/**
 * Event store: append-only event log backed by SQLite.
 *
 * Provides:
 *   - runMigrations(db) — idempotently creates the events + projection_watermarks tables
 *   - appendEvent(db, partial) — ULID-assigns id, computes version, validates via Zod, inserts
 *   - readEvents(db, filters) — queries the event log with optional filters
 */

import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

// Monotonic factory ensures ULIDs generated within the same millisecond
// are strictly increasing, which preserves insertion order when sorting by id.
const ulid = monotonicFactory();
import type {
  AnyEvent,
  EventType,
  AggregateType,
  Actor,
  EventMap,
} from "@shared/events.js";
import { eventPayloadSchemas } from "@shared/eventSchemas.js";

// ============================================================================
// Migrations
// ============================================================================

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id             TEXT    PRIMARY KEY,
      type           TEXT    NOT NULL,
      aggregate_type TEXT    NOT NULL,
      aggregate_id   TEXT    NOT NULL,
      version        INTEGER NOT NULL,
      ts             TEXT    NOT NULL,
      actor_json     TEXT    NOT NULL,
      correlation_id TEXT,
      causation_id   TEXT,
      payload_json   TEXT    NOT NULL,
      UNIQUE(aggregate_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_events_aggregate
      ON events (aggregate_id, version);

    CREATE INDEX IF NOT EXISTS idx_events_correlation
      ON events (correlation_id);

    CREATE INDEX IF NOT EXISTS idx_events_ts
      ON events (ts);

    CREATE TABLE IF NOT EXISTS projection_watermarks (
      projection_name TEXT PRIMARY KEY,
      last_event_id   TEXT,
      updated_at      TEXT
    );
  `);

  // Idempotent column additions — ADD COLUMN is a no-op if the column exists
  // (SQLite throws SQLITE_ERROR; we swallow it intentionally).
  for (const sql of [
    "ALTER TABLE proj_task_detail ADD COLUMN merge_commit_sha TEXT",
    "ALTER TABLE proj_task_detail ADD COLUMN merged_into_branch TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

// ============================================================================
// appendEvent
// ============================================================================

/** Input shape for appendEvent — id, ts, and version are assigned automatically. */
export type AppendEventInput<T extends EventType = EventType> = {
  type: T;
  aggregate_type: AggregateType;
  aggregate_id: string;
  actor: Actor;
  correlation_id?: string;
  causation_id?: string;
  payload: EventMap[T];
};

/**
 * Appends a new event to the store.
 *
 * - Assigns a ULID as the event id
 * - Sets ts to current ISO 8601 with milliseconds
 * - Computes version as max(version)+1 for the aggregate_id
 * - Validates payload against the Zod schema for the event type
 * - Inserts within a transaction for atomicity
 *
 * Returns the fully-hydrated event.
 */
export function appendEvent<T extends EventType>(
  db: Database.Database,
  input: AppendEventInput<T>,
): AnyEvent {
  // Validate payload against the Zod schema
  const schema = eventPayloadSchemas[input.type];
  if (!schema) {
    throw new Error(`No Zod schema registered for event type: ${input.type}`);
  }
  const parseResult = schema.safeParse(input.payload);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Payload validation failed for ${input.type}: ${issues}`,
    );
  }

  const id = ulid();
  const ts = new Date().toISOString();

  // Compute version inside a transaction to avoid race conditions
  const insert = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS max_v FROM events WHERE aggregate_id = ?",
      )
      .get(input.aggregate_id) as { max_v: number };

    const version = row.max_v + 1;

    db.prepare(
      `INSERT INTO events (id, type, aggregate_type, aggregate_id, version, ts, actor_json, correlation_id, causation_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      input.aggregate_type,
      input.aggregate_id,
      version,
      ts,
      JSON.stringify(input.actor),
      input.correlation_id ?? null,
      input.causation_id ?? null,
      JSON.stringify(input.payload),
    );

    return version;
  });

  const version = insert();

  return {
    id,
    type: input.type,
    aggregate_type: input.aggregate_type,
    aggregate_id: input.aggregate_id,
    version,
    ts,
    actor: input.actor,
    correlation_id: input.correlation_id,
    causation_id: input.causation_id,
    payload: input.payload,
  } as AnyEvent;
}

// ============================================================================
// readEvents
// ============================================================================

export type ReadEventsFilter = {
  /** Only events with id > after (for cursor-based pagination). */
  after?: string;
  /** Only events matching this correlation_id. */
  correlation_id?: string;
  /** Only events for this aggregate_id. */
  aggregate_id?: string;
  /** Max number of events to return. */
  limit?: number;
};

/**
 * Reads events from the store, ordered by id ASC (which is chronological
 * since ids are ULIDs).
 */
export function readEvents(
  db: Database.Database,
  filters: ReadEventsFilter = {},
): AnyEvent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.after) {
    conditions.push("id > ?");
    params.push(filters.after);
  }
  if (filters.correlation_id) {
    conditions.push("correlation_id = ?");
    params.push(filters.correlation_id);
  }
  if (filters.aggregate_id) {
    conditions.push("aggregate_id = ?");
    params.push(filters.aggregate_id);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause =
    filters.limit != null ? `LIMIT ${Number(filters.limit)}` : "";

  const sql = `SELECT * FROM events ${where} ORDER BY id ASC ${limitClause}`;
  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    type: string;
    aggregate_type: string;
    aggregate_id: string;
    version: number;
    ts: string;
    actor_json: string;
    correlation_id: string | null;
    causation_id: string | null;
    payload_json: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    type: row.type as EventType,
    aggregate_type: row.aggregate_type as AggregateType,
    aggregate_id: row.aggregate_id,
    version: row.version,
    ts: row.ts,
    actor: JSON.parse(row.actor_json) as Actor,
    correlation_id: row.correlation_id ?? undefined,
    causation_id: row.causation_id ?? undefined,
    payload: JSON.parse(row.payload_json),
  })) as AnyEvent[];
}
