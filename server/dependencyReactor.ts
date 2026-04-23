/**
 * Dependency reactor — reacts to task lifecycle events by checking whether
 * dependent tasks should be unblocked or warned about.
 *
 * Listens on the eventBus for "event.committed" and:
 * - When a task.merged/task.auto_merged event fires, checks if dependents
 *   can be unblocked (all deps merged).
 * - When a task reaches a terminal failure status (rejected/archived),
 *   emits task.dependency.warning for blocked dependents.
 */

import type Database from "better-sqlite3";
import type { AnyEvent, TaskStatus } from "@shared/events.js";
import { eventBus, appendAndProject } from "./projectionRunner.js";

interface DependentRow {
  task_id: string;
  depends_on_json: string;
  blocked: number;
}

const TERMINAL_FAILURE_STATUSES = new Set<TaskStatus>([
  "rejected",
  "archived",
]);

/**
 * Register the dependency reactor. Call once at boot after projections
 * are initialized.
 */
export function registerDependencyReactor(db: Database.Database): void {
  eventBus.on("event.committed", (event: AnyEvent) => {
    // Handle merge events — check for unblocking
    if (event.type === "task.merged" || event.type === "task.auto_merged") {
      const mergedTaskId = event.payload.task_id;
      handleMerged(db, mergedTaskId);
      return;
    }

    // Handle terminal failure — emit warnings for dependents
    if (event.type === "task.status_changed") {
      const { task_id, to } = event.payload;
      if (TERMINAL_FAILURE_STATUSES.has(to as TaskStatus)) {
        handleTerminalFailure(db, task_id, to as TaskStatus);
      }
    }
  });
}

function handleMerged(db: Database.Database, mergedTaskId: string): void {
  const dependents = db
    .prepare(
      `SELECT task_id, depends_on_json, blocked FROM proj_task_list
       WHERE blocked = 1 AND depends_on_json LIKE ?`,
    )
    .all(`%${mergedTaskId}%`) as DependentRow[];

  for (const dep of dependents) {
    const dependsOn: string[] = JSON.parse(dep.depends_on_json);
    if (!dependsOn.includes(mergedTaskId)) continue;

    // Check if ALL dependencies are now merged
    const allMerged = dependsOn.every((depId) => {
      const row = db
        .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
        .get(depId) as { status: string } | undefined;
      return row?.status === "merged";
    });

    if (allMerged) {
      appendAndProject(db, {
        type: "task.unblocked",
        aggregate_type: "task",
        aggregate_id: dep.task_id,
        actor: { kind: "system", component: "dependency_reactor" },
        payload: { task_id: dep.task_id },
      });
    }
  }
}

function handleTerminalFailure(
  db: Database.Database,
  failedTaskId: string,
  status: TaskStatus,
): void {
  const dependents = db
    .prepare(
      `SELECT task_id, depends_on_json, blocked FROM proj_task_list
       WHERE blocked = 1 AND depends_on_json LIKE ?`,
    )
    .all(`%${failedTaskId}%`) as DependentRow[];

  for (const dep of dependents) {
    const dependsOn: string[] = JSON.parse(dep.depends_on_json);
    if (!dependsOn.includes(failedTaskId)) continue;

    appendAndProject(db, {
      type: "task.dependency.warning",
      aggregate_type: "task",
      aggregate_id: dep.task_id,
      actor: { kind: "system", component: "dependency_reactor" },
      payload: {
        task_id: dep.task_id,
        dependency_id: failedTaskId,
        dependency_status: status,
        message: `Dependency ${failedTaskId} is ${status} and will never be merged`,
      },
    });
  }
}
