/**
 * Repo + Worktree utility routes.
 *
 * GET /api/repo/current-branch        — current HEAD branch of the main working tree
 * GET /api/config/on_merge            — on_merge config block from config.yaml
 * GET /api/config/ingest              — ingest config defaults (transport + model)
 * GET /api/worktree/:task_id/open     — open the task worktree in $EDITOR / $VISUAL
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { Hono } from "hono";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { getDefaultRepoRoot, getConfigPath } from "../paths.js";
import { getIngestConfig } from "../config.js";

const CONFIG_PATH = getConfigPath();

export function createRepoRoutes(db: Database.Database) {
  const app = new Hono();

  // --------------------------------------------------------------------------
  // GET /api/repo/current-branch
  //
  // Reads `git rev-parse --abbrev-ref HEAD` at the host repo root.
  // The review screen polls this every 3 seconds while a task is approved
  // so the Merge button always reflects the branch the user is on.
  // --------------------------------------------------------------------------
  app.get("/api/repo/current-branch", async (c) => {
    try {
      const repoRoot = getDefaultRepoRoot();
      const result = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoRoot,
      });
      return c.json({ branch: result.stdout.trim() });
    } catch (err) {
      return c.json({ branch: "unknown", error: String(err) }, 500);
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/config/on_merge
  //
  // Returns the on_merge config block from config.yaml.
  // The merge dialog reads this to determine the strategy (squash/merge/ff-only)
  // so it can enable/disable commit message editing accordingly.
  // --------------------------------------------------------------------------
  app.get("/api/config/on_merge", (c) => {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const config = parseYaml(raw) as {
        on_merge?: {
          strategy?: string;
          auto_delete_worktree?: boolean;
          preserve_branch?: boolean;
        };
      };
      return c.json({
        strategy: config.on_merge?.strategy ?? "squash",
        auto_delete_worktree: config.on_merge?.auto_delete_worktree ?? true,
        preserve_branch: config.on_merge?.preserve_branch ?? false,
      });
    } catch {
      return c.json({ strategy: "squash", auto_delete_worktree: true, preserve_branch: false });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/config/ingest
  //
  // Returns the resolved ingest config (transport + model) so the UI can
  // default its dropdowns from config.yaml rather than hard-coding values.
  // --------------------------------------------------------------------------
  app.get("/api/config/ingest", (c) => {
    const ingest = getIngestConfig();
    return c.json({ transport: ingest.transport, model: ingest.model });
  });

  // --------------------------------------------------------------------------
  // GET /api/worktree/:task_id/open
  //
  // Spawns the user's configured editor ($VISUAL → $EDITOR → "code") pointed
  // at the task's worktree directory. The subprocess is detached so the
  // request returns immediately without waiting for the editor to close.
  // --------------------------------------------------------------------------
  app.get("/api/worktree/:task_id/open", async (c) => {
    const taskId = c.req.param("task_id");

    const row = db
      .prepare("SELECT worktree_path FROM proj_task_detail WHERE task_id = ?")
      .get(taskId) as { worktree_path: string | null } | undefined;

    if (!row || !row.worktree_path) {
      return Response.json(
        {
          type: "not_found",
          status: 404,
          detail: `No worktree found for task '${taskId}'`,
        },
        { status: 404 },
      );
    }

    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "code";

    try {
      // Detached spawn — fire and forget; never await
      execa(editor, [row.worktree_path], {
        detached: true,
        stdio: "ignore",
      }).unref();

      return c.json({ opened: true, path: row.worktree_path, editor });
    } catch (err) {
      return c.json({ opened: false, error: String(err) }, 500);
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/fs/suggest?q=<partial-path>
  //
  // Returns directory entries matching a partial filesystem path, used by the
  // ingest form to autocomplete PRD file paths.
  // --------------------------------------------------------------------------
  app.get("/api/fs/suggest", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) return c.json({ entries: [] });

    try {
      const resolved = resolve(q);
      let dir: string;
      let prefix: string;

      try {
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          dir = resolved;
          prefix = "";
        } else {
          dir = dirname(resolved);
          prefix = basename(resolved);
        }
      } catch {
        dir = dirname(resolved);
        prefix = basename(resolved);
      }

      const raw = readdirSync(dir, { withFileTypes: true });
      const entries = raw
        .filter((e) => !e.name.startsWith(".") && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, 20)
        .map((e) => ({
          name: e.name,
          path: resolve(dir, e.name),
          isDir: e.isDirectory(),
        }));

      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  return app;
}
