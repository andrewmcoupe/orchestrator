/**
 * Gate command routes — POST endpoints for manual gate re-runs.
 *
 * POST /api/commands/gate/:name/run?attempt_id=<id>
 *
 * Looks up the gate by name in the registry, fetches the worktree path
 * from the attempt's task_detail projection row, and runs the gate.
 * Returns the gate run result.
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { getGateConfig } from "../gates/registry.js";
import { runGate } from "../gates/runner.js";

export function createGateCommandRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // POST /api/commands/gate/:name/run?attempt_id=<id>
  app.post("/api/commands/gate/:name/run", async (c) => {
    const gateName = c.req.param("name");
    const attempt_id = c.req.query("attempt_id");

    if (!attempt_id) {
      return c.json(
        {
          type: "https://httpstatuses.com/400",
          title: "Bad Request",
          detail: "attempt_id query parameter is required",
        },
        400,
      );
    }

    // Look up gate config
    const gate = getGateConfig(gateName);
    if (!gate) {
      return c.json(
        {
          type: "https://httpstatuses.com/404",
          title: "Not Found",
          detail: `Gate "${gateName}" not found in registry`,
        },
        404,
      );
    }

    // Look up worktree path from task_detail via the attempt row
    // We join via proj_task_list / proj_task_detail using attempt_id
    const attemptRow = db
      .prepare(
        "SELECT task_id_json FROM proj_task_detail WHERE current_attempt_id = ?",
      )
      .get(attempt_id) as { task_id_json?: string } | undefined;

    // Try the attempt projection table if it exists
    let worktreePath: string | null = null;

    if (attemptRow) {
      // Found via task_detail
      const taskDetail = db
        .prepare("SELECT worktree_path FROM proj_task_detail WHERE task_id = ?")
        .get(attemptRow.task_id_json) as { worktree_path?: string } | undefined;
      worktreePath = taskDetail?.worktree_path ?? null;
    } else {
      // Fall back: look for worktree_path directly in proj_task_detail by any attempt match
      // Attempt to query for the task that has this attempt_id as current_attempt_id
      const row = db
        .prepare(
          "SELECT worktree_path FROM proj_task_detail WHERE current_attempt_id = ?",
        )
        .get(attempt_id) as { worktree_path?: string } | undefined;
      worktreePath = row?.worktree_path ?? null;
    }

    if (!worktreePath) {
      return c.json(
        {
          type: "https://httpstatuses.com/404",
          title: "Not Found",
          detail: `No worktree found for attempt_id "${attempt_id}"`,
        },
        404,
      );
    }

    const result = await runGate(db, gate, attempt_id, worktreePath);
    return c.json(result);
  });

  return app;
}
