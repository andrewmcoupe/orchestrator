// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEventStore } from "../store/eventStore.js";
import { App } from "../App.js";

// Mock fetch so hydrate() doesn't fail on relative URLs in jsdom
const mockFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
);

// Mock EventSource so SSE doesn't explode in jsdom
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  vi.stubGlobal("EventSource", MockEventSource);
  // Reset store between tests
  useEventStore.setState({
    taskList: {},
    taskDetail: {},
    providerHealth: {},
    recentEvents: [],
    hydrated: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App shell", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("renders the top bar with Orchestrator branding", () => {
    renderApp();
    expect(screen.getByText("Orchestrator")).toBeDefined();
  });

  it("renders all five rail items", () => {
    renderApp();
    expect(screen.getAllByText("Tasks").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Prompts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Providers").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Measurement").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
  });

  it("renders four provider pills with fallback data", () => {
    renderApp();
    expect(screen.getByText("claude")).toBeDefined();
    expect(screen.getByText("codex")).toBeDefined();
    expect(screen.getByText("gemini")).toBeDefined();
    expect(screen.getByText("local")).toBeDefined();
  });

  it("renders the event stream strip", () => {
    renderApp();
    expect(screen.getByText("stream")).toBeDefined();
    expect(screen.getByText("filter")).toBeDefined();
  });

  it("defaults to Tasks section content", () => {
    renderApp();
    const headings = screen.getAllByText("Tasks");
    expect(headings.length).toBeGreaterThanOrEqual(2);
  });

  it("clicking a rail item switches section", () => {
    renderApp();
    const promptsBtns = screen.getAllByText("Prompts");
    const railBtn = promptsBtns.find((el) => el.closest("nav button"));
    fireEvent.click(railBtn!);
    expect(window.location.hash).toBe("#/prompts");
  });

  it("provider pills show status dots with fallback unknown status", () => {
    renderApp();
    const claudeEl = screen.getByText("claude").closest("span");
    const dot = claudeEl?.querySelector("span.rounded-full");
    // Fallback providers have "unknown" status which maps to muted
    expect(dot?.className).toContain("bg-status-muted");
  });

  it("keyboard shortcut ⌘2 navigates to prompts", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(window.location.hash).toBe("#/prompts");
  });
});
