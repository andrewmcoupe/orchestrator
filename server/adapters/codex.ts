/**
 * Codex CLI Adapter.
 *
 * Spawns `codex exec --json` and translates its NDJSON event stream into
 * canonical AppendEventInput objects. The caller is responsible for persisting
 * each yielded input via appendAndProject.
 *
 * A Spawner abstraction (same type as claudeCode.ts) allows injecting a fake
 * line source in tests without mocking the esm execa module.
 *
 * No permission-hang detection — Codex always receives --full-auto or
 * equivalent flags so it never prompts for permission.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execa } from "execa";
import type { BlobStore } from "../blobStore.js";
import type { AppendEventInput } from "../eventStore.js";
import type { ExitReason, PhaseName, TransportOptions } from "@shared/events.js";
import { classifySubprocessError } from "./claudeCode.js";
import { computeCost } from "./modelPricing.js";

// ============================================================================
// Public types
// ============================================================================

type CliTransportOptions = Extract<TransportOptions, { kind: "cli" }>;

export type InvokeOptions = {
  invocation_id: string;
  attempt_id: string;
  phase_name: PhaseName;
  model: string;
  /** The prompt text. */
  prompt: string;
  prompt_version_id: string;
  /** Hash of the context manifest stored in the blob store. */
  context_manifest_hash: string;
  /** Absolute path to the task worktree (used as cwd for the subprocess). */
  cwd: string;
  transport_options: CliTransportOptions;
};

// ============================================================================
// Codex NDJSON line types
// ============================================================================

/** Item types within Codex events. */
export type CodexItemType = "command_execution" | "file_change" | "agent_message";

export type CodexCommandExecutionItem = {
  type: "command_execution";
  id: string;
  command: string;
  output?: string;
  exit_code?: number;
};

export type CodexFileChangeItem = {
  type: "file_change";
  id: string;
  changes: Array<{
    path: string;
    kind: "add" | "update" | "delete";
  }>;
  status?: string;
};

export type CodexAgentMessageItem = {
  type: "agent_message";
  id: string;
  text: string;
};

export type CodexItem = CodexCommandExecutionItem | CodexFileChangeItem | CodexAgentMessageItem;

export type CodexLine =
  | { type: "thread.started"; thread_id: string; model?: string }
  | { type: "turn.started"; turn_id: string }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | {
      type: "turn.completed";
      turn_id: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens?: number;
        reasoning_output_tokens?: number;
      };
      cost_usd?: number;
      duration_ms?: number;
    };

// ============================================================================
// Spawner abstraction (same type as claudeCode.ts)
// ============================================================================

export type SpawnerContext = {
  stderrTail?: string;
};

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; stdinData?: string },
  context?: SpawnerContext,
) => AsyncIterable<string>;

/**
 * Default spawner: reads stdout line-by-line from the codex subprocess.
 * When opts.stdinData is provided, it is piped to the process stdin.
 */
async function* execaSpawner(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdinData?: string },
  context?: SpawnerContext,
): AsyncIterable<string> {
  const proc = execa(cmd, args, {
    cwd: opts.cwd,
    stdin: opts.stdinData ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  });

  // Pipe prompt to stdin if provided
  if (opts.stdinData && proc.stdin) {
    proc.stdin.write(opts.stdinData);
    proc.stdin.end();
  }

  const stdout = proc.stdout;
  if (!stdout) {
    const result = await proc;
    const err = new Error(result.stderr ?? "No stdout from codex") as Error & {
      exitCode?: number;
    };
    err.exitCode = result.exitCode ?? 1;
    throw err;
  }

  let stderrTail = "";
  const stderr = proc.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
  }

  let buffer = "";
  for await (const chunk of stdout) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer;

  const result = await proc;
  console.log(`[codex] process exited: code=${result.exitCode}, signal=${result.signal ?? "none"}, stderr=${stderrTail.slice(-500)}`);
  if (result.exitCode !== 0) {
    const err = new Error(
      stderrTail || result.stderr || `codex exited with code ${result.exitCode}`,
    ) as Error & { exitCode?: number; signal?: string; stderrTail?: string };
    err.exitCode = result.exitCode ?? 1;
    if (result.signal) err.signal = result.signal;
    err.stderrTail = stderrTail || result.stderr || "";
    throw err;
  }
  if (context) context.stderrTail = stderrTail;
}

// ============================================================================
// enforceNoAdditionalProperties — OpenAI schema compliance
// ============================================================================

/**
 * Recursively transforms a JSON Schema to comply with OpenAI's structured
 * output requirements:
 *   1. Every object with `properties` gets `additionalProperties: false`.
 *   2. Every object with `properties` gets `required` set to all property keys
 *      (OpenAI requires all properties to be listed in required).
 */
export function enforceOpenAiSchemaRules(schema: unknown): unknown {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(enforceOpenAiSchemaRules);

  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = enforceOpenAiSchemaRules(value);
  }
  if (out["type"] === "object" && out["properties"] != null) {
    out["additionalProperties"] = false;
    out["required"] = Object.keys(out["properties"] as Record<string, unknown>);
  }
  return out;
}

// ============================================================================
// buildArgs — pure CLI argument construction
// ============================================================================

/**
 * Constructs the CLI args array for `codex exec`.
 *
 * Produces: codex exec --json --ephemeral --cd <cwd> --model <model> <prompt>
 *
 * Permission mode mapping:
 *   acceptEdits / auto          → --full-auto
 *   bypassPermissions           → --dangerously-bypass-approvals-and-sandbox
 *   plan / default              → --sandbox read-only --ask-for-approval untrusted
 *
 * When transport_options includes a `schema`, the JSON schema is written to a
 * temp file and `--output-schema <path>` is appended.
 */
export function buildArgs(opts: InvokeOptions): string[] {
  const { transport_options: to } = opts;
  const args: string[] = [
    "exec",
    "--json",
    "--ephemeral",
    "--cd",
    opts.cwd,
    "--model",
    opts.model,
  ];

  // Permission mode mapping
  const mode = to.permission_mode ?? "acceptEdits";
  switch (mode) {
    case "acceptEdits":
    case "auto":
      args.push("--full-auto");
      break;
    case "bypassPermissions":
      args.push("--dangerously-bypass-approvals-and-sandbox");
      break;
    case "plan":
    case "default":
      args.push("--sandbox", "read-only");
      break;
  }

  // Output schema — write JSON to temp file
  // OpenAI requires `additionalProperties: false` on every object node.
  if (to.schema) {
    const tmpDir = os.tmpdir();
    const schemaPath = path.join(tmpDir, `codex-schema-${opts.invocation_id}.json`);
    fs.writeFileSync(schemaPath, JSON.stringify(enforceOpenAiSchemaRules(to.schema)), "utf-8");
    args.push("--output-schema", schemaPath);
  }

  // Prompt is piped via stdin using "-" as the positional argument.
  // Packed context can be very large, exceeding shell argument limits.
  args.push("-");

  return args;
}

// ============================================================================
// translateLine — pure translation of a parsed CodexLine
// ============================================================================

/**
 * Context passed into translateLine so it can schedule async side effects
 * (like git diff) that the caller (invoke) will execute.
 */
export type TranslateContext = {
  /** Map from item id → timestamp when item.started was seen. */
  itemStartTimes: Record<string, number>;
  /** Epoch ms when the invocation started (for completed duration). */
  startedAt?: number;
  /** Number of turns completed so far (incremented on turn.completed). */
  turnCount: number;
  /**
   * Paths emitted as file_edited by translateLine (from file_change items).
   * invoke() pre-populates seenFileSnapshot from this set so detectFileEdits
   * does not emit a duplicate file_edited for the same path.
   */
  fileChangePathsSeen: Set<string>;
};

/**
 * Translates one Codex NDJSON line into zero or more AppendEventInput objects.
 *
 * AC1: thread.started → invocation.started
 * AC2: turn.started → [] (internal bookkeeping)
 * AC3: item.started (command_execution) → invocation.tool_called (command in blob)
 * AC4: item.completed (command_execution) → invocation.tool_returned (+ git diff in invoke)
 * AC5: item.started (file_change) → invocation.tool_called
 * AC6: item.completed (file_change) → invocation.tool_returned + invocation.file_edited (+ git diff in invoke)
 * AC7: item.completed (agent_message) → invocation.assistant_message
 * AC8: turn.completed → invocation.completed with token counts
 */
export function translateLine(
  line: CodexLine,
  opts: InvokeOptions,
  blobStore: BlobStore,
  ctx: TranslateContext = { itemStartTimes: {}, turnCount: 0, fileChangePathsSeen: new Set() },
): AppendEventInput[] {
  const actor = {
    kind: "cli" as const,
    transport: "codex" as const,
    invocation_id: opts.invocation_id,
  };
  const base = {
    aggregate_type: "attempt" as const,
    aggregate_id: opts.attempt_id,
    actor,
    correlation_id: opts.attempt_id,
  };

  // AC1: thread.started → invocation.started
  if (line.type === "thread.started") {
    return [{
      ...base,
      type: "invocation.started",
      payload: {
        invocation_id: opts.invocation_id,
        attempt_id: opts.attempt_id,
        phase_name: opts.phase_name,
        transport: "codex",
        model: opts.model,
        prompt_version_id: opts.prompt_version_id,
        context_manifest_hash: opts.context_manifest_hash,
      },
    } satisfies AppendEventInput<"invocation.started">];
  }

  // AC2: turn.started → no event (internal bookkeeping)
  if (line.type === "turn.started") {
    return [];
  }

  // AC3 + AC5: item.started → invocation.tool_called
  if (line.type === "item.started") {
    const item = line.item;
    ctx.itemStartTimes[item.id] = Date.now();

    if (item.type === "command_execution") {
      // AC3: store command in blob store
      const { hash: args_hash } = blobStore.putBlob(
        JSON.stringify({ command: item.command }),
      );
      return [{
        ...base,
        type: "invocation.tool_called",
        payload: {
          invocation_id: opts.invocation_id,
          tool_call_id: item.id,
          tool_name: "command_execution",
          args_hash,
        },
      } satisfies AppendEventInput<"invocation.tool_called">];
    }

    if (item.type === "file_change") {
      // AC5: item.started for file_change → invocation.tool_called
      const { hash: args_hash } = blobStore.putBlob(
        JSON.stringify({ changes: item.changes }),
      );
      return [{
        ...base,
        type: "invocation.tool_called",
        payload: {
          invocation_id: opts.invocation_id,
          tool_call_id: item.id,
          tool_name: "file_change",
          args_hash,
        },
      } satisfies AppendEventInput<"invocation.tool_called">];
    }

    return [];
  }

  // AC4, AC6, AC7: item.completed
  if (line.type === "item.completed") {
    const item = line.item;
    const calledAt = ctx.itemStartTimes[item.id];
    const duration_ms = calledAt ? Date.now() - calledAt : 0;

    // AC4: command_execution completed → invocation.tool_returned
    if (item.type === "command_execution") {
      const success = item.exit_code == null || item.exit_code === 0;
      return [{
        ...base,
        type: "invocation.tool_returned",
        payload: {
          invocation_id: opts.invocation_id,
          tool_call_id: item.id,
          success,
          duration_ms,
          error: !success ? (item.output ?? `exit code ${item.exit_code}`) : undefined,
        },
      } satisfies AppendEventInput<"invocation.tool_returned">];
    }

    // AC6: file_change completed → invocation.tool_returned + invocation.file_edited per change
    if (item.type === "file_change") {
      const inputs: AppendEventInput[] = [];

      inputs.push({
        ...base,
        type: "invocation.tool_returned",
        payload: {
          invocation_id: opts.invocation_id,
          tool_call_id: item.id,
          success: true,
          duration_ms,
        },
      } satisfies AppendEventInput<"invocation.tool_returned">);

      // Emit one file_edited per change. Codex stages changes internally
      // so git diff HEAD returns nothing — line counts will be 0 here.
      // The phase-level diff snapshot (base_sha..HEAD) provides accurate
      // counts for the review screen.
      for (const change of item.changes ?? []) {
        const operation = change.kind === "add" ? "create" as const
          : change.kind === "delete" ? "delete" as const
          : "update" as const;

        const patchContent = `file_change: ${operation} ${change.path}`;
        const patch_hash = createHash("sha256").update(patchContent).digest("hex");

        inputs.push({
          ...base,
          type: "invocation.file_edited",
          payload: {
            invocation_id: opts.invocation_id,
            path: change.path,
            operation,
            patch_hash,
            lines_added: 0,
            lines_removed: 0,
          },
        } satisfies AppendEventInput<"invocation.file_edited">);

        // Track path so git diff safety net skips duplicates
        ctx.fileChangePathsSeen.add(change.path);
      }

      return inputs;
    }

    // AC7: agent_message completed → invocation.assistant_message
    if (item.type === "agent_message") {
      return [{
        ...base,
        type: "invocation.assistant_message",
        payload: {
          invocation_id: opts.invocation_id,
          text: item.text,
        },
      } satisfies AppendEventInput<"invocation.assistant_message">];
    }

    return [];
  }

  // AC8: turn.completed → invocation.completed with token counts
  if (line.type === "turn.completed") {
    ctx.turnCount += 1;
    const duration_ms = ctx.startedAt ? Date.now() - ctx.startedAt : (line.duration_ms ?? 0);
    const tokens_in = line.usage?.input_tokens ?? 0;
    const tokens_out = line.usage?.output_tokens ?? 0;
    return [{
      ...base,
      type: "invocation.completed",
      payload: {
        invocation_id: opts.invocation_id,
        outcome: "success",
        tokens_in,
        tokens_out,
        cached_tokens_in: line.usage?.cached_input_tokens ?? 0,
        reasoning_tokens_out: line.usage?.reasoning_output_tokens ?? 0,
        cost_usd: computeCost(opts.model, tokens_in, tokens_out),
        duration_ms,
        turns: ctx.turnCount,
        exit_code: 0,
        exit_reason: "normal",
        stdout_tail_hash: null,
        stderr_tail_hash: null,
        permission_blocked_on: null,
      },
    } satisfies AppendEventInput<"invocation.completed">];
  }

  return [];
}

// ============================================================================
// invoke — the main async generator
// ============================================================================

// ============================================================================
// Git diff helper for file edit detection (AC4, AC6 safety net)
// ============================================================================

/**
 * Runs `git diff HEAD --numstat --name-status` in the cwd and returns
 * invocation.file_edited events for files that changed since the last snapshot.
 */
export async function detectFileEdits(
  cwd: string,
  invocation_id: string,
  attempt_id: string,
  seenSnapshot: Map<string, { lines_added: number; lines_removed: number; operation: string }>,
): Promise<AppendEventInput<"invocation.file_edited">[]> {
  let numstatOut = "";
  let nameStatusOut = "";
  try {
    const [ns, nm] = await Promise.all([
      execa("git", ["diff", "HEAD", "--numstat"], { cwd }),
      execa("git", ["diff", "HEAD", "--name-status"], { cwd }),
    ]);
    numstatOut = ns.stdout;
    nameStatusOut = nm.stdout;
  } catch {
    return [];
  }

  const actor = {
    kind: "cli" as const,
    transport: "codex" as const,
    invocation_id,
  };

  const inputs: AppendEventInput<"invocation.file_edited">[] = [];

  // Parse numstat
  const numstat: Record<string, { lines_added: number; lines_removed: number }> = {};
  for (const line of numstatOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, filePath] = parts;
    numstat[filePath] = {
      lines_added: added === "-" ? 0 : parseInt(added, 10) || 0,
      lines_removed: removed === "-" ? 0 : parseInt(removed, 10) || 0,
    };
  }

  // Parse name-status
  const nameStatus: Record<string, "A" | "M" | "D"> = {};
  for (const line of nameStatusOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const [status, ...paths] = parts;
    if (status.startsWith("R")) {
      if (paths[0]) nameStatus[paths[0]] = "D";
      if (paths[1]) nameStatus[paths[1]] = "A";
    } else if (status === "M" || status === "A" || status === "D") {
      nameStatus[paths[0]] = status;
    }
  }

  for (const [filePath, op] of Object.entries(nameStatus)) {
    const counts = numstat[filePath] ?? { lines_added: 0, lines_removed: 0 };
    const prev = seenSnapshot.get(filePath);
    const hasChanged = !prev ||
      prev.lines_added !== counts.lines_added ||
      prev.lines_removed !== counts.lines_removed ||
      prev.operation !== op;

    if (hasChanged) {
      const patchContent = `diff --git a/${filePath} b/${filePath}\n@ ${op} +${counts.lines_added} -${counts.lines_removed}`;
      const patch_hash = createHash("sha256").update(patchContent).digest("hex");

      inputs.push({
        type: "invocation.file_edited",
        aggregate_type: "attempt",
        aggregate_id: attempt_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          invocation_id,
          path: filePath,
          operation: op === "A" ? "create" : op === "D" ? "delete" : "update",
          patch_hash,
          lines_added: counts.lines_added,
          lines_removed: counts.lines_removed,
        },
      });

      seenSnapshot.set(filePath, { ...counts, operation: op });
    }
  }

  return inputs;
}

/**
 * Spawns the Codex CLI and translates its NDJSON output into a stream
 * of AppendEventInput objects.
 */
export async function* invoke(
  opts: InvokeOptions,
  blobStore: BlobStore,
  spawner: Spawner = execaSpawner,
): AsyncIterable<AppendEventInput> {
  const startedAt = Date.now();
  const args = buildArgs(opts);
  console.log(`[codex] spawning: args=${JSON.stringify(args.filter(a => a !== "-"))}, cwd=${opts.cwd}, promptLen=${opts.prompt.length}`);
  const ctx: TranslateContext = { itemStartTimes: {}, startedAt, turnCount: 0, fileChangePathsSeen: new Set() };
  const spawnerCtx: SpawnerContext = {};

  // Snapshot of previously detected file changes for git diff deduplication
  const seenFileSnapshot = new Map<
    string,
    { lines_added: number; lines_removed: number; operation: string }
  >();

  try {
    for await (const rawLine of spawner("codex", args, { cwd: opts.cwd, stdinData: opts.prompt }, spawnerCtx)) {
      let parsed: CodexLine;
      try {
        parsed = JSON.parse(rawLine) as CodexLine;
      } catch {
        continue;
      }

      const inputs = translateLine(parsed, opts, blobStore, ctx);
      for (const input of inputs) {
        yield input;
      }

      // AC4 + AC6: run git diff after item.completed for command_execution or file_change
      if (parsed.type === "item.completed" &&
          (parsed.item.type === "command_execution" || parsed.item.type === "file_change")) {
        const fileEdits = await detectFileEdits(
          opts.cwd,
          opts.invocation_id,
          opts.attempt_id,
          seenFileSnapshot,
        );
        for (const edit of fileEdits) {
          // Skip paths already emitted as file_edited by translateLine
          // (from file_change items) to avoid duplicate events.
          const editPayload = edit.payload as { path: string };
          if (ctx.fileChangePathsSeen.has(editPayload.path)) continue;
          yield edit;
        }
      }
    }
  } catch (err: unknown) {
    const error = err as Error & { exitCode?: number; signal?: string; stderrTail?: string };
    const stderrForClassify = error.stderrTail ?? error.message;
    const exitReason: ExitReason = classifySubprocessError(error, stderrForClassify);

    const actor = {
      kind: "cli" as const,
      transport: "codex" as const,
      invocation_id: opts.invocation_id,
    };

    yield {
      type: "invocation.errored",
      aggregate_type: "attempt",
      aggregate_id: opts.attempt_id,
      actor,
      correlation_id: opts.attempt_id,
      payload: {
        invocation_id: opts.invocation_id,
        error: error.message ?? "Unknown error",
        error_category: "aborted",
      },
    } satisfies AppendEventInput<"invocation.errored">;

    yield {
      type: "invocation.completed",
      aggregate_type: "attempt",
      aggregate_id: opts.attempt_id,
      actor,
      correlation_id: opts.attempt_id,
      payload: {
        invocation_id: opts.invocation_id,
        outcome: "failed",
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: computeCost(opts.model, 0, 0),
        duration_ms: Date.now() - startedAt,
        turns: 0,
        exit_code: error.exitCode ?? 1,
        exit_reason: exitReason,
        stdout_tail_hash: null,
        stderr_tail_hash: null,
        permission_blocked_on: null,
      },
    } satisfies AppendEventInput<"invocation.completed">;
  }
}
