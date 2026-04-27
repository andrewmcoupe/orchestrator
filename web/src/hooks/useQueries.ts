/**
 * TanStack Query hooks for read-only projections.
 *
 * These wrap GET endpoints and provide caching, deduplication, and
 * background refetch. No manual cache invalidation is needed — the
 * Zustand event store handles live updates via SSE for the task list
 * and task detail. These queries are used by overlay screens (config,
 * review) that load on demand.
 */

import { useQuery, useQueries } from "@tanstack/react-query";
import type { TaskDetailRow, PresetRow, PropositionRow } from "@shared/projections.js";
import type { GateConfig, AnyEvent, TaskStatus } from "@shared/events.js";

/** Statuses where new events are expected — timeline should poll. */
const ACTIVE_STATUSES = new Set<TaskStatus>([
  "running", "paused", "awaiting_review", "revising", "awaiting_merge",
]);

// ============================================================================
// Shared fetcher
// ============================================================================

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ============================================================================
// Task detail
// ============================================================================

export function useTaskDetailQuery(taskId: string) {
  return useQuery({
    queryKey: ["task_detail", taskId],
    queryFn: () => fetchJson<TaskDetailRow>(`/api/projections/task_detail/${taskId}`),
  });
}

// ============================================================================
// Presets
// ============================================================================

export function usePresetsQuery() {
  return useQuery({
    queryKey: ["presets"],
    queryFn: () => fetchJson<PresetRow[]>("/api/projections/preset"),
  });
}

// ============================================================================
// Propositions by IDs
// ============================================================================

export function usePropositionsQuery(ids: string[]) {
  const key = ids.join(",");
  return useQuery({
    queryKey: ["propositions", key],
    queryFn: () => fetchJson<PropositionRow[]>(`/api/projections/proposition?ids=${key}`),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

// ============================================================================
// Gate library
// ============================================================================

type LibraryGate = GateConfig & { source: "config" | "library" };

type GatesResponse = {
  config_gates: GateConfig[];
  library_gates: GateConfig[];
  all_gates: LibraryGate[];
  config_gate_names: string[];
};

export function useGateLibraryQuery() {
  return useQuery({
    queryKey: ["gate_library"],
    queryFn: () => fetchJson<GatesResponse>("/api/settings/gates"),
    // Gate library changes infrequently — stale time of 30s is fine
    staleTime: 30_000,
  });
}

// ============================================================================
// Task timeline events
// ============================================================================

/** Events worth showing in the timeline (skip noisy invocation-level events) */
const TIMELINE_EVENT_TYPES = new Set([
  "task.drafted",
  "task.created",
  "task.status_changed",
  "task.worktree_created",
  "task.worktree_deleted",
  "task.config_updated",
  "task.archived",
  "attempt.started",
  "attempt.completed",
  "attempt.paused",
  "attempt.resumed",
  "attempt.killed",
  "attempt.approved",
  "attempt.rejected",
  "attempt.retry_requested",
  "phase.started",
  "phase.completed",
  "gate.started",
  "gate.passed",
  "gate.failed",
  "gate.timed_out",
  "auditor.judged",
]);

/**
 * Fetches all timeline-worthy events for a task. Loads the task's own
 * aggregate events first, extracts attempt IDs, then fetches attempt-scoped
 * events (phases, gates, auditor) in parallel.
 */
export function useTaskTimelineQuery(taskId: string | undefined, status?: TaskStatus) {
  // Poll every 3s while the task is in an active state, otherwise no polling
  const refetchInterval = status && ACTIVE_STATUSES.has(status) ? 3_000 : false;

  // Step 1: fetch task-level events and attempt list in parallel
  const taskEventsQuery = useQuery({
    queryKey: ["task_events", taskId],
    queryFn: () => fetchJson<AnyEvent[]>(`/api/events/recent?aggregate_id=${taskId}&limit=500`),
    enabled: !!taskId,
    refetchInterval,
  });

  const attemptsQuery = useQuery({
    queryKey: ["task_attempts", taskId],
    queryFn: () => fetchJson<Array<{ attempt_id: string }>>(`/api/projections/attempts?task_id=${taskId}`),
    enabled: !!taskId,
    refetchInterval,
  });

  const uniqueAttemptIds = (attemptsQuery.data ?? []).map((a) => a.attempt_id);

  // Step 2: fetch attempt-scoped events (phases, gates, auditor) in parallel
  const attemptQueries = useQueries({
    queries: uniqueAttemptIds.map((aid) => ({
      queryKey: ["attempt_events", aid],
      queryFn: () => fetchJson<AnyEvent[]>(`/api/events/recent?correlation_id=${aid}&limit=500`),
    })),
  });

  const allAttemptEvents = attemptQueries
    .filter((q) => q.isSuccess)
    .flatMap((q) => q.data ?? []);

  // Merge, deduplicate, filter, sort chronologically
  const allEvents = [...(taskEventsQuery.data ?? []), ...allAttemptEvents];
  const seen = new Set<string>();
  const timeline = allEvents
    .filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return TIMELINE_EVENT_TYPES.has(e.type);
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const isLoading = taskEventsQuery.isLoading || attemptsQuery.isLoading || attemptQueries.some((q) => q.isLoading);

  return { data: timeline, isLoading };
}

// ============================================================================
// Graph layout
// ============================================================================

export function useGraphLayoutQuery(prdId?: string) {
  const url = prdId
    ? `/api/projections/graph_layout?prd_id=${encodeURIComponent(prdId)}`
    : "/api/projections/graph_layout";
  return useQuery({
    queryKey: ["graph_layout", prdId ?? "all"],
    queryFn: () => fetchJson<import("@shared/projections.js").GraphLayoutResponse>(url),
    refetchInterval: 5_000,
  });
}

export type { LibraryGate, GatesResponse };
