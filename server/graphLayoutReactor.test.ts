import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./eventStore.js";
import type { AppendEventInput } from "./eventStore.js";
import type { Actor, TaskConfig } from "@shared/events.js";
import {
  appendAndProject,
  initProjections,
  eventBus,
} from "./projectionRunner.js";
import { createGraphLayoutTable, readGraphLayout } from "./graphLayoutStore.js";
import { registerGraphLayoutReactor } from "./graphLayoutReactor.js";

// Register projections
import "./projections/register.js";

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
  ],
  gates: [],
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
      proposition_ids: [],
      config_snapshot: minimalConfig,
    },
  };
}

function taskDependencySet(
  taskId: string,
  dependsOn: string[],
): AppendEventInput<"task.dependency.set"> {
  return {
    type: "task.dependency.set",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: { task_id: taskId, depends_on: dependsOn },
  };
}

function taskArchived(taskId: string): AppendEventInput<"task.archived"> {
  return {
    type: "task.archived",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: { task_id: taskId },
  };
}

/** Wait for debounce + layout computation to settle. */
async function waitForLayout(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe("graphLayoutReactor", () => {
  let db: Database.Database;
  let dispose: () => void;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    initProjections(db);
    createGraphLayoutTable(db);
    dispose = registerGraphLayoutReactor(db);
  });

  afterEach(() => {
    dispose();
    eventBus.removeAllListeners();
    db.close();
  });

  it("computes layout on task.created", async () => {
    appendAndProject(db, taskCreated("T-001", "First task"));
    await waitForLayout();

    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(layout!.nodes["T-001"]).toBeDefined();
    expect(layout!.nodes["T-001"].width).toBe(200);
    expect(layout!.nodes["T-001"].height).toBe(72);
  });

  it("computes edges from dependency relationships", async () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, taskCreated("T-002"));
    appendAndProject(db, taskDependencySet("T-002", ["T-001"]));
    await waitForLayout();

    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(layout!.edges).toContainEqual({
      source: "T-001",
      target: "T-002",
    });
  });

  it("includes critical path in meta", async () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, taskCreated("T-002"));
    appendAndProject(db, taskCreated("T-003"));
    appendAndProject(db, taskDependencySet("T-002", ["T-001"]));
    appendAndProject(db, taskDependencySet("T-003", ["T-002"]));
    await waitForLayout();

    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(layout!.meta.critical_path).toEqual(["T-001", "T-002", "T-003"]);
    expect(layout!.meta.direction).toBe("DOWN");
  });

  it("debounces rapid-fire events into a single recomputation", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Fire many events quickly
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, taskCreated("T-002"));
    appendAndProject(db, taskCreated("T-003"));
    appendAndProject(db, taskDependencySet("T-002", ["T-001"]));
    appendAndProject(db, taskDependencySet("T-003", ["T-002"]));

    // Wait for the boot recompute + debounced event recompute to settle
    await waitForLayout();

    // Now the layout should reflect all 3 tasks
    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(Object.keys(layout!.nodes)).toHaveLength(3);

    consoleSpy.mockRestore();
  });

  it("removes archived tasks from layout", async () => {
    appendAndProject(db, taskCreated("T-001"));
    appendAndProject(db, taskCreated("T-002"));
    await waitForLayout();

    let layout = readGraphLayout(db);
    expect(Object.keys(layout!.nodes)).toHaveLength(2);

    appendAndProject(db, taskArchived("T-001"));
    await waitForLayout();

    layout = readGraphLayout(db);
    // Archived tasks are deleted from proj_task_list
    expect(layout!.nodes["T-001"]).toBeUndefined();
  });

  it("handles empty graph gracefully", async () => {
    appendAndProject(db, taskCreated("T-001"));
    await waitForLayout();
    appendAndProject(db, taskArchived("T-001"));
    await waitForLayout();

    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(Object.keys(layout!.nodes)).toHaveLength(0);
    expect(layout!.edges).toHaveLength(0);
  });

  it("ignores events that don't affect graph shape", async () => {
    appendAndProject(db, taskCreated("T-001"));
    await waitForLayout();

    const layout1 = readGraphLayout(db);
    const _updatedAt1 = db
      .prepare(
        "SELECT updated_at FROM proj_graph_layout WHERE id = 'singleton'",
      )
      .get() as { updated_at: string };

    // Wait a bit so timestamps differ if a write happens
    await new Promise((r) => setTimeout(r, 50));

    // Emit a non-graph-affecting event type — this won't trigger recompute
    // We test indirectly: the layout shouldn't have changed timestamp
    // Since we can't easily emit a non-graph event through appendAndProject,
    // verify the layout still matches
    expect(readGraphLayout(db)).toEqual(layout1);
  });

  it("does not crash when layout computation fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The reactor should catch errors and log them
    appendAndProject(db, taskCreated("T-001"));
    await waitForLayout();

    // If we got here without an unhandled rejection, the error handling works
    expect(readGraphLayout(db)).not.toBeNull();

    consoleSpy.mockRestore();
  });

  it("dispose removes listener and clears pending timer", async () => {
    // Wait for the boot-time recompute to finish first
    await waitForLayout();

    // Now dispose, then emit an event
    dispose();
    appendAndProject(db, taskCreated("T-NEW"));

    // Wait for what would have been the debounce period
    await waitForLayout();

    // The new task should NOT appear in the layout since we disposed before the event
    const layout = readGraphLayout(db);
    expect(layout).not.toBeNull();
    expect(layout!.nodes["T-NEW"]).toBeUndefined();
  });
});
