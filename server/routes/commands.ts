/**
 * Command endpoints — POST routes that translate user intents into events.
 *
 * Each endpoint:
 *   1. Zod-validates the request body
 *   2. Performs pre-flight checks (existence, allowed-status transitions)
 *   3. Calls appendAndProject for each event
 *   4. Returns the resulting event(s)
 *
 * Actor defaults to { kind: "user", user_id: "local" }.
 *
 * Task lifecycle (start / pause / resume / kill / retry) is wired to the
 * phase runner so real background execution is triggered and in-flight state
 * (pause flag, kill flag) is updated atomically.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { appendAndProject } from "../projectionRunner.js";
import { DEFAULT_TASK_CONFIG } from "@shared/projections.js";
import {
  runAttempt,
  isAttemptRunning,
  getActiveAttemptId,
  pauseAttempt,
  resumeAttempt,
  killAttempt,
} from "../phaseRunner.js";
import { ingestPrd } from "../ingest.js";
import { getIngestConfig, INGEST_TRANSPORTS } from "../config.js";
import { mergeTask } from "../merge.js";
import type {
  Actor,
  TaskConfig,
  TaskStatus,
  RetryStrategy,
  MergeStrategy,
} from "@shared/events.js";
import { canAddDependency, topoSort } from "@shared/dependency.js";

const DEFAULT_ACTOR: Actor = { kind: "user", user_id: "local" };

// Track active ingest processes so they can be cancelled
const activeIngests = new Map<string, AbortController>();

// Default config re-exported from shared — single source of truth
const DEFAULT_CONFIG = DEFAULT_TASK_CONFIG;

// ============================================================================
// Request body schemas
// ============================================================================

const createTaskBody = z.object({
  title: z.string().min(1),
  proposition_ids: z.array(z.string()),
  preset_id: z.string().optional(),
});

const retryBody = z.object({
  strategy: z
    .enum([
      "retry_same",
      "retry_with_more_context",
      "reroute_to_stronger_model",
      "decompose_task",
      "escalate_to_human",
    ])
    .optional(),
});

const configBody = z.object({
  config_diff: z.record(z.unknown()),
  reason: z.string().optional(),
});

const approveBody = z.object({
  rationale: z.string().optional(),
  /** @deprecated use override_audit */
  override: z.boolean().optional(),
  override_audit: z.boolean().optional(),
});

const finalizeBody = z.object({
  reason: z.enum(["manual", "archived"]).optional(),
});

const rejectBody = z.object({
  rationale: z.string().optional(),
});

const ingestOverrideFields = {
  transport: z.enum(INGEST_TRANSPORTS).optional(),
  model: z.string().min(1).optional(),
};

const prdIngestBody = z.union([
  z.object({
    path: z.string().min(1),
    content: z.undefined(),
    ...ingestOverrideFields,
  }),
  z.object({
    content: z.string().min(1),
    path: z.undefined(),
    ...ingestOverrideFields,
  }),
]);

const setDependenciesBody = z.object({
  depends_on: z.array(z.string()),
});

const pushbackResolveBody = z.object({
  resolution: z.enum(["amended", "reply_inline", "deferred", "dismissed"]),
  resolution_text: z.string().optional(),
  amended_proposition_text: z.string().optional(),
});

const mergeTaskBody = z.object({
  into_branch: z.string().optional(),
  strategy: z.enum(["squash", "merge", "ff-only"]).optional(),
  force: z.boolean().optional(),
  /** Optional commit message override — used for squash merges from the UI. */
  commit_message: z.string().optional(),
});

// ============================================================================
// Valid status transitions
// ============================================================================

const VALID_TRANSITIONS: Record<string, TaskStatus[]> = {
  start: ["queued", "draft"],
  pause: ["running"],
  resume: ["paused"],
  kill: ["running", "paused"],
  retry: ["awaiting_review", "rejected"],
  archive: [
    "queued",
    "draft",
    "paused",
    "awaiting_review",
    "rejected",
    "merged",
  ],
};

// ============================================================================
// Helpers
// ============================================================================

type TaskListRow = {
  task_id: string;
  status: TaskStatus;
  current_attempt_id: string | null;
  attempt_count: number;
  blocked: number;
};

type TaskDetailRow = {
  task_id: string;
  status: TaskStatus;
  config_json: string;
  current_attempt_id: string | null;
};

function getTaskFromList(
  db: Database.Database,
  taskId: string,
): TaskListRow | null {
  return (
    (db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as TaskListRow | undefined) ?? null
  );
}

function _getTaskDetail(
  db: Database.Database,
  taskId: string,
): TaskDetailRow | null {
  return (
    (db
      .prepare("SELECT * FROM proj_task_detail WHERE task_id = ?")
      .get(taskId) as TaskDetailRow | undefined) ?? null
  );
}

function notFound(taskId: string) {
  return Response.json(
    {
      type: "not_found",
      status: 404,
      detail: `Task '${taskId}' not found`,
    },
    { status: 404 },
  );
}

function conflict(message: string) {
  return Response.json(
    { type: "conflict", status: 409, detail: message },
    { status: 409 },
  );
}

function badRequest(detail: string | z.ZodError) {
  if (detail instanceof z.ZodError) {
    return Response.json(
      {
        type: "validation_error",
        status: 400,
        detail: "Request body validation failed",
        errors: detail.errors,
      },
      { status: 400 },
    );
  }
  return Response.json(
    { type: "bad_request", status: 400, detail },
    { status: 400 },
  );
}

// ============================================================================
// Route factory
// ============================================================================

export function createCommandRoutes(db: Database.Database) {
  const app = new Hono();

  // --------------------------------------------------------------------------
  // POST /api/commands/task/create
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/create", async (c) => {
    const parsed = createTaskBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const { title, proposition_ids, preset_id } = parsed.data;

    // Reject duplicate titles (case-insensitive)
    const existing = db
      .prepare("SELECT task_id FROM proj_task_list WHERE LOWER(title) = LOWER(?)")
      .get(title) as { task_id: string } | undefined;
    if (existing) {
      return Response.json(
        {
          type: "conflict",
          status: 409,
          detail: `A task with this title already exists: ${existing.task_id}`,
        },
        { status: 409 },
      );
    }

    const task_id = `T-${ulid()}`;

    // Use preset config when a preset_id is provided; fall back to DEFAULT_CONFIG
    let config_snapshot: TaskConfig = DEFAULT_CONFIG;
    if (preset_id) {
      const presetRow = db
        .prepare("SELECT config_json FROM proj_preset WHERE preset_id = ?")
        .get(preset_id) as { config_json: string } | undefined;
      if (!presetRow) {
        return Response.json(
          {
            type: "not_found",
            status: 404,
            detail: `Preset '${preset_id}' not found`,
          },
          { status: 404 },
        );
      }
      config_snapshot = JSON.parse(presetRow.config_json) as TaskConfig;
    }

    const event = appendAndProject(db, {
      type: "task.created",
      aggregate_type: "task",
      aggregate_id: task_id,
      actor: DEFAULT_ACTOR,
      payload: {
        task_id,
        title,
        proposition_ids,
        config_snapshot,
        preset_id,
      },
    });

    return c.json(event);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/start
  //
  // Transitions the task to running, then fires runAttempt() in the background.
  // runAttempt() registers synchronously before its first await, so
  // getActiveAttemptId() is reliable immediately after the fire-and-forget call.
  // Returns 202 Accepted with { task_id, attempt_id }.
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/start", (c) => {
    const taskId = c.req.param("id");
    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.start.includes(task.status)) {
      return conflict(
        `Cannot start task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.start.join(", ")}`,
      );
    }

    // Blocked tasks cannot be started — dependencies must be merged first
    if (task.blocked) {
      return conflict(
        `Task '${taskId}' is blocked by unmet dependencies`,
      );
    }

    // Enforce one-attempt-per-task: reject if already running
    if (isAttemptRunning(taskId)) {
      return conflict(
        `Task '${taskId}' already has an active running attempt`,
      );
    }

    // Transition task to running
    appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: DEFAULT_ACTOR,
      payload: { task_id: taskId, from: task.status, to: "running" as const },
    });

    // Fire-and-forget: runAttempt registers in activeAttempts synchronously
    // (before its first await), so getActiveAttemptId() is available below.
    void runAttempt(db, taskId, { triggered_by: "user_start" }).catch(
      (err: unknown) => {
        console.error(`[phaseRunner] runAttempt failed for task ${taskId}:`, err);
      },
    );

    const attempt_id = getActiveAttemptId(taskId);
    return c.json({ task_id: taskId, attempt_id }, 202);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/pause
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/pause", (c) => {
    const taskId = c.req.param("id");
    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.pause.includes(task.status)) {
      return conflict(
        `Cannot pause task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.pause.join(", ")}`,
      );
    }

    const attempt_id = task.current_attempt_id;

    const events = [];

    if (attempt_id) {
      events.push(
        appendAndProject(db, {
          type: "attempt.paused",
          aggregate_type: "attempt",
          aggregate_id: attempt_id,
          actor: DEFAULT_ACTOR,
          correlation_id: attempt_id,
          payload: { attempt_id, reason: "User requested pause" },
        }),
      );
      pauseAttempt(attempt_id);
    }

    // Always transition the task — handles stuck tasks with no attempt
    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          from: task.status,
          to: "paused" as const,
        },
      }),
    );

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/resume
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/resume", (c) => {
    const taskId = c.req.param("id");
    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.resume.includes(task.status)) {
      return conflict(
        `Cannot resume task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.resume.join(", ")}`,
      );
    }

    const attempt_id = task.current_attempt_id;
    if (!attempt_id) return conflict("No paused attempt to resume");

    // Resume the spin-waiting phase runner
    resumeAttempt(attempt_id);

    const event = appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: DEFAULT_ACTOR,
      payload: {
        task_id: taskId,
        from: task.status,
        to: "running" as const,
      },
    });

    return c.json([event]);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/kill
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/kill", (c) => {
    const taskId = c.req.param("id");
    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.kill.includes(task.status)) {
      return conflict(
        `Cannot kill task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.kill.join(", ")}`,
      );
    }

    const attempt_id = task.current_attempt_id;

    const events = [];

    // If there's an active attempt, kill it and signal the phase runner
    if (attempt_id) {
      events.push(
        appendAndProject(db, {
          type: "attempt.killed",
          aggregate_type: "attempt",
          aggregate_id: attempt_id,
          actor: DEFAULT_ACTOR,
          correlation_id: attempt_id,
          payload: { attempt_id, reason: "User requested kill" },
        }),
      );
      killAttempt(attempt_id);
    }

    // Always transition the task out of running — handles stuck tasks
    // where runAttempt crashed before creating an attempt
    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          from: task.status,
          to: "rejected" as const,
        },
      }),
    );

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/retry
  //
  // Emits the retry_requested event on the old attempt and task.status_changed,
  // then fires runAttempt() in the background with the pre-assigned new ID.
  // Returns the command events plus { new_attempt_id }.
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/retry", async (c) => {
    const taskId = c.req.param("id");
    const parsed = retryBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);

    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.retry.includes(task.status)) {
      return conflict(
        `Cannot retry task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.retry.join(", ")}`,
      );
    }

    const previous_attempt_id = task.current_attempt_id ?? undefined;
    const new_attempt_id = `A-${ulid()}`;
    const strategy: RetryStrategy = parsed.data.strategy ?? "retry_same";

    const events = [];

    // Emit retry_requested on the old attempt
    if (previous_attempt_id) {
      events.push(
        appendAndProject(db, {
          type: "attempt.retry_requested",
          aggregate_type: "attempt",
          aggregate_id: previous_attempt_id,
          actor: DEFAULT_ACTOR,
          correlation_id: previous_attempt_id,
          payload: {
            attempt_id: previous_attempt_id,
            with_feedback: false,
            new_attempt_id,
            strategy,
          },
        }),
      );
    }

    // Transition task status → running
    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          from: task.status,
          to: "running" as const,
        },
      }),
    );

    // Fire the actual attempt in the background (runAttempt emits attempt.started)
    void runAttempt(db, taskId, {
      attempt_id: new_attempt_id,
      previous_attempt_id,
      triggered_by: "retry",
    }).catch((err: unknown) => {
      console.error(`[phaseRunner] retry runAttempt failed for task ${taskId}:`, err);
    });

    return c.json({ events, new_attempt_id });
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/config
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/config", async (c) => {
    const taskId = c.req.param("id");
    const parsed = configBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (task.status === "archived") {
      return conflict("Cannot update config of an archived task");
    }

    const event = appendAndProject(db, {
      type: "task.config_updated",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: DEFAULT_ACTOR,
      payload: {
        task_id: taskId,
        config_diff: parsed.data.config_diff as Partial<TaskConfig>,
        reason: parsed.data.reason,
      },
    });

    return c.json(event);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/archive
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/archive", (c) => {
    const taskId = c.req.param("id");
    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!VALID_TRANSITIONS.archive.includes(task.status)) {
      return conflict(
        `Cannot archive task in status '${task.status}'. Allowed: ${VALID_TRANSITIONS.archive.join(", ")}`,
      );
    }

    const events = [];

    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          from: task.status,
          to: "archived" as const,
        },
      }),
    );

    events.push(
      appendAndProject(db, {
        type: "task.archived",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: { task_id: taskId },
      }),
    );

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // DELETE /api/commands/task/:id
  //
  // Permanently removes an archived task from projections.
  // Only archived tasks can be deleted. Events are kept for audit history.
  // --------------------------------------------------------------------------
  app.delete("/api/commands/task/:id", (c) => {
    const taskId = c.req.param("id");

    const detail = db
      .prepare("SELECT status FROM proj_task_detail WHERE task_id = ?")
      .get(taskId) as { status: string } | undefined;

    if (!detail) {
      return c.json({ error: `Task ${taskId} not found` }, 404);
    }

    if (detail.status !== "archived") {
      return c.json(
        { error: `Cannot delete task in status '${detail.status}'. Only archived tasks can be deleted.` },
        409,
      );
    }

    db.prepare("DELETE FROM proj_task_detail WHERE task_id = ?").run(taskId);

    return c.json({ deleted: taskId });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/commands/archived_tasks
  //
  // Permanently removes all archived tasks from projections.
  // --------------------------------------------------------------------------
  app.delete("/api/commands/archived_tasks", (c) => {
    const result = db
      .prepare("DELETE FROM proj_task_detail WHERE status = 'archived'")
      .run();

    return c.json({ deleted: result.changes });
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/attempt/:id/approve
  //
  // Transitions awaiting_review → approved (merge is a separate step).
  // If override_audit=true and the attempt has a revise/reject verdict,
  // also emits audit.overridden so the override is recorded in the log.
  // --------------------------------------------------------------------------
  app.post("/api/commands/attempt/:id/approve", async (c) => {
    const attemptId = c.req.param("id");
    const parsed = approveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);

    // Find the owning task via current_attempt_id
    const taskRow = db
      .prepare(
        "SELECT task_id, status FROM proj_task_list WHERE current_attempt_id = ?",
      )
      .get(attemptId) as { task_id: string; status: TaskStatus } | undefined;

    if (!taskRow) {
      return Response.json(
        {
          type: "not_found",
          status: 404,
          detail: `Attempt '${attemptId}' not found`,
        },
        { status: 404 },
      );
    }

    // Already approved — idempotency guard
    if (taskRow.status === "approved") {
      return conflict(
        `Task is already in 'approved' status. Use unapprove to revert, or proceed to merge.`,
      );
    }

    const isOverride = parsed.data.override_audit ?? parsed.data.override ?? false;

    const events = [];

    events.push(
      appendAndProject(db, {
        type: "attempt.approved",
        aggregate_type: "attempt",
        aggregate_id: attemptId,
        actor: DEFAULT_ACTOR,
        correlation_id: attemptId,
        payload: {
          attempt_id: attemptId,
          rationale: parsed.data.rationale,
          overrode_audit: isOverride,
        },
      }),
    );

    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskRow.task_id,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskRow.task_id,
          from: taskRow.status,
          to: "approved" as const,
        },
      }),
    );

    // If overriding the audit, check whether there was actually a revise/reject verdict.
    // Only emit audit.overridden when there genuinely was one to override.
    if (isOverride) {
      const auditRow = db
        .prepare(
          "SELECT payload_json FROM events WHERE correlation_id = ? AND type = 'auditor.judged' ORDER BY ts DESC LIMIT 1",
        )
        .get(attemptId) as { payload_json: string } | undefined;

      if (auditRow) {
        const auditPayload = JSON.parse(auditRow.payload_json) as {
          verdict: string;
          audit_id: string;
        };
        if (
          auditPayload.verdict === "revise" ||
          auditPayload.verdict === "reject"
        ) {
          const auditOverrideId = `AO-${ulid()}`;
          events.push(
            appendAndProject(db, {
              type: "audit.overridden",
              aggregate_type: "audit",
              aggregate_id: auditOverrideId,
              actor: DEFAULT_ACTOR,
              correlation_id: attemptId,
              payload: {
                audit_id: auditOverrideId,
                rationale: parsed.data.rationale ?? "Override approved by user",
                effective_verdict: "approve" as const,
              },
            }),
          );
        }
      }
    }

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/attempt/:id/unapprove
  //
  // Reverts an approved-but-not-yet-merged task back to awaiting_review.
  // --------------------------------------------------------------------------
  app.post("/api/commands/attempt/:id/unapprove", (c) => {
    const attemptId = c.req.param("id");

    const taskRow = db
      .prepare(
        "SELECT task_id, status FROM proj_task_list WHERE current_attempt_id = ?",
      )
      .get(attemptId) as { task_id: string; status: TaskStatus } | undefined;

    if (!taskRow) {
      return Response.json(
        {
          type: "not_found",
          status: 404,
          detail: `Attempt '${attemptId}' not found`,
        },
        { status: 404 },
      );
    }

    if (taskRow.status !== "approved") {
      return conflict(
        `Cannot unapprove: task is in status '${taskRow.status}', not 'approved'.`,
      );
    }

    const event = appendAndProject(db, {
      type: "task.status_changed",
      aggregate_type: "task",
      aggregate_id: taskRow.task_id,
      actor: DEFAULT_ACTOR,
      payload: {
        task_id: taskRow.task_id,
        from: "approved" as const,
        to: "awaiting_review" as const,
      },
    });

    return c.json([event]);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/finalize
  //
  // Manual-merge path: marks a task as done without going through the
  // automated merge workflow. Emits task.finalized then task.status_changed.
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/finalize", async (c) => {
    const taskId = c.req.param("id");
    const parsed = finalizeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);

    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    const reason = parsed.data.reason ?? "manual";

    const events = [];

    events.push(
      appendAndProject(db, {
        type: "task.finalized",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          reason,
        },
      }),
    );

    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskId,
          from: task.status,
          to: "merged" as const,
        },
      }),
    );

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/attempt/:id/reject
  // --------------------------------------------------------------------------
  app.post("/api/commands/attempt/:id/reject", async (c) => {
    const attemptId = c.req.param("id");
    const parsed = rejectBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);

    const taskRow = db
      .prepare(
        "SELECT task_id, status FROM proj_task_list WHERE current_attempt_id = ?",
      )
      .get(attemptId) as { task_id: string; status: TaskStatus } | undefined;

    if (!taskRow) {
      return Response.json(
        {
          type: "not_found",
          status: 404,
          detail: `Attempt '${attemptId}' not found`,
        },
        { status: 404 },
      );
    }

    const events = [];

    events.push(
      appendAndProject(db, {
        type: "attempt.rejected",
        aggregate_type: "attempt",
        aggregate_id: attemptId,
        actor: DEFAULT_ACTOR,
        correlation_id: attemptId,
        payload: {
          attempt_id: attemptId,
          rationale: parsed.data.rationale,
        },
      }),
    );

    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskRow.task_id,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskRow.task_id,
          from: taskRow.status,
          to: "rejected" as const,
        },
      }),
    );

    return c.json(events);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/attempt/:id/retry-with-feedback
  //
  // Reads prior auditor concerns, emits retry_requested on the old attempt,
  // then fires runAttempt() in the background carrying those concerns into the
  // new attempt's retry_feedback field.
  // --------------------------------------------------------------------------
  app.post("/api/commands/attempt/:id/retry-with-feedback", (c) => {
    const attemptId = c.req.param("id");

    const taskRow = db
      .prepare(
        "SELECT task_id, status, attempt_count FROM proj_task_list WHERE current_attempt_id = ?",
      )
      .get(attemptId) as
      | { task_id: string; status: TaskStatus; attempt_count: number }
      | undefined;

    if (!taskRow) {
      return Response.json(
        {
          type: "not_found",
          status: 404,
          detail: `Attempt '${attemptId}' not found`,
        },
        { status: 404 },
      );
    }

    // Look up auditor concerns from the event log for this attempt
    const auditEvent = db
      .prepare(
        "SELECT payload_json FROM events WHERE correlation_id = ? AND type = 'auditor.judged' ORDER BY ts DESC LIMIT 1",
      )
      .get(attemptId) as { payload_json: string } | undefined;

    const concerns = auditEvent
      ? (JSON.parse(auditEvent.payload_json).concerns ?? [])
      : [];

    const new_attempt_id = `A-${ulid()}`;

    const events = [];

    // Emit retry_requested on old attempt
    events.push(
      appendAndProject(db, {
        type: "attempt.retry_requested",
        aggregate_type: "attempt",
        aggregate_id: attemptId,
        actor: DEFAULT_ACTOR,
        correlation_id: attemptId,
        payload: {
          attempt_id: attemptId,
          with_feedback: true,
          new_attempt_id,
          strategy: "retry_same" as const,
        },
      }),
    );

    // Status → revising
    events.push(
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskRow.task_id,
        actor: DEFAULT_ACTOR,
        payload: {
          task_id: taskRow.task_id,
          from: taskRow.status,
          to: "revising" as const,
        },
      }),
    );

    // Fire the actual attempt in the background with carried feedback
    void runAttempt(db, taskRow.task_id, {
      attempt_id: new_attempt_id,
      previous_attempt_id: attemptId,
      retry_feedback: concerns,
      triggered_by: "retry",
    }).catch((err: unknown) => {
      console.error(
        `[phaseRunner] retry-with-feedback runAttempt failed for task ${taskRow.task_id}:`,
        err,
      );
    });

    return c.json({ events, new_attempt_id });
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/prd/ingest
  // --------------------------------------------------------------------------
  app.post("/api/commands/prd/ingest", async (c) => {
    const parsed = prdIngestBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const ac = new AbortController();
    const ingestId = ulid();
    activeIngests.set(ingestId, ac);

    try {
      const defaults = getIngestConfig();
      const result = await ingestPrd(
        db,
        {
          ...parsed.data,
          transport: parsed.data.transport ?? defaults.transport,
          model: parsed.data.model ?? defaults.model,
        },
        undefined,
        ac.signal,
      );
      return c.json(result);
    } catch (err) {
      if (ac.signal.aborted) {
        return c.json({ error: "Ingest cancelled" }, 500);
      }
      const error = err as Error;
      return c.json({ error: error.message }, 500);
    } finally {
      activeIngests.delete(ingestId);
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/prd/ingest/cancel
  // --------------------------------------------------------------------------
  app.post("/api/commands/prd/ingest/cancel", (c) => {
    for (const [id, ac] of activeIngests) {
      ac.abort();
      activeIngests.delete(id);
    }
    return c.json({ cancelled: true });
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/merge
  //
  // Merges the approved task's worktree branch into the current HEAD branch
  // (or the explicitly supplied into_branch). Task must be in 'approved' status.
  //
  // Outcomes:
  //   merged      → emits task.status_changed → merged, returns merge result
  //   drifted     → returns drift info; no events emitted (caller may retry with force)
  //   conflicted  → returns conflict info; task remains in approved status
  //   gate_failed → returns gate failure info; task remains in approved status
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/merge", async (c) => {
    const taskId = c.req.param("id");
    const parsed = mergeTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);

    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (task.status !== "approved") {
      return conflict(
        `Task '${taskId}' must be in 'approved' status to merge (current: '${task.status}').`,
      );
    }

    const attempt_id = task.current_attempt_id;
    if (!attempt_id) {
      return conflict(`Task '${taskId}' has no current attempt to merge.`);
    }

    try {
      const result = await mergeTask(db, taskId, attempt_id, {
        into_branch: parsed.data.into_branch,
        strategy: parsed.data.strategy as MergeStrategy | undefined,
        force: parsed.data.force,
        commit_message: parsed.data.commit_message,
      });

      // On successful merge, transition task status to 'merged'.
      if (result.outcome === "merged") {
        appendAndProject(db, {
          type: "task.status_changed",
          aggregate_type: "task",
          aggregate_id: taskId,
          actor: DEFAULT_ACTOR,
          payload: {
            task_id: taskId,
            from: task.status,
            to: "merged" as const,
          },
        });
      }

      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ type: "merge_error", status: 500, detail: message }, 500);
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/task/:id/dependencies
  //
  // Sets the dependency list for a task. Only allowed on draft/queued/blocked
  // tasks (before execution begins). Validates no cycles would be created.
  // --------------------------------------------------------------------------
  app.post("/api/commands/task/:id/dependencies", async (c) => {
    const taskId = c.req.param("id");
    const parsed = setDependenciesBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const task = getTaskFromList(db, taskId);
    if (!task) return notFound(taskId);

    if (!canAddDependency(task.status as TaskStatus)) {
      return conflict(
        `Cannot modify dependencies on task in status '${task.status}'. Only draft, queued, or blocked tasks can have dependencies edited.`,
      );
    }

    const { depends_on } = parsed.data;

    // Cycle detection: build the full dependency graph from all tasks,
    // apply the proposed change, and check for cycles
    if (depends_on.length > 0) {
      const allRows = db
        .prepare("SELECT task_id, depends_on_json FROM proj_task_list")
        .all() as Array<{ task_id: string; depends_on_json: string }>;

      const tasks = allRows.map((r) => ({
        id: r.task_id,
        depends_on:
          r.task_id === taskId
            ? depends_on
            : (JSON.parse(r.depends_on_json) as string[]),
      }));

      const result = topoSort(tasks);
      if (result.stripped.length > 0) {
        return conflict(
          `Adding these dependencies would create a cycle. Edges that would cycle: ${result.stripped.map((e) => `${e.from} → ${e.to}`).join(", ")}`,
        );
      }
    }

    const event = appendAndProject(db, {
      type: "task.dependency.set",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: DEFAULT_ACTOR,
      payload: {
        task_id: taskId,
        depends_on,
      },
    });

    return c.json(event);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/pushback/:id/resolve
  // --------------------------------------------------------------------------
  app.post("/api/commands/pushback/:id/resolve", async (c) => {
    const pushbackId = c.req.param("id");
    const parsed = pushbackResolveBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const { resolution, resolution_text, amended_proposition_text } =
      parsed.data;

    const events = [];

    events.push(
      appendAndProject(db, {
        type: "pushback.resolved",
        aggregate_type: "pushback",
        aggregate_id: pushbackId,
        actor: DEFAULT_ACTOR,
        payload: {
          pushback_id: pushbackId,
          resolution,
          resolution_text,
          amended_proposition_text,
        },
      }),
    );

    // If amended, also emit proposition.amended
    if (resolution === "amended" && amended_proposition_text) {
      // Look up the original pushback to find the proposition_id
      const pushbackEvent = db
        .prepare(
          "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'pushback.raised' LIMIT 1",
        )
        .get(pushbackId) as { payload_json: string } | undefined;

      if (pushbackEvent) {
        const payload = JSON.parse(pushbackEvent.payload_json) as {
          proposition_id: string;
        };

        events.push(
          appendAndProject(db, {
            type: "proposition.amended",
            aggregate_type: "proposition",
            aggregate_id: payload.proposition_id,
            actor: DEFAULT_ACTOR,
            payload: {
              proposition_id: payload.proposition_id,
              new_text: amended_proposition_text,
              rationale: resolution_text ?? "Amended via pushback resolution",
              resolves_pushback_id: pushbackId,
            },
          }),
        );
      }
    }

    return c.json(events);
  });

  return app;
}
