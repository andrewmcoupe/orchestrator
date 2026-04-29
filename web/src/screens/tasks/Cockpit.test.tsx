// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { TaskListSidebar } from "./TaskListSidebar.js";
import { TaskDetailPane } from "./TaskDetailPane.js";
import type { TaskListRow, TaskDetailRow } from "@shared/projections.js";
import type { TaskConfig } from "@shared/events.js";

afterEach(cleanup);

/** Wrap component in a fresh QueryClientProvider and RouterProvider per test. */
async function withQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

// ============================================================================
// Fixtures
// ============================================================================

const baseConfig: TaskConfig = {
  phases: [
    {
      name: "test-author",
      enabled: true,
      transport: "claude-code",
      model: "opus-4.7",
      prompt_version_id: "pv-001",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 5,
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
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4.6",
      prompt_version_id: "pv-002",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 10,
        max_budget_usd: 2,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 3,
        include_tests: false,
        include_similar_patterns: true,
        token_budget: 16000,
      },
    },
    {
      name: "auditor",
      enabled: true,
      transport: "anthropic-api",
      model: "opus-4.7",
      prompt_version_id: "pv-003",
      transport_options: { kind: "api", max_tokens: 4096 },
      context_policy: {
        symbol_graph_depth: 1,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 12000,
      },
    },
  ],
  gates: [
    {
      name: "tsc",
      command: "pnpm tsc --noEmit",
      required: true,
      timeout_seconds: 60,
      on_fail: "retry",
    },
    {
      name: "eslint",
      command: "pnpm eslint .",
      required: true,
      timeout_seconds: 60,
      on_fail: "retry",
    },
    {
      name: "jest",
      command: "pnpm test",
      required: true,
      timeout_seconds: 120,
      on_fail: "retry_with_context",
    },
    {
      name: "integration",
      command: "pnpm test:integration",
      required: false,
      timeout_seconds: 300,
      on_fail: "skip",
    },
  ],
  retry_policy: {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_with_more_context", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

function makeListRow(overrides: Partial<TaskListRow> = {}): TaskListRow {
  return {
    task_id: "T-003",
    title: "Rate limit /api/messages",
    status: "running",
    attempt_count: 1,
    pushback_count: 0,
    phase_models: {
      "test-author": "opus-4.7",
      implementer: "sonnet-4.6",
      auditor: "opus-4.7",
    },
    last_event_ts: "2026-04-21T14:23:47.000Z",
    updated_at: "2026-04-21T14:23:47.000Z",
    current_phase: "implementer",
    ...overrides,
  };
}

function makeDetailRow(overrides: Partial<TaskDetailRow> = {}): TaskDetailRow {
  return {
    task_id: "T-003",
    title: "Rate limit /api/messages",
    status: "running",
    config: baseConfig,
    preset_override_keys: [],
    proposition_ids: ["P-001"],
    current_attempt_id: "ATT-001",
    worktree_branch: "wt/t-003",
    last_event_id: "evt-100",
    updated_at: "2026-04-21T14:23:47.000Z",
    ...overrides,
  };
}

// ============================================================================
// TaskListSidebar tests
// ============================================================================

describe("TaskListSidebar", () => {
  const tasks: TaskListRow[] = [
    makeListRow({
      task_id: "T-003",
      title: "Rate limit /api/messages",
      status: "running",
      prd_id: "PRD-001",
    }),
    makeListRow({
      task_id: "T-004",
      title: "Fix worker queue race",
      status: "awaiting_review",
      prd_id: "PRD-001",
    }),
    makeListRow({
      task_id: "T-005",
      title: "Paginate admin dashboard",
      status: "paused",
      pushback_count: 1,
    }),
    makeListRow({
      task_id: "T-002",
      title: "Extract auth middleware",
      status: "merged",
    }),
    makeListRow({
      task_id: "T-006",
      title: "Migrate sessions to Redis",
      status: "queued",
    }),
  ];

  it("renders all task IDs", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.getByText("T-004")).toBeDefined();
    expect(screen.getByText("T-005")).toBeDefined();
    expect(screen.getByText("T-002")).toBeDefined();
    expect(screen.getByText("T-006")).toBeDefined();
  });

  it("renders task titles", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.getByText("Rate limit /api/messages")).toBeDefined();
    expect(screen.getByText("Fix worker queue race")).toBeDefined();
    expect(screen.getByText("Paginate admin dashboard")).toBeDefined();
    expect(screen.getByText("Extract auth middleware")).toBeDefined();
    expect(screen.getByText("Migrate sessions to Redis")).toBeDefined();
  });

  it("shows auditor flagged status for awaiting_review", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.getByText("auditor flagged")).toBeDefined();
  });

  it("shows spec pushback annotation for tasks with pushbacks", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.getByText("paused · spec pushback")).toBeDefined();
  });

  it("highlights selected task with border", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId="T-003" />);
    const link = screen.getByText("Rate limit /api/messages").closest("a");
    expect(link?.className).toContain("border-l-status-warning");
  });

  it("renders task items as Link elements", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    const link = screen.getByText("Rate limit /api/messages").closest("a");
    expect(link).toBeDefined();
  });

  it("filters tasks by search query", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    fireEvent.change(screen.getByPlaceholderText("search tasks"), {
      target: { value: "rate limit" },
    });
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.queryByText("T-004")).toBeNull();
  });

  it("shows empty state when no results", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    fireEvent.change(screen.getByPlaceholderText("search tasks"), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No tasks match your search.")).toBeDefined();
  });

  it("groups tasks by PRD", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.getByText("PRD-001")).toBeDefined();
    expect(screen.getByText("Standalone Tasks")).toBeDefined();
  });

  // ── Priority 41 affordances ──────────────────────────────────────────────

  it("shows 'ready to merge → main' for approved tasks when currentBranch provided", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar
        tasks={[approvedTask]}
        selectedId={null}
        currentBranch="main"
      />,
    );
    expect(screen.getByText("ready to merge → main")).toBeDefined();
  });

  it("shows 'ready to merge → main' as fallback when no branch provided", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar tasks={[approvedTask]} selectedId={null} />,
    );
    expect(screen.getByText("ready to merge → main")).toBeDefined();
  });

  it("renders merge icon button for approved task with current_attempt_id", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar tasks={[approvedTask]} selectedId={null} />,
    );
    expect(screen.getByLabelText("Open merge review")).toBeDefined();
  });

  it("renders merge icon as a Link element", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar tasks={[approvedTask]} selectedId={null} />,
    );
    const mergeLink = screen.getByLabelText("Open merge review");
    expect(mergeLink.tagName).toBe("A");
  });

  it("shows 'N ready to merge' counter when approved tasks exist", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar tasks={[approvedTask, ...tasks]} selectedId={null} />,
    );
    expect(screen.getByText("1 ready to merge")).toBeDefined();
  });

  it("does not show counter when no approved tasks exist", async () => {
    await withQuery(<TaskListSidebar tasks={tasks} selectedId={null} />);
    expect(screen.queryByText(/ready to merge/)).toBeNull();
  });

  it("filters tasks by statusFilter prop", async () => {
    const approvedTask = makeListRow({
      task_id: "T-007",
      title: "Ready task",
      status: "approved",
      current_attempt_id: "ATT-007",
    });
    await withQuery(
      <TaskListSidebar
        tasks={[...tasks, approvedTask]}
        selectedId={null}
        statusFilter="done"
      />,
    );
    // "done" filter includes approved/awaiting_merge/merged
    expect(screen.getByText("T-007")).toBeDefined();
    expect(screen.getByText("T-002")).toBeDefined(); // merged
    expect(screen.queryByText("T-003")).toBeNull(); // running
  });

  it("shows 'auto' badge on auto-merged tasks", async () => {
    const autoMergedTask = makeListRow({
      task_id: "T-010",
      title: "Auto merged feature",
      status: "merged",
      auto_merged: true,
    });
    await withQuery(
      <TaskListSidebar tasks={[autoMergedTask]} selectedId={null} />,
    );
    expect(screen.getByText("auto")).toBeDefined();
  });

  it("does not show 'auto' badge on manually merged tasks", async () => {
    const manualMergedTask = makeListRow({
      task_id: "T-011",
      title: "Manual merged feature",
      status: "merged",
      auto_merged: false,
    });
    await withQuery(
      <TaskListSidebar tasks={[manualMergedTask]} selectedId={null} />,
    );
    expect(screen.queryByText("auto")).toBeNull();
  });

  // ── Dependency indicators ──────────────────────────────────────────────

  it("shows lock icon and greyed-out styling on blocked tasks", async () => {
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "queued",
      blocked: true,
      depends_on: ["T-019"],
    });
    await withQuery(
      <TaskListSidebar tasks={[blockedTask]} selectedId={null} />,
    );
    expect(screen.getByLabelText("Blocked")).toBeDefined();
    const link = screen.getByText("Blocked feature").closest("a");
    expect(link?.className).toContain("opacity-50");
  });

  it("shows 'Blocked by T-XXXXX' badge with dependency IDs", async () => {
    const dep1 = makeListRow({
      task_id: "T-019",
      title: "Dep one",
      status: "running",
    });
    const dep2 = makeListRow({
      task_id: "T-018",
      title: "Dep two",
      status: "queued",
    });
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "queued",
      blocked: true,
      depends_on: ["T-019", "T-018"],
    });
    await withQuery(
      <TaskListSidebar tasks={[dep1, dep2, blockedTask]} selectedId={null} />,
    );
    expect(screen.getByText("Blocked by T-019, T-018")).toBeDefined();
  });

  it("shows warning indicator when a dependency is in failed/cancelled state", async () => {
    const rejectedDep = makeListRow({
      task_id: "T-019",
      title: "Rejected dep",
      status: "rejected",
    });
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "queued",
      blocked: true,
      depends_on: ["T-019"],
    });
    await withQuery(
      <TaskListSidebar tasks={[rejectedDep, blockedTask]} selectedId={null} />,
    );
    expect(screen.getByLabelText("Dependency failed")).toBeDefined();
  });

  it("renders unblocked tasks normally with no dependency indicators", async () => {
    const normalTask = makeListRow({
      task_id: "T-021",
      title: "Normal task",
      status: "running",
      blocked: false,
      depends_on: ["T-019"],
    });
    await withQuery(<TaskListSidebar tasks={[normalTask]} selectedId={null} />);
    expect(screen.queryByLabelText("Blocked")).toBeNull();
    expect(screen.queryByText(/Blocked by/)).toBeNull();
  });
});

// ============================================================================
// Dependency editing — TaskDetailPane
// ============================================================================

describe("TaskDetailPane — dependency editing", () => {
  it("shows dependency picker on draft tasks", async () => {
    const allTasks = [
      makeListRow({ task_id: "T-010", title: "Dep A", status: "queued" }),
      makeListRow({ task_id: "T-011", title: "Dep B", status: "queued" }),
    ];
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ task_id: "T-010", status: "draft" })}
        listRow={makeListRow({ task_id: "T-010", status: "draft" })}
        allTasks={allTasks}
      />,
    );
    expect(screen.getByText("Dependencies")).toBeDefined();
    expect(screen.getByLabelText("Add dependency")).toBeDefined();
  });

  it("hides dependency picker on running tasks", async () => {
    const allTasks = [
      makeListRow({
        task_id: "T-010",
        title: "Running task",
        status: "running",
      }),
    ];
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ task_id: "T-010", status: "running" })}
        listRow={makeListRow({ task_id: "T-010", status: "running" })}
        allTasks={allTasks}
      />,
    );
    // Section heading should still show if there are deps, but no add button
    expect(screen.queryByLabelText("Add dependency")).toBeNull();
  });

  it("prevents adding a dependency that would create a cycle", async () => {
    const allTasks = [
      makeListRow({
        task_id: "T-A",
        title: "Task A",
        status: "draft",
        depends_on: [],
      }),
      makeListRow({
        task_id: "T-B",
        title: "Task B",
        status: "draft",
        depends_on: ["T-A"],
      }),
    ];
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ task_id: "T-A", status: "draft" })}
        listRow={makeListRow({
          task_id: "T-A",
          status: "draft",
          depends_on: [],
        })}
        allTasks={allTasks}
      />,
    );
    // T-B depends on T-A, so T-A cannot depend on T-B
    const addBtn = screen.getByLabelText("Add dependency");
    fireEvent.click(addBtn);
    // T-B should not appear as an option (it would create a cycle)
    expect(screen.queryByText("Task B")).toBeNull();
  });

  it("removes a dependency when clicking the remove button", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const allTasks = [
      makeListRow({
        task_id: "T-010",
        title: "Main task",
        status: "draft",
        depends_on: ["T-011"],
      }),
      makeListRow({ task_id: "T-011", title: "Dep task", status: "queued" }),
    ];
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ task_id: "T-010", status: "draft" })}
        listRow={makeListRow({
          task_id: "T-010",
          status: "draft",
          depends_on: ["T-011"],
        })}
        allTasks={allTasks}
      />,
    );
    // Should show the dependency
    expect(screen.getByText("T-011")).toBeDefined();
    // Click remove
    const removeBtn = screen.getByLabelText("Remove dependency T-011");
    fireEvent.click(removeBtn);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/commands/task/T-010/dependencies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ depends_on: [] }),
      }),
    );
    fetchSpy.mockRestore();
  });

  it("emits task.dependency.set when adding a dependency", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const allTasks = [
      makeListRow({
        task_id: "T-010",
        title: "Main task",
        status: "draft",
        depends_on: [],
      }),
      makeListRow({
        task_id: "T-011",
        title: "Dep task",
        status: "queued",
        depends_on: [],
      }),
    ];
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ task_id: "T-010", status: "draft" })}
        listRow={makeListRow({
          task_id: "T-010",
          status: "draft",
          depends_on: [],
        })}
        allTasks={allTasks}
      />,
    );
    // Open picker and select a task
    fireEvent.click(screen.getByLabelText("Add dependency"));
    fireEvent.click(screen.getByText("Dep task"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/commands/task/T-010/dependencies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ depends_on: ["T-011"] }),
      }),
    );
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// TaskDetailPane tests
// ============================================================================

describe("TaskDetailPane", () => {
  it("renders task ID and title", async () => {
    await withQuery(
      <TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />,
    );
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.getByText("Rate limit /api/messages")).toBeDefined();
  });

  it("renders status pill", async () => {
    await withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("running")).toBeDefined();
  });

  it("renders worktree branch", async () => {
    await withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("worktree: wt/t-003")).toBeDefined();
  });

  it("renders all three phase boxes", async () => {
    await withQuery(
      <TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />,
    );
    expect(screen.getByText("test-author")).toBeDefined();
    expect(screen.getByText("implementer")).toBeDefined();
    expect(screen.getByText("auditor")).toBeDefined();
  });

  it("renders all gate pills", async () => {
    await withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("tsc")).toBeDefined();
    expect(screen.getByText("eslint")).toBeDefined();
    expect(screen.getByText("jest")).toBeDefined();
    expect(screen.getByText("integration")).toBeDefined();
  });

  it("shows Pause/Retry/Kill for running status", async () => {
    await withQuery(
      <TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />,
    );
    expect(screen.getByText("Pause")).toBeDefined();
    expect(screen.getByText("Retry")).toBeDefined();
    expect(screen.getByText("Kill")).toBeDefined();
  });

  it("shows Approve/Reject for awaiting_review", async () => {
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ status: "awaiting_review" })}
        listRow={makeListRow({ status: "awaiting_review" })}
      />,
    );
    expect(screen.getByText("Approve")).toBeDefined();
    expect(screen.getByText("Reject")).toBeDefined();
  });

  it("POSTs to command endpoint on action click", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await withQuery(
      <TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />,
    );

    fireEvent.click(screen.getByText("Pause"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/commands/task/T-003/pause",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("renders proposition IDs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { proposition_id: "P-001", text: "First proposition" },
          { proposition_id: "P-002", text: "Second proposition" },
        ]),
      ),
    );
    await withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ proposition_ids: ["P-001", "P-002"] })}
      />,
    );
    expect(await screen.findByText("First proposition")).toBeDefined();
    expect(screen.getByText("Second proposition")).toBeDefined();
    fetchSpy.mockRestore();
  });

  it("hides proposition section when empty", async () => {
    const { container } = await withQuery(
      <TaskDetailPane detail={makeDetailRow({ proposition_ids: [] })} />,
    );
    // No "Proposition" heading when there are no proposition IDs
    const headings = container.querySelectorAll("h3");
    const texts = Array.from(headings).map((h) => h.textContent);
    expect(texts).not.toContain("Proposition");
  });
});
