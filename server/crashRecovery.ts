/**
 * Crash Recovery — discard uncommitted worktree changes on server startup.
 *
 * On restart, any uncommitted changes in a worktree belong to an interrupted
 * in-flight attempt and should be discarded. Committed state (completed
 * attempts) is preserved.
 */

import type Database from "better-sqlite3";
import { execa } from "execa";
import fs from "node:fs";

/**
 * Resets all known worktrees to their last committed state.
 *
 * Queries proj_task_detail for rows with a worktree_path, checks if the
 * directory still exists on disk, and runs `git reset --hard HEAD` +
 * `git clean -fd` to discard any uncommitted changes or untracked files.
 */
export async function recoverWorktrees(db: Database.Database): Promise<void> {
  const rows = db
    .prepare(
      "SELECT worktree_path FROM proj_task_detail WHERE worktree_path IS NOT NULL",
    )
    .all() as Array<{ worktree_path: string }>;

  for (const row of rows) {
    const wtPath = row.worktree_path;

    if (!fs.existsSync(wtPath)) {
      continue;
    }

    // Discard uncommitted changes (staged + unstaged)
    await execa("git", ["reset", "--hard", "HEAD"], {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Remove untracked files and directories
    await execa("git", ["clean", "-fd"], {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
