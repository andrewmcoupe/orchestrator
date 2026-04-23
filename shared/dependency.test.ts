import { describe, it, expect } from "vitest";
import {
  topoSort,
  canAddDependency,
  resolveBlockedStatus,
} from "./dependency.js";
import { reduceTaskList, type TaskListRow } from "./projections.js";
import type { AnyEvent, EventEnvelope, TaskConfig, TaskStatus } from "./events.js";

// ============================================================================
// Helpers
// ============================================================================

function makeEvent<T extends AnyEvent["type"]>(
  type: T,
  payload: Extract<AnyEvent, { type: T }>["payload"],
  overrides: Partial<EventEnvelope> = {},
): Extract<AnyEvent, { type: T }> {
  return {
    id: overrides.id ?? "evt-001",
    type,
    aggregate_type: "task" as const,
    aggregate_id: overrides.aggregate_id ?? "task-1",
    version: 1,
    ts: overrides.ts ?? "2026-04-23T10:00:00.000Z",
    actor: { kind: "user" as const, user_id: "local" },
    payload,
  } as Extract<AnyEvent, { type: T }>;
}

const testConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-001",
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

function makeTaskRow(
  taskId: string,
  overrides: Partial<TaskListRow> = {},
): TaskListRow {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    status: "queued",
    attempt_count: 0,
    pushback_count: 0,
    phase_models: { implementer: "sonnet-4-6" },
    last_event_ts: "2026-04-23T10:00:00.000Z",
    updated_at: "2026-04-23T10:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// topoSort — cycle detection and edge stripping
// ============================================================================

describe("topoSort", () => {
  it("returns valid topological order for a DAG", () => {
    const result = topoSort([
      { id: "A", depends_on: [] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["A", "B"] },
    ]);

    expect(result.stripped).toEqual([]);
    // A must come before B, B must come before C
    const idxA = result.sorted.indexOf("A");
    const idxB = result.sorted.indexOf("B");
    const idxC = result.sorted.indexOf("C");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it("detects circular dependencies and strips offending edges", () => {
    const result = topoSort([
      { id: "A", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] },
    ]);

    // At least one edge must be stripped to break the cycle
    expect(result.stripped.length).toBeGreaterThanOrEqual(1);
    // All tasks should still appear in the sorted output
    expect(result.sorted).toHaveLength(2);
    expect(result.sorted).toContain("A");
    expect(result.sorted).toContain("B");
  });

  it("strips only the minimum edges for a 3-node cycle", () => {
    const result = topoSort([
      { id: "A", depends_on: ["C"] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["B"] },
    ]);

    // One edge stripped breaks a 3-cycle
    expect(result.stripped).toHaveLength(1);
    expect(result.sorted).toHaveLength(3);
  });

  it("passes through a graph with no dependencies unchanged", () => {
    const result = topoSort([
      { id: "A", depends_on: [] },
      { id: "B", depends_on: [] },
    ]);

    expect(result.stripped).toEqual([]);
    expect(result.sorted).toHaveLength(2);
  });

  it("handles self-referential dependency", () => {
    const result = topoSort([{ id: "A", depends_on: ["A"] }]);

    expect(result.stripped).toEqual([{ from: "A", to: "A" }]);
    expect(result.sorted).toEqual(["A"]);
  });
});

// ============================================================================
// canAddDependency — status validation
// ============================================================================

describe("canAddDependency", () => {
  it("allows adding dependencies to draft tasks", () => {
    expect(canAddDependency("draft")).toBe(true);
  });

  it("allows adding dependencies to queued tasks", () => {
    expect(canAddDependency("queued")).toBe(true);
  });

  it("allows adding dependencies to blocked tasks", () => {
    expect(canAddDependency("blocked")).toBe(true);
  });

  it("rejects adding dependencies to in_progress (running) tasks", () => {
    expect(canAddDependency("running")).toBe(false);
  });

  it("rejects adding dependencies to tasks beyond in_progress", () => {
    const beyondStatuses: TaskStatus[] = [
      "paused",
      "awaiting_review",
      "revising",
      "approved",
      "awaiting_merge",
      "merged",
      "rejected",
      "archived",
    ];
    for (const status of beyondStatuses) {
      expect(canAddDependency(status)).toBe(false);
    }
  });
});

// ============================================================================
// resolveBlockedStatus — dependency status resolution
// ============================================================================

describe("resolveBlockedStatus", () => {
  it("returns blocked: false when task has no dependencies", () => {
    const result = resolveBlockedStatus([], new Map());
    expect(result.blocked).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("returns blocked: true when dependency is not yet merged", () => {
    const statuses = new Map<string, TaskStatus>([["dep-1", "queued"]]);
    const result = resolveBlockedStatus(["dep-1"], statuses);
    expect(result.blocked).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns blocked: false when all dependencies are merged", () => {
    const statuses = new Map<string, TaskStatus>([
      ["dep-1", "merged"],
      ["dep-2", "merged"],
    ]);
    const result = resolveBlockedStatus(["dep-1", "dep-2"], statuses);
    expect(result.blocked).toBe(false);
  });

  it("returns blocked: true when one of multiple dependencies is not merged", () => {
    const statuses = new Map<string, TaskStatus>([
      ["dep-1", "merged"],
      ["dep-2", "running"],
    ]);
    const result = resolveBlockedStatus(["dep-1", "dep-2"], statuses);
    expect(result.blocked).toBe(true);
  });

  it("returns blocked: true with warning when dependency is rejected", () => {
    const statuses = new Map<string, TaskStatus>([["dep-1", "rejected"]]);
    const result = resolveBlockedStatus(["dep-1"], statuses);
    expect(result.blocked).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("dep-1");
  });

  it("returns blocked: true with warning when dependency is archived", () => {
    const statuses = new Map<string, TaskStatus>([["dep-1", "archived"]]);
    const result = resolveBlockedStatus(["dep-1"], statuses);
    expect(result.blocked).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("dep-1");
  });
});

// ============================================================================
// reduceTaskList — dependency event handling
// ============================================================================

describe("reduceTaskList — dependency events", () => {
  it("task.dependency.set adds depends_on and sets blocked: true", () => {
    const row = makeTaskRow("task-1");
    const event = makeEvent("task.dependency.set", {
      task_id: "task-1",
      depends_on: ["task-2", "task-3"],
    });

    const result = reduceTaskList(row, event);
    expect(result).not.toBeNull();
    expect(result!.depends_on).toEqual(["task-2", "task-3"]);
    expect(result!.blocked).toBe(true);
  });

  it("task.dependency.set with empty depends_on clears blocked", () => {
    const row = makeTaskRow("task-1", {
      depends_on: ["task-2"],
      blocked: true,
    });
    const event = makeEvent("task.dependency.set", {
      task_id: "task-1",
      depends_on: [],
    });

    const result = reduceTaskList(row, event);
    expect(result).not.toBeNull();
    expect(result!.depends_on).toEqual([]);
    expect(result!.blocked).toBe(false);
  });

  it("task.unblocked sets blocked to false and status to queued", () => {
    const row = makeTaskRow("task-1", {
      status: "blocked",
      blocked: true,
      depends_on: ["task-2"],
    });
    const event = makeEvent("task.unblocked", {
      task_id: "task-1",
    });

    const result = reduceTaskList(row, event);
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(false);
    expect(result!.status).toBe("queued");
  });
});
