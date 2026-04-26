/**
 * Merge Workflow — integration tests.
 *
 * All tests run against a real temp-dir git repository so we exercise
 * actual git operations rather than mocking them.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "./eventStore.js";
import { initProjections } from "./projectionRunner.js";
import "./projections/register.js";
import { createWorktree } from "./worktree.js";
import { mergeTask } from "./merge.js";
import { clearGateRegistry, registerGate } from "./gates/registry.js";

// ============================================================================
// Fixture helpers
// ============================================================================

/**
 * Creates a fully initialised git repo with an initial commit in a temp dir.
 * git config is set so commits work without a global gitconfig.
 */
async function makeTempRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-merge-"));

  await execa("git", ["init", "--initial-branch=main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  await execa("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".orchestrator-worktrees/\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "initial", "--no-gpg-sign"], { cwd: dir });

  return dir;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  initProjections(db);
  return db;
}

/**
 * Makes a commit in the given directory with the specified file content.
 */
async function makeCommit(
  dir: string,
  filename: string,
  content: string,
  message = "feat: add file",
): Promise<void> {
  fs.writeFileSync(path.join(dir, filename), content);
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", message, "--no-gpg-sign"], { cwd: dir });
}

/**
 * Resolves to a temp config.yaml path that disables auto_delete_worktree.
 * Used by tests that want to verify the worktree survives after merge.
 */
function writeTempConfig(
  options: {
    strategy?: string;
    auto_delete_worktree?: boolean;
    preserve_branch?: boolean;
  } = {},
): string {
  const {
    strategy = "squash",
    auto_delete_worktree = false,
    preserve_branch = false,
  } = options;
  const tmpPath = path.join(
    os.tmpdir(),
    `orchestrator-merge-config-${Date.now()}.yaml`,
  );
  fs.writeFileSync(
    tmpPath,
    `on_merge:\n  strategy: ${strategy}\n  auto_delete_worktree: ${auto_delete_worktree}\n  preserve_branch: ${preserve_branch}\n`,
  );
  return tmpPath;
}

// ============================================================================
// Tests
// ============================================================================

describe("mergeTask", () => {
  let repoRoot: string;
  let db: Database.Database;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    db = makeTestDb();
    // Ensure gate registry is empty — no gates to run by default.
    clearGateRegistry();
  });

  afterEach(() => {
    db.close();
    rmrf(repoRoot);
  });

  // ── Tracer bullet: basic squash merge ──────────────────────────────────────

  it("squash: merges worktree branch and emits task.merged event", async () => {
    const taskId = "T-MERGE-001";
    const attemptId = "A-MERGE-001";
    const configPath = writeTempConfig({ strategy: "squash", auto_delete_worktree: false });

    // Create a worktree and make a commit in it.
    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "hello world\n", "feat: add feature");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return; // type narrowing

    // The merge commit SHA should be a valid git SHA.
    expect(result.merge_commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // The new file should exist in the main working tree.
    expect(fs.existsSync(path.join(repoRoot, "feature.txt"))).toBe(true);

    // task.merged event should be in the event log.
    const mergeEvent = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'task.merged' AND aggregate_id = ?",
      )
      .get(taskId) as { payload_json: string } | undefined;

    expect(mergeEvent).toBeDefined();
    const payload = JSON.parse(mergeEvent!.payload_json) as {
      merge_commit_sha: string;
      into_branch: string;
      strategy: string;
    };
    expect(payload.merge_commit_sha).toBe(result.merge_commit_sha);
    expect(payload.into_branch).toBe("main");
    expect(payload.strategy).toBe("squash");

    fs.unlinkSync(configPath);
  });

  // ── Drift detection ────────────────────────────────────────────────────────

  it("returns drifted when target branch has advanced after worktree creation", async () => {
    const taskId = "T-DRIFT-001";
    const attemptId = "A-DRIFT-001";
    const configPath = writeTempConfig({ auto_delete_worktree: false });

    // Create worktree, then advance the main branch with an unrelated commit.
    await createWorktree(db, taskId, { repoRoot });
    await makeCommit(repoRoot, "unrelated.txt", "unrelated\n", "chore: unrelated");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("drifted");
    if (result.outcome !== "drifted") return;
    expect(result.commits_ahead).toBe(1);
    expect(result.can_merge_anyway).toBe(true);

    fs.unlinkSync(configPath);
  });

  it("bypasses drift check when force=true", async () => {
    const taskId = "T-DRIFT-002";
    const attemptId = "A-DRIFT-002";
    const configPath = writeTempConfig({
      strategy: "squash",
      auto_delete_worktree: false,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "my feature\n");

    // Advance the main branch (drift).
    await makeCommit(repoRoot, "unrelated.txt", "unrelated\n", "chore: unrelated");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
      force: true,
    });

    // Squash merge onto drifted base should still succeed.
    expect(result.outcome).toBe("merged");

    fs.unlinkSync(configPath);
  });

  // ── Conflict ───────────────────────────────────────────────────────────────

  it("returns conflicted when merge has conflicts, main tree remains clean", async () => {
    const taskId = "T-CONFLICT-001";
    const attemptId = "A-CONFLICT-001";
    const configPath = writeTempConfig({
      strategy: "merge",
      auto_delete_worktree: false,
    });

    // Both sides edit the same file at the same line.
    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);

    await makeCommit(wtPath, "shared.txt", "worktree version\n", "feat: worktree edit");
    await makeCommit(repoRoot, "shared.txt", "main version\n", "feat: main edit");

    // force=true bypasses the drift check so we reach the actual merge attempt.
    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
      force: true,
    });

    expect(result.outcome).toBe("conflicted");
    if (result.outcome !== "conflicted") return;
    expect(result.conflicting_paths).toContain("shared.txt");

    // Verify the main working tree is clean — no conflict markers.
    const sharedContent = fs.readFileSync(
      path.join(repoRoot, "shared.txt"),
      "utf-8",
    );
    expect(sharedContent).not.toContain("<<<<<<<");

    // merge.conflicted event should be present.
    const conflictEvent = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'merge.conflicted' AND aggregate_id = ?",
      )
      .get(taskId) as { payload_json: string } | undefined;
    expect(conflictEvent).toBeDefined();

    fs.unlinkSync(configPath);
  });

  // ── Strategy: merge (no-ff) ────────────────────────────────────────────────

  it("merge strategy: produces a merge commit with two parents", async () => {
    const taskId = "T-MERGE-NOFF-001";
    const attemptId = "A-MERGE-NOFF-001";
    const configPath = writeTempConfig({
      strategy: "merge",
      auto_delete_worktree: false,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return;

    // The merge commit should have two parents.
    const { stdout } = await execa(
      "git",
      ["log", "--pretty=%P", "-1", result.merge_commit_sha],
      { cwd: repoRoot },
    );
    const parents = stdout.trim().split(" ").filter(Boolean);
    expect(parents).toHaveLength(2);

    fs.unlinkSync(configPath);
  });

  // ── Strategy: ff-only ─────────────────────────────────────────────────────

  it("ff-only strategy: succeeds when history is linear", async () => {
    const taskId = "T-FF-001";
    const attemptId = "A-FF-001";
    const configPath = writeTempConfig({
      strategy: "ff-only",
      auto_delete_worktree: false,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    // No extra commits on main — history is linear.
    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");

    fs.unlinkSync(configPath);
  });

  it("ff-only strategy: throws when history is non-linear", async () => {
    const taskId = "T-FF-002";
    const attemptId = "A-FF-002";
    const configPath = writeTempConfig({
      strategy: "ff-only",
      auto_delete_worktree: false,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    // Advance main — makes history non-linear.
    await makeCommit(repoRoot, "unrelated.txt", "unrelated\n");

    // force=true bypasses the drift check so the ff-only strategy is actually attempted.
    await expect(
      mergeTask(db, taskId, attemptId, { repoRoot, configPath, force: true }),
    ).rejects.toThrow(/ff-only/);

    fs.unlinkSync(configPath);
  });

  // ── auto_delete_worktree ───────────────────────────────────────────────────

  it("leaves worktree in place when auto_delete_worktree=false", async () => {
    const taskId = "T-NODELETE-001";
    const attemptId = "A-NODELETE-001";
    const configPath = writeTempConfig({ auto_delete_worktree: false });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");
    // Worktree directory should still exist.
    expect(fs.existsSync(wtPath)).toBe(true);

    fs.unlinkSync(configPath);
  });

  it("removes worktree after merge when auto_delete_worktree=true", async () => {
    const taskId = "T-AUTODELETE-001";
    const attemptId = "A-AUTODELETE-001";
    const configPath = writeTempConfig({ auto_delete_worktree: true });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");
    // Worktree should be gone.
    expect(fs.existsSync(wtPath)).toBe(false);

    fs.unlinkSync(configPath);
  });

  // ── preserve_branch ────────────────────────────────────────────────────────

  it("preserves branch when preserve_branch=true and auto_delete_worktree=false", async () => {
    const taskId = "T-PREBRANCH-001";
    const attemptId = "A-PREBRANCH-001";
    const configPath = writeTempConfig({
      auto_delete_worktree: false,
      preserve_branch: true,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");

    // Branch wt/<taskId> should still exist.
    const { stdout } = await execa("git", ["branch", "--list", `wt/${taskId}`], {
      cwd: repoRoot,
    });
    expect(stdout.trim()).toContain(`wt/${taskId}`);

    fs.unlinkSync(configPath);
  });

  it("deletes branch when auto_delete_worktree=true and preserve_branch=false", async () => {
    const taskId = "T-DELBRANCH-001";
    const attemptId = "A-DELBRANCH-001";
    // auto_delete_worktree=true causes removeWorktree() which deletes both
    // the worktree directory and the branch.
    const configPath = writeTempConfig({
      auto_delete_worktree: true,
      preserve_branch: false,
    });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("merged");
    // Worktree and branch should both be removed.
    expect(fs.existsSync(wtPath)).toBe(false);
    const { stdout } = await execa("git", ["branch", "--list", `wt/${taskId}`], {
      cwd: repoRoot,
    });
    expect(stdout.trim()).toBe("");

    fs.unlinkSync(configPath);
  });

  // ── Gate failure ──────────────────────────────────────────────────────────

  it("returns gate_failed when a required gate fails before merge", async () => {
    const taskId = "T-GATE-001";
    const attemptId = "A-GATE-001";
    const configPath = writeTempConfig({ auto_delete_worktree: false });

    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    await makeCommit(wtPath, "feature.txt", "feature\n");

    // Register a gate that always fails.
    registerGate({
      name: "always-fail",
      command: "exit 1",
      timeout_seconds: 5,
      required: true,
      on_fail: "fail_task",
    });

    const result = await mergeTask(db, taskId, attemptId, {
      repoRoot,
      configPath,
    });

    expect(result.outcome).toBe("gate_failed");

    // merge.gate_failed event should be present.
    const gateFailEvent = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'merge.gate_failed' AND aggregate_id = ?",
      )
      .get(taskId) as { payload_json: string } | undefined;
    expect(gateFailEvent).toBeDefined();

    // The file should NOT have been merged into the main tree.
    expect(fs.existsSync(path.join(repoRoot, "feature.txt"))).toBe(false);

    fs.unlinkSync(configPath);
  });
});
