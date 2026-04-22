/**
 * Projection runner — the canonical write path for the event store.
 *
 * appendAndProject(db, input) is the ONLY way events should be written.
 * It opens a single SQLite transaction containing:
 *   1. The event append (via eventStore.appendEvent)
 *   2. For each subscribed projection: read → reduce → write
 *   3. Watermark updates for each touched projection
 *
 * After the transaction commits, the committed event is emitted on an
 * in-process EventEmitter ("event.committed") so the SSE layer can fan
 * it out to connected clients.
 *
 * rebuildProjection(db, name) replays the entire event log through a
 * single projection's reducer, replacing all its rows. This is the
 * escape hatch for projection logic changes.
 */

import type Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { appendEvent, readEvents } from "./eventStore.js";
import type { AppendEventInput } from "./eventStore.js";
import type { AnyEvent, EventType } from "@shared/events.js";
import {
  PROJECTION_SUBSCRIPTIONS,
  type ProjectionName,
} from "@shared/projections.js";

// ============================================================================
// Projection interface
// ============================================================================

/**
 * Each projection module implements this interface and self-registers
 * with the runner at import time.
 *
 * - createSql: DDL to create the projection table (idempotent with IF NOT EXISTS)
 * - read: fetch the current row affected by this event (or null)
 * - reduce: pure function (current, event) → next (null means delete)
 * - write: upsert the new row or delete if null
 */
export type Projection<TRow> = {
  name: ProjectionName;
  createSql: string;
  read: (db: Database.Database, event: AnyEvent) => TRow | null;
  reduce: (current: TRow | null, event: AnyEvent) => TRow | null;
  write: (db: Database.Database, next: TRow | null, id: string) => void;
};

// ============================================================================
// Registry
// ============================================================================

const registry = new Map<ProjectionName, Projection<unknown>>();

/** Register a projection module. Called at import time by each projection. */
export function registerProjection<TRow>(projection: Projection<TRow>): void {
  registry.set(
    projection.name,
    projection as unknown as Projection<unknown>,
  );
}

/** Get all registered projections. */
export function getRegisteredProjections(): Map<
  ProjectionName,
  Projection<unknown>
> {
  return registry;
}

// ============================================================================
// Event bus — emits after transaction commits
// ============================================================================

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// ============================================================================
// appendAndProject — the canonical write path
// ============================================================================

/**
 * Appends an event and updates all subscribed projections in a single
 * SQLite transaction. Emits "event.committed" AFTER the transaction
 * commits successfully.
 */
export function appendAndProject<T extends EventType>(
  db: Database.Database,
  input: AppendEventInput<T>,
): AnyEvent {
  let committedEvent: AnyEvent;

  const tx = db.transaction(() => {
    // 1. Append the event
    const event = appendEvent(db, input);

    // 2. Look up subscribed projections
    const subscriptions = PROJECTION_SUBSCRIPTIONS[event.type] ?? [];

    // 3. For each subscribed projection: read → reduce → write + watermark
    for (const projName of subscriptions) {
      const projection = registry.get(projName);
      if (!projection) continue; // not yet registered — skip silently

      const current = projection.read(db, event);
      const next = projection.reduce(current, event);
      projection.write(db, next, deriveRowId(event, projName));

      // Update watermark
      db.prepare(
        `INSERT INTO projection_watermarks (projection_name, last_event_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(projection_name) DO UPDATE SET
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at`,
      ).run(projName, event.id, event.ts);
    }

    committedEvent = event;
    return event;
  });

  tx();

  // Emit only AFTER the transaction has committed
  eventBus.emit("event.committed", committedEvent!);

  return committedEvent!;
}

// ============================================================================
// rebuildProjection — replay all events through one projection
// ============================================================================

/**
 * Drops all rows from a projection's table, resets its watermark,
 * and replays every event in chronological order through the reducer.
 */
export function rebuildProjection(
  db: Database.Database,
  name: ProjectionName,
): void {
  const projection = registry.get(name);
  if (!projection) {
    throw new Error(`No projection registered with name: ${name}`);
  }

  // Find the table name from the createSql (convention: proj_<name>)
  const tableName = `proj_${name}`;

  const tx = db.transaction(() => {
    // Drop existing rows
    db.prepare(`DELETE FROM ${tableName}`).run();

    // Reset watermark
    db.prepare(
      `INSERT INTO projection_watermarks (projection_name, last_event_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
    ).run(name, null, new Date().toISOString());

    // Replay all events in order
    const events = readEvents(db);
    let lastEventId: string | null = null;

    for (const event of events) {
      const subscriptions = PROJECTION_SUBSCRIPTIONS[event.type] ?? [];
      if (!subscriptions.includes(name)) continue;

      const current = projection.read(db, event);
      const next = projection.reduce(current, event);
      projection.write(db, next, deriveRowId(event, name));

      lastEventId = event.id;
    }

    // Update watermark to the last processed event
    if (lastEventId) {
      db.prepare(
        `UPDATE projection_watermarks SET last_event_id = ?, updated_at = ?
         WHERE projection_name = ?`,
      ).run(lastEventId, new Date().toISOString(), name);
    }
  });

  tx();
}

// ============================================================================
// initProjections — create all projection tables
// ============================================================================

/**
 * Run createSql for every registered projection. Call once at boot
 * after all projection modules have been imported.
 */
export function initProjections(db: Database.Database): void {
  for (const projection of registry.values()) {
    db.exec(projection.createSql);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Derives the primary key for a projection row from the event.
 * Convention: each projection's read/write uses a domain id
 * (task_id, attempt_id, etc.). The runner passes this through
 * so write() can use it for upsert/delete keying.
 *
 * For most projections the id is in event.payload. The projection's
 * read() + write() are responsible for the actual keying; this
 * helper provides a fallback aggregate_id.
 */
function deriveRowId(event: AnyEvent, _projName: ProjectionName): string {
  return event.aggregate_id;
}
