/**
 * Claude Code CLI Adapter.
 *
 * Spawns `claude` with --output-format stream-json --verbose and translates
 * each NDJSON line into canonical AppendEventInput objects. The caller is
 * responsible for persisting each yielded input via appendAndProject.
 *
 * File edits are detected by running `git diff HEAD --numstat --name-status`
 * in the worktree cwd after each Write / Edit / MultiEdit / Create tool_result.
 *
 * Tool call args are stored in the blob store; only args_hash is included
 * in the invocation.tool_called event payload.
 *
 * A Spawner abstraction allows injecting a fake line source in tests
 * without mocking the esm execa module.
 */

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
  /** The -p prompt text. */
  prompt: string;
  prompt_version_id: string;
  /** Hash of the context manifest stored in the blob store. */
  context_manifest_hash: string;
  /** Optional path to a system prompt file passed via --append-system-prompt-file. */
  systemPromptFile?: string;
  /** Absolute path to the task worktree (used as cwd for the subprocess). */
  cwd: string;
  transport_options: CliTransportOptions;
};

// ============================================================================
// Claude Code stream-json line types
// ============================================================================

export type ClaudeTextBlock = { type: "text"; text: string };
export type ClaudeToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock;

export type ClaudeCodeLine =
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      model: string;
      permissionMode: string;
      tools?: string[];
    }
  | {
      type: "assistant";
      message: {
        id: string;
        type: "message";
        role: "assistant";
        content: ClaudeContentBlock[];
        model: string;
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };
      session_id: string;
    }
  | {
      type: "user";
      message: {
        role: "user";
        content: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string | Array<{ type: string; text?: string }>;
          is_error?: boolean;
        }>;
      };
      session_id: string;
    }
  | {
      type: "result";
      subtype: string;
      duration_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

// ============================================================================
// Spawner abstraction
// ============================================================================

/**
 * Async generator yielding raw NDJSON lines from the claude subprocess.
 * Default implementation uses execa; inject a fake in tests.
 */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => AsyncIterable<string>;

/**
 * Default spawner: reads stdout line-by-line from the claude subprocess.
 * Throws with exitCode attached on non-zero exit.
 */
async function* execaSpawner(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): AsyncIterable<string> {
  const proc = execa(cmd, args, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    reject: false, // handle errors ourselves
  });

  const stdout = proc.stdout;
  if (!stdout) {
    const result = await proc;
    const err = new Error(result.stderr ?? "No stdout from claude") as Error & {
      exitCode?: number;
    };
    err.exitCode = result.exitCode ?? 1;
    throw err;
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
  if (result.exitCode !== 0) {
    const err = new Error(
      result.stderr ?? `claude exited with code ${result.exitCode}`,
    ) as Error & { exitCode?: number };
    err.exitCode = result.exitCode ?? 1;
    throw err;
  }
}

// ============================================================================
// buildArgs — pure CLI argument construction
// ============================================================================

/**
 * Constructs the CLI args array for `claude`.
 *
 * If transport_options includes a `schema`, serialises it as inline JSON
 * and passes `--json-schema <json>`. Because execa uses spawn (not shell),
 * the JSON string is passed as a single argv element — no shell-quoting issues.
 */
export function buildArgs(opts: InvokeOptions): string[] {
  const { transport_options: to } = opts;
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--permission-mode",
    to.permission_mode ?? "acceptEdits",
    "--max-turns",
    String(to.max_turns ?? 10),
  ];

  // Only add budget flag when a value is provided
  if (to.max_budget_usd != null) {
    args.push("--max-budget-usd", String(to.max_budget_usd));
  }

  if (opts.systemPromptFile) {
    args.push("--append-system-prompt-file", opts.systemPromptFile);
  }

  if (to.allowed_tools && to.allowed_tools.length > 0) {
    args.push("--allowedTools", to.allowed_tools.join(","));
  }

  if (to.schema) {
    args.push("--json-schema", JSON.stringify(to.schema));
  }

  return args;
}

// ============================================================================
// translateLine — pure translation of a parsed ClaudeCodeLine
// ============================================================================

/**
 * Translates one Claude Code stream-json line into zero or more AppendEventInput objects.
 *
 * @param line           Parsed JSON from stdout
 * @param opts           Invocation options (for invocation/attempt/phase identifiers)
 * @param blobStore      Used to store tool call args
 * @param toolCallTimes  Map from tool_call_id → timestamp when call was made (for duration_ms)
 * @param startedAt      Epoch ms when the invocation started (for completed duration)
 */
export function translateLine(
  line: ClaudeCodeLine,
  opts: InvokeOptions,
  blobStore: BlobStore,
  toolCallTimes: Record<string, number> = {},
  startedAt?: number,
): AppendEventInput[] {
  const actor = {
    kind: "cli" as const,
    transport: "claude-code" as const,
    invocation_id: opts.invocation_id,
  };
  const base = {
    aggregate_type: "attempt" as const,
    aggregate_id: opts.attempt_id,
    actor,
    correlation_id: opts.attempt_id,
  };

  if (line.type === "system" && line.subtype === "init") {
    const input: AppendEventInput<"invocation.started"> = {
      ...base,
      type: "invocation.started",
      payload: {
        invocation_id: opts.invocation_id,
        attempt_id: opts.attempt_id,
        phase_name: opts.phase_name,
        transport: "claude-code",
        model: opts.model,
        prompt_version_id: opts.prompt_version_id,
        context_manifest_hash: opts.context_manifest_hash,
      },
    };
    return [input];
  }

  if (line.type === "assistant") {
    const inputs: AppendEventInput[] = [];
    for (const block of line.message.content) {
      if (block.type === "text") {
        const input: AppendEventInput<"invocation.assistant_message"> = {
          ...base,
          type: "invocation.assistant_message",
          payload: {
            invocation_id: opts.invocation_id,
            text: block.text,
            tokens: line.message.usage.output_tokens,
          },
        };
        inputs.push(input);
      } else if (block.type === "tool_use") {
        // Store args in blob store — only hash goes in the event
        const argsJson = JSON.stringify(block.input);
        const { hash: args_hash } = blobStore.putBlob(argsJson);

        const input: AppendEventInput<"invocation.tool_called"> = {
          ...base,
          type: "invocation.tool_called",
          payload: {
            invocation_id: opts.invocation_id,
            tool_call_id: block.id,
            tool_name: block.name,
            args_hash,
          },
        };
        inputs.push(input);
      }
    }
    return inputs;
  }

  if (line.type === "user") {
    const inputs: AppendEventInput[] = [];
    for (const item of line.message.content) {
      if (item.type === "tool_result") {
        const calledAt = toolCallTimes[item.tool_use_id];
        const duration_ms = calledAt ? Date.now() - calledAt : 0;

        const input: AppendEventInput<"invocation.tool_returned"> = {
          ...base,
          type: "invocation.tool_returned",
          payload: {
            invocation_id: opts.invocation_id,
            tool_call_id: item.tool_use_id,
            success: !(item.is_error ?? false),
            duration_ms,
            error: item.is_error
              ? typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content)
              : undefined,
          },
        };
        inputs.push(input);
      }
    }
    return inputs;
  }

  if (line.type === "result") {
    if (line.is_error) {
      const errorCategory = mapErrorCategory(line.subtype);
      const input: AppendEventInput<"invocation.errored"> = {
        ...base,
        type: "invocation.errored",
        payload: {
          invocation_id: opts.invocation_id,
          error: line.result,
          error_category: errorCategory,
        },
      };
      return [input];
    }

    const duration_ms = startedAt ? Date.now() - startedAt : line.duration_ms;
    const input: AppendEventInput<"invocation.completed"> = {
      ...base,
      type: "invocation.completed",
      payload: {
        invocation_id: opts.invocation_id,
        outcome: "success",
        tokens_in: line.usage.input_tokens,
        tokens_out: line.usage.output_tokens,
        cost_usd: line.total_cost_usd,
        duration_ms,
        turns: line.num_turns,
        exit_code: 0,
      },
    };
    return [input];
  }

  return [];
}

// ============================================================================
// Git diff helpers
// ============================================================================

/**
 * Parses `git diff HEAD --numstat` output into a map of
 * { filePath → { lines_added, lines_removed } }.
 */
export function parseGitNumstat(
  output: string,
): Record<string, { lines_added: number; lines_removed: number }> {
  const result: Record<string, { lines_added: number; lines_removed: number }> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, filePath] = parts;
    result[filePath] = {
      lines_added: added === "-" ? 0 : parseInt(added, 10) || 0,
      lines_removed: removed === "-" ? 0 : parseInt(removed, 10) || 0,
    };
  }
  return result;
}

/**
 * Parses `git diff HEAD --name-status` output into a map of
 * { filePath → operation ("A" | "M" | "D") }.
 *
 * Rename lines (R100<tab>old<tab>new) are treated as: old=D, new=A.
 */
export function parseGitNameStatus(
  output: string,
): Record<string, "A" | "M" | "D"> {
  const result: Record<string, "A" | "M" | "D"> = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const [status, ...paths] = parts;

    if (status.startsWith("R")) {
      // Rename: oldPath deleted, newPath added
      if (paths[0]) result[paths[0]] = "D";
      if (paths[1]) result[paths[1]] = "A";
    } else if (status === "M" || status === "A" || status === "D") {
      result[paths[0]] = status;
    }
  }
  return result;
}

/**
 * Returns file edit events for files that have changed in the worktree
 * since the last snapshot, by running `git diff HEAD` in the cwd.
 *
 * We track a `seenSnapshot` of previously processed diffs so we only
 * emit events for files that are genuinely new or changed since last check.
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
    // Not a git repo or no HEAD — skip file edit detection
    return [];
  }

  const numstat = parseGitNumstat(numstatOut);
  const nameStatus = parseGitNameStatus(nameStatusOut);

  const actor = {
    kind: "cli" as const,
    transport: "claude-code" as const,
    invocation_id,
  };

  const inputs: AppendEventInput<"invocation.file_edited">[] = [];

  for (const [filePath, op] of Object.entries(nameStatus)) {
    const counts = numstat[filePath] ?? { lines_added: 0, lines_removed: 0 };
    const prev = seenSnapshot.get(filePath);

    // Only emit if this file is new or the line counts have changed
    const hasChanged =
      !prev ||
      prev.lines_added !== counts.lines_added ||
      prev.lines_removed !== counts.lines_removed ||
      prev.operation !== op;

    if (hasChanged) {
      // Store a placeholder patch hash (full diff could be stored separately)
      const patchContent = `diff --git a/${filePath} b/${filePath}\n@ ${op} +${counts.lines_added} -${counts.lines_removed}`;
      // Note: in a full implementation, we'd store the actual patch via blobStore
      // For now we compute a deterministic hash from the description
      const { createHash } = await import("node:crypto");
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

// ============================================================================
// Error category mapping
// ============================================================================

/** File-editing tools that should trigger git diff detection after tool_result. */
const FILE_EDIT_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "Create",
  "str_replace_based_edit_tool",
]);

function mapErrorCategory(
  subtype: string,
): "provider_error" | "timeout" | "budget_exceeded" | "turn_limit" | "invalid_output" | "aborted" | "unknown" {
  switch (subtype) {
    case "error_budget_exceeded":
      return "budget_exceeded";
    case "error_max_turns":
      return "turn_limit";
    case "error_timeout":
      return "timeout";
    default:
      return "unknown";
  }
}

// ============================================================================
// invoke — the main async generator
// ============================================================================

/**
 * Spawns the Claude Code CLI and translates its NDJSON output into a stream
 * of AppendEventInput objects. The caller should pipe each through
 * appendAndProject(db, input) to persist them.
 *
 * File edit events (invocation.file_edited) are emitted after each
 * Write/Edit/Create/MultiEdit tool_result by diffing the worktree.
 *
 * @param opts        Invocation parameters
 * @param blobStore   For storing tool args (a hash is placed in the event)
 * @param spawner     Optional custom line source for testing
 */
export async function* invoke(
  opts: InvokeOptions,
  blobStore: BlobStore,
  spawner: Spawner = execaSpawner,
): AsyncIterable<AppendEventInput> {
  const startedAt = Date.now();
  const args = buildArgs(opts);

  // Track tool call timestamps for duration_ms calculation on tool_result
  const toolCallTimes: Record<string, number> = {};

  // Track the name of each pending tool call (by tool_call_id) so we know
  // whether to run file edit detection after the tool_result
  const pendingToolNames: Record<string, string> = {};

  // Snapshot of previously detected file changes
  const seenFileSnapshot = new Map<
    string,
    { lines_added: number; lines_removed: number; operation: string }
  >();

  try {
    for await (const rawLine of spawner("claude", args, { cwd: opts.cwd })) {
      let parsed: ClaudeCodeLine;
      try {
        parsed = JSON.parse(rawLine) as ClaudeCodeLine;
      } catch {
        // Skip malformed lines
        continue;
      }

      // Record when each tool is called so we can compute duration_ms
      if (parsed.type === "assistant") {
        for (const block of parsed.message.content) {
          if (block.type === "tool_use") {
            toolCallTimes[block.id] = Date.now();
            pendingToolNames[block.id] = block.name;
          }
        }
      }

      const inputs = translateLine(parsed, opts, blobStore, toolCallTimes, startedAt);
      for (const input of inputs) {
        yield input;
      }

      // After a tool_result for a file-editing tool, detect file changes
      if (parsed.type === "user") {
        for (const item of parsed.message.content) {
          if (
            item.type === "tool_result" &&
            FILE_EDIT_TOOLS.has(pendingToolNames[item.tool_use_id] ?? "")
          ) {
            const fileEdits = await detectFileEdits(
              opts.cwd,
              opts.invocation_id,
              opts.attempt_id,
              seenFileSnapshot,
            );
            for (const edit of fileEdits) {
              yield edit;
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    // Subprocess exited without emitting a normal result line — it was
    // killed, crashed, or errored before completion.
    const error = err as Error & { exitCode?: number; signal?: string };

    const actor = {
      kind: "cli" as const,
      transport: "claude-code" as const,
      invocation_id: opts.invocation_id,
    };

    const errInput: AppendEventInput<"invocation.errored"> = {
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
    };
    yield errInput;
  }
}
