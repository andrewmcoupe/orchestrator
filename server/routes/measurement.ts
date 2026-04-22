/**
 * Measurement routes — aggregated analytics data for the dashboard.
 *
 * GET /api/measurement/cost?from=&to=&group_by=
 *   Returns daily cost rollups, optionally aggregated by provider or model.
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { CostRollupRow } from "@shared/projections.js";

/** Aggregated cost row when grouped by provider. */
interface ProviderCostSummary {
  provider_id: string;
  invocation_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** Aggregated cost row when grouped by model. */
interface ModelCostSummary {
  provider_id: string;
  model: string;
  invocation_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/**
 * Safely execute a SELECT against a table that may not exist yet.
 * Returns an empty array if the table hasn't been created.
 */
function safeAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("no such table")) return [];
    throw e;
  }
}

export function createMeasurementRoutes(db: Database.Database): Hono {
  const routes = new Hono();

  /**
   * GET /api/measurement/cost
   *
   * Query params:
   *   from       — ISO date (YYYY-MM-DD), inclusive lower bound
   *   to         — ISO date (YYYY-MM-DD), inclusive upper bound
   *   group_by   — "provider" | "model" | omit for daily granularity
   *
   * Responses:
   *   group_by=provider  → ProviderCostSummary[]
   *   group_by=model     → ModelCostSummary[]
   *   (default)          → CostRollupRow[]  ordered by date ASC (for time-series charts)
   */
  routes.get("/api/measurement/cost", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const groupBy = c.req.query("group_by");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (from) {
      conditions.push("date >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("date <= ?");
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    if (groupBy === "provider") {
      const rows = safeAll<ProviderCostSummary>(
        db,
        `SELECT provider_id,
                SUM(invocation_count) AS invocation_count,
                SUM(tokens_in)        AS tokens_in,
                SUM(tokens_out)       AS tokens_out,
                SUM(cost_usd)         AS cost_usd
         FROM proj_cost_rollup ${where}
         GROUP BY provider_id
         ORDER BY cost_usd DESC`,
        params,
      );
      return c.json(rows);
    }

    if (groupBy === "model") {
      const rows = safeAll<ModelCostSummary>(
        db,
        `SELECT provider_id,
                model,
                SUM(invocation_count) AS invocation_count,
                SUM(tokens_in)        AS tokens_in,
                SUM(tokens_out)       AS tokens_out,
                SUM(cost_usd)         AS cost_usd
         FROM proj_cost_rollup ${where}
         GROUP BY provider_id, model
         ORDER BY cost_usd DESC`,
        params,
      );
      return c.json(rows);
    }

    // Default: raw daily rows ordered ascending for time-series charts
    const rows = safeAll<CostRollupRow>(
      db,
      `SELECT * FROM proj_cost_rollup ${where} ORDER BY date ASC`,
      params,
    );
    return c.json(rows);
  });

  return routes;
}
