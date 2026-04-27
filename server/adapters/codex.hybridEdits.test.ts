/**
 * Tests for hybrid file edit detection in the Codex adapter.
 *
 * AC1: file_change items emit invocation.file_edited directly from structured data
 * AC2: command_execution items trigger detectFileEdits via git diff as a safety net
 * AC3: seenSnapshot pattern (from claudeCode.ts) deduplicates across git diff calls
 *
 * These tests mock execa so that detectFileEdits returns controlled git diff output,
 * while using an injected fake Spawner for the codex subprocess.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execa so detectFileEdits gets controlled git diff output
const { mockExeca } = vi.hoisted(() => ({ mockExeca: vi.fn() }));
vi.mock("execa", () => ({ execa: mockExeca }));

import {
  invoke,
  detectFileEdits,
  translateLine,
  type InvokeOptions,
  type CodexLine,
  type Spawner,
  type TranslateContext,
} from "./codex.js";
import type { BlobStore } from "../blobStore.js";
import type { AppendEventInput } from "../eventStore.js";

// ============================================================================
// Helpers
// ============================================================================

function makeBlobStore(): BlobStore & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    putBlob(content) {
      const key = Buffer.isBuffer(content)
        ? content.toString("hex").slice(0, 8)
        : String(content).slice(0, 8);
      const hash = "a".repeat(64 - key.length) + key;
      stored.set(hash, Buffer.isBuffer(content) ? content.toString() : String(content));
      return { hash };
    },
    getBlob(hash) {
      const v = stored.get(hash);
      return v ? Buffer.from(v) : null;
    },
    hasBlob(hash) {
      return stored.has(hash);
    },
  };
}

const baseOpts: InvokeOptions = {
  invocation_id: "inv-hybrid-001",
  attempt_id: "att-hybrid-001",
  phase_name: "implementer",
  model: "o3",
  prompt: "Make changes",
  prompt_version_id: "pv-001",
  context_manifest_hash: "abc123",
  cwd: "/tmp/worktree/hybrid-test",
  transport_options: {
    kind: "cli",
    max_turns: 10,
    max_budget_usd: 1.0,
    permission_mode: "acceptEdits",
  },
};

/** Helper: builds a fake spawner that yields the given NDJSON lines. */
function fakeSpawner(lines: string[]): Spawner {
  return async function* (_cmd, _args, _opts) {
    for (const line of lines) yield line;
  };
}

/** Helper: sets up mockExeca to return specific numstat + name-status output. */
function setupGitDiffMock(
  numstat: string,
  nameStatus: string,
) {
  mockExeca.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "git" && args.includes("--numstat")) {
      return Promise.resolve({ stdout: numstat });
    }
    if (cmd === "git" && args.includes("--name-status")) {
      return Promise.resolve({ stdout: nameStatus });
    }
    return Promise.reject(new Error(`unexpected execa call: ${cmd} ${args.join(" ")}`));
  });
}

// ============================================================================
// AC1: file_change items emit file_edited directly from structured data
// ============================================================================

describe("AC1: file_change items emit file_edited directly", () => {
  let bs: ReturnType<typeof makeBlobStore>;

  beforeEach(() => {
    bs = makeBlobStore();
    mockExeca.mockReset();
    // Default: git diff returns nothing (no safety-net edits)
    setupGitDiffMock("", "");
  });

  it("emits file_edited with path and operation=create for kind=add", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-1", changes: [{ path: "src/new.ts", kind: "add" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/new.ts",
      operation: "create",
      lines_added: 0,
      lines_removed: 0,
    });
  });

  it("emits file_edited with operation=update for kind=update", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-2", changes: [{ path: "src/existing.ts", kind: "update" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/existing.ts",
      operation: "update",
    });
  });

  it("emits file_edited with operation=delete for kind=delete", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-3", changes: [{ path: "src/old.ts", kind: "delete" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/old.ts",
      operation: "delete",
      lines_added: 0,
      lines_removed: 0,
    });
  });

  it("emits file_edited for each change in a multi-change item and across items", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-a", changes: [
          { path: "a.ts", kind: "add" },
          { path: "b.ts", kind: "update" },
        ]},
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-c", changes: [{ path: "c.ts", kind: "delete" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(3);
    expect((fileEdited[0].payload as any).path).toBe("a.ts");
    expect((fileEdited[1].payload as any).path).toBe("b.ts");
    expect((fileEdited[2].payload as any).path).toBe("c.ts");
  });
});

// ============================================================================
// AC2: command_execution triggers detectFileEdits via git diff safety net
// ============================================================================

describe("AC2: command_execution triggers git diff safety net", () => {
  let bs: ReturnType<typeof makeBlobStore>;

  beforeEach(() => {
    bs = makeBlobStore();
    mockExeca.mockReset();
  });

  it("yields file_edited from git diff after command_execution completes", async () => {
    // Git diff reports that command_execution modified a file
    setupGitDiffMock(
      "5\t2\tsrc/modified-by-cmd.ts",
      "M\tsrc/modified-by-cmd.ts",
    );

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", id: "cmd-1", command: "sed -i 's/old/new/g' src/modified-by-cmd.ts" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "sed -i 's/old/new/g' src/modified-by-cmd.ts", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/modified-by-cmd.ts",
      operation: "update",
      lines_added: 5,
      lines_removed: 2,
    });
  });

  it("yields multiple file_edited events when command modifies several files", async () => {
    setupGitDiffMock(
      "10\t0\tnew-file.ts\n3\t1\texisting.ts",
      "A\tnew-file.ts\nM\texisting.ts",
    );

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "make build", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(2);

    const paths = fileEdited.map(e => (e.payload as any).path);
    expect(paths).toContain("new-file.ts");
    expect(paths).toContain("existing.ts");

    const newFile = fileEdited.find(e => (e.payload as any).path === "new-file.ts");
    expect(newFile!.payload).toMatchObject({ operation: "create", lines_added: 10 });
  });

  it("does not yield duplicate file_edited for paths already emitted by file_change", async () => {
    // file_change emits file_edited for "src/foo.ts"
    // git diff also reports "src/foo.ts" — it should be suppressed via fileChangePathsSeen
    setupGitDiffMock(
      "3\t0\tsrc/foo.ts",
      "A\tsrc/foo.ts",
    );

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.started",
        item: { type: "file_change", id: "fc-1", changes: [{ path: "src/foo.ts", kind: "add" }] },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-1", changes: [{ path: "src/foo.ts", kind: "add" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    // file_edited from translateLine; git diff duplicate should be suppressed
    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/foo.ts",
      operation: "create",
    });
  });

  it("suppresses git diff for file_change update paths (translateLine already emitted file_edited)", async () => {
    // fileChangePathsSeen includes all file_change paths, so git diff is suppressed
    setupGitDiffMock(
      "4\t2\tsrc/bar.ts",
      "M\tsrc/bar.ts",
    );

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-1", changes: [{ path: "src/bar.ts", kind: "update" }] },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    // Only one file_edited from translateLine; git diff duplicate suppressed
    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/bar.ts",
      operation: "update",
    });
  });

  it("does not emit file_edited from git diff when command_execution produces no file changes", async () => {
    setupGitDiffMock("", "");

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "echo hello", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(0);
  });
});

// ============================================================================
// AC3: seenSnapshot pattern deduplicates across git diff calls
// ============================================================================

describe("AC3: seenSnapshot deduplicates across git diff calls", () => {
  let bs: ReturnType<typeof makeBlobStore>;

  beforeEach(() => {
    bs = makeBlobStore();
    mockExeca.mockReset();
  });

  it("does not re-emit file_edited for unchanged files across consecutive command_executions", async () => {
    // Both command_execution items see the same git diff output.
    // The second call should NOT re-emit file_edited for the same unchanged file.
    setupGitDiffMock(
      "3\t1\tsrc/utils.ts",
      "M\tsrc/utils.ts",
    );

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      // First command
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "npm test", exit_code: 0 },
      }),
      // Second command — same git diff state
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-2", command: "npm lint", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    // Only one file_edited for src/utils.ts from the first git diff call
    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    expect(fileEdited).toHaveLength(1);
    expect(fileEdited[0].payload).toMatchObject({
      path: "src/utils.ts",
      operation: "update",
    });
  });

  it("emits new file_edited when git diff shows additional changes after second command", async () => {
    let callCount = 0;
    mockExeca.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== "git") return Promise.reject(new Error("unexpected"));

      callCount++;
      if (args.includes("--numstat")) {
        // First two calls (numstat+namestatus for cmd-1): one file
        // Next two calls (numstat+namestatus for cmd-2): two files
        if (callCount <= 2) {
          return Promise.resolve({ stdout: "3\t1\tsrc/a.ts" });
        }
        return Promise.resolve({ stdout: "3\t1\tsrc/a.ts\n7\t0\tsrc/b.ts" });
      }
      if (args.includes("--name-status")) {
        if (callCount <= 2) {
          return Promise.resolve({ stdout: "M\tsrc/a.ts" });
        }
        return Promise.resolve({ stdout: "M\tsrc/a.ts\nA\tsrc/b.ts" });
      }
      return Promise.reject(new Error("unexpected git args"));
    });

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "make step1", exit_code: 0 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-2", command: "make step2", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    // First command: src/a.ts (new)
    // Second command: src/a.ts (unchanged, skipped), src/b.ts (new)
    expect(fileEdited).toHaveLength(2);
    expect((fileEdited[0].payload as any).path).toBe("src/a.ts");
    expect((fileEdited[1].payload as any).path).toBe("src/b.ts");
    expect((fileEdited[1].payload as any).operation).toBe("create");
  });

  it("re-emits file_edited when line counts change between git diff calls", async () => {
    let callCount = 0;
    mockExeca.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== "git") return Promise.reject(new Error("unexpected"));
      callCount++;
      if (args.includes("--numstat")) {
        // First call: 3 added, 1 removed. Second call: 5 added, 1 removed (more changes).
        if (callCount <= 2) {
          return Promise.resolve({ stdout: "3\t1\tsrc/evolving.ts" });
        }
        return Promise.resolve({ stdout: "5\t1\tsrc/evolving.ts" });
      }
      if (args.includes("--name-status")) {
        return Promise.resolve({ stdout: "M\tsrc/evolving.ts" });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-1", command: "step1", exit_code: 0 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd-2", command: "step2", exit_code: 0 },
      }),
      JSON.stringify({ type: "turn.completed", turn_id: "turn-1" }),
    ];

    const events: AppendEventInput[] = [];
    for await (const ev of invoke(baseOpts, bs, fakeSpawner(lines))) {
      events.push(ev);
    }

    const fileEdited = events.filter(e => e.type === "invocation.file_edited");
    // Both calls should emit file_edited because line counts changed
    expect(fileEdited).toHaveLength(2);
    expect((fileEdited[0].payload as any).lines_added).toBe(3);
    expect((fileEdited[1].payload as any).lines_added).toBe(5);
  });
});

// ============================================================================
// detectFileEdits unit tests (direct)
// ============================================================================

describe("detectFileEdits", () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it("returns file_edited events from git diff numstat + name-status", async () => {
    setupGitDiffMock(
      "10\t0\tnew.ts\n2\t3\tchanged.ts",
      "A\tnew.ts\nM\tchanged.ts",
    );

    const snapshot = new Map<string, { lines_added: number; lines_removed: number; operation: string }>();
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(results).toHaveLength(2);
    expect(results[0].payload).toMatchObject({
      path: "new.ts",
      operation: "create",
      lines_added: 10,
      lines_removed: 0,
    });
    expect(results[1].payload).toMatchObject({
      path: "changed.ts",
      operation: "update",
      lines_added: 2,
      lines_removed: 3,
    });
  });

  it("skips files already in seenSnapshot with unchanged counts", async () => {
    setupGitDiffMock(
      "5\t2\talready-seen.ts",
      "M\talready-seen.ts",
    );

    const snapshot = new Map([
      ["already-seen.ts", { lines_added: 5, lines_removed: 2, operation: "M" }],
    ]);
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(results).toHaveLength(0);
  });

  it("emits file_edited when seenSnapshot has different counts for the same file", async () => {
    setupGitDiffMock(
      "8\t2\tchanged.ts",
      "M\tchanged.ts",
    );

    const snapshot = new Map([
      ["changed.ts", { lines_added: 5, lines_removed: 2, operation: "M" }],
    ]);
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(results).toHaveLength(1);
    expect(results[0].payload).toMatchObject({
      path: "changed.ts",
      lines_added: 8,
    });
  });

  it("handles rename lines as delete + add", async () => {
    setupGitDiffMock(
      "10\t0\tnew-name.ts",
      "R100\told-name.ts\tnew-name.ts",
    );

    const snapshot = new Map<string, { lines_added: number; lines_removed: number; operation: string }>();
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    const paths = results.map(r => (r.payload as any).path);
    expect(paths).toContain("old-name.ts");
    expect(paths).toContain("new-name.ts");

    const deleted = results.find(r => (r.payload as any).path === "old-name.ts");
    expect(deleted!.payload).toMatchObject({ operation: "delete" });

    const added = results.find(r => (r.payload as any).path === "new-name.ts");
    expect(added!.payload).toMatchObject({ operation: "create" });
  });

  it("returns empty array when git diff fails", async () => {
    mockExeca.mockRejectedValue(new Error("not a git repo"));

    const snapshot = new Map<string, { lines_added: number; lines_removed: number; operation: string }>();
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(results).toHaveLength(0);
  });

  it("updates seenSnapshot after emitting events", async () => {
    setupGitDiffMock(
      "3\t1\ttracked.ts",
      "M\ttracked.ts",
    );

    const snapshot = new Map<string, { lines_added: number; lines_removed: number; operation: string }>();
    await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(snapshot.get("tracked.ts")).toEqual({
      lines_added: 3,
      lines_removed: 1,
      operation: "M",
    });
  });

  it("uses transport codex in the actor field", async () => {
    setupGitDiffMock("1\t0\tf.ts", "A\tf.ts");

    const snapshot = new Map<string, { lines_added: number; lines_removed: number; operation: string }>();
    const results = await detectFileEdits("/some/cwd", "inv-1", "att-1", snapshot);

    expect(results[0].actor).toMatchObject({
      kind: "cli",
      transport: "codex",
    });
  });
});
