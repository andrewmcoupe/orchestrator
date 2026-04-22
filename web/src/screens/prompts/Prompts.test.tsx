// @vitest-environment jsdom
/**
 * Tests for the Prompts section — prompt library and A/B experiments tab.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Prompts } from "./Prompts.js";
import type { PromptVersionRow, AbExperimentRow } from "@shared/projections.js";

// ============================================================================
// Fixtures
// ============================================================================

const PROMPT_A: PromptVersionRow = {
  prompt_version_id: "pv-001",
  name: "ingest-v1",
  phase_class: "ingest",
  template_hash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
  parent_version_id: undefined,
  retired: false,
  notes: undefined,
  invocations_last_30d: 10,
  success_rate_last_30d: 0.9,
  avg_cost_usd: 0.005,
  ab_experiment_ids: [],
  created_at: "2026-04-21T10:00:00.000Z",
};

const PROMPT_B: PromptVersionRow = {
  ...PROMPT_A,
  prompt_version_id: "pv-002",
  name: "ingest-v2",
  template_hash: "bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333",
  ab_experiment_ids: ["exp-001"],
};

const RUNNING_EXPERIMENT: AbExperimentRow = {
  experiment_id: "exp-001",
  phase_class: "ingest",
  variant_a_id: "pv-001",
  variant_b_id: "pv-002",
  status: "running",
  split_a: 50,
  bucket_key: "${task_id}:${phase_name}",
  a_n: 5,
  a_success_n: 4,
  a_cost_usd: 0.025,
  a_success_rate: 0.8,
  b_n: 6,
  b_success_n: 3,
  b_cost_usd: 0.03,
  b_success_rate: 0.5,
  significance_p: 0.21,
};

const CONCLUDED_EXPERIMENT: AbExperimentRow = {
  ...RUNNING_EXPERIMENT,
  experiment_id: "exp-002",
  status: "concluded",
  winner: "A",
};

// ============================================================================
// Mock fetch helpers
// ============================================================================

function mockFetch({
  prompts = [] as PromptVersionRow[],
  experiments = [] as AbExperimentRow[],
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/projections/prompt_library")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(prompts) });
      }
      if (url.includes("/api/projections/ab_experiment")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(experiments) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

// ============================================================================
// Setup — stub EventSource (not available in jsdom)
// ============================================================================

class StubEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", StubEventSource);

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ============================================================================
// Tests — library tab
// ============================================================================

describe("Prompts — library tab", () => {
  beforeEach(() => {
    mockFetch({ prompts: [PROMPT_A, PROMPT_B] });
  });

  it("renders the prompt library tab by default", async () => {
    render(<Prompts />);
    await waitFor(() => screen.getByText("ingest-v1"));
    expect(screen.getByText("ingest-v1")).toBeTruthy();
    expect(screen.getByText("ingest-v2")).toBeTruthy();
  });

  it("shows A/B experiment badge count on prompts that are in experiments", async () => {
    render(<Prompts />);
    await waitFor(() => screen.getByText("ingest-v2"));
    // PROMPT_B has 1 experiment; the badge should show "1 A/B"
    expect(screen.getByText(/1 A\/B/i)).toBeTruthy();
  });
});

// ============================================================================
// Tests — experiments tab: Running / History split
// ============================================================================

describe("Prompts — A/B experiments tab", () => {
  it("navigates to experiments tab on click", async () => {
    mockFetch({ prompts: [], experiments: [RUNNING_EXPERIMENT] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByTestId("running-section"));
    expect(screen.getByTestId("running-section")).toBeTruthy();
  });

  it("shows running experiment in Running section", async () => {
    mockFetch({ prompts: [PROMPT_A, PROMPT_B], experiments: [RUNNING_EXPERIMENT] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByTestId("running-section"));
    expect(screen.getByTestId("running-section")).toBeTruthy();
    expect(screen.getByTestId(`experiment-card-${RUNNING_EXPERIMENT.experiment_id}`)).toBeTruthy();
  });

  it("shows concluded experiment in History section", async () => {
    mockFetch({ prompts: [PROMPT_A, PROMPT_B], experiments: [CONCLUDED_EXPERIMENT] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByTestId("history-section"));
    expect(screen.getByTestId("history-section")).toBeTruthy();
    expect(screen.getByTestId(`experiment-card-${CONCLUDED_EXPERIMENT.experiment_id}`)).toBeTruthy();
  });

  it("shows both running and history sections when both exist", async () => {
    mockFetch({
      prompts: [PROMPT_A, PROMPT_B],
      experiments: [RUNNING_EXPERIMENT, CONCLUDED_EXPERIMENT],
    });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByTestId("running-section"));
    expect(screen.getByTestId("running-section")).toBeTruthy();
    expect(screen.getByTestId("history-section")).toBeTruthy();
  });

  it("shows significance p-value for running experiment", async () => {
    mockFetch({ prompts: [PROMPT_A, PROMPT_B], experiments: [RUNNING_EXPERIMENT] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByText(/0\.2100/));
    expect(screen.getByText(/0\.2100/)).toBeTruthy();
  });

  it("shows winner badge on concluded experiment", async () => {
    mockFetch({ prompts: [PROMPT_A, PROMPT_B], experiments: [CONCLUDED_EXPERIMENT] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByText(/Variant A won/i));
    expect(screen.getByText(/Variant A won/i)).toBeTruthy();
  });

  it("Conclude button only appears on running experiments", async () => {
    mockFetch({
      prompts: [PROMPT_A, PROMPT_B],
      experiments: [RUNNING_EXPERIMENT, CONCLUDED_EXPERIMENT],
    });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByTestId("running-section"));
    // "Conclude" button text (exact) — excludes "concluded" status pill text
    const concludeButtons = screen.getAllByRole("button", { name: "Conclude" });
    // Only one conclude button (for the running experiment)
    expect(concludeButtons).toHaveLength(1);
  });

  it("shows empty state when no experiments exist", async () => {
    mockFetch({ prompts: [], experiments: [] });
    render(<Prompts />);
    const tab = await waitFor(() => screen.getByText(/A\/B Experiments/i));
    fireEvent.click(tab);
    await waitFor(() => screen.getByText(/No A\/B experiments yet/i));
    expect(screen.getByText(/No A\/B experiments yet/i)).toBeTruthy();
  });
});
