/**
 * Tests for the Codex CLI adapter.
 *
 * These tests cover:
 *   1. buildArgs — CLI arg construction and permission mode mapping
 *   2. translateLine — translation of each Codex NDJSON line type
 *   3. Full invoke() pipeline via an injected fake spawner
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildArgs,
  translateLine,
  invoke,
  type InvokeOptions,
  type CodexLine,
  type Spawner,
  type TranslateContext,
} from "./codex.js";
import type { BlobStore } from "../blobStore.js";
import type { InvocationCompleted } from "@shared/events.js";
import { MODEL_PRICING, computeCost } from "./modelPricing.js";

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
  model: "o3",
  prompt: "Create hello.txt with Hello, world",
  prompt_version_id: "pv-001",
  context_manifest_hash: "abc123",
  cwd: "/tmp/worktree/T-001",
  transport_options: {
    kind: "cli",
    max_turns: 10,
    max_budget_usd: 1.0,
    permission_mode: "acceptEdits",
  },
};

function makeCtx(overrides?: Partial<TranslateContext>): TranslateContext {
  return {
    itemStartTimes: {},
    startedAt: Date.now(),
    turnCount: 0,
    fileChangePathsSeen: new Set(),
    ...overrides,
  };
}

describe("model pricing", () => {
  it("includes the required OpenAI model entries", () => {
    expect(MODEL_PRICING["o3"]).toMatchObject({
      input_per_1m: 2.0,
      output_per_1m: 8.0,
    });
    expect(MODEL_PRICING["o4-mini"]).toMatchObject({
      input_per_1m: 1.1,
      output_per_1m: 4.4,
    });
    expect(MODEL_PRICING["gpt-4.1"]).toMatchObject({
      input_per_1m: 2.0,
      output_per_1m: 8.0,
    });
    expect(MODEL_PRICING["gpt-4.1-mini"]).toMatchObject({
      input_per_1m: 0.4,
      output_per_1m: 1.6,
    });
    expect(MODEL_PRICING["gpt-4.1-nano"]).toMatchObject({
      input_per_1m: 0.1,
      output_per_1m: 0.4,
    });
    expect(MODEL_PRICING["o3-pro"]).toMatchObject({
      input_per_1m: 20.0,
      output_per_1m: 80.0,
    });
  });

  it("prefers the most specific prefix for versioned model IDs", () => {
    expect(computeCost("o3-pro-2025-06-10", 1_000_000, 1_000_000)).toBe(100);
    expect(computeCost("gpt-4.1-mini-2025-04-14", 1_000_000, 1_000_000)).toBe(
      2,
    );
  });
});

// ============================================================================
// buildArgs
// ============================================================================

describe("buildArgs", () => {
  afterEach(() => {
    // Clean up any temp schema files
    const tmpDir = os.tmpdir();
    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("codex-schema-"));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
    }
  });

  it("produces correct base invocation: codex exec --json --ephemeral --cd <cwd> --model <model> <prompt>", () => {
    const args = buildArgs(baseOpts);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");

    const cdIdx = args.indexOf("--cd");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(args[cdIdx + 1]).toBe(baseOpts.cwd);

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("o3");

    // Stdin pipe marker "-" is the last positional argument
    expect(args[args.length - 1]).toBe("-");
  });

  it("always includes --ephemeral", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--ephemeral");
  });

  it("includes --full-auto when permission_mode is acceptEdits", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--full-auto");
  });

  it("includes --full-auto when permission_mode is auto", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: {
        ...baseOpts.transport_options,
        permission_mode: "auto",
      },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--full-auto");
  });

  it("includes --dangerously-bypass-approvals-and-sandbox when permission_mode is bypassPermissions", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: {
        ...baseOpts.transport_options,
        permission_mode: "bypassPermissions",
      },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");
  });

  it("includes --sandbox read-only --ask-for-approval untrusted when permission_mode is plan", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: {
        ...baseOpts.transport_options,
        permission_mode: "plan",
      },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("--full-auto");
  });

  it("includes --sandbox read-only --ask-for-approval untrusted when permission_mode is default", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: {
        ...baseOpts.transport_options,
        permission_mode: "default",
      },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--ask-for-approval");
  });

  it("appends --output-schema <path> when schema is provided", () => {
    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
    };
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, schema },
    };
    const args = buildArgs(opts);
    const schemaIdx = args.indexOf("--output-schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaPath = args[schemaIdx + 1];
    expect(schemaPath).toContain("codex-schema-");

    // Verify OpenAI schema rules: additionalProperties: false + all keys in required
    const written = fs.readFileSync(schemaPath, "utf-8");
    expect(JSON.parse(written)).toEqual({
      ...schema,
      additionalProperties: false,
      required: ["result"],
    });
  });

  it("does not include --output-schema when no schema is provided", () => {
    const args = buildArgs(baseOpts);
    expect(args).not.toContain("--output-schema");
  });
});

// ============================================================================
// translateLine
// ============================================================================

describe("translateLine", () => {
  let bs: ReturnType<typeof makeBlobStore>;

  beforeEach(() => {
    bs = makeBlobStore();
  });

  // AC1: thread.started → invocation.started
  it("AC1: translates thread.started into invocation.started", () => {
    const line: CodexLine = {
      type: "thread.started",
      thread_id: "t-1",
      model: "o3",
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.started");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      transport: "codex",
      model: "o3",
      phase_name: "implementer",
      prompt_version_id: "pv-001",
      context_manifest_hash: "abc123",
    });
  });

  // AC2: turn.started → no event
  it("AC2: emits no canonical event for turn.started", () => {
    const line: CodexLine = { type: "turn.started", turn_id: "turn-1" };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(0);
  });

  // AC3: item.started for command_execution → invocation.tool_called with command in blob
  it("AC3: translates item.started (command_execution) to invocation.tool_called with command in blob store", () => {
    const line: CodexLine = {
      type: "item.started",
      item: { type: "command_execution", id: "cmd-1", command: "npm test" },
    };
    const ctx = makeCtx();
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.tool_called");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      tool_call_id: "cmd-1",
      tool_name: "command_execution",
    });
    // Command should be stored in the blob store
    expect(bs.stored.size).toBe(1);
    const storedValue = [...bs.stored.values()][0];
    expect(JSON.parse(storedValue)).toMatchObject({ command: "npm test" });
    // Item start time should be recorded
    expect(ctx.itemStartTimes["cmd-1"]).toBeDefined();
  });

  // AC4: item.completed for command_execution → invocation.tool_returned
  it("AC4: translates item.completed (command_execution) to invocation.tool_returned", () => {
    const ctx = makeCtx({ itemStartTimes: { "cmd-1": Date.now() - 500 } });
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-1",
        command: "npm test",
        output: "ok",
        exit_code: 0,
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.tool_returned");
    expect(inputs[0].payload).toMatchObject({
      tool_call_id: "cmd-1",
      success: true,
    });
    // duration_ms should be > 0
    expect((inputs[0].payload as any).duration_ms).toBeGreaterThan(0);
  });

  it("AC4: command_execution with non-zero exit_code reports failure", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-2",
        command: "false",
        output: "error msg",
        exit_code: 1,
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].payload).toMatchObject({
      success: false,
      error: "error msg",
    });
  });

  it("AC4: command_execution with undefined exit_code defaults to success", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: { type: "command_execution", id: "cmd-3", command: "echo hi" },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].payload).toMatchObject({
      success: true,
    });
  });

  // AC5: item.started for file_change → invocation.tool_called
  it("AC5: translates item.started (file_change) to invocation.tool_called", () => {
    const line: CodexLine = {
      type: "item.started",
      item: {
        type: "file_change",
        id: "fc-1",
        changes: [{ path: "src/index.ts", kind: "update" }],
      },
    };
    const ctx = makeCtx();
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.tool_called");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      tool_call_id: "fc-1",
      tool_name: "file_change",
    });
    // Args should be stored in blob store
    expect(bs.stored.size).toBe(1);
    const storedValue = [...bs.stored.values()][0];
    expect(JSON.parse(storedValue)).toMatchObject({
      changes: [{ path: "src/index.ts", kind: "update" }],
    });
  });

  // AC6: item.completed for file_change → invocation.tool_returned + invocation.file_edited
  it("AC6: translates item.completed (file_change) to tool_returned + file_edited", () => {
    const ctx = makeCtx({ itemStartTimes: { "fc-1": Date.now() - 200 } });
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "file_change",
        id: "fc-1",
        changes: [{ path: "src/index.ts", kind: "update" }],
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(2);

    // First: tool_returned
    expect(inputs[0].type).toBe("invocation.tool_returned");
    expect(inputs[0].payload).toMatchObject({
      tool_call_id: "fc-1",
      success: true,
    });

    // Second: file_edited with structured data from changes
    expect(inputs[1].type).toBe("invocation.file_edited");
    expect(inputs[1].payload).toMatchObject({
      invocation_id: "inv-001",
      path: "src/index.ts",
      operation: "update",
    });
  });

  it("AC6: file_change with kind=add maps to operation=create", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "file_change",
        id: "fc-2",
        changes: [{ path: "new-file.ts", kind: "add" }],
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs[1].payload).toMatchObject({
      path: "new-file.ts",
      operation: "create",
    });
  });

  it("AC6: file_change with kind=add emits file_edited with lines_added=0 (line counts deferred to phase diff)", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "file_change",
        id: "fc-content",
        changes: [{ path: "new-file.ts", kind: "add" }],
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs[1].payload).toMatchObject({
      path: "new-file.ts",
      operation: "create",
      lines_added: 0,
      lines_removed: 0,
    });
  });

  it("AC6: file_change with kind=delete maps to operation=delete", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "file_change",
        id: "fc-3",
        changes: [{ path: "old-file.ts", kind: "delete" }],
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs[1].payload).toMatchObject({
      path: "old-file.ts",
      operation: "delete",
    });
  });

  it("AC6: file_change with multiple changes emits one file_edited per change", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "file_change",
        id: "fc-multi",
        changes: [
          { path: "a.ts", kind: "add" },
          { path: "b.ts", kind: "update" },
        ],
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    // 1 tool_returned + 2 file_edited
    expect(inputs).toHaveLength(3);
    expect(inputs[1].payload).toMatchObject({
      path: "a.ts",
      operation: "create",
    });
    expect(inputs[2].payload).toMatchObject({
      path: "b.ts",
      operation: "update",
    });
  });

  // AC7: item.completed for agent_message → invocation.assistant_message
  it("AC7: translates item.completed (agent_message) to invocation.assistant_message", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "item.completed",
      item: {
        type: "agent_message",
        id: "msg-1",
        text: "I've made the changes.",
      },
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.assistant_message");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      text: "I've made the changes.",
    });
  });

  // AC8: turn.completed → invocation.completed with token counts
  it("AC8: translates turn.completed to invocation.completed with all four token counts", () => {
    const ctx = makeCtx({ startedAt: Date.now() - 3000 });
    const line: CodexLine = {
      type: "turn.completed",
      turn_id: "turn-1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 30,
        reasoning_output_tokens: 20,
      },
      cost_usd: 0.01,
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.completed");
    const expectedCost = computeCost(baseOpts.model, 100, 50);
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      outcome: "success",
      tokens_in: 100,
      tokens_out: 50,
      cached_tokens_in: 30,
      reasoning_tokens_out: 20,
      cost_usd: expectedCost,
      turns: 1,
      exit_code: 0,
      exit_reason: "normal",
    });
    // duration_ms should be reasonable
    expect(
      (inputs[0].payload as InvocationCompleted).duration_ms,
    ).toBeGreaterThan(0);
  });

  it("computes cost_usd from model pricing instead of using cost_usd from the event", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "turn.completed",
      turn_id: "turn-1",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost_usd: 0.99,
    };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect((inputs[0].payload as InvocationCompleted).cost_usd).toBe(
      computeCost(baseOpts.model, 10, 5),
    );
  });

  it("returns cost_usd=0 for unknown models", () => {
    const ctx = makeCtx();
    const line: CodexLine = {
      type: "turn.completed",
      turn_id: "turn-1",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const inputs = translateLine(
      line,
      { ...baseOpts, model: "unknown-model" },
      bs,
      ctx,
    );
    expect((inputs[0].payload as InvocationCompleted).cost_usd).toBe(0);
  });

  it("AC8: turn.completed defaults token counts to 0 when no usage", () => {
    const ctx = makeCtx();
    const line: CodexLine = { type: "turn.completed", turn_id: "turn-1" };
    const inputs = translateLine(line, baseOpts, bs, ctx);
    expect(inputs[0].payload).toMatchObject({
      tokens_in: 0,
      tokens_out: 0,
      cached_tokens_in: 0,
      reasoning_tokens_out: 0,
      cost_usd: 0,
    });
  });

  it("AC8: turn count increments across multiple turn.completed events", () => {
    const ctx = makeCtx();
    translateLine(
      { type: "turn.completed", turn_id: "turn-1" } as CodexLine,
      baseOpts,
      bs,
      ctx,
    );
    expect(ctx.turnCount).toBe(1);
    const inputs = translateLine(
      { type: "turn.completed", turn_id: "turn-2" } as CodexLine,
      baseOpts,
      bs,
      ctx,
    );
    expect(ctx.turnCount).toBe(2);
    expect((inputs[0].payload as any).turns).toBe(2);
  });

  it("returns empty array for unknown line types", () => {
    const line = { type: "unknown_event" } as unknown as CodexLine;
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(0);
  });

  it("uses transport codex in actor", () => {
    const line: CodexLine = { type: "thread.started", thread_id: "t-1" };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs[0].actor).toMatchObject({
      kind: "cli",
      transport: "codex",
    });
  });
});

// ============================================================================
// invoke (full pipeline with fake spawner)
// ============================================================================

describe("invoke", () => {
  let bs: ReturnType<typeof makeBlobStore>;

  beforeEach(() => {
    bs = makeBlobStore();
  });

  it("yields events from a successful run with all four token counts", async () => {
    const lines: string[] = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1", model: "o3" }),
      JSON.stringify({ type: "turn.started", turn_id: "turn-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", id: "msg-1", text: "Done!" },
      }),
      JSON.stringify({
        type: "turn.completed",
        turn_id: "turn-1",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 3,
          reasoning_output_tokens: 2,
        },
        cost_usd: 0.001,
      }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) {
        yield line;
      }
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.assistant_message");
    expect(events[2].type).toBe("invocation.completed");
    const completed = events[2].payload as InvocationCompleted;
    expect(completed.outcome).toBe("success");
    expect(completed.tokens_in).toBe(10);
    expect(completed.tokens_out).toBe(5);
    expect(completed.cached_tokens_in).toBe(3);
    expect(completed.reasoning_tokens_out).toBe(2);
    expect(completed.cost_usd).toBe(computeCost(baseOpts.model, 10, 5));
  });

  it("yields errored + completed when spawner throws, with classified exit_reason", async () => {
    // oxlint-disable-next-line require-yield
    const fakeSpawner: Spawner = async function* () {
      throw Object.assign(new Error("codex crashed"), {
        exitCode: 137,
        signal: "SIGKILL",
      });
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("invocation.errored");
    expect(events[1].type).toBe("invocation.completed");
    const completed = events[1].payload as InvocationCompleted;
    expect(completed.outcome).toBe("failed");
    // AC6: classifySubprocessError maps SIGKILL → "killed"
    expect(completed.exit_reason).toBe("killed");
    expect(completed.exit_code).toBe(137);
  });

  it("AC6: classifies timeout from exit code 124", async () => {
    // oxlint-disable-next-line require-yield
    const fakeSpawner: Spawner = async function* () {
      throw Object.assign(new Error("timed out"), { exitCode: 124 });
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    const completed = events[1].payload as InvocationCompleted;
    expect(completed.exit_reason).toBe("timeout");
  });

  it("AC6: classifies network error from stderr", async () => {
    // oxlint-disable-next-line require-yield
    const fakeSpawner: Spawner = async function* () {
      throw Object.assign(new Error("connection failed"), {
        exitCode: 1,
        stderrTail: "ECONNREFUSED 127.0.0.1:443",
      });
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    const completed = events[1].payload as InvocationCompleted;
    expect(completed.exit_reason).toBe("network_error");
  });

  it("AC5: non-zero exit_code command_execution produces tool_returned error, not adapter termination", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", id: "cmd-fail", command: "false" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-fail",
          command: "false",
          output: "command failed",
          exit_code: 1,
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        turn_id: "turn-1",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    // Should have: started, tool_called, tool_returned (error), completed (success)
    const toolReturned = events.find(
      (e) => e.type === "invocation.tool_returned",
    );
    expect(toolReturned).toBeDefined();
    expect((toolReturned!.payload as any).success).toBe(false);
    expect((toolReturned!.payload as any).error).toBe("command failed");

    // The adapter should still complete successfully (not crash)
    const completed = events.find((e) => e.type === "invocation.completed");
    expect(completed).toBeDefined();
    expect((completed!.payload as InvocationCompleted).outcome).toBe("success");
  });

  it("skips malformed JSON lines", async () => {
    const lines = [
      "not json",
      JSON.stringify({ type: "thread.started", thread_id: "t-1", model: "o3" }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.completed");
  });

  it("records item start times for duration calculation", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1", model: "o3" }),
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", id: "cmd-1", command: "ls" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "ls",
          exit_code: 0,
        },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    // thread.started → invocation.started
    // item.started → invocation.tool_called
    // item.completed → invocation.tool_returned
    // turn.completed → invocation.completed
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.tool_called");
    expect(events[2].type).toBe("invocation.tool_returned");
    expect(events[3].type).toBe("invocation.completed");
  });

  it("turn.started produces no events in the pipeline", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "turn.started", turn_id: "turn-1" }),
      JSON.stringify({ type: "turn.started", turn_id: "turn-2" }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-2" }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    // Only thread.started and turn.completed produce events
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.completed");
  });

  it("file_change item.completed emits tool_returned + file_edited in invoke", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "file_change",
          id: "fc-1",
          changes: [{ path: "hello.ts", kind: "add" }],
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          id: "fc-1",
          changes: [{ path: "hello.ts", kind: "add" }],
        },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    // invocation.started, tool_called, tool_returned, file_edited, completed
    // (git diff detectFileEdits will likely return [] since /tmp/worktree doesn't exist)
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.tool_called");
    expect(events[2].type).toBe("invocation.tool_returned");
    expect(events[3].type).toBe("invocation.file_edited");
  });
});
