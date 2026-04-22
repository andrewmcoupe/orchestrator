/**
 * Git Worktree Management.
 *
 * Encapsulates all git-worktree operations for the orchestrator.
 *
 * Worktrees live at:
 *   <host_repo_root>/.orchestrator-worktrees/<task_id>
 *
 * This is a sibling to the main working tree so git can manage them
 * independently. The directory is added to the host repo's .gitignore
 * automatically on first use.
 *
 * All git operations use execa with proper error handling.
 * Events are appended to the store via appendAndProject so downstream
 * consumers (SSE clients, projections) see worktree lifecycle events.
 */

import type Database from "better-sqlite3";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { appendAndProject } from "./projectionRunner.js";

// ============================================================================
// Types
// ============================================================================

export type WorktreeInfo = {
  worktreePath: string;
  branch?: string;
  commitHash?: string;
};

export type FileDiff = {
  /** Repo-relative file path. */
  path: string;
  /** A = added, M = modified, D = deleted */
  operation: "A" | "M" | "D";
  lines_added: number;
  lines_removed: number;
};

export type DiffResult = {
  files: FileDiff[];
};

// ============================================================================
// Repo root detection
// ============================================================================

/**
 * Walks upward from startDir looking for a .git directory or file.
 * Returns the absolute path of the repo root.
 * Throws if no git repo is found.
 */
export function findHostRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);

  // Walk up until we find .git or hit the filesystem root
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding .git
      throw new Error(
        `No git repo found walking up from ${startDir}. ` +
          "Ensure the orchestrator is running inside a git repository.",
      );
    }
    current = parent;
  }
}

/**
 * Returns the host repo root by walking up from this file's directory.
 * Used as the default when callers don't supply an explicit repoRoot.
 */
export function getDefaultRepoRoot(): string {
  return findHostRepoRoot(import.meta.dirname);
}

// ============================================================================
// .gitignore management
// ============================================================================

const GITIGNORE_ENTRY = ".orchestrator-worktrees/";

/**
 * Adds .orchestrator-worktrees/ to the repo .gitignore if not already present.
 * Creates the .gitignore file if it doesn't exist.
 */
function ensureGitignoreEntry(repoRoot: string): void {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let contents = "";

  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, "utf8");
  }

  if (contents.includes(GITIGNORE_ENTRY)) {
    return; // Already present — nothing to do
  }

  // Append with a leading newline if the file doesn't end with one
  const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${contents}${separator}${GITIGNORE_ENTRY}\n`);
}

// ============================================================================
// Worktree path helpers
// ============================================================================

function getWorktreePath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".orchestrator-worktrees", taskId);
}

function getWorktreeBranch(taskId: string): string {
  return `wt/${taskId}`;
}

// ============================================================================
// createWorktree
// ============================================================================

export type CreateWorktreeOptions = {
  /** Override the detected host repo root. Primarily for testing. */
  repoRoot?: string;
  /** Git ref to base the new branch on. Defaults to HEAD. */
  baseRef?: string;
};

/**
 * Creates a git worktree for a task and emits task.worktree_created.
 *
 * - Worktree lands at <repoRoot>/.orchestrator-worktrees/<taskId>
 * - New branch is named wt/<taskId> off baseRef (default: HEAD)
 * - <repoRoot>/.gitignore gets .orchestrator-worktrees/ added if absent
 */
export async function createWorktree(
  db: Database.Database,
  taskId: string,
  options: CreateWorktreeOptions = {},
): Promise<{ path: string; branch: string }> {
  const repoRoot = options.repoRoot ?? getDefaultRepoRoot();
  const baseRef = options.baseRef ?? "HEAD";
  const wtPath = getWorktreePath(repoRoot, taskId);
  const branch = getWorktreeBranch(taskId);

  // Ensure parent directory exists
  const worktreesDir = path.join(repoRoot, ".orchestrator-worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });

  // Add to .gitignore before creating the worktree
  ensureGitignoreEntry(repoRoot);

  // Create the worktree with a new branch.
  // Explicit stdio avoids inheriting broken FDs from piped dev scripts.
  await execa(
    "git",
    ["worktree", "add", wtPath, "-b", branch, baseRef],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Symlink node_modules from the host repo so gate commands (pnpm test,
  // pnpm tsc, etc.) work in the worktree without a full install.
  const hostNodeModules = path.join(repoRoot, "node_modules");
  const wtNodeModules = path.join(wtPath, "node_modules");
  if (fs.existsSync(hostNodeModules) && !fs.existsSync(wtNodeModules)) {
    fs.symlinkSync(hostNodeModules, wtNodeModules, "junction");
  }

  // Emit the event
  appendAndProject(db, {
    type: "task.worktree_created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: { kind: "system", component: "watcher" },
    payload: {
      task_id: taskId,
      path: wtPath,
      branch,
      base_ref: baseRef,
    },
  });

  return { path: wtPath, branch };
}

// ============================================================================
// removeWorktree
// ============================================================================

export type RemoveWorktreeOptions = {
  /** Override the detected host repo root. Primarily for testing. */
  repoRoot?: string;
};

/**
 * Removes a git worktree and its branch, then emits task.worktree_deleted.
 *
 * Idempotent: if the worktree does not exist, resolves without error.
 */
export async function removeWorktree(
  db: Database.Database,
  taskId: string,
  options: RemoveWorktreeOptions = {},
): Promise<void> {
  const repoRoot = options.repoRoot ?? getDefaultRepoRoot();
  const wtPath = getWorktreePath(repoRoot, taskId);
  const branch = getWorktreeBranch(taskId);

  const worktreeExists = fs.existsSync(wtPath);

  if (!worktreeExists) {
    // Nothing to clean up — silently succeed
    return;
  }

  // Remove the worktree directory
  await execa("git", ["worktree", "remove", "--force", wtPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Delete the tracking branch (best-effort; may already be gone)
  try {
    await execa("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // Branch may not exist — not an error
  }

  // Emit the event
  appendAndProject(db, {
    type: "task.worktree_deleted",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: { kind: "system", component: "watcher" },
    payload: {
      task_id: taskId,
      path: wtPath,
    },
  });
}

// ============================================================================
// listWorktrees
// ============================================================================

/**
 * Lists all git worktrees by parsing `git worktree list --porcelain`.
 * Returns all worktrees including the main one.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execa(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  return parseWorktreePorcelain(stdout);
}

/**
 * Parses the porcelain output of `git worktree list --porcelain`.
 *
 * Format per worktree:
 *   worktree /absolute/path
 *   HEAD <commit-hash>
 *   branch refs/heads/<branch>      (or "detached")
 *   <blank line>
 */
function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const entries = output.trim().split(/\n\n+/);
  const results: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.trim()) continue;

    const lines = entry.split("\n");
    const info: WorktreeInfo = { worktreePath: "" };

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        info.worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        info.commitHash = line.slice("HEAD ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        info.branch = line.slice("branch refs/heads/".length);
      }
    }

    if (info.worktreePath) {
      results.push(info);
    }
  }

  return results;
}

// ============================================================================
// diffWorktree
// ============================================================================

/**
 * Returns a structured diff of changes in a task's worktree vs HEAD.
 *
 * Combines:
 *  - `git diff HEAD --numstat` for line counts (staged + unstaged)
 *  - `git diff HEAD --name-status` for operation type
 *
 * Also includes staged changes (via `git diff --cached`) so newly added
 * files that have been staged appear in the diff.
 */
export async function diffWorktree(
  taskId: string,
  repoRoot: string,
): Promise<DiffResult> {
  const wtPath = getWorktreePath(repoRoot, taskId);

  if (!fs.existsSync(wtPath)) {
    throw new Error(
      `Worktree for task ${taskId} not found at ${wtPath}`,
    );
  }

  // Get line counts for both staged and unstaged changes
  const [numstatResult, nameStatusResult, cachedNumstatResult, cachedNameStatusResult] =
    await Promise.all([
      execa("git", ["diff", "HEAD", "--numstat"], { cwd: wtPath }),
      execa("git", ["diff", "HEAD", "--name-status"], { cwd: wtPath }),
      execa("git", ["diff", "--cached", "--numstat"], { cwd: wtPath }),
      execa("git", ["diff", "--cached", "--name-status"], { cwd: wtPath }),
    ]);

  // Merge results: keyed by file path
  const fileMap = new Map<
    string,
    { lines_added: number; lines_removed: number; operation: "A" | "M" | "D" }
  >();

  // Parse unstaged changes (vs HEAD)
  parseNumstat(numstatResult.stdout, fileMap);
  parseNameStatus(nameStatusResult.stdout, fileMap);

  // Parse staged changes (cached); for newly added files not in HEAD
  parseCachedNumstat(cachedNumstatResult.stdout, fileMap);
  parseCachedNameStatus(cachedNameStatusResult.stdout, fileMap);

  const files: FileDiff[] = Array.from(fileMap.entries()).map(
    ([filePath, info]) => ({
      path: filePath,
      operation: info.operation,
      lines_added: info.lines_added,
      lines_removed: info.lines_removed,
    }),
  );

  return { files };
}

// ============================================================================
// Diff parsers
// ============================================================================

type FileInfo = {
  lines_added: number;
  lines_removed: number;
  operation: "A" | "M" | "D";
};

/**
 * Parses `git diff --numstat` output.
 * Format: <added>\t<removed>\t<filename>
 */
function parseNumstat(
  output: string,
  fileMap: Map<string, FileInfo>,
): void {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;

    const [added, removed, ...rest] = parts;
    const filePath = rest.join("\t");

    // Binary files show "-" for counts — skip them
    if (added === "-" || removed === "-") continue;

    const existing = fileMap.get(filePath);
    if (existing) {
      existing.lines_added += parseInt(added, 10);
      existing.lines_removed += parseInt(removed, 10);
    } else {
      fileMap.set(filePath, {
        lines_added: parseInt(added, 10),
        lines_removed: parseInt(removed, 10),
        operation: "M", // Default; overwritten by name-status
      });
    }
  }
}

/**
 * Parses `git diff --name-status` output.
 * Format: <status>\t<filename>
 */
function parseNameStatus(
  output: string,
  fileMap: Map<string, FileInfo>,
): void {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [status, ...rest] = trimmed.split("\t");
    const filePath = rest.join("\t");

    const op = normalizeStatus(status);
    if (!op) continue;

    const existing = fileMap.get(filePath);
    if (existing) {
      existing.operation = op;
    } else {
      fileMap.set(filePath, { lines_added: 0, lines_removed: 0, operation: op });
    }
  }
}

/**
 * Parses `git diff --cached --numstat` for staged-only changes.
 * Only adds files not already in the map (avoids double-counting).
 */
function parseCachedNumstat(
  output: string,
  fileMap: Map<string, FileInfo>,
): void {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;

    const [added, removed, ...rest] = parts;
    const filePath = rest.join("\t");

    if (added === "-" || removed === "-") continue;

    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, {
        lines_added: parseInt(added, 10),
        lines_removed: parseInt(removed, 10),
        operation: "M",
      });
    }
  }
}

/**
 * Parses `git diff --cached --name-status` for staged-only operations.
 * Applies operation type to cached-only entries.
 */
function parseCachedNameStatus(
  output: string,
  fileMap: Map<string, FileInfo>,
): void {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [status, ...rest] = trimmed.split("\t");
    const filePath = rest.join("\t");

    const op = normalizeStatus(status);
    if (!op) continue;

    const existing = fileMap.get(filePath);
    if (existing) {
      // Only update operation if current is the default "M"
      if (existing.operation === "M" && op !== "M") {
        existing.operation = op;
      }
    }
  }
}

/** Maps git status letters to our operation type. */
function normalizeStatus(status: string): "A" | "M" | "D" | null {
  if (status.startsWith("A")) return "A";
  if (status.startsWith("M")) return "M";
  if (status.startsWith("D")) return "D";
  return null;
}
