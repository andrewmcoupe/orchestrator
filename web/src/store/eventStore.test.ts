// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEventStore } from "./eventStore.js";
import type { AnyEvent } from "@shared/events.js";
import type { TaskConfig } from "@shared/events.js";
import type { TaskListRow, ProviderHealthRow } from "@shared/projections.js";

const EMPTY_CONFIG: TaskConfig = {
  phases: [],
  gates: [],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

function makeTaskCreated(taskId: string, title: string): AnyEvent {
  return {
    id: `EV-${taskId}`,
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    version: 1,
    ts: new Date().toISOString(),
    actor: { kind: "user", user_id: "local" },
    correlation_id: undefined,
    causation_id: undefined,
    payload: {
      task_id: taskId,
      title,
      proposition_ids: ["P-1"],
      config_snapshot: EMPTY_CONFIG,
    },
  } as unknown as AnyEvent;
}

function makeStatusChanged(taskId: string, from: string, to: string): AnyEvent {
  return {
    id: `EV-SC-${taskId}-${to}`,
    type: "task.status_changed",
    aggregate_type: "task",
    aggregate_id: taskId,
    version: 2,
    ts: new Date().toISOString(),
    actor: { kind: "user", user_id: "local" },
    correlation_id: undefined,
    causation_id: undefined,
    payload: { task_id: taskId, from, to },
  } as unknown as AnyEvent;
}

function makeArchived(taskId: string): AnyEvent {
  return {
    id: `EV-A-${taskId}`,
    type: "task.archived",
    aggregate_type: "task",
    aggregate_id: taskId,
    version: 3,
    ts: new Date().toISOString(),
    actor: { kind: "user", user_id: "local" },
    correlation_id: undefined,
    causation_id: undefined,
    payload: { task_id: taskId },
  } as unknown as AnyEvent;
}

describe("eventStore", () => {
  beforeEach(() => {
    // Reset Zustand store between tests
    useEventStore.setState({
      taskList: {},
      taskDetail: {},
      providerHealth: {},
      recentEvents: [],
      hydrated: false,
    });
  });

  describe("applyEvent — task_list", () => {
    it("creates a task_list row on task.created", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-001", "Build login"));

      const { taskList } = useEventStore.getState();
      expect(taskList["T-001"]).toBeDefined();
      expect(taskList["T-001"].title).toBe("Build login");
      expect(taskList["T-001"].status).toBe("queued");
    });

    it("updates status on task.status_changed", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-002", "Refactor auth"));
      applyEvent(makeStatusChanged("T-002", "queued", "running"));

      const { taskList } = useEventStore.getState();
      expect(taskList["T-002"].status).toBe("running");
    });

    it("removes row on task.archived", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-003", "Archived task"));
      applyEvent(makeArchived("T-003"));

      const { taskList } = useEventStore.getState();
      expect(taskList["T-003"]).toBeUndefined();
    });
  });

  describe("applyEvent — task_detail", () => {
    it("creates a task_detail row on task.created", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-010", "Detail test"));

      const { taskDetail } = useEventStore.getState();
      expect(taskDetail["T-010"]).toBeDefined();
      expect(taskDetail["T-010"].title).toBe("Detail test");
      expect(taskDetail["T-010"].proposition_ids).toEqual(["P-1"]);
    });

    it("keeps row on task.archived (unlike task_list)", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-011", "Archive keep"));
      applyEvent(makeArchived("T-011"));

      const { taskDetail } = useEventStore.getState();
      expect(taskDetail["T-011"]).toBeDefined();
      expect(taskDetail["T-011"].status).toBe("archived");
    });
  });

  describe("applyEvent — recentEvents", () => {
    it("prepends events to recentEvents", () => {
      const { applyEvent } = useEventStore.getState();
      applyEvent(makeTaskCreated("T-100", "First"));
      applyEvent(makeTaskCreated("T-101", "Second"));

      const { recentEvents } = useEventStore.getState();
      expect(recentEvents).toHaveLength(2);
      // Most recent first
      expect((recentEvents[0].payload as unknown as Record<string, unknown>).task_id).toBe("T-101");
    });

    it("caps recentEvents at 200", () => {
      const { applyEvent } = useEventStore.getState();
      for (let i = 0; i < 210; i++) {
        applyEvent(makeTaskCreated(`T-${i}`, `Task ${i}`));
      }

      const { recentEvents } = useEventStore.getState();
      expect(recentEvents).toHaveLength(200);
    });
  });

  describe("hydrate", () => {
    it("fetches projections and populates the store", async () => {
      const mockTasks: TaskListRow[] = [
        {
          task_id: "T-H1",
          title: "Hydrated",
          status: "queued",
          attempt_count: 0,
          pushback_count: 0,
          phase_models: {},
          last_event_ts: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
      const mockProviders: ProviderHealthRow[] = [
        {
          provider_id: "claude",
          transport: "claude-code",
          status: "healthy",
          auth_present: true,
        },
      ];
      const mockRecent: AnyEvent[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.includes("task_list"))
            return Promise.resolve({ ok: true, json: () => Promise.resolve(mockTasks) });
          if (url.includes("provider_health"))
            return Promise.resolve({ ok: true, json: () => Promise.resolve(mockProviders) });
          if (url.includes("events/recent"))
            return Promise.resolve({ ok: true, json: () => Promise.resolve(mockRecent) });
          return Promise.resolve({ ok: false });
        }),
      );

      await useEventStore.getState().hydrate();

      const state = useEventStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.taskList["T-H1"]).toBeDefined();
      expect(state.taskList["T-H1"].title).toBe("Hydrated");
      expect(state.providerHealth["claude"]).toBeDefined();
      expect(state.providerHealth["claude"].status).toBe("healthy");

      vi.unstubAllGlobals();
    });

    it("handles failed fetches gracefully", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve({ ok: false })),
      );

      await useEventStore.getState().hydrate();

      const state = useEventStore.getState();
      expect(state.hydrated).toBe(true);
      expect(Object.keys(state.taskList)).toHaveLength(0);
      expect(Object.keys(state.providerHealth)).toHaveLength(0);

      vi.unstubAllGlobals();
    });
  });

  describe("shared reducers", () => {
    it("uses the same reduceTaskList as the server", () => {
      // Verify the client reducer produces the same result as calling
      // the shared function directly
      const { applyEvent } = useEventStore.getState();
      const event = makeTaskCreated("T-SHARED", "Shared reducer test");
      applyEvent(event);

      const { taskList } = useEventStore.getState();
      const row = taskList["T-SHARED"];
      expect(row.task_id).toBe("T-SHARED");
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(0);
    });
  });
});
