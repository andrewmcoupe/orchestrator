// @vitest-environment jsdom
/**
 * Maintenance subsection tests.
 *
 * Tests: worktree listing, bulk removal, orphan labeling,
 * "safely removable" filter, rebuild projections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Maintenance } from "./Maintenance.js";

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_WORKTREES = {
  worktrees: [
    {
      task_id: "T-001",
      task_title: "Fix login bug",
      task_status: "merged",
      branch: "wt/T-001",
      worktree_path: "/repo/.orchestrator-worktrees/T-001",
      created_days_ago: 10,
      size_display: "4.2 MB",
    },
    {
      task_id: "T-002",
      task_title: "Add feature X",
      task_status: "running",
      branch: "wt/T-002",
      worktree_path: "/repo/.orchestrator-worktrees/T-002",
      created_days_ago: 2,
      size_display: "1.1 MB",
    },
    {
      task_id: "T-GONE",
      task_title: null,
      task_status: "orphaned",
      branch: "wt/T-GONE",
      worktree_path: "/repo/.orchestrator-worktrees/T-GONE",
      created_days_ago: 30,
      size_display: "512 KB",
    },
    {
      task_id: "T-003",
      task_title: "Approved task",
      task_status: "approved",
      branch: "wt/T-003",
      worktree_path: "/repo/.orchestrator-worktrees/T-003",
      created_days_ago: 1,
      size_display: "2.0 MB",
    },
  ],
};

const MOCK_ABOUT = {
  version: "0.1.0",
  event_count: 100,
  db_size_bytes: 2048,
  db_path: "/data/events.db",
  env_local_path: "/orchestrator/.env.local",
  repo_root: "/host/repo",
  projections: ["task_list", "task_detail", "preset"],
};

function mockFetch(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "/api/worktrees": MOCK_WORKTREES,
    "/api/settings/about": MOCK_ABOUT,
    "/api/commands/worktree/remove": { removed: [], errors: [] },
    "/api/maintenance/rebuild-projections": { ok: true, rebuilt: ["task_list", "task_detail", "preset"] },
    ...overrides,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const key = Object.keys(responses).find((k) => url.includes(k));
      const body = key ? responses[key] : {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      });
    }),
  );
}

describe("Maintenance subsection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch();
  });

  it("renders the maintenance section heading", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      expect(screen.getByTestId("maintenance-section")).toBeDefined();
    });
  });

  it("lists worktrees from the API (safely removable ones by default)", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      // T-001 (merged) and T-GONE (orphaned) are safely removable
      expect(screen.getByTestId("worktree-row-T-001")).toBeDefined();
      expect(screen.getByTestId("worktree-row-T-GONE")).toBeDefined();
    });
  });

  it("labels orphaned worktrees clearly", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      const row = screen.getByTestId("worktree-row-T-GONE");
      expect(row.innerHTML).toContain("orphaned");
    });
  });

  it("shows task title and status for correlated worktrees", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      // T-001 (merged) is visible with safe filter on
      expect(screen.getByText("Fix login bug")).toBeDefined();
    });
    // Turn off the filter to also see running task
    fireEvent.click(screen.getByTestId("safe-filter-toggle"));
    await waitFor(() => {
      expect(screen.getByText("Add feature X")).toBeDefined();
    });
  });

  it("shows size on disk for each worktree", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      // T-001 (merged) visible with safe filter on
      expect(screen.getByText("4.2 MB")).toBeDefined();
      expect(screen.getByText("512 KB")).toBeDefined();
    });
  });

  // "Safely removable" filter
  it("filters out running and approved tasks when 'safely removable' is on", async () => {
    render(<Maintenance />);
    await waitFor(() => screen.getByTestId("worktree-row-T-001"));

    // Toggle should be on by default
    const toggle = screen.getByTestId("safe-filter-toggle");
    expect((toggle as HTMLInputElement).checked).toBe(true);

    // Running (T-002) and approved (T-003) should be hidden
    expect(screen.queryByTestId("worktree-row-T-002")).toBeNull();
    expect(screen.queryByTestId("worktree-row-T-003")).toBeNull();

    // Merged (T-001) and orphaned (T-GONE) should be visible
    expect(screen.getByTestId("worktree-row-T-001")).toBeDefined();
    expect(screen.getByTestId("worktree-row-T-GONE")).toBeDefined();
  });

  it("shows all worktrees when 'safely removable' is off", async () => {
    render(<Maintenance />);
    await waitFor(() => screen.getByTestId("worktree-row-T-001"));

    // Turn off the safety filter
    fireEvent.click(screen.getByTestId("safe-filter-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("worktree-row-T-002")).toBeDefined();
      expect(screen.getByTestId("worktree-row-T-003")).toBeDefined();
    });
  });

  // Bulk removal
  it("enables Remove Selected button only when items are checked", async () => {
    render(<Maintenance />);
    await waitFor(() => screen.getByTestId("worktree-row-T-001"));

    const removeBtn = screen.getByTestId("remove-selected-btn");
    expect((removeBtn as HTMLButtonElement).disabled).toBe(true);

    // Check one worktree
    fireEvent.click(screen.getByTestId("select-worktree-T-001"));
    expect((removeBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("posts selected task_ids to the remove endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/worktrees")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKTREES) });
      }
      if (url.includes("/api/commands/worktree/remove")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ removed: ["T-001"], errors: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Maintenance />);
    await waitFor(() => screen.getByTestId("worktree-row-T-001"));

    fireEvent.click(screen.getByTestId("select-worktree-T-001"));
    fireEvent.click(screen.getByTestId("remove-selected-btn"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/commands/worktree/remove",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  // Rebuild projections
  it("shows rebuild projections button", async () => {
    render(<Maintenance />);
    await waitFor(() => {
      expect(screen.getByTestId("rebuild-all-btn")).toBeDefined();
    });
  });

  it("calls rebuild-projections endpoint on button click", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/worktrees")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKTREES) });
      }
      if (url.includes("/api/maintenance/rebuild-projections")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rebuilt: ["task_list"] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Maintenance />);
    await waitFor(() => screen.getByTestId("rebuild-all-btn"));
    fireEvent.click(screen.getByTestId("rebuild-all-btn"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/maintenance/rebuild-projections",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
