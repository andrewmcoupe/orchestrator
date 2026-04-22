// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Ingest } from "./Ingest.js";
import type { PropositionRow } from "@shared/projections.js";

afterEach(cleanup);

// ============================================================================
// Fixtures
// ============================================================================

const mockProp = (overrides: Partial<PropositionRow> = {}): PropositionRow => ({
  proposition_id: "PROP-01JXXXXXXXXXXXXXXXXXXXXXXX",
  prd_id: "PRD-01JXXXXXXXXXXXXXXXXXXXXXXX",
  text: "The system shall allow users to login with email and password.",
  source_span: { section: "Authentication", line_start: 10, line_end: 12 },
  confidence: 0.92,
  active_pushback_ids: [],
  updated_at: "2026-04-21T00:00:00.000Z",
  ...overrides,
});

const mockProp2 = (): PropositionRow => ({
  proposition_id: "PROP-02JXXXXXXXXXXXXXXXXXXXXXXX",
  prd_id: "PRD-01JXXXXXXXXXXXXXXXXXXXXXXX",
  text: "The system shall support OAuth2 via Google.",
  source_span: { section: "Authentication", line_start: 14, line_end: 16 },
  confidence: 0.75,
  active_pushback_ids: [],
  updated_at: "2026-04-21T00:00:00.000Z",
});

const mockIngestResult = {
  prd_id: "PRD-01JXXXXXXXXXXXXXXXXXXXXXXX",
  propositions: [mockProp(), mockProp2()],
  draft_tasks: [
    {
      task_id: "T-01JXXXXXXXXXXXXXXXXXXXXXXXX",
      title: "Implement authentication",
      proposition_ids: [
        "PROP-01JXXXXXXXXXXXXXXXXXXXXXXX",
        "PROP-02JXXXXXXXXXXXXXXXXXXXXXXX",
      ],
    },
  ],
  pushback_count: 0,
};

const mockPushbackEvent = {
  id: "EVT-001",
  type: "pushback.raised" as const,
  aggregate_type: "pushback" as const,
  aggregate_id: "PUSHBACK-001",
  version: 1,
  ts: "2026-04-21T00:00:00.000Z",
  actor: { kind: "system" as const, component: "gate_runner" as const },
  correlation_id: "PRD-01JXXXXXXXXXXXXXXXXXXXXXXX",
  payload: {
    pushback_id: "PUSHBACK-001",
    proposition_id: "PROP-01JXXXXXXXXXXXXXXXXXXXXXXX",
    kind: "blocking" as const,
    rationale: "Spec is ambiguous about password requirements.",
    suggested_resolutions: ["Define min length", "Add complexity rules"],
    raised_by: { phase: "ingest" as const, model: "claude-sonnet-4-6" },
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("Ingest — idle state", () => {
  it("renders path input and ingest button", () => {
    render(<Ingest onBack={vi.fn()} />);
    expect(screen.getByPlaceholderText(/absolute\/path/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /ingest/i })).toBeTruthy();
  });

  it("back button calls onBack", () => {
    const onBack = vi.fn();
    render(<Ingest onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /tasks/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("ingest button is disabled with empty input", () => {
    render(<Ingest onBack={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /^ingest$/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Ingest — loading state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading spinner after clicking Ingest", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));
    await waitFor(() => {
      expect(screen.getByText(/ingesting/i)).toBeTruthy();
    });
  });
});

describe("Ingest — review state (no pushbacks)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/commands/prd/ingest") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockIngestResult),
          });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders draft task card with title after ingest", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText("Implement authentication")).toBeTruthy();
    });
  });

  it("renders proposition text from results", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/login with email and password/i)).toBeTruthy();
    });
  });

  it("renders meta strip with proposition count", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 propositions/i)).toBeTruthy();
    });
  });

  it("shows 'Accept & create 1 task' button", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/accept & create 1 task/i)).toBeTruthy();
    });
  });
});

describe("Ingest — review state with pushbacks", () => {
  beforeEach(() => {
    const resultWithPushback = {
      ...mockIngestResult,
      propositions: [
        mockProp({ active_pushback_ids: ["PUSHBACK-001"] }),
        mockProp2(),
      ],
      pushback_count: 1,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/commands/prd/ingest") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(resultWithPushback),
          });
        }
        if (url.includes("/api/events/recent")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([mockPushbackEvent]),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows pushback rationale", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/ambiguous about password requirements/i)).toBeTruthy();
    });
  });

  it("shows blocking pushback kind pill", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/blocking pushback/i)).toBeTruthy();
    });
  });

  it("Accept button is disabled while blocking pushback is unresolved", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      const btn = screen.getByText(/accept & create/i).closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  it("shows suggested resolutions", async () => {
    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Define min length/i)).toBeTruthy();
    });
  });

  it("defer button resolves pushback", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/commands/prd/ingest") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ...mockIngestResult,
              propositions: [
                mockProp({ active_pushback_ids: ["PUSHBACK-001"] }),
                mockProp2(),
              ],
              pushback_count: 1,
            }),
        });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([mockPushbackEvent]),
        });
      }
      if (url.includes("/api/commands/pushback/") && (opts?.method === "POST")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /defer/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /defer/i }));

    // After deferring, the pushback block should be removed from the DOM
    await waitFor(() => {
      expect(screen.queryByText(/ambiguous about password requirements/i)).toBeNull();
    });
  });
});

describe("Ingest — accept action", () => {
  it("calls task/create and onBack after accepting", async () => {
    const onBack = vi.fn();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/commands/prd/ingest") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockIngestResult),
        });
      }
      if (url.includes("/api/events/recent")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url === "/api/commands/task/create") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ task_id: "T-001" }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Ingest onBack={onBack} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/prd.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/accept & create 1 task/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/accept & create 1 task/i).closest("button")!);

    await waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });

    const createCalls = (fetchMock.mock.calls as [string, ...unknown[]][]).filter(
      ([url]) => url === "/api/commands/task/create",
    );
    expect(createCalls).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe("Ingest — error handling", () => {
  it("shows error message when ingest fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: "File not found" }),
      }),
    );

    render(<Ingest onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/absolute\/path/i), {
      target: { value: "/tmp/nonexistent.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^ingest$/i }));

    await waitFor(() => {
      expect(screen.getByText(/file not found/i)).toBeTruthy();
    });

    vi.unstubAllGlobals();
  });
});
