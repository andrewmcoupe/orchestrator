/**
 * Merge Workflow — takes an approved task's worktree branch and merges it
 * into the main working tree branch.
 *
 * Flow:
 *  1. Resolve target branch (HEAD of main tree if not supplied).
 *  2. Drift check — if target branch has advanced since the worktree was
 *     created and force is not set, return { outcome: 'drifted' }.
 *  3. Run all required gates in the worktree. If any fail, emit
 *     merge.gate_failed and return { outcome: 'gate_failed' }.
 *  4. Perform the merge in the MAIN working tree using the configured
 *     strategy (squash | merge | ff-only).
 *  5. On conflict: abort, emit merge.conflicted, return { outcome: 'conflicted' }.
 *  6. On success: emit task.merged, optionally remove worktree / branch,
 *     return { outcome: 'merged', merge_commit_sha }.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { appendAndProject } from "./projectionRunner.js";
import { removeWorktree, getDefaultRepoRoot } from "./worktree.js";
import { listGates } from "./gates/registry.js";
import { runGate } from "./gates/runner.js";
import type { MergeStrategy, Actor } from "@shared/events.js";
import type { GateFailure } from "./gates/parsers/types.js";
import { getConfigPath } from "./paths.js";

// ============================================================================
// Config loading
// ============================================================================

type OnMergeConfig = {
  strategy: MergeStrategy;
  auto_delete_worktree: boolean;
  preserve_branch: boolean;
};

const CONFIG_PATH = getConfigPath();

function loadMergeConfig(configPath = CONFIG_PATH): OnMergeConfig {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as {
      on_merge?: Partial<OnMergeConfig>;
    };
    return {
      strategy: config.on_merge?.strategy ?? "squash",
      auto_delete_worktree: config.on_merge?.auto_delete_worktree ?? true,
      preserve_branch: config.on_merge?.preserve_branch ?? false,
    };
  } catch {
    return { strategy: "squash", auto_delete_worktree: true, preserve_branch: false };
  }
}

// ============================================================================
// Public types
// ============================================================================

export type MergeResult =
  | { outcome: "merged"; merge_commit_sha: string }
  | { outcome: "drifted"; commits_ahead: number; can_merge_anyway: true }
  | { outcome: "conflicted"; conflicting_paths: string[] }
  | { outcome: "gate_failed"; failures: GateFailure[] };

export type MergeOptions = {
  into_branch?: string;
  strategy?: MergeStrategy;
  force?: boolean;
  /** Custom commit message for squash merges (from the UI editor). Overrides the auto-generated message. */
  commit_message?: string;
  /** Override the repo root — used in tests to point at a fixture repo. */
  repoRoot?: string;
  /** Override config path — used in tests. */
  configPath?: string;
};

// ============================================================================
// Internal merge helper
// ============================================================================

type MergeAttemptResult =
  | { success: true; merge_commit_sha: string }
  | { success: false; type: "conflict"; conflicting_paths: string[] }
  | { success: false; type: "ff_failed"; reason: string };

/**
 * Executes the actual git merge command in the main working tree.
 * Returns a typed result rather than throwing so the caller can emit the
 * appropriate event before surfacing the outcome.
 */
async function performMerge(
  repoRoot: string,
  worktreeBranch: string,
  strategy: MergeStrategy,
  title: string,
  commitMessageOverride?: string,
): Promise<MergeAttemptResult> {
  if (strategy === "squash") {
    const result = await execa("git", ["merge", "--squash", worktreeBranch], {
      cwd: repoRoot,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.exitCode !== 0) {
      // Squash leaves unmerged index entries — find them before resetting.
      const conflictResult = await execa(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: repoRoot, reject: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      const conflicting_paths = conflictResult.stdout
        .split("\n")
        .filter(Boolean);

      // Squash doesn't create MERGE_HEAD, so reset hard to clean up.
      await execa("git", ["reset", "--hard", "HEAD"], {
        cwd: repoRoot,
        reject: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      return { success: false, type: "conflict", conflicting_paths };
    }

    // Commit the squashed changes. Use the UI-provided message if supplied.
    const commitMsg = commitMessageOverride ?? `${title}\n\nAuto-merged by orchestrator`;
    await execa("git", ["commit", "--allow-empty", "-m", commitMsg, "--no-gpg-sign"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sha = (
      await execa("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
    ).stdout.trim();

    return { success: true, merge_commit_sha: sha };
  }

  if (strategy === "merge") {
    const result = await execa(
      "git",
      ["merge", "--no-ff", worktreeBranch, "-m", title, "--no-gpg-sign"],
      { cwd: repoRoot, reject: false, stdio: ["ignore", "pipe", "pipe"] },
    );

    if (result.exitCode !== 0) {
      const conflictResult = await execa(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: repoRoot, reject: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      const conflicting_paths = conflictResult.stdout
        .split("\n")
        .filter(Boolean);

      await execa("git", ["merge", "--abort"], {
        cwd: repoRoot,
        reject: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      return { success: false, type: "conflict", conflicting_paths };
    }

    const sha = (
      await execa("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
    ).stdout.trim();

    return { success: true, merge_commit_sha: sha };
  }

  // ff-only
  const result = await execa("git", ["merge", "--ff-only", worktreeBranch], {
    cwd: repoRoot,
    reject: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    const output = stderr || stdout;

    // Detect fast-forward refusal (non-linear history) vs. a true conflict.
    if (
      output.toLowerCase().includes("not possible to fast-forward") ||
      output.toLowerCase().includes("refusing to merge") ||
      output.toLowerCase().includes("aborting") ||
      output.toLowerCase().includes("fatal")
    ) {
      return { success: false, type: "ff_failed", reason: output };
    }

    // Genuine conflict (rare for ff-only, but possible in some edge cases).
    const conflictResult = await execa(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: repoRoot, reject: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const conflicting_paths = conflictResult.stdout.split("\n").filter(Boolean);

    await execa("git", ["merge", "--abort"], {
      cwd: repoRoot,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return { success: false, type: "conflict", conflicting_paths };
  }

  const sha = (
    await execa("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  ).stdout.trim();

  return { success: true, merge_commit_sha: sha };
}

// ============================================================================
// mergeTask
// ============================================================================

/**
 * Merges an approved task's worktree branch into the main working tree branch.
 *
 * @param db         - SQLite database for reading projections and writing events.
 * @param task_id    - The task whose worktree branch should be merged.
 * @param attempt_id - The approved attempt associated with this merge.
 * @param options    - Optional overrides for branch, strategy, force, repoRoot.
 */
export async function mergeTask(
  db: Database.Database,
  task_id: string,
  attempt_id: string,
  options: MergeOptions = {},
): Promise<MergeResult> {
  const repoRoot = options.repoRoot ?? getDefaultRepoRoot();
  const fileConfig = loadMergeConfig(options.configPath);
  const strategy = options.strategy ?? fileConfig.strategy;
  const force = options.force ?? false;
  const actor: Actor = { kind: "user", user_id: "local" };

  // Read task detail for title and worktree_path.
  const taskRow = db
    .prepare(
      "SELECT title, worktree_path FROM proj_task_detail WHERE task_id = ?",
    )
    .get(task_id) as
    | { title: string; worktree_path: string | null }
    | undefined;

  const title = taskRow?.title ?? task_id;
  const worktreePath =
    taskRow?.worktree_path ??
    path.join(repoRoot, ".orchestrator-worktrees", task_id);

  const worktreeBranch = `wt/${task_id}`;

  // ── 1. Resolve target branch ──────────────────────────────────────────────
  const intoBranch =
    options.into_branch ??
    (
      await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
    ).stdout.trim();

  // ── 2. Drift check ────────────────────────────────────────────────────────
  const mergeBase = (
    await execa("git", ["merge-base", worktreeBranch, intoBranch], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  ).stdout.trim();

  const targetHead = (
    await execa("git", ["rev-parse", intoBranch], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  ).stdout.trim();

  if (mergeBase !== targetHead && !force) {
    const commitsAheadStr = (
      await execa("git", ["rev-list", `${mergeBase}..${intoBranch}`, "--count"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      })
    ).stdout.trim();
    return {
      outcome: "drifted",
      commits_ahead: parseInt(commitsAheadStr, 10),
      can_merge_anyway: true,
    };
  }

  // ── 3. Gate checks ────────────────────────────────────────────────────────
  const gates = listGates().filter((g) => g.required !== false);
  for (const gate of gates) {
    const result = await runGate(db, gate, attempt_id, worktreePath);
    if (result.status !== "passed") {
      appendAndProject(db, {
        type: "merge.gate_failed",
        aggregate_type: "task",
        aggregate_id: task_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          task_id,
          attempt_id,
          gate_name: gate.name,
          failures: result.failures ?? [],
        },
      });
      return { outcome: "gate_failed", failures: result.failures ?? [] };
    }
  }

  // ── 4. Perform merge ──────────────────────────────────────────────────────
  const mergeAttempt = await performMerge(
    repoRoot,
    worktreeBranch,
    strategy,
    title,
    options.commit_message,
  );

  if (!mergeAttempt.success) {
    if (mergeAttempt.type === "conflict") {
      appendAndProject(db, {
        type: "merge.conflicted",
        aggregate_type: "task",
        aggregate_id: task_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          task_id,
          attempt_id,
          conflicting_paths: mergeAttempt.conflicting_paths,
          attempted_into_branch: intoBranch,
        },
      });
      return {
        outcome: "conflicted",
        conflicting_paths: mergeAttempt.conflicting_paths,
      };
    }

    // ff_failed — surface as a thrown error so the command layer returns 500.
    throw new Error(
      `Cannot merge task ${task_id} with ff-only strategy: ${mergeAttempt.reason}`,
    );
  }

  // ── 5. Post-merge: events + cleanup ───────────────────────────────────────
  const merge_commit_sha = mergeAttempt.merge_commit_sha;

  const advancedStr = (
    await execa("git", ["rev-list", `${mergeBase}..${merge_commit_sha}`, "--count"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  ).stdout.trim();
  const advanced_by_commits = parseInt(advancedStr, 10);

  appendAndProject(db, {
    type: "task.merged",
    aggregate_type: "task",
    aggregate_id: task_id,
    actor,
    payload: {
      task_id,
      attempt_id,
      merge_commit_sha,
      into_branch: intoBranch,
      strategy,
      advanced_by_commits,
    },
  });

  // Cleanup per config.
  if (fileConfig.auto_delete_worktree) {
    // removeWorktree deletes both the worktree directory AND the branch.
    await removeWorktree(db, task_id, { repoRoot });
  } else if (!fileConfig.preserve_branch) {
    // Leave the worktree but prune the tracking branch.
    try {
      await execa("git", ["branch", "-D", worktreeBranch], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Branch may already be gone — not an error.
    }
  }
  // If preserve_branch is true, leave both worktree and branch intact.

  return { outcome: "merged", merge_commit_sha };
}
