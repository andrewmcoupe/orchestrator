/**
 * Git Worktree Management — unit tests.
 *
 * All tests run against a real temp-dir git repo fixture so we exercise
 * actual git operations rather than mocking them.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import { execa, execaSync } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "./eventStore.js";
import { initProjections } from "./projectionRunner.js";
import "./projections/register.js";
import {
  findHostRepoRoot,
  createWorktree,
  removeWorktree,
  listWorktrees,
  diffWorktree,
} from "./worktree.js";

// ============================================================================
// Fixture: a bare git repo in a temp directory
// ============================================================================

/** Creates an isolated git repo and returns its root path. */
async function makeTempRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-worktree-"));

  await execa("git", ["init", "--initial-branch=main"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });

  // Seed an initial commit so worktrees can be added
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", [
    "commit",
    "-m",
    "initial",
    "--no-gpg-sign",
  ], { cwd: dir });

  return dir;
}

/** Recursively removes a directory. */
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates an isolated in-memory SQLite DB with all migrations applied. */
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

// ============================================================================
// Tests
// ============================================================================

describe("findHostRepoRoot", () => {
  let repoRoot: string;

  beforeAll(async () => {
    repoRoot = await makeTempRepo();
  });

  afterAll(() => {
    rmrf(repoRoot);
  });

  it("returns the repo root when called from the root itself", () => {
    const found = findHostRepoRoot(repoRoot);
    expect(found).toBe(repoRoot);
  });

  it("returns the repo root when called from a subdirectory", () => {
    const subDir = path.join(repoRoot, "some", "nested", "dir");
    fs.mkdirSync(subDir, { recursive: true });
    const found = findHostRepoRoot(subDir);
    expect(found).toBe(repoRoot);
  });

  it("throws if no git repo is found up the tree", () => {
    // Use /tmp itself which should have no .git ancestor
    expect(() => findHostRepoRoot(os.tmpdir())).toThrow(/git repo/i);
  });
});

/** Removes all managed worktrees from a repo root (best-effort). */
function cleanupWorktrees(repoRoot: string): void {
  const worktreesDir = path.join(repoRoot, ".orchestrator-worktrees");
  if (!fs.existsSync(worktreesDir)) return;
  const entries = fs.readdirSync(worktreesDir);
  for (const entry of entries) {
    const wtPath = path.join(worktreesDir, entry);
    try {
      execaSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repoRoot,
      });
    } catch {
      // ignore
    }
    try {
      execaSync("git", ["branch", "-D", `wt/${entry}`], { cwd: repoRoot });
    } catch {
      // ignore
    }
  }
}

describe("createWorktree", () => {
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

  afterEach(() => {
    db.close();
    cleanupWorktrees(repoRoot);
  });

  it("creates the worktree directory at <repoRoot>/.orchestrator-worktrees/<taskId>", async () => {
    const taskId = "T-001-dir";
    const { path: wtPath } = await createWorktree(db, taskId, { repoRoot });

    const expectedPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    expect(wtPath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("creates a branch named wt/<taskId>", async () => {
    const taskId = "T-001-branch";
    const { branch } = await createWorktree(db, taskId, { repoRoot });
    expect(branch).toBe(`wt/${taskId}`);

    const { stdout } = await execa(
      "git",
      ["branch", "--list", `wt/${taskId}`],
      { cwd: repoRoot },
    );
    expect(stdout.trim()).toContain(`wt/${taskId}`);
  });

  it("emits a task.worktree_created event with path and branch", async () => {
    const taskId = "T-001-event";
    await createWorktree(db, taskId, { repoRoot });

    const rows = db
      .prepare("SELECT * FROM events WHERE type = 'task.worktree_created'")
      .all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload_json) as {
      task_id: string;
      path: string;
      branch: string;
      base_ref: string;
    };
    expect(payload.task_id).toBe(taskId);
    expect(payload.path).toBe(
      path.join(repoRoot, ".orchestrator-worktrees", taskId),
    );
    expect(payload.branch).toBe(`wt/${taskId}`);
  });

  it("adds .orchestrator-worktrees/ to the repo .gitignore on first use", async () => {
    await createWorktree(db, "T-001-gi", { repoRoot });

    const gitignorePath = path.join(repoRoot, ".gitignore");
    const contents = fs.readFileSync(gitignorePath, "utf8");
    expect(contents).toContain(".orchestrator-worktrees/");
  });

  it("does not duplicate the .gitignore entry on second call", async () => {
    await createWorktree(db, "T-001-nodup-a", { repoRoot });
    db.close();
    db = makeTestDb();
    await createWorktree(db, "T-001-nodup-b", { repoRoot });

    const gitignorePath = path.join(repoRoot, ".gitignore");
    const contents = fs.readFileSync(gitignorePath, "utf8");
    const matches = contents.match(/\.orchestrator-worktrees\//g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("diffWorktree", () => {
  let repoRoot: string;
  const taskId = "T-002";

  beforeAll(async () => {
    repoRoot = await makeTempRepo();
  });

  afterAll(() => {
    rmrf(repoRoot);
  });

  it("returns empty diff for a clean worktree", async () => {
    const db = makeTestDb();
    const { path: wtPath } = await createWorktree(db, taskId, { repoRoot });
    db.close();

    const result = await diffWorktree(taskId, repoRoot);
    expect(result.files).toHaveLength(0);

    // Cleanup
    await execa("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoRoot,
    });
    await execa("git", ["branch", "-D", `wt/${taskId}`], { cwd: repoRoot });
  });

  it("returns structured diff with lines_added and lines_removed after editing a file", async () => {
    const db = makeTestDb();
    const taskId2 = "T-002b";
    const { path: wtPath } = await createWorktree(db, taskId2, { repoRoot });
    db.close();

    // Modify an existing file in the worktree
    const filePath = path.join(wtPath, "README.md");
    fs.writeFileSync(
      filePath,
      "# test repo\n\nadded line 1\nadded line 2\nadded line 3\n",
    );

    const result = await diffWorktree(taskId2, repoRoot);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("README.md");
    expect(result.files[0].operation).toBe("M");
    expect(result.files[0].lines_added).toBeGreaterThan(0);

    // Cleanup
    await execa("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoRoot,
    });
    await execa("git", ["branch", "-D", `wt/${taskId2}`], { cwd: repoRoot });
  });

  it("detects newly added files in the diff", async () => {
    const db = makeTestDb();
    const taskId3 = "T-002c";
    const { path: wtPath } = await createWorktree(db, taskId3, { repoRoot });
    db.close();

    // Stage a new file so it shows in the diff
    const newFile = path.join(wtPath, "new-feature.ts");
    fs.writeFileSync(newFile, 'export const foo = "bar";\n');
    await execa("git", ["add", "new-feature.ts"], { cwd: wtPath });

    const result = await diffWorktree(taskId3, repoRoot);
    const added = result.files.find((f) => f.path === "new-feature.ts");
    expect(added).toBeDefined();
    expect(added?.operation).toBe("A");
    expect(added?.lines_added).toBeGreaterThan(0);

    // Cleanup
    await execa("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoRoot,
    });
    await execa("git", ["branch", "-D", `wt/${taskId3}`], { cwd: repoRoot });
  });
});

describe("removeWorktree", () => {
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

  afterEach(() => {
    db.close();
    cleanupWorktrees(repoRoot);
  });

  it("removes the worktree directory", async () => {
    const taskId = "T-003-dir";
    await createWorktree(db, taskId, { repoRoot });
    const wtPath = path.join(repoRoot, ".orchestrator-worktrees", taskId);
    expect(fs.existsSync(wtPath)).toBe(true);

    await removeWorktree(db, taskId, { repoRoot });
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("removes the wt/<taskId> branch", async () => {
    const taskId = "T-003-branch";
    await createWorktree(db, taskId, { repoRoot });
    await removeWorktree(db, taskId, { repoRoot });

    const { stdout } = await execa(
      "git",
      ["branch", "--list", `wt/${taskId}`],
      { cwd: repoRoot },
    );
    expect(stdout.trim()).toBe("");
  });

  it("emits a task.worktree_deleted event", async () => {
    const taskId = "T-003-event";
    await createWorktree(db, taskId, { repoRoot });
    await removeWorktree(db, taskId, { repoRoot });

    const rows = db
      .prepare("SELECT * FROM events WHERE type = 'task.worktree_deleted'")
      .all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);

    const payload = JSON.parse(rows[0].payload_json) as {
      task_id: string;
      path: string;
    };
    expect(payload.task_id).toBe(taskId);
    expect(payload.path).toBe(
      path.join(repoRoot, ".orchestrator-worktrees", taskId),
    );
  });

  it("is idempotent — removing a non-existent worktree does not throw", async () => {
    await expect(
      removeWorktree(db, "T-does-not-exist", { repoRoot }),
    ).resolves.not.toThrow();
  });
});

describe("listWorktrees", () => {
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

  afterEach(() => {
    db.close();
    cleanupWorktrees(repoRoot);
  });

  it("returns an empty array when no managed worktrees exist", async () => {
    const result = await listWorktrees(repoRoot);
    const managed = result.filter((w) =>
      w.worktreePath.includes(".orchestrator-worktrees"),
    );
    expect(managed).toHaveLength(0);
  });

  it("returns a WorktreeInfo for each created worktree", async () => {
    await createWorktree(db, "T-list-1", { repoRoot });
    await createWorktree(db, "T-list-2", { repoRoot });

    const result = await listWorktrees(repoRoot);
    const managed = result.filter((w) =>
      w.worktreePath.includes(".orchestrator-worktrees"),
    );
    expect(managed).toHaveLength(2);

    // Use the real path to handle any symlink resolution
    const realRepoRoot = fs.realpathSync(repoRoot);
    const paths = managed.map((w) => w.worktreePath);
    expect(paths).toContain(
      path.join(realRepoRoot, ".orchestrator-worktrees", "T-list-1"),
    );
    expect(paths).toContain(
      path.join(realRepoRoot, ".orchestrator-worktrees", "T-list-2"),
    );

    // Verify branches are reported
    const branches = managed.map((w) => w.branch);
    expect(branches).toContain("wt/T-list-1");
    expect(branches).toContain("wt/T-list-2");
  });
});
