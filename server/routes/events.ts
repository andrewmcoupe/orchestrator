/**
 * SSE event stream and recent-events query routes.
 *
 * GET /api/events — Server-Sent Events stream of committed events.
 *   ?after=<event_id>  — replay events with id > after before switching to live
 *   ?correlation_id=<id> — only emit events matching this correlation_id
 *
 * GET /api/events/recent — last N events for initial UI load.
 *   ?correlation_id=<id> — filter by correlation_id
 *   ?limit=<n> — max events to return (default 50)
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type Database from "better-sqlite3";
import { readEvents } from "../eventStore.js";
import { eventBus } from "../projectionRunner.js";
import type { AnyEvent } from "@shared/events.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export function createEventRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // =========================================================================
  // GET /api/events — SSE stream
  // =========================================================================
  app.get("/api/events", (c) => {
    const afterParam = c.req.query("after");
    const correlationFilter = c.req.query("correlation_id");

    return streamSSE(c, async (stream) => {
      let lastSeenId = afterParam ?? undefined;

      // 1. Replay missed events (if ?after= provided)
      if (lastSeenId) {
        const missed = readEvents(db, {
          after: lastSeenId,
          correlation_id: correlationFilter,
        });
        for (const event of missed) {
          await stream.writeSSE({
            data: JSON.stringify(event),
            id: event.id,
          });
          lastSeenId = event.id;
        }
      }

      // 2. Subscribe to live events
      const listener = async (event: AnyEvent) => {
        // Skip events we've already sent during replay
        if (lastSeenId && event.id <= lastSeenId) return;

        // Apply correlation filter
        if (correlationFilter && event.correlation_id !== correlationFilter) {
          return;
        }

        try {
          await stream.writeSSE({
            data: JSON.stringify(event),
            id: event.id,
          });
          lastSeenId = event.id;
        } catch {
          // Client disconnected — listener will be removed by onAbort
        }
      };

      eventBus.on("event.committed", listener);

      // 3. Heartbeat every 15s
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ data: "", event: "heartbeat" });
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // 4. Clean up on disconnect
      stream.onAbort(() => {
        eventBus.removeListener("event.committed", listener);
        clearInterval(heartbeat);
      });

      // Keep the stream open until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    });
  });

  // =========================================================================
  // GET /api/events/recent — last N events (reverse chronological)
  // =========================================================================
  app.get("/api/events/recent", (c) => {
    const correlationFilter = c.req.query("correlation_id");
    const aggregateIdFilter = c.req.query("aggregate_id");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Number(limitParam), 500) : 50;

    // Read all matching events then take the last N (readEvents is ordered ASC)
    const events = readEvents(db, {
      correlation_id: correlationFilter || undefined,
      aggregate_id: aggregateIdFilter || undefined,
    });

    // Return the last `limit` events in reverse chronological order
    const recent = events.slice(-limit).reverse();

    return c.json(recent);
  });

  return app;
}
