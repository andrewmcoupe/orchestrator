import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import type { AppendEventInput } from "../eventStore.js";
import type { Actor, TaskConfig } from "@shared/events.js";
import type { TaskListRow } from "@shared/projections.js";
import {
  appendAndProject,
  rebuildProjection,
  getRegisteredProjections,
  initProjections,
  eventBus,
} from "../projectionRunner.js";

// Register projections
import "./register.js";

// ============================================================================
// Fixtures
// ============================================================================

const testActor: Actor = { kind: "user", user_id: "test-user" };

const minimalConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-1",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 10,
        max_budget_usd: 1,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 2,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 8000,
      },
    },
    {
      name: "auditor",
      enabled: true,
      transport: "anthropic-api",
      model: "opus-4-7",
      prompt_version_id: "pv-2",
      transport_options: { kind: "api", max_tokens: 4096 },
      context_policy: {
        symbol_graph_depth: 1,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 4000,
      },
    },
  ],
  gates: [
    {
      name: "tsc",
      command: "pnpm typecheck",
      required: true,
      timeout_seconds: 60,
      on_fail: "retry",
    },
  ],
  retry_policy: {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

function taskCreated(
  taskId: string,
  title = "Test task",
): AppendEventInput<"task.created"> {
  return {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: {
      task_id: taskId,
      title,
      proposition_ids: ["prop-1", "prop-2"],
      config_snapshot: minimalConfig,
      preset_id: "preset-default",
    },
  };
}

type RawTaskListRow = Omit<TaskListRow, "phase_models"> & {
  phase_models_json: string | null;
};

// ============================================================================
// Tests
// ============================================================================

describe("TaskList projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    initProjections(db);
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
  });

  it("creates a row on task.created with correct initial state", () => {
    appendAndProject(db, taskCreated("T-001", "Build widget"));

    const row = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;

    expect(row).toBeDefined();
    expect(row.title).toBe("Build widget");
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(0);
    expect(row.pushback_count).toBe(0);
    const models = JSON.parse(row.phase_models_json!);
    expect(models).toEqual({ implementer: "sonnet-4-6", auditor: "opus-4-7" });
  });

  it("canned replay: drafted → created → config_updated → attempt.started → phase.started → phase.completed → attempt.completed", () => {
    // task.drafted — creates a draft row in task_list
    appendAndProject(db, {
      type: "task.drafted",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        title: "Draft task",
        proposition_ids: ["prop-1"],
        proposed_by: "agent",
      },
    });

    // Should appear in task_list with status=draft
    let rows = db.prepare("SELECT * FROM proj_task_list").all() as Array<{status: string}>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");

    // task.created
    appendAndProject(db, taskCreated("T-001", "Build widget"));

    let raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.status).toBe("queued");

    // task.config_updated — change phases
    const updatedPhases = [
      { ...minimalConfig.phases[0], model: "opus-4-7" },
      minimalConfig.phases[1],
    ];
    appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        config_diff: { phases: updatedPhases },
      },
    });

    raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    const models = JSON.parse(raw.phase_models_json!);
    expect(models.implementer).toBe("opus-4-7");

    // attempt.started
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: "att-001",
      actor: testActor,
      correlation_id: "att-001",
      payload: {
        attempt_id: "att-001",
        task_id: "T-001",
        attempt_number: 1,
        config_snapshot: minimalConfig,
        triggered_by: "user_start",
      },
    });

    raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.status).toBe("running");
    expect(raw.current_attempt_id).toBe("att-001");
    expect(raw.attempt_count).toBe(1);

    // phase.started
    appendAndProject(db, {
      type: "phase.started",
      aggregate_type: "attempt",
      aggregate_id: "att-001",
      actor: testActor,
      correlation_id: "att-001",
      payload: {
        attempt_id: "att-001",
        phase_name: "implementer",
        transport: "claude-code",
        model: "opus-4-7",
        prompt_version_id: "pv-1",
      },
    });

    raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.current_phase).toBe("implementer");

    // phase.completed — task_list doesn't subscribe, but let's ensure no crash
    appendAndProject(db, {
      type: "phase.completed",
      aggregate_type: "attempt",
      aggregate_id: "att-001",
      actor: testActor,
      correlation_id: "att-001",
      payload: {
        attempt_id: "att-001",
        phase_name: "implementer",
        outcome: "success",
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.05,
        duration_ms: 30000,
      },
    });

    // attempt.completed
    appendAndProject(db, {
      type: "attempt.completed",
      aggregate_type: "attempt",
      aggregate_id: "att-001",
      actor: testActor,
      correlation_id: "att-001",
      payload: {
        attempt_id: "att-001",
        outcome: "approved",
        tokens_in_total: 1000,
        tokens_out_total: 500,
        cost_usd_total: 0.05,
        duration_ms: 30000,
      },
    });

    // Final state — attempt.completed subscribes to task_list but the
    // reducer's default branch returns current unchanged (no status change).
    raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.status).toBe("running");
    expect(raw.attempt_count).toBe(1);
    expect(raw.current_phase).toBe("implementer");
  });

  it("archiving removes the row from task_list", () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, {
      type: "task.archived",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001" },
    });

    const row = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001");
    expect(row).toBeUndefined();
  });

  it("rebuild produces identical state to the live projection", () => {
    appendAndProject(db, taskCreated("T-001", "One"));
    appendAndProject(db, taskCreated("T-002", "Two"));
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001", from: "queued", to: "running" },
    });

    const before = db
      .prepare("SELECT * FROM proj_task_list ORDER BY task_id")
      .all() as RawTaskListRow[];

    rebuildProjection(db, "task_list");

    const after = db
      .prepare("SELECT * FROM proj_task_list ORDER BY task_id")
      .all() as RawTaskListRow[];

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].task_id).toBe(before[i].task_id);
      expect(after[i].title).toBe(before[i].title);
      expect(after[i].status).toBe(before[i].status);
      expect(after[i].attempt_count).toBe(before[i].attempt_count);
      expect(after[i].phase_models_json).toBe(before[i].phase_models_json);
    }
  });

  it("pushback events increment and decrement the count", () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, {
      type: "pushback.raised",
      aggregate_type: "pushback",
      aggregate_id: "pb-1",
      actor: testActor,
      payload: {
        pushback_id: "pb-1",
        proposition_id: "prop-1",
        kind: "blocking",
        rationale: "Ambiguous requirement",
        suggested_resolutions: ["Clarify scope"],
        raised_by: { phase: "implementer", model: "sonnet-4-6" },
      },
    });

    let raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.pushback_count).toBe(1);

    appendAndProject(db, {
      type: "pushback.resolved",
      aggregate_type: "pushback",
      aggregate_id: "pb-1",
      actor: testActor,
      payload: {
        pushback_id: "pb-1",
        resolution: "amended",
        resolution_text: "Clarified",
      },
    });

    raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as RawTaskListRow;
    expect(raw.pushback_count).toBe(0);
  });
});
