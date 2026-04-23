/**
 * Dependency reactor — reacts to task.merged events by checking whether
 * dependent tasks should be unblocked.
 *
 * Listens on the eventBus for "event.committed" and, when a task.merged
 * event fires, queries proj_task_list for tasks whose depends_on includes
 * the merged task. For each dependent, checks whether ALL dependencies
 * are now merged. If so, emits a task.unblocked event via appendAndProject.
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { eventBus, appendAndProject } from "./projectionRunner.js";

interface DependentRow {
  task_id: string;
  depends_on_json: string;
  blocked: number;
}

/**
 * Register the dependency reactor. Call once at boot after projections
 * are initialized.
 */
export function registerDependencyReactor(db: Database.Database): void {
  eventBus.on("event.committed", (event: AnyEvent) => {
    if (event.type !== "task.merged" && event.type !== "task.auto_merged") {
      return;
    }

    const mergedTaskId = event.payload.task_id;

    // Find all tasks that depend on the merged task and are still blocked
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
  });
}
