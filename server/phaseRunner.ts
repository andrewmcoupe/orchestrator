/**
 * Phase Runner — the core execution engine for a task attempt.
 *
 * runAttempt(db, task_id) executes the full attempt lifecycle:
 *   1. Read task config from proj_task_detail
 *   2. Emit attempt.started (with frozen config_snapshot)
 *   3. Ensure worktree exists
 *   4. For each enabled phase in order:
 *      a. Check pause/kill flags
 *      b. Emit phase.started
 *      c. Pack context (packer.pack)
 *      d. Emit phase.context_packed
 *      e. Invoke adapter (CLI or API) and pipe events through appendAndProject
 *      f. Run configured gates
 *      g. Emit phase.completed
 *   5. Emit attempt.completed with aggregated tokens/cost/duration
 *   6. Emit task.status_changed (awaiting_review or rejected)
 *
 * Kill: killAttempt(attempt_id) sets an abort flag. The loop detects it
 * between phases and during invocation. When aborted, the runner exits
 * without emitting attempt.completed — the kill command is responsible for
 * emitting attempt.killed.
 *
 * Pause: pauseAttempt(attempt_id) causes the loop to spin-wait between
 * phases. resumeAttempt(attempt_id) clears the flag.
 *
 * Concurrency: at most one active attempt per task (enforced by in-memory
 * map). Different tasks run in parallel independently.
 */

import { createHash } from "node:crypto";
import { execa } from "execa";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { appendAndProject } from "./projectionRunner.js";
import { createWorktree } from "./worktree.js";
import { pack } from "./packer/trivial.js";
import type { PackInput, PackResult } from "./packer/trivial.js";
import { invoke as claudeCodeInvoke } from "./adapters/claudeCode.js";
import type { InvokeOptions as ClaudeCodeInvokeOptions } from "./adapters/claudeCode.js";
import { invoke as codexInvoke } from "./adapters/codex.js";
import type { InvokeOptions as CodexInvokeOptions } from "./adapters/codex.js";
import { invoke as apiInvoke } from "./adapters/anthropicApi.js";
import type { ApiInvokeOptions } from "./adapters/anthropicApi.js";
import { runGate } from "./gates/runner.js";
import type { GateRunResult } from "./gates/runner.js";
import { createBlobStore, type BlobStore } from "./blobStore.js";
import {
  AUDITOR_PROMPT_VERSION_ID,
  AUDITOR_MODEL,
  VERDICT_JSON_SCHEMA,
  parseVerdict,
  newAuditId,
} from "./auditor.js";
import { evaluate as evaluateRetryPolicy } from "./retryPolicy.js";
import { handleAutoMerge } from "./autoMerge.js";
import { getBlobsDir } from "./paths.js";
import { assign as assignAbVariant } from "./ab/assign.js";

import type {
  TaskConfig,
  GateConfig,
  Transport,
  InvocationCompleted,
  InvocationErrored,
  InvocationAssistantMessage,
  InvocationToolCalled,
  TaskStatus,
  AuditConcern,
  AnyEvent,
  ExitReason,
  ExitReasonPolicy,
  RetryPolicy,
} from "@shared/events.js";
import type { TaskDetailRow, AttemptRow } from "@shared/projections.js";
import type { AppendEventInput } from "./eventStore.js";

const defaultBlobStore = createBlobStore(getBlobsDir());

// ============================================================================
// Default on_exit_reason map — used when config.retry_policy.on_exit_reason
// doesn't specify a mapping for a given exit reason.
// ============================================================================

const DEFAULT_EXIT_REASON_POLICY: Partial<Record<ExitReason, ExitReasonPolicy>> = {
  timeout: "retry_same",
  network_error: "retry_same",
  schema_invalid: "retry_same",
  budget_exceeded: "escalate_to_human",
  turn_limit: "escalate_to_human",
  permission_blocked: "escalate_to_human",
  killed: "escalate_to_human",
  crashed: "escalate_to_human",
  unknown: "escalate_to_human",
};

/** Max retries for schema_invalid before escalating. */
const SCHEMA_INVALID_MAX_RETRIES = 2;

/**
 * Evaluates the on_exit_reason policy for a given exit reason.
 * Returns the policy action, or null if the exit reason is "normal" (no action needed).
 */
export function evaluateExitReasonPolicy(
  exitReason: ExitReason | undefined,
  policy: RetryPolicy,
  attemptNumber: number,
): { action: ExitReasonPolicy; reason: string } | null {
  if (!exitReason || exitReason === "normal") return null;

  const userMap = policy.on_exit_reason ?? {};
  const action = userMap[exitReason] ?? DEFAULT_EXIT_REASON_POLICY[exitReason] ?? "escalate_to_human";

  // schema_invalid has a max retry count of 2 — escalate on attempt 3+
  if (exitReason === "schema_invalid" && action === "retry_same") {
    if (attemptNumber > SCHEMA_INVALID_MAX_RETRIES) {
      return {
        action: "escalate_to_human",
        reason: `exit_reason '${exitReason}' — max retries (${SCHEMA_INVALID_MAX_RETRIES}) exhausted`,
      };
    }
  }

  return {
    action,
    reason: `exit_reason '${exitReason}' → ${action}`,
  };
}

// ============================================================================
// Injectable deps (for testing — swap out adapters without esm mocks)
// ============================================================================

export type AdapterInvokeFn = (
  opts: ClaudeCodeInvokeOptions | CodexInvokeOptions | ApiInvokeOptions,
  blobStore: BlobStore,
) => AsyncIterable<AppendEventInput>;

export type PhaseRunnerDeps = {
  blobStore?: BlobStore;
  worktreeCreator?: (
    db: Database.Database,
    taskId: string,
  ) => Promise<{ path: string; branch: string }>;
  packer?: (input: PackInput) => Promise<PackResult>;
  claudeCodeInvoker?: AdapterInvokeFn;
  codexInvoker?: AdapterInvokeFn;
  apiInvoker?: AdapterInvokeFn;
  gateRunner?: (
    db: Database.Database,
    gate: GateConfig,
    attempt_id: string,
    worktree_path: string,
  ) => Promise<GateRunResult>;
  /** Override diff capture for testing — returns the diff string (empty = no changes). */
  diffCapturer?: (worktree_path: string, base_sha: string) => Promise<string>;
  /** Override git commit for testing — returns { sha, empty }. */
  committer?: (worktree_path: string, message: string) => Promise<{ sha: string; empty: boolean }>;
};

// ============================================================================
// Run options (passed from command layer to carry retry metadata)
// ============================================================================

/**
 * Options for a single attempt run.
 *
 * - attempt_id: pre-assign the attempt ID (used by retry so attempt.retry_requested
 *   can reference the new ID before runAttempt starts)
 * - previous_attempt_id / retry_feedback / triggered_by: carried into attempt.started
 * - deps: injectable adapters for testing
 */
export type RunAttemptOptions = {
  attempt_id?: string;
  previous_attempt_id?: string;
  retry_feedback?: AuditConcern[];
  triggered_by?: "user_start" | "retry" | "scheduler";
  deps?: PhaseRunnerDeps;
};

// ============================================================================
// In-memory active-attempt state
// ============================================================================

type ActiveAttempt = {
  attempt_id: string;
  task_id: string;
  aborted: boolean;
  paused: boolean;
};

/** Keyed by task_id. */
const activeAttempts = new Map<string, ActiveAttempt>();

/** True if there is an active (running or paused) attempt for this task. */
export function isAttemptRunning(task_id: string): boolean {
  return activeAttempts.has(task_id);
}

/** Returns the active attempt_id for a task, or undefined if none. */
export function getActiveAttemptId(task_id: string): string | undefined {
  return activeAttempts.get(task_id)?.attempt_id;
}

/** Signal an active attempt to abort. The runner exits after the current event. */
export function killAttempt(attempt_id: string): void {
  for (const state of activeAttempts.values()) {
    if (state.attempt_id === attempt_id) {
      state.aborted = true;
      return;
    }
  }
}

/** Suspend phase transitions (checked between phases and gate runs). */
export function pauseAttempt(attempt_id: string): void {
  for (const state of activeAttempts.values()) {
    if (state.attempt_id === attempt_id) {
      state.paused = true;
      return;
    }
  }
}

/** Resume a paused attempt. */
export function resumeAttempt(attempt_id: string): void {
  for (const state of activeAttempts.values()) {
    if (state.attempt_id === attempt_id) {
      state.paused = false;
      return;
    }
  }
}

// ============================================================================
// DB row types (raw SQLite columns)
// ============================================================================

type TaskListDbRow = {
  task_id: string;
  status: string;
  attempt_count: number;
  current_attempt_id: string | null;
};

type TaskDetailDbRow = {
  task_id: string;
  title: string;
  status: string;
  config_json: string;
  worktree_path: string | null;
  base_sha: string | null;
  proposition_ids_json: string;
  preset_id: string | null;
  preset_override_keys_json: string;
  last_event_id: string;
  updated_at: string;
};

function getTaskListRow(
  db: Database.Database,
  task_id: string,
): TaskListDbRow | null {
  return (
    (db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get(task_id) as TaskListDbRow | undefined) ?? null
  );
}

function getTaskDetailRow(
  db: Database.Database,
  task_id: string,
): TaskDetailDbRow | null {
  return (
    (db
      .prepare("SELECT * FROM proj_task_detail WHERE task_id = ?")
      .get(task_id) as TaskDetailDbRow | undefined) ?? null
  );
}

// ============================================================================
// Transport classification
// ============================================================================

const CLI_TRANSPORTS = new Set<Transport>([
  "claude-code",
  "codex",
  "aider",
  "gemini-cli",
]);

function isCliTransport(transport: Transport): boolean {
  return CLI_TRANSPORTS.has(transport);
}

// ============================================================================
// runAttempt — the main entry point
// ============================================================================

/**
 * Runs a full attempt for the given task. Returns when the attempt is done
 * (completed, failed, or killed). This function is always async and should
 * be called in the background (fire-and-forget) from the HTTP layer.
 *
 * Registers synchronously in activeAttempts before its first await so callers
 * can retrieve the attempt_id via getActiveAttemptId() immediately after firing.
 *
 * @param db      The database connection (WAL mode, safe for concurrent reads)
 * @param task_id The task to attempt
 * @param options Optional run options (retry metadata, injected deps for testing)
 */
export async function runAttempt(
  db: Database.Database,
  task_id: string,
  options?: RunAttemptOptions,
): Promise<void> {
  const deps = options?.deps;
  // Read current task state
  const taskListRow = getTaskListRow(db, task_id);
  if (!taskListRow) throw new Error(`Task ${task_id} not found`);

  const taskDetailDbRow = getTaskDetailRow(db, task_id);
  if (!taskDetailDbRow) throw new Error(`Task detail for ${task_id} not found`);

  // Parse JSON columns
  const config: TaskConfig = JSON.parse(taskDetailDbRow.config_json);
  const propositionIds: string[] = JSON.parse(
    taskDetailDbRow.proposition_ids_json || "[]",
  );

  // Assign new attempt identity (caller may pre-assign an ID for event correlation)
  const attempt_id = options?.attempt_id ?? `A-${ulid()}`;
  const attempt_number = taskListRow.attempt_count + 1;
  const startedAt = Date.now();
  const systemActor = { kind: "system" as const, component: "scheduler" as const };

  // Register this attempt as active (checked by pause/kill)
  const state: ActiveAttempt = {
    attempt_id,
    task_id,
    aborted: false,
    paused: false,
  };
  activeAttempts.set(task_id, state);

  // Resolve deps (defaults to production implementations)
  const bs = deps?.blobStore ?? defaultBlobStore;
  const doWorktree =
    deps?.worktreeCreator ??
    ((d: Database.Database, id: string) => createWorktree(d, id));
  const doPack = deps?.packer ?? pack;
  const doGate = deps?.gateRunner ?? runGate;
  const doClaudeCodeInvoke: AdapterInvokeFn =
    deps?.claudeCodeInvoker ??
    ((opts, blobStore) => claudeCodeInvoke(opts as ClaudeCodeInvokeOptions, blobStore));
  const doCodexInvoke: AdapterInvokeFn =
    deps?.codexInvoker ??
    ((opts, blobStore) => codexInvoke(opts as CodexInvokeOptions, blobStore));
  const doApiInvoke: AdapterInvokeFn =
    deps?.apiInvoker ??
    ((opts, _blobStore) => apiInvoke(opts as ApiInvokeOptions));
  const doDiffCapture = deps?.diffCapturer ?? (async (wp: string, baseSha: string) => {
    const { stdout } = await execa(
      "git", ["diff", baseSha, "--", ".", ":!node_modules"],
      { cwd: wp, stdio: ["ignore", "pipe", "pipe"] },
    );
    return stdout;
  });
  const doCommit = deps?.committer ?? (async (wp: string, message: string) => {
    // Stage all changes except node_modules. Use reject:false because
    // git add -A can exit non-zero when only ignored files are present.
    await execa("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], {
      cwd: wp,
      stdio: ["ignore", "pipe", "pipe"],
      reject: false,
    });
    const { stdout: statusOut } = await execa(
      "git", ["status", "--porcelain"],
      { cwd: wp, stdio: ["ignore", "pipe", "pipe"] },
    );
    const empty = !statusOut.trim();
    const commitArgs = ["commit", "-m", message, "--no-gpg-sign"];
    if (empty) commitArgs.push("--allow-empty");
    const { stdout: commitOut } = await execa("git", commitArgs, {
      cwd: wp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Extract SHA from commit output (first line: "[branch sha] message")
    const shaMatch = commitOut.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
    const sha = shaMatch?.[1] ?? "";
    return { sha, empty };
  });

  try {
    // -----------------------------------------------------------------------
    // 1. Emit attempt.started (captures config_snapshot at this moment)
    // -----------------------------------------------------------------------
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor: systemActor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        task_id,
        attempt_number,
        config_snapshot: config,
        triggered_by: options?.triggered_by ?? "user_start",
        previous_attempt_id: options?.previous_attempt_id,
        retry_feedback: options?.retry_feedback,
      },
    });

    // -----------------------------------------------------------------------
    // 2. Ensure worktree exists
    // -----------------------------------------------------------------------
    let worktree_path = taskDetailDbRow.worktree_path;
    if (!worktree_path) {
      const wt = await doWorktree(db, task_id);
      worktree_path = wt.path;
    }

    // Build typed rows for the packer (it uses attempt.attempt_id for DB queries)
    const attemptRow: AttemptRow = {
      attempt_id,
      task_id,
      attempt_number,
      status: "running" as const,
      started_at: new Date(startedAt).toISOString(),
      tokens_in_total: 0,
      tokens_out_total: 0,
      cost_usd_total: 0,
      phases: {},
      gate_runs: [],
      files_changed: [],
      config_snapshot: config,
      last_failure_reason: null,
      last_event_id: "",
    };

    const taskDetailRow: TaskDetailRow = {
      task_id,
      title: taskDetailDbRow.title,
      status: taskDetailDbRow.status as TaskStatus,
      config,
      preset_override_keys: JSON.parse(
        taskDetailDbRow.preset_override_keys_json || "[]",
      ),
      proposition_ids: propositionIds,
      worktree_path: worktree_path ?? undefined,
      last_event_id: taskDetailDbRow.last_event_id,
      updated_at: taskDetailDbRow.updated_at,
    };

    // -----------------------------------------------------------------------
    // 2b. Resolve diff base SHA
    // -----------------------------------------------------------------------
    // Always use the original base_sha from task.worktree_created so the diff
    // captures ALL accumulated changes on the branch, not just the delta from
    // the previous attempt. This ensures the review screen shows the full picture.
    let diffBaseSha = "HEAD"; // fallback
    {
      const freshDetail = getTaskDetailRow(db, task_id);
      if (freshDetail?.base_sha) {
        diffBaseSha = freshDetail.base_sha;
      }
    }

    // -----------------------------------------------------------------------
    // 3. Phase loop
    // -----------------------------------------------------------------------
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    let finalOutcome: "approved" | "rejected" | "revised" | "escalated" | "failed" | "no_changes" =
      "approved";
    let _anyPhaseProducedDiff = false;

    // Auto-merge tracking — accumulated across all phases
    let auditorVerdict: "approve" | "revise" | "reject" | undefined;
    let hasBlockingConcerns = false;
    let allRequiredGatesPassed = true;

    const enabledPhases = config.phases.filter((p) => p.enabled);

    phaseLoop: for (const phase of enabledPhases) {
      // Check kill before starting a new phase
      if (state.aborted) break phaseLoop;

      // Pause polling — spin until resumed or killed
      while (state.paused && !state.aborted) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      if (state.aborted) break phaseLoop;

      const phaseStartedAt = Date.now();

      // ----- A/B variant resolution -----
      let resolvedPromptVersionId = phase.prompt_version_id;
      let abVariant: "A" | "B" | undefined;

      if (phase.ab_experiment_id) {
        const expRow = db
          .prepare(
            "SELECT variant_a_id, variant_b_id, status FROM proj_ab_experiment WHERE experiment_id = ?",
          )
          .get(phase.ab_experiment_id) as
          | { variant_a_id: string; variant_b_id: string; status: string }
          | undefined;

        if (expRow && expRow.status === "running") {
          abVariant = assignAbVariant(db, phase.ab_experiment_id, task_id, phase.name);
          resolvedPromptVersionId = abVariant === "A" ? expRow.variant_a_id : expRow.variant_b_id;
        }
      }

      // ----- phase.started -----
      appendAndProject(db, {
        type: "phase.started",
        aggregate_type: "attempt",
        aggregate_id: attempt_id,
        actor: systemActor,
        correlation_id: attempt_id,
        payload: {
          attempt_id,
          phase_name: phase.name,
          transport: phase.transport,
          model: phase.model,
          prompt_version_id: resolvedPromptVersionId,
          ab_variant: abVariant,
        },
      });

      // ----- pack context -----
      const packResult = await doPack({
        db,
        phase_name: phase.name,
        task: taskDetailRow,
        attempt: attemptRow,
        worktree_path: worktree_path ?? "/tmp/no-worktree",
        policy: phase.context_policy,
        blobStore: bs,
      });

      // ----- phase.context_packed -----
      appendAndProject(db, {
        type: "phase.context_packed",
        aggregate_type: "attempt",
        aggregate_id: attempt_id,
        actor: systemActor,
        correlation_id: attempt_id,
        payload: {
          attempt_id,
          phase_name: phase.name,
          symbol_count: packResult.manifest.symbols.length,
          tokens_estimated: packResult.manifest.token_estimated,
          manifest_hash: packResult.manifest_hash,
          manifest: packResult.manifest,
        },
      });

      // ----- invoke adapter -----
      const invocation_id = `INV-${ulid()}`;
      let phaseTokensIn = 0;
      let phaseTokensOut = 0;
      let phaseCostUsd = 0;
      let phaseOutcome: "success" | "failed" | "aborted" = "success";
      let phaseExitReason: ExitReason = "unknown";
      let phaseStdoutTailHash: string | null = null;
      let phaseStderrTailHash: string | null = null;
      let phasePermissionBlockedOn: string | null = null;

      // For the auditor phase, capture the last assistant message text
      // (it will contain the structured-output JSON verdict).
      const isAuditorPhase = phase.name === "auditor";
      let auditorResponseText: string | null = null;
      let structuredOutputCaptured = false;

      try {
        let invoker: AsyncIterable<AppendEventInput>;

        // For the auditor phase, merge the verdict schema into whichever
        // transport the phase is configured to use. If the user switched
        // transport (e.g. to claude-code) but transport_options.kind is
        // still "api" from the old default, reconcile by building fresh
        // CLI transport_options.
        let effectiveTransportOpts = phase.transport_options;
        if (isAuditorPhase) {
          if (isCliTransport(phase.transport) && phase.transport_options.kind !== "cli") {
            // Transport was switched to CLI but options are still API-shaped — build CLI defaults
            effectiveTransportOpts = {
              kind: "cli",
              max_turns: 10,
              max_budget_usd: 1,
              permission_mode: "bypassPermissions",
              schema: VERDICT_JSON_SCHEMA,
            };
          } else {
            effectiveTransportOpts = { ...phase.transport_options, schema: VERDICT_JSON_SCHEMA };
          }
        }

        if (isCliTransport(phase.transport)) {
          if (effectiveTransportOpts.kind !== "cli") {
            throw new Error(
              `Transport ${phase.transport} requires cli transport_options`,
            );
          }

          // Deny git-write commands for all phases — the orchestrator manages commits.
          // Reading git state (status, diff, log) is allowed.
          const GIT_WRITE_DENY_LIST = [
            "Bash(git commit:*)",
            "Bash(git reset:*)",
            "Bash(git checkout:*)",
            "Bash(git merge:*)",
            "Bash(git rebase:*)",
            "Bash(git push:*)",
          ];
          const cliOpts = {
            ...effectiveTransportOpts,
            disallowed_tools: [
              ...(effectiveTransportOpts.disallowed_tools ?? []),
              ...GIT_WRITE_DENY_LIST,
            ],
          };

          const cliInvokeOpts = {
              invocation_id,
              attempt_id,
              phase_name: phase.name,
              model: isAuditorPhase ? (phase.model || AUDITOR_MODEL) : phase.model,
              prompt: packResult.prompt,
              prompt_version_id: isAuditorPhase
                ? (resolvedPromptVersionId || AUDITOR_PROMPT_VERSION_ID)
                : resolvedPromptVersionId,
              context_manifest_hash: packResult.manifest_hash,
              systemPromptFile: packResult.system_prompt_file,
              cwd: worktree_path ?? "/tmp/no-worktree",
              transport_options: cliOpts,
            };

          if (phase.transport === "codex") {
            invoker = doCodexInvoke(cliInvokeOpts as CodexInvokeOptions, bs);
          } else {
            invoker = doClaudeCodeInvoke(cliInvokeOpts as ClaudeCodeInvokeOptions, bs);
          }
        } else {
          // API transport (anthropic-api, openai-api)
          if (effectiveTransportOpts.kind !== "api") {
            throw new Error(
              `Transport ${phase.transport} requires api transport_options`,
            );
          }
          invoker = doApiInvoke(
            {
              invocation_id,
              attempt_id,
              phase_name: phase.name,
              model: isAuditorPhase ? (phase.model || AUDITOR_MODEL) : phase.model,
              messages: [{ role: "user", content: packResult.prompt }],
              prompt_version_id: isAuditorPhase
                ? (resolvedPromptVersionId || AUDITOR_PROMPT_VERSION_ID)
                : resolvedPromptVersionId,
              context_manifest_hash: packResult.manifest_hash,
              transport_options: effectiveTransportOpts,
            } satisfies ApiInvokeOptions,
            bs,
          );
        }

        for await (const input of invoker) {
          if (state.aborted) {
            phaseOutcome = "aborted";
            break phaseLoop;
          }

          const event = appendAndProject(db, input);

          // Capture the auditor response text — could arrive as a plain
          // assistant_message (API/Codex path) or as a StructuredOutput tool_use
          // (Claude Code --json-schema path).
          //
          // StructuredOutput is definitive — once captured, assistant_message
          // updates are ignored. For Codex, the structured JSON arrives as the
          // *last* agent_message, so we keep overwriting until we find it or
          // until a StructuredOutput tool_call supersedes.
          if (isAuditorPhase) {
            if (event.type === "invocation.tool_called") {
              const p = event.payload as InvocationToolCalled;
              if (p.tool_name === "StructuredOutput") {
                const blob = bs.getBlob(p.args_hash);
                if (blob) {
                  auditorResponseText = blob.toString("utf8");
                  structuredOutputCaptured = true;
                }
              }
            } else if (event.type === "invocation.assistant_message" && !structuredOutputCaptured) {
              auditorResponseText = (event.payload as InvocationAssistantMessage).text;
            }
          }

          if (event.type === "invocation.completed") {
            const p = event.payload as InvocationCompleted;
            phaseTokensIn = p.tokens_in;
            phaseTokensOut = p.tokens_out;
            phaseCostUsd = p.cost_usd;
            if (p.outcome !== "success") phaseOutcome = p.outcome;
            // Mirror exit_reason fields from invocation to phase
            phaseExitReason = p.exit_reason;
            phaseStdoutTailHash = p.stdout_tail_hash;
            phaseStderrTailHash = p.stderr_tail_hash;
            phasePermissionBlockedOn = p.permission_blocked_on;
          }
          if (event.type === "invocation.errored") {
            const p = event.payload as InvocationErrored;
            void p; // logged via event
            phaseOutcome = "failed";
          }
        }

        // After a successful auditor invocation, parse the verdict and emit auditor.judged
        if (isAuditorPhase && phaseOutcome === "success" && !auditorResponseText) {
          console.error(
            `[phaseRunner] auditor produced no verdict output for attempt ${attempt_id} — model may have exhausted turns without using StructuredOutput`,
          );
          phaseOutcome = "failed";
        }
        if (isAuditorPhase && phaseOutcome === "success" && auditorResponseText) {
          try {
            const verdict = parseVerdict(auditorResponseText);
            const audit_id = newAuditId();

            const judgedEvent: AnyEvent = appendAndProject(db, {
              type: "auditor.judged",
              aggregate_type: "audit",
              aggregate_id: audit_id,
              actor: systemActor,
              correlation_id: attempt_id,
              payload: {
                audit_id,
                attempt_id,
                verdict: verdict.verdict,
                confidence: verdict.confidence,
                summary: verdict.summary,
                concerns: verdict.concerns,
                model: phase.model || AUDITOR_MODEL,
                prompt_version_id: resolvedPromptVersionId || AUDITOR_PROMPT_VERSION_ID,
              },
            });

            // Capture verdict for auto-merge evaluation
            auditorVerdict = verdict.verdict;
            if (verdict.concerns.some((c) => c.severity === "blocking")) {
              hasBlockingConcerns = true;
            }

            // Set phase outcome based on verdict
            if (verdict.verdict === "approve") {
              phaseOutcome = "success";
            } else if (verdict.verdict === "reject") {
              phaseOutcome = "failed";
              finalOutcome = "rejected";
            } else {
              // verdict === "revise" — consult the retry policy
              const hasBlocking = verdict.concerns.some((c) => c.severity === "blocking");
              if (hasBlocking) {
                const retryResult = evaluateRetryPolicy({
                  policy: config.retry_policy,
                  attempt: {
                    attempt_number,
                    typecheck_fail_count: 0,
                    test_fail_count: 0,
                  },
                  last_event: judgedEvent,
                });
                if (retryResult.action === "escalate") {
                  finalOutcome = "escalated";
                } else if (retryResult.action === "stop") {
                  finalOutcome = "rejected";
                } else {
                  // retry_same / retry_with_context / etc. → signal revised so UI can trigger retry
                  finalOutcome = "revised";
                }
              } else {
                // Only advisory concerns — treat as revised (soft fail → awaiting review)
                finalOutcome = "revised";
              }
              phaseOutcome = "failed";
            }
          } catch (parseErr: unknown) {
            // Verdict JSON was malformed — treat auditor phase as failed
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error(
              `[phaseRunner] auditor verdict parse failed for attempt ${attempt_id}: ${msg}`,
              `\n  response text (first 200 chars): ${auditorResponseText?.slice(0, 200)}`,
            );
            phaseOutcome = "failed";
          }
        }
      } catch (err: unknown) {
        phaseOutcome = "failed";
        // Log the real error — adapters only surface invocation.errored when
        // the failure happens inside their own try/catch, not for spawn failures
        // or other upstream errors.
        console.error(
          `[phaseRunner] phase "${phase.name}" failed for attempt ${attempt_id}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Check kill after invocation
      if (state.aborted) break phaseLoop;

      const phaseDuration = Date.now() - phaseStartedAt;

      // ----- capture worktree diff and store in blob store -----
      let diff_hash: string | undefined;
      if (worktree_path) {
        try {
          const diffOutput = await doDiffCapture(worktree_path, diffBaseSha);
          if (diffOutput.trim()) {
            diff_hash = bs.putBlob(diffOutput).hash;
            _anyPhaseProducedDiff = true;

            // Emit phase.diff_snapshotted with the diff hash and base SHA
            appendAndProject(db, {
              type: "phase.diff_snapshotted",
              aggregate_type: "attempt",
              aggregate_id: attempt_id,
              actor: systemActor,
              correlation_id: attempt_id,
              payload: {
                attempt_id,
                phase_name: phase.name,
                diff_hash,
                base_sha: diffBaseSha,
              },
            });
          }
        } catch {
          // Diff capture is best-effort — don't fail the phase
        }
      }

      // ----- phase.completed -----
      // Emitted before gates so the timeline reads naturally:
      //   phase.completed → gate.started → gate.passed/failed
      appendAndProject(db, {
        type: "phase.completed",
        aggregate_type: "attempt",
        aggregate_id: attempt_id,
        actor: systemActor,
        correlation_id: attempt_id,
        payload: {
          attempt_id,
          phase_name: phase.name,
          outcome: phaseOutcome,
          tokens_in: phaseTokensIn,
          tokens_out: phaseTokensOut,
          cost_usd: phaseCostUsd,
          duration_ms: phaseDuration,
          diff_hash,
          exit_reason: phaseExitReason,
          stdout_tail_hash: phaseStdoutTailHash,
          stderr_tail_hash: phaseStderrTailHash,
          permission_blocked_on: phasePermissionBlockedOn,
        },
      });

      totalTokensIn += phaseTokensIn;
      totalTokensOut += phaseTokensOut;
      totalCostUsd += phaseCostUsd;

      // ----- on_exit_reason evaluation (before verdict-based retry logic) -----
      if (phaseOutcome === "failed" && phaseExitReason && phaseExitReason !== "normal") {
        const exitReasonResult = evaluateExitReasonPolicy(
          phaseExitReason,
          config.retry_policy,
          attempt_number,
        );
        if (exitReasonResult) {
          if (exitReasonResult.action === "escalate_to_human") {
            finalOutcome = "escalated";
            break phaseLoop;
          }
          // retry_same — fall through to let the existing retry counter/limits apply
        }
      }

      if (phaseOutcome === "failed") {
        // Only fall back to generic "failed" if the auditor didn't
        // already set a more specific outcome (rejected / revised / escalated).
        if (finalOutcome === "approved") finalOutcome = "failed";
        break phaseLoop;
      }

      // ----- run gates (after phase.completed) -----
      let gatesFailed = false;
      const skippedGates = new Set(phase.skip_gates ?? []);
      for (const gate of config.gates) {
        if (skippedGates.has(gate.name)) continue;
        if (state.aborted) break;
        while (state.paused && !state.aborted) {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        if (state.aborted) break;

        const result = await doGate(db, gate, attempt_id, worktree_path ?? "/tmp/no-worktree");
        if (result.status !== "passed" && gate.required) {
          gatesFailed = true;
          allRequiredGatesPassed = false;
          break;
        }
      }

      if (state.aborted) break phaseLoop;

      if (gatesFailed) {
        if (finalOutcome === "approved") finalOutcome = "failed";
        break phaseLoop;
      }
    } // end phaseLoop

    // -----------------------------------------------------------------------
    // 3b. Per-attempt commit + attempt.committed event
    // -----------------------------------------------------------------------
    // Every attempt gets a commit (--allow-empty when no changes) so git
    // history has one commit per attempt and squash-merge works correctly.
    if (worktree_path && !state.aborted) {
      try {
        const durationMs = Date.now() - startedAt;
        const configHash = createHash("sha256")
          .update(JSON.stringify(config))
          .digest("hex")
          .slice(0, 12);
        const commitMessage = [
          `Attempt ${attempt_number} of ${task_id} — ${finalOutcome}`,
          "",
          `config: ${configHash}`,
          `cost: $${totalCostUsd.toFixed(4)}`,
          `duration: ${durationMs}ms`,
        ].join("\n");

        const { sha, empty } = await doCommit(worktree_path, commitMessage);

        appendAndProject(db, {
          type: "attempt.committed",
          aggregate_type: "attempt",
          aggregate_id: attempt_id,
          actor: systemActor,
          correlation_id: attempt_id,
          payload: {
            attempt_id,
            commit_sha: sha,
            empty,
          },
        });
      } catch (commitErr: unknown) {
        console.error(
          `[phaseRunner] failed to commit worktree changes for ${task_id}:`,
          commitErr instanceof Error ? commitErr.message : commitErr,
        );
      }
    }

    // -----------------------------------------------------------------------
    // 4. Emit attempt.completed (only if not killed)
    // -----------------------------------------------------------------------
    if (!state.aborted) {
      appendAndProject(db, {
        type: "attempt.completed",
        aggregate_type: "attempt",
        aggregate_id: attempt_id,
        actor: systemActor,
        correlation_id: attempt_id,
        payload: {
          attempt_id,
          outcome: finalOutcome,
          tokens_in_total: totalTokensIn,
          tokens_out_total: totalTokensOut,
          cost_usd_total: totalCostUsd,
          duration_ms: Date.now() - startedAt,
        },
      });

      // Evaluate auto-merge before setting the final task status
      const currentRow = getTaskListRow(db, task_id);
      if (currentRow) {
        let newStatus: TaskStatus;

        // Check if auto-merge should handle this attempt
        const autoMergeResult = await handleAutoMerge({
          db,
          task_id,
          attempt_id,
          config,
          attempt_outcome: finalOutcome,
          auditor_verdict: auditorVerdict,
          has_blocking_concerns: hasBlockingConcerns,
          all_required_gates_passed: allRequiredGatesPassed,
          current_task_status: currentRow.status,
        });

        if (autoMergeResult.action === "merged") {
          // Auto-merge succeeded — task.auto_approved and task.merged already emitted
          // by handleAutoMerge and mergeTask. Set status to merged.
          newStatus = "merged";
        } else if ((finalOutcome as string) === "no_changes") {
          // No diff produced — user decides what to do next
          newStatus = "awaiting_review";
        } else {
          // Normal flow: approved / revised → awaiting_review, others → rejected
          newStatus =
            finalOutcome === "approved" || finalOutcome === "revised"
              ? "awaiting_review"
              : "rejected";
        }

        appendAndProject(db, {
          type: "task.status_changed",
          aggregate_type: "task",
          aggregate_id: task_id,
          actor: systemActor,
          payload: {
            task_id,
            from: currentRow.status as TaskStatus,
            to: newStatus,
          },
        });
      }
    }
  } finally {
    activeAttempts.delete(task_id);
  }
}
