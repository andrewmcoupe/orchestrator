// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useEventStore } from "../store/eventStore";
import { NoProvidersBanner } from "./NoProvidersBanner";
import type { ProviderHealthRow } from "@shared/projections.js";

// Minimal TanStack Router Link mock
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function setStoreState(rows: ProviderHealthRow[], hydrated: boolean) {
  useEventStore.setState({
    providerHealth: Object.fromEntries(rows.map((r) => [r.provider_id, r])),
    hydrated,
    taskList: {},
    taskDetail: {},
    recentEvents: [],
  });
}

const makeRow = (overrides: Partial<ProviderHealthRow> = {}): ProviderHealthRow => ({
  provider_id: "claude-code",
  transport: "claude-code",
  status: "down",
  latency_ms: undefined,
  last_probe_at: undefined,
  last_error: undefined,
  models: undefined,
  binary_path: undefined,
  endpoint: undefined,
  auth_method: "cli_login",
  auth_present: false,
  ...overrides,
});

describe("NoProvidersBanner", () => {
  beforeEach(() => {
    useEventStore.setState({
      taskList: {},
      taskDetail: {},
      providerHealth: {},
      recentEvents: [],
      hydrated: false,
    });
  });

  it("does not render while hydrating", () => {
    setStoreState([], false);
    render(<NoProvidersBanner />);
    expect(screen.queryByTestId("no-providers-banner")).toBeNull();
  });

  it("does not render when no provider rows exist yet (still loading)", () => {
    setStoreState([], true);
    render(<NoProvidersBanner />);
    expect(screen.queryByTestId("no-providers-banner")).toBeNull();
  });

  it("renders when all providers are unavailable", () => {
    setStoreState(
      [
        makeRow({ provider_id: "claude-code", auth_present: false, status: "down" }),
        makeRow({ provider_id: "anthropic-api", transport: "anthropic-api", auth_present: false, status: "down" }),
      ],
      true,
    );
    render(<NoProvidersBanner />);
    expect(screen.getByTestId("no-providers-banner")).toBeTruthy();
    expect(screen.getByText("No AI providers available.")).toBeTruthy();
    expect(screen.getByText("Open provider settings")).toBeTruthy();
  });

  it("does not render when any provider has auth_present=true", () => {
    setStoreState(
      [
        makeRow({ provider_id: "claude-code", auth_present: true, status: "down" }),
        makeRow({ provider_id: "anthropic-api", transport: "anthropic-api", auth_present: false, status: "down" }),
      ],
      true,
    );
    render(<NoProvidersBanner />);
    expect(screen.queryByTestId("no-providers-banner")).toBeNull();
  });

  it("does not render when any provider has status=healthy", () => {
    setStoreState(
      [
        makeRow({ provider_id: "claude-code", auth_present: false, status: "healthy" }),
        makeRow({ provider_id: "anthropic-api", transport: "anthropic-api", auth_present: false, status: "down" }),
      ],
      true,
    );
    render(<NoProvidersBanner />);
    expect(screen.queryByTestId("no-providers-banner")).toBeNull();
  });

  it("CTA links to /providers", () => {
    setStoreState(
      [makeRow({ provider_id: "claude-code", auth_present: false, status: "down" })],
      true,
    );
    render(<NoProvidersBanner />);
    const link = screen.getByText("Open provider settings");
    expect(link.closest("a")?.getAttribute("href")).toBe("/providers");
  });
});
