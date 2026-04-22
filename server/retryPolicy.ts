/**
 * Retry Policy Evaluator — pure, rule-based decision engine.
 *
 * evaluate({policy, attempt, last_event}) returns the action the phase runner
 * should take after a failure. It emits NO events and performs NO DB writes.
 *
 * Branches:
 *   gate.failed (typecheck gate) → policy.on_typecheck_fail
 *   gate.failed (test gate)      → policy.on_test_fail
 *   auditor.judged (revise|reject) → policy.on_audit_reject
 *   pushback.raised               → policy.on_spec_pushback
 *
 * The max_total_attempts ceiling is always checked first and overrides every
 * branch — it is the hard cap regardless of what any branch would return.
 */

import type {
  RetryPolicy,
  RetryStrategy,
  AnyEvent,
  GateFailed,
  AuditorJudged,
} from "@shared/events.js";

// ============================================================================
// Public types
// ============================================================================

export type RetryAction =
  | "retry_same"
  | "retry_with_context"
  | "reroute"
  | "decompose"
  | "escalate"
  | "stop";

/** Subset of attempt history needed to evaluate the retry policy. */
export type RetryAttemptContext = {
  /** The current attempt number (1-based). Next retry would be attempt_number + 1. */
  attempt_number: number;
  /** How many typecheck gate failures have occurred in this attempt chain so far. */
  typecheck_fail_count: number;
  /** How many test gate failures have occurred in this attempt chain so far. */
  test_fail_count: number;
};

export type RetryEvaluateInput = {
  policy: RetryPolicy;
  attempt: RetryAttemptContext;
  /** The event that triggered the evaluation (gate.failed, auditor.judged, pushback.raised). */
  last_event: AnyEvent;
};

export type RetryEvaluateResult = {
  action: RetryAction;
  reason: string;
};

// ============================================================================
// Helpers
// ============================================================================

/** Maps the canonical RetryStrategy union onto the RetryAction union. */
function strategyToAction(strategy: RetryStrategy): RetryAction {
  switch (strategy) {
    case "retry_same":
      return "retry_same";
    case "retry_with_more_context":
      return "retry_with_context";
    case "reroute_to_stronger_model":
      return "reroute";
    case "decompose_task":
      return "decompose";
    case "escalate_to_human":
      return "escalate";
  }
}

/** Returns true if the gate name indicates a TypeScript / type-checker gate. */
function isTypecheckGate(gate_name: string): boolean {
  return /tsc|typecheck|type[-_]?check/i.test(gate_name);
}

/** Returns true if the gate name indicates a test-runner gate. */
function isTestGate(gate_name: string): boolean {
  return /\btest|vitest|jest|pytest|spec\b/i.test(gate_name);
}

// ============================================================================
// evaluate — the main entry point
// ============================================================================

/**
 * Evaluates the retry policy and returns the action the caller should take.
 *
 * Decision tree:
 *   1. max_total_attempts hard ceiling (always wins)
 *   2. Dispatch on last_event.type
 *   3. Per-branch max_attempts ceiling (typecheck / test only)
 *   4. Map strategy → action
 */
export function evaluate(input: RetryEvaluateInput): RetryEvaluateResult {
  const { policy, attempt, last_event } = input;

  // ── 1. Hard ceiling ─────────────────────────────────────────────────────
  // attempt_number is the current attempt. The next retry would be
  // attempt_number + 1. If we're already at the ceiling, stop.
  if (attempt.attempt_number >= policy.max_total_attempts) {
    return {
      action: "stop",
      reason: `max_total_attempts (${policy.max_total_attempts}) reached`,
    };
  }

  // ── 2. Dispatch on triggering event ─────────────────────────────────────
  if (last_event.type === "gate.failed") {
    const payload = last_event.payload as GateFailed;

    if (isTypecheckGate(payload.gate_name)) {
      // Per-branch ceiling for typecheck failures
      if (attempt.typecheck_fail_count >= policy.on_typecheck_fail.max_attempts) {
        return {
          action: "stop",
          reason: `typecheck max_attempts (${policy.on_typecheck_fail.max_attempts}) exhausted`,
        };
      }
      return {
        action: strategyToAction(policy.on_typecheck_fail.strategy),
        reason: `typecheck gate '${payload.gate_name}' failed`,
      };
    }

    if (isTestGate(payload.gate_name)) {
      // Per-branch ceiling for test failures
      if (attempt.test_fail_count >= policy.on_test_fail.max_attempts) {
        return {
          action: "stop",
          reason: `test max_attempts (${policy.on_test_fail.max_attempts}) exhausted`,
        };
      }
      return {
        action: strategyToAction(policy.on_test_fail.strategy),
        reason: `test gate '${payload.gate_name}' failed`,
      };
    }

    // Gate type not recognised — no matching branch
    return {
      action: "stop",
      reason: `gate '${payload.gate_name}' failed — no matching policy branch`,
    };
  }

  if (last_event.type === "auditor.judged") {
    const payload = last_event.payload as AuditorJudged;

    if (payload.verdict === "revise" || payload.verdict === "reject") {
      return {
        action: strategyToAction(policy.on_audit_reject),
        reason: `auditor verdict: ${payload.verdict}`,
      };
    }

    // verdict === "approve" — evaluate shouldn't normally be called here,
    // but handle it gracefully
    return {
      action: "stop",
      reason: "auditor approved — no retry needed",
    };
  }

  if (last_event.type === "pushback.raised") {
    if (policy.on_spec_pushback === "pause_and_notify") {
      return {
        action: "escalate",
        reason: "spec pushback raised — pausing for human review",
      };
    }
    // auto_defer
    return {
      action: "stop",
      reason: "spec pushback raised — auto-deferring",
    };
  }

  // ── 3. No matching branch ─────────────────────────────────────────────────
  return {
    action: "stop",
    reason: `no matching retry policy branch for event type '${last_event.type}'`,
  };
}
