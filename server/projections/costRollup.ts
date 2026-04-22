/**
 * Cost rollup projection — one row per (date, provider_id, model, phase_class).
 *
 * Subscribed events:
 *   invocation.completed → aggregate daily cost/token totals
 *
 * The composite primary key means this projection diverges from the normal
 * single-row-per-aggregate pattern. read() bootstraps a seed row when the
 * combination doesn't exist yet so that reduce() always receives a non-null
 * current (it just increments).
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceCostRollup, type CostRollupRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

/** Derive YYYY-MM-DD date string from an ISO 8601 timestamp. */
function toDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Look up the invocation.started event for a given invocation_id to
 * retrieve the transport (= provider_id), model, and phase_name.
 */
function resolveInvocationMeta(
  db: Database.Database,
  invocationId: string,
): { provider_id: string; model: string; phase_class: string } | null {
  const row = db
    .prepare(
      "SELECT payload_json FROM events WHERE type = 'invocation.started' AND aggregate_id = ? LIMIT 1",
    )
    .get(invocationId) as { payload_json: string } | undefined;

  if (!row) return null;

  const payload = JSON.parse(row.payload_json) as {
    transport?: string;
    model?: string;
    phase_name?: string;
  };

  if (!payload.transport || !payload.model || !payload.phase_name) return null;

  return {
    provider_id: payload.transport,
    model: payload.model,
    phase_class: payload.phase_name,
  };
}

export const costRollupProjection: Projection<CostRollupRow> = {
  name: "cost_rollup",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_cost_rollup (
      date             TEXT NOT NULL,
      provider_id      TEXT NOT NULL,
      model            TEXT NOT NULL,
      phase_class      TEXT NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0,
      tokens_in        INTEGER NOT NULL DEFAULT 0,
      tokens_out       INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, provider_id, model, phase_class)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_rollup_date ON proj_cost_rollup(date DESC);
    CREATE INDEX IF NOT EXISTS idx_cost_rollup_provider ON proj_cost_rollup(provider_id);
  `,

  /**
   * For invocation.completed: look up the companion invocation.started to
   * get provider/model/phase, then return the existing row for that composite
   * key — or a zero-seed row if none exists yet.
   *
   * Returns null if the invocation.started event cannot be found (e.g. orphaned
   * completion), which causes the runner to no-op.
   */
  read(db: Database.Database, event: AnyEvent): CostRollupRow | null {
    if (event.type !== "invocation.completed") return null;

    const meta = resolveInvocationMeta(db, event.aggregate_id);
    if (!meta) return null;

    const date = toDate(event.ts);

    const existing = db
      .prepare(
        `SELECT * FROM proj_cost_rollup
         WHERE date = ? AND provider_id = ? AND model = ? AND phase_class = ?`,
      )
      .get(date, meta.provider_id, meta.model, meta.phase_class) as
      | CostRollupRow
      | undefined;

    // Bootstrap seed row so reduce() always gets a non-null current.
    return existing ?? {
      date,
      provider_id: meta.provider_id,
      model: meta.model,
      phase_class: meta.phase_class as CostRollupRow["phase_class"],
      invocation_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  },

  reduce: reduceCostRollup,

  /**
   * UPSERT using the composite key from `next`. The `id` param is the
   * aggregate_id (invocation_id), which is unused here — the composite
   * key is derived from the row itself.
   */
  write(db: Database.Database, next: CostRollupRow | null, _id: string): void {
    if (!next) return; // reduceCostRollup returns null only when current was null

    db.prepare(`
      INSERT INTO proj_cost_rollup
        (date, provider_id, model, phase_class, invocation_count, tokens_in, tokens_out, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, provider_id, model, phase_class) DO UPDATE SET
        invocation_count = excluded.invocation_count,
        tokens_in        = excluded.tokens_in,
        tokens_out       = excluded.tokens_out,
        cost_usd         = excluded.cost_usd
    `).run(
      next.date,
      next.provider_id,
      next.model,
      next.phase_class ?? "",
      next.invocation_count,
      next.tokens_in,
      next.tokens_out,
      next.cost_usd,
    );
  },
};

// Self-register on import
registerProjection(costRollupProjection);
