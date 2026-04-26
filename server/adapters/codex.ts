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
import { execa } from "execa";
import type { BlobStore } from "../blobStore.js";
import type { AppendEventInput } from "../eventStore.js";
import type { EventType, PhaseName, TransportOptions } from "@shared/events.js";

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

export type CodexLine =
  | { type: "start"; model: string; session_id?: string }
  | {
      type: "message";
      role: "assistant";
      content: string;
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      success: boolean;
      output?: string;
    }
  | {
      type: "end";
      reason: string;
      is_error: boolean;
      duration_ms: number;
      usage?: { input_tokens: number; output_tokens: number };
      cost_usd?: number;
      turns?: number;
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
  opts: { cwd: string },
  context?: SpawnerContext,
) => AsyncIterable<string>;

/**
 * Default spawner: reads stdout line-by-line from the codex subprocess.
 */
async function* execaSpawner(
  cmd: string,
  args: string[],
  opts: { cwd: string },
  context?: SpawnerContext,
): AsyncIterable<string> {
  const proc = execa(cmd, args, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  });

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

  try {
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
    if (result.exitCode !== 0) {
      const err = new Error(
        result.stderr ?? `codex exited with code ${result.exitCode}`,
      ) as Error & { exitCode?: number; signal?: string; stderrTail?: string };
      err.exitCode = result.exitCode ?? 1;
      if (result.signal) err.signal = result.signal;
      err.stderrTail = stderrTail || result.stderr || "";
      throw err;
    }
    if (context) context.stderrTail = stderrTail;
  } catch (err) {
    throw err;
  }
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
      args.push("--sandbox", "read-only", "--ask-for-approval", "untrusted");
      break;
  }

  // Output schema — write JSON to temp file
  if (to.schema) {
    const tmpDir = os.tmpdir();
    const schemaPath = path.join(tmpDir, `codex-schema-${opts.invocation_id}.json`);
    fs.writeFileSync(schemaPath, JSON.stringify(to.schema), "utf-8");
    args.push("--output-schema", schemaPath);
  }

  // Prompt is the final positional argument
  args.push(opts.prompt);

  return args;
}

// ============================================================================
// translateLine — pure translation of a parsed CodexLine
// ============================================================================

/**
 * Translates one Codex NDJSON line into zero or more AppendEventInput objects.
 */
export function translateLine(
  line: CodexLine,
  opts: InvokeOptions,
  blobStore: BlobStore,
  toolCallTimes: Record<string, number> = {},
  startedAt?: number,
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

  if (line.type === "start") {
    const input: AppendEventInput<"invocation.started"> = {
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
    };
    return [input];
  }

  if (line.type === "message" && line.role === "assistant") {
    const input: AppendEventInput<"invocation.assistant_message"> = {
      ...base,
      type: "invocation.assistant_message",
      payload: {
        invocation_id: opts.invocation_id,
        text: line.content,
        tokens: line.usage?.output_tokens,
      },
    };
    return [input];
  }

  if (line.type === "tool_call") {
    const argsJson = JSON.stringify(line.args);
    const { hash: args_hash } = blobStore.putBlob(argsJson);

    const input: AppendEventInput<"invocation.tool_called"> = {
      ...base,
      type: "invocation.tool_called",
      payload: {
        invocation_id: opts.invocation_id,
        tool_call_id: line.id,
        tool_name: line.name,
        args_hash,
      },
    };
    return [input];
  }

  if (line.type === "tool_result") {
    const calledAt = toolCallTimes[line.id];
    const duration_ms = calledAt ? Date.now() - calledAt : 0;

    const input: AppendEventInput<"invocation.tool_returned"> = {
      ...base,
      type: "invocation.tool_returned",
      payload: {
        invocation_id: opts.invocation_id,
        tool_call_id: line.id,
        success: line.success,
        duration_ms,
        error: !line.success ? line.output : undefined,
      },
    };
    return [input];
  }

  if (line.type === "end") {
    if (line.is_error) {
      const inputs: AppendEventInput[] = [];
      inputs.push({
        ...base,
        type: "invocation.errored",
        payload: {
          invocation_id: opts.invocation_id,
          error: line.reason,
          error_category: "unknown",
        },
      } satisfies AppendEventInput<"invocation.errored">);

      const duration_ms = startedAt ? Date.now() - startedAt : line.duration_ms;
      inputs.push({
        ...base,
        type: "invocation.completed",
        payload: {
          invocation_id: opts.invocation_id,
          outcome: "failed",
          tokens_in: line.usage?.input_tokens ?? 0,
          tokens_out: line.usage?.output_tokens ?? 0,
          cost_usd: line.cost_usd ?? 0,
          duration_ms,
          turns: line.turns ?? 0,
          exit_code: 1,
          exit_reason: "unknown",
          stdout_tail_hash: null,
          stderr_tail_hash: null,
          permission_blocked_on: null,
        },
      } satisfies AppendEventInput<"invocation.completed">);
      return inputs;
    }

    const duration_ms = startedAt ? Date.now() - startedAt : line.duration_ms;
    const input: AppendEventInput<"invocation.completed"> = {
      ...base,
      type: "invocation.completed",
      payload: {
        invocation_id: opts.invocation_id,
        outcome: "success",
        tokens_in: line.usage?.input_tokens ?? 0,
        tokens_out: line.usage?.output_tokens ?? 0,
        cost_usd: line.cost_usd ?? 0,
        duration_ms,
        turns: line.turns ?? 0,
        exit_code: 0,
        exit_reason: "normal",
        stdout_tail_hash: null,
        stderr_tail_hash: null,
        permission_blocked_on: null,
      },
    };
    return [input];
  }

  return [];
}

// ============================================================================
// invoke — the main async generator
// ============================================================================

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
  const toolCallTimes: Record<string, number> = {};
  const spawnerCtx: SpawnerContext = {};

  try {
    for await (const rawLine of spawner("codex", args, { cwd: opts.cwd }, spawnerCtx)) {
      let parsed: CodexLine;
      try {
        parsed = JSON.parse(rawLine) as CodexLine;
      } catch {
        continue;
      }

      // Record when each tool is called for duration_ms
      if (parsed.type === "tool_call") {
        toolCallTimes[parsed.id] = Date.now();
      }

      const inputs = translateLine(parsed, opts, blobStore, toolCallTimes, startedAt);
      for (const input of inputs) {
        yield input;
      }
    }
  } catch (err: unknown) {
    const error = err as Error & { exitCode?: number; signal?: string; stderrTail?: string };

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
        cost_usd: 0,
        duration_ms: Date.now() - startedAt,
        turns: 0,
        exit_code: error.exitCode ?? 1,
        exit_reason: "unknown",
        stdout_tail_hash: null,
        stderr_tail_hash: null,
        permission_blocked_on: null,
      },
    } satisfies AppendEventInput<"invocation.completed">;
  }
}
