/**
 * Crash Recovery — unit tests.
 *
 * Tests run against real temp-dir git repos to exercise actual git operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskConfig } from "@shared/events.js";
import { runMigrations } from "./eventStore.js";
import { appendAndProject, initProjections } from "./projectionRunner.js";
import "./projections/register.js";
import { createWorktree } from "./worktree.js";
import { recoverWorktrees } from "./crashRecovery.js";

// ============================================================================
// Fixture helpers
// ============================================================================

async function makeTempRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-crash-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
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

const minimalConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-1",
      transport_options: { kind: "cli", bare: true, max_turns: 10, max_budget_usd: 1, permission_mode: "acceptEdits" },
      context_policy: { symbol_graph_depth: 2, include_tests: true, include_similar_patterns: false, token_budget: 8000 },
    },
  ],
  gates: [],
  retry_policy: {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

const testActor = { kind: "system" as const, component: "scheduler" as const };

/** Seed a task.created event so the task_detail projection has a row. */
function seedTask(db: Database.Database, taskId: string): void {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: {
      task_id: taskId,
      title: `Test task ${taskId}`,
      proposition_ids: [],
      config_snapshot: minimalConfig,
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("recoverWorktrees", () => {
  let repoRoot: string;
  let db: Database.Database;

  beforeAll(async () => {
    repoRoot = await makeTempRepo();
  });

  afterAll(() => {
    rmrf(repoRoot);
  });

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(async () => {
    db.close();
    // Best-effort cleanup
    const worktreesDir = path.join(repoRoot, ".orchestrator-worktrees");
    if (fs.existsSync(worktreesDir)) {
      for (const entry of fs.readdirSync(worktreesDir)) {
        const wtPath = path.join(worktreesDir, entry);
        try {
          await execa("git", ["worktree", "remove", "--force", wtPath], { cwd: repoRoot });
        } catch { /* ignore */ }
        try {
          await execa("git", ["branch", "-D", `wt/${entry}`], { cwd: repoRoot });
        } catch { /* ignore */ }
      }
    }
  });

  it("discards uncommitted file modifications in worktrees", async () => {
    const taskId = "T-crash-mod";
    seedTask(db, taskId);
    const { path: wtPath } = await createWorktree(db, taskId, { repoRoot });

    // Dirty the worktree with an uncommitted modification
    fs.writeFileSync(path.join(wtPath, "README.md"), "DIRTY\n");

    // Verify it's dirty
    const { stdout: before } = await execa("git", ["status", "--porcelain"], { cwd: wtPath });
    expect(before.trim()).not.toBe("");

    // Run recovery
    await recoverWorktrees(db);

    // Verify worktree is now clean
    const { stdout: after } = await execa("git", ["status", "--porcelain"], { cwd: wtPath });
    expect(after.trim()).toBe("");
  });

  it("discards untracked files in worktrees", async () => {
    const taskId = "T-crash-untracked";
    seedTask(db, taskId);
    const { path: wtPath } = await createWorktree(db, taskId, { repoRoot });

    // Add an untracked file
    fs.writeFileSync(path.join(wtPath, "stray-file.ts"), "leftover\n");
    expect(fs.existsSync(path.join(wtPath, "stray-file.ts"))).toBe(true);

    await recoverWorktrees(db);

    // Untracked file should be gone
    expect(fs.existsSync(path.join(wtPath, "stray-file.ts"))).toBe(false);
  });

  it("preserves committed state", async () => {
    const taskId = "T-crash-preserve";
    seedTask(db, taskId);
    const { path: wtPath } = await createWorktree(db, taskId, { repoRoot });

    // Make a proper commit inside the worktree
    fs.writeFileSync(path.join(wtPath, "committed.txt"), "safe\n");
    await execa("git", ["add", "committed.txt"], { cwd: wtPath });
    await execa("git", ["commit", "-m", "attempt commit", "--no-gpg-sign"], { cwd: wtPath });

    // Then dirty it further
    fs.writeFileSync(path.join(wtPath, "committed.txt"), "DIRTY\n");

    await recoverWorktrees(db);

    // Committed file should still exist with committed content
    const content = fs.readFileSync(path.join(wtPath, "committed.txt"), "utf8");
    expect(content).toBe("safe\n");
  });

  it("skips worktree paths that no longer exist on disk", async () => {
    const taskId = "T-crash-missing";
    seedTask(db, taskId);
    await createWorktree(db, taskId, { repoRoot });

    // Forcibly remove the worktree directory without going through git
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    fs.rmSync(wtPath, { recursive: true, force: true });

    // Should not throw
    await expect(recoverWorktrees(db)).resolves.not.toThrow();
  });

  it("handles multiple worktrees in a single recovery pass", async () => {
    seedTask(db, "T-crash-multi-1");
    seedTask(db, "T-crash-multi-2");
    const { path: wt1 } = await createWorktree(db, "T-crash-multi-1", { repoRoot });
    const { path: wt2 } = await createWorktree(db, "T-crash-multi-2", { repoRoot });

    // Dirty both
    fs.writeFileSync(path.join(wt1, "README.md"), "DIRTY1\n");
    fs.writeFileSync(path.join(wt2, "README.md"), "DIRTY2\n");

    await recoverWorktrees(db);

    // Both should be clean
    const { stdout: s1 } = await execa("git", ["status", "--porcelain"], { cwd: wt1 });
    const { stdout: s2 } = await execa("git", ["status", "--porcelain"], { cwd: wt2 });
    expect(s1.trim()).toBe("");
    expect(s2.trim()).toBe("");
  });
});
