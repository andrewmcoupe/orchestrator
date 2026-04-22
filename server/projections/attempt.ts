/**
 * Attempt projection — one row per attempt, powering the review screen,
 * attempt history view, and retry-with-feedback command.
 *
 * Subscribed events (see PROJECTION_SUBSCRIPTIONS in shared/projections.ts):
 *   attempt.* → lifecycle state and outcome
 *   phase.*   → phase summaries
 *   invocation.* → token/cost accumulation, file changes
 *   gate.*    → gate run tracking
 *   auditor.judged / audit.overridden → AuditSummary
 *
 * The attempt_id is resolved from each event via:
 *   - aggregate_type === "attempt" → aggregate_id
 *   - otherwise → correlation_id (set to attempt_id by phaseRunner, gate runner, adapters)
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceAttempt, type AttemptRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (JSON columns stored as TEXT)
// ============================================================================

type RawAttemptRow = {
  attempt_id: string;
  task_id: string;
  attempt_number: number;
  status: string;
  outcome: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  phases_json: string;
  gate_runs_json: string;
  audit_json: string | null;
  files_changed_json: string;
  config_snapshot_json: string;
  previous_attempt_id: string | null;
  last_event_id: string;
};

function rowFromRaw(raw: RawAttemptRow): AttemptRow {
  return {
    attempt_id: raw.attempt_id,
    task_id: raw.task_id,
    attempt_number: raw.attempt_number,
    status: raw.status as AttemptRow["status"],
    outcome: raw.outcome as AttemptRow["outcome"],
    started_at: raw.started_at,
    completed_at: raw.completed_at ?? undefined,
    duration_ms: raw.duration_ms ?? undefined,
    tokens_in_total: raw.tokens_in_total,
    tokens_out_total: raw.tokens_out_total,
    cost_usd_total: raw.cost_usd_total,
    phases: JSON.parse(raw.phases_json),
    gate_runs: JSON.parse(raw.gate_runs_json),
    audit: raw.audit_json ? JSON.parse(raw.audit_json) : undefined,
    files_changed: JSON.parse(raw.files_changed_json),
    config_snapshot: JSON.parse(raw.config_snapshot_json),
    previous_attempt_id: raw.previous_attempt_id ?? undefined,
    last_event_id: raw.last_event_id,
  };
}

// ============================================================================
// Attempt ID resolution
// ============================================================================

/**
 * Extracts the attempt_id to look up from an event.
 * - For attempt/phase events: aggregate_id IS the attempt_id.
 * - For invocation/gate/audit events: correlation_id == attempt_id (by convention).
 */
function extractAttemptId(event: AnyEvent): string | null {
  if (event.aggregate_type === "attempt") return event.aggregate_id;
  return event.correlation_id ?? null;
}

// ============================================================================
// Projection definition
// ============================================================================

export const attemptProjection: Projection<AttemptRow> = {
  name: "attempt",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_attempt (
      attempt_id           TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      attempt_number       INTEGER NOT NULL,
      status               TEXT NOT NULL,
      outcome              TEXT,
      started_at           TEXT NOT NULL,
      completed_at         TEXT,
      duration_ms          INTEGER,
      tokens_in_total      INTEGER NOT NULL DEFAULT 0,
      tokens_out_total     INTEGER NOT NULL DEFAULT 0,
      cost_usd_total       REAL NOT NULL DEFAULT 0,
      phases_json          TEXT NOT NULL DEFAULT '{}',
      gate_runs_json       TEXT NOT NULL DEFAULT '[]',
      audit_json           TEXT,
      files_changed_json   TEXT NOT NULL DEFAULT '[]',
      config_snapshot_json TEXT NOT NULL DEFAULT '{}',
      previous_attempt_id  TEXT,
      last_event_id        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempt_task
      ON proj_attempt(task_id, attempt_number DESC);
    CREATE INDEX IF NOT EXISTS idx_attempt_outcome
      ON proj_attempt(outcome) WHERE outcome IS NOT NULL;
  `,

  read(db: Database.Database, event: AnyEvent): AttemptRow | null {
    const attemptId = extractAttemptId(event);
    if (!attemptId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_attempt WHERE attempt_id = ?")
      .get(attemptId) as RawAttemptRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reduceAttempt,

  write(db: Database.Database, next: AttemptRow | null, _id: string): void {
    // Attempts are never deleted — even killed/rejected attempts are kept for history.
    if (!next) return;

    db.prepare(
      `INSERT INTO proj_attempt (
        attempt_id, task_id, attempt_number, status, outcome,
        started_at, completed_at, duration_ms,
        tokens_in_total, tokens_out_total, cost_usd_total,
        phases_json, gate_runs_json, audit_json,
        files_changed_json, config_snapshot_json,
        previous_attempt_id, last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        status               = excluded.status,
        outcome              = excluded.outcome,
        completed_at         = excluded.completed_at,
        duration_ms          = excluded.duration_ms,
        tokens_in_total      = excluded.tokens_in_total,
        tokens_out_total     = excluded.tokens_out_total,
        cost_usd_total       = excluded.cost_usd_total,
        phases_json          = excluded.phases_json,
        gate_runs_json       = excluded.gate_runs_json,
        audit_json           = excluded.audit_json,
        files_changed_json   = excluded.files_changed_json,
        last_event_id        = excluded.last_event_id`,
    ).run(
      next.attempt_id,
      next.task_id,
      next.attempt_number,
      next.status,
      next.outcome ?? null,
      next.started_at,
      next.completed_at ?? null,
      next.duration_ms ?? null,
      next.tokens_in_total,
      next.tokens_out_total,
      next.cost_usd_total,
      JSON.stringify(next.phases),
      JSON.stringify(next.gate_runs),
      next.audit ? JSON.stringify(next.audit) : null,
      JSON.stringify(next.files_changed),
      JSON.stringify(next.config_snapshot),
      next.previous_attempt_id ?? null,
      next.last_event_id,
    );
  },
};

// Self-register on import
registerProjection(attemptProjection);
