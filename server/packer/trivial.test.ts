/**
 * Tests for the trivial context packer.
 *
 * Uses in-memory SQLite for isolation, injectable git-diff and find-test-files
 * dependencies, and a temp-dir blob store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMigrations } from "../eventStore.js";
import { createBlobStore } from "../blobStore.js";
import { pack } from "./trivial.js";
import type { TaskDetailRow, AttemptRow } from "@shared/projections.js";
import type {
  TaskConfig,
  ContextPolicy,
  AuditConcern,
} from "@shared/events.js";

// ============================================================================
// Test fixtures
// ============================================================================

const minimalConfig: TaskConfig = {
  phases: [],
  gates: [],
  retry_policy: {
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "retry_same",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

const testPolicy: ContextPolicy = {
  symbol_graph_depth: 0,
  include_tests: true,
  include_similar_patterns: false,
  token_budget: 4000,
};

function makeTask(overrides: Partial<TaskDetailRow> = {}): TaskDetailRow {
  return {
    task_id: "T-001",
    title: "Add user authentication",
    status: "running",
    config: minimalConfig,
    preset_override_keys: [],
    proposition_ids: [],
    last_event_id: "ev-000",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    attempt_id: "att-001",
    task_id: "T-001",
    attempt_number: 1,
    status: "running",
    started_at: new Date().toISOString(),
    tokens_in_total: 0,
    tokens_out_total: 0,
    cost_usd_total: 0,
    phases: {},
    gate_runs: [],
    files_changed: [],
    config_snapshot: minimalConfig,
    last_event_id: "ev-000",
    ...overrides,
  };
}

let evCounter = 0;
function insertEvent(
  db: Database.Database,
  type: string,
  payload: object,
  opts: {
    id?: string;
    aggregate_id?: string;
    correlation_id?: string;
  } = {},
): void {
  const id = opts.id ?? `ev-${String(++evCounter).padStart(3, "0")}`;
  db.prepare(
    `INSERT INTO events (id, type, aggregate_type, aggregate_id, version, ts, actor_json, correlation_id, payload_json)
     VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    type,
    opts.aggregate_id ?? id,
    evCounter,
    new Date().toISOString(),
    JSON.stringify({ kind: "system", component: "gate_runner" }),
    opts.correlation_id ?? null,
    JSON.stringify(payload),
  );
}

// No-op gitDiff (no file changes)
const noGitDiff = async () => "";

// No-op findTestFiles
const noTestFiles = async () => [];

// ============================================================================
// Test setup
// ============================================================================

let db: Database.Database;
let blobDir: string;

beforeEach(() => {
  evCounter = 0;
  db = new Database(":memory:");
  runMigrations(db);
  blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "packer-test-"));
});

afterEach(() => {
  db.close();
  fs.rmSync(blobDir, { recursive: true, force: true });
});

// ============================================================================
// test-author phase
// ============================================================================

describe("pack — test-author phase", () => {
  it("includes proposition texts in the prompt", async () => {
    insertEvent(db, "proposition.extracted", {
      proposition_id: "P-001",
      prd_id: "PRD-1",
      text: "Users must be able to log in with email and password",
      source_span: { section: "auth", line_start: 1, line_end: 2 },
      confidence: 0.95,
    });

    const result = await pack(
      {
        db,
        phase_name: "test-author",
        task: makeTask({ proposition_ids: ["P-001"] }),
        attempt: null,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain(
      "Users must be able to log in with email and password",
    );
  });

  it("falls back to task title when no propositions exist", async () => {
    const result = await pack(
      {
        db,
        phase_name: "test-author",
        task: makeTask({ proposition_ids: [], title: "Implement login flow" }),
        attempt: null,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("Implement login flow");
  });

  it("includes file paths mentioned in proposition text in the manifest", async () => {
    insertEvent(db, "proposition.extracted", {
      proposition_id: "P-002",
      prd_id: "PRD-1",
      text: "Update src/auth/login.ts and src/auth/session.ts to support OAuth",
      source_span: { section: "auth", line_start: 3, line_end: 4 },
      confidence: 0.9,
    });

    const result = await pack(
      {
        db,
        phase_name: "test-author",
        task: makeTask({ proposition_ids: ["P-002"] }),
        attempt: null,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    const filePaths = result.manifest.files.map((f) => f.path);
    expect(filePaths.some((p) => p.includes("src/auth/login.ts"))).toBe(true);
    expect(filePaths.some((p) => p.includes("src/auth/session.ts"))).toBe(true);
  });

  it("includes test files returned by findTestFiles in the manifest", async () => {
    const fakeTestFiles = async () => [
      "src/auth/login.test.ts",
      "src/auth/session.test.ts",
    ];

    const result = await pack(
      {
        db,
        phase_name: "test-author",
        task: makeTask(),
        attempt: null,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: fakeTestFiles },
    );

    const filePaths = result.manifest.files.map((f) => f.path);
    expect(filePaths).toContain("src/auth/login.test.ts");
    expect(filePaths).toContain("src/auth/session.test.ts");
  });
});

// ============================================================================
// implementer phase
// ============================================================================

describe("pack — implementer phase", () => {
  it("includes proposition texts in the prompt", async () => {
    insertEvent(db, "proposition.extracted", {
      proposition_id: "P-003",
      prd_id: "PRD-1",
      text: "Hash passwords with bcrypt before storing",
      source_span: { section: "security", line_start: 10, line_end: 11 },
      confidence: 0.98,
    });

    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask({ proposition_ids: ["P-003"] }),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("Hash passwords with bcrypt before storing");
  });

  it("includes gate failure output when a gate.failed event exists", async () => {
    const attempt = makeAttempt({ attempt_id: "att-002" });
    insertEvent(
      db,
      "gate.failed",
      {
        gate_run_id: "gr-001",
        gate_name: "tsc",
        duration_ms: 3000,
        failures: [
          {
            category: "type_error",
            location: { path: "src/auth/login.ts", line: 42 },
            excerpt: "Property 'hash' does not exist on type 'User'",
          },
        ],
      },
      { correlation_id: "att-002" },
    );

    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask(),
        attempt,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("tsc");
    expect(result.prompt).toContain(
      "Property 'hash' does not exist on type 'User'",
    );
  });

  it("includes prior auditor concerns when attempt has retry_feedback", async () => {
    const concerns: AuditConcern[] = [
      {
        category: "security",
        severity: "blocking",
        rationale: "Password is stored in plain text",
      },
    ];
    const attempt = makeAttempt({ attempt_id: "att-003" });
    insertEvent(
      db,
      "attempt.started",
      {
        attempt_id: "att-003",
        task_id: "T-001",
        attempt_number: 2,
        config_snapshot: minimalConfig,
        triggered_by: "retry",
        retry_feedback: concerns,
      },
      { aggregate_id: "att-003" },
    );

    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask(),
        attempt,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("Prior Auditor Concerns");
    expect(result.prompt).toContain("Password is stored in plain text");
    expect(result.prompt).toContain("[BLOCKING]");
  });

  it("includes files written by test-author in the manifest", async () => {
    const attempt = makeAttempt({ attempt_id: "att-004" });

    // Simulate test-author invocation
    insertEvent(
      db,
      "invocation.started",
      {
        invocation_id: "inv-001",
        attempt_id: "att-004",
        phase_name: "test-author",
        transport: "claude-code",
        model: "claude-sonnet-4-6",
        prompt_version_id: "pv-001",
        context_manifest_hash: "abc123",
      },
      { correlation_id: "att-004" },
    );
    insertEvent(
      db,
      "invocation.file_edited",
      {
        invocation_id: "inv-001",
        path: "src/auth/login.test.ts",
        operation: "create",
        patch_hash: "def456",
        lines_added: 42,
        lines_removed: 0,
      },
    );

    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask(),
        attempt,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    const filePaths = result.manifest.files.map((f) => f.path);
    expect(filePaths).toContain("src/auth/login.test.ts");
    expect(result.prompt).toContain("src/auth/login.test.ts");
  });
});

// ============================================================================
// auditor phase
// ============================================================================

describe("pack — auditor phase", () => {
  it("includes git diff in the prompt", async () => {
    const fakeDiff = async () =>
      `diff --git a/src/auth/login.ts b/src/auth/login.ts
index 1234567..abcdefg 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,6 +10,8 @@
+  const hashedPassword = await bcrypt.hash(password, 10);`;

    const result = await pack(
      {
        db,
        phase_name: "auditor",
        task: makeTask(),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: fakeDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("bcrypt.hash");
    expect(result.prompt).toContain("Changes Made");
  });

  it("includes proposition text in the prompt", async () => {
    insertEvent(db, "proposition.extracted", {
      proposition_id: "P-004",
      prd_id: "PRD-1",
      text: "The system must rate-limit failed login attempts",
      source_span: { section: "security", line_start: 20, line_end: 21 },
      confidence: 0.92,
    });

    const result = await pack(
      {
        db,
        phase_name: "auditor",
        task: makeTask({ proposition_ids: ["P-004"] }),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain(
      "The system must rate-limit failed login attempts",
    );
  });

  it("extracts changed files from git diff into manifest", async () => {
    const fakeDiff = async () =>
      `diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc..def 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,1 +1,2 @@
+export const x = 1;`;

    const result = await pack(
      {
        db,
        phase_name: "auditor",
        task: makeTask(),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: fakeDiff, findTestFiles: noTestFiles },
    );

    const filePaths = result.manifest.files.map((f) => f.path);
    expect(filePaths).toContain("src/auth/login.ts");
  });

  it("includes prior concerns in prompt for retry-with-feedback attempt", async () => {
    const concerns: AuditConcern[] = [
      {
        category: "correctness",
        severity: "blocking",
        rationale: "Login does not verify email before allowing access",
      },
    ];
    const attempt = makeAttempt({ attempt_id: "att-005" });
    insertEvent(
      db,
      "attempt.started",
      {
        attempt_id: "att-005",
        task_id: "T-001",
        attempt_number: 2,
        config_snapshot: minimalConfig,
        triggered_by: "retry",
        retry_feedback: concerns,
      },
      { aggregate_id: "att-005" },
    );

    const result = await pack(
      {
        db,
        phase_name: "auditor",
        task: makeTask(),
        attempt,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("Prior Auditor Concerns");
    expect(result.prompt).toContain(
      "Login does not verify email before allowing access",
    );
  });
});

// ============================================================================
// Manifest + blob store
// ============================================================================

describe("pack — manifest and blob store", () => {
  it("stores the manifest in the blob store and returns its hash", async () => {
    const blobStore = createBlobStore(blobDir);
    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask(),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore,
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = blobStore.getBlob(result.manifest_hash);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.toString())).toEqual(result.manifest);
  });

  it("manifest token_budget matches the policy", async () => {
    const policy: ContextPolicy = {
      ...testPolicy,
      token_budget: 8000,
    };

    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask(),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.manifest.token_budget).toBe(8000);
  });

  it("token estimate is within ~50% of naive char/3.5 calculation", async () => {
    const result = await pack(
      {
        db,
        phase_name: "implementer",
        task: makeTask({ title: "A".repeat(1000) }),
        attempt: makeAttempt(),
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    const naiveEstimate = Math.ceil(result.prompt.length / 3.5);
    const ratio = result.manifest.token_estimated / naiveEstimate;
    // Should be exactly equal (same formula), but tolerance handles minor drift
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});

// ============================================================================
// Unknown phase fallback
// ============================================================================

describe("pack — unknown phase", () => {
  it("returns a minimal prompt with task title for an unrecognised phase", async () => {
    const result = await pack(
      {
        db,
        phase_name: "custom-phase",
        task: makeTask({ title: "Do something custom" }),
        attempt: null,
        worktree_path: "/tmp/wt",
        policy: testPolicy,
        blobStore: createBlobStore(blobDir),
      },
      { gitDiff: noGitDiff, findTestFiles: noTestFiles },
    );

    expect(result.prompt).toContain("Do something custom");
    expect(result.prompt).toContain("Complete the task");
  });
});
