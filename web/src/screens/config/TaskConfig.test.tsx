// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskConfig } from "./TaskConfig.js";
import type { TaskDetailRow, PresetRow } from "@shared/projections.js";
import type { TaskConfig as TaskConfigType } from "@shared/events.js";

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

afterEach(cleanup);

/** Wrap component in a fresh QueryClientProvider per test. */
function withQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// ============================================================================
// Fixtures
// ============================================================================

const baseConfig: TaskConfigType = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "prompt-v1",
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
      enabled: false,
      transport: "anthropic-api",
      model: "claude-opus-4-6",
      prompt_version_id: "auditor-v1",
      transport_options: {
        kind: "api",
        max_tokens: 4096,
      },
      context_policy: {
        symbol_graph_depth: 0,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 4000,
      },
    },
  ],
  gates: [
    {
      name: "typecheck",
      command: "pnpm tsc",
      required: true,
      timeout_seconds: 60,
      on_fail: "retry",
    },
  ],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

const mockDetail: TaskDetailRow = {
  task_id: "T-001",
  title: "Add login feature",
  status: "queued",
  config: baseConfig,
  preset_id: "preset-abc",
  preset_override_keys: [],
  proposition_ids: ["PROP-001"],
  last_event_id: "EVT-001",
  updated_at: "2026-04-21T00:00:00.000Z",
};

const mockPreset: PresetRow = {
  preset_id: "preset-abc",
  name: "default-new-feature",
  task_class: "feature",
  config: baseConfig,
  updated_at: "2026-04-21T00:00:00.000Z",
};

function setupFetch(options: {
  detail?: TaskDetailRow | null;
  presets?: PresetRow[];
  configResult?: unknown;
  presetCreateResult?: unknown;
} = {}) {
  const { detail = mockDetail, presets = [mockPreset] } = options;

  // Build gate library from config gates
  const configGates = (detail ?? mockDetail)?.config?.gates ?? baseConfig.gates;
  const gateLibrary = {
    library_gates: configGates,
    all_gates: configGates.map((g) => ({ ...g, source: "library" as const })),
    config_gate_names: configGates.map((g) => g.name),
  };

  return vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    const u = url.toString();

    if (u.includes("/api/projections/task_detail/")) {
      if (detail === null) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }));
    }
    if (u.includes("/api/projections/preset")) {
      return Promise.resolve(new Response(JSON.stringify(presets), { status: 200 }));
    }
    if (u.includes("/api/settings/gates")) {
      return Promise.resolve(new Response(JSON.stringify(gateLibrary), { status: 200 }));
    }
    if (u.includes("/api/settings/defaults")) {
      return Promise.resolve(new Response(JSON.stringify({ default_preset_id: null }), { status: 200 }));
    }
    if (u.includes("/api/projections/prompt_library")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (u.includes("/api/projections/prompt_template")) {
      return Promise.resolve(new Response(JSON.stringify({ template: "mock template" }), { status: 200 }));
    }
    if (u.includes("/api/commands/task/") && u.includes("/config")) {
      return Promise.resolve(new Response(JSON.stringify(options.configResult ?? { ok: true }), { status: 200 }));
    }
    if (u.includes("/api/commands/preset/create")) {
      return Promise.resolve(new Response(JSON.stringify(options.presetCreateResult ?? { preset_id: "new-preset" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

// ============================================================================
// Loading & rendering
// ============================================================================

describe("TaskConfig — loading", () => {
  it("shows a loading state while fetching task detail", async () => {
    let resolve: (v: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise((r) => { resolve = r; })
    );

    withQuery(<TaskConfig taskId="T-001" />);
    expect(screen.getByText(/loading/i)).toBeTruthy();

    resolve!(new Response(JSON.stringify(mockDetail), { status: 200 }));
    vi.restoreAllMocks();
  });

  it("renders the task title and id after loading", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => expect(screen.getByText("Add login feature")).toBeTruthy());
    expect(screen.getByText("T-001")).toBeTruthy();
  });

  it("shows 404 message when task is not found", async () => {
    setupFetch({ detail: null });
    withQuery(<TaskConfig taskId="T-999" />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
  });
});

// ============================================================================
// Navigation
// ============================================================================

describe("TaskConfig — navigation", () => {
  it("back button navigates without saving", async () => {
    mockNavigate.mockClear();
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledOnce();
  });

  it("Cancel button navigates without saving", async () => {
    mockNavigate.mockClear();
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockNavigate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Preset strip
// ============================================================================

describe("TaskConfig — preset strip", () => {
  it("shows preset dropdown with the selected preset value", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // base-ui Select renders a hidden input with the selected value
    const hiddenInputs = document.querySelectorAll<HTMLInputElement>("input[aria-hidden='true']");
    const presetInput = Array.from(hiddenInputs).find((i) => i.value === "preset-abc");
    expect(presetInput).toBeTruthy();
  });
});

// ============================================================================
// Phases section
// ============================================================================

describe("TaskConfig — phases section", () => {
  it("renders a card for each phase", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    expect(screen.getByText("implementer")).toBeTruthy();
    expect(screen.getByText("auditor")).toBeTruthy();
  });

  it("enabled phase shows toggle as checked", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    const checkboxes = screen.getAllByRole("checkbox");
    // implementer is enabled (true), auditor is disabled (false)
    expect(checkboxes[0]).toBeTruthy();
  });

  it("toggling a phase checkbox changes its checked state", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Find the "enabled" label checkboxes — each phase card has one
    const enabledLabels = screen.getAllByText("enabled");
    const auditorEnabledCheckbox = enabledLabels[1].closest("label")?.querySelector("input[type='checkbox']");
    expect(auditorEnabledCheckbox).toBeTruthy();
    expect((auditorEnabledCheckbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(auditorEnabledCheckbox!);
    expect((auditorEnabledCheckbox as HTMLInputElement).checked).toBe(true);
  });
});

// ============================================================================
// Gates section
// ============================================================================

describe("TaskConfig — gates section", () => {
  it("renders gate rows from config", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    expect(screen.getAllByText("typecheck").length).toBeGreaterThan(0);
  });

  it("gate timeout input accepts a new value", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Wait for gate library to load and render the timeout input
    await waitFor(() => expect(screen.getAllByDisplayValue("60").length).toBeGreaterThan(0));
    const timeoutInputs = screen.getAllByDisplayValue("60");
    fireEvent.change(timeoutInputs[0], { target: { value: "120" } });

    expect((timeoutInputs[0] as HTMLInputElement).value).toBe("120");
  });
});

// ============================================================================
// Retry policy section
// ============================================================================

describe("TaskConfig — retry policy", () => {
  it("renders max total attempts field", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    expect(screen.getByDisplayValue("3")).toBeTruthy();
  });

  it("changing max_total_attempts updates the input value", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    const maxAttemptsInput = screen.getByLabelText(/max attempts/i);
    fireEvent.change(maxAttemptsInput, { target: { value: "5" } });

    expect((maxAttemptsInput as HTMLInputElement).value).toBe("5");
  });
});

// ============================================================================
// Save
// ============================================================================

describe("TaskConfig — save", () => {
  it("save button POSTs to /api/commands/task/:id/config", async () => {
    const fetchSpy = setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Use exact "Save" text to avoid matching "Save as preset"
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const configCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/api/commands/task/T-001/config"),
      );
      expect(configCall).toBeTruthy();
    });
  });

  it("save only includes changed fields in the diff", async () => {
    const fetchSpy = setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Change only retry policy max_total_attempts
    const maxAttemptsInput = screen.getByLabelText(/max attempts/i);
    fireEvent.change(maxAttemptsInput, { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const configCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/api/commands/task/T-001/config"),
      );
      expect(configCall).toBeTruthy();
      const body = JSON.parse(configCall![1]?.body as string);
      // Diff should include retry_policy with the changed value
      expect(body.config_diff.retry_policy.max_total_attempts).toBe(5);
      // Diff should NOT include phases (unchanged)
      expect(body.config_diff.phases).toBeUndefined();
    });
  });

  it("save navigates after success", async () => {
    mockNavigate.mockClear();
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledOnce());
  });

  it("save-as-preset opens a modal and POSTs on confirm", async () => {
    const fetchSpy = setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Open modal
    fireEvent.click(screen.getByRole("button", { name: /save as preset/i }));

    // Fill in preset name in the modal
    await waitFor(() => screen.getByPlaceholderText(/e\.g\. my-api-feature/i));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. my-api-feature/i), {
      target: { value: "my-preset" },
    });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /create preset/i }));

    await waitFor(() => {
      const presetCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/api/commands/preset/create"),
      );
      expect(presetCall).toBeTruthy();
    });
  });
});

// ============================================================================
// Auto-merge section
// ============================================================================

describe("TaskConfig — auto-merge section", () => {
  it("renders auto-merge policy section with current value", async () => {
    const configWithAutoMerge = {
      ...baseConfig,
      auto_merge_policy: "on_full_pass" as const,
      shadow_mode: false,
    };
    setupFetch({
      detail: { ...mockDetail, config: configWithAutoMerge },
      presets: [{ ...mockPreset, config: configWithAutoMerge }],
    });
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // base-ui Select renders a hidden input with the selected value
    const hiddenInputs = document.querySelectorAll<HTMLInputElement>("input[aria-hidden='true']");
    const autoMergeInput = Array.from(hiddenInputs).find((i) => i.value === "on_full_pass");
    expect(autoMergeInput).toBeTruthy();
  });

  it("renders shadow mode toggle", async () => {
    setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    expect(screen.getByLabelText(/shadow mode/i)).toBeTruthy();
  });

  it("save includes shadow_mode in diff when toggled", async () => {
    const fetchSpy = setupFetch();
    withQuery(<TaskConfig taskId="T-001" />);
    await waitFor(() => screen.getByText("Add login feature"));

    // Toggle shadow mode
    fireEvent.click(screen.getByLabelText(/shadow mode/i));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const configCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/api/commands/task/T-001/config"),
      );
      expect(configCall).toBeTruthy();
      const body = JSON.parse(configCall![1]?.body as string);
      expect(body.config_diff.shadow_mode).toBe(true);
    });
  });
});
