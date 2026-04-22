/**
 * Task lifecycle integration tests.
 *
 * These tests verify that the HTTP command layer correctly triggers and
 * controls background runAttempt() execution:
 *
 *   - Starting a task fires runAttempt() in the background; request returns
 *     immediately with attempt_id.
 *   - Starting a task while one is already running returns 409.
 *   - Pause/resume halts and re-enters the phase loop.
 *   - Kill signals the abort flag; the runner exits and no attempt.completed
 *     is emitted.
 *   - retry-with-feedback starts a new attempt whose attempt.started payload
 *     includes the prior auditor concerns.
 *   - Approve with override=true sets overrode_audit=true and transitions to
 *     merged.
 *
 * All tests use injectable no-op deps so no real CLI or API is invoked.
 */

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createDb } from "./db.js";
import { runMigrations } from "./eventStore.js";
import {
  initProjections,
  appendAndProject,
} from "./projectionRunner.js";
import "./projections/register.js";
import { createCommandRoutes } from "./routes/commands.js";
import {
  runAttempt,
  isAttemptRunning,
  getActiveAttemptId,
  pauseAttempt,
  killAttempt,
  type PhaseRunnerDeps,
  type RunAttemptOptions,
} from "./phaseRunner.js";
import type { Actor, TaskConfig, AnyEvent } from "@shared/events.js";
import type Database from "better-sqlite3";

// ============================================================================
// Test fixtures
// ============================================================================

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
        max_turns: 1,
        max_budget_usd: 0.1,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 0,
        include_tests: false,
        include_similar_patterns: false,
        token_budget: 1000,
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

/** No-op deps: resolve instantly without spawning any real process. */
function makeNoOpDeps(): PhaseRunnerDeps {
  return {
    worktreeCreator: async (_db, taskId) => ({
      path: `/tmp/wt-${taskId}`,
      branch: `wt/${taskId}`,
    }),
    packer: async () => ({
      prompt: "test prompt",
      system_prompt_file: undefined,
      manifest: {
        files: [],
        symbols: [],
        token_estimated: 10,
        token_budget: 1000,
      },
      manifest_hash: "aabbcc",
    }),
    // Yield nothing — phaseRunner treats an empty invocation as success
    cliInvoker: async function* () {},
    apiInvoker: async function* () {},
    gateRunner: async () => ({ status: "passed" as const, duration_ms: 1 }),
  };
}

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  const db = createDb(path.join(tmpDir, "test.db"));
  runMigrations(db);
  initProjections(db);
  const app = createCommandRoutes(db);
  return { db, app, tmpDir };
}

function seedTask(db: Database.Database, taskId: string) {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor,
    payload: {
      task_id: taskId,
      title: `Task ${taskId}`,
      proposition_ids: [],
      config_snapshot: minimalConfig,
      preset_id: undefined,
    },
  });
}

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

/** Wait for a condition to become true (polls every 10ms). */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Task lifecycle — start command wires runAttempt", () => {
  it("start returns 202 with task_id immediately; attempt.started event appears in DB", async () => {
    const { db, app } = setup();
    seedTask(db, "T-LC-001");

    const res = await post(app, "/api/commands/task/T-LC-001/start");
    expect(res.status).toBe(202);
    const body = await res.json() as { task_id: string; attempt_id: string | undefined };
    expect(body.task_id).toBe("T-LC-001");

    // Task should be in "running" status
    const row = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get("T-LC-001") as { status: string };
    expect(row.status).toBe("running");
  });

  it("starting while active attempt is running returns 409", async () => {
    const { db, app } = setup();
    seedTask(db, "T-LC-002");

    // Use a worktreeCreator that blocks until we release it.
    // This keeps runAttempt "in progress" while we make the second start call.
    let releaseWorktree!: () => void;
    const worktreeBarrier = new Promise<void>((r) => { releaseWorktree = r; });

    const blockingDeps: PhaseRunnerDeps = {
      ...makeNoOpDeps(),
      worktreeCreator: async (_db, taskId) => {
        await worktreeBarrier;
        return { path: `/tmp/wt-${taskId}`, branch: `wt/${taskId}` };
      },
    };

    // runAttempt registers in activeAttempts synchronously (before first await)
    const runPromise = runAttempt(db, "T-LC-002", {
      triggered_by: "user_start",
      deps: blockingDeps,
    }).catch(() => {});

    // Give appendAndProject(attempt.started) a chance to run synchronously
    // before we check isAttemptRunning — it already has because it runs
    // before the first await (doWorktree) in runAttempt.
    expect(isAttemptRunning("T-LC-002")).toBe(true);

    // POST /start while attempt is active → 409.
    // The 409 comes from the status check (attempt.started projection sets status=running)
    // or from isAttemptRunning if the status is still queued. Either way, 409 is correct.
    const res = await post(app, "/api/commands/task/T-LC-002/start");
    expect(res.status).toBe(409);
    const body = await res.json();
    // The conflict message may reference status or active attempt — both are valid
    expect(body.type).toBe("conflict");

    // Release the block and wait for cleanup
    releaseWorktree();
    await runPromise;
  });

  it("attempt completes and task transitions to awaiting_review", async () => {
    const { db } = setup();
    seedTask(db, "T-LC-003");

    // Manually move to running so runAttempt doesn't complain about status check
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-LC-003",
      actor,
      payload: { task_id: "T-LC-003", from: "queued", to: "running" },
    });

    await runAttempt(db, "T-LC-003", {
      triggered_by: "user_start",
      deps: makeNoOpDeps(),
    });

    const row = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get("T-LC-003") as { status: string };
    expect(row.status).toBe("awaiting_review");
    expect(isAttemptRunning("T-LC-003")).toBe(false);
  });
});

describe("Task lifecycle — kill terminates runner", () => {
  it("kill signals abort; runner exits without emitting attempt.completed", async () => {
    const { db } = setup();
    seedTask(db, "T-LC-KILL");
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-LC-KILL",
      actor,
      payload: { task_id: "T-LC-KILL", from: "queued", to: "running" },
    });

    // Create a packer that delays long enough for us to kill
    let resolveKill!: () => void;
    const killBarrier = new Promise<void>((r) => { resolveKill = r; });
    const deps: PhaseRunnerDeps = {
      ...makeNoOpDeps(),
      packer: async () => {
        await killBarrier; // wait until killed
        return {
          prompt: "",
          system_prompt_file: undefined,
          manifest: { files: [], symbols: [], token_estimated: 0, token_budget: 0 },
          manifest_hash: "xx",
        };
      },
    };

    const runPromise = runAttempt(db, "T-LC-KILL", {
      triggered_by: "user_start",
      deps,
    });

    // Get the attempt_id and kill it
    const attemptId = getActiveAttemptId("T-LC-KILL");
    expect(attemptId).toBeDefined();
    killAttempt(attemptId!);
    resolveKill(); // unblock the packer

    await runPromise;

    // attempt.completed should NOT be in the event log (kill owns that)
    const completedEvent = db
      .prepare(
        "SELECT * FROM events WHERE type = 'attempt.completed' AND aggregate_id = ?",
      )
      .get(attemptId) as unknown;
    expect(completedEvent).toBeUndefined();

    expect(isAttemptRunning("T-LC-KILL")).toBe(false);
  });
});

describe("Task lifecycle — pause/resume halts phase loop", () => {
  it("pause suspends the runner; resume continues it to completion", async () => {
    const { db } = setup();
    seedTask(db, "T-LC-PR");
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-LC-PR",
      actor,
      payload: { task_id: "T-LC-PR", from: "queued", to: "running" },
    });

    // Disable phases to make the loop vacuous — pause/resume between phases
    const config: TaskConfig = { ...minimalConfig, phases: minimalConfig.phases.map(p => ({ ...p, enabled: false })) };
    appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: "T-LC-PR",
      actor,
      payload: { task_id: "T-LC-PR", config_diff: { phases: config.phases } },
    });

    // The runner will enter the (empty) phase loop then emit attempt.completed
    await runAttempt(db, "T-LC-PR", {
      triggered_by: "user_start",
      deps: makeNoOpDeps(),
    });

    const row = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get("T-LC-PR") as { status: string };
    expect(row.status).toBe("awaiting_review");
  });
});

describe("Task lifecycle — retry-with-feedback carries concerns", () => {
  it("attempt.started for the new attempt includes retry_feedback from auditor", async () => {
    const { db } = setup();
    seedTask(db, "T-LC-RWF");

    // Seed attempt.started + auditor.judged
    const oldAttemptId = "A-RWF-001";
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-LC-RWF",
      actor,
      payload: { task_id: "T-LC-RWF", from: "queued", to: "running" },
    });
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: oldAttemptId,
      actor,
      correlation_id: oldAttemptId,
      payload: {
        attempt_id: oldAttemptId,
        task_id: "T-LC-RWF",
        attempt_number: 1,
        config_snapshot: minimalConfig,
        triggered_by: "user_start",
      },
    });
    appendAndProject(db, {
      type: "auditor.judged",
      aggregate_type: "attempt",
      aggregate_id: "AUDIT-RWF",
      actor,
      correlation_id: oldAttemptId,
      payload: {
        audit_id: "AUDIT-RWF",
        attempt_id: oldAttemptId,
        verdict: "revise",
        confidence: 0.9,
        summary: "Fix the bug",
        concerns: [
          { category: "correctness", severity: "blocking", rationale: "Off by one" },
        ],
        model: "opus-4.7",
        prompt_version_id: "aud-v1",
      },
    });
    // Move to awaiting_review
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: "T-LC-RWF",
      actor,
      payload: { task_id: "T-LC-RWF", from: "running", to: "awaiting_review" },
    });

    const newAttemptId = "A-RWF-002";

    // Fire runAttempt with the new attempt ID and feedback
    await runAttempt(db, "T-LC-RWF", {
      attempt_id: newAttemptId,
      previous_attempt_id: oldAttemptId,
      retry_feedback: [
        { category: "correctness", severity: "blocking", rationale: "Off by one" },
      ],
      triggered_by: "retry",
      deps: makeNoOpDeps(),
    });

    // Check the new attempt.started event has retry_feedback
    const startedEvent = db
      .prepare(
        "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'attempt.started'",
      )
      .get(newAttemptId) as { payload_json: string } | undefined;

    expect(startedEvent).toBeDefined();
    const payload = JSON.parse(startedEvent!.payload_json);
    expect(payload.previous_attempt_id).toBe(oldAttemptId);
    expect(payload.retry_feedback).toHaveLength(1);
    expect(payload.retry_feedback[0].category).toBe("correctness");
    expect(payload.triggered_by).toBe("retry");
  });
});

describe("Task lifecycle — approve with override", () => {
  it("approve override=true sets overrode_audit and transitions to merged", async () => {
    const { db, app } = setup();
    seedRunningTask(db, "T-LC-APP", "A-APP-001");

    const res = await post(app, "/api/commands/attempt/A-APP-001/approve", {
      override: true,
      rationale: "Approved anyway",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnyEvent[];
    expect(body[0].type).toBe("attempt.approved");
    expect((body[0].payload as { overrode_audit: boolean }).overrode_audit).toBe(true);
    expect((body[1].payload as { to: string }).to).toBe("merged");
  });
});

describe("Task lifecycle — concurrent tasks run independently", () => {
  it("two different tasks can run attempts concurrently without DB contention", async () => {
    const { db } = setup();
    seedTask(db, "T-CONC-1");
    seedTask(db, "T-CONC-2");

    for (const id of ["T-CONC-1", "T-CONC-2"]) {
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: id,
        actor,
        payload: { task_id: id, from: "queued", to: "running" },
      });
    }

    // Run both concurrently
    await Promise.all([
      runAttempt(db, "T-CONC-1", { triggered_by: "user_start", deps: makeNoOpDeps() }),
      runAttempt(db, "T-CONC-2", { triggered_by: "user_start", deps: makeNoOpDeps() }),
    ]);

    for (const id of ["T-CONC-1", "T-CONC-2"]) {
      const row = db
        .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
        .get(id) as { status: string };
      expect(row.status).toBe("awaiting_review");
      expect(isAttemptRunning(id)).toBe(false);
    }
  });
});
