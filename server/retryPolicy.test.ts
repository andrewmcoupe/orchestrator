/**
 * retryPolicy.test.ts
 *
 * Exhaustive unit tests for the pure retry policy evaluator.
 * No DB, no events emitted — just input → output assertions.
 */

import { describe, it, expect } from "vitest";
import { evaluate, type RetryEvaluateInput } from "./retryPolicy.js";
import type { RetryPolicy, AnyEvent } from "@shared/events.js";
import { ulid } from "ulid";

// ============================================================================
// Fixtures
// ============================================================================

const actor = { kind: "system" as const, component: "scheduler" as const };

function makePolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_with_more_context", max_attempts: 3 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 5,
    ...overrides,
  };
}

function makeGateFailedEvent(gate_name: string): AnyEvent {
  return {
    id: ulid(),
    type: "gate.failed",
    aggregate_type: "gate",
    aggregate_id: `GR-${ulid()}`,
    version: 1,
    ts: new Date().toISOString(),
    actor,
    payload: {
      gate_run_id: `GR-${ulid()}`,
      gate_name,
      duration_ms: 1000,
      failures: [{ category: "error", excerpt: "some error" }],
    },
  } as AnyEvent;
}

function makeAuditorJudgedEvent(
  verdict: "approve" | "revise" | "reject",
): AnyEvent {
  return {
    id: ulid(),
    type: "auditor.judged",
    aggregate_type: "attempt",
    aggregate_id: `A-${ulid()}`,
    version: 1,
    ts: new Date().toISOString(),
    actor,
    payload: {
      audit_id: `AUD-${ulid()}`,
      attempt_id: `A-${ulid()}`,
      verdict,
      confidence: 0.9,
      summary: "test verdict",
      concerns: [],
      model: "claude-sonnet-4-6",
      prompt_version_id: "pv-001",
    },
  } as AnyEvent;
}

function makePushbackEvent(
  kind: "blocking" | "advisory" | "question" = "blocking",
): AnyEvent {
  return {
    id: ulid(),
    type: "pushback.raised",
    aggregate_type: "attempt",
    aggregate_id: `A-${ulid()}`,
    version: 1,
    ts: new Date().toISOString(),
    actor: { kind: "agent", model: "claude-sonnet-4-6" },
    payload: {
      pushback_id: `PB-${ulid()}`,
      proposition_id: "prop-001",
      kind,
      rationale: "ambiguous spec",
      suggested_resolutions: ["clarify X"],
      raised_by: { phase: "implementer", model: "claude-sonnet-4-6" },
    },
  } as AnyEvent;
}

function makeInput(
  overrides?: Partial<RetryEvaluateInput>,
): RetryEvaluateInput {
  return {
    policy: makePolicy(),
    attempt: { attempt_number: 1, typecheck_fail_count: 0, test_fail_count: 0 },
    last_event: makeGateFailedEvent("typecheck"),
    ...overrides,
  };
}

// ============================================================================
// Tests: max_total_attempts hard ceiling
// ============================================================================

describe("max_total_attempts ceiling", () => {
  it("returns stop when attempt_number equals max_total_attempts", () => {
    const result = evaluate(
      makeInput({ attempt: { attempt_number: 5, typecheck_fail_count: 0, test_fail_count: 0 } }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/max_total_attempts/);
  });

  it("returns stop when attempt_number exceeds max_total_attempts", () => {
    const result = evaluate(
      makeInput({ attempt: { attempt_number: 10, typecheck_fail_count: 0, test_fail_count: 0 } }),
    );
    expect(result.action).toBe("stop");
  });

  it("ceiling overrides typecheck branch that would otherwise retry", () => {
    const policy = makePolicy({
      on_typecheck_fail: { strategy: "retry_same", max_attempts: 99 },
      max_total_attempts: 3,
    });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 3, typecheck_fail_count: 0, test_fail_count: 0 },
        last_event: makeGateFailedEvent("typecheck"),
      }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/max_total_attempts/);
  });

  it("ceiling overrides test branch that would otherwise retry", () => {
    const policy = makePolicy({
      on_test_fail: { strategy: "retry_with_more_context", max_attempts: 99 },
      max_total_attempts: 2,
    });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 2, typecheck_fail_count: 0, test_fail_count: 0 },
        last_event: makeGateFailedEvent("vitest"),
      }),
    );
    expect(result.action).toBe("stop");
  });

  it("ceiling overrides audit branch", () => {
    const policy = makePolicy({ max_total_attempts: 1 });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 1, typecheck_fail_count: 0, test_fail_count: 0 },
        last_event: makeAuditorJudgedEvent("revise"),
      }),
    );
    expect(result.action).toBe("stop");
  });

  it("ceiling overrides pushback branch", () => {
    const policy = makePolicy({ max_total_attempts: 1 });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 1, typecheck_fail_count: 0, test_fail_count: 0 },
        last_event: makePushbackEvent(),
      }),
    );
    expect(result.action).toBe("stop");
  });

  it("does NOT stop when attempt_number is below max", () => {
    const result = evaluate(
      makeInput({ attempt: { attempt_number: 1, typecheck_fail_count: 0, test_fail_count: 0 } }),
    );
    expect(result.action).not.toBe("stop");
  });
});

// ============================================================================
// Tests: typecheck-fail branch
// ============================================================================

describe("typecheck-fail branch", () => {
  it("matches gate named 'typecheck'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("typecheck") }));
    expect(result.action).toBe("retry_same");
    expect(result.reason).toMatch(/typecheck/);
  });

  it("matches gate named 'tsc'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("retry_same");
  });

  it("matches gate named 'type-check'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("type-check") }));
    expect(result.action).toBe("retry_same");
  });

  it("maps retry_same strategy", () => {
    const policy = makePolicy({ on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 } });
    const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("retry_same");
  });

  it("maps retry_with_more_context strategy", () => {
    const policy = makePolicy({
      on_typecheck_fail: { strategy: "retry_with_more_context", max_attempts: 2 },
    });
    const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("retry_with_context");
  });

  it("maps reroute_to_stronger_model strategy", () => {
    const policy = makePolicy({
      on_typecheck_fail: { strategy: "reroute_to_stronger_model", max_attempts: 2 },
    });
    const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("reroute");
  });

  it("maps decompose_task strategy", () => {
    const policy = makePolicy({
      on_typecheck_fail: { strategy: "decompose_task", max_attempts: 2 },
    });
    const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("decompose");
  });

  it("maps escalate_to_human strategy", () => {
    const policy = makePolicy({
      on_typecheck_fail: { strategy: "escalate_to_human", max_attempts: 2 },
    });
    const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("tsc") }));
    expect(result.action).toBe("escalate");
  });

  it("stops when typecheck_fail_count reaches max_attempts", () => {
    const policy = makePolicy({ on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 } });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 2, typecheck_fail_count: 2, test_fail_count: 0 },
        last_event: makeGateFailedEvent("tsc"),
      }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/typecheck max_attempts/);
  });

  it("stops when typecheck_fail_count exceeds max_attempts", () => {
    const policy = makePolicy({ on_typecheck_fail: { strategy: "retry_same", max_attempts: 1 } });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 2, typecheck_fail_count: 3, test_fail_count: 0 },
        last_event: makeGateFailedEvent("typecheck"),
      }),
    );
    expect(result.action).toBe("stop");
  });
});

// ============================================================================
// Tests: test-fail branch
// ============================================================================

describe("test-fail branch", () => {
  it("matches gate named 'vitest'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("vitest") }));
    expect(result.action).toBe("retry_with_context");
  });

  it("matches gate named 'jest'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("jest") }));
    expect(result.action).toBe("retry_with_context");
  });

  it("matches gate named 'pytest'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("pytest") }));
    expect(result.action).toBe("retry_with_context");
  });

  it("matches gate named 'tests'", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("tests") }));
    expect(result.action).toBe("retry_with_context");
  });

  it("maps all test strategies correctly", () => {
    const strategies: Array<[string, string]> = [
      ["retry_same", "retry_same"],
      ["retry_with_more_context", "retry_with_context"],
      ["reroute_to_stronger_model", "reroute"],
      ["decompose_task", "decompose"],
      ["escalate_to_human", "escalate"],
    ] as const;

    for (const [strategy, expectedAction] of strategies) {
      const policy = makePolicy({
        on_test_fail: { strategy: strategy as RetryPolicy["on_test_fail"]["strategy"], max_attempts: 3 },
      });
      const result = evaluate(makeInput({ policy, last_event: makeGateFailedEvent("vitest") }));
      expect(result.action).toBe(expectedAction);
    }
  });

  it("stops when test_fail_count reaches max_attempts", () => {
    const policy = makePolicy({
      on_test_fail: { strategy: "retry_with_more_context", max_attempts: 3 },
    });
    const result = evaluate(
      makeInput({
        policy,
        attempt: { attempt_number: 2, typecheck_fail_count: 0, test_fail_count: 3 },
        last_event: makeGateFailedEvent("vitest"),
      }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/test max_attempts/);
  });
});

// ============================================================================
// Tests: audit branch
// ============================================================================

describe("auditor.judged branch", () => {
  it("verdict=revise applies on_audit_reject strategy", () => {
    const policy = makePolicy({ on_audit_reject: "retry_same" });
    const result = evaluate(
      makeInput({ policy, last_event: makeAuditorJudgedEvent("revise") }),
    );
    expect(result.action).toBe("retry_same");
    expect(result.reason).toMatch(/revise/);
  });

  it("verdict=reject applies on_audit_reject strategy", () => {
    const policy = makePolicy({ on_audit_reject: "reroute_to_stronger_model" });
    const result = evaluate(
      makeInput({ policy, last_event: makeAuditorJudgedEvent("reject") }),
    );
    expect(result.action).toBe("reroute");
    expect(result.reason).toMatch(/reject/);
  });

  it("verdict=approve returns stop", () => {
    const result = evaluate(
      makeInput({ last_event: makeAuditorJudgedEvent("approve") }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/approved/);
  });

  it("maps all on_audit_reject strategies", () => {
    const cases: Array<[RetryPolicy["on_audit_reject"], string]> = [
      ["retry_same", "retry_same"],
      ["retry_with_more_context", "retry_with_context"],
      ["reroute_to_stronger_model", "reroute"],
      ["decompose_task", "decompose"],
      ["escalate_to_human", "escalate"],
    ];
    for (const [strategy, expectedAction] of cases) {
      const policy = makePolicy({ on_audit_reject: strategy });
      const result = evaluate(
        makeInput({ policy, last_event: makeAuditorJudgedEvent("revise") }),
      );
      expect(result.action).toBe(expectedAction);
    }
  });
});

// ============================================================================
// Tests: pushback branch
// ============================================================================

describe("pushback.raised branch", () => {
  it("pause_and_notify maps to escalate", () => {
    const policy = makePolicy({ on_spec_pushback: "pause_and_notify" });
    const result = evaluate(
      makeInput({ policy, last_event: makePushbackEvent() }),
    );
    expect(result.action).toBe("escalate");
    expect(result.reason).toMatch(/pushback/);
  });

  it("auto_defer maps to stop", () => {
    const policy = makePolicy({ on_spec_pushback: "auto_defer" });
    const result = evaluate(
      makeInput({ policy, last_event: makePushbackEvent() }),
    );
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/pushback/);
  });
});

// ============================================================================
// Tests: unknown / edge cases
// ============================================================================

describe("edge cases", () => {
  it("unknown gate name returns stop", () => {
    const result = evaluate(makeInput({ last_event: makeGateFailedEvent("eslint") }));
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/no matching policy branch/);
  });

  it("unknown event type returns stop", () => {
    const unknownEvent = {
      id: ulid(),
      type: "task.created",
      aggregate_type: "task",
      aggregate_id: "T-001",
      version: 1,
      ts: new Date().toISOString(),
      actor,
      payload: { task_id: "T-001", title: "t", config: {} },
    } as unknown as AnyEvent;

    const result = evaluate(makeInput({ last_event: unknownEvent }));
    expect(result.action).toBe("stop");
    expect(result.reason).toMatch(/no matching retry policy branch/);
  });

  it("evaluate is deterministic — same inputs produce same output", () => {
    const input = makeInput({
      policy: makePolicy({ on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 } }),
      attempt: { attempt_number: 1, typecheck_fail_count: 1, test_fail_count: 0 },
      last_event: makeGateFailedEvent("tsc"),
    });
    const r1 = evaluate(input);
    const r2 = evaluate(input);
    expect(r1).toEqual(r2);
  });

  it("evaluate emits no events (no side effects)", () => {
    // If evaluate were to emit events, it would throw because there's no DB.
    // The fact this test completes without error confirms no side effects.
    expect(() => evaluate(makeInput())).not.toThrow();
  });
});
