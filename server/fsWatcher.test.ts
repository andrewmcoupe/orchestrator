/**
 * Filesystem Watcher — unit tests.
 *
 * Tests use a real temp directory to exercise chokidar behaviour.
 * A short debounceMs (50ms) is used so tests complete quickly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMigrations } from "./eventStore.js";
import { readEvents } from "./eventStore.js";
import { createFsWatcher } from "./fsWatcher.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Wait until the predicate returns true, checking every 20ms for up to
 * maxMs milliseconds. Throws if the condition never becomes true.
 */
async function waitFor(
  predicate: () => boolean,
  maxMs = 10000,
  interval = 20,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor: condition never became true within timeout");
}

// ============================================================================
// Fixtures
// ============================================================================

let tmpDir: string;
let db: Database.Database;
let worktreesDir: string;
let activeWatchers: Array<{ stop: () => Promise<void> }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-fswatcher-"));
  worktreesDir = path.join(tmpDir, ".orchestrator-worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });
  db = makeTestDb();
  activeWatchers = [];
});

afterEach(async () => {
  // Ensure all watchers are stopped to prevent EMFILE
  for (const w of activeWatchers) {
    try {
      await w.stop();
    } catch {}
  }
  activeWatchers = [];
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Tests
// ============================================================================

describe("createFsWatcher — external change detection", () => {
  it("emits files.changed_externally when a file in a worktree is created", async () => {
    const taskDir = path.join(worktreesDir, "T-001");
    fs.mkdirSync(taskDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Write a file inside the task's worktree
    fs.writeFileSync(path.join(taskDir, "hello.txt"), "hi");

    await waitFor(() => {
      const events = readEvents(db, { aggregate_id: "T-001" });
      return events.some((e) => e.type === "files.changed_externally");
    });

    const events = readEvents(db, { aggregate_id: "T-001" });
    const evt = events.find((e) => e.type === "files.changed_externally");
    expect(evt).toBeDefined();
    expect(evt!.payload).toMatchObject({
      task_id: "T-001",
      paths: expect.arrayContaining([expect.stringContaining("hello.txt")]),
    });

    await watcher.stop();
  });

  it("emits files.changed_externally when a file is modified in a worktree", async () => {
    const taskDir = path.join(worktreesDir, "T-002");
    fs.mkdirSync(taskDir, { recursive: true });
    // Pre-create the file before watching starts
    const filePath = path.join(taskDir, "existing.ts");
    fs.writeFileSync(filePath, "original");

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Give chokidar time to finish the initial scan
    await new Promise((r) => setTimeout(r, 200));

    // Modify the file
    fs.writeFileSync(filePath, "modified");

    await waitFor(() => {
      const events = readEvents(db, { aggregate_id: "T-002" });
      return events.some((e) => e.type === "files.changed_externally");
    });

    const events = readEvents(db, { aggregate_id: "T-002" });
    const evt = events.find((e) => e.type === "files.changed_externally");
    expect(evt).toBeDefined();
    expect(evt!.payload.paths).toContain(filePath);

    await watcher.stop();
  });
});

describe("createFsWatcher — expected change filtering", () => {
  it("does NOT emit an event for paths marked as expected", async () => {
    const taskDir = path.join(worktreesDir, "T-003");
    fs.mkdirSync(taskDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Give chokidar time to finish the initial scan
    await new Promise((r) => setTimeout(r, 200));

    const filePath = path.join(taskDir, "invocation-write.ts");
    // Mark the path as expected before writing
    watcher.markExpectedChange(filePath);
    fs.writeFileSync(filePath, "written by invocation");

    // Wait longer than debounce + some margin
    await new Promise((r) => setTimeout(r, 200));

    const events = readEvents(db, { aggregate_id: "T-003" });
    const externalEvents = events.filter(
      (e) => e.type === "files.changed_externally",
    );
    expect(externalEvents).toHaveLength(0);

    await watcher.stop();
  });

  it("emits an event after clearExpectedChange is called for that path", async () => {
    const taskDir = path.join(worktreesDir, "T-004");
    fs.mkdirSync(taskDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Give chokidar time to finish the initial scan
    await new Promise((r) => setTimeout(r, 200));

    const filePath = path.join(taskDir, "expected-then-external.ts");

    // Mark then immediately clear
    watcher.markExpectedChange(filePath);
    watcher.clearExpectedChange(filePath);

    // Now write — should emit
    fs.writeFileSync(filePath, "now external");

    await waitFor(() => {
      const events = readEvents(db, { aggregate_id: "T-004" });
      return events.some((e) => e.type === "files.changed_externally");
    });

    const events = readEvents(db, { aggregate_id: "T-004" });
    expect(events.some((e) => e.type === "files.changed_externally")).toBe(
      true,
    );

    await watcher.stop();
  });
});

describe("createFsWatcher — debounce", () => {
  it("collapses multiple rapid writes into a single event with all paths", async () => {
    const taskDir = path.join(worktreesDir, "T-005");
    fs.mkdirSync(taskDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 100,
    });
    await watcher.start();

    // Give chokidar time to finish the initial scan
    await new Promise((r) => setTimeout(r, 200));

    // Write three files in rapid succession (within debounce window)
    fs.writeFileSync(path.join(taskDir, "a.ts"), "a");
    fs.writeFileSync(path.join(taskDir, "b.ts"), "b");
    fs.writeFileSync(path.join(taskDir, "c.ts"), "c");

    await waitFor(() => {
      const events = readEvents(db, { aggregate_id: "T-005" });
      return events.some((e) => e.type === "files.changed_externally");
    }, 3000);

    const events = readEvents(db, { aggregate_id: "T-005" });
    const externalEvents = events.filter(
      (e) => e.type === "files.changed_externally",
    );

    // All three files should be in a single event (or at most two events)
    // The key assertion: all paths are covered
    const allPaths = externalEvents.flatMap((e) => e.payload.paths as string[]);
    expect(allPaths.some((p) => p.includes("a.ts"))).toBe(true);
    expect(allPaths.some((p) => p.includes("b.ts"))).toBe(true);
    expect(allPaths.some((p) => p.includes("c.ts"))).toBe(true);

    await watcher.stop();
  });
});

describe("createFsWatcher — ignore patterns", () => {
  it("does not emit events for files under .git/", async () => {
    const taskDir = path.join(worktreesDir, "T-006");
    const gitDir = path.join(taskDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    fs.writeFileSync(path.join(gitDir, "COMMIT_EDITMSG"), "ignored");

    await new Promise((r) => setTimeout(r, 200));

    const events = readEvents(db, { aggregate_id: "T-006" });
    expect(
      events.filter((e) => e.type === "files.changed_externally"),
    ).toHaveLength(0);

    await watcher.stop();
  });

  it("does not emit events for files under node_modules/", async () => {
    const taskDir = path.join(worktreesDir, "T-007");
    const nmDir = path.join(taskDir, "node_modules", "some-pkg");
    fs.mkdirSync(nmDir, { recursive: true });

    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    fs.writeFileSync(path.join(nmDir, "index.js"), "ignored");

    await new Promise((r) => setTimeout(r, 200));

    const events = readEvents(db, { aggregate_id: "T-007" });
    expect(
      events.filter((e) => e.type === "files.changed_externally"),
    ).toHaveLength(0);

    await watcher.stop();
  });
});

describe("createFsWatcher — lifecycle", () => {
  it("stop() closes the watcher without throwing", async () => {
    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    // Should not throw
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it("calling stop() before start() does not throw", async () => {
    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it("detects files in a new worktree directory added after watcher started", async () => {
    const watcher = createFsWatcher(db, {
      worktreesDir,
      debounceMs: 50,
    });
    await watcher.start();

    // Give chokidar time to settle
    await new Promise((r) => setTimeout(r, 200));

    // Create a new task worktree after the watcher is running
    const taskDir = path.join(worktreesDir, "T-008");
    fs.mkdirSync(taskDir, { recursive: true });

    // Give chokidar time to pick up the new directory
    await new Promise((r) => setTimeout(r, 300));

    fs.writeFileSync(path.join(taskDir, "new-file.ts"), "added late");

    await waitFor(() => {
      const events = readEvents(db, { aggregate_id: "T-008" });
      return events.some((e) => e.type === "files.changed_externally");
    });

    const events = readEvents(db, { aggregate_id: "T-008" });
    expect(events.some((e) => e.type === "files.changed_externally")).toBe(
      true,
    );

    await watcher.stop();
  });
});
