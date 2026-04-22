/**
 * Auto-merge evaluator tests — verifies the pure evaluation logic
 * and the handleAutoMerge orchestration function.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./eventStore.js";
import { appendAndProject, initProjections } from "./projectionRunner.js";
import "./projections/register.js";
import {
  evaluateAutoMerge,
  getAutoMergeEnabled,
  handleAutoMerge,
  type AutoMergeInput,
  type HandleAutoMergeInput,
} from "./autoMerge.js";
import type { Actor, TaskConfig, TaskStatus } from "@shared/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<AutoMergeInput> = {}): AutoMergeInput {
  return {
    policy: "on_full_pass",
    shadow_mode: false,
    attempt_outcome: "approved",
    auditor_verdict: "approve",
    has_blocking_concerns: false,
    all_required_gates_passed: true,
    ...overrides,
  };
}

const testActor: Actor = { kind: "user", user_id: "test" };

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

function getEventTypes(db: Database.Database): string[] {
  return (
    db.prepare("SELECT type FROM events ORDER BY ts, id").all() as Array<{
      type: string;
    }>
  ).map((r) => r.type);
}

function getEventsOfType(db: Database.Database, type: string): Array<{ type: string; payload_json: string; actor_json: string }> {
  return db
    .prepare("SELECT type, payload_json, actor_json FROM events WHERE type = ? ORDER BY ts, id")
    .all(type) as Array<{ type: string; payload_json: string; actor_json: string }>;
}

// ---------------------------------------------------------------------------
// evaluateAutoMerge — pure function
// ---------------------------------------------------------------------------

describe("evaluateAutoMerge", () => {
  it("returns should_auto_merge=false when policy is off", () => {
    const result = evaluateAutoMerge(baseInput({ policy: "off" }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("policy is off");
  });

  it("on_full_pass: auto-merges when auditor approves, all gates pass, no blocking concerns", () => {
    const result = evaluateAutoMerge(baseInput());
    expect(result.should_auto_merge).toBe(true);
    expect(result.matched_conditions).toContain("auditor_verdict=approve");
    expect(result.matched_conditions).toContain("all_required_gates_passed");
    expect(result.matched_conditions).toContain("no_blocking_concerns");
    expect(result.unmet_conditions).toHaveLength(0);
  });

  it("on_full_pass: does not auto-merge when a required gate failed", () => {
    const result = evaluateAutoMerge(baseInput({ all_required_gates_passed: false }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("required gate(s) failed");
  });

  it("on_full_pass: does not auto-merge when blocking concerns exist", () => {
    const result = evaluateAutoMerge(baseInput({ has_blocking_concerns: true }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("blocking concerns present");
  });

  it("on_full_pass: does not auto-merge when auditor verdict is revise", () => {
    const result = evaluateAutoMerge(baseInput({ auditor_verdict: "revise" }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("auditor_verdict!=approve");
  });

  it("on_full_pass: does not auto-merge when no auditor ran", () => {
    const result = evaluateAutoMerge(baseInput({ auditor_verdict: undefined }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("no auditor verdict");
  });

  it("on_auditor_approve: auto-merges when auditor approves even if gate failed", () => {
    const result = evaluateAutoMerge(
      baseInput({ policy: "on_auditor_approve", all_required_gates_passed: false }),
    );
    expect(result.should_auto_merge).toBe(true);
    expect(result.matched_conditions).toContain("auditor_verdict=approve");
  });

  it("on_auditor_approve: does not auto-merge when auditor rejects", () => {
    const result = evaluateAutoMerge(
      baseInput({ policy: "on_auditor_approve", auditor_verdict: "reject" }),
    );
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("auditor_verdict!=approve");
  });

  it("does not auto-merge when attempt outcome is not approved", () => {
    const result = evaluateAutoMerge(baseInput({ attempt_outcome: "rejected" }));
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("attempt_outcome!=approved");
  });

  it("does not auto-merge when attempt outcome is failed", () => {
    const result = evaluateAutoMerge(baseInput({ attempt_outcome: "failed" }));
    expect(result.should_auto_merge).toBe(false);
  });

  it("on_auditor_approve: does not auto-merge when no auditor ran", () => {
    const result = evaluateAutoMerge(
      baseInput({ policy: "on_auditor_approve", auditor_verdict: undefined }),
    );
    expect(result.should_auto_merge).toBe(false);
    expect(result.unmet_conditions).toContain("no auditor verdict");
  });

  it("on_full_pass: reports both matched and unmet conditions when partially met", () => {
    const result = evaluateAutoMerge(
      baseInput({ all_required_gates_passed: false, has_blocking_concerns: true }),
    );
    expect(result.should_auto_merge).toBe(false);
    expect(result.matched_conditions).toContain("auditor_verdict=approve");
    expect(result.unmet_conditions).toContain("required gate(s) failed");
    expect(result.unmet_conditions).toContain("blocking concerns present");
  });
});

// ---------------------------------------------------------------------------
// getAutoMergeEnabled — reads from proj_settings
// ---------------------------------------------------------------------------

describe("getAutoMergeEnabled", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("returns false on a fresh DB (no settings event)", () => {
    expect(getAutoMergeEnabled(db)).toBe(false);
  });

  it("returns true after a settings.auto_merge_enabled_set event with enabled=true", () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });
    expect(getAutoMergeEnabled(db)).toBe(true);
  });

  it("returns false after toggling back to disabled", () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: false },
    });
    expect(getAutoMergeEnabled(db)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAutoMerge — orchestration function
// ---------------------------------------------------------------------------

describe("handleAutoMerge", () => {
  let db: Database.Database;
  const taskId = "T-auto-test";
  const attemptId = "A-auto-test";

  function baseHandle(overrides: Partial<HandleAutoMergeInput> = {}): HandleAutoMergeInput {
    return {
      db,
      task_id: taskId,
      attempt_id: attemptId,
      config: {
        phases: [],
        gates: [],
        retry_policy: {
          max_total_attempts: 2,
          on_typecheck_fail: { strategy: "retry_same", max_attempts: 1 },
          on_test_fail: { strategy: "retry_same", max_attempts: 1 },
          on_audit_reject: "escalate_to_human",
          on_spec_pushback: "pause_and_notify",
        },
        auto_merge_policy: "on_full_pass",
        shadow_mode: false,
      },
      attempt_outcome: "approved",
      auditor_verdict: "approve",
      has_blocking_concerns: false,
      all_required_gates_passed: true,
      current_task_status: "running",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    // Seed a task for the events to reference
    appendAndProject(db, {
      type: "task.created",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: testActor,
      payload: {
        task_id: taskId,
        title: "Auto-merge test task",
        proposition_ids: [],
        config_snapshot: baseHandle().config,
      },
    });
  });

  afterEach(() => { db.close(); });

  it("skips entirely when global kill switch is off (no auto-merge events)", async () => {
    // kill switch defaults to false on fresh DB
    const result = await handleAutoMerge(baseHandle());
    expect(result.action).toBe("skip");
    // No auto-merge events emitted
    expect(getEventsOfType(db, "task.auto_approved")).toHaveLength(0);
    expect(getEventsOfType(db, "task.would_auto_merge")).toHaveLength(0);
  });

  it("skips when policy is off even if kill switch is enabled", async () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });
    const result = await handleAutoMerge(baseHandle({
      config: { ...baseHandle().config, auto_merge_policy: "off" },
    }));
    expect(result.action).toBe("skip");
  });

  it("shadow mode: emits task.would_auto_merge but does not merge", async () => {
    // Enable kill switch
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });

    const result = await handleAutoMerge(baseHandle({
      config: { ...baseHandle().config, shadow_mode: true },
    }));

    expect(result.action).toBe("shadow");
    // Should have emitted the advisory event
    const wouldMerge = getEventsOfType(db, "task.would_auto_merge");
    expect(wouldMerge).toHaveLength(1);
    const payload = JSON.parse(wouldMerge[0]!.payload_json);
    expect(payload.task_id).toBe(taskId);
    expect(payload.matched_conditions).toContain("auditor_verdict=approve");

    // No actual merge events
    expect(getEventsOfType(db, "task.auto_approved")).toHaveLength(0);
    expect(getEventsOfType(db, "task.auto_merged")).toHaveLength(0);
  });

  it("live mode + conditions met: emits task.auto_approved and calls merge", async () => {
    // Enable kill switch
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });

    // Provide a mock merger that returns success
    const mockMerger = vi.fn().mockResolvedValue({
      outcome: "merged" as const,
      merge_commit_sha: "abc123",
    });

    const result = await handleAutoMerge(baseHandle({ merger: mockMerger }));

    expect(result.action).toBe("merged");

    // auto_approved event emitted
    const approved = getEventsOfType(db, "task.auto_approved");
    expect(approved).toHaveLength(1);
    const approvedPayload = JSON.parse(approved[0]!.payload_json);
    expect(approvedPayload.policy).toBe("on_full_pass");

    // Actor should be system
    const approvedActor = JSON.parse(approved[0]!.actor_json);
    expect(approvedActor.kind).toBe("system");
    expect(approvedActor.component).toBe("scheduler");

    // Merger was called
    expect(mockMerger).toHaveBeenCalledWith(db, taskId, attemptId);
  });

  it("live mode + merge fails (conflict): falls back to awaiting_review", async () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });

    // Merger returns conflict
    const mockMerger = vi.fn().mockResolvedValue({
      outcome: "conflicted" as const,
      conflicting_paths: ["src/index.ts"],
    });

    const result = await handleAutoMerge(baseHandle({ merger: mockMerger }));

    // Falls back — caller should set awaiting_review
    expect(result.action).toBe("merge_failed");

    // auto_approved was still emitted (approval happened; merge failed)
    expect(getEventsOfType(db, "task.auto_approved")).toHaveLength(1);
    // But no auto_merged
    expect(getEventsOfType(db, "task.auto_merged")).toHaveLength(0);
  });

  it("live mode + merge throws: falls back to awaiting_review", async () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });

    const mockMerger = vi.fn().mockRejectedValue(new Error("git exploded"));

    const result = await handleAutoMerge(baseHandle({ merger: mockMerger }));
    expect(result.action).toBe("merge_failed");
  });

  it("conditions not met (gate failed): skips auto-merge", async () => {
    appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: testActor,
      payload: { enabled: true },
    });

    const result = await handleAutoMerge(baseHandle({ all_required_gates_passed: false }));
    expect(result.action).toBe("skip");
    expect(getEventsOfType(db, "task.auto_approved")).toHaveLength(0);
  });
});
