// @vitest-environment jsdom
/**
 * Tests for the Measurement section.
 * Verifies: tab rendering, cost data display, invocations chart, task status,
 * A/B experiment cards, top prompts list, date range controls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Measurement } from "./Measurement.js";
import type { CostRollupRow, AbExperimentRow, PromptVersionRow, TaskListRow } from "@shared/projections.js";

afterEach(cleanup);

// ============================================================================
// Fixtures
// ============================================================================

const costRow = (overrides: Partial<CostRollupRow> = {}): CostRollupRow => ({
  date: "2026-04-21",
  provider_id: "anthropic-api",
  model: "claude-sonnet-4-6",
  phase_class: "implementer",
  invocation_count: 5,
  tokens_in: 10000,
  tokens_out: 3000,
  cost_usd: 0.05,
  ...overrides,
});

const abRow = (overrides: Partial<AbExperimentRow> = {}): AbExperimentRow => ({
  experiment_id: "exp-001",
  phase_class: "implementer",
  variant_a_id: "pv-aaaaaaaa",
  variant_b_id: "pv-bbbbbbbb",
  bucket_key: "${task_id}:implementer",
  split_a: 50,
  a_n: 20,
  a_success_n: 16,
  a_cost_usd: 0.2,
  b_n: 22,
  b_success_n: 15,
  b_cost_usd: 0.18,
  a_success_rate: 0.8,
  b_success_rate: 0.68,
  significance_p: 0.12,
  status: "running",
  winner: undefined,
  ...overrides,
});

const promptRow = (overrides: Partial<PromptVersionRow> = {}): PromptVersionRow => ({
  prompt_version_id: "pv-001",
  name: "ingest-v1",
  phase_class: "implementer",
  template_hash: "abc123",
  retired: false,
  invocations_last_30d: 42,
  success_rate_last_30d: 0.85,
  avg_cost_usd: 0.01,
  ab_experiment_ids: [],
  created_at: "2026-04-21T00:00:00.000Z",
  ...overrides,
});

const taskRow = (overrides: Partial<TaskListRow> = {}): TaskListRow => ({
  task_id: "T-001",
  title: "Test task",
  status: "merged",
  attempt_count: 2,
  pushback_count: 0,
  phase_models: {},
  last_event_ts: "2026-04-21T10:00:00.000Z",
  updated_at: "2026-04-21T10:00:00.000Z",
  ...overrides,
});

// ============================================================================
// Mock fetch
// ============================================================================

function setupFetch({
  costRows = [],
  abRows = [],
  promptRows = [],
  taskRows = [],
}: {
  costRows?: CostRollupRow[];
  abRows?: AbExperimentRow[];
  promptRows?: PromptVersionRow[];
  taskRows?: TaskListRow[];
} = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input.toString();

    if (url.includes("/api/measurement/cost")) {
      return new Response(JSON.stringify(costRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/projections/ab_experiment")) {
      return new Response(JSON.stringify(abRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/projections/prompt_library")) {
      return new Response(JSON.stringify(promptRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/projections/task_list")) {
      return new Response(JSON.stringify(taskRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Measurement screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the section heading", async () => {
    setupFetch();
    render(<Measurement />);
    expect(screen.getByText("Measurement")).toBeTruthy();
  });

  it("renders all six tabs", async () => {
    setupFetch();
    render(<Measurement />);
    expect(screen.getByTestId("tab-cost")).toBeTruthy();
    expect(screen.getByTestId("tab-invocations")).toBeTruthy();
    expect(screen.getByTestId("tab-tasks")).toBeTruthy();
    expect(screen.getByTestId("tab-experiments")).toBeTruthy();
    expect(screen.getByTestId("tab-prompts")).toBeTruthy();
    expect(screen.getByTestId("tab-auto_merge")).toBeTruthy();
  });

  it("shows date range controls on Cost tab", async () => {
    setupFetch();
    render(<Measurement />);
    expect(screen.getByTestId("date-from")).toBeTruthy();
    expect(screen.getByTestId("date-to")).toBeTruthy();
    expect(screen.getByTestId("preset-30d")).toBeTruthy();
  });

  it("displays summary stats from cost data", async () => {
    setupFetch({ costRows: [costRow({ cost_usd: 0.05, invocation_count: 5, tokens_in: 10000, tokens_out: 3000 })] });
    render(<Measurement />);
    await waitFor(() => {
      // Should show cost (in some format)
      expect(screen.getByText(/Total cost/i)).toBeTruthy();
      expect(screen.getByText(/Tokens in/i)).toBeTruthy();
    });
  });

  it("shows empty state when no cost data", async () => {
    setupFetch({ costRows: [] });
    render(<Measurement />);
    await waitFor(() => {
      expect(screen.getByText(/No cost data for this period/i)).toBeTruthy();
    });
  });

  it("switches to Invocations tab and hides cost-only sections", async () => {
    setupFetch({ costRows: [costRow()] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-invocations"));
    await waitFor(() => {
      expect(screen.getByText(/Total invocations/i)).toBeTruthy();
    });
  });

  it("switches to Tasks tab and shows status breakdown", async () => {
    setupFetch({
      taskRows: [
        taskRow({ status: "merged" }),
        taskRow({ task_id: "T-002", status: "merged" }),
        taskRow({ task_id: "T-003", status: "running" }),
      ],
    });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-tasks"));
    await waitFor(() => {
      expect(screen.getByText(/Total tasks/i)).toBeTruthy();
      expect(screen.getByText("3")).toBeTruthy(); // total tasks
    });
  });

  it("shows success rate on Tasks tab", async () => {
    setupFetch({
      taskRows: [
        taskRow({ status: "merged" }),
        taskRow({ task_id: "T-002", status: "merged" }),
        taskRow({ task_id: "T-003", status: "rejected" }),
        taskRow({ task_id: "T-004", status: "rejected" }),
      ],
    });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-tasks"));
    await waitFor(() => {
      expect(screen.getByText("50%")).toBeTruthy(); // 2 merged / 4 total
    });
  });

  it("shows empty state on Tasks tab when no tasks", async () => {
    setupFetch({ taskRows: [] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-tasks"));
    await waitFor(() => {
      expect(screen.getByText(/No tasks yet/i)).toBeTruthy();
    });
  });

  it("shows A/B experiment cards with stats", async () => {
    setupFetch({ abRows: [abRow()] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-experiments"));
    await waitFor(() => {
      expect(screen.getByTestId("experiment-exp-001")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
      // Success rates
      expect(screen.getByText("80%")).toBeTruthy(); // variant A
      expect(screen.getByText("68%")).toBeTruthy(); // variant B
    });
  });

  it("shows p-value on A/B experiment card", async () => {
    setupFetch({ abRows: [abRow({ significance_p: 0.042 })] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-experiments"));
    await waitFor(() => {
      expect(screen.getByTestId("p-value")).toBeTruthy();
      expect(screen.getByTestId("p-value").textContent).toContain("0.042");
    });
  });

  it("shows concluded experiment with winner badge", async () => {
    setupFetch({
      abRows: [
        abRow({
          status: "concluded",
          winner: "A",
          significance_p: 0.03,
        }),
      ],
    });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-experiments"));
    await waitFor(() => {
      expect(screen.getByText("concluded")).toBeTruthy();
      expect(screen.getByText("Winner: A")).toBeTruthy();
    });
  });

  it("shows empty state when no experiments", async () => {
    setupFetch({ abRows: [] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-experiments"));
    await waitFor(() => {
      expect(screen.getByText(/No A\/B experiments yet/i)).toBeTruthy();
    });
  });

  it("shows top prompts sorted by usage", async () => {
    setupFetch({
      promptRows: [
        promptRow({ prompt_version_id: "pv-001", name: "ingest-v1", invocations_last_30d: 42 }),
        promptRow({ prompt_version_id: "pv-002", name: "auditor-v1", invocations_last_30d: 18 }),
      ],
    });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-prompts"));
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^prompt-row-/);
      expect(rows).toHaveLength(2);
      // ingest-v1 (42) should appear before auditor-v1 (18)
      expect(rows[0].textContent).toContain("ingest-v1");
    });
  });

  it("allows sorting prompts by success rate", async () => {
    setupFetch({
      promptRows: [
        promptRow({ prompt_version_id: "pv-low", name: "low-success", invocations_last_30d: 100, success_rate_last_30d: 0.5 }),
        promptRow({ prompt_version_id: "pv-high", name: "high-success", invocations_last_30d: 10, success_rate_last_30d: 0.95 }),
      ],
    });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-prompts"));
    await waitFor(() => expect(screen.getAllByTestId(/^prompt-row-/).length).toBe(2));

    fireEvent.click(screen.getByTestId("sort-success"));
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^prompt-row-/);
      // high-success (95%) should now be first
      expect(rows[0].textContent).toContain("high-success");
    });
  });

  it("shows empty state when no prompts", async () => {
    setupFetch({ promptRows: [] });
    render(<Measurement />);
    fireEvent.click(screen.getByTestId("tab-prompts"));
    await waitFor(() => {
      expect(screen.getByText(/No prompt versions yet/i)).toBeTruthy();
    });
  });

  it("date range preset buttons update the date inputs", async () => {
    setupFetch();
    render(<Measurement />);
    const fromInput = screen.getByTestId("date-from") as HTMLInputElement;
    const originalFrom = fromInput.value;

    // Click 7d preset — should set a closer date range
    fireEvent.click(screen.getByTestId("preset-7d"));
    await waitFor(() => {
      const newFrom = (screen.getByTestId("date-from") as HTMLInputElement).value;
      expect(newFrom).not.toBe(originalFrom);
    });
  });

  // ── Auto-merge activity tab ───────────────────────────────────────────

  describe("Auto-merge activity tab", () => {
    it("renders the auto-merge tab button", async () => {
      setupFetch();
      render(<Measurement />);
      expect(screen.getByTestId("tab-auto_merge")).toBeTruthy();
    });

    it("shows auto-merge activity stats when tab is selected", async () => {
      setupFetch({
        taskRows: [
          taskRow({ task_id: "T-001", status: "merged", auto_merged: true }),
          taskRow({ task_id: "T-002", status: "merged", auto_merged: false }),
          taskRow({ task_id: "T-003", status: "merged", auto_merged: true }),
        ],
      });
      render(<Measurement />);
      fireEvent.click(screen.getByTestId("tab-auto_merge"));

      await waitFor(() => {
        expect(screen.getByText("2")).toBeTruthy(); // auto-merged count
      });
    });

    it("shows empty state when no merges exist", async () => {
      setupFetch();
      render(<Measurement />);
      fireEvent.click(screen.getByTestId("tab-auto_merge"));

      await waitFor(() => {
        expect(screen.getByText(/no merge activity/i)).toBeTruthy();
      });
    });
  });
});
