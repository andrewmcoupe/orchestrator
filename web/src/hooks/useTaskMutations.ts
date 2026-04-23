/**
 * TanStack Query mutations for task commands.
 *
 * Each mutation wraps a POST to /api/commands/... and returns the
 * server response. No cache invalidation is needed — the Zustand
 * event store is updated via SSE when the server emits the resulting event.
 */

import { useMutation } from "@tanstack/react-query";

// ============================================================================
// Shared fetch helper
// ============================================================================

async function postCommand<T = unknown>(
  url: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// Set dependencies
// ============================================================================

type SetDependenciesInput = {
  taskId: string;
  depends_on: string[];
};

export function useSetDependencies() {
  return useMutation({
    mutationFn: (input: SetDependenciesInput) =>
      postCommand(`/api/commands/task/${input.taskId}/dependencies`, {
        depends_on: input.depends_on,
      }),
  });
}

// ============================================================================
// Create task
// ============================================================================

type CreateTaskInput = {
  title: string;
  proposition_ids?: string[];
  preset_id?: string;
};

type CreateTaskResult = {
  type: string;
  aggregate_id: string;
  payload: { task_id: string };
};

export function useCreateTask() {
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      postCommand<CreateTaskResult>("/api/commands/task/create", {
        title: input.title,
        proposition_ids: input.proposition_ids ?? [],
        preset_id: input.preset_id,
      }),
  });
}
