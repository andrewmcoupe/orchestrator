/**
 * attempt.test.ts
 *
 * Tests for the attempt projection — verifies that all attempt-lifecycle
 * events fold correctly into AttemptRow and that the table is created,
 * queried, and rebuilt correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { appendAndProject, initProjections, rebuildProjection } from "../projectionRunner.js";
import "./register.js";
import type { Actor, TaskConfig, ExitReason } from "@shared/events.js";
import type { AttemptRow } from "@shared/projections.js";

// ============================================================================
// Fixtures
// ============================================================================

const actor: Actor = { kind: "user", user_id: "test" };

const minimalConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-test",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 5,
        max_budget_usd: 0.5,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 0,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 1000,
      },
    },
    {
      name: "auditor",
      enabled: true,
      transport: "anthropic-api",
      model: "claude-opus-4-6",
      prompt_version_id: "pv-auditor-v1",
      transport_options: { kind: "api", max_tokens: 4096 },
      context_policy: {
        symbol_graph_depth: 0,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 4000,
      },
    },
  ],
  gates: [],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 1 },
    on_test_fail: { strategy: "retry_same", max_attempts: 1 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

function seedTask(db: Database.Database, task_id: string) {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: task_id,
    actor,
    payload: {
      task_id,
      title: "Test task",
      proposition_ids: [],
      config_snapshot: minimalConfig,
    },
  });
}

function getAttemptRow(db: Database.Database, attempt_id: string): AttemptRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_attempt WHERE attempt_id = ?")
    .get(attempt_id) as Record<string, unknown> | undefined;
  if (!raw) return null;
  return {
    attempt_id: raw.attempt_id as string,
    task_id: raw.task_id as string,
    attempt_number: raw.attempt_number as number,
    status: raw.status as AttemptRow["status"],
    outcome: (raw.outcome ?? undefined) as AttemptRow["outcome"],
    started_at: raw.started_at as string,
    completed_at: (raw.completed_at ?? undefined) as string | undefined,
    duration_ms: (raw.duration_ms ?? undefined) as number | undefined,
    tokens_in_total: raw.tokens_in_total as number,
    tokens_out_total: raw.tokens_out_total as number,
    cost_usd_total: raw.cost_usd_total as number,
    phases: JSON.parse(raw.phases_json as string),
    gate_runs: JSON.parse(raw.gate_runs_json as string),
    audit: raw.audit_json ? JSON.parse(raw.audit_json as string) : undefined,
    files_changed: JSON.parse(raw.files_changed_json as string),
    config_snapshot: JSON.parse(raw.config_snapshot_json as string),
    previous_attempt_id: (raw.previous_attempt_id ?? undefined) as string | undefined,
    commit_sha: (raw.commit_sha ?? undefined) as string | undefined,
    empty: raw.empty === 1 ? true : raw.empty === 0 ? false : undefined,
    effective_diff_attempt_id: (raw.effective_diff_attempt_id ?? undefined) as string | undefined,
    last_failure_reason: (raw.last_failure_reason ?? null) as ExitReason | null,
    last_event_id: raw.last_event_id as string,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("attempt projection", () => {
  let db: Database.Database;
  const task_id = "T-001";
  const attempt_id = "A-001";
  const invocation_id = "INV-001";
  const gate_run_id = "GATE-001";

  beforeEach(() => {
    db = makeDb();
    seedTask(db, task_id);
  });

  it("creates a row on attempt.started", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        task_id,
        attempt_number: 1,
        config_snapshot: minimalConfig,
        triggered_by: "user_start",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row).not.toBeNull();
    expect(row!.attempt_id).toBe(attempt_id);
    expect(row!.task_id).toBe(task_id);
    expect(row!.status).toBe("running");
    expect(row!.attempt_number).toBe(1);
    expect(row!.tokens_in_total).toBe(0);
    expect(row!.gate_runs).toEqual([]);
  });

  it("tracks phase lifecycle: started → completed", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "phase.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, phase_name: "implementer", transport: "claude-code", model: "sonnet-4-6", prompt_version_id: "pv-test" },
    });
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, phase_name: "implementer", outcome: "success", tokens_in: 100, tokens_out: 200, cost_usd: 0.01, duration_ms: 5000 },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.phases["implementer"]).toMatchObject({
      phase_name: "implementer",
      status: "succeeded",
      tokens_in: 100,
      tokens_out: 200,
    });
  });

  it("accumulates token totals from invocation.completed", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "invocation.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { invocation_id, outcome: "success", tokens_in: 500, tokens_out: 300, cost_usd: 0.05, duration_ms: 2000, turns: 3 },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.tokens_in_total).toBe(500);
    expect(row!.tokens_out_total).toBe(300);
    expect(row!.cost_usd_total).toBeCloseTo(0.05);
  });

  it("tracks gate runs via correlation_id", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "gate.started",
      aggregate_type: "gate",
      aggregate_id: `gate-run:${gate_run_id}`,
      actor,
      correlation_id: attempt_id,
      payload: { gate_run_id, gate_name: "tsc", attempt_id },
    });
    appendAndProject(db, {
      type: "gate.passed",
      aggregate_type: "gate",
      aggregate_id: `gate-run:${gate_run_id}`,
      actor,
      correlation_id: attempt_id,
      payload: { gate_run_id, gate_name: "tsc", duration_ms: 1200 },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.gate_runs).toHaveLength(1);
    expect(row!.gate_runs[0]).toMatchObject({
      gate_run_id,
      gate_name: "tsc",
      status: "passed",
      duration_ms: 1200,
    });
  });

  it("sets audit field on auditor.judged", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "audit",
      aggregate_id: "audit-001",
      actor,
      correlation_id: attempt_id,
      payload: {
        audit_id: "audit-001",
        attempt_id,
        verdict: "approve",
        confidence: 0.95,
        summary: "Implementation looks correct.",
        concerns: [],
        model: "claude-opus-4-6",
        prompt_version_id: "pv-auditor-v1",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.audit).toMatchObject({
      verdict: "approve",
      confidence: 0.95,
      concern_count: 0,
      blocking_count: 0,
      overridden: false,
    });
  });

  it("counts blocking vs advisory concerns correctly", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "audit",
      aggregate_id: "audit-001",
      actor,
      correlation_id: attempt_id,
      payload: {
        audit_id: "audit-001",
        attempt_id,
        verdict: "revise",
        confidence: 0.7,
        summary: "Has some issues.",
        concerns: [
          { category: "correctness", severity: "blocking", rationale: "Missing null check" },
          { category: "style", severity: "advisory", rationale: "Prefer const" },
        ],
        model: "claude-opus-4-6",
        prompt_version_id: "pv-auditor-v1",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.audit!.concern_count).toBe(2);
    expect(row!.audit!.blocking_count).toBe(1);
    expect(row!.audit!.verdict).toBe("revise");
  });

  it("sets status=completed and outcome on attempt.completed", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "attempt.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        outcome: "approved",
        tokens_in_total: 1000,
        tokens_out_total: 500,
        cost_usd_total: 0.1,
        duration_ms: 30000,
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.status).toBe("completed");
    expect(row!.outcome).toBe("approved");
    expect(row!.duration_ms).toBe(30000);
  });

  it("tracks file changes from invocation.file_edited", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "invocation.file_edited",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        invocation_id,
        path: "src/foo.ts",
        operation: "update",
        patch_hash: "abc123",
        lines_added: 10,
        lines_removed: 3,
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.files_changed).toHaveLength(1);
    expect(row!.files_changed[0]).toMatchObject({
      path: "src/foo.ts",
      operation: "update",
      lines_added: 10,
      lines_removed: 3,
    });
  });

  // ============================================================================
  // effective_diff_attempt_id
  // ============================================================================

  it("non-empty attempt sets effective_diff_attempt_id to its own id", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "attempt.committed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, commit_sha: "abc123def456", empty: false },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.effective_diff_attempt_id).toBe(attempt_id);
  });

  it("empty attempt walks back to find the most recent non-empty attempt", () => {
    // Attempt 1: non-empty
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: { attempt_id: "A-001", task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "attempt.committed",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: { attempt_id: "A-001", commit_sha: "sha-1", empty: false },
    });

    // Attempt 2: empty, links back to A-001
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: "A-002",
      actor,
      correlation_id: "A-002",
      payload: { attempt_id: "A-002", task_id, attempt_number: 2, config_snapshot: minimalConfig, triggered_by: "retry", previous_attempt_id: "A-001" },
    });
    appendAndProject(db, {
      type: "attempt.committed",
      aggregate_type: "attempt",
      aggregate_id: "A-002",
      actor,
      correlation_id: "A-002",
      payload: { attempt_id: "A-002", commit_sha: "sha-2", empty: true },
    });

    const row = getAttemptRow(db, "A-002");
    expect(row!.empty).toBe(true);
    expect(row!.effective_diff_attempt_id).toBe("A-001");
  });

  it("effective_diff_attempt_id is null when no prior non-empty attempt exists", () => {
    // Attempt 1: empty (first attempt, no previous)
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: { attempt_id: "A-001", task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "attempt.committed",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: { attempt_id: "A-001", commit_sha: "sha-1", empty: true },
    });

    const row = getAttemptRow(db, "A-001");
    expect(row!.empty).toBe(true);
    expect(row!.effective_diff_attempt_id).toBeUndefined();
  });

  // ============================================================================
  // last_failure_reason
  // ============================================================================

  it("last_failure_reason is null initially", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.last_failure_reason).toBeNull();
  });

  it("last_failure_reason is populated from phase.completed with a non-normal exit_reason", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        phase_name: "implementer",
        outcome: "failed",
        tokens_in: 10,
        tokens_out: 0,
        cost_usd: 0,
        duration_ms: 500,
        exit_reason: "permission_blocked",
        permission_blocked_on: "Write",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.last_failure_reason).toBe("permission_blocked");
  });

  it("last_failure_reason is not updated when exit_reason is 'normal'", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        phase_name: "implementer",
        outcome: "success",
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.001,
        duration_ms: 1000,
        exit_reason: "normal",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.last_failure_reason).toBeNull();
  });

  it("last_failure_reason is not updated when exit_reason is absent", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        phase_name: "implementer",
        outcome: "success",
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.001,
        duration_ms: 1000,
      },
    });

    const row = getAttemptRow(db, attempt_id);
    expect(row!.last_failure_reason).toBeNull();
  });

  it("last_failure_reason retains the most recent non-normal exit_reason across multiple phases", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    // First phase: budget_exceeded
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        phase_name: "implementer",
        outcome: "failed",
        tokens_in: 5000,
        tokens_out: 0,
        cost_usd: 10,
        duration_ms: 60000,
        exit_reason: "budget_exceeded",
      },
    });
    // Second phase: timeout (overwrites)
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        attempt_id,
        phase_name: "auditor",
        outcome: "failed",
        tokens_in: 100,
        tokens_out: 0,
        cost_usd: 0,
        duration_ms: 120000,
        exit_reason: "timeout",
      },
    });

    const row = getAttemptRow(db, attempt_id);
    // Most recent non-normal exit_reason wins
    expect(row!.last_failure_reason).toBe("timeout");
  });

  it("rebuild produces identical state", () => {
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
      payload: { attempt_id, task_id, attempt_number: 1, config_snapshot: minimalConfig, triggered_by: "user_start" },
    });
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "audit",
      aggregate_id: "audit-001",
      actor,
      correlation_id: attempt_id,
      payload: {
        audit_id: "audit-001",
        attempt_id,
        verdict: "approve",
        confidence: 0.9,
        summary: "All good.",
        concerns: [],
        model: "claude-opus-4-6",
        prompt_version_id: "pv-auditor-v1",
      },
    });

    const beforeRebuild = getAttemptRow(db, attempt_id);
    rebuildProjection(db, "attempt");
    const afterRebuild = getAttemptRow(db, attempt_id);

    expect(afterRebuild).toEqual(beforeRebuild);
  });
});
