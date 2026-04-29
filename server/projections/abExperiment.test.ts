import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import {
  appendAndProject,
  initProjections,
  rebuildProjection,
} from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import type { AbExperimentRow } from "@shared/projections.js";

// Register all projections including abExperiment
import "./register.js";

// ============================================================================
// Types
// ============================================================================

// Raw DB row shape — _variant is transient and never written, split_a is persisted
type RawRow = Omit<
  AbExperimentRow,
  "significance_p" | "winner" | "_variant"
> & {
  significance_p: number | null;
  winner: string | null;
};

// ============================================================================
// Fixtures
// ============================================================================

const actor: Actor = { kind: "user", user_id: "test" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

function getRow(
  db: Database.Database,
  experimentId: string,
): AbExperimentRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_ab_experiment WHERE experiment_id = ?")
    .get(experimentId) as RawRow | undefined;
  if (!raw) return null;
  const { significance_p, winner, ...rest } = raw;
  return {
    ...rest,
    significance_p: significance_p ?? undefined,
    winner: (winner as AbExperimentRow["winner"]) ?? undefined,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ab_experiment projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("proj_ab_experiment table is created on first run", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proj_ab_experiment'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("proj_ab_experiment");
  });

  it("creates a row on ab_experiment.created", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-001",
      actor,
      payload: {
        experiment_id: "exp-001",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    const row = getRow(db, "exp-001");
    expect(row).not.toBeNull();
    expect(row!.experiment_id).toBe("exp-001");
    expect(row!.phase_class).toBe("implementer");
    expect(row!.variant_a_id).toBe("pv-a");
    expect(row!.variant_b_id).toBe("pv-b");
    expect(row!.bucket_key).toBe("${task_id}:implementer");
    expect(row!.status).toBe("running");
    expect(row!.a_n).toBe(0);
    expect(row!.b_n).toBe(0);
    expect(row!.winner).toBeUndefined();
  });

  it("ab_experiment.created is idempotent (second event is a no-op)", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-idem",
      actor,
      payload: {
        experiment_id: "exp-idem",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [50, 50],
        bucket_key: "key",
      },
    });

    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-idem",
      actor,
      payload: {
        experiment_id: "exp-idem",
        phase_class: "auditor",
        variants: { A: "pv-c", B: "pv-d" },
        split: [70, 30],
        bucket_key: "other-key",
      },
    });

    const row = getRow(db, "exp-idem");
    // First write wins — original values preserved
    expect(row!.phase_class).toBe("implementer");
    expect(row!.variant_a_id).toBe("pv-a");
  });

  it("ab_experiment.concluded updates status, winner and stats", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-conclude",
      actor,
      payload: {
        experiment_id: "exp-conclude",
        phase_class: "auditor",
        variants: { A: "pv-aa", B: "pv-bb" },
        split: [50, 50],
        bucket_key: "key",
      },
    });

    appendAndProject(db, {
      type: "ab_experiment.concluded",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-conclude",
      actor,
      payload: {
        experiment_id: "exp-conclude",
        winner: "A",
        reason: "A had significantly higher success rate",
        stats: {
          a: { n: 50, success_rate: 0.9, avg_cost_usd: 0.01 },
          b: { n: 48, success_rate: 0.7, avg_cost_usd: 0.012 },
        },
      },
    });

    const row = getRow(db, "exp-conclude");
    expect(row!.status).toBe("concluded");
    expect(row!.winner).toBe("A");
    expect(row!.a_n).toBe(50);
    expect(row!.b_n).toBe(48);
    expect(row!.a_success_rate).toBeCloseTo(0.9);
    expect(row!.b_success_rate).toBeCloseTo(0.7);
    expect(row!.a_cost_usd).toBeCloseTo(0.5); // 50 * 0.01
    expect(row!.b_cost_usd).toBeCloseTo(0.576); // 48 * 0.012
  });

  it("rebuild produces identical state", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-rebuild",
      actor,
      payload: {
        experiment_id: "exp-rebuild",
        phase_class: "implementer",
        variants: { A: "pv-x", B: "pv-y" },
        split: [50, 50],
        bucket_key: "key",
      },
    });

    appendAndProject(db, {
      type: "ab_experiment.concluded",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-rebuild",
      actor,
      payload: {
        experiment_id: "exp-rebuild",
        winner: "B",
        reason: "B was cheaper",
        stats: {
          a: { n: 20, success_rate: 0.8, avg_cost_usd: 0.02 },
          b: { n: 22, success_rate: 0.85, avg_cost_usd: 0.015 },
        },
      },
    });

    const before = getRow(db, "exp-rebuild");
    rebuildProjection(db, "ab_experiment");
    const after = getRow(db, "exp-rebuild");

    expect(after).toEqual(before);
  });

  it("multiple experiments coexist independently", () => {
    for (const id of ["exp-alpha", "exp-beta", "exp-gamma"]) {
      appendAndProject(db, {
        type: "ab_experiment.created",
        aggregate_type: "ab_experiment",
        aggregate_id: id,
        actor,
        payload: {
          experiment_id: id,
          phase_class: "implementer",
          variants: { A: `pv-${id}-a`, B: `pv-${id}-b` },
          split: [50, 50],
          bucket_key: id,
        },
      });
    }

    const rows = db
      .prepare(
        "SELECT experiment_id FROM proj_ab_experiment ORDER BY experiment_id",
      )
      .all() as Array<{ experiment_id: string }>;
    expect(rows.map((r) => r.experiment_id)).toEqual([
      "exp-alpha",
      "exp-beta",
      "exp-gamma",
    ]);
  });

  it("stores split_a on ab_experiment.created", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-split",
      actor,
      payload: {
        experiment_id: "exp-split",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [70, 30],
        bucket_key: "${task_id}:implementer",
      },
    });

    const row = getRow(db, "exp-split");
    expect(row!.split_a).toBe(70);
  });

  // ============================================================================
  // invocation.completed stats tests
  // ============================================================================

  /**
   * Helper: append an invocation.started event so that invocation.completed
   * can resolve the prompt_version_id via cross-event lookup.
   */
  function appendInvocationStarted(
    invocationId: string,
    promptVersionId: string,
  ): void {
    appendAndProject(db, {
      type: "invocation.started",
      aggregate_type: "attempt",
      aggregate_id: `attempt-${invocationId}`,
      actor,
      payload: {
        invocation_id: invocationId,
        attempt_id: `attempt-${invocationId}`,
        phase_name: "implementer",
        transport: "claude-code",
        model: "claude-sonnet",
        prompt_version_id: promptVersionId,
        context_manifest_hash: "abc123",
      },
    });
  }

  function appendInvocationCompleted(
    invocationId: string,
    costUsd: number,
    outcome: "success" | "failed" | "aborted" = "success",
  ): void {
    appendAndProject(db, {
      type: "invocation.completed",
      aggregate_type: "attempt",
      aggregate_id: `attempt-${invocationId}`,
      actor,
      payload: {
        invocation_id: invocationId,
        outcome,
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: costUsd,
        duration_ms: 1000,
        turns: 1,
        stdout_tail_hash: "",
        exit_reason: "unknown",
        permission_blocked_on: "",
        stderr_tail_hash: "",
      },
    });
  }

  it("invocation.completed increments a_n and a_cost_usd when variant A", () => {
    // Set up the experiment
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-inv-a",
      actor,
      payload: {
        experiment_id: "exp-inv-a",
        phase_class: "implementer",
        variants: { A: "pv-variant-a", B: "pv-variant-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    // Append invocation.started with variant A prompt version
    appendInvocationStarted("inv-001", "pv-variant-a");
    appendInvocationCompleted("inv-001", 0.05);

    const row = getRow(db, "exp-inv-a");
    expect(row!.a_n).toBe(1);
    expect(row!.a_cost_usd).toBeCloseTo(0.05);
    expect(row!.b_n).toBe(0);
    expect(row!.b_cost_usd).toBe(0);
  });

  it("invocation.completed increments b_n and b_cost_usd when variant B", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-inv-b",
      actor,
      payload: {
        experiment_id: "exp-inv-b",
        phase_class: "implementer",
        variants: { A: "pv-va", B: "pv-vb" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    appendInvocationStarted("inv-002", "pv-vb");
    appendInvocationCompleted("inv-002", 0.03);

    const row = getRow(db, "exp-inv-b");
    expect(row!.b_n).toBe(1);
    expect(row!.b_cost_usd).toBeCloseTo(0.03);
    expect(row!.a_n).toBe(0);
    expect(row!.a_cost_usd).toBe(0);
  });

  it("invocation.completed for unknown prompt_version_id is a no-op", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-inv-noop",
      actor,
      payload: {
        experiment_id: "exp-inv-noop",
        phase_class: "implementer",
        variants: { A: "pv-known-a", B: "pv-known-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    // Invocation with a prompt_version_id that belongs to a different experiment
    appendInvocationStarted("inv-003", "pv-unrelated");
    appendInvocationCompleted("inv-003", 0.01);

    const row = getRow(db, "exp-inv-noop");
    expect(row!.a_n).toBe(0);
    expect(row!.b_n).toBe(0);
  });

  // ============================================================================
  // auditor.judged stats tests
  // ============================================================================

  function appendAuditorJudged(
    promptVersionId: string,
    verdict: "approve" | "revise" | "reject",
    auditId = "audit-001",
  ): void {
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "audit",
      aggregate_id: auditId,
      actor,
      payload: {
        audit_id: auditId,
        attempt_id: "attempt-001",
        verdict,
        confidence: 0.9,
        summary: "Looks good",
        concerns: [],
        model: "claude-sonnet",
        prompt_version_id: promptVersionId,
      },
    });
  }

  it("auditor.judged with approve increments a_success_n for variant A", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-audit-a",
      actor,
      payload: {
        experiment_id: "exp-audit-a",
        phase_class: "implementer",
        variants: { A: "pv-audit-a", B: "pv-audit-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    // Need at least one invocation so a_n > 0 for rate to be meaningful
    appendInvocationStarted("inv-a1", "pv-audit-a");
    appendInvocationCompleted("inv-a1", 0.01);

    appendAuditorJudged("pv-audit-a", "approve", "audit-a1");

    const row = getRow(db, "exp-audit-a");
    expect(row!.a_success_n).toBe(1);
    expect(row!.b_success_n).toBe(0);
    expect(row!.a_success_rate).toBeCloseTo(1); // 1/1
  });

  it("auditor.judged with revise does NOT increment success_n", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-audit-revise",
      actor,
      payload: {
        experiment_id: "exp-audit-revise",
        phase_class: "implementer",
        variants: { A: "pv-rev-a", B: "pv-rev-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    appendAuditorJudged("pv-rev-a", "revise", "audit-rev1");

    const row = getRow(db, "exp-audit-revise");
    expect(row!.a_success_n).toBe(0);
    expect(row!.b_success_n).toBe(0);
  });

  it("auditor.judged with reject does NOT increment success_n", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-audit-reject",
      actor,
      payload: {
        experiment_id: "exp-audit-reject",
        phase_class: "implementer",
        variants: { A: "pv-rej-a", B: "pv-rej-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    appendAuditorJudged("pv-rej-a", "reject", "audit-rej1");

    const row = getRow(db, "exp-audit-reject");
    expect(row!.a_success_n).toBe(0);
  });

  it("significance_p is computed and stored after invocation.completed", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-sig",
      actor,
      payload: {
        experiment_id: "exp-sig",
        phase_class: "implementer",
        variants: { A: "pv-sig-a", B: "pv-sig-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    appendInvocationStarted("inv-sig1", "pv-sig-a");
    appendInvocationCompleted("inv-sig1", 0.01);

    const row = getRow(db, "exp-sig");
    // significance_p should be computed (returns 1 with no successes yet)
    expect(row!.significance_p).toBeDefined();
    expect(row!.significance_p).toBe(1); // no successes, pooled rate = 0, denom = 0
  });

  it("significance_p reflects real difference after approve events", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-sig-diff",
      actor,
      payload: {
        experiment_id: "exp-sig-diff",
        phase_class: "implementer",
        variants: { A: "pv-sd-a", B: "pv-sd-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    // Seed 100 invocations for A, 90 successes
    for (let i = 0; i < 100; i++) {
      appendInvocationStarted(`inv-sd-a-${i}`, "pv-sd-a");
      appendInvocationCompleted(`inv-sd-a-${i}`, 0.01);
    }
    for (let i = 0; i < 90; i++) {
      appendAuditorJudged("pv-sd-a", "approve", `audit-sd-a-${i}`);
    }

    // Seed 100 invocations for B, 70 successes
    for (let i = 0; i < 100; i++) {
      appendInvocationStarted(`inv-sd-b-${i}`, "pv-sd-b");
      appendInvocationCompleted(`inv-sd-b-${i}`, 0.01);
    }
    for (let i = 0; i < 70; i++) {
      appendAuditorJudged("pv-sd-b", "approve", `audit-sd-b-${i}`);
    }

    const row = getRow(db, "exp-sig-diff");
    expect(row!.a_n).toBe(100);
    expect(row!.b_n).toBe(100);
    expect(row!.a_success_n).toBe(90);
    expect(row!.b_success_n).toBe(70);
    // Highly significant — p < 0.001
    expect(row!.significance_p).toBeDefined();
    expect(row!.significance_p!).toBeLessThan(0.001);
  });

  it("rebuild produces identical state after invocation and audit events", () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-rebuild2",
      actor,
      payload: {
        experiment_id: "exp-rebuild2",
        phase_class: "implementer",
        variants: { A: "pv-rb-a", B: "pv-rb-b" },
        split: [50, 50],
        bucket_key: "${task_id}:implementer",
      },
    });

    appendInvocationStarted("inv-rb1", "pv-rb-a");
    appendInvocationCompleted("inv-rb1", 0.02);
    appendAuditorJudged("pv-rb-a", "approve", "audit-rb1");

    appendInvocationStarted("inv-rb2", "pv-rb-b");
    appendInvocationCompleted("inv-rb2", 0.01);
    appendAuditorJudged("pv-rb-b", "revise", "audit-rb2");

    const before = getRow(db, "exp-rebuild2");
    rebuildProjection(db, "ab_experiment");
    const after = getRow(db, "exp-rebuild2");

    expect(after).toEqual(before);
  });
});
