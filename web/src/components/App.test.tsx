// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { useEventStore } from "../store/eventStore";
import { routeTree } from "../routeTree.gen";

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

async function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe("App shell", () => {
  it("renders the top bar with Orchestrator branding", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("Orchestrator")).toBeDefined();
    });
  });

  it("renders all five rail items", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getAllByText("Tasks").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("Prompts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Providers").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Measurement").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
  });

  it("renders four provider pills with fallback data", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("claude")).toBeDefined();
    });
    expect(screen.getByText("codex")).toBeDefined();
    expect(screen.getByText("gemini")).toBeDefined();
    expect(screen.getByText("local")).toBeDefined();
  });

  it("renders the event stream strip", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("stream")).toBeDefined();
    });
  });

  it("defaults to Tasks section content", async () => {
    await renderApp();
    await waitFor(() => {
      const headings = screen.getAllByText("Tasks");
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("rail items are rendered as Link elements", async () => {
    await renderApp();
    await waitFor(() => {
      const promptsLinks = screen.getAllByText("Prompts");
      const railLink = promptsLinks.find((el) => el.closest("nav a"));
      expect(railLink).toBeDefined();
    });
  });

  it("provider pills show status dots with fallback unknown status", async () => {
    await renderApp();
    await waitFor(() => {
      const claudeEl = screen.getByText("claude").closest("span");
      const dot = claudeEl?.querySelector("span.rounded-full");
      // Fallback providers have "unknown" status which maps to muted
      expect(dot?.className).toContain("bg-status-muted");
    });
  });
});
