// @vitest-environment jsdom
/**
 * Tests for the Review — Diff Review Screen
 * Route: #/tasks/:taskId/review/:attemptId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Review } from "./Review.js";
import type { AttemptRow } from "@shared/projections.js";

// ============================================================================
// Fixtures
// ============================================================================

const BASE_ATTEMPT: AttemptRow = {
  attempt_id: "ATT-001",
  task_id: "T-001",
  attempt_number: 1,
  status: "completed",
  outcome: "approved",
  started_at: "2026-04-21T10:00:00.000Z",
  completed_at: "2026-04-21T10:05:00.000Z",
  duration_ms: 300_000,
  tokens_in_total: 1500,
  tokens_out_total: 800,
  cost_usd_total: 0.025,
  phases: {
    implementer: {
      phase_name: "implementer",
      status: "succeeded",
      model: "anthropic-api/claude-sonnet-4-6",
      prompt_version_id: "pv-001",
      tokens_in: 1500,
      tokens_out: 800,
      cost_usd: 0.025,
      duration_ms: 300_000,
    },
  },
  gate_runs: [
    { gate_run_id: "gr-001", gate_name: "tsc", status: "passed", duration_ms: 12_000 },
    { gate_run_id: "gr-002", gate_name: "eslint", status: "failed", duration_ms: 8_000, failure_count: 2 },
  ],
  audit: {
    verdict: "approve",
    confidence: 0.92,
    concern_count: 1,
    blocking_count: 0,
    concerns: [
      {
        category: "style",
        severity: "advisory",
        anchor: { path: "src/foo.ts", line: 42 },
        rationale: "Variable name could be more descriptive",
      },
    ],
    overridden: false,
  },
  files_changed: [
    { path: "src/foo.ts", operation: "update", lines_added: 10, lines_removed: 3 },
    { path: "src/bar.ts", operation: "create", lines_added: 25, lines_removed: 0 },
  ],
  config_snapshot: {
    phases: [
      {
        name: "implementer" as const,
        enabled: true,
        transport: "anthropic-api" as const,
        model: "claude-sonnet-4-6",
        prompt_version_id: "pv-001",
        transport_options: { kind: "api" as const, max_tokens: 8192 },
        context_policy: { symbol_graph_depth: 1, include_tests: false, include_similar_patterns: false, token_budget: 4096 },
      },
    ],
    gates: [],
    retry_policy: {
      max_total_attempts: 3,
      on_typecheck_fail: { strategy: "retry_same" as const, max_attempts: 2 },
      on_test_fail: { strategy: "retry_same" as const, max_attempts: 2 },
      on_audit_reject: "escalate_to_human" as const,
      on_spec_pushback: "pause_and_notify" as const,
    },
  },
  last_event_id: "ev-999",
};

const REVISE_ATTEMPT: AttemptRow = {
  ...BASE_ATTEMPT,
  attempt_id: "ATT-002",
  outcome: "revised",
  audit: {
    verdict: "revise",
    confidence: 0.75,
    concern_count: 2,
    blocking_count: 1,
    concerns: [
      {
        category: "correctness",
        severity: "blocking",
        anchor: { path: "src/foo.ts", line: 15 },
        rationale: "Off-by-one error in loop boundary",
        reference_proposition_id: "P-001",
      },
      {
        category: "nit",
        severity: "advisory",
        rationale: "Trailing whitespace",
      },
    ],
    overridden: false,
  },
};

const REJECT_ATTEMPT: AttemptRow = {
  ...BASE_ATTEMPT,
  attempt_id: "ATT-003",
  outcome: "rejected",
  audit: {
    verdict: "reject",
    confidence: 0.95,
    concern_count: 3,
    blocking_count: 3,
    concerns: [],
    overridden: false,
  },
};

// Mock fetch returning attempt data
function mockFetchAttempt(attempt: AttemptRow) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(attempt),
        });
      }
      if (url.includes("/api/projections/task_detail/")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ task_id: attempt.task_id, title: "Add user auth feature" }),
        });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: "ev-100",
                type: "invocation.file_edited",
                aggregate_type: "invocation",
                aggregate_id: "inv-001",
                version: 1,
                ts: "2026-04-21T10:02:00.000Z",
                actor_json: "{}",
                correlation_id: attempt.attempt_id,
                payload_json: JSON.stringify({
                  invocation_id: "inv-001",
                  path: "src/foo.ts",
                  operation: "update",
                  patch_hash: "abc123",
                  lines_added: 10,
                  lines_removed: 3,
                }),
              },
            ]),
        });
      }
      if (url.includes("/api/blobs/")) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,3 +10,10 @@\n context line\n-removed line\n+added line\n+another added line\n"),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }),
  );
}

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ============================================================================
// Tests — loading state
// ============================================================================

describe("Review — loading state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {
        // never resolves — stays loading
      })),
    );
  });

  it("renders loading spinner while fetching attempt", () => {
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

// ============================================================================
// Tests — not found state
// ============================================================================

describe("Review — not found", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
      ),
    );
  });

  it("renders error state when attempt does not exist", async () => {
    render(<Review taskId="T-001" attemptId="MISSING" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/not found/i));
    expect(screen.getByText(/not found/i)).toBeTruthy();
  });
});

// ============================================================================
// Tests — verdict cards
// ============================================================================

describe("Review — verdict cards", () => {
  it("renders approve verdict with success styling", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    const verdictCard = screen.getByTestId("verdict-card");
    expect(verdictCard.className).toMatch(/healthy|success|green/i);
  });

  it("renders revise verdict with warning styling", async () => {
    mockFetchAttempt(REVISE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-002" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    const verdictCard = screen.getByTestId("verdict-card");
    expect(verdictCard.className).toMatch(/warning|amber|yellow/i);
  });

  it("renders reject verdict with danger styling", async () => {
    mockFetchAttempt(REJECT_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-003" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    const verdictCard = screen.getByTestId("verdict-card");
    expect(verdictCard.className).toMatch(/danger|red/i);
  });

  it("renders confidence percentage", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/92%/));
    expect(screen.getByText(/92%/)).toBeTruthy();
  });
});

// ============================================================================
// Tests — concerns list
// ============================================================================

describe("Review — concerns", () => {
  it("renders concern with category pill and severity pill", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/style/i));
    expect(screen.getByText(/advisory/i)).toBeTruthy();
    expect(screen.getByText(/Variable name could be more descriptive/)).toBeTruthy();
  });

  it("renders concern anchor as a path:line link", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/src\/foo\.ts:42/));
    expect(screen.getByText(/src\/foo\.ts:42/)).toBeTruthy();
  });

  it("renders blocking concern with danger styling", async () => {
    mockFetchAttempt(REVISE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-002" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/blocking/i));
    expect(screen.getByText(/Off-by-one error/)).toBeTruthy();
    expect(screen.getByText(/correctness/i)).toBeTruthy();
  });
});

// ============================================================================
// Tests — gates strip
// ============================================================================

describe("Review — gates strip", () => {
  it("renders gate pills with status and duration", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("gate-tsc"));
    expect(screen.getByTestId("gate-tsc")).toBeTruthy();
    expect(screen.getByTestId("gate-eslint")).toBeTruthy();
  });

  it("renders passed gates with success styling", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("gate-tsc"));
    const tscPill = screen.getByTestId("gate-tsc");
    expect(tscPill.className).toMatch(/healthy|success|green/i);
  });

  it("renders failed gates with danger styling", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("gate-eslint"));
    const eslintPill = screen.getByTestId("gate-eslint");
    expect(eslintPill.className).toMatch(/danger|red/i);
  });
});

// ============================================================================
// Tests — file tabs
// ============================================================================

describe("Review — file tabs", () => {
  it("renders a tab per changed file with +N/-M counts", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText("src/foo.ts"));
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.getByText("src/bar.ts")).toBeTruthy();
    // Check +10/-3 counts for foo.ts
    expect(screen.getByText("+10")).toBeTruthy();
    expect(screen.getByText("-3")).toBeTruthy();
  });

  it("loads diff content from blob store when a file tab is clicked", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText("src/foo.ts"));
    fireEvent.click(screen.getByText("src/foo.ts"));
    await waitFor(() => screen.getByText("another added line"));
    expect(screen.getByText("another added line")).toBeTruthy();
  });
});

// ============================================================================
// Tests — meta strip
// ============================================================================

describe("Review — meta strip", () => {
  it("renders attempt number pill", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("attempt-pill"));
    expect(screen.getByTestId("attempt-pill").textContent).toBe("#1");
  });

  it("renders token counts", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    // toLocaleString may format as 1,500 or 1500 depending on locale
    await waitFor(() => screen.getByText(/1[,.]?500/));
    expect(screen.getByText(/1[,.]?500/)).toBeTruthy();
  });

  it("renders cost", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/\$0\.025/));
    expect(screen.getByText(/\$0\.025/)).toBeTruthy();
  });
});

// ============================================================================
// Tests — action buttons
// ============================================================================

describe("Review — action buttons", () => {
  it("Approve as-is button POSTs to approve endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      }
      if (url.includes("/api/projections/task_detail/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Test task" }) });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/approve as-is/i));
    fireEvent.click(screen.getByText(/approve as-is/i));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/attempt/ATT-001/approve") && opts?.method === "POST",
      ),
    );
  });

  it("Reject task button POSTs to reject endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      }
      if (url.includes("/api/projections/task_detail/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Test task" }) });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/reject task/i));
    fireEvent.click(screen.getByText(/reject task/i));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/attempt/ATT-001/reject") && opts?.method === "POST",
      ),
    );
  });

  it("Retry with feedback button POSTs to retry-with-feedback endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(REVISE_ATTEMPT) });
      }
      if (url.includes("/api/projections/task_detail/")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Test task" }) });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-002" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/retry with feedback/i));
    fireEvent.click(screen.getByText(/retry with feedback/i));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/attempt/ATT-002/retry-with-feedback") && opts?.method === "POST",
      ),
    );
  });

  it("back button calls onBack", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    const onBack = vi.fn();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={onBack} />);
    await waitFor(() => screen.getByTestId("back-btn"));
    fireEvent.click(screen.getByTestId("back-btn"));
    expect(onBack).toHaveBeenCalled();
  });
});

// ============================================================================
// Tests — approved task state footer
// ============================================================================

describe("Review — approved task footer", () => {
  function mockApproved(overrides: Record<string, unknown> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
        }
        if (url.includes("/api/projections/task_detail/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                task_id: "T-001",
                title: "Add user auth feature",
                status: "approved",
                updated_at: "2026-04-21T10:10:00.000Z",
                worktree_path: "/tmp/.orchestrator-worktrees/T-001",
                ...overrides,
              }),
          });
        }
        if (url.includes("/api/repo/current-branch")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: "main" }) });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  }

  it("shows Merge button with target branch when task is approved", async () => {
    mockApproved();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-approved"));
    expect(screen.getByTestId("footer-approved")).toBeTruthy();
    // Branch label is fetched async — wait for it to populate in the Merge button
    await waitFor(() => {
      const btn = screen.getByText(/Merge into/i);
      if (!btn.textContent?.includes("main")) throw new Error("branch not yet loaded");
    });
  });

  it("shows Unapprove button when task is approved", async () => {
    mockApproved();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-approved"));
    expect(screen.getByText(/Unapprove/i)).toBeTruthy();
  });

  it("shows Open in editor button when task has a worktree", async () => {
    mockApproved();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-approved"));
    expect(screen.getByTestId("open-in-editor-btn")).toBeTruthy();
  });

  it("Unapprove POSTs to unapprove endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      if (url.includes("/api/projections/task_detail/"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ task_id: "T-001", title: "Test", status: "approved", updated_at: "2026-04-21T10:10:00.000Z" }),
        });
      if (url.includes("/api/repo/current-branch"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: "main" }) });
      if (url.includes("/api/events/recent"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/Unapprove/i));
    fireEvent.click(screen.getByText(/Unapprove/i));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/attempt/ATT-001/unapprove") && opts?.method === "POST",
      ),
    );
  });

  it("Merge button POSTs to merge endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      if (url.includes("/api/projections/task_detail/"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ task_id: "T-001", title: "Test", status: "approved", updated_at: "2026-04-21T10:10:00.000Z" }),
        });
      if (url.includes("/api/repo/current-branch"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: "main" }) });
      if (url.includes("/api/events/recent"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByText(/Merge into/i));
    fireEvent.click(screen.getAllByText(/Merge into/i)[0]);

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url, opts]) =>
          url.includes("/api/commands/task/T-001/merge") && opts?.method === "POST",
      ),
    );
  });

  it("shows approved summary strip with time ago", async () => {
    mockApproved();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-approved"));
    // Should show some indication of approval time
    expect(screen.getByTestId("approved-summary-strip")).toBeTruthy();
  });

  it("Open in editor calls worktree open endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      if (url.includes("/api/projections/task_detail/"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ task_id: "T-001", title: "Test", status: "approved", updated_at: "2026-04-21T10:10:00.000Z", worktree_path: "/tmp/wt" }),
        });
      if (url.includes("/api/repo/current-branch"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ branch: "main" }) });
      if (url.includes("/api/events/recent"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("open-in-editor-btn"));
    fireEvent.click(screen.getByTestId("open-in-editor-btn"));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url]) => url.includes("/api/worktree/T-001/open"),
      ),
    );
  });
});

// ============================================================================
// Tests — merged task state footer
// ============================================================================

describe("Review — merged task footer", () => {
  function mockMerged() {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
        }
        if (url.includes("/api/projections/task_detail/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                task_id: "T-001",
                title: "Add user auth feature",
                status: "merged",
                updated_at: "2026-04-21T10:15:00.000Z",
                merge_commit_sha: "abc1234def5678",
                merged_into_branch: "main",
              }),
          });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  }

  it("shows read-only merged footer when task is merged", async () => {
    mockMerged();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-merged"));
    expect(screen.getByTestId("footer-merged")).toBeTruthy();
  });

  it("shows merged branch name in footer", async () => {
    mockMerged();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-merged"));
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  it("shows short commit sha in merged footer", async () => {
    mockMerged();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-merged"));
    // First 7 chars of merge_commit_sha
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });

  it("does not show Merge or Unapprove buttons when task is merged", async () => {
    mockMerged();
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-merged"));
    expect(screen.queryByText(/Merge into/i)).toBeNull();
    expect(screen.queryByText(/Unapprove/i)).toBeNull();
  });
});

// ============================================================================
// Tests — awaiting_review state includes Manual edit button
// ============================================================================

describe("Review — awaiting_review Manual edit button", () => {
  it("shows Manual edit button in awaiting_review state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
        if (url.includes("/api/projections/task_detail/"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                task_id: "T-001",
                title: "Test",
                status: "awaiting_review",
                updated_at: "2026-04-21T10:00:00.000Z",
                worktree_path: "/tmp/wt",
              }),
          });
        if (url.includes("/api/events/recent"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("footer-awaiting-review"));
    expect(screen.getByTestId("manual-edit-btn")).toBeTruthy();
  });

  it("Manual edit button calls open endpoint", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/projections/attempt/"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(BASE_ATTEMPT) });
      if (url.includes("/api/projections/task_detail/"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ task_id: "T-001", title: "Test", status: "awaiting_review", updated_at: "2026-04-21T10:00:00.000Z", worktree_path: "/tmp/wt" }),
        });
      if (url.includes("/api/events/recent"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("manual-edit-btn"));
    fireEvent.click(screen.getByTestId("manual-edit-btn"));

    await waitFor(() =>
      (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
        ([url]) => url.includes("/api/worktree/T-001/open"),
      ),
    );
  });
});

// ============================================================================
// Tests — phase strip with A/B variant badge
// ============================================================================

describe("Review — phase strip A/B variant", () => {
  it("renders phase strip with variant A badge when ab_variant is set", async () => {
    const attemptWithAb: AttemptRow = {
      ...BASE_ATTEMPT,
      phases: {
        implementer: {
          ...BASE_ATTEMPT.phases.implementer,
          ab_variant: "A",
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve(attemptWithAb) });
        if (url.includes("/api/projections/task_detail/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Test" }) });
        if (url.includes("/api/events/recent"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }),
    );

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("ab-variant-implementer"));
    const badge = screen.getByTestId("ab-variant-implementer");
    expect(badge.textContent).toBe("A");
  });

  it("renders variant B badge when ab_variant is B", async () => {
    const attemptWithAbB: AttemptRow = {
      ...BASE_ATTEMPT,
      phases: {
        implementer: {
          ...BASE_ATTEMPT.phases.implementer,
          ab_variant: "B",
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve(attemptWithAbB) });
        if (url.includes("/api/projections/task_detail/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Test" }) });
        if (url.includes("/api/events/recent"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }),
    );

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("ab-variant-implementer"));
    const badge = screen.getByTestId("ab-variant-implementer");
    expect(badge.textContent).toBe("B");
  });

  it("does not render variant badge when ab_variant is not set", async () => {
    mockFetchAttempt(BASE_ATTEMPT); // BASE_ATTEMPT has no ab_variant
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    expect(screen.queryByTestId("ab-variant-implementer")).toBeNull();
  });
});

// ============================================================================
// Tests — shadow mode "would have auto-merged" note
// ============================================================================

describe("Review — shadow mode auto-merge note", () => {
  it("shows 'would have auto-merged' note when task has shadow_mode policy and attempt succeeded", async () => {
    const shadowAttempt: AttemptRow = {
      ...BASE_ATTEMPT,
      config_snapshot: {
        ...BASE_ATTEMPT.config_snapshot,
        auto_merge_policy: "on_full_pass",
        shadow_mode: true,
      },
    };
    // Mock fetching with would_auto_merge event in recent events
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/projections/attempt/"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve(shadowAttempt) });
        if (url.includes("/api/projections/task_detail/"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              task_id: "T-001",
              title: "Shadow task",
              status: "awaiting_review",
            }),
          });
        if (url.includes("/api/events/recent"))
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }),
    );

    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    expect(screen.getByTestId("would-auto-merge-note")).toBeDefined();
    expect(screen.getByTestId("would-auto-merge-note").textContent).toContain("would have auto-merged");
  });

  it("does not show note when shadow_mode is false", async () => {
    mockFetchAttempt(BASE_ATTEMPT);
    render(<Review taskId="T-001" attemptId="ATT-001" onBack={() => {}} />);
    await waitFor(() => screen.getByTestId("verdict-card"));
    expect(screen.queryByTestId("would-auto-merge-note")).toBeNull();
  });
});
