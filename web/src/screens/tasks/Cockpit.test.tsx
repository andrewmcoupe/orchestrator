// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskListSidebar } from "./TaskListSidebar.js";
import { TaskDetailPane } from "./TaskDetailPane.js";
import type { TaskListRow, TaskDetailRow } from "@shared/projections.js";
import type { TaskConfig } from "@shared/events.js";

afterEach(cleanup);

/** Wrap component in a fresh QueryClientProvider per test. */
function withQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
      transport_options: { kind: "cli", bare: true, max_turns: 5, max_budget_usd: 1, permission_mode: "acceptEdits" },
      context_policy: { symbol_graph_depth: 2, include_tests: true, include_similar_patterns: false, token_budget: 8000 },
    },
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4.6",
      prompt_version_id: "pv-002",
      transport_options: { kind: "cli", bare: true, max_turns: 10, max_budget_usd: 2, permission_mode: "acceptEdits" },
      context_policy: { symbol_graph_depth: 3, include_tests: false, include_similar_patterns: true, token_budget: 16000 },
    },
    {
      name: "auditor",
      enabled: true,
      transport: "anthropic-api",
      model: "opus-4.7",
      prompt_version_id: "pv-003",
      transport_options: { kind: "api", max_tokens: 4096 },
      context_policy: { symbol_graph_depth: 1, include_tests: true, include_similar_patterns: false, token_budget: 12000 },
    },
  ],
  gates: [
    { name: "tsc", command: "pnpm tsc --noEmit", required: true, timeout_seconds: 60, on_fail: "retry" },
    { name: "eslint", command: "pnpm eslint .", required: true, timeout_seconds: 60, on_fail: "retry" },
    { name: "jest", command: "pnpm test", required: true, timeout_seconds: 120, on_fail: "retry_with_context" },
    { name: "integration", command: "pnpm test:integration", required: false, timeout_seconds: 300, on_fail: "skip" },
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
    phase_models: { "test-author": "opus-4.7", implementer: "sonnet-4.6", auditor: "opus-4.7" },
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
    makeListRow({ task_id: "T-003", title: "Rate limit /api/messages", status: "running", prd_id: "PRD-001" }),
    makeListRow({ task_id: "T-004", title: "Fix worker queue race", status: "awaiting_review", prd_id: "PRD-001" }),
    makeListRow({ task_id: "T-005", title: "Paginate admin dashboard", status: "paused", pushback_count: 1 }),
    makeListRow({ task_id: "T-002", title: "Extract auth middleware", status: "merged" }),
    makeListRow({ task_id: "T-006", title: "Migrate sessions to Redis", status: "queued" }),
  ];

  it("renders all task IDs", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.getByText("T-004")).toBeDefined();
    expect(screen.getByText("T-005")).toBeDefined();
    expect(screen.getByText("T-002")).toBeDefined();
    expect(screen.getByText("T-006")).toBeDefined();
  });

  it("renders task titles", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Rate limit /api/messages")).toBeDefined();
    expect(screen.getByText("Fix worker queue race")).toBeDefined();
    expect(screen.getByText("Paginate admin dashboard")).toBeDefined();
    expect(screen.getByText("Extract auth middleware")).toBeDefined();
    expect(screen.getByText("Migrate sessions to Redis")).toBeDefined();
  });

  it("shows auditor flagged status for awaiting_review", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("auditor flagged")).toBeDefined();
  });

  it("shows spec pushback annotation for tasks with pushbacks", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("paused · spec pushback")).toBeDefined();
  });

  it("highlights selected task with border", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId="T-003" onSelect={() => {}} />);
    const btn = screen.getByText("Rate limit /api/messages").closest("button");
    expect(btn?.className).toContain("border-l-status-warning");
  });

  it("calls onSelect with task ID when clicking", () => {
    const onSelect = vi.fn();
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Rate limit /api/messages"));
    expect(onSelect).toHaveBeenCalledWith("T-003");
  });

  it("deselects when clicking the already-selected task", () => {
    const onSelect = vi.fn();
    withQuery(<TaskListSidebar tasks={tasks} selectedId="T-003" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Rate limit /api/messages"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("filters tasks by search query", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("search tasks"), { target: { value: "rate limit" } });
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.queryByText("T-004")).toBeNull();
  });

  it("shows empty state when no results", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("search tasks"), { target: { value: "nonexistent" } });
    expect(screen.getByText("No tasks match your search.")).toBeDefined();
  });

  it("groups tasks by PRD", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("PRD-001")).toBeDefined();
    expect(screen.getByText("Standalone Tasks")).toBeDefined();
  });

  // ── Priority 41 affordances ──────────────────────────────────────────────

  it("shows 'ready to merge → main' for approved tasks when currentBranch provided", () => {
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask]} selectedId={null} onSelect={() => {}} currentBranch="main" />);
    expect(screen.getByText("ready to merge → main")).toBeDefined();
  });

  it("shows 'ready to merge → main' as fallback when no branch provided", () => {
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("ready to merge → main")).toBeDefined();
  });

  it("renders merge icon button for approved task with current_attempt_id", () => {
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask]} selectedId={null} onSelect={() => {}} onMergeIconClick={vi.fn()} />);
    expect(screen.getByLabelText("Open merge review")).toBeDefined();
  });

  it("calls onMergeIconClick with taskId and attemptId when merge icon is clicked", () => {
    const onMerge = vi.fn();
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask]} selectedId={null} onSelect={() => {}} onMergeIconClick={onMerge} />);
    fireEvent.click(screen.getByLabelText("Open merge review"));
    expect(onMerge).toHaveBeenCalledWith("T-007", "ATT-007");
  });

  it("clicking merge icon does not also trigger task selection", () => {
    const onSelect = vi.fn();
    const onMerge = vi.fn();
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask]} selectedId={null} onSelect={onSelect} onMergeIconClick={onMerge} />);
    fireEvent.click(screen.getByLabelText("Open merge review"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows 'N ready to merge' counter when approved tasks exist", () => {
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[approvedTask, ...tasks]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("1 ready to merge")).toBeDefined();
  });

  it("does not show counter when no approved tasks exist", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText(/ready to merge/)).toBeNull();
  });

  it("renders status filter select with All, Active, Approved, Done options", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    const select = screen.getByRole("combobox", { name: /status filter/i });
    expect(select).toBeDefined();
    expect(screen.getByRole("option", { name: "All" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Active" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Approved" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Done" })).toBeDefined();
  });

  it("filters to only approved tasks when Approved filter is selected", () => {
    const approvedTask = makeListRow({ task_id: "T-007", title: "Ready task", status: "approved", current_attempt_id: "ATT-007" });
    withQuery(<TaskListSidebar tasks={[...tasks, approvedTask]} selectedId={null} onSelect={() => {}} />);
    const select = screen.getByRole("combobox", { name: /status filter/i });
    fireEvent.change(select, { target: { value: "approved" } });
    expect(screen.getByText("T-007")).toBeDefined();
    expect(screen.queryByText("T-003")).toBeNull();
  });

  it("filters to active tasks when Active filter is selected", () => {
    withQuery(<TaskListSidebar tasks={tasks} selectedId={null} onSelect={() => {}} />);
    const select = screen.getByRole("combobox", { name: /status filter/i });
    fireEvent.change(select, { target: { value: "active" } });
    // T-003 (running) and T-004 (awaiting_review) are active; T-002 (merged) and T-005 (paused) should be filtered
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.queryByText("T-002")).toBeNull();
  });

  it("shows 'auto' badge on auto-merged tasks", () => {
    const autoMergedTask = makeListRow({
      task_id: "T-010",
      title: "Auto merged feature",
      status: "merged",
      auto_merged: true,
    });
    withQuery(<TaskListSidebar tasks={[autoMergedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("auto")).toBeDefined();
  });

  it("does not show 'auto' badge on manually merged tasks", () => {
    const manualMergedTask = makeListRow({
      task_id: "T-011",
      title: "Manual merged feature",
      status: "merged",
      auto_merged: false,
    });
    withQuery(<TaskListSidebar tasks={[manualMergedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText("auto")).toBeNull();
  });

  // ── Dependency indicators ──────────────────────────────────────────────

  it("shows lock icon and greyed-out styling on blocked tasks", () => {
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "draft",
      blocked: true,
      depends_on: ["T-019"],
    });
    withQuery(<TaskListSidebar tasks={[blockedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByLabelText("Blocked")).toBeDefined();
    const btn = screen.getByText("Blocked feature").closest("button");
    expect(btn?.className).toContain("opacity-50");
  });

  it("shows 'Blocked by T-XXXXX' badge with dependency IDs", () => {
    const dep1 = makeListRow({ task_id: "T-019", title: "Dep one", status: "running" });
    const dep2 = makeListRow({ task_id: "T-018", title: "Dep two", status: "queued" });
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "draft",
      blocked: true,
      depends_on: ["T-019", "T-018"],
    });
    withQuery(<TaskListSidebar tasks={[dep1, dep2, blockedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Blocked by T-019, T-018")).toBeDefined();
  });

  it("shows warning indicator when a dependency is in failed/cancelled state", () => {
    const rejectedDep = makeListRow({ task_id: "T-019", title: "Rejected dep", status: "rejected" });
    const blockedTask = makeListRow({
      task_id: "T-020",
      title: "Blocked feature",
      status: "draft",
      blocked: true,
      depends_on: ["T-019"],
    });
    withQuery(<TaskListSidebar tasks={[rejectedDep, blockedTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByLabelText("Dependency failed")).toBeDefined();
  });

  it("renders unblocked tasks normally with no dependency indicators", () => {
    const normalTask = makeListRow({
      task_id: "T-021",
      title: "Normal task",
      status: "running",
      blocked: false,
      depends_on: ["T-019"],
    });
    withQuery(<TaskListSidebar tasks={[normalTask]} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByLabelText("Blocked")).toBeNull();
    expect(screen.queryByText(/Blocked by/)).toBeNull();
  });
});

// ============================================================================
// TaskDetailPane tests
// ============================================================================

describe("TaskDetailPane", () => {
  it("renders task ID and title", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />);
    expect(screen.getByText("T-003")).toBeDefined();
    expect(screen.getByText("Rate limit /api/messages")).toBeDefined();
  });

  it("renders status pill", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("running")).toBeDefined();
  });

  it("renders worktree branch", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("worktree: wt/t-003")).toBeDefined();
  });

  it("renders all three phase boxes", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />);
    expect(screen.getByText("test-author")).toBeDefined();
    expect(screen.getByText("implementer")).toBeDefined();
    expect(screen.getByText("auditor")).toBeDefined();
  });

  it("renders all gate pills", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} />);
    expect(screen.getByText("tsc")).toBeDefined();
    expect(screen.getByText("eslint")).toBeDefined();
    expect(screen.getByText("jest")).toBeDefined();
    expect(screen.getByText("integration")).toBeDefined();
  });

  it("renders retry policy summary", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />);
    // The × is Unicode \u00d7
    expect(screen.getByText("2\u00d7 on typecheck \u00b7 escalate on audit reject")).toBeDefined();
  });

  it("renders attempt counter from list row", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow({ attempt_count: 1 })} />);
    expect(screen.getByText("attempt 1/3")).toBeDefined();
  });

  it("shows Pause/Retry/Kill for running status", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />);
    expect(screen.getByText("Pause")).toBeDefined();
    expect(screen.getByText("Retry")).toBeDefined();
    expect(screen.getByText("Kill")).toBeDefined();
  });

  it("shows Approve/Reject for awaiting_review", () => {
    withQuery(
      <TaskDetailPane
        detail={makeDetailRow({ status: "awaiting_review" })}
        listRow={makeListRow({ status: "awaiting_review" })}
      />,
    );
    expect(screen.getByText("Approve")).toBeDefined();
    expect(screen.getByText("Reject")).toBeDefined();
  });

  it("POSTs to command endpoint on action click", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    withQuery(<TaskDetailPane detail={makeDetailRow()} listRow={makeListRow()} />);

    fireEvent.click(screen.getByText("Pause"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/commands/task/T-003/pause",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("renders proposition IDs", () => {
    withQuery(<TaskDetailPane detail={makeDetailRow({ proposition_ids: ["P-001", "P-002"] })} />);
    expect(screen.getByText("P-001")).toBeDefined();
    expect(screen.getByText("P-002")).toBeDefined();
  });

  it("hides proposition section when empty", () => {
    const { container } = withQuery(<TaskDetailPane detail={makeDetailRow({ proposition_ids: [] })} />);
    // No "Proposition" heading when there are no proposition IDs
    const headings = container.querySelectorAll("h3");
    const texts = Array.from(headings).map((h) => h.textContent);
    expect(texts).not.toContain("Proposition");
  });
});
