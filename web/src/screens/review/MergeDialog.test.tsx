// @vitest-environment jsdom
/**
 * Tests for MergeDialog — merge confirmation modal.
 *
 * Follows the tracer-bullet TDD pattern: each test was written to drive
 * the corresponding piece of implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MergeDialog } from "./MergeDialog.js";
import type { GateRunSummary } from "@shared/projections.js";

// ============================================================================
// Fixtures
// ============================================================================

const SQUASH_GATE_RUNS: GateRunSummary[] = [
  { gate_run_id: "gr-001", gate_name: "tsc", status: "passed", duration_ms: 12_000 },
  { gate_run_id: "gr-002", gate_name: "eslint", status: "passed", duration_ms: 8_000 },
];

const BASE_PROPS = {
  taskId: "T-001",
  taskTitle: "Add user authentication",
  currentBranch: "main",
  priorGateRuns: SQUASH_GATE_RUNS,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

/** Set up fetch mock with configurable merge outcome */
function mockFetch(mergeOutcome: unknown, strategy = "squash") {
  return vi.fn((url: string, opts?: RequestInit) => {
    if (url.includes("/api/config/on_merge")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ strategy, auto_delete_worktree: true, preserve_branch: false }),
      });
    }
    if (url.includes("/api/commands/task/") && opts?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mergeOutcome),
      });
    }
    if (url.includes("/api/worktree/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ opened: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ============================================================================
// Tests — confirming state
// ============================================================================

describe("MergeDialog — confirming state", () => {
  // TRACER BULLET: basic render
  it("renders the dialog heading", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("merge-dialog"));
    expect(screen.getByTestId("merge-dialog")).toBeTruthy();
  });

  it("shows target branch in the title", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByText(/merge into/i));
    expect(screen.getByText(/main/i)).toBeTruthy();
  });

  it("prefills commit message textarea with task title (squash strategy)", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("commit-message-input"));
    const textarea = screen.getByTestId("commit-message-input") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Add user authentication");
  });

  it("commit message textarea is editable for squash strategy", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }, "squash"));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("commit-message-input"));
    const textarea = screen.getByTestId("commit-message-input") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
  });

  it("commit message textarea is read-only for merge strategy", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }, "merge"));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("commit-message-input"));
    const textarea = screen.getByTestId("commit-message-input") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
  });

  it("shows gate preview list from priorGateRuns", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("gate-preview-list"));
    expect(screen.getByText("tsc")).toBeTruthy();
    expect(screen.getByText("eslint")).toBeTruthy();
  });

  it("shows estimated gate duration from prior runs", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("gate-preview-list"));
    // 12s and 8s should appear as estimates
    expect(screen.getByText(/12s|12,000|0:12/)).toBeTruthy();
  });

  it("Cancel button calls onClose", async () => {
    const onClose = vi.fn();
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }));
    render(<MergeDialog {...BASE_PROPS} onClose={onClose} />);
    await waitFor(() => screen.getByTestId("cancel-btn"));
    fireEvent.click(screen.getByTestId("cancel-btn"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows strategy badge", async () => {
    vi.stubGlobal("fetch", mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" }, "squash"));
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("strategy-badge"));
    expect(screen.getByTestId("strategy-badge").textContent).toMatch(/squash/i);
  });
});

// ============================================================================
// Tests — confirm merge action
// ============================================================================

describe("MergeDialog — confirm merge", () => {
  it("Confirm merge button POSTs to /api/commands/task/:id/merge", async () => {
    const fetchMock = mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" });
    vi.stubGlobal("fetch", fetchMock);
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/task/T-001/merge") && opts?.method === "POST",
      ),
    );
  });

  it("sends commit message in the POST body for squash strategy", async () => {
    const fetchMock = mockFetch({ outcome: "merged", merge_commit_sha: "abc1234" });
    vi.stubGlobal("fetch", fetchMock);
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));

    // Edit commit message first
    const textarea = screen.getByTestId("commit-message-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Custom commit message" } });
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => {
      const mergeCall = (fetchMock.mock.calls as Array<[string, RequestInit?]>).find(
        ([url, opts]) => url.includes("/api/commands/task/T-001/merge") && opts?.method === "POST",
      );
      if (!mergeCall) throw new Error("merge call not found");
      const body = JSON.parse(mergeCall[1]?.body as string ?? "{}");
      if (!body.commit_message?.includes("Custom commit message")) {
        throw new Error("commit_message not in body");
      }
    });
  });

  it("shows merging progress state while POST is in-flight", async () => {
    let resolveMerge!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/config/on_merge")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ strategy: "squash" }) });
        }
        if (url.includes("/api/commands/task/")) {
          return new Promise((resolve) => {
            resolveMerge = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("merging-progress"));
    expect(screen.getByTestId("merging-progress")).toBeTruthy();

    // Clean up the dangling promise
    resolveMerge({ ok: true, json: () => Promise.resolve({ outcome: "merged", merge_commit_sha: "abc" }) });
  });
});

// ============================================================================
// Tests — drifted outcome
// ============================================================================

describe("MergeDialog — drifted", () => {
  it("shows drift warning when POST returns drifted outcome", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ outcome: "drifted", commits_ahead: 3, can_merge_anyway: true }),
    );
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("drift-warning"));
    expect(screen.getByTestId("drift-warning")).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it("shows Merge anyway and Cancel buttons in drift warning", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ outcome: "drifted", commits_ahead: 2, can_merge_anyway: true }),
    );
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("drift-warning"));
    expect(screen.getByTestId("merge-anyway-btn")).toBeTruthy();
    expect(screen.getByTestId("cancel-btn")).toBeTruthy();
  });

  it("Merge anyway button re-POSTs with force=true", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((url: string) => {
        // Config fetch
        if (url.includes("/api/config/on_merge")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ strategy: "squash" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      })
      .mockImplementationOnce(() =>
        // First merge call → drifted
        Promise.resolve({ ok: true, json: () => Promise.resolve({ outcome: "drifted", commits_ahead: 2, can_merge_anyway: true }) }),
      )
      .mockImplementationOnce(() =>
        // Second merge call → merged
        Promise.resolve({ ok: true, json: () => Promise.resolve({ outcome: "merged", merge_commit_sha: "abc1234" }) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("merge-anyway-btn"));
    fireEvent.click(screen.getByTestId("merge-anyway-btn"));

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const forceCall = calls.find(
        ([url, opts]) =>
          url.includes("/api/commands/task/T-001/merge") &&
          opts?.method === "POST" &&
          JSON.parse(opts?.body as string ?? "{}").force === true,
      );
      if (!forceCall) throw new Error("force POST not found");
    });
  });
});

// ============================================================================
// Tests — conflicted outcome
// ============================================================================

describe("MergeDialog — conflicted", () => {
  it("shows conflict view with conflicting_paths when POST returns conflicted", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ outcome: "conflicted", conflicting_paths: ["src/foo.ts", "src/bar.ts"] }),
    );
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("conflict-view"));
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.getByText("src/bar.ts")).toBeTruthy();
  });

  it("shows Open worktree in editor button in conflict view", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ outcome: "conflicted", conflicting_paths: ["src/foo.ts"] }),
    );
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("open-editor-conflict-btn"));
    expect(screen.getByTestId("open-editor-conflict-btn")).toBeTruthy();
  });

  it("Open worktree in editor calls /api/worktree/:taskId/open", async () => {
    const fetchMock = mockFetch({ outcome: "conflicted", conflicting_paths: ["src/foo.ts"] });
    vi.stubGlobal("fetch", fetchMock);
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("open-editor-conflict-btn"));
    fireEvent.click(screen.getByTestId("open-editor-conflict-btn"));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url]) => url.includes("/api/worktree/T-001/open"),
      ),
    );
  });

  it("Retry merge button re-POSTs merge from conflict view", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((url: string) => {
        if (url.includes("/api/config/on_merge")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ strategy: "squash" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      })
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ outcome: "conflicted", conflicting_paths: ["src/foo.ts"] }) }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ outcome: "merged", merge_commit_sha: "abc1234" }) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("retry-merge-btn"));
    fireEvent.click(screen.getByTestId("retry-merge-btn"));

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const mergeCalls = calls.filter(
        ([url, opts]) => url.includes("/api/commands/task/T-001/merge") && opts?.method === "POST",
      );
      if (mergeCalls.length < 2) throw new Error("retry POST not found");
    });
  });
});

// ============================================================================
// Tests — gate_failed outcome
// ============================================================================

describe("MergeDialog — gate_failed", () => {
  it("shows gate failure detail when POST returns gate_failed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        outcome: "gate_failed",
        failures: [{ category: "typecheck", excerpt: "Type 'string' is not assignable to 'number'" }],
      }),
    );
    render(<MergeDialog {...BASE_PROPS} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("gate-failed-view"));
    expect(screen.getByText(/Type 'string' is not assignable/)).toBeTruthy();
  });

  it("Back to review button calls onClose in gate_failed state", async () => {
    const onClose = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch({ outcome: "gate_failed", failures: [{ category: "test", excerpt: "test failed" }] }),
    );
    render(<MergeDialog {...BASE_PROPS} onClose={onClose} />);
    await waitFor(() => screen.getByTestId("confirm-merge-btn"));
    fireEvent.click(screen.getByTestId("confirm-merge-btn"));

    await waitFor(() => screen.getByTestId("back-to-review-btn"));
    fireEvent.click(screen.getByTestId("back-to-review-btn"));
    expect(onClose).toHaveBeenCalled();
  });
});
