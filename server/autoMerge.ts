/**
 * Auto-merge evaluator — determines whether a completed attempt should
 * trigger an automatic merge based on the task's policy and attempt outcome.
 *
 * evaluateAutoMerge is a pure function with no side effects — it takes
 * the relevant data and returns a decision. The caller (phaseRunner)
 * is responsible for reading the global kill switch, emitting events,
 * and invoking the merge workflow.
 *
 * handleAutoMerge orchestrates the full auto-merge flow:
 *   1. Check global kill switch (from proj_settings)
 *   2. Check per-task policy
 *   3. Evaluate conditions via evaluateAutoMerge
 *   4. Shadow mode → emit advisory event only
 *   5. Live mode → emit task.auto_approved, invoke merge, handle failures
 */
import type Database from "better-sqlite3";
import type { AutoMergePolicy, TaskConfig, MergeStrategy } from "@shared/events.js";
import { appendAndProject } from "./projectionRunner.js";
import type { MergeResult } from "./merge.js";

// ============================================================================
// Input / output types
// ============================================================================

export type AutoMergeInput = {
  policy: AutoMergePolicy;
  shadow_mode: boolean;
  attempt_outcome: "approved" | "rejected" | "revised" | "escalated" | "failed" | "no_changes";
  auditor_verdict?: "approve" | "revise" | "reject";
  has_blocking_concerns: boolean;
  all_required_gates_passed: boolean;
};

export type AutoMergeEvaluation = {
  should_auto_merge: boolean;
  matched_conditions: string[];
  unmet_conditions: string[];
};

export type HandleAutoMergeInput = {
  db: Database.Database;
  task_id: string;
  attempt_id: string;
  config: TaskConfig;
  attempt_outcome: "approved" | "rejected" | "revised" | "escalated" | "failed" | "no_changes";
  auditor_verdict?: "approve" | "revise" | "reject";
  has_blocking_concerns: boolean;
  all_required_gates_passed: boolean;
  current_task_status: string;
  /** Injectable merge function — defaults to the real mergeTask. */
  merger?: (db: Database.Database, task_id: string, attempt_id: string) => Promise<MergeResult>;
};

export type HandleAutoMergeResult =
  | { action: "skip" }
  | { action: "shadow" }
  | { action: "merged"; merge_commit_sha: string }
  | { action: "merge_failed" };

// ============================================================================
// Pure evaluator
// ============================================================================

/**
 * Evaluates whether an attempt qualifies for auto-merge based on the task's
 * policy and the attempt's outcome data. Pure function — no DB, no events.
 *
 * Conditions by policy:
 *   on_full_pass:       auditor approve + all required gates pass + no blocking concerns
 *   on_auditor_approve: auditor approve (gates may fail if advisory)
 */
export function evaluateAutoMerge(input: AutoMergeInput): AutoMergeEvaluation {
  const matched: string[] = [];
  const unmet: string[] = [];

  // Policy off → never auto-merge
  if (input.policy === "off") {
    return { should_auto_merge: false, matched_conditions: [], unmet_conditions: ["policy is off"] };
  }

  // Attempt must have completed with outcome=approved
  if (input.attempt_outcome !== "approved") {
    unmet.push("attempt_outcome!=approved");
    return { should_auto_merge: false, matched_conditions: matched, unmet_conditions: unmet };
  }

  // Auditor verdict must exist and be 'approve'
  if (input.auditor_verdict == null) {
    unmet.push("no auditor verdict");
    return { should_auto_merge: false, matched_conditions: matched, unmet_conditions: unmet };
  }

  if (input.auditor_verdict === "approve") {
    matched.push("auditor_verdict=approve");
  } else {
    unmet.push("auditor_verdict!=approve");
  }

  // Policy-specific conditions
  if (input.policy === "on_full_pass") {
    if (input.all_required_gates_passed) {
      matched.push("all_required_gates_passed");
    } else {
      unmet.push("required gate(s) failed");
    }

    if (!input.has_blocking_concerns) {
      matched.push("no_blocking_concerns");
    } else {
      unmet.push("blocking concerns present");
    }
  }
  // on_auditor_approve: only needs auditor approval (gates/concerns don't block)

  const should_auto_merge = unmet.length === 0;
  return { should_auto_merge, matched_conditions: matched, unmet_conditions: unmet };
}

// ============================================================================
// Global kill switch reader
// ============================================================================

/**
 * Reads the auto_merge_enabled flag from proj_settings.
 * Returns false on a fresh DB (no settings event emitted yet).
 */
export function getAutoMergeEnabled(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT auto_merge_enabled FROM proj_settings WHERE settings_id = 'global'")
    .get() as { auto_merge_enabled: number } | undefined;
  return Boolean(row?.auto_merge_enabled);
}

// ============================================================================
// Orchestrator — full auto-merge flow
// ============================================================================

const systemActor = { kind: "system" as const, component: "scheduler" as const };

/**
 * Orchestrates the auto-merge decision after attempt.completed.
 * Called by the phase runner. Returns what happened so the caller
 * can decide the final task status.
 */
export async function handleAutoMerge(
  input: HandleAutoMergeInput,
): Promise<HandleAutoMergeResult> {
  const { db, task_id, attempt_id, config } = input;
  const policy = config.auto_merge_policy ?? "off";
  const shadowMode = config.shadow_mode ?? false;

  // 1. Global kill switch
  if (!getAutoMergeEnabled(db)) {
    return { action: "skip" };
  }

  // 2. Per-task policy
  if (policy === "off") {
    return { action: "skip" };
  }

  // 3. Evaluate conditions
  const evaluation = evaluateAutoMerge({
    policy,
    shadow_mode: shadowMode,
    attempt_outcome: input.attempt_outcome,
    auditor_verdict: input.auditor_verdict,
    has_blocking_concerns: input.has_blocking_concerns,
    all_required_gates_passed: input.all_required_gates_passed,
  });

  if (!evaluation.should_auto_merge) {
    return { action: "skip" };
  }

  // 4. Shadow mode — emit advisory event, do not merge
  if (shadowMode) {
    appendAndProject(db, {
      type: "task.would_auto_merge",
      aggregate_type: "task",
      aggregate_id: task_id,
      actor: systemActor,
      correlation_id: attempt_id,
      payload: {
        task_id,
        attempt_id,
        policy,
        matched_conditions: evaluation.matched_conditions,
      },
    });
    return { action: "shadow" };
  }

  // 5. Live mode — auto-approve then merge
  appendAndProject(db, {
    type: "task.auto_approved",
    aggregate_type: "task",
    aggregate_id: task_id,
    actor: systemActor,
    correlation_id: attempt_id,
    payload: {
      task_id,
      attempt_id,
      policy,
      matched_conditions: evaluation.matched_conditions,
    },
  });

  // Invoke the merge workflow
  try {
    const doMerge = input.merger ?? (await loadDefaultMerger());
    const mergeResult = await doMerge(db, task_id, attempt_id);

    if (mergeResult.outcome === "merged") {
      return { action: "merged", merge_commit_sha: mergeResult.merge_commit_sha };
    }

    // Any non-merged outcome (drifted, conflicted, gate_failed) — fall back
    // The merge workflow already emits the appropriate failure events
    return { action: "merge_failed" };
  } catch {
    // Merge threw — fall back to awaiting_review
    return { action: "merge_failed" };
  }
}

// Lazy import to avoid circular dependency (merge.ts → projectionRunner → ...)
async function loadDefaultMerger(): Promise<
  (db: Database.Database, task_id: string, attempt_id: string) => Promise<MergeResult>
> {
  const { mergeTask } = await import("./merge.js");
  return (db, task_id, attempt_id) => mergeTask(db, task_id, attempt_id);
}
