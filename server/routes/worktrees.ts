/**
 * Worktree management routes — listing, bulk removal, and rebuild-all.
 *
 * GET  /api/worktrees                     — list all worktrees correlated with tasks
 * POST /api/commands/worktree/remove      — bulk remove worktrees by task_id
 * POST /api/maintenance/rebuild-projections — rebuild all registered projections
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { listWorktrees, removeWorktree, getDefaultRepoRoot } from "../worktree.js";
import { rebuildProjection, getRegisteredProjections } from "../projectionRunner.js";
import { execa } from "execa";

const removeBodySchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1, "At least one task_id is required"),
});

function badRequest(detail: string | z.ZodError) {
  if (detail instanceof z.ZodError) {
    return Response.json(
      { type: "validation_error", status: 400, detail: "Request body validation failed", errors: detail.errors },
      { status: 400 },
    );
  }
  return Response.json({ type: "bad_request", status: 400, detail }, { status: 400 });
}

export function createWorktreeRoutes(db: Database.Database) {
  const app = new Hono();

  // --------------------------------------------------------------------------
  // GET /api/worktrees
  //
  // Lists all git worktrees, correlates each wt/<task_id> branch with its
  // task from proj_task_detail, and returns enriched metadata.
  // Excludes the main worktree (no wt/ branch prefix).
  // --------------------------------------------------------------------------
  app.get("/api/worktrees", async (c) => {
    try {
      const repoRoot = getDefaultRepoRoot();
      const worktrees = await listWorktrees(repoRoot);

      // Filter to only orchestrator worktrees (branch starts with "wt/")
      const orchestratorWorktrees = worktrees.filter(
        (wt) => wt.branch?.startsWith("wt/"),
      );

      const results = await Promise.all(
        orchestratorWorktrees.map(async (wt) => {
          // Extract task_id from branch name "wt/<task_id>"
          const taskId = wt.branch!.slice("wt/".length);

          // Look up task in the projection
          const taskRow = db
            .prepare("SELECT task_id, title, status FROM proj_task_detail WHERE task_id = ?")
            .get(taskId) as { task_id: string; title: string; status: string } | undefined;

          // Estimate disk usage via du -sh
          let sizeDisplay = "unknown";
          try {
            const duResult = await execa("du", ["-sh", wt.worktreePath], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            // du -sh output: "4.2M\t/path/to/dir"
            sizeDisplay = duResult.stdout.split("\t")[0].trim();
          } catch {
            // Best-effort; ignore failures
          }

          // Estimate age in days from commit timestamp
          let createdDaysAgo = 0;
          try {
            const logResult = await execa(
              "git",
              ["log", "-1", "--format=%ct", wt.branch!],
              { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
            );
            const commitTs = parseInt(logResult.stdout.trim(), 10);
            if (!isNaN(commitTs)) {
              createdDaysAgo = Math.floor((Date.now() / 1000 - commitTs) / 86400);
            }
          } catch {
            // Best-effort
          }

          return {
            task_id: taskId,
            task_title: taskRow?.title ?? null,
            task_status: taskRow?.status ?? "orphaned",
            branch: wt.branch!,
            worktree_path: wt.worktreePath,
            created_days_ago: createdDaysAgo,
            size_display: sizeDisplay,
          };
        }),
      );

      return c.json({ worktrees: results });
    } catch (err) {
      return c.json({ worktrees: [], error: String(err) }, 500);
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/worktree/remove
  //
  // Bulk-removes worktrees by task_id. Each removal emits a
  // task.worktree_deleted event. Errors per-task are collected without
  // failing the entire batch.
  // --------------------------------------------------------------------------
  app.post("/api/commands/worktree/remove", async (c) => {
    const parsed = removeBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const removed: string[] = [];
    const errors: Array<{ task_id: string; error: string }> = [];

    for (const taskId of parsed.data.task_ids) {
      try {
        await removeWorktree(db, taskId);
        removed.push(taskId);
      } catch (err) {
        errors.push({ task_id: taskId, error: String(err) });
      }
    }

    return c.json({ removed, errors });
  });

  // --------------------------------------------------------------------------
  // POST /api/maintenance/rebuild-projections
  //
  // Rebuilds ALL registered projections from the event log.
  // Blocks until complete.
  // --------------------------------------------------------------------------
  app.post("/api/maintenance/rebuild-projections", (c) => {
    const projections = getRegisteredProjections();
    const rebuilt: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const [name] of projections) {
      try {
        rebuildProjection(db, name);
        rebuilt.push(name);
      } catch (err) {
        errors.push({ name, error: String(err) });
      }
    }

    if (errors.length > 0) {
      return c.json({ ok: false, rebuilt, errors });
    }

    return c.json({ ok: true, rebuilt });
  });

  return app;
}
