/**
 * Tests for the Claude Code CLI adapter.
 *
 * These tests cover:
 *   1. buildArgs — pure CLI arg construction
 *   2. translateLine — pure translation of each Claude Code NDJSON line type
 *   3. Full invoke() pipeline via an injected fake spawner
 *   4. File edit detection (git diff parsing helpers)
 */

import { describe, it, expect } from "vitest";
import {
  buildArgs,
  translateLine,
  parseGitNumstat,
  parseGitNameStatus,
  classifySubprocessError,
  parsePermissionBlockedOn,
  PERMISSION_HANG_TIMEOUT_MS,
  type InvokeOptions,
  type ClaudeCodeLine,
  type SpawnerContext,
} from "./claudeCode.js";
import type { BlobStore } from "../blobStore.js";
import { invoke } from "./claudeCode.js";
import type { InvocationCompleted } from "@shared/events.js";

// ============================================================================
// Helpers
// ============================================================================

function makeBlobStore(): BlobStore & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    putBlob(content) {
      const key = Buffer.isBuffer(content)
        ? content.toString("hex").slice(0, 8)
        : String(content).slice(0, 8);
      const hash = "a".repeat(64 - key.length) + key;
      stored.set(
        hash,
        Buffer.isBuffer(content) ? content.toString() : String(content),
      );
      return { hash };
    },
    getBlob(hash) {
      const v = stored.get(hash);
      return v ? Buffer.from(v) : null;
    },
    hasBlob(hash) {
      return stored.has(hash);
    },
  };
}

const baseOpts: InvokeOptions = {
  invocation_id: "inv-001",
  attempt_id: "att-001",
  phase_name: "implementer",
  model: "claude-sonnet-4-6",
  prompt: "Create hello.txt with Hello, world",
  prompt_version_id: "pv-001",
  context_manifest_hash: "abc123",
  cwd: "/tmp/worktree/T-001",
  transport_options: {
    kind: "cli",
    bare: true,
    max_turns: 10,
    max_budget_usd: 1.0,
    permission_mode: "acceptEdits",
  },
};

// ============================================================================
// buildArgs
// ============================================================================

describe("buildArgs", () => {
  it("includes required flags for stream-json output", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("-p");
    expect(args).toContain(baseOpts.prompt);
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--model");
    expect(args).toContain(baseOpts.model);
  });

  it("includes max-turns and max-budget-usd", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--max-turns");
    expect(args).toContain("10");
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("1");
  });

  it("includes permission-mode", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
  });

  it("includes bare flag when bare=true", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--bare");
  });

  it("omits bare flag when bare=false", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, bare: false },
    };
    const args = buildArgs(opts);
    expect(args).not.toContain("--bare");
  });

  it("includes system prompt file when provided", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      systemPromptFile: "/tmp/system.md",
    };
    const args = buildArgs(opts);
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("/tmp/system.md");
  });

  it("omits system prompt file when not provided", () => {
    const args = buildArgs(baseOpts);
    expect(args).not.toContain("--append-system-prompt-file");
  });
});

// ============================================================================
// translateLine — system init
// ============================================================================

describe("translateLine — system init", () => {
  it("produces invocation.started from system/init line", () => {
    const line: ClaudeCodeLine = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input.type).toBe("invocation.started");
    expect(input.aggregate_type).toBe("attempt");
    expect(input.aggregate_id).toBe("att-001");
    expect(input.actor).toMatchObject({
      kind: "cli",
      transport: "claude-code",
    });
    expect(input.payload).toMatchObject({
      invocation_id: "inv-001",
      attempt_id: "att-001",
      phase_name: "implementer",
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "pv-001",
      context_manifest_hash: "abc123",
    });
  });
});

// ============================================================================
// translateLine — assistant text message
// ============================================================================

describe("translateLine — assistant text", () => {
  it("produces invocation.assistant_message from assistant text block", () => {
    const line: ClaudeCodeLine = {
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I'll create that file now." }],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      session_id: "sess-1",
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    // One assistant_message per text block
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    const msgInput = inputs.find(
      (i) => i.type === "invocation.assistant_message",
    );
    expect(msgInput).toBeDefined();
    expect(msgInput!.payload).toMatchObject({
      invocation_id: "inv-001",
      text: "I'll create that file now.",
    });
  });
});

// ============================================================================
// translateLine — assistant tool_use
// ============================================================================

describe("translateLine — assistant tool_use", () => {
  it("produces invocation.tool_called from tool_use block and stores args in blob", () => {
    const toolInput = {
      file_path: "/tmp/worktree/T-001/hello.txt",
      content: "Hello, world\n",
    };
    const line: ClaudeCodeLine = {
      type: "assistant",
      message: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Creating the file." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Write",
            input: toolInput,
          },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        usage: { input_tokens: 120, output_tokens: 30 },
      },
      session_id: "sess-1",
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);

    const toolInput_ = inputs.find((i) => i.type === "invocation.tool_called");
    expect(toolInput_).toBeDefined();
    expect(toolInput_!.payload).toMatchObject({
      invocation_id: "inv-001",
      tool_call_id: "tool-1",
      tool_name: "Write",
    });
    // args_hash must be present and args stored in blob
    const { args_hash } = toolInput_!.payload as { args_hash: string };
    expect(args_hash).toBeTruthy();
    expect(blobStore.hasBlob(args_hash)).toBe(true);
    // verify stored args round-trip
    const stored = blobStore.getBlob(args_hash);
    expect(JSON.parse(stored!.toString())).toEqual(toolInput);
  });

  it("produces text and tool_called from a message with both", () => {
    const line: ClaudeCodeLine = {
      type: "assistant",
      message: {
        id: "msg-3",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          {
            type: "tool_use",
            id: "t2",
            name: "Read",
            input: { path: "src/index.ts" },
          },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      session_id: "sess-1",
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    expect(inputs.some((i) => i.type === "invocation.assistant_message")).toBe(
      true,
    );
    expect(inputs.some((i) => i.type === "invocation.tool_called")).toBe(true);
  });
});

// ============================================================================
// translateLine — tool result (user turn)
// ============================================================================

describe("translateLine — user tool_result", () => {
  it("produces invocation.tool_returned from user tool_result", () => {
    const line: ClaudeCodeLine = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "File created successfully",
            is_error: false,
          },
        ],
      },
      session_id: "sess-1",
    };
    const blobStore = makeBlobStore();
    const toolCallTime = Date.now();
    const inputs = translateLine(line, baseOpts, blobStore, {
      "tool-1": toolCallTime - 200,
    });

    expect(inputs.length).toBeGreaterThanOrEqual(1);
    const returned = inputs.find((i) => i.type === "invocation.tool_returned");
    expect(returned).toBeDefined();
    expect(returned!.payload).toMatchObject({
      invocation_id: "inv-001",
      tool_call_id: "tool-1",
      success: true,
    });
    const { duration_ms } = returned!.payload as { duration_ms: number };
    expect(duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("marks tool_returned as success=false on error", () => {
    const line: ClaudeCodeLine = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            content: "File not found",
            is_error: true,
          },
        ],
      },
      session_id: "sess-1",
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore, {});
    const returned = inputs.find((i) => i.type === "invocation.tool_returned");
    expect(returned!.payload).toMatchObject({ success: false });
  });
});

// ============================================================================
// translateLine — result (final)
// ============================================================================

describe("translateLine — result success", () => {
  it("produces invocation.completed from a success result", () => {
    const line: ClaudeCodeLine = {
      type: "result",
      subtype: "success",
      duration_ms: 3200,
      is_error: false,
      num_turns: 3,
      result: "Created hello.txt",
      session_id: "sess-1",
      total_cost_usd: 0.0042,
      usage: { input_tokens: 500, output_tokens: 100 },
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore, {}, 1000);
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input.type).toBe("invocation.completed");
    expect(input.payload).toMatchObject({
      invocation_id: "inv-001",
      outcome: "success",
      tokens_in: 500,
      tokens_out: 100,
      cost_usd: 0.0042,
      turns: 3,
    });
    const { duration_ms } = input.payload as { duration_ms: number };
    expect(duration_ms).toBeGreaterThan(0);
  });
});

describe("translateLine — result error", () => {
  it("produces invocation.errored and invocation.completed on is_error=true", () => {
    const line: ClaudeCodeLine = {
      type: "result",
      subtype: "error",
      duration_ms: 1000,
      is_error: true,
      num_turns: 1,
      result: "Process exited with code 1",
      session_id: "sess-1",
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].type).toBe("invocation.errored");
    expect(
      (inputs[0].payload as { error_category: string }).error_category,
    ).toBe("unknown");
    expect(inputs[1].type).toBe("invocation.completed");
    expect((inputs[1].payload as { exit_reason: string }).exit_reason).toBe(
      "unknown",
    );
  });

  it("maps error_budget_exceeded subtype to budget_exceeded category", () => {
    const line: ClaudeCodeLine = {
      type: "result",
      subtype: "error_budget_exceeded",
      duration_ms: 500,
      is_error: true,
      num_turns: 2,
      result: "Budget exceeded",
      session_id: "sess-1",
      total_cost_usd: 1.0,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    const errored = inputs.find((i) => i.type === "invocation.errored");
    expect(errored).toBeDefined();
    expect(
      (errored!.payload as { error_category: string }).error_category,
    ).toBe("budget_exceeded");
  });

  it("maps error_max_turns subtype to turn_limit category", () => {
    const line: ClaudeCodeLine = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 800,
      is_error: true,
      num_turns: 10,
      result: "Max turns reached",
      session_id: "sess-1",
      total_cost_usd: 0.5,
      usage: { input_tokens: 200, output_tokens: 80 },
    };
    const blobStore = makeBlobStore();
    const inputs = translateLine(line, baseOpts, blobStore);
    const errored = inputs.find((i) => i.type === "invocation.errored");
    expect(
      (errored!.payload as { error_category: string }).error_category,
    ).toBe("turn_limit");
  });
});

// ============================================================================
// parseGitNumstat / parseGitNameStatus
// ============================================================================

describe("parseGitNumstat", () => {
  it("parses numstat lines correctly", () => {
    const output = "5\t3\tsrc/foo.ts\n10\t0\tsrc/bar.ts\n";
    const result = parseGitNumstat(output);
    expect(result).toEqual({
      "src/foo.ts": { lines_added: 5, lines_removed: 3 },
      "src/bar.ts": { lines_added: 10, lines_removed: 0 },
    });
  });

  it("returns empty map for empty output", () => {
    expect(parseGitNumstat("")).toEqual({});
  });

  it("handles binary files (- - path)", () => {
    const output = "-\t-\tbinary.png\n";
    const result = parseGitNumstat(output);
    expect(result["binary.png"]).toEqual({ lines_added: 0, lines_removed: 0 });
  });
});

describe("parseGitNameStatus", () => {
  it("parses M/A/D status correctly", () => {
    const output = "M\tsrc/foo.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\n";
    const result = parseGitNameStatus(output);
    expect(result).toEqual({
      "src/foo.ts": "M",
      "src/new.ts": "A",
      "src/old.ts": "D",
    });
  });

  it("handles rename lines (R100 old new)", () => {
    const output = "R100\tsrc/old.ts\tsrc/new.ts\n";
    const result = parseGitNameStatus(output);
    // Rename: treat new path as added, old as deleted
    expect(result["src/new.ts"]).toBe("A");
  });
});

// ============================================================================
// Full invoke() pipeline with fake spawner
// ============================================================================

describe("invoke() pipeline", () => {
  it("produces expected canonical event sequence from a complete NDJSON stream", async () => {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Creating file." }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 5 },
        },
        session_id: "s1",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1000,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.001,
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ];

    async function* fakeSpawner() {
      for (const line of lines) yield line;
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string }> = [];

    for await (const input of invoke(baseOpts, blobStore, fakeSpawner)) {
      results.push({ type: input.type });
    }

    expect(results[0].type).toBe("invocation.started");
    expect(results[1].type).toBe("invocation.assistant_message");
    expect(results[results.length - 1].type).toBe("invocation.completed");
  });

  it("yields invocation.errored when subprocess exits non-zero", async () => {
    async function* failingSpawner() {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      // Simulate non-zero exit by throwing
      const err = new Error("Process exited with code 1") as Error & {
        exitCode?: number;
      };
      err.exitCode = 1;
      throw err;
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, failingSpawner)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const errored = results.find((r) => r.type === "invocation.errored");
    expect(errored).toBeDefined();
    expect(
      (errored!.payload as { error_category: string }).error_category,
    ).toBe("aborted");
  });

  it("yields invocation.errored with budget_exceeded on budget error line", async () => {
    async function* budgetSpawner() {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      yield JSON.stringify({
        type: "result",
        subtype: "error_budget_exceeded",
        duration_ms: 500,
        is_error: true,
        num_turns: 2,
        result: "Budget exceeded",
        session_id: "s1",
        total_cost_usd: 1.0,
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, budgetSpawner)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const errored = results.find((r) => r.type === "invocation.errored");
    expect(errored).toBeDefined();
    expect(
      (errored!.payload as { error_category: string }).error_category,
    ).toBe("budget_exceeded");
  });

  it("stores tool args in blob and only emits hash in tool_called event", async () => {
    const toolArgs = { file_path: "/tmp/hello.txt", content: "hi" };
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tc1", name: "Write", input: toolArgs },
          ],
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          usage: { input_tokens: 80, output_tokens: 20 },
        },
        session_id: "s1",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc1",
              content: "OK",
              is_error: false,
            },
          ],
        },
        session_id: "s1",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 800,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.001,
        usage: { input_tokens: 80, output_tokens: 20 },
      }),
    ];

    async function* fakeSpawner() {
      for (const line of lines) yield line;
    }

    const blobStore = makeBlobStore();
    const allInputs: Array<ReturnType<typeof translateLine>[0]> = [];

    for await (const input of invoke(baseOpts, blobStore, fakeSpawner)) {
      allInputs.push(input);
    }

    const toolCalledInput = allInputs.find(
      (i) => i.type === "invocation.tool_called",
    );
    expect(toolCalledInput).toBeDefined();

    const { args_hash } = toolCalledInput!.payload as { args_hash: string };
    expect(args_hash).toBeTruthy();
    // Payload must NOT contain the raw args
    expect(JSON.stringify(toolCalledInput!.payload)).not.toContain("hello.txt");
    // But args can be retrieved from blob store
    const stored = blobStore.getBlob(args_hash);
    expect(JSON.parse(stored!.toString())).toEqual(toolArgs);
  });
});

// ============================================================================
// Exit reason classification
// ============================================================================

describe("exit reason classification", () => {
  // --------------------------------------------------------------------------
  // AC2: permission hang timeout is 10 seconds
  // --------------------------------------------------------------------------

  describe("PERMISSION_HANG_TIMEOUT_MS — AC2 timeout constant", () => {
    it("is exactly 10 seconds (10_000 ms)", () => {
      // AC2: "no stream-json events have arrived for 10 seconds, the subprocess is killed immediately"
      // The execaSpawner starts a PERMISSION_HANG_TIMEOUT_MS timer the moment it
      // detects "Waiting for permission" in stderr. This test verifies the constant
      // is set to the required 10s so the kill fires within the AC2 window.
      expect(PERMISSION_HANG_TIMEOUT_MS).toBe(10_000);
    });
  });

  describe("classifySubprocessError", () => {
    it("classifies SIGKILL as killed", () => {
      const err = Object.assign(new Error("killed"), {
        signal: "SIGKILL",
        exitCode: 137,
      });
      expect(classifySubprocessError(err)).toBe("killed");
    });

    it("classifies exit code 137 as killed", () => {
      const err = Object.assign(new Error("killed"), { exitCode: 137 });
      expect(classifySubprocessError(err)).toBe("killed");
    });

    it("classifies exit code 124 as timeout", () => {
      const err = Object.assign(new Error("timeout"), { exitCode: 124 });
      expect(classifySubprocessError(err)).toBe("timeout");
    });

    it("classifies permission prompt in stderr as permission_blocked", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(
        classifySubprocessError(err, "Waiting for permission to use tool"),
      ).toBe("permission_blocked");
    });

    it("classifies ENOTFOUND as network_error", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(
        classifySubprocessError(err, "Error: ENOTFOUND api.anthropic.com"),
      ).toBe("network_error");
    });

    it("classifies ECONNREFUSED as network_error", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(
        classifySubprocessError(err, "connect ECONNREFUSED 127.0.0.1:443"),
      ).toBe("network_error");
    });

    it("classifies 'socket hang up' as network_error (AC7)", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(classifySubprocessError(err, "Error: socket hang up")).toBe(
        "network_error",
      );
    });

    it("classifies schema validation errors as schema_invalid", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(classifySubprocessError(err, "schema validation failed")).toBe(
        "schema_invalid",
      );
    });

    it("classifies segfault as crashed", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(
        classifySubprocessError(
          err,
          "Segmentation fault (core dumped)\nSIGSEGV",
        ),
      ).toBe("crashed");
    });

    it("classifies stack trace in stderr as crashed (AC9)", () => {
      const err = Object.assign(new Error("failed"), { exitCode: 1 });
      expect(
        classifySubprocessError(
          err,
          "at Object.<anonymous> (/app/index.js:10:5)\nstack trace",
        ),
      ).toBe("crashed");
    });

    it("falls through to unknown with no matching pattern", () => {
      const err = Object.assign(new Error("something went wrong"), {
        exitCode: 1,
      });
      expect(classifySubprocessError(err)).toBe("unknown");
    });
  });

  describe("budget-exceeded fixture: classifies correctly from structured event", () => {
    it("translateLine produces exit_reason budget_exceeded from error_budget_exceeded result (AC1)", () => {
      const line: ClaudeCodeLine = {
        type: "result",
        subtype: "error_budget_exceeded",
        duration_ms: 500,
        is_error: true,
        num_turns: 2,
        result: "Budget exceeded",
        session_id: "s1",
        total_cost_usd: 1.0,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const blobStore = makeBlobStore();
      const inputs = translateLine(line, baseOpts, blobStore, {}, 1000);
      const completed = inputs.find((i) => i.type === "invocation.completed");
      expect(completed).toBeDefined();
      expect((completed!.payload as { exit_reason: string }).exit_reason).toBe(
        "budget_exceeded",
      );
    });
  });

  describe("turn-limit fixture: classifies correctly from structured event", () => {
    it("translateLine produces exit_reason turn_limit from error_max_turns result (AC2)", () => {
      const line: ClaudeCodeLine = {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 800,
        is_error: true,
        num_turns: 10,
        result: "Max turns reached",
        session_id: "s1",
        total_cost_usd: 0.5,
        usage: { input_tokens: 200, output_tokens: 80 },
      };
      const blobStore = makeBlobStore();
      const inputs = translateLine(line, baseOpts, blobStore, {}, 1000);
      const completed = inputs.find((i) => i.type === "invocation.completed");
      expect(completed).toBeDefined();
      expect((completed!.payload as { exit_reason: string }).exit_reason).toBe(
        "turn_limit",
      );
    });
  });

  describe("unknown-crash fixture: falls through to unknown with tails preserved", () => {
    it("invoke() yields invocation.completed with exit_reason=unknown and null tail hashes on unexpected crash", async () => {
      async function* crashingSpawner() {
        yield JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
        });
        const err = new Error("Unexpected crash") as Error & {
          exitCode?: number;
        };
        err.exitCode = 1;
        throw err;
      }

      const blobStore = makeBlobStore();
      const results: Array<{ type: string; payload: unknown }> = [];

      for await (const input of invoke(baseOpts, blobStore, crashingSpawner)) {
        results.push({ type: input.type, payload: input.payload });
      }

      // Should have both errored and completed events
      const errored = results.find((r) => r.type === "invocation.errored");
      expect(errored).toBeDefined();

      const completed = results.find((r) => r.type === "invocation.completed");
      expect(completed).toBeDefined();
      const p = completed!.payload as InvocationCompleted;
      expect(p.exit_reason).toBe("unknown");
      expect(p.outcome).toBe("failed");
      // Tail hashes are now stored in the crash path (best-effort blob store).
      // stdout had the init line, stderr has the error message — both get hashes.
      expect(p.stdout_tail_hash).not.toBeNull();
      expect(p.stderr_tail_hash).not.toBeNull();
    });
  });

  describe("permission-prompt-hang fixture: adapter detects and kills within 10s", () => {
    it("invoke() classifies permission_blocked when process is killed after permission prompt appears in stderr", async () => {
      // AC1/AC2: The real execaSpawner monitors stderr for "Waiting for permission" and
      // kills the process after PERMISSION_HANG_TIMEOUT_MS (10s, verified above).
      // Here we simulate the outcome of that kill: a spawner that throws with
      // SIGKILL + the permission prompt in stderr (exactly what execaSpawner produces).
      async function* permissionHangSpawner() {
        yield JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
        });
        // Simulates execaSpawner killing after PERMISSION_HANG_TIMEOUT_MS:
        // result.stderr contains "Waiting for permission", exitCode=137, signal=SIGKILL
        const err = Object.assign(
          new Error("Waiting for permission to use tool Write"),
          { signal: "SIGKILL", exitCode: 137 },
        );
        throw err;
      }

      const blobStore = makeBlobStore();
      const results: Array<{ type: string; payload: unknown }> = [];

      for await (const input of invoke(
        baseOpts,
        blobStore,
        permissionHangSpawner,
      )) {
        results.push({ type: input.type, payload: input.payload });
      }

      const completed = results.find((r) => r.type === "invocation.completed");
      expect(completed).toBeDefined();
      const p = completed!.payload as InvocationCompleted;
      // AC3: permission hang → permission_blocked (not "killed" even though SIGKILL)
      expect(p.exit_reason).toBe("permission_blocked");
      // AC4: tool name extracted from the permission prompt
      expect(p.permission_blocked_on).toBe("Write");
    });
  });

  describe("translateLine includes exit_reason on success result", () => {
    it("sets exit_reason to normal on success", () => {
      const line: ClaudeCodeLine = {
        type: "result",
        subtype: "success",
        duration_ms: 1000,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.001,
        usage: { input_tokens: 50, output_tokens: 5 },
      };
      const blobStore = makeBlobStore();
      const inputs = translateLine(line, baseOpts, blobStore, {}, 1000);
      expect(inputs).toHaveLength(1);
      expect((inputs[0].payload as { exit_reason: string }).exit_reason).toBe(
        "normal",
      );
    });
  });

  // --------------------------------------------------------------------------
  // AC3/AC4: permission hang + SIGKILL classification and tool name extraction
  // --------------------------------------------------------------------------

  describe("classifySubprocessError — permission pattern takes priority over SIGKILL", () => {
    it("returns permission_blocked (not killed) when SIGKILL + permission prompt in stderr", () => {
      // Real scenario: execaSpawner kills with SIGKILL after detecting permission prompt.
      // The exit code is 137 and signal is SIGKILL, but stderr contains the permission prompt.
      // The permission pattern must win so the caller can record the correct exit reason.
      const err = Object.assign(
        new Error("Waiting for permission to use tool Write"),
        { signal: "SIGKILL", exitCode: 137 },
      );
      expect(classifySubprocessError(err, err.message)).toBe(
        "permission_blocked",
      );
    });

    it("still returns killed when SIGKILL without permission prompt in stderr", () => {
      const err = Object.assign(new Error("Process was killed"), {
        signal: "SIGKILL",
        exitCode: 137,
      });
      expect(classifySubprocessError(err, err.message)).toBe("killed");
    });
  });

  describe("parsePermissionBlockedOn — tool name extraction", () => {
    it("extracts tool name from 'Waiting for permission to use tool ToolName'", () => {
      expect(
        parsePermissionBlockedOn("Waiting for permission to use tool Write"),
      ).toBe("Write");
    });

    it("extracts tool name from 'Waiting for permission to use ToolName' (no 'tool' keyword)", () => {
      expect(
        parsePermissionBlockedOn("Waiting for permission to use Bash"),
      ).toBe("Bash");
    });

    it("extracts tool name from quoted tool name", () => {
      expect(
        parsePermissionBlockedOn('Waiting for permission to use tool "Edit"'),
      ).toBe("Edit");
    });

    it("returns null when permission pattern is absent", () => {
      expect(parsePermissionBlockedOn("Something unrelated")).toBeNull();
    });

    it("returns null when 'Waiting for permission' appears without a tool name", () => {
      expect(parsePermissionBlockedOn("Waiting for permission")).toBeNull();
    });
  });

  describe("AC3/AC4: invoke() with permission-hang kill — classifies and records tool name", () => {
    it("classifies exit_reason as permission_blocked when killed after permission prompt", async () => {
      // Simulate the real scenario: subprocess dies with SIGKILL (exitCode 137)
      // and the error message contains the stderr permission prompt.
      async function* permissionKillSpawner() {
        yield JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
        });
        // The error simulates what execaSpawner throws when SIGKILL terminates the process
        // after a permission hang: message = result.stderr, signal = SIGKILL, exitCode = 137
        const err = Object.assign(
          new Error(
            "Waiting for permission to use tool Write\nClaude is requesting permission to write to a file.",
          ),
          { signal: "SIGKILL", exitCode: 137 },
        );
        throw err;
      }

      const blobStore = makeBlobStore();
      const results: Array<{ type: string; payload: unknown }> = [];

      for await (const input of invoke(
        baseOpts,
        blobStore,
        permissionKillSpawner,
      )) {
        results.push({ type: input.type, payload: input.payload });
      }

      const completed = results.find((r) => r.type === "invocation.completed");
      expect(completed).toBeDefined();
      const p = completed!.payload as InvocationCompleted;
      expect(p.exit_reason).toBe("permission_blocked");
    });

    it("records permission_blocked_on with the tool name parsed from the permission prompt", async () => {
      async function* permissionKillSpawner() {
        yield JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
        });
        const err = Object.assign(
          new Error("Waiting for permission to use tool Bash"),
          { signal: "SIGKILL", exitCode: 137 },
        );
        throw err;
      }

      const blobStore = makeBlobStore();
      const results: Array<{ type: string; payload: unknown }> = [];

      for await (const input of invoke(
        baseOpts,
        blobStore,
        permissionKillSpawner,
      )) {
        results.push({ type: input.type, payload: input.payload });
      }

      const completed = results.find((r) => r.type === "invocation.completed");
      expect(completed).toBeDefined();
      const p = completed!.payload as InvocationCompleted;
      expect(p.exit_reason).toBe("permission_blocked");
      expect(p.permission_blocked_on).toBe("Bash");
    });

    it("sets permission_blocked_on to null when tool name cannot be parsed", async () => {
      async function* permissionKillSpawner() {
        yield JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "claude-sonnet-4-6",
          permissionMode: "acceptEdits",
        });
        // Permission prompt without a parseable tool name
        const err = Object.assign(new Error("Waiting for permission"), {
          signal: "SIGKILL",
          exitCode: 137,
        });
        throw err;
      }

      const blobStore = makeBlobStore();
      const results: Array<{ type: string; payload: unknown }> = [];

      for await (const input of invoke(
        baseOpts,
        blobStore,
        permissionKillSpawner,
      )) {
        results.push({ type: input.type, payload: input.payload });
      }

      const completed = results.find((r) => r.type === "invocation.completed");
      const p = completed!.payload as InvocationCompleted;
      expect(p.exit_reason).toBe("permission_blocked");
      expect(p.permission_blocked_on).toBeNull();
    });
  });
});

// ============================================================================
// Stdout/stderr tail capture
// ============================================================================

describe("stdout/stderr tail capture", () => {
  it("AC1/AC3/AC5: stores stdout tail in blob store and attaches non-null hash to invocation.completed", async () => {
    async function* fakeSpawner() {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, fakeSpawner)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const completed = results.find((r) => r.type === "invocation.completed");
    expect(completed).toBeDefined();
    const p = completed!.payload as InvocationCompleted;
    // stdout was produced (the NDJSON lines), so hash must be a non-null string
    expect(typeof p.stdout_tail_hash).toBe("string");
    expect(p.stdout_tail_hash).not.toBeNull();
    // The blob must be retrievable from the store
    const stored = blobStore.getBlob(p.stdout_tail_hash!);
    expect(stored).not.toBeNull();
  });

  it("AC2/AC4/AC6: stores stderr tail in blob store when spawner sets stderrTail on context", async () => {
    const stderrContent = "Some stderr output from claude subprocess";

    async function* spawnerWithStderr(
      _cmd: string,
      _args: string[],
      _opts: { cwd: string },
      context?: SpawnerContext,
    ) {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      // Simulates execaSpawner setting stderrTail after subprocess exits
      if (context) context.stderrTail = stderrContent;
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, spawnerWithStderr)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const completed = results.find((r) => r.type === "invocation.completed");
    expect(completed).toBeDefined();
    const p = completed!.payload as InvocationCompleted;
    expect(typeof p.stderr_tail_hash).toBe("string");
    expect(p.stderr_tail_hash).not.toBeNull();
    const stored = blobStore.getBlob(p.stderr_tail_hash!);
    expect(stored!.toString()).toBe(stderrContent);
  });

  it("stderr_tail_hash is null when no stderr was produced", async () => {
    async function* fakeSpawner() {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      // context.stderrTail left unset — simulates a subprocess with no stderr
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, fakeSpawner)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const completed = results.find((r) => r.type === "invocation.completed");
    const p = completed!.payload as InvocationCompleted;
    expect(p.stderr_tail_hash).toBeNull();
  });

  it("AC7: invocation completes normally with null hashes when blob store throws", async () => {
    async function* fakeSpawner() {
      yield JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-sonnet-4-6",
        permissionMode: "acceptEdits",
      });
      yield JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }

    const throwingBlobStore: BlobStore & { stored: Map<string, string> } = {
      stored: new Map(),
      putBlob(_content) {
        throw new Error("blob store unavailable");
      },
      getBlob(_hash) {
        return null;
      },
      hasBlob(_hash) {
        return false;
      },
    };

    const results: Array<{ type: string; payload: unknown }> = [];

    // Must not throw even though blob store throws on putBlob
    for await (const input of invoke(
      baseOpts,
      throwingBlobStore,
      fakeSpawner,
    )) {
      results.push({ type: input.type, payload: input.payload });
    }

    const completed = results.find((r) => r.type === "invocation.completed");
    expect(completed).toBeDefined();
    const p = completed!.payload as InvocationCompleted;
    // Best-effort: hashes are null when blob store throws
    expect(p.stdout_tail_hash).toBeNull();
    expect(p.stderr_tail_hash).toBeNull();
  });

  it("stdout tail is capped at ~4KB (last 4096 bytes)", async () => {
    // Generate more than 4KB of stdout content
    const largeLine = "x".repeat(1000);
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 500,
      is_error: false,
      num_turns: 1,
      result: "Done",
      session_id: "s1",
      total_cost_usd: 0.0001,
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    async function* fakeSpawner() {
      // Yield 6 large lines = 6000+ bytes of stdout (> 4KB)
      for (let i = 0; i < 6; i++) {
        yield largeLine;
      }
      yield resultLine;
    }

    const blobStore = makeBlobStore();
    const results: Array<{ type: string; payload: unknown }> = [];

    for await (const input of invoke(baseOpts, blobStore, fakeSpawner)) {
      results.push({ type: input.type, payload: input.payload });
    }

    const completed = results.find((r) => r.type === "invocation.completed");
    const p = completed!.payload as InvocationCompleted;
    expect(p.stdout_tail_hash).not.toBeNull();
    // The stored blob must be at most 4096 bytes
    const stored = blobStore.getBlob(p.stdout_tail_hash!);
    expect(stored!.length).toBeLessThanOrEqual(4096);
  });
});
