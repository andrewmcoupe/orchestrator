/**
 * Dependency system — topological sort, validation, and status resolution.
 *
 * Pure functions used by both server (ingest, projection runner) and client
 * (dependency editing UI) to enforce dependency constraints.
 */

import type { TaskStatus } from "./events.js";

// ============================================================================
// Types
// ============================================================================

export interface DraftTask {
  id: string;
  depends_on: string[];
}

export interface TopoSortResult {
  /** Tasks in valid topological order (dependencies before dependents). */
  sorted: string[];
  /** Edges that were removed to break cycles. */
  stripped: Array<{ from: string; to: string }>;
}

export interface BlockedStatus {
  blocked: boolean;
  /** Human-readable warnings (e.g. dependency is rejected/archived). */
  warnings: string[];
}

// ============================================================================
// Statuses that allow dependency modification
// ============================================================================

/** Statuses before execution begins — dependencies can still be edited. */
const EDITABLE_STATUSES = new Set<TaskStatus>(["draft", "queued", "blocked"]);

/** Terminal non-success statuses that will never reach "merged". */
const TERMINAL_FAILURE_STATUSES = new Set<TaskStatus>([
  "rejected",
  "archived",
]);

// ============================================================================
// topoSort — Kahn's algorithm with cycle-edge stripping
// ============================================================================

/**
 * Topological sort with cycle detection. When cycles are found, back-edges
 * are stripped (removed from depends_on) and reported. The result always
 * contains every input task in a valid topological order.
 */
export function topoSort(tasks: DraftTask[]): TopoSortResult {
  const stripped: Array<{ from: string; to: string }> = [];
  const ids = new Set(tasks.map((t) => t.id));

  // Build adjacency: edge from dependency → dependent (dep must come first)
  // in-degree counts how many unprocessed dependencies each task has
  const adjOut = new Map<string, string[]>(); // dep → [dependents]
  const inDegree = new Map<string, number>();
  const cleanedDeps = new Map<string, string[]>(); // working copy of depends_on

  for (const t of tasks) {
    adjOut.set(t.id, []);
    inDegree.set(t.id, 0);
    cleanedDeps.set(t.id, [...t.depends_on]);
  }

  // Strip self-references and references to unknown tasks immediately
  for (const t of tasks) {
    const deps = cleanedDeps.get(t.id)!;
    const valid: string[] = [];
    for (const dep of deps) {
      if (dep === t.id) {
        stripped.push({ from: t.id, to: t.id });
      } else if (!ids.has(dep)) {
        // Ignore references to tasks not in this batch
      } else {
        valid.push(dep);
      }
    }
    cleanedDeps.set(t.id, valid);
  }

  // Build graph from cleaned deps
  for (const t of tasks) {
    const deps = cleanedDeps.get(t.id)!;
    inDegree.set(t.id, deps.length);
    for (const dep of deps) {
      adjOut.get(dep)!.push(t.id);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const dependent of adjOut.get(node) ?? []) {
      const newDeg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // If not all nodes are sorted, there are cycles — break them
  if (sorted.length < tasks.length) {
    const remaining = tasks.filter((t) => !sorted.includes(t.id));

    // Find and strip back-edges using DFS
    const visited = new Set<string>(sorted);
    const inStack = new Set<string>();

    const dfs = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      inStack.add(nodeId);

      const deps = cleanedDeps.get(nodeId) ?? [];
      for (const dep of deps) {
        if (inStack.has(dep)) {
          // Back-edge found — strip it
          stripped.push({ from: nodeId, to: dep });
          cleanedDeps.set(
            nodeId,
            cleanedDeps.get(nodeId)!.filter((d) => d !== dep),
          );
        } else if (!visited.has(dep)) {
          dfs(dep);
        }
      }

      inStack.delete(nodeId);
    };

    for (const t of remaining) {
      dfs(t.id);
    }

    // Re-run Kahn's with cleaned graph
    const retry = topoSort(
      tasks.map((t) => ({ id: t.id, depends_on: cleanedDeps.get(t.id)! })),
    );
    return {
      sorted: retry.sorted,
      stripped: [...stripped, ...retry.stripped],
    };
  }

  return { sorted, stripped };
}

// ============================================================================
// canAddDependency — status gate
// ============================================================================

/**
 * Returns true if a task in the given status can have its dependencies modified.
 * Once a task is in_progress (running) or beyond, dependencies are locked.
 */
export function canAddDependency(status: TaskStatus): boolean {
  return EDITABLE_STATUSES.has(status);
}

// ============================================================================
// resolveBlockedStatus — compute blocked state from dependency statuses
// ============================================================================

/**
 * Given a task's dependency list and a map of all task statuses, determines
 * whether the task should be blocked and surfaces warnings for dependencies
 * in terminal failure states (they'll never unblock naturally).
 */
export function resolveBlockedStatus(
  dependsOn: string[],
  taskStatuses: Map<string, TaskStatus>,
): BlockedStatus {
  if (dependsOn.length === 0) {
    return { blocked: false, warnings: [] };
  }

  const warnings: string[] = [];
  let allMerged = true;

  for (const depId of dependsOn) {
    const status = taskStatuses.get(depId);
    if (status === "merged") continue;

    allMerged = false;

    if (status && TERMINAL_FAILURE_STATUSES.has(status)) {
      warnings.push(
        `Dependency ${depId} is ${status} and will never be merged`,
      );
    }
  }

  return { blocked: !allMerged, warnings };
}
