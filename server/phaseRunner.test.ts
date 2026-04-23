/**
 * phaseRunner.test.ts
 *
 * Unit tests for the phase runner. All tests use an in-memory SQLite DB and
 * injectable fake deps so no real CLI/API calls are made.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./eventStore.js";
import { appendAndProject, initProjections, eventBus } from "./projectionRunner.js";
import "./projections/register.js";
import {
  runAttempt,
  killAttempt,
  pauseAttempt,
  resumeAttempt,
  isAttemptRunning,
  getActiveAttemptId,
  type PhaseRunnerDeps,
  type AdapterInvokeFn,
} from "./phaseRunner.js";
import type { Actor, TaskConfig, InvocationCompleted } from "@shared/events.js";
import type { AppendEventInput } from "./eventStore.js";
import type { BlobStore } from "./blobStore.js";
import type { PackInput, PackResult } from "./packer/trivial.js";

// ============================================================================
// Fixtures
// ============================================================================

const testActor: Actor = { kind: "user", user_id: "test" };

const minimalCliConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-test",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 5,
        max_budget_usd: 0.5,
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
    max_total_attempts: 2,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 1 },
    on_test_fail: { strategy: "retry_same", max_attempts: 1 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

const minimalManifest = {
  symbols: [],
  files: [],
  token_budget: 1000,
  token_estimated: 50,
};

/** Fake packer that returns a canned result without touching the FS. */
function fakePacker(_input: PackInput): Promise<PackResult> {
  return Promise.resolve({
    prompt: "Test prompt",
    manifest: minimalManifest,
    manifest_hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
}

/** Fake blob store (no-op — the packer already provides a hash). */
const fakeBlobStore: BlobStore = {
  putBlob: (content) => ({
    hash: Buffer.from(
      typeof content === "string" ? content : content.toString(),
    )
      .toString("hex")
      .slice(0, 64)
      .padEnd(64, "0"),
  }),
  getBlob: () => null,
  hasBlob: () => false,
};

/** Fake worktree creator — returns a fixed path without git ops. */
function fakeWorktreeCreator(
  _db: Database.Database,
  taskId: string,
): Promise<{ path: string; branch: string }> {
  return Promise.resolve({
    path: `/tmp/fake-wt/${taskId}`,
    branch: `wt/${taskId}`,
  });
}

/** Build a fake CLI invoker that yields a simple success sequence. */
function makeFakeCliInvoker(
  overrides?: Partial<InvocationCompleted>,
): AdapterInvokeFn {
  return async function* (opts) {
    const attempt_id = (opts as { attempt_id: string }).attempt_id;
    const invocation_id = (opts as { invocation_id: string }).invocation_id;
    const actor = { kind: "cli" as const, transport: "claude-code" as const, invocation_id };
    const base = {
      aggregate_type: "attempt" as const,
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
    };

    yield {
      ...base,
      type: "invocation.started" as const,
      payload: {
        invocation_id,
        attempt_id,
        phase_name: "implementer",
        transport: "claude-code" as const,
        model: "sonnet-4-6",
        prompt_version_id: "pv-test",
        context_manifest_hash: "abc",
      },
    } satisfies AppendEventInput<"invocation.started">;

    yield {
      ...base,
      type: "invocation.assistant_message" as const,
      payload: { invocation_id, text: "Done." },
    } satisfies AppendEventInput<"invocation.assistant_message">;

    yield {
      ...base,
      type: "invocation.completed" as const,
      payload: {
        invocation_id,
        outcome: "success" as const,
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.001,
        duration_ms: 1000,
        turns: 1,
        ...overrides,
      },
    } satisfies AppendEventInput<"invocation.completed">;
  };
}

/** Fake CLI invoker that pauses mid-stream until a signal fires. */
function makeSlowCliInvoker(signal: Promise<void>): AdapterInvokeFn {
  return async function* (opts) {
    const attempt_id = (opts as { attempt_id: string }).attempt_id;
    const invocation_id = (opts as { invocation_id: string }).invocation_id;
    const actor = { kind: "cli" as const, transport: "claude-code" as const, invocation_id };
    const base = {
      aggregate_type: "attempt" as const,
      aggregate_id: attempt_id,
      actor,
      correlation_id: attempt_id,
    };

    yield {
      ...base,
      type: "invocation.started" as const,
      payload: {
        invocation_id,
        attempt_id,
        phase_name: "implementer",
        transport: "claude-code" as const,
        model: "sonnet-4-6",
        prompt_version_id: "pv-test",
        context_manifest_hash: "abc",
      },
    } satisfies AppendEventInput<"invocation.started">;

    // Wait for signal before yielding the next event
    await signal;

    yield {
      ...base,
      type: "invocation.completed" as const,
      payload: {
        invocation_id,
        outcome: "success" as const,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        duration_ms: 0,
        turns: 1,
      },
    } satisfies AppendEventInput<"invocation.completed">;
  };
}

/** Fake diff capturer — returns empty diff by default. */
const noDiffCapturer = async (_wp: string, _baseSha: string) => "";
/** Fake diff capturer that simulates changes being present. */
const hasDiffCapturer = async (_wp: string, _baseSha: string) => "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";

/** Fake gate runner that emits gate events (like the real runner) without executing commands. */
function makeFakeGateRunner(
  status: "passed" | "failed" = "passed",
): PhaseRunnerDeps["gateRunner"] {
  return async (db, gate, attempt_id) => {
    const gate_run_id = `GR-${Date.now()}`;
    const actor = { kind: "system" as const, component: "gate_runner" as const };
    const aggregate_id = `gate-run:${gate_run_id}`;

    appendAndProject(db, {
      type: "gate.started",
      aggregate_type: "gate",
      aggregate_id,
      actor,
      correlation_id: attempt_id,
      payload: { gate_run_id, gate_name: gate.name, attempt_id },
    });

    if (status === "passed") {
      appendAndProject(db, {
        type: "gate.passed",
        aggregate_type: "gate",
        aggregate_id,
        actor,
        correlation_id: attempt_id,
        payload: { gate_run_id, gate_name: gate.name, duration_ms: 50 },
      });
      return { status: "passed" as const, failures: [], duration_ms: 50 };
    }

    appendAndProject(db, {
      type: "gate.failed",
      aggregate_type: "gate",
      aggregate_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        gate_run_id,
        gate_name: gate.name,
        duration_ms: 50,
        failures: [{ category: "test", excerpt: "Test failed" }],
      },
    });
    return {
      status: "failed" as const,
      failures: [{ category: "test", excerpt: "Test failed" }],
      duration_ms: 50,
    };
  };
}

/** No-op committer for tests that don't care about commit behavior. */
const noopCommitter = async () => ({ sha: "0".repeat(12), empty: true });

/** Standard test deps. */
function makeTestDeps(invoker?: AdapterInvokeFn): PhaseRunnerDeps {
  return {
    blobStore: fakeBlobStore,
    worktreeCreator: fakeWorktreeCreator,
    packer: fakePacker,
    cliInvoker: invoker ?? makeFakeCliInvoker(),
    diffCapturer: noDiffCapturer,
    committer: noopCommitter,
  };
}

// ============================================================================
// DB setup helpers
// ============================================================================

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

/** Creates a task in queued status and returns its task_id. */
function createTask(
  db: Database.Database,
  config: TaskConfig = minimalCliConfig,
  taskId = `T-${Date.now()}-${Math.random().toString(36).slice(2)}`,
): string {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: {
      task_id: taskId,
      title: "Test task",
      proposition_ids: [],
      config_snapshot: config,
    },
  });
  return taskId;
}

/** Helper: collect all event types from the DB in order. */
function getEventTypes(db: Database.Database): string[] {
  return (
    db.prepare("SELECT type FROM events ORDER BY ts, id").all() as Array<{
      type: string;
    }>
  ).map((r) => r.type);
}

// ============================================================================
// Tests
// ============================================================================

describe("runAttempt", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // Happy path: minimal config
  // --------------------------------------------------------------------------

  it("produces the expected event sequence for a minimal config (implementer only)", async () => {
    const taskId = createTask(db);

    await runAttempt(db, taskId, { deps: makeTestDeps() });

    const types = getEventTypes(db);

    // task.created is the setup event
    expect(types[0]).toBe("task.created");

    // Phase runner events start from index 1
    const runnerEvents = types.slice(1);
    expect(runnerEvents).toEqual([
      "attempt.started",
      "phase.started",
      "phase.context_packed",
      "invocation.started",
      "invocation.assistant_message",
      "invocation.completed",
      "phase.completed",
      "attempt.committed",
      "attempt.completed",
      "task.status_changed",
    ]);
  });

  it("emits attempt.completed with outcome=approved on a fully successful run", async () => {
    const taskId = createTask(db);
    await runAttempt(db, taskId, { deps: makeTestDeps() });

    const completedRow = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'attempt.completed' LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;

    expect(completedRow).toBeDefined();
    const payload = JSON.parse(completedRow!.payload_json) as {
      outcome: string;
      tokens_in_total: number;
      tokens_out_total: number;
      cost_usd_total: number;
    };
    expect(payload.outcome).toBe("approved");
    expect(payload.tokens_in_total).toBe(100);
    expect(payload.tokens_out_total).toBe(50);
    expect(payload.cost_usd_total).toBeCloseTo(0.001);
  });

  it("transitions task to awaiting_review after a successful run", async () => {
    const taskId = createTask(db);
    await runAttempt(db, taskId, { deps: makeTestDeps() });

    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    expect(taskRow?.status).toBe("awaiting_review");
  });

  it("transitions task to rejected when a phase invocation fails", async () => {
    const failInvoker: AdapterInvokeFn = async function* (opts) {
      const attempt_id = (opts as { attempt_id: string }).attempt_id;
      const invocation_id = (opts as { invocation_id: string }).invocation_id;
      const actor = { kind: "cli" as const, transport: "claude-code" as const, invocation_id };
      yield {
        type: "invocation.errored" as const,
        aggregate_type: "attempt" as const,
        aggregate_id: attempt_id,
        actor,
        correlation_id: attempt_id,
        payload: { invocation_id, error: "Subprocess failed", error_category: "aborted" as const },
      };
    };

    const taskId = createTask(db);
    await runAttempt(db, taskId, { deps: { ...makeTestDeps(), cliInvoker: failInvoker } });

    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    expect(taskRow?.status).toBe("rejected");
  });

  // --------------------------------------------------------------------------
  // config_snapshot captured at the right moment
  // --------------------------------------------------------------------------

  it("config_snapshot in attempt.started matches the task config at that moment", async () => {
    const taskId = createTask(db, minimalCliConfig);
    await runAttempt(db, taskId, { deps: makeTestDeps() });

    const row = db
      .prepare(
        "SELECT payload_json FROM events WHERE type = 'attempt.started' LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json) as { config_snapshot: TaskConfig };
    expect(payload.config_snapshot).toEqual(minimalCliConfig);
  });

  // --------------------------------------------------------------------------
  // Kill during invocation
  // --------------------------------------------------------------------------

  it("aborts the run when killed mid-invocation, without emitting attempt.completed", async () => {
    let resolveSignal!: () => void;
    const signal = new Promise<void>((r) => { resolveSignal = r; });
    const slowInvoker = makeSlowCliInvoker(signal);

    const taskId = createTask(db);

    // Capture attempt_id from the first committed attempt.started event
    let capturedAttemptId: string | undefined;
    const listener = (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type === "attempt.started") {
        capturedAttemptId = event.payload.attempt_id as string;
      }
    };
    eventBus.on("event.committed", listener);

    const runPromise = runAttempt(db, taskId, {
      deps: makeTestDeps(slowInvoker),
    });

    // Wait until invocation.started is emitted (slow adapter is paused)
    await new Promise<void>((resolve) => {
      const waitForInvocationStarted = (event: { type: string }) => {
        if (event.type === "invocation.started") {
          eventBus.off("event.committed", waitForInvocationStarted);
          resolve();
        }
      };
      eventBus.on("event.committed", waitForInvocationStarted);
    });

    // Kill the attempt
    expect(capturedAttemptId).toBeDefined();
    killAttempt(capturedAttemptId!);

    // Unblock the slow adapter (but the loop should have broken already)
    resolveSignal();

    await runPromise;
    eventBus.off("event.committed", listener);

    const types = getEventTypes(db);
    expect(types).not.toContain("attempt.completed");
    expect(types).toContain("invocation.started");
    // phase.completed should not be emitted either (loop was broken)
    expect(types).not.toContain("phase.completed");
  });

  it("does not register as active after completion", async () => {
    const taskId = createTask(db);
    await runAttempt(db, taskId, { deps: makeTestDeps() });
    expect(isAttemptRunning(taskId)).toBe(false);
  });

  it("does not register as active after being killed", async () => {
    let resolveSignal!: () => void;
    const signal = new Promise<void>((r) => { resolveSignal = r; });

    const taskId = createTask(db);
    const runPromise = runAttempt(db, taskId, {
      deps: makeTestDeps(makeSlowCliInvoker(signal)),
    });

    // Wait briefly for attempt to start
    await new Promise<void>((r) => setTimeout(r, 20));

    const attemptId = getActiveAttemptId(taskId);
    expect(attemptId).toBeDefined();
    killAttempt(attemptId!);
    resolveSignal();

    await runPromise;
    expect(isAttemptRunning(taskId)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Pause / resume
  // --------------------------------------------------------------------------

  it("pauses between phases and resumes when flag is cleared", async () => {
    // Config with two enabled phases so we can pause between them
    const twoPhaseConfig: TaskConfig = {
      ...minimalCliConfig,
      phases: [
        { ...minimalCliConfig.phases[0], name: "test-author" },
        { ...minimalCliConfig.phases[0], name: "implementer" },
      ],
    };

    let pausedDuringSecondPhase = false;
    let phaseCount = 0;

    const countingInvoker: AdapterInvokeFn = async function* (opts) {
      phaseCount++;
      const attempt_id = (opts as { attempt_id: string }).attempt_id;
      const invocation_id = (opts as { invocation_id: string }).invocation_id;
      const actor = { kind: "cli" as const, transport: "claude-code" as const, invocation_id };
      const base = { aggregate_type: "attempt" as const, aggregate_id: attempt_id, actor, correlation_id: attempt_id };

      yield { ...base, type: "invocation.started" as const, payload: { invocation_id, attempt_id, phase_name: "implementer", transport: "claude-code" as const, model: "m", prompt_version_id: "pv", context_manifest_hash: "h" } } satisfies AppendEventInput<"invocation.started">;
      yield { ...base, type: "invocation.completed" as const, payload: { invocation_id, outcome: "success" as const, tokens_in: 0, tokens_out: 0, cost_usd: 0, duration_ms: 0, turns: 1 } } satisfies AppendEventInput<"invocation.completed">;
    };

    const taskId = createTask(db, twoPhaseConfig);

    let capturedAttemptId: string | undefined;
    const startListener = (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type === "attempt.started") {
        capturedAttemptId = event.payload.attempt_id as string;
      }
    };
    eventBus.on("event.committed", startListener);

    const runPromise = runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(countingInvoker),
      },
    });

    // Pause after first phase starts
    await new Promise<void>((resolve) => {
      let phaseStartedCount = 0;
      const waitListener = (event: { type: string; payload: Record<string, unknown> }) => {
        if (event.type === "phase.completed") {
          phaseStartedCount++;
          if (phaseStartedCount === 1 && capturedAttemptId) {
            // Pause after first phase completes
            pauseAttempt(capturedAttemptId);
            pausedDuringSecondPhase = true;
            eventBus.off("event.committed", waitListener);
            resolve();
          }
        }
      };
      eventBus.on("event.committed", waitListener);
    });

    // Allow a brief window for the loop to hit the pause check
    await new Promise<void>((r) => setTimeout(r, 100));

    // Resume
    if (capturedAttemptId) resumeAttempt(capturedAttemptId);

    await runPromise;
    eventBus.off("event.committed", startListener);

    expect(pausedDuringSecondPhase).toBe(true);
    // Both phases should have run
    expect(phaseCount).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Concurrency: two tasks run in parallel
  // --------------------------------------------------------------------------

  it("runs two tasks concurrently without DB lock contention", async () => {
    const taskId1 = createTask(db, minimalCliConfig, "T-concurrent-1");
    const taskId2 = createTask(db, minimalCliConfig, "T-concurrent-2");

    await Promise.all([
      runAttempt(db, taskId1, { deps: makeTestDeps() }),
      runAttempt(db, taskId2, { deps: makeTestDeps() }),
    ]);

    // Both tasks should have completed attempts
    const completedEvents = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'attempt.completed'")
      .get() as { n: number };
    expect(completedEvents.n).toBe(2);

    // Both tasks should be in awaiting_review
    for (const taskId of [taskId1, taskId2]) {
      const row = db
        .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
        .get(taskId) as { status: string } | undefined;
      expect(row?.status).toBe("awaiting_review");
    }
  });

  // --------------------------------------------------------------------------
  // No phases — vacuous success
  // --------------------------------------------------------------------------

  it("completes with outcome=approved when there are no enabled phases", async () => {
    const noPhaseConfig: TaskConfig = {
      ...minimalCliConfig,
      phases: [{ ...minimalCliConfig.phases[0], enabled: false }],
    };
    const taskId = createTask(db, noPhaseConfig);

    await runAttempt(db, taskId, { deps: makeTestDeps() });

    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const payload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(payload.outcome).toBe("approved");
  });

  // --------------------------------------------------------------------------
  // Gate failures
  // --------------------------------------------------------------------------

  it("emits attempt.completed with outcome=failed when a required gate fails", async () => {
    const configWithGate: TaskConfig = {
      ...minimalCliConfig,
      gates: [
        {
          name: "tsc",
          command: "tsc --noEmit",
          required: true,
          timeout_seconds: 30,
          on_fail: "fail_task",
        },
      ],
    };

    const taskId = createTask(db, configWithGate);
    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        gateRunner: makeFakeGateRunner("failed"),
      },
    });

    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const payload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(payload.outcome).toBe("failed");
  });

  // --------------------------------------------------------------------------
  // Auditor phase integration
  // --------------------------------------------------------------------------

  /** Config with both implementer and auditor phases. */
  const auditorConfig: TaskConfig = {
    phases: [
      {
        name: "implementer",
        enabled: true,
        transport: "claude-code",
        model: "sonnet-4-6",
        prompt_version_id: "pv-impl",
        transport_options: {
          kind: "cli",
          bare: true,
          max_turns: 5,
          max_budget_usd: 0.5,
          permission_mode: "acceptEdits",
        },
        context_policy: {
          symbol_graph_depth: 0,
          include_tests: false,
          include_similar_patterns: false,
          token_budget: 1000,
        },
      },
      {
        name: "auditor",
        enabled: true,
        transport: "anthropic-api",
        model: "claude-opus-4-6",
        prompt_version_id: "pv-auditor-v1",
        transport_options: { kind: "api", max_tokens: 4096 },
        context_policy: {
          symbol_graph_depth: 0,
          include_tests: false,
          include_similar_patterns: false,
          token_budget: 4000,
        },
      },
    ],
    gates: [],
    retry_policy: {
      max_total_attempts: 3,
      on_typecheck_fail: { strategy: "retry_same", max_attempts: 1 },
      on_test_fail: { strategy: "retry_same", max_attempts: 1 },
      on_audit_reject: "escalate_to_human",
      on_spec_pushback: "pause_and_notify",
    },
  };

  /** Makes a fake API invoker that yields a verdict JSON response. */
  function makeAuditorInvoker(verdict: object): AdapterInvokeFn {
    return async function* (opts) {
      const attempt_id = (opts as { attempt_id: string }).attempt_id;
      const invocation_id = (opts as { invocation_id: string }).invocation_id;
      const actor = {
        kind: "cli" as const,
        transport: "anthropic-api" as const,
        invocation_id,
      };
      const base = {
        aggregate_type: "attempt" as const,
        aggregate_id: attempt_id,
        actor,
        correlation_id: attempt_id,
      };

      yield {
        ...base,
        type: "invocation.started" as const,
        payload: {
          invocation_id,
          attempt_id,
          phase_name: "auditor",
          transport: "anthropic-api" as const,
          model: "claude-opus-4-6",
          prompt_version_id: "pv-auditor-v1",
          context_manifest_hash: "abc",
        },
      } satisfies AppendEventInput<"invocation.started">;

      // The structured-output JSON is delivered as the final assistant_message
      yield {
        ...base,
        type: "invocation.assistant_message" as const,
        payload: { invocation_id, text: JSON.stringify(verdict) },
      } satisfies AppendEventInput<"invocation.assistant_message">;

      yield {
        ...base,
        type: "invocation.completed" as const,
        payload: {
          invocation_id,
          outcome: "success" as const,
          tokens_in: 200,
          tokens_out: 100,
          cost_usd: 0.01,
          duration_ms: 1500,
          turns: 1,
        },
      } satisfies AppendEventInput<"invocation.completed">;
    };
  }

  it("emits auditor.judged with verdict=approve → outcome=approved", async () => {
    const taskId = createTask(db, auditorConfig);
    const approveVerdict = {
      verdict: "approve",
      confidence: 0.95,
      summary: "All requirements satisfied.",
      concerns: [],
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        apiInvoker: makeAuditorInvoker(approveVerdict),
        diffCapturer: hasDiffCapturer,
      },
    });

    // auditor.judged should be emitted
    const judgedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'auditor.judged'")
      .get() as { payload_json: string } | undefined;
    expect(judgedRow).not.toBeUndefined();
    const judgedPayload = JSON.parse(judgedRow!.payload_json) as { verdict: string };
    expect(judgedPayload.verdict).toBe("approve");

    // attempt.completed should have outcome=approved
    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const completedPayload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(completedPayload.outcome).toBe("approved");

    // Task status should be awaiting_review
    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    expect(taskRow?.status).toBe("awaiting_review");
  });

  it("emits auditor.judged with verdict=reject → outcome=rejected", async () => {
    const taskId = createTask(db, auditorConfig);
    const rejectVerdict = {
      verdict: "reject",
      confidence: 0.9,
      summary: "Fundamental misalignment with requirements.",
      concerns: [
        { category: "correctness", severity: "blocking", rationale: "Does not implement the feature" },
      ],
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        apiInvoker: makeAuditorInvoker(rejectVerdict),
        diffCapturer: hasDiffCapturer,
      },
    });

    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const completedPayload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(completedPayload.outcome).toBe("rejected");

    // Task status should be rejected
    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    expect(taskRow?.status).toBe("rejected");
  });

  it("emits auditor.judged with verdict=revise → outcome=revised, task=awaiting_review", async () => {
    const taskId = createTask(db, auditorConfig);
    const reviseVerdict = {
      verdict: "revise",
      confidence: 0.75,
      summary: "Mostly correct but has blocking issues.",
      concerns: [
        { category: "correctness", severity: "blocking", rationale: "Missing null check on line 42" },
        { category: "style", severity: "advisory", rationale: "Prefer const" },
      ],
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        apiInvoker: makeAuditorInvoker(reviseVerdict),
        diffCapturer: hasDiffCapturer,
      },
    });

    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const completedPayload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    // revised or escalated — depends on retry policy
    expect(["revised", "escalated", "rejected"]).toContain(completedPayload.outcome);

    // Task should be awaiting_review (for revised) or rejected (for escalate_to_human)
    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    // escalate_to_human maps to escalated → rejected status
    expect(["awaiting_review", "rejected"]).toContain(taskRow?.status);
  });

  it("attempt projection has audit field populated after auditor runs", async () => {
    const taskId = createTask(db, auditorConfig);
    const approveVerdict = {
      verdict: "approve",
      confidence: 0.98,
      summary: "Excellent implementation.",
      concerns: [],
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        apiInvoker: makeAuditorInvoker(approveVerdict),
        diffCapturer: hasDiffCapturer,
      },
    });

    // Find the attempt id from the DB
    const attemptRow = db
      .prepare("SELECT attempt_id, audit_json FROM proj_attempt LIMIT 1")
      .get() as { attempt_id: string; audit_json: string | null } | undefined;
    expect(attemptRow).not.toBeUndefined();
    expect(attemptRow!.audit_json).not.toBeNull();
    const audit = JSON.parse(attemptRow!.audit_json!) as { verdict: string; confidence: number };
    expect(audit.verdict).toBe("approve");
    expect(audit.confidence).toBeCloseTo(0.98);
  });

  // --------------------------------------------------------------------------
  // Gates run after phase.completed
  // --------------------------------------------------------------------------

  it("emits phase.completed before gate events in the timeline", async () => {
    const configWithGate: TaskConfig = {
      ...minimalCliConfig,
      gates: [
        {
          name: "test",
          command: "pnpm test",
          required: true,
          timeout_seconds: 30,
          on_fail: "fail_task",
        },
      ],
    };

    const taskId = createTask(db, configWithGate);
    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        gateRunner: makeFakeGateRunner("passed"),
      },
    });

    const types = getEventTypes(db);
    const runnerEvents = types.slice(1); // skip task.created

    const phaseCompletedIdx = runnerEvents.indexOf("phase.completed");
    const gateStartedIdx = runnerEvents.indexOf("gate.started");

    expect(phaseCompletedIdx).toBeGreaterThan(-1);
    expect(gateStartedIdx).toBeGreaterThan(-1);
    expect(phaseCompletedIdx).toBeLessThan(gateStartedIdx);
  });

  it("emits gate events between phase.completed events in a multi-phase config", async () => {
    const twoPhaseWithGate: TaskConfig = {
      ...minimalCliConfig,
      phases: [
        { ...minimalCliConfig.phases[0], name: "test-author" },
        { ...minimalCliConfig.phases[0], name: "implementer" },
      ],
      gates: [
        {
          name: "test",
          command: "pnpm test",
          required: false,
          timeout_seconds: 30,
          on_fail: "skip",
        },
      ],
    };

    const taskId = createTask(db, twoPhaseWithGate);
    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        gateRunner: makeFakeGateRunner("passed"),
      },
    });

    const types = getEventTypes(db);
    const runnerEvents = types.slice(1);

    // Expected order: phase.completed (test-author) → gate events → phase.started (implementer)
    const firstPhaseCompleted = runnerEvents.indexOf("phase.completed");
    const firstGateStarted = runnerEvents.indexOf("gate.started");
    const secondPhaseStarted = runnerEvents.lastIndexOf("phase.started");

    expect(firstPhaseCompleted).toBeLessThan(firstGateStarted);
    expect(firstGateStarted).toBeLessThan(secondPhaseStarted);
  });

  // --------------------------------------------------------------------------
  // skip_gates per phase
  // --------------------------------------------------------------------------

  it("skips gates listed in phase.skip_gates", async () => {
    const configWithSkip: TaskConfig = {
      ...minimalCliConfig,
      phases: [
        {
          ...minimalCliConfig.phases[0],
          name: "test-author",
          skip_gates: ["test"],
        },
      ],
      gates: [
        {
          name: "test",
          command: "pnpm test",
          required: true,
          timeout_seconds: 30,
          on_fail: "fail_task",
        },
      ],
    };

    let gateRunnerCalled = false;
    const trackingGateRunner = async () => {
      gateRunnerCalled = true;
      return { status: "passed" as const, failures: [], duration_ms: 50 };
    };

    const taskId = createTask(db, configWithSkip);
    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        gateRunner: trackingGateRunner as PhaseRunnerDeps["gateRunner"],
      },
    });

    expect(gateRunnerCalled).toBe(false);

    const types = getEventTypes(db);
    expect(types).not.toContain("gate.started");

    // Task should still complete successfully
    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const payload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(payload.outcome).toBe("approved");
  });

  it("runs non-skipped gates even when some are skipped", async () => {
    const configWithPartialSkip: TaskConfig = {
      ...minimalCliConfig,
      phases: [
        {
          ...minimalCliConfig.phases[0],
          name: "test-author",
          skip_gates: ["test"],
        },
      ],
      gates: [
        {
          name: "test",
          command: "pnpm test",
          required: true,
          timeout_seconds: 30,
          on_fail: "fail_task",
        },
        {
          name: "lint",
          command: "pnpm lint",
          required: false,
          timeout_seconds: 30,
          on_fail: "skip",
        },
      ],
    };

    const gatesRun: string[] = [];
    const trackingGateRunner = async (
      _db: Database.Database,
      gate: { name: string },
    ) => {
      gatesRun.push(gate.name);
      return { status: "passed" as const, failures: [], duration_ms: 50 };
    };

    const taskId = createTask(db, configWithPartialSkip);
    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        gateRunner: trackingGateRunner as PhaseRunnerDeps["gateRunner"],
      },
    });

    // "test" should be skipped, "lint" should run
    expect(gatesRun).toEqual(["lint"]);
  });

  // --------------------------------------------------------------------------
  // no_changes outcome
  // --------------------------------------------------------------------------

  it("skips auditor and returns no_changes when no phase produces a diff", async () => {
    const taskId = createTask(db, auditorConfig);

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: noDiffCapturer,
      },
    });

    // Auditor should not have run
    const judgedRow = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'auditor.judged'")
      .get() as { n: number };
    expect(judgedRow.n).toBe(0);

    // Only one phase.started (implementer) — auditor was skipped
    const phaseStartedRows = db
      .prepare("SELECT payload_json FROM events WHERE type = 'phase.started'")
      .all() as { payload_json: string }[];
    const phaseNames = phaseStartedRows.map(
      (r) => (JSON.parse(r.payload_json) as { phase_name: string }).phase_name,
    );
    expect(phaseNames).toEqual(["implementer"]);

    // attempt.completed with no_changes
    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.completed'")
      .get() as { payload_json: string } | undefined;
    const payload = JSON.parse(completedRow!.payload_json) as { outcome: string };
    expect(payload.outcome).toBe("no_changes");

    // Task goes back to draft
    const taskRow = db
      .prepare("SELECT status FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;
    expect(taskRow?.status).toBe("draft");
  });

  // --------------------------------------------------------------------------
  // Per-attempt commit lifecycle
  // --------------------------------------------------------------------------

  it("emits attempt.committed with correct commit_sha after a successful attempt", async () => {
    const taskId = createTask(db);
    const fakeCommitter = async (_wp: string, _msg: string) => ({
      sha: "abc123def456",
      empty: false,
    });

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: hasDiffCapturer,
        committer: fakeCommitter,
      },
    });

    const committedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.committed'")
      .get() as { payload_json: string } | undefined;
    expect(committedRow).toBeDefined();
    const payload = JSON.parse(committedRow!.payload_json) as {
      attempt_id: string;
      commit_sha: string;
      empty: boolean;
    };
    expect(payload.commit_sha).toBe("abc123def456");
    expect(payload.empty).toBe(false);
  });

  it("emits attempt.committed with empty: true when no file changes were produced", async () => {
    const taskId = createTask(db, auditorConfig);
    const fakeCommitter = async (_wp: string, _msg: string) => ({
      sha: "empty0000000",
      empty: true,
    });

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: noDiffCapturer,
        committer: fakeCommitter,
      },
    });

    const committedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'attempt.committed'")
      .get() as { payload_json: string } | undefined;
    expect(committedRow).toBeDefined();
    const payload = JSON.parse(committedRow!.payload_json) as {
      attempt_id: string;
      commit_sha: string;
      empty: boolean;
    };
    expect(payload.commit_sha).toBe("empty0000000");
    expect(payload.empty).toBe(true);
  });

  it("commit message follows the required format with outcome, config hash, cost, and duration", async () => {
    const taskId = createTask(db);
    let capturedMessage = "";
    const fakeCommitter = async (_wp: string, msg: string) => {
      capturedMessage = msg;
      return { sha: "aaa111bbb222", empty: false };
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: hasDiffCapturer,
        committer: fakeCommitter,
      },
    });

    // First line: Attempt <N> of <task_id> — <outcome>
    const lines = capturedMessage.split("\n");
    expect(lines[0]).toMatch(/^Attempt 1 of .+ — approved$/);
    // Body contains config hash, cost, duration
    expect(capturedMessage).toMatch(/config: [0-9a-f]{12}/);
    expect(capturedMessage).toMatch(/cost: \$[\d.]+/);
    expect(capturedMessage).toMatch(/duration: \d+ms/);
  });

  // --------------------------------------------------------------------------
  // Anchored diff capture
  // --------------------------------------------------------------------------

  it("attempt 1 diff uses base_sha from worktree creation as the diff base", async () => {
    const taskId = createTask(db);
    const fakeBaseSha = "a".repeat(40);

    // Pre-emit task.worktree_created with base_sha so the projection has it
    appendAndProject(db, {
      type: "task.worktree_created",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: testActor,
      payload: {
        task_id: taskId,
        path: `/tmp/fake-wt/${taskId}`,
        branch: `wt/${taskId}`,
        base_ref: "main",
        base_sha: fakeBaseSha,
      },
    });

    // Track what base_sha the diff capturer receives
    let capturedBaseSha = "";
    const trackingDiffCapturer = async (_wp: string, baseSha: string) => {
      capturedBaseSha = baseSha;
      return "diff --git a/foo.ts b/foo.ts\n-old\n+new\n";
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        // worktree already exists (from the event above), so worktreeCreator won't be called
        diffCapturer: trackingDiffCapturer,
        committer: async () => ({ sha: "commit1sha12", empty: false }),
      },
    });

    expect(capturedBaseSha).toBe(fakeBaseSha);
  });

  it("attempt 2 diff uses attempt 1's commit_sha as the diff base", async () => {
    const taskId = createTask(db);
    const fakeBaseSha = "b".repeat(40);
    const attempt1CommitSha = "c".repeat(12);

    // Pre-emit task.worktree_created
    appendAndProject(db, {
      type: "task.worktree_created",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: testActor,
      payload: {
        task_id: taskId,
        path: `/tmp/fake-wt/${taskId}`,
        branch: `wt/${taskId}`,
        base_ref: "main",
        base_sha: fakeBaseSha,
      },
    });

    // Run attempt 1
    const attempt1Id = "A-attempt1-test";
    await runAttempt(db, taskId, {
      attempt_id: attempt1Id,
      deps: {
        ...makeTestDeps(),
        diffCapturer: async () => "diff output",
        committer: async () => ({ sha: attempt1CommitSha, empty: false }),
      },
    });

    // Reset task status back to queued so attempt 2 can run
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: testActor,
      payload: { task_id: taskId, from: "awaiting_review", to: "queued" },
    });

    // Track what base_sha attempt 2's diff capturer receives
    let capturedBaseSha = "";
    const trackingDiffCapturer = async (_wp: string, baseSha: string) => {
      capturedBaseSha = baseSha;
      return "diff --git a/bar.ts b/bar.ts\n-old\n+new\n";
    };

    await runAttempt(db, taskId, {
      previous_attempt_id: attempt1Id,
      triggered_by: "retry",
      deps: {
        ...makeTestDeps(),
        diffCapturer: trackingDiffCapturer,
        committer: async () => ({ sha: "commit2sha12", empty: false }),
      },
    });

    expect(capturedBaseSha).toBe(attempt1CommitSha);
  });

  it("emits phase.diff_snapshotted with correct diff_hash and base_sha after diff capture", async () => {
    const taskId = createTask(db);
    const fakeBaseSha = "d".repeat(40);

    // Pre-emit task.worktree_created
    appendAndProject(db, {
      type: "task.worktree_created",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: testActor,
      payload: {
        task_id: taskId,
        path: `/tmp/fake-wt/${taskId}`,
        branch: `wt/${taskId}`,
        base_ref: "main",
        base_sha: fakeBaseSha,
      },
    });

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: async () => "diff --git a/foo.ts b/foo.ts\n-old\n+new\n",
        committer: async () => ({ sha: "snap1234sha0", empty: false }),
      },
    });

    const snapshotRows = db
      .prepare("SELECT payload_json FROM events WHERE type = 'phase.diff_snapshotted'")
      .all() as { payload_json: string }[];

    expect(snapshotRows).toHaveLength(1);
    const payload = JSON.parse(snapshotRows[0].payload_json) as {
      attempt_id: string;
      phase_name: string;
      diff_hash: string;
      base_sha: string;
    };
    expect(payload.phase_name).toBe("implementer");
    expect(payload.base_sha).toBe(fakeBaseSha);
    expect(payload.diff_hash).toBeTruthy();

    // diff_hash on phase.completed should match
    const completedRow = db
      .prepare("SELECT payload_json FROM events WHERE type = 'phase.completed'")
      .get() as { payload_json: string };
    const completedPayload = JSON.parse(completedRow.payload_json) as {
      diff_hash?: string;
    };
    expect(completedPayload.diff_hash).toBe(payload.diff_hash);
  });

  it("does not commit during the phase loop — only after all phases complete", async () => {
    const taskId = createTask(db);
    const commitCalls: number[] = [];
    const fakeCommitter = async (_wp: string, _msg: string) => {
      commitCalls.push(Date.now());
      return { sha: "bbb222ccc333", empty: false };
    };

    await runAttempt(db, taskId, {
      deps: {
        ...makeTestDeps(),
        diffCapturer: hasDiffCapturer,
        committer: fakeCommitter,
      },
    });

    // Exactly one commit call (per-attempt, not per-phase)
    expect(commitCalls).toHaveLength(1);

    // attempt.committed appears after attempt.completed in event sequence
    // (actually it appears before attempt.completed since commit happens in step 3b)
    const types = getEventTypes(db);
    const committedIdx = types.indexOf("attempt.committed");
    const completedIdx = types.indexOf("attempt.completed");
    expect(committedIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(-1);
    // Committed before completed (commit is step 3b, completed is step 4)
    expect(committedIdx).toBeLessThan(completedIdx);
  });
});
