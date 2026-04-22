/**
 * Filesystem Watcher.
 *
 * Monitors .orchestrator-worktrees subtrees for external file changes:
 * changes NOT caused by an active invocation within this process.
 *
 * When genuine external changes are detected they are batched on a per-task
 * debounce window and emitted as a `files.changed_externally` event through
 * appendAndProject so downstream consumers (SSE, projections) see them.
 *
 * "Expected" changes (files written by an active invocation) are suppressed
 * via markExpectedChange() / clearExpectedChange() so only real human edits
 * trigger events.
 *
 * Ignored paths: .git/, node_modules/, dist/, .next/, build/, coverage/
 */

import type Database from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { appendAndProject } from "./projectionRunner.js";

// ============================================================================
// Types
// ============================================================================

export type FsWatcher = {
  /**
   * Start watching the worktrees directory.
   * Returns a promise that resolves when chokidar has finished its initial scan.
   * Safe to call multiple times.
   */
  start(): Promise<void>;

  /** Stop watching and release all resources. */
  stop(): Promise<void>;

  /**
   * Mark a file path as an "expected change" driven by an active invocation.
   * Changes to this path will be suppressed until clearExpectedChange is called.
   */
  markExpectedChange(filePath: string): void;

  /**
   * Remove a file path from the expected-changes set so future writes to it
   * will be treated as external.
   */
  clearExpectedChange(filePath: string): void;
};

export type FsWatcherOptions = {
  /**
   * Override the worktrees directory to watch.
   * Defaults to <host_repo_root>/.orchestrator-worktrees/
   */
  worktreesDir?: string;

  /** Debounce window in milliseconds. Defaults to 500. */
  debounceMs?: number;
};

// ============================================================================
// Ignored path segments
// ============================================================================

/** Directory names that should never trigger external-change events. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "build",
  "coverage",
  ".cache",
]);

/**
 * Returns true if any path segment is one of the ignored directory names.
 * Used as the chokidar `ignored` function — safer than glob patterns in v4.
 */
function isIgnoredPath(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some((seg) => IGNORED_DIRS.has(seg));
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a filesystem watcher that watches for external changes in all
 * task worktree directories under worktreesDir.
 *
 * @param db    Live database connection for appending events.
 * @param options  Optional configuration overrides.
 */
export function createFsWatcher(
  db: Database.Database,
  options: FsWatcherOptions = {},
): FsWatcher {
  const debounceMs = options.debounceMs ?? 500;

  // Resolve the worktrees directory to watch
  const worktreesDir =
    options.worktreesDir ??
    resolveDefaultWorktreesDir();

  // Set of absolute file paths driven by active invocations (suppressed)
  const expectedChanges = new Set<string>();

  // Per-task debounce state: task_id → { timer, paths }
  const pendingByTask = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; paths: Set<string> }
  >();

  let chokidarWatcher: FSWatcher | null = null;

  // -------------------------------------------------------------------------
  // Internal: handle a single file change event from chokidar
  // -------------------------------------------------------------------------

  function handleChange(filePath: string): void {
    // Normalise to absolute path
    const absPath = path.resolve(filePath);

    // Skip expected (invocation-driven) changes
    if (expectedChanges.has(absPath)) return;

    // Derive task_id from the path structure:
    //   <worktreesDir>/<task_id>/... → task_id is the first segment after worktreesDir
    const rel = path.relative(worktreesDir, absPath);
    const segments = rel.split(path.sep);
    if (segments.length < 2) return; // top-level entry, not inside a task dir
    const taskId = segments[0];
    if (!taskId) return;

    // Accumulate paths for this task and (re)start the debounce timer
    let entry = pendingByTask.get(taskId);
    if (!entry) {
      entry = { timer: null as unknown as ReturnType<typeof setTimeout>, paths: new Set() };
      pendingByTask.set(taskId, entry);
    }

    entry.paths.add(absPath);

    if (entry.timer) clearTimeout(entry.timer);

    entry.timer = setTimeout(() => {
      const paths = Array.from(entry!.paths);
      pendingByTask.delete(taskId);

      // Append the event through the canonical write path
      try {
        appendAndProject(db, {
          type: "files.changed_externally",
          aggregate_type: "task",
          aggregate_id: taskId,
          actor: { kind: "system", component: "watcher" },
          payload: {
            task_id: taskId,
            paths,
          },
        });
      } catch {
        // Non-fatal: log and continue (the watcher must not crash the server)
        // eslint-disable-next-line no-console
        console.warn(
          `[fsWatcher] Failed to append files.changed_externally for ${taskId}`,
        );
      }
    }, debounceMs);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(): Promise<void> {
    if (chokidarWatcher) return Promise.resolve(); // already watching

    // Ensure the worktrees directory exists before watching
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    chokidarWatcher = chokidar.watch(worktreesDir, {
      // Watch recursively, including new subdirectories added after start
      depth: 99,
      // Use polling as a fallback on network / Docker volumes, but prefer native
      usePolling: false,
      // Ignore known non-source directories using a function for v4 compatibility
      ignored: isIgnoredPath,
      // Don't fire for files that already exist when the watcher starts
      ignoreInitial: true,
    });

    chokidarWatcher.on("add", handleChange);
    chokidarWatcher.on("change", handleChange);
    // Deletions are also external changes
    chokidarWatcher.on("unlink", handleChange);

    // Resolve when chokidar finishes its initial scan so callers can safely
    // write files knowing the watcher is active.
    return new Promise<void>((resolve) => {
      chokidarWatcher!.on("ready", resolve);
    });
  }

  async function stop(): Promise<void> {
    // Cancel all pending debounce timers
    for (const { timer } of pendingByTask.values()) {
      clearTimeout(timer);
    }
    pendingByTask.clear();

    if (chokidarWatcher) {
      await chokidarWatcher.close();
      chokidarWatcher = null;
    }
  }

  function markExpectedChange(filePath: string): void {
    expectedChanges.add(path.resolve(filePath));
  }

  function clearExpectedChange(filePath: string): void {
    expectedChanges.delete(path.resolve(filePath));
  }

  return { start, stop, markExpectedChange, clearExpectedChange };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the default worktrees directory, resolved relative to this file's
 * location (orchestrator/server/ → orchestrator/../.orchestrator-worktrees/).
 */
function resolveDefaultWorktreesDir(): string {
  // Walk up from orchestrator/server/ to find the host repo root, then append
  // the conventional worktrees dir name.
  // import.meta.dirname is the compiled server/ directory.
  const serverDir = import.meta.dirname;
  const orchestratorDir = path.resolve(serverDir, "..");
  const repoRoot = path.resolve(orchestratorDir, "..");
  return path.join(repoRoot, ".orchestrator-worktrees");
}
