import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import {
  appendAndProject,
  initProjections,
  rebuildProjection,
} from "../projectionRunner.js";
import type { Actor, Transport } from "@shared/events.js";
import type { CostRollupRow } from "@shared/projections.js";

// Register all projections including costRollup
import "./register.js";

// ============================================================================
// Fixtures
// ============================================================================

const actor: Actor = { kind: "user", user_id: "test" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

/** Append a paired invocation.started + invocation.completed event sequence. */
function appendInvocation(
  db: Database.Database,
  opts: {
    invocationId: string;
    transport?: Transport;
    model?: string;
    phaseName?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    ts?: string;
  },
): void {
  const {
    invocationId,
    transport = "anthropic-api" as const,
    model = "claude-sonnet-4-6",
    phaseName = "implementer",
    tokensIn = 1000,
    tokensOut = 500,
    costUsd = 0.005,
    ts = "2026-04-21T12:00:00.000Z",
  } = opts;

  // invocation.started provides the metadata (transport, model, phase_name)
  appendAndProject(db, {
    type: "invocation.started",
    aggregate_type: "attempt",
    aggregate_id: invocationId,
    actor,
    payload: {
      invocation_id: invocationId,
      attempt_id: "att-001",
      phase_name: phaseName,
      transport,
      model,
      prompt_version_id: "pv-001",
      context_manifest_hash: "abc123",
    },
  });

  // invocation.completed triggers the cost_rollup projection
  appendAndProject(db, {
    type: "invocation.completed",
    aggregate_type: "attempt",
    aggregate_id: invocationId,
    actor,
    // Override ts for date-bucketing tests
    payload: {
      invocation_id: invocationId,
      outcome: "success",
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      duration_ms: 1500,
      turns: 3,
    },
  });
}

function getRows(db: Database.Database): CostRollupRow[] {
  return db
    .prepare("SELECT * FROM proj_cost_rollup ORDER BY date, provider_id, model")
    .all() as CostRollupRow[];
}

function getRow(
  db: Database.Database,
  date: string,
  providerId: string,
  model: string,
  phaseClass: string,
): CostRollupRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM proj_cost_rollup
         WHERE date = ? AND provider_id = ? AND model = ? AND phase_class = ?`,
      )
      .get(date, providerId, model, phaseClass) as CostRollupRow | undefined) ?? null
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("cost_rollup projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("proj_cost_rollup table is created on first run", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proj_cost_rollup'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("proj_cost_rollup");
  });

  it("creates a row on first invocation.completed for a given date/provider/model", () => {
    appendInvocation(db, { invocationId: "inv-001" });

    const rows = getRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_id).toBe("anthropic-api");
    expect(rows[0].model).toBe("claude-sonnet-4-6");
    expect(rows[0].phase_class).toBe("implementer");
    expect(rows[0].invocation_count).toBe(1);
    expect(rows[0].tokens_in).toBe(1000);
    expect(rows[0].tokens_out).toBe(500);
    expect(rows[0].cost_usd).toBeCloseTo(0.005);
  });

  it("accumulates multiple invocations into the same row", () => {
    appendInvocation(db, {
      invocationId: "inv-a",
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.004,
    });
    appendInvocation(db, {
      invocationId: "inv-b",
      tokensIn: 2000,
      tokensOut: 400,
      costUsd: 0.008,
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(1); // same date/provider/model/phase → same row
    expect(rows[0].invocation_count).toBe(2);
    expect(rows[0].tokens_in).toBe(3000);
    expect(rows[0].tokens_out).toBe(600);
    expect(rows[0].cost_usd).toBeCloseTo(0.012);
  });

  it("creates separate rows for different providers", () => {
    appendInvocation(db, {
      invocationId: "inv-api",
      transport: "anthropic-api",
      model: "claude-sonnet-4-6",
    });
    appendInvocation(db, {
      invocationId: "inv-cli",
      transport: "claude-code",
      model: "claude-sonnet-4-6",
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(2);
    const providerIds = rows.map((r) => r.provider_id).sort();
    expect(providerIds).toEqual(["anthropic-api", "claude-code"]);
  });

  it("creates separate rows for different models", () => {
    appendInvocation(db, {
      invocationId: "inv-sonnet",
      model: "claude-sonnet-4-6",
      costUsd: 0.003,
    });
    appendInvocation(db, {
      invocationId: "inv-opus",
      model: "claude-opus-4-6",
      costUsd: 0.015,
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(2);
    const models = rows.map((r) => r.model).sort();
    expect(models).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
  });

  it("creates separate rows for different phase classes", () => {
    appendInvocation(db, {
      invocationId: "inv-impl",
      phaseName: "implementer",
    });
    appendInvocation(db, {
      invocationId: "inv-audit",
      phaseName: "auditor",
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(2);
    const phases = rows.map((r) => r.phase_class).sort();
    expect(phases).toEqual(["auditor", "implementer"]);
  });

  it("is a no-op when invocation.started is missing (orphaned completion)", () => {
    // Append completed without a prior started — projection should not write a row
    appendAndProject(db, {
      type: "invocation.completed",
      aggregate_type: "attempt",
      aggregate_id: "orphan-001",
      actor,
      payload: {
        invocation_id: "orphan-001",
        outcome: "success",
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.001,
        duration_ms: 500,
        turns: 1,
      },
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(0);
  });

  it("rebuild produces identical state", () => {
    appendInvocation(db, { invocationId: "inv-r1", tokensIn: 500, tokensOut: 100, costUsd: 0.002 });
    appendInvocation(db, { invocationId: "inv-r2", tokensIn: 800, tokensOut: 200, costUsd: 0.004 });

    const before = getRows(db);
    rebuildProjection(db, "cost_rollup");
    const after = getRows(db);

    expect(after).toEqual(before);
  });

  it("proj_cost_rollup has rows per day/provider/model after attempts complete", () => {
    // Two invocations on the same day
    appendInvocation(db, {
      invocationId: "inv-day1a",
      tokensIn: 1000,
      costUsd: 0.005,
    });
    appendInvocation(db, {
      invocationId: "inv-day1b",
      tokensIn: 2000,
      costUsd: 0.01,
    });

    const rows = getRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].invocation_count).toBe(2);
    expect(rows[0].tokens_in).toBe(3000);
    expect(rows[0].cost_usd).toBeCloseTo(0.015);
  });
});
