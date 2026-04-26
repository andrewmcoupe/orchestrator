/**
 * Tests for the Codex CLI adapter.
 *
 * These tests cover:
 *   1. buildArgs — CLI arg construction and permission mode mapping
 *   2. translateLine — translation of each Codex NDJSON line type
 *   3. Full invoke() pipeline via an injected fake spawner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  type SpawnerContext,
} from "./codex.js";
import type { BlobStore } from "../blobStore.js";
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
      stored.set(hash, Buffer.isBuffer(content) ? content.toString() : String(content));
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

// ============================================================================
// buildArgs
// ============================================================================

describe("buildArgs", () => {
  afterEach(() => {
    // Clean up any temp schema files
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("codex-schema-"));
    for (const f of files) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
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

    // Prompt is the last positional argument
    expect(args[args.length - 1]).toBe(baseOpts.prompt);
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
      transport_options: { ...baseOpts.transport_options, permission_mode: "auto" },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--full-auto");
  });

  it("includes --dangerously-bypass-approvals-and-sandbox when permission_mode is bypassPermissions", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, permission_mode: "bypassPermissions" },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");
  });

  it("includes --sandbox read-only --ask-for-approval untrusted when permission_mode is plan", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, permission_mode: "plan" },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("--ask-for-approval");
    expect(args).toContain("untrusted");
    expect(args).not.toContain("--full-auto");
  });

  it("includes --sandbox read-only --ask-for-approval untrusted when permission_mode is default", () => {
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, permission_mode: "default" },
    };
    const args = buildArgs(opts);
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("--ask-for-approval");
    expect(args).toContain("untrusted");
  });

  it("appends --output-schema <path> when schema is provided", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } };
    const opts: InvokeOptions = {
      ...baseOpts,
      transport_options: { ...baseOpts.transport_options, schema },
    };
    const args = buildArgs(opts);
    const schemaIdx = args.indexOf("--output-schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaPath = args[schemaIdx + 1];
    expect(schemaPath).toContain("codex-schema-");

    // Verify the temp file was written with the schema JSON
    const written = fs.readFileSync(schemaPath, "utf-8");
    expect(JSON.parse(written)).toEqual(schema);
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

  it("translates a start line into invocation.started", () => {
    const line: CodexLine = { type: "start", model: "o3" };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.started");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      transport: "codex",
      model: "o3",
    });
  });

  it("translates an assistant message", () => {
    const line: CodexLine = {
      type: "message",
      role: "assistant",
      content: "Hello!",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.assistant_message");
    expect(inputs[0].payload).toMatchObject({
      invocation_id: "inv-001",
      text: "Hello!",
      tokens: 5,
    });
  });

  it("translates a tool_call line and stores args in blob store", () => {
    const line: CodexLine = {
      type: "tool_call",
      id: "tc-001",
      name: "write_file",
      args: { path: "/tmp/test.txt", content: "hi" },
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.tool_called");
    expect(inputs[0].payload).toMatchObject({
      tool_call_id: "tc-001",
      tool_name: "write_file",
    });
    // Args should be stored in the blob store
    expect(bs.stored.size).toBe(1);
  });

  it("translates a tool_result line", () => {
    const line: CodexLine = {
      type: "tool_result",
      id: "tc-001",
      success: true,
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.tool_returned");
    expect(inputs[0].payload).toMatchObject({
      tool_call_id: "tc-001",
      success: true,
    });
  });

  it("translates a tool_result with error", () => {
    const line: CodexLine = {
      type: "tool_result",
      id: "tc-002",
      success: false,
      output: "file not found",
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].payload).toMatchObject({
      success: false,
      error: "file not found",
    });
  });

  it("translates a successful end line into invocation.completed", () => {
    const line: CodexLine = {
      type: "end",
      reason: "done",
      is_error: false,
      duration_ms: 5000,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost_usd: 0.01,
      turns: 3,
    };
    const inputs = translateLine(line, baseOpts, bs, {}, Date.now() - 5000);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("invocation.completed");
    expect(inputs[0].payload).toMatchObject({
      outcome: "success",
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.01,
      turns: 3,
      exit_code: 0,
      exit_reason: "normal",
    });
  });

  it("translates an error end line into errored + completed", () => {
    const line: CodexLine = {
      type: "end",
      reason: "budget exceeded",
      is_error: true,
      duration_ms: 10000,
    };
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].type).toBe("invocation.errored");
    expect(inputs[0].payload).toMatchObject({
      error: "budget exceeded",
    });
    expect(inputs[1].type).toBe("invocation.completed");
    expect(inputs[1].payload).toMatchObject({
      outcome: "failed",
    });
  });

  it("returns empty array for unknown line types", () => {
    const line = { type: "unknown_event" } as unknown as CodexLine;
    const inputs = translateLine(line, baseOpts, bs);
    expect(inputs).toHaveLength(0);
  });

  it("uses transport codex in actor", () => {
    const line: CodexLine = { type: "start", model: "o3" };
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

  it("yields events from a successful run", async () => {
    const lines: string[] = [
      JSON.stringify({ type: "start", model: "o3" }),
      JSON.stringify({ type: "message", role: "assistant", content: "Done!", usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({ type: "end", reason: "done", is_error: false, duration_ms: 1000, usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.001, turns: 1 }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.assistant_message");
    expect(events[2].type).toBe("invocation.completed");
    expect((events[2].payload as InvocationCompleted).outcome).toBe("success");
  });

  it("yields errored + completed when spawner throws", async () => {
    const fakeSpawner: Spawner = async function* () {
      throw Object.assign(new Error("codex crashed"), { exitCode: 1 });
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("invocation.errored");
    expect(events[1].type).toBe("invocation.completed");
    expect((events[1].payload as InvocationCompleted).outcome).toBe("failed");
  });

  it("skips malformed JSON lines", async () => {
    const lines = [
      "not json",
      JSON.stringify({ type: "start", model: "o3" }),
      JSON.stringify({ type: "end", reason: "done", is_error: false, duration_ms: 500, turns: 1 }),
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

  it("records tool call times for duration calculation", async () => {
    const lines = [
      JSON.stringify({ type: "start", model: "o3" }),
      JSON.stringify({ type: "tool_call", id: "tc-1", name: "read_file", args: { path: "/x" } }),
      JSON.stringify({ type: "tool_result", id: "tc-1", success: true }),
      JSON.stringify({ type: "end", reason: "done", is_error: false, duration_ms: 1000, turns: 1 }),
    ];

    const fakeSpawner: Spawner = async function* (_cmd, _args, _opts) {
      for (const line of lines) yield line;
    };

    const events = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner)) {
      events.push(ev);
    }

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("invocation.started");
    expect(events[1].type).toBe("invocation.tool_called");
    expect(events[2].type).toBe("invocation.tool_returned");
    expect(events[3].type).toBe("invocation.completed");
  });
});
