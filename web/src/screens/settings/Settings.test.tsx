// @vitest-environment jsdom
/**
 * Settings screen tests.
 *
 * Tests all 5 subsections: Presets, Gates, Defaults, API Keys, About.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Settings } from "./Settings.js";
import type { PresetRow, ProviderHealthRow } from "@shared/projections.js";

// ============================================================================
// Mocks
// ============================================================================

const MOCK_PRESETS: PresetRow[] = [
  {
    preset_id: "preset-alpha",
    name: "Alpha Preset",
    task_class: "new-feature",
    config: {
      phases: [],
      gates: [],
      retry_policy: {
        on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
        on_test_fail: { strategy: "retry_same", max_attempts: 2 },
        on_audit_reject: "retry_same",
        on_spec_pushback: "pause_and_notify",
        max_total_attempts: 3,
      },
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const MOCK_GATES_RESPONSE = {
  config_gates: [],
  library_gates: [],
  all_gates: [],
  config_gate_names: [],
};

const MOCK_DEFAULTS = {
  settings_id: "global",
  default_preset_id: null,
  auto_delete_worktree_on_merge: false,
  auto_pause_on_external_fs_change: false,
};

const MOCK_PROVIDERS: ProviderHealthRow[] = [
  {
    provider_id: "anthropic-api",
    transport: "anthropic-api",
    status: "healthy",
    auth_method: "env_var",
    auth_present: true,
  } as unknown as ProviderHealthRow,
  {
    provider_id: "openai-api",
    transport: "openai-api",
    status: "down",
    auth_method: "env_var",
    auth_present: false,
  } as unknown as ProviderHealthRow,
];

const MOCK_ABOUT = {
  version: "0.1.0",
  event_count: 42,
  db_size_bytes: 1024,
  db_path: "/data/events.db",
  env_local_path: "/orchestrator/.env.local",
  repo_root: "/host/repo",
  projections: ["task_list", "preset", "settings"],
};

function mockFetch(responses: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : {};
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  }));
}

describe("Settings screen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch({
      "/api/projections/preset": MOCK_PRESETS,
      "/api/settings/gates": MOCK_GATES_RESPONSE,
      "/api/settings/defaults": MOCK_DEFAULTS,
      "/api/projections/provider_health": MOCK_PROVIDERS,
      "/api/settings/about": MOCK_ABOUT,
    });
  });

  it("renders all 6 nav tabs", () => {
    render(<Settings />);
    expect(screen.getByTestId("settings-tab-presets")).toBeDefined();
    expect(screen.getByTestId("settings-tab-gates")).toBeDefined();
    expect(screen.getByTestId("settings-tab-defaults")).toBeDefined();
    expect(screen.getByTestId("settings-tab-api_keys")).toBeDefined();
    expect(screen.getByTestId("settings-tab-maintenance")).toBeDefined();
    expect(screen.getByTestId("settings-tab-about")).toBeDefined();
  });

  // Presets subsection
  describe("Presets", () => {
    it("shows the presets section by default", async () => {
      render(<Settings />);
      await waitFor(() => {
        expect(screen.getByTestId("presets-section")).toBeDefined();
      });
    });

    it("lists presets from the projection", async () => {
      render(<Settings />);
      await waitFor(() => {
        expect(screen.getByText("Alpha Preset")).toBeDefined();
      });
    });

    it("shows delete button per preset", async () => {
      render(<Settings />);
      await waitFor(() => {
        expect(screen.getByTestId("delete-preset-preset-alpha")).toBeDefined();
      });
    });

    it("calls delete endpoint on delete click", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/projections/preset")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESETS) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      await waitFor(() => screen.getByTestId("delete-preset-preset-alpha"));
      fireEvent.click(screen.getByTestId("delete-preset-preset-alpha"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/commands/preset/delete/preset-alpha",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });

  // Gates subsection
  describe("Gates", () => {
    it("navigates to gates section on tab click", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-gates"));
      await waitFor(() => {
        expect(screen.getByTestId("gates-section")).toBeDefined();
      });
    });

    it("shows add gate button", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-gates"));
      await waitFor(() => {
        expect(screen.getByTestId("add-gate-btn")).toBeDefined();
      });
    });

    it("shows gate form on add click", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-gates"));
      await waitFor(() => screen.getByTestId("add-gate-btn"));
      fireEvent.click(screen.getByTestId("add-gate-btn"));
      expect(screen.getByTestId("gate-form")).toBeDefined();
      expect(screen.getByTestId("gate-name-input")).toBeDefined();
    });

    it("adds gate to library via POST", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/settings/gates")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_GATES_RESPONSE) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-gates"));
      await waitFor(() => screen.getByTestId("add-gate-btn"));
      fireEvent.click(screen.getByTestId("add-gate-btn"));

      fireEvent.change(screen.getByTestId("gate-name-input"), { target: { value: "my-gate" } });
      fireEvent.change(screen.getByTestId("gate-command-input"), { target: { value: "npm test" } });
      fireEvent.click(screen.getByTestId("save-gate-btn"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/commands/gate_library/add",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("shows library gates with source badge", async () => {
      const withGates = {
        ...MOCK_GATES_RESPONSE,
        all_gates: [{ name: "typecheck", command: "tsc --noEmit", required: true, timeout_seconds: 60, on_fail: "fail_task", source: "library" }],
        library_gates: [{ gate_name: "typecheck", command: "tsc --noEmit", required: true, timeout_seconds: 60, on_fail: "fail_task", updated_at: "" }],
      };
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.includes("/api/settings/gates")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(withGates) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_DEFAULTS) });
      }));
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-gates"));
      await waitFor(() => {
        expect(screen.getByTestId("gate-row-typecheck")).toBeDefined();
      });
    });
  });

  // Defaults subsection
  describe("Defaults", () => {
    it("renders defaults section", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => {
        expect(screen.getByTestId("defaults-section")).toBeDefined();
      });
    });

    it("renders auto-merge master switch", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => {
        expect(screen.getByTestId("auto-merge-master-switch")).toBeDefined();
      });
    });

    it("master switch toggles via POST to settings/auto-merge", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/api/settings/defaults")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_DEFAULTS) });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => screen.getByTestId("auto-merge-master-switch"));

      fireEvent.click(screen.getByTestId("auto-merge-master-switch"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/commands/settings/auto-merge",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("shows advisory banner with would-auto-merge count", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/settings/defaults")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...MOCK_DEFAULTS, auto_merge_enabled: true }) });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { type: "task.would_auto_merge", ts: new Date().toISOString() },
              { type: "task.would_auto_merge", ts: new Date().toISOString() },
            ]),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => {
        expect(screen.getByTestId("auto-merge-advisory-banner")).toBeDefined();
      });
    });

    it("shows default preset input", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => {
        expect(screen.getByTestId("default-preset-input")).toBeDefined();
      });
    });

    it("shows auto-delete worktree checkbox", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => {
        expect(screen.getByTestId("auto-delete-worktree-checkbox")).toBeDefined();
      });
    });

    it("saves defaults via POST", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/settings/defaults")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_DEFAULTS) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-defaults"));
      await waitFor(() => screen.getByTestId("save-defaults-btn"));

      // Change a value to trigger a save
      fireEvent.click(screen.getByTestId("auto-delete-worktree-checkbox"));
      fireEvent.click(screen.getByTestId("save-defaults-btn"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/commands/settings/defaults",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });

  // API Keys subsection
  describe("API Keys", () => {
    it("renders API keys section", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-api_keys"));
      await waitFor(() => {
        expect(screen.getByTestId("api-keys-section")).toBeDefined();
      });
    });

    it("shows present for anthropic-api", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-api_keys"));
      await waitFor(() => {
        const row = screen.getByTestId("provider-key-anthropic-api");
        expect(row).toBeDefined();
        expect(row.innerHTML).toContain("present");
      });
    });

    it("shows missing for openai-api", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-api_keys"));
      await waitFor(() => {
        const row = screen.getByTestId("provider-key-openai-api");
        expect(row).toBeDefined();
        expect(row.innerHTML).toContain("missing");
      });
    });

    it("never renders actual key values", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-api_keys"));
      await waitFor(() => screen.getByTestId("api-keys-section"));
      expect(screen.queryByText(/sk-/)).toBeNull();
      expect(screen.queryByText(/AIza/)).toBeNull();
    });
  });

  // About subsection
  describe("About", () => {
    it("renders about section", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-about"));
      await waitFor(() => {
        expect(screen.getByTestId("about-section")).toBeDefined();
      });
    });

    it("shows version and event count", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-about"));
      await waitFor(() => {
        expect(screen.getByText("0.1.0")).toBeDefined();
        expect(screen.getByText(/42/)).toBeDefined();
      });
    });

    it("shows rebuild button per projection", async () => {
      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-about"));
      await waitFor(() => {
        expect(screen.getByTestId("rebuild-btn-task_list")).toBeDefined();
        expect(screen.getByTestId("rebuild-btn-preset")).toBeDefined();
        expect(screen.getByTestId("rebuild-btn-settings")).toBeDefined();
      });
    });

    it("calls rebuild endpoint on button click", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/api/settings/about")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ABOUT) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, projection: "task_list" }) });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<Settings />);
      fireEvent.click(screen.getByTestId("settings-tab-about"));
      await waitFor(() => screen.getByTestId("rebuild-btn-task_list"));
      fireEvent.click(screen.getByTestId("rebuild-btn-task_list"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/maintenance/rebuild/task_list",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });
});
