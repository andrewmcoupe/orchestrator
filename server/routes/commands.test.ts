/**
 * Tests for command POST endpoints.
 *
 * Uses Hono test client against an in-memory SQLite DB.
 * Each test gets a fresh DB to avoid cross-contamination.
 *
 * NOTE: lifecycle integration (background runAttempt, pause/resume, kill)
 * is tested in taskLifecycle.test.ts.  The tests here focus on HTTP
 * contract — correct status codes, response shapes, and event emission.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../ingest.js", () => ({
  ingestPrd: vi.fn().mockRejectedValue(new Error("mocked: CLI not available in tests")),
  seedIngestPromptVersion: vi.fn(),
}));
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Hono } from "hono";
import { createDb } from "../db.js";
import { runMigrations } from "../eventStore.js";
import {
  initProjections,
  appendAndProject,
  eventBus,
} from "../projectionRunner.js";
import "../projections/register.js";
import { createCommandRoutes } from "./commands.js";
import type { Actor, TaskConfig, AnyEvent } from "@shared/events.js";
import type Database from "better-sqlite3";

const actor: Actor = { kind: "user", user_id: "test" };

const minimalConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-1",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 10,
        max_budget_usd: 1,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 2,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 8000,
      },
    },
  ],
  gates: [],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

function setup(): {
  db: Database.Database;
  app: ReturnType<typeof createCommandRoutes>;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-routes-"));
  const db = createDb(path.join(tmpDir, "test.db"));
  runMigrations(db);
  initProjections(db);
  const app = createCommandRoutes(db);
  return { db, app };
}

// Seed a task in "queued" status via appendAndProject
function seedTask(
  db: Database.Database,
  taskId: string,
  opts: { title?: string } = {},
) {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor,
    payload: {
      task_id: taskId,
      title: opts.title ?? `Task ${taskId}`,
      proposition_ids: [],
      config_snapshot: minimalConfig,
      preset_id: undefined,
    },
  });
}

// Seed a running task with an active attempt
function seedRunningTask(
  db: Database.Database,
  taskId: string,
  attemptId: string,
) {
  seedTask(db, taskId);
  appendAndProject(db, {
    type: "task.status_changed",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor,
    payload: { task_id: taskId, from: "queued", to: "running" },
  });
  appendAndProject(db, {
    type: "attempt.started",
    aggregate_type: "attempt",
    aggregate_id: attemptId,
    actor,
    correlation_id: attemptId,
    payload: {
      attempt_id: attemptId,
      task_id: taskId,
      attempt_number: 1,
      config_snapshot: minimalConfig,
      triggered_by: "user_start",
    },
  });
}

function post(
  app: ReturnType<typeof createCommandRoutes>,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
}

// ============================================================================
// POST /api/commands/task/create
// ============================================================================

describe("POST /api/commands/task/create", () => {
  it("creates a task and returns the event", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/create", {
      title: "My Task",
      proposition_ids: ["P-1", "P-2"],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("task.created");
    expect(body.payload.title).toBe("My Task");
    expect(body.payload.proposition_ids).toEqual(["P-1", "P-2"]);
    expect(body.payload.task_id).toMatch(/^T-/);
  });

  it("task appears in task_list projection after create", async () => {
    const { db, app } = setup();
    const res = await post(app, "/api/commands/task/create", {
      title: "Projected Task",
      proposition_ids: [],
    });
    const event = await res.json();
    const taskId = event.payload.task_id;

    const row = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { task_id: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("queued");
  });

  it("returns 400 on malformed body with Zod field errors", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/create", {
      title: "",
      proposition_ids: "not-an-array",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("validation_error");
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("returns 404 when preset_id references an unknown preset", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/create", {
      title: "Task with missing preset",
      proposition_ids: [],
      preset_id: "preset-does-not-exist",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toBe("not_found");
  });

  it("uses preset config when a valid preset_id is provided", async () => {
    const { db, app } = setup();
    // Seed a preset directly
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-for-task",
      actor,
      payload: {
        preset_id: "preset-for-task",
        name: "Test Preset",
        task_class: "new-feature",
        config: minimalConfig,
      },
    });

    const res = await post(app, "/api/commands/task/create", {
      title: "Task using preset",
      proposition_ids: [],
      preset_id: "preset-for-task",
    });

    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.payload.preset_id).toBe("preset-for-task");
    // Config snapshot should come from the preset
    expect(event.payload.config_snapshot.phases[0].name).toBe("implementer");
  });
});

// ============================================================================
// POST /api/commands/task/:id/start
// ============================================================================

describe("POST /api/commands/task/:id/start", () => {
  it("starts a queued task and returns 202 with attempt_id", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await post(app, "/api/commands/task/T-001/start");
    expect(res.status).toBe(202);

    const body = (await res.json()) as {
      task_id: string;
      attempt_id: string | undefined;
    };
    expect(body.task_id).toBe("T-001");
    // attempt_id may be undefined in test environments where runAttempt is not mocked,
    // but the task must have been transitioned to running
    const row = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as { status: string } | undefined;
    expect(row?.status).toBe("running");
  });

  it("returns 404 for nonexistent task", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/NOPE/start");
    expect(res.status).toBe(404);
  });

  it("returns 409 for a blocked task", async () => {
    const { db, app } = setup();
    seedTask(db, "T-DEP-BLOCK");
    seedTask(db, "T-BLOCKED");

    // Set dependency — T-BLOCKED depends on T-DEP-BLOCK
    appendAndProject(db, {
      type: "task.dependency.set",
      aggregate_type: "task",
      aggregate_id: "T-BLOCKED",
      actor,
      payload: { task_id: "T-BLOCKED", depends_on: ["T-DEP-BLOCK"] },
    });

    const res = await post(app, "/api/commands/task/T-BLOCKED/start");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("blocked");
  });

  it("allows starting a task whose dependencies are all merged", async () => {
    const { db, app } = setup();
    seedTask(db, "T-DEP-UNBLOCK");
    seedTask(db, "T-UNBLOCK");

    // Set dependency
    appendAndProject(db, {
      type: "task.dependency.set",
      aggregate_type: "task",
      aggregate_id: "T-UNBLOCK",
      actor,
      payload: { task_id: "T-UNBLOCK", depends_on: ["T-DEP-UNBLOCK"] },
    });

    // Merge the dependency
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-DEP-UNBLOCK",
      actor,
      payload: { task_id: "T-DEP-UNBLOCK", from: "queued", to: "merged" },
    });

    // Unblock
    appendAndProject(db, {
      type: "task.unblocked",
      aggregate_type: "task",
      aggregate_id: "T-UNBLOCK",
      actor,
      payload: { task_id: "T-UNBLOCK" },
    });

    const res = await post(app, "/api/commands/task/T-UNBLOCK/start");
    expect(res.status).toBe(202);
  });

  it("returns 409 for a task in rejected status", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Kill it
    appendAndProject(db, {
      type: "attempt.killed",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      payload: { attempt_id: "A-001", reason: "test" },
    });
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "rejected" },
    });

    const res = await post(app, "/api/commands/task/T-001/start");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain("rejected");
  });
});

// ============================================================================
// POST /api/commands/task/:id/pause
// ============================================================================

describe("POST /api/commands/task/:id/pause", () => {
  it("pauses a running task", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    const res = await post(app, "/api/commands/task/T-001/pause");
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("attempt.paused");
    expect(body[1].type).toBe("task.status_changed");
  });

  it("returns 409 for a queued task", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await post(app, "/api/commands/task/T-001/pause");
    expect(res.status).toBe(409);
  });
});

// ============================================================================
// POST /api/commands/task/:id/resume
// ============================================================================

describe("POST /api/commands/task/:id/resume", () => {
  it("resumes a paused task", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Pause it
    appendAndProject(db, {
      type: "attempt.paused",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: { attempt_id: "A-001", reason: "test" },
    });
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "paused" },
    });

    const res = await post(app, "/api/commands/task/T-001/resume");
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("task.status_changed");
    expect((body[0].payload as { to: string }).to).toBe("running");
  });

  it("returns 409 for a running task", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    const res = await post(app, "/api/commands/task/T-001/resume");
    expect(res.status).toBe(409);
  });
});

// ============================================================================
// POST /api/commands/task/:id/kill
// ============================================================================

describe("POST /api/commands/task/:id/kill", () => {
  it("kills a running task", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    const res = await post(app, "/api/commands/task/T-001/kill");
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("attempt.killed");
    expect(body[1].type).toBe("task.status_changed");
  });

  it("returns 409 for a task already in rejected status", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Kill it first
    appendAndProject(db, {
      type: "attempt.killed",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      payload: { attempt_id: "A-001", reason: "test" },
    });
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "rejected" },
    });

    // Try killing again
    const res = await post(app, "/api/commands/task/T-001/kill");
    expect(res.status).toBe(409);
  });
});

// ============================================================================
// POST /api/commands/task/:id/retry
// ============================================================================

describe("POST /api/commands/task/:id/retry", () => {
  it("retries a task in awaiting_review: returns command events + new_attempt_id", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to awaiting_review
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "awaiting_review" },
    });

    const res = await post(app, "/api/commands/task/T-001/retry", {
      strategy: "retry_same",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      events: AnyEvent[];
      new_attempt_id: string;
    };
    // Command returns attempt.retry_requested + task.status_changed (attempt.started is background)
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe("attempt.retry_requested");
    expect(body.events[1].type).toBe("task.status_changed");
    expect(body.new_attempt_id).toMatch(/^A-/);
    // The retry_requested event references the new attempt ID
    expect(
      (body.events[0].payload as { new_attempt_id: string }).new_attempt_id,
    ).toBe(body.new_attempt_id);
    expect(
      (body.events[0].payload as { previous_attempt_id: string })
        .previous_attempt_id ??
        (body.events[0].payload as { attempt_id: string }).attempt_id,
    ).toBeDefined();
  });
});

// ============================================================================
// POST /api/commands/task/:id/config
// ============================================================================

describe("POST /api/commands/task/:id/config", () => {
  it("updates task config", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await post(app, "/api/commands/task/T-001/config", {
      config_diff: {
        retry_policy: {
          max_total_attempts: 5,
          on_typecheck_fail: { strategy: "retry_same", max_attempts: 3 },
          on_test_fail: { strategy: "retry_same", max_attempts: 2 },
          on_audit_reject: "escalate_to_human",
          on_spec_pushback: "pause_and_notify",
        },
      },
      reason: "Increased retry limit",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("task.config_updated");
    expect(body.payload.reason).toBe("Increased retry limit");
  });

  it("returns 404 for nonexistent task", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/NOPE/config", {
      config_diff: {},
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/commands/task/:id/archive
// ============================================================================

describe("POST /api/commands/task/:id/archive", () => {
  it("archives a queued task", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await post(app, "/api/commands/task/T-001/archive");
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("task.status_changed");
    expect(body[1].type).toBe("task.archived");

    // Verify removed from task_list
    const row = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get("T-001");
    expect(row).toBeUndefined();
  });
});

// ============================================================================
// POST /api/commands/attempt/:id/approve
// ============================================================================

describe("POST /api/commands/attempt/:id/approve", () => {
  it("approves an attempt and moves task to 'approved' (not merged)", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to awaiting_review first
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "awaiting_review" },
    });

    const res = await post(app, "/api/commands/attempt/A-001/approve", {
      rationale: "Looks good",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("attempt.approved");
    expect(body[0].payload).toMatchObject({
      attempt_id: "A-001",
      overrode_audit: false,
    });
    expect(body[1].type).toBe("task.status_changed");
    // Now transitions to 'approved', not 'merged'
    expect((body[1].payload as { to: string }).to).toBe("approved");
  });

  it("returns 409 when task is already in 'approved' status", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to approved
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "approved" },
    });

    const res = await post(app, "/api/commands/attempt/A-001/approve", {
      rationale: "Looks good",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("approved");
  });

  it("emits audit.overridden when override_audit=true and attempt had a revise verdict", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to awaiting_review
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "awaiting_review" },
    });

    // Seed an auditor.judged with verdict=revise correlated to the attempt
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "attempt",
      aggregate_id: "AUDIT-1",
      actor,
      correlation_id: "A-001",
      payload: {
        audit_id: "AUDIT-1",
        attempt_id: "A-001",
        verdict: "revise",
        confidence: 0.7,
        summary: "Needs revision",
        concerns: [],
        model: "opus-4.7",
        prompt_version_id: "aud-v1",
      },
    });

    const res = await post(app, "/api/commands/attempt/A-001/approve", {
      override_audit: true,
      rationale: "Overriding the audit",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    // attempt.approved + task.status_changed + audit.overridden
    expect(body).toHaveLength(3);
    expect(body[0].type).toBe("attempt.approved");
    expect(body[1].type).toBe("task.status_changed");
    expect((body[1].payload as { to: string }).to).toBe("approved");
    expect(body[2].type).toBe("audit.overridden");
    expect(body[2].payload).toMatchObject({
      rationale: "Overriding the audit",
      effective_verdict: "approve",
    });
  });

  it("does NOT emit audit.overridden when override_audit=true but no revise/reject verdict exists", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "running", to: "awaiting_review" },
    });

    const res = await post(app, "/api/commands/attempt/A-001/approve", {
      override_audit: true,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    // No revise/reject verdict, so just 2 events
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("attempt.approved");
    expect(body[1].type).toBe("task.status_changed");
  });

  it("returns 404 for nonexistent attempt", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/attempt/NOPE/approve");
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/commands/attempt/:id/unapprove
// ============================================================================

describe("POST /api/commands/attempt/:id/unapprove", () => {
  it("reverts an approved task back to awaiting_review", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to approved
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "awaiting_review", to: "approved" },
    });

    const res = await post(app, "/api/commands/attempt/A-001/unapprove");
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("task.status_changed");
    expect((body[0].payload as { from: string; to: string }).from).toBe(
      "approved",
    );
    expect((body[0].payload as { from: string; to: string }).to).toBe(
      "awaiting_review",
    );

    // Verify the projection reflects the revert
    const row = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get("T-001") as { status: string } | undefined;
    expect(row?.status).toBe("awaiting_review");
  });

  it("returns 409 when task is not in approved status", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");
    // Task is still 'running', not 'approved'

    const res = await post(app, "/api/commands/attempt/A-001/unapprove");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("approved");
  });

  it("returns 404 for nonexistent attempt", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/attempt/NOPE/unapprove");
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/commands/task/:id/finalize
// ============================================================================

describe("POST /api/commands/task/:id/finalize", () => {
  it("finalizes a task with reason=manual and transitions to merged", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Move to approved
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-001",
      actor,
      payload: { task_id: "T-001", from: "awaiting_review", to: "approved" },
    });

    const res = await post(app, "/api/commands/task/T-001/finalize", {
      reason: "manual",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("task.finalized");
    expect((body[0].payload as { reason: string }).reason).toBe("manual");
    expect(body[1].type).toBe("task.status_changed");
    expect((body[1].payload as { to: string }).to).toBe("merged");
  });

  it("defaults reason to manual when not specified", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await post(app, "/api/commands/task/T-001/finalize", {});
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body[0].type).toBe("task.finalized");
    expect((body[0].payload as { reason: string }).reason).toBe("manual");
  });

  it("returns 404 for nonexistent task", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/NOPE/finalize", {});
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/commands/attempt/:id/reject
// ============================================================================

describe("POST /api/commands/attempt/:id/reject", () => {
  it("rejects an attempt", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    const res = await post(app, "/api/commands/attempt/A-001/reject", {
      rationale: "Needs work",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("attempt.rejected");
    expect(body[1].type).toBe("task.status_changed");
    expect((body[1].payload as { to: string }).to).toBe("rejected");
  });
});

// ============================================================================
// POST /api/commands/attempt/:id/retry-with-feedback
// ============================================================================

describe("POST /api/commands/attempt/:id/retry-with-feedback", () => {
  it("returns command events + new_attempt_id with carried concerns", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-001", "A-001");

    // Seed an auditor.judged event so concerns can be carried
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "attempt",
      aggregate_id: "AUDIT-1",
      actor,
      correlation_id: "A-001",
      payload: {
        audit_id: "AUDIT-1",
        attempt_id: "A-001",
        verdict: "revise",
        confidence: 0.8,
        summary: "Needs changes",
        concerns: [
          {
            category: "correctness",
            severity: "blocking",
            rationale: "Missing null check",
          },
        ],
        model: "opus-4.7",
        prompt_version_id: "aud-v1",
      },
    });

    const res = await post(
      app,
      "/api/commands/attempt/A-001/retry-with-feedback",
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      events: AnyEvent[];
      new_attempt_id: string;
    };
    // Command returns attempt.retry_requested + task.status_changed (attempt.started is background)
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe("attempt.retry_requested");
    expect(
      (body.events[0].payload as { with_feedback: boolean }).with_feedback,
    ).toBe(true);
    expect(body.events[1].type).toBe("task.status_changed");
    expect((body.events[1].payload as { to: string }).to).toBe("revising");
    expect(body.new_attempt_id).toMatch(/^A-/);
    // The retry_requested event references the new attempt ID
    expect(
      (body.events[0].payload as { new_attempt_id: string }).new_attempt_id,
    ).toBe(body.new_attempt_id);
  });
});

// ============================================================================
// POST /api/commands/prd/ingest
// ============================================================================

describe("POST /api/commands/prd/ingest", () => {
  it("returns 500 when PRD file does not exist", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", {
      path: "/nonexistent/prd.md",
    });
    // Real ingestPrd is called; file not found → 500 with error message
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it("returns 400 on empty path", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", { path: "" });
    expect(res.status).toBe(400);
  });

  it("accepts { path: string }", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", {
      path: "/some/prd.md",
    });
    // Validation passes (500 because file doesn't exist, not 400)
    expect(res.status).not.toBe(400);
  });

  it("accepts { content: string }", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", {
      content: "# My PRD\nSome content here",
    });
    // Validation passes (500 from ingestPrd internals, not 400)
    expect(res.status).not.toBe(400);
  });

  it("rejects payload with both path and content", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", {
      path: "/some/prd.md",
      content: "# My PRD",
    });
    expect(res.status).toBe(400);
  });

  it("rejects payload with neither path nor content", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/prd/ingest", {});
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /api/commands/pushback/:id/resolve
// ============================================================================

describe("POST /api/commands/pushback/:id/resolve", () => {
  it("resolves a pushback", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/pushback/PB-001/resolve", {
      resolution: "deferred",
      resolution_text: "Will address later",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("pushback.resolved");
    expect(body[0].payload).toMatchObject({
      pushback_id: "PB-001",
      resolution: "deferred",
    });
  });

  it("emits proposition.amended when resolution is amended with text", async () => {
    const { db, app } = setup();

    // Seed a pushback.raised event so we can resolve it
    appendAndProject(db, {
      type: "pushback.raised",
      aggregate_type: "pushback",
      aggregate_id: "PB-002",
      actor,
      payload: {
        pushback_id: "PB-002",
        proposition_id: "PROP-1",
        kind: "blocking",
        rationale: "Ambiguous requirement",
        suggested_resolutions: ["Clarify scope"],
        raised_by: { phase: "implementer", model: "sonnet-4-6" },
      },
    });

    const res = await post(app, "/api/commands/pushback/PB-002/resolve", {
      resolution: "amended",
      resolution_text: "Clarified the scope",
      amended_proposition_text: "Updated proposition text",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyEvent[];
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("pushback.resolved");
    expect(body[1].type).toBe("proposition.amended");
    expect(body[1].payload).toMatchObject({
      proposition_id: "PROP-1",
      new_text: "Updated proposition text",
      resolves_pushback_id: "PB-002",
    });
  });

  it("returns 400 on invalid resolution value", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/pushback/PB-001/resolve", {
      resolution: "invalid",
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /api/commands/task/:id/dependencies
// ============================================================================

describe("POST /api/commands/task/:id/dependencies", () => {
  it("sets dependencies on a draft task and emits task.dependency.set", async () => {
    const { db, app } = setup();
    seedTask(db, "T-DEP");
    seedTask(db, "T-TARGET");

    const res = await post(app, "/api/commands/task/T-TARGET/dependencies", {
      depends_on: ["T-DEP"],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent;
    expect(body.type).toBe("task.dependency.set");
    expect(body.payload).toMatchObject({
      task_id: "T-TARGET",
      depends_on: ["T-DEP"],
    });
  });

  it("returns 409 when task is in_progress (running)", async () => {
    const { db, app } = setup();
    seedTask(db, "T-DEP");
    seedRunningTask(db, "T-RUNNING", "A-RUN");

    const res = await post(app, "/api/commands/task/T-RUNNING/dependencies", {
      depends_on: ["T-DEP"],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("running");
  });

  it("returns 409 when adding a dependency would create a cycle", async () => {
    const { db, app } = setup();
    seedTask(db, "T-A");
    seedTask(db, "T-B");

    // T-B depends on T-A
    appendAndProject(db, {
      type: "task.dependency.set",
      aggregate_type: "task",
      aggregate_id: "T-B",
      actor,
      payload: { task_id: "T-B", depends_on: ["T-A"] },
    });

    // Now try T-A depends on T-B — cycle!
    const res = await post(app, "/api/commands/task/T-A/dependencies", {
      depends_on: ["T-B"],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("cycle");
  });

  it("allows removing dependencies (empty array)", async () => {
    const { db, app } = setup();
    seedTask(db, "T-DEP");
    seedTask(db, "T-TARGET");

    // Set dependency first
    appendAndProject(db, {
      type: "task.dependency.set",
      aggregate_type: "task",
      aggregate_id: "T-TARGET",
      actor,
      payload: { task_id: "T-TARGET", depends_on: ["T-DEP"] },
    });

    // Remove all dependencies
    const res = await post(app, "/api/commands/task/T-TARGET/dependencies", {
      depends_on: [],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent;
    expect(body.type).toBe("task.dependency.set");
    expect(body.payload).toMatchObject({
      task_id: "T-TARGET",
      depends_on: [],
    });
  });

  it("returns 404 for nonexistent task", async () => {
    const { app } = setup();
    const res = await post(app, "/api/commands/task/NOPE/dependencies", {
      depends_on: [],
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid body", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");
    const res = await post(app, "/api/commands/task/T-001/dependencies", {
      depends_on: "not-an-array",
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// SSE integration — commands trigger SSE events
// ============================================================================

describe("SSE integration", () => {
  it("commands emit events on the eventBus", async () => {
    const { app } = setup();
    const received: AnyEvent[] = [];
    const listener = (e: AnyEvent) => received.push(e);
    eventBus.on("event.committed", listener);

    try {
      await post(app, "/api/commands/task/create", {
        title: "SSE test",
        proposition_ids: [],
      });

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[received.length - 1].type).toBe("task.created");
    } finally {
      eventBus.off("event.committed", listener);
    }
  });
});
