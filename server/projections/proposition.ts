/**
 * Proposition projection — the ingest review screen's data source.
 *
 * One row per proposition extracted from a PRD. Tracks text, source span,
 * confidence, optional task assignment, and open pushback IDs.
 *
 * Deleted/merged/split propositions are removed from this projection but
 * remain in the event log for full audit history.
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceProposition, type PropositionRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (JSON columns stored as text)
// ============================================================================

type RawPropositionRow = Omit<
  PropositionRow,
  "source_span" | "active_pushback_ids"
> & {
  source_span_json: string;
  active_pushback_ids_json: string;
};

// ============================================================================
// Helpers
// ============================================================================

function rowFromRaw(raw: RawPropositionRow): PropositionRow {
  return {
    proposition_id: raw.proposition_id,
    prd_id: raw.prd_id,
    text: raw.text,
    source_span: JSON.parse(raw.source_span_json) as PropositionRow["source_span"],
    confidence: raw.confidence,
    task_id: raw.task_id,
    active_pushback_ids: JSON.parse(raw.active_pushback_ids_json) as string[],
    updated_at: raw.updated_at,
  };
}

/**
 * Resolve the proposition_id for a given event.
 *
 * Most proposition events carry proposition_id directly. pushback.resolved
 * carries only pushback_id, so we look up the original pushback.raised event.
 * Events not related to a single proposition (e.g. task.propositions_added)
 * return null — the runner will call write(null, task_id) which is a safe no-op.
 */
function extractPropositionId(
  db: Database.Database,
  event: AnyEvent,
): string | null {
  const p = event.payload as unknown as Record<string, unknown>;

  // Direct proposition_id in payload
  if ("proposition_id" in p && typeof p.proposition_id === "string") {
    return p.proposition_id;
  }

  // pushback.resolved: look up the original pushback.raised to find proposition_id
  if (
    event.type === "pushback.resolved" &&
    "pushback_id" in p &&
    typeof p.pushback_id === "string"
  ) {
    const raised = db
      .prepare(
        "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'pushback.raised' LIMIT 1",
      )
      .get(p.pushback_id) as { payload_json: string } | undefined;
    if (raised) {
      const raisedPayload = JSON.parse(raised.payload_json) as Record<
        string,
        unknown
      >;
      if (typeof raisedPayload.proposition_id === "string") {
        return raisedPayload.proposition_id;
      }
    }
    return null;
  }

  return null;
}

// ============================================================================
// Projection definition
// ============================================================================

export const propositionProjection: Projection<PropositionRow> = {
  name: "proposition",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_proposition (
      proposition_id           TEXT PRIMARY KEY,
      prd_id                   TEXT NOT NULL,
      text                     TEXT NOT NULL,
      source_span_json         TEXT NOT NULL,
      confidence               REAL NOT NULL,
      task_id                  TEXT,
      active_pushback_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at               TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proposition_prd  ON proj_proposition(prd_id);
    CREATE INDEX IF NOT EXISTS idx_proposition_task ON proj_proposition(task_id);
  `,

  read(db: Database.Database, event: AnyEvent): PropositionRow | null {
    const propositionId = extractPropositionId(db, event);
    if (!propositionId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_proposition WHERE proposition_id = ?")
      .get(propositionId) as RawPropositionRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reduceProposition,

  write(db: Database.Database, next: PropositionRow | null, id: string): void {
    if (!next) {
      // For proposition.deleted, id = aggregate_id = proposition_id → correct delete.
      // For other null cases (e.g. task.propositions_added with id = task_id),
      // no row has proposition_id = task_id, so this is safely a no-op.
      db.prepare(
        "DELETE FROM proj_proposition WHERE proposition_id = ?",
      ).run(id);
      return;
    }

    // Always key on next.proposition_id (not the passed `id`, which may be a
    // pushback_id or task_id for events that don't have aggregate_id = proposition_id).
    db.prepare(
      `INSERT INTO proj_proposition
         (proposition_id, prd_id, text, source_span_json, confidence,
          task_id, active_pushback_ids_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposition_id) DO UPDATE SET
         prd_id                   = excluded.prd_id,
         text                     = excluded.text,
         source_span_json         = excluded.source_span_json,
         confidence               = excluded.confidence,
         task_id                  = excluded.task_id,
         active_pushback_ids_json = excluded.active_pushback_ids_json,
         updated_at               = excluded.updated_at`,
    ).run(
      next.proposition_id,
      next.prd_id,
      next.text,
      JSON.stringify(next.source_span),
      next.confidence,
      next.task_id ?? null,
      JSON.stringify(next.active_pushback_ids),
      next.updated_at,
    );
  },
};

// Self-register on import
registerProjection(propositionProjection);
