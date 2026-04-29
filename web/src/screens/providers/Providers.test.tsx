// @vitest-environment jsdom
/**
 * Tests for the Providers Detail screen.
 * Verifies: card rendering, re-probe action, edit config form, focused provider,
 * latency sparkline, models list, last_error display.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { Providers } from "./Providers.js";
import type { ProviderHealthRow } from "@shared/projections.js";

afterEach(cleanup);

// ============================================================================
// Fixtures
// ============================================================================

const healthRow = (
  overrides: Partial<ProviderHealthRow> = {},
): ProviderHealthRow => ({
  provider_id: "claude-code",
  transport: "claude-code",
  status: "healthy",
  latency_ms: 120,
  last_probe_at: "2026-04-21T10:00:00.000Z",
  last_error: undefined,
  models: undefined,
  binary_path: "/usr/local/bin/claude",
  endpoint: undefined,
  auth_method: "cli_login",
  auth_present: true,
  ...overrides,
});

const apiRow = (): ProviderHealthRow => ({
  provider_id: "anthropic-api",
  transport: "anthropic-api",
  status: "healthy",
  latency_ms: 450,
  last_probe_at: "2026-04-21T10:00:00.000Z",
  last_error: undefined,
  models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  binary_path: undefined,
  endpoint: "https://api.anthropic.com",
  auth_method: "env_var",
  auth_present: true,
});

const registryEntries = [
  { provider_id: "claude-code", transport: "claude-code", kind: "cli", setup_hint: "Run `claude login` in your terminal" },
  { provider_id: "codex", transport: "codex", kind: "cli", setup_hint: "Run `codex login` in your terminal" },
  { provider_id: "gemini-cli", transport: "gemini-cli", kind: "cli", setup_hint: "Run `gemini` in your terminal and follow the login prompt" },
  { provider_id: "anthropic-api", transport: "anthropic-api", kind: "api", setup_hint: "Add `ANTHROPIC_API_KEY=...` to `.orchestrator/.env.local`" },
  { provider_id: "openai-api", transport: "openai-api", kind: "api", setup_hint: "Add `OPENAI_API_KEY=...` to `.orchestrator/.env.local`" },
];

const probeEvent = (latency: number, ts: string) => ({
  id: `evt-${ts}`,
  type: "provider.probed",
  aggregate_type: "provider",
  aggregate_id: "claude-code",
  version: 1,
  ts,
  actor: { kind: "system", component: "probe_scheduler" },
  payload: {
    provider_id: "claude-code",
    status: "healthy",
    latency_ms: latency,
  },
});

// ============================================================================
// Mock fetch
// ============================================================================

function setupFetch(
  healthRows: ProviderHealthRow[],
  probeEvents: unknown[] = [],
  reprobeResult?: ProviderHealthRow,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input.toString();

    if (url === "/api/providers" || url.endsWith("/api/providers")) {
      return new Response(JSON.stringify(registryEntries), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/projections/provider_health")) {
      return new Response(JSON.stringify(healthRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/events/recent") && url.includes("aggregate_id=")) {
      return new Response(JSON.stringify(probeEvents), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.match(/\/api\/providers\/probe\//)) {
      return new Response(JSON.stringify(reprobeResult ?? healthRows[0]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.match(/\/api\/providers\/configure\//)) {
      return new Response(JSON.stringify(healthRows[0]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Providers screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows all provider cards after loading", async () => {
    setupFetch([healthRow(), apiRow()]);
    render(<Providers />);
    // Each card has a heading-style element with the provider_id
    await waitFor(() => {
      const names = document.querySelectorAll("[data-testid='provider-name']");
      expect(names.length).toBe(2);
    });
  });

  it("shows status badge for each provider", async () => {
    setupFetch([
      healthRow({ status: "healthy" }),
      healthRow({ provider_id: "codex", transport: "codex", status: "down" }),
    ]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getAllByText("healthy").length).toBeGreaterThan(0);
      // CLI providers show "not found" instead of "down"
      expect(screen.getAllByText("not found").length).toBeGreaterThan(0);
    });
  });

  it("shows binary_path for CLI providers", async () => {
    setupFetch([healthRow({ binary_path: "/usr/local/bin/claude" })]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy();
    });
  });

  it("shows endpoint for API providers", async () => {
    setupFetch([apiRow()]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText("https://api.anthropic.com")).toBeTruthy();
    });
  });

  it("shows auth method badge", async () => {
    setupFetch([healthRow({ auth_method: "cli_login" })]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText("cli_login")).toBeTruthy();
    });
  });

  it("shows auth ok badge when auth_present is true", async () => {
    setupFetch([healthRow({ auth_method: "env_var", auth_present: true })]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText(/auth ok/i)).toBeTruthy();
    });
  });

  it("shows auth missing badge when auth not present", async () => {
    setupFetch([healthRow({ auth_method: "env_var", auth_present: false })]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText(/auth missing/i)).toBeTruthy();
    });
  });

  it("shows models list for API providers", async () => {
    setupFetch([apiRow()]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText("claude-opus-4-6")).toBeTruthy();
      expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    });
  });

  it("shows last_error when present", async () => {
    setupFetch([
      healthRow({ status: "down", last_error: "binary not found on PATH" }),
    ]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText("binary not found on PATH")).toBeTruthy();
    });
  });

  it("renders a sparkline SVG for each provider", async () => {
    const events = [
      probeEvent(100, "2026-04-21T09:00:00.000Z"),
      probeEvent(150, "2026-04-21T09:30:00.000Z"),
      probeEvent(120, "2026-04-21T10:00:00.000Z"),
    ];
    setupFetch([healthRow()], events);
    render(<Providers />);
    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='sparkline-claude-code']"),
      ).toBeTruthy();
    });
  });

  it("clicking Re-probe POSTs to /api/providers/probe/:id", async () => {
    const updatedRow = healthRow({ latency_ms: 55, status: "healthy" });
    setupFetch([healthRow({ latency_ms: 120 })], [], updatedRow);

    render(<Providers />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /re-probe/i }).length,
      ).toBeGreaterThan(0),
    );

    const reprobe = screen.getAllByRole("button", { name: /re-probe/i })[0];
    fireEvent.click(reprobe);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/providers/probe/claude-code"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("Edit config button opens the config form", async () => {
    setupFetch([healthRow()]);
    render(<Providers />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /edit config/i }).length,
      ).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /edit config/i })[0]);
    expect(screen.getByRole("textbox", { name: /binary path/i })).toBeTruthy();
  });

  it("config form submit POSTs to /api/providers/configure/:id", async () => {
    setupFetch([healthRow()]);
    render(<Providers />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /edit config/i }).length,
      ).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /edit config/i })[0]);

    const input = screen.getByRole("textbox", { name: /binary path/i });
    fireEvent.change(input, { target: { value: "/opt/homebrew/bin/claude" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/providers/configure/claude-code"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("focused provider card has data-focused attribute", async () => {
    setupFetch([healthRow(), apiRow()]);
    render(<Providers focusedProvider="anthropic-api" />);
    await waitFor(() => {
      const focused = document.querySelector("[data-focused='true']");
      expect(focused).toBeTruthy();
    });
  });

  it("renders setup_hint for each provider card", async () => {
    setupFetch([
      healthRow(),
      healthRow({ provider_id: "codex", transport: "codex" }),
      healthRow({ provider_id: "gemini-cli", transport: "gemini-cli" }),
      apiRow(),
      {
        ...apiRow(),
        provider_id: "openai-api",
        transport: "openai-api",
        endpoint: "https://api.openai.com",
        auth_method: "env_var",
        auth_present: true,
      } as ProviderHealthRow,
    ]);
    render(<Providers />);
    await waitFor(() => {
      // CLI hints
      expect(screen.getByText(/claude login/)).toBeTruthy();
      expect(screen.getByText(/codex login/)).toBeTruthy();
      expect(screen.getByText(/follow the login prompt/)).toBeTruthy();
      // API hints
      expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
      expect(screen.getByText(/OPENAI_API_KEY/)).toBeTruthy();
    });
  });

  it("shows empty state when no providers", async () => {
    setupFetch([]);
    render(<Providers />);
    await waitFor(() => {
      expect(screen.getByText(/no providers/i)).toBeTruthy();
    });
  });
});
