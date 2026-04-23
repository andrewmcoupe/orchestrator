/**
 * TaskDetail projection — cockpit detail pane and config modal.
 *
 * One row per task. Unlike task_list, archived tasks are KEPT here
 * (status flips to "archived" instead of deleting the row).
 */

import type Database from "better-sqlite3";
import type { AnyEvent, TaskConfig } from "@shared/events.js";
import { reduceTaskDetail, type TaskDetailRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (JSON columns stored as TEXT)
// ============================================================================

type RawTaskDetailRow = {
  task_id: string;
  prd_id: string | null;
  title: string;
  status: string;
  config_json: string;
  preset_id: string | null;
  preset_override_keys_json: string;
  proposition_ids_json: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_sha: string | null;
  current_attempt_id: string | null;
  merge_commit_sha: string | null;
  merged_into_branch: string | null;
  last_event_id: string;
  updated_at: string;
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract task_id from event payload. Pushback events carry proposition_id
 * instead — resolve via proposition_ids_json in the existing detail rows.
 */
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

function extractTaskId(
  db: Database.Database,
  event: AnyEvent,
): string | null {
  const p = event.payload as unknown as Record<string, unknown>;

  if ("task_id" in p && typeof p.task_id === "string") return p.task_id;

  // Attempt events carry attempt_id — look up via current_attempt_id
  if ("attempt_id" in p && typeof p.attempt_id === "string") {
    const row = db
      .prepare(
        "SELECT task_id FROM proj_task_detail WHERE current_attempt_id = ?",
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

function rowFromRaw(raw: RawTaskDetailRow): TaskDetailRow {
  return {
    task_id: raw.task_id,
    prd_id: raw.prd_id ?? undefined,
    title: raw.title,
    status: raw.status as TaskDetailRow["status"],
    config: JSON.parse(raw.config_json) as TaskConfig,
    preset_id: raw.preset_id ?? undefined,
    preset_override_keys: JSON.parse(raw.preset_override_keys_json) as string[],
    proposition_ids: JSON.parse(raw.proposition_ids_json) as string[],
    worktree_path: raw.worktree_path ?? undefined,
    worktree_branch: raw.worktree_branch ?? undefined,
    base_sha: raw.base_sha ?? undefined,
    current_attempt_id: raw.current_attempt_id ?? undefined,
    merge_commit_sha: raw.merge_commit_sha ?? undefined,
    merged_into_branch: raw.merged_into_branch ?? undefined,
    last_event_id: raw.last_event_id,
    updated_at: raw.updated_at,
  };
}

// ============================================================================
// Projection definition
// ============================================================================

export const taskDetailProjection: Projection<TaskDetailRow> = {
  name: "task_detail",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_task_detail (
      task_id                    TEXT PRIMARY KEY,
      prd_id                     TEXT,
      title                      TEXT NOT NULL,
      status                     TEXT NOT NULL,
      config_json                TEXT NOT NULL,
      preset_id                  TEXT,
      preset_override_keys_json  TEXT NOT NULL DEFAULT '[]',
      proposition_ids_json       TEXT NOT NULL DEFAULT '[]',
      worktree_path              TEXT,
      worktree_branch            TEXT,
      base_sha                   TEXT,
      current_attempt_id         TEXT,
      merge_commit_sha           TEXT,
      merged_into_branch         TEXT,
      last_event_id              TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    );
  `,

  read(db: Database.Database, event: AnyEvent): TaskDetailRow | null {
    const taskId = extractTaskId(db, event);
    if (!taskId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_task_detail WHERE task_id = ?")
      .get(taskId) as RawTaskDetailRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reduceTaskDetail,

  write(db: Database.Database, next: TaskDetailRow | null, id: string): void {
    if (!next) {
      db.prepare("DELETE FROM proj_task_detail WHERE task_id = ?").run(id);
      return;
    }

    db.prepare(
      `INSERT INTO proj_task_detail
         (task_id, prd_id, title, status, config_json, preset_id,
          preset_override_keys_json, proposition_ids_json,
          worktree_path, worktree_branch, base_sha, current_attempt_id,
          merge_commit_sha, merged_into_branch,
          last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         prd_id                    = excluded.prd_id,
         title                     = excluded.title,
         status                    = excluded.status,
         config_json               = excluded.config_json,
         preset_id                 = excluded.preset_id,
         preset_override_keys_json = excluded.preset_override_keys_json,
         proposition_ids_json      = excluded.proposition_ids_json,
         worktree_path             = excluded.worktree_path,
         worktree_branch           = excluded.worktree_branch,
         base_sha                  = excluded.base_sha,
         current_attempt_id        = excluded.current_attempt_id,
         merge_commit_sha          = excluded.merge_commit_sha,
         merged_into_branch        = excluded.merged_into_branch,
         last_event_id             = excluded.last_event_id,
         updated_at                = excluded.updated_at`,
    ).run(
      next.task_id,
      next.prd_id ?? null,
      next.title,
      next.status,
      JSON.stringify(next.config),
      next.preset_id ?? null,
      JSON.stringify(next.preset_override_keys),
      JSON.stringify(next.proposition_ids),
      next.worktree_path ?? null,
      next.worktree_branch ?? null,
      next.base_sha ?? null,
      next.current_attempt_id ?? null,
      next.merge_commit_sha ?? null,
      next.merged_into_branch ?? null,
      next.last_event_id,
      next.updated_at,
    );
  },
};

// Self-register on import
registerProjection(taskDetailProjection);
