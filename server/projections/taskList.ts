/**
 * TaskList projection — the cockpit sidebar.
 *
 * One row per live task. Archived tasks are deleted from this projection.
 * Delegates reduction to the shared reduceTaskList so the client can
 * fold events identically.
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceTaskList, type TaskListRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (phase_models stored as JSON text)
// ============================================================================

type RawTaskListRow = Omit<TaskListRow, "phase_models" | "auto_merged" | "depends_on" | "blocked" | "completed_phases"> & {
  phase_models_json: string | null;
  auto_merged: number;
  depends_on_json: string | null;
  blocked: number;
  completed_phases_json: string | null;
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract task_id from event payload. Most task/attempt events carry it
 * directly. Phase events carry attempt_id instead, and pushback events
 * carry proposition_id — both require a lookup to resolve the owning task.
 */
function extractTaskId(
  db: Database.Database,
  event: AnyEvent,
): string | null {
  const p = event.payload as unknown as Record<string, unknown>;

  // Direct task_id in payload
  if ("task_id" in p && typeof p.task_id === "string") return p.task_id;

  // Phase events carry attempt_id — look up the task via current_attempt_id
  if ("attempt_id" in p && typeof p.attempt_id === "string") {
    const row = db
      .prepare(
        "SELECT task_id FROM proj_task_list WHERE current_attempt_id = ?",
      )
      .get(p.attempt_id) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  // Pushback events: raised carries proposition_id, resolved carries pushback_id
  const propositionId = resolvePropositionId(db, p);
  if (propositionId) {
    const rows = db
      .prepare("SELECT task_id, proposition_ids_json FROM proj_task_detail")
      .all() as Array<{ task_id: string; proposition_ids_json: string }>;
    for (const row of rows) {
      const ids = JSON.parse(row.proposition_ids_json) as string[];
      if (ids.includes(propositionId)) return row.task_id;
    }
    return null;
  }

  return null;
}

/**
 * Resolve the proposition_id for pushback events.
 * pushback.raised carries it directly; pushback.resolved must look up the
 * original raised event in the event log.
 */
function resolvePropositionId(
  db: Database.Database,
  p: Record<string, unknown>,
): string | null {
  if ("proposition_id" in p && typeof p.proposition_id === "string") {
    return p.proposition_id;
  }
  if ("pushback_id" in p && typeof p.pushback_id === "string") {
    // Look up the pushback.raised event to get the proposition_id
    const row = db
      .prepare(
        "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'pushback.raised' LIMIT 1",
      )
      .get(p.pushback_id) as { payload_json: string } | undefined;
    if (row) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (typeof payload.proposition_id === "string") return payload.proposition_id;
    }
  }
  return null;
}

function rowFromRaw(raw: RawTaskListRow): TaskListRow {
  const { phase_models_json, auto_merged: autoMergedInt, depends_on_json, blocked: blockedInt, completed_phases_json, ...rest } = raw;
  return {
    ...rest,
    phase_models: phase_models_json ? JSON.parse(phase_models_json) : {},
    auto_merged: autoMergedInt === 1,
    depends_on: depends_on_json ? JSON.parse(depends_on_json) : [],
    blocked: blockedInt === 1,
    completed_phases: completed_phases_json ? JSON.parse(completed_phases_json) : [],
  };
}

// ============================================================================
// Projection definition
// ============================================================================

export const taskListProjection: Projection<TaskListRow> = {
  name: "task_list",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_task_list (
      task_id                TEXT PRIMARY KEY,
      prd_id                 TEXT,
      title                  TEXT NOT NULL,
      status                 TEXT NOT NULL,
      current_phase          TEXT,
      completed_phases_json  TEXT NOT NULL DEFAULT '[]',
      current_attempt_id     TEXT,
      attempt_count          INTEGER NOT NULL DEFAULT 0,
      pushback_count         INTEGER NOT NULL DEFAULT 0,
      phase_models_json      TEXT,
      auto_merged            INTEGER NOT NULL DEFAULT 0,
      depends_on_json        TEXT NOT NULL DEFAULT '[]',
      blocked                INTEGER NOT NULL DEFAULT 0,
      last_event_ts          TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_list_prd     ON proj_task_list(prd_id);
    CREATE INDEX IF NOT EXISTS idx_task_list_status  ON proj_task_list(status);
    CREATE INDEX IF NOT EXISTS idx_task_list_updated ON proj_task_list(updated_at DESC);
  `,

  read(db: Database.Database, event: AnyEvent): TaskListRow | null {
    const taskId = extractTaskId(db, event);
    if (!taskId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as RawTaskListRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reduceTaskList,

  write(db: Database.Database, next: TaskListRow | null, id: string): void {
    if (!next) {
      db.prepare("DELETE FROM proj_task_list WHERE task_id = ?").run(id);
      return;
    }

    db.prepare(
      `INSERT INTO proj_task_list
         (task_id, prd_id, title, status, current_phase, completed_phases_json,
          current_attempt_id, attempt_count, pushback_count, phase_models_json,
          auto_merged, depends_on_json, blocked, last_event_ts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         prd_id                = excluded.prd_id,
         title                 = excluded.title,
         status                = excluded.status,
         current_phase         = excluded.current_phase,
         completed_phases_json = excluded.completed_phases_json,
         current_attempt_id    = excluded.current_attempt_id,
         attempt_count         = excluded.attempt_count,
         pushback_count        = excluded.pushback_count,
         phase_models_json     = excluded.phase_models_json,
         auto_merged           = excluded.auto_merged,
         depends_on_json       = excluded.depends_on_json,
         blocked               = excluded.blocked,
         last_event_ts         = excluded.last_event_ts,
         updated_at            = excluded.updated_at`,
    ).run(
      next.task_id,
      next.prd_id ?? null,
      next.title,
      next.status,
      next.current_phase ?? null,
      JSON.stringify(next.completed_phases ?? []),
      next.current_attempt_id ?? null,
      next.attempt_count,
      next.pushback_count,
      JSON.stringify(next.phase_models),
      next.auto_merged ? 1 : 0,
      JSON.stringify(next.depends_on ?? []),
      next.blocked ? 1 : 0,
      next.last_event_ts,
      next.updated_at,
    );
  },
};

// Self-register on import
registerProjection(taskListProjection);
