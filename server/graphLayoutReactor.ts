/**
 * Graph layout reactor — recomputes the graph layout whenever the task
 * dependency graph changes.
 *
 * Listens on the eventBus for graph-affecting events and recomputes the
 * layout with a 200ms debounce so rapid-fire events are batched into a
 * single recomputation.
 */

import type Database from "better-sqlite3";
import type { AnyEvent, EventType } from "@shared/events.js";
import { eventBus } from "./projectionRunner.js";
import { computeGraphLayout } from "./graphLayout.js";
import { writeGraphLayout, type GraphLayoutBlob } from "./graphLayoutStore.js";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 72;

/** Event types that can change the shape of the dependency graph. */
const GRAPH_AFFECTING_EVENTS = new Set<EventType>([
  "task.created",
  "task.dependency.set",
  "task.status_changed",
  "task.archived",
  "task.unblocked",
]);

interface TaskRow {
  task_id: string;
  depends_on_json: string;
}

/**
 * Build the graph input from the current task_list projection.
 * Returns nodes for every non-archived task and edges for dependency links.
 */
function buildGraphInput(db: Database.Database) {
  const rows = db
    .prepare("SELECT task_id, depends_on_json FROM proj_task_list")
    .all() as TaskRow[];

  const taskIds = new Set(rows.map((r) => r.task_id));

  const nodes = rows.map((r) => ({
    id: r.task_id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));

  const edges: { source: string; target: string }[] = [];
  for (const row of rows) {
    const deps: string[] = JSON.parse(row.depends_on_json || "[]");
    for (const dep of deps) {
      // Only include edges where both endpoints exist in the current graph
      if (taskIds.has(dep)) {
        edges.push({ source: dep, target: row.task_id });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Register the graph layout reactor. Call once at boot after projections
 * and the graph layout table are initialized.
 *
 * Returns a dispose function for testing (removes listeners, clears timers).
 */
export function registerGraphLayoutReactor(db: Database.Database): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function recompute(): Promise<void> {
    try {
      const input = buildGraphInput(db);

      if (input.nodes.length === 0) {
        writeGraphLayout(db, {
          nodes: {},
          edges: [],
          meta: { critical_path: [], direction: "DOWN" },
        });
        return;
      }

      const result = await computeGraphLayout(input);

      const blob: GraphLayoutBlob = {
        nodes: Object.fromEntries(
          result.nodes.map((n) => [
            n.id,
            { x: n.x, y: n.y, width: NODE_WIDTH, height: NODE_HEIGHT },
          ]),
        ),
        edges: result.edges.map((e) => ({
          source: e.source,
          target: e.target,
        })),
        meta: {
          critical_path: result.meta.critical_path,
          direction: "DOWN",
        },
      };

      writeGraphLayout(db, blob);
    } catch (err) {
      console.error("[graphLayoutReactor] Layout computation failed:", err);
    }
  }

  function listener(event: AnyEvent): void {
    if (!GRAPH_AFFECTING_EVENTS.has(event.type)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void recompute();
    }, 200);
  }

  eventBus.on("event.committed", listener);

  return () => {
    eventBus.off("event.committed", listener);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}
