/**
 * A/B experiment projection — one row per experiment.
 *
 * Subscribed events:
 *   ab_experiment.created   → insert row
 *   ab_experiment.concluded → update status and final stats
 *   invocation.completed    → increment n and cost_usd for matched variant
 *   auditor.judged          → increment success_n for matched variant (approve only)
 *
 * Cross-event lookups:
 *   invocation.completed carries no prompt_version_id. We resolve the variant
 *   by looking up the corresponding invocation.started event in the events table,
 *   which does carry prompt_version_id. This lookup uses json_extract() which
 *   is natively supported by SQLite / better-sqlite3.
 *
 *   auditor.judged carries prompt_version_id directly, so no cross-event lookup
 *   is required.
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceAbExperiment, type AbExperimentRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";
import { computeSignificance } from "../ab/stats.js";

// Raw DB row — nullable columns stored as null in SQLite, split_a is persisted
type RawAbExperimentRow = Omit<AbExperimentRow, "significance_p" | "winner" | "_variant"> & {
  significance_p: number | null;
  winner: string | null;
};

function rowFromRaw(raw: RawAbExperimentRow): AbExperimentRow {
  const { significance_p, winner, ...rest } = raw;
  return {
    ...rest,
    significance_p: significance_p ?? undefined,
    winner: (winner as AbExperimentRow["winner"]) ?? undefined,
  };
}

export const abExperimentProjection: Projection<AbExperimentRow> = {
  name: "ab_experiment",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_ab_experiment (
      experiment_id  TEXT PRIMARY KEY,
      phase_class    TEXT NOT NULL,
      variant_a_id   TEXT NOT NULL,
      variant_b_id   TEXT NOT NULL,
      bucket_key     TEXT NOT NULL,
      split_a        INTEGER NOT NULL DEFAULT 50,
      a_n            INTEGER NOT NULL DEFAULT 0,
      a_success_n    INTEGER NOT NULL DEFAULT 0,
      a_cost_usd     REAL NOT NULL DEFAULT 0,
      b_n            INTEGER NOT NULL DEFAULT 0,
      b_success_n    INTEGER NOT NULL DEFAULT 0,
      b_cost_usd     REAL NOT NULL DEFAULT 0,
      a_success_rate REAL NOT NULL DEFAULT 0,
      b_success_rate REAL NOT NULL DEFAULT 0,
      significance_p REAL,
      status         TEXT NOT NULL DEFAULT 'running',
      winner         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ab_experiment_phase ON proj_ab_experiment(phase_class);
    CREATE INDEX IF NOT EXISTS idx_ab_experiment_status ON proj_ab_experiment(status);
    CREATE INDEX IF NOT EXISTS idx_ab_experiment_variant_a ON proj_ab_experiment(variant_a_id);
    CREATE INDEX IF NOT EXISTS idx_ab_experiment_variant_b ON proj_ab_experiment(variant_b_id);
  `,

  read(db: Database.Database, event: AnyEvent): AbExperimentRow | null {
    // For events with experiment_id in payload (created/concluded)
    if ("experiment_id" in event.payload) {
      const experimentId = (event.payload as unknown as Record<string, unknown>).experiment_id;
      if (typeof experimentId !== "string") return null;

      const raw = db
        .prepare("SELECT * FROM proj_ab_experiment WHERE experiment_id = ?")
        .get(experimentId) as RawAbExperimentRow | undefined;

      return raw ? rowFromRaw(raw) : null;
    }

    // For invocation.completed — resolve prompt_version_id via the paired invocation.started event
    if (event.type === "invocation.completed") {
      const invId = event.payload.invocation_id;

      const startedEvent = db
        .prepare(
          "SELECT payload_json FROM events WHERE type = 'invocation.started' AND json_extract(payload_json, '$.invocation_id') = ? LIMIT 1",
        )
        .get(invId) as { payload_json: string } | undefined;

      if (!startedEvent) return null;

      const startedPayload = JSON.parse(startedEvent.payload_json) as {
        prompt_version_id: string;
      };
      const pvId = startedPayload.prompt_version_id;

      const raw = db
        .prepare(
          "SELECT * FROM proj_ab_experiment WHERE status = 'running' AND (variant_a_id = ? OR variant_b_id = ?) LIMIT 1",
        )
        .get(pvId, pvId) as RawAbExperimentRow | undefined;

      if (!raw) return null;

      const row = rowFromRaw(raw);
      // Tag the row with which variant this invocation belongs to
      row._variant = row.variant_a_id === pvId ? "A" : "B";
      return row;
    }

    // For auditor.judged — prompt_version_id is in the payload directly
    if (event.type === "auditor.judged") {
      const pvId = event.payload.prompt_version_id;

      const raw = db
        .prepare(
          "SELECT * FROM proj_ab_experiment WHERE status = 'running' AND (variant_a_id = ? OR variant_b_id = ?) LIMIT 1",
        )
        .get(pvId, pvId) as RawAbExperimentRow | undefined;

      if (!raw) return null;

      const row = rowFromRaw(raw);
      // Tag the row with which variant this audit belongs to
      row._variant = row.variant_a_id === pvId ? "A" : "B";
      return row;
    }

    return null;
  },

  reduce(current: AbExperimentRow | null, event: AnyEvent): AbExperimentRow | null {
    const next = reduceAbExperiment(current, event);
    if (!next) return null;

    // Recompute significance after every stats-updating event
    if (event.type === "invocation.completed" || event.type === "auditor.judged") {
      next.significance_p = computeSignificance(
        next.a_success_n,
        next.a_n,
        next.b_success_n,
        next.b_n,
      );
    }

    return next;
  },

  write(db: Database.Database, next: AbExperimentRow | null, id: string): void {
    if (!next) {
      db.prepare("DELETE FROM proj_ab_experiment WHERE experiment_id = ?").run(id);
      return;
    }

    db.prepare(`
      INSERT INTO proj_ab_experiment (
        experiment_id, phase_class, variant_a_id, variant_b_id, bucket_key,
        split_a,
        a_n, a_success_n, a_cost_usd, b_n, b_success_n, b_cost_usd,
        a_success_rate, b_success_rate, significance_p, status, winner
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET
        split_a        = excluded.split_a,
        a_n            = excluded.a_n,
        a_success_n    = excluded.a_success_n,
        a_cost_usd     = excluded.a_cost_usd,
        b_n            = excluded.b_n,
        b_success_n    = excluded.b_success_n,
        b_cost_usd     = excluded.b_cost_usd,
        a_success_rate = excluded.a_success_rate,
        b_success_rate = excluded.b_success_rate,
        significance_p = excluded.significance_p,
        status         = excluded.status,
        winner         = excluded.winner
    `).run(
      next.experiment_id,
      next.phase_class,
      next.variant_a_id,
      next.variant_b_id,
      next.bucket_key,
      next.split_a,
      next.a_n,
      next.a_success_n,
      next.a_cost_usd,
      next.b_n,
      next.b_success_n,
      next.b_cost_usd,
      next.a_success_rate,
      next.b_success_rate,
      next.significance_p ?? null,
      next.status,
      next.winner ?? null,
    );
  },
};

// Self-register on import
registerProjection(abExperimentProjection);
