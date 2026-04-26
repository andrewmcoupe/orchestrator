/**
 * Client-side event store — Zustand + shared reducers.
 *
 * The client maintains projection state identical to the server by running
 * the SAME reducer functions over the same event stream. On mount:
 *   1. hydrate() fetches current projections via REST
 *   2. SSE subscribes to live events via applyEvent()
 *
 * This guarantees the UI stays in sync without polling or refetching.
 */

import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { AnyEvent } from "@shared/events.js";
import {
  reduceTaskList,
  reduceTaskDetail,
  PROJECTION_SUBSCRIPTIONS,
} from "@shared/projections.js";
import type {
  TaskListRow,
  TaskDetailRow,
  ProviderHealthRow,
} from "@shared/projections.js";

// ============================================================================
// Store shape
// ============================================================================

type EventStoreState = {
  /** Task list rows keyed by task_id */
  taskList: Record<string, TaskListRow>;
  /** Task detail rows keyed by task_id */
  taskDetail: Record<string, TaskDetailRow>;
  /** Provider health rows keyed by provider_id */
  providerHealth: Record<string, ProviderHealthRow>;
  /** Recent events (most recent first), capped at 200 */
  recentEvents: AnyEvent[];
  /** Whether initial hydration has completed */
  hydrated: boolean;
};

type EventStoreActions = {
  /** Seed initial state from REST endpoints */
  hydrate: () => Promise<void>;
  /** Apply a single event using the shared reducers */
  applyEvent: (event: AnyEvent) => void;
};

const MAX_RECENT_EVENTS = 200;

// ============================================================================
// Helpers — extract the relevant ID from an event for each projection
// ============================================================================

/**
 * Reverse lookup: attempt_id → task_id.
 * Built from attempt.started events which carry both IDs.
 */
const attemptToTask = new Map<string, string>();

/**
 * Extracts the task_id from an event payload. Events may carry it as
 * task_id directly, or indirectly via attempt_id (phase events, etc.).
 * Returns undefined if the event doesn't relate to a task.
 */
function extractTaskId(event: AnyEvent): string | undefined {
  const p = event.payload as unknown as Record<string, unknown>;
  if ("task_id" in p && typeof p.task_id === "string") return p.task_id;
  if ("attempt_id" in p && typeof p.attempt_id === "string") {
    return attemptToTask.get(p.attempt_id);
  }
  return undefined;
}

// ============================================================================
// Store
// ============================================================================

export const useEventStore = create<EventStoreState & EventStoreActions>()(
  (set, get) => ({
    taskList: {},
    taskDetail: {},
    providerHealth: {},
    recentEvents: [],
    hydrated: false,

    async hydrate() {
      const [taskListRes, providerHealthRes, recentRes] = await Promise.all([
        fetch("/api/projections/task_list"),
        fetch("/api/projections/provider_health"),
        fetch("/api/events/recent?limit=200"),
      ]);

      const taskListRows: TaskListRow[] = taskListRes.ok
        ? await taskListRes.json()
        : [];
      const providerHealthRows: ProviderHealthRow[] = providerHealthRes.ok
        ? await providerHealthRes.json()
        : [];
      const recentEvents: AnyEvent[] = recentRes.ok
        ? await recentRes.json()
        : [];

      // Seed the attempt→task lookup from hydrated task list rows
      for (const row of taskListRows) {
        if (row.current_attempt_id) {
          attemptToTask.set(row.current_attempt_id, row.task_id);
        }
      }

      set({
        taskList: Object.fromEntries(
          taskListRows.map((r) => [r.task_id, r]),
        ),
        providerHealth: Object.fromEntries(
          providerHealthRows.map((r) => [r.provider_id, r]),
        ),
        recentEvents,
        hydrated: true,
      });
    },

    applyEvent(event: AnyEvent) {
      const subscriptions = PROJECTION_SUBSCRIPTIONS[event.type];
      const state = get();

      // Deduplicate — SSE may replay events already present from hydration
      // or after reconnection
      if (state.recentEvents.length > 0 && state.recentEvents.some((e) => e.id === event.id)) {
        return;
      }

      // Track attempt→task mapping for resolving phase events
      if (event.type === "attempt.started") {
        const p = event.payload as unknown as Record<string, unknown>;
        if (typeof p.attempt_id === "string" && typeof p.task_id === "string") {
          attemptToTask.set(p.attempt_id, p.task_id);
        }
      } else if (event.type === "attempt.retry_requested") {
        const p = event.payload as unknown as Record<string, unknown>;
        if (typeof p.attempt_id === "string" && typeof p.new_attempt_id === "string") {
          const taskId = attemptToTask.get(p.attempt_id);
          if (taskId) attemptToTask.set(p.new_attempt_id, taskId);
        }
      }

      const updates: Partial<EventStoreState> = {};

      for (const projection of subscriptions) {
        switch (projection) {
          case "task_list": {
            const taskId = extractTaskId(event);
            if (!taskId) break;
            const current = state.taskList[taskId] ?? null;
            const next = reduceTaskList(current, event);
            if (next) {
              updates.taskList = { ...(updates.taskList ?? state.taskList), [taskId]: next };
            } else if (current) {
              // Reducer returned null — remove the row (e.g. archived)
              const copy = { ...(updates.taskList ?? state.taskList) };
              delete copy[taskId];
              updates.taskList = copy;
            }
            break;
          }

          case "task_detail": {
            const taskId = extractTaskId(event);
            if (!taskId) break;
            const current = state.taskDetail[taskId] ?? null;
            const next = reduceTaskDetail(current, event);
            if (next) {
              updates.taskDetail = { ...(updates.taskDetail ?? state.taskDetail), [taskId]: next };
            } else if (current) {
              const copy = { ...(updates.taskDetail ?? state.taskDetail) };
              delete copy[taskId];
              updates.taskDetail = copy;
            }
            break;
          }

          // Provider health, prompt_library, etc. are not yet client-reducible
          // — they'll be added when those projections have client reducers.
          // For now, provider_health is hydrated from REST only.
          default:
            break;
        }
      }

      // Prepend to recent events, cap at MAX_RECENT_EVENTS
      const recentEvents = [event, ...state.recentEvents].slice(0, MAX_RECENT_EVENTS);
      updates.recentEvents = recentEvents;

      set(updates);
    },
  }),
);

// ============================================================================
// Selector hooks — memoized slices for React components
// ============================================================================

/** The taskList record (shallow-compared to avoid re-renders on unrelated updates) */
export function useTaskListMap(): Record<string, TaskListRow> {
  return useEventStore(useShallow((s) => s.taskList));
}

/** All task list rows sorted by updated_at DESC */
export function useTaskList(): TaskListRow[] {
  const map = useTaskListMap();
  const rows = Object.values(map);
  rows.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  return rows;
}

/** Single task detail row, or undefined */
export function useTaskDetail(taskId: string | undefined): TaskDetailRow | undefined {
  return useEventStore((s) => (taskId ? s.taskDetail[taskId] : undefined));
}

/** All provider health rows */
export function useProviderHealth(): ProviderHealthRow[] {
  return useEventStore(useShallow((s) => Object.values(s.providerHealth)));
}

/** Recent events (the array reference in the store) */
export function useRecentEvents(options?: { correlationId?: string }): AnyEvent[] {
  const events = useEventStore((s) => s.recentEvents);
  if (!options?.correlationId) return events;
  return events.filter((e) => e.correlation_id === options.correlationId);
}

/** Whether initial hydration has completed */
export function useHydrated(): boolean {
  return useEventStore((s) => s.hydrated);
}
