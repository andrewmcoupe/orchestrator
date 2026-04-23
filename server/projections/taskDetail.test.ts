import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import type { AppendEventInput } from "../eventStore.js";
import type { Actor, TaskConfig } from "@shared/events.js";
import type { TaskDetailRow } from "@shared/projections.js";
import {
  appendAndProject,
  rebuildProjection,
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

type RawTaskDetailRow = {
  task_id: string;
  prd_id: string | null;
  title: string;
  status: string;
  config_json: string;
  preset_id: string | null;
  preset_override_keys_json: string;
  proposition_ids_json: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  current_attempt_id: string | null;
  last_event_id: string;
  updated_at: string;
};

function readDetail(db: Database.Database, taskId: string): TaskDetailRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_task_detail WHERE task_id = ?")
    .get(taskId) as RawTaskDetailRow | undefined;
  if (!raw) return null;
  return {
    task_id: raw.task_id,
    prd_id: raw.prd_id ?? undefined,
    title: raw.title,
    status: raw.status as TaskDetailRow["status"],
    config: JSON.parse(raw.config_json) as TaskConfig,
    preset_id: raw.preset_id ?? undefined,
    preset_override_keys: JSON.parse(raw.preset_override_keys_json) as string[],
    proposition_ids: JSON.parse(raw.proposition_ids_json) as string[],
    worktree_path: raw.worktree_path ?? undefined,
    worktree_branch: raw.worktree_branch ?? undefined,
    current_attempt_id: raw.current_attempt_id ?? undefined,
    last_event_id: raw.last_event_id,
    updated_at: raw.updated_at,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("TaskDetail projection", () => {
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

  it("creates a row on task.created with full config snapshot", () => {
    appendAndProject(db, taskCreated("T-001", "Build widget"));

    const detail = readDetail(db, "T-001");
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Build widget");
    expect(detail!.status).toBe("queued");
    expect(detail!.config.phases).toHaveLength(2);
    expect(detail!.preset_id).toBe("preset-default");
    expect(detail!.preset_override_keys).toEqual([]);
    expect(detail!.proposition_ids).toEqual(["prop-1", "prop-2"]);
  });

  it("canned replay: drafted → created → config_updated → attempt.started → phase.started → phase.completed → attempt.completed", () => {
    // task.drafted — creates a draft row in task_detail
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
    const draftDetail = readDetail(db, "T-001");
    expect(draftDetail).not.toBeNull();
    expect(draftDetail!.status).toBe("draft");

    // task.created
    appendAndProject(db, taskCreated("T-001", "Build widget"));
    let detail = readDetail(db, "T-001")!;
    expect(detail.status).toBe("queued");
    expect(detail.config.phases[0].model).toBe("sonnet-4-6");

    // task.config_updated — change implementer model
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

    detail = readDetail(db, "T-001")!;
    expect(detail.config.phases[0].model).toBe("opus-4-7");
    expect(detail.preset_override_keys).toContain("phases");

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

    detail = readDetail(db, "T-001")!;
    expect(detail.current_attempt_id).toBe("att-001");

    // phase.started — task_detail doesn't subscribe (via task_list only)
    // but phase.started does NOT subscribe to task_detail per the subscription map.
    // Verify no crash and no change to detail.

    // phase.completed — not subscribed to task_detail
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

    // attempt.completed — not subscribed to task_detail
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

    // Detail should still have current_attempt_id set
    detail = readDetail(db, "T-001")!;
    expect(detail.current_attempt_id).toBe("att-001");
  });

  it("config_updated regenerates preset_override_keys correctly", () => {
    appendAndProject(db, taskCreated("T-001"));

    // Update phases
    appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        config_diff: { phases: minimalConfig.phases },
      },
    });

    let detail = readDetail(db, "T-001")!;
    expect(detail.preset_override_keys).toEqual(["phases"]);

    // Update retry_policy sub-key
    appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        config_diff: {
          retry_policy: {
            ...minimalConfig.retry_policy,
            max_total_attempts: 5,
          },
        },
      },
    });

    detail = readDetail(db, "T-001")!;
    expect(detail.preset_override_keys).toContain("phases");
    expect(detail.preset_override_keys).toContain(
      "retry_policy.on_typecheck_fail",
    );
    expect(detail.preset_override_keys).toContain(
      "retry_policy.max_total_attempts",
    );
  });

  it("archiving keeps the row in task_detail but sets status to archived", () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, {
      type: "task.archived",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001" },
    });

    const detail = readDetail(db, "T-001");
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("archived");
  });

  it("worktree events update path and branch", () => {
    appendAndProject(db, taskCreated("T-001"));

    appendAndProject(db, {
      type: "task.worktree_created",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        path: "/repo/.orchestrator-worktrees/T-001",
        branch: "wt/T-001",
        base_ref: "HEAD",
        base_sha: "a".repeat(40),
      },
    });

    let detail = readDetail(db, "T-001")!;
    expect(detail.worktree_path).toBe(
      "/repo/.orchestrator-worktrees/T-001",
    );
    expect(detail.worktree_branch).toBe("wt/T-001");

    appendAndProject(db, {
      type: "task.worktree_deleted",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        path: "/repo/.orchestrator-worktrees/T-001",
      },
    });

    detail = readDetail(db, "T-001")!;
    expect(detail.worktree_path).toBeUndefined();
    expect(detail.worktree_branch).toBeUndefined();
  });

  it("proposition management: add and remove", () => {
    appendAndProject(db, taskCreated("T-001"));

    appendAndProject(db, {
      type: "task.propositions_added",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001", proposition_ids: ["prop-3"] },
    });

    let detail = readDetail(db, "T-001")!;
    expect(detail.proposition_ids).toEqual(["prop-1", "prop-2", "prop-3"]);

    appendAndProject(db, {
      type: "task.propositions_removed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001", proposition_ids: ["prop-2"] },
    });

    detail = readDetail(db, "T-001")!;
    expect(detail.proposition_ids).toEqual(["prop-1", "prop-3"]);
  });

  it("rebuild produces identical state to the live projection", () => {
    appendAndProject(db, taskCreated("T-001", "One"));
    appendAndProject(db, taskCreated("T-002", "Two"));
    appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: {
        task_id: "T-001",
        config_diff: { gates: [] },
      },
    });

    const before = readDetail(db, "T-001");
    const before2 = readDetail(db, "T-002");

    rebuildProjection(db, "task_detail");

    const after = readDetail(db, "T-001");
    const after2 = readDetail(db, "T-002");

    expect(after!.task_id).toBe(before!.task_id);
    expect(after!.title).toBe(before!.title);
    expect(after!.config.gates).toEqual(before!.config.gates);
    expect(after!.preset_override_keys).toEqual(before!.preset_override_keys);

    expect(after2!.task_id).toBe(before2!.task_id);
    expect(after2!.title).toBe(before2!.title);
  });

  it("deferred sets status to blocked", () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, {
      type: "task.deferred",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor: testActor,
      payload: { task_id: "T-001", reason: "Waiting on dependency" },
    });

    const detail = readDetail(db, "T-001")!;
    expect(detail.status).toBe("blocked");
  });
});
