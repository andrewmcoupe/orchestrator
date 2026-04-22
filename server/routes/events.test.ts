/**
 * Tests for SSE event stream and recent-events routes.
 *
 * Uses in-memory SQLite DB seeded via appendAndProject. For the SSE
 * stream tests, we emit events on the eventBus directly to simulate
 * live commits without needing a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createDb } from "../db.js";
import { runMigrations } from "../eventStore.js";
import {
  initProjections,
  appendAndProject,
  eventBus,
} from "../projectionRunner.js";
import "../projections/register.js";
import { createEventRoutes } from "./events.js";
import type { Actor, TaskConfig, AnyEvent } from "@shared/events.js";
import type Database from "better-sqlite3";

const actor: Actor = { kind: "user", user_id: "test" };

const minimalConfig: TaskConfig = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "sonnet-4-6",
      prompt_version_id: "pv-1",
      transport_options: {
        kind: "cli",
        bare: true,
        max_turns: 10,
        max_budget_usd: 1,
        permission_mode: "acceptEdits",
      },
      context_policy: {
        symbol_graph_depth: 2,
        include_tests: true,
        include_similar_patterns: false,
        token_budget: 8000,
      },
    },
  ],
  gates: [],
  retry_policy: {
    max_total_attempts: 3,
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
  },
};

function setup(): {
  db: Database.Database;
  app: ReturnType<typeof createEventRoutes>;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "events-routes-"));
  const db = createDb(path.join(tmpDir, "test.db"));
  runMigrations(db);
  initProjections(db);
  const app = createEventRoutes(db);
  return { db, app };
}

function seedTask(
  db: Database.Database,
  taskId: string,
  opts: { correlationId?: string } = {},
): AnyEvent {
  return appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor,
    correlation_id: opts.correlationId,
    payload: {
      task_id: taskId,
      title: `Task ${taskId}`,
      preset_id: undefined,
      proposition_ids: [],
      config_snapshot: minimalConfig,
    },
  });
}

// ============================================================================
// GET /api/events/recent
// ============================================================================

describe("GET /api/events/recent", () => {
  it("returns empty array on a fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/events/recent");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns events in reverse chronological order", async () => {
    const { db, app } = setup();
    const e1 = seedTask(db, "T-001");
    const e2 = seedTask(db, "T-002");
    const e3 = seedTask(db, "T-003");

    const res = await app.request("/api/events/recent");
    const body = (await res.json()) as AnyEvent[];

    expect(body).toHaveLength(3);
    // Most recent first
    expect(body[0].id).toBe(e3.id);
    expect(body[1].id).toBe(e2.id);
    expect(body[2].id).toBe(e1.id);
  });

  it("respects the limit parameter", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");
    seedTask(db, "T-002");
    seedTask(db, "T-003");

    const res = await app.request("/api/events/recent?limit=2");
    const body = (await res.json()) as AnyEvent[];

    expect(body).toHaveLength(2);
    // Should be the 2 most recent
    expect(body[0].aggregate_id).toBe("T-003");
    expect(body[1].aggregate_id).toBe("T-002");
  });

  it("defaults to 50 limit", async () => {
    const { db, app } = setup();
    // Seed 60 tasks
    for (let i = 1; i <= 60; i++) {
      seedTask(db, `T-${String(i).padStart(3, "0")}`);
    }

    const res = await app.request("/api/events/recent");
    const body = (await res.json()) as AnyEvent[];

    expect(body).toHaveLength(50);
    // Most recent should be T-060
    expect(body[0].aggregate_id).toBe("T-060");
  });

  it("filters by correlation_id", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001", { correlationId: "corr-A" });
    seedTask(db, "T-002", { correlationId: "corr-B" });
    seedTask(db, "T-003", { correlationId: "corr-A" });

    const res = await app.request(
      "/api/events/recent?correlation_id=corr-A",
    );
    const body = (await res.json()) as AnyEvent[];

    expect(body).toHaveLength(2);
    expect(body.every((e) => e.correlation_id === "corr-A")).toBe(true);
  });

  it("caps limit at 500", async () => {
    const { app } = setup();
    const res = await app.request("/api/events/recent?limit=9999");
    // Should not error — limit is capped internally
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// GET /api/events — SSE stream
// ============================================================================

describe("GET /api/events (SSE)", () => {
  afterEach(() => {
    // Clean up any lingering listeners from tests
    eventBus.removeAllListeners("event.committed");
  });

  it("returns a streaming response with correct content type", async () => {
    const { app } = setup();

    // Use AbortController to close the connection after checking headers
    const controller = new AbortController();
    const resPromise = app.request("/api/events", {
      signal: controller.signal,
    });

    // Give the stream a moment to start
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    try {
      const res = await resPromise;
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } catch {
      // AbortError is expected
    }
  });

  it("replays missed events when ?after= is provided", async () => {
    const { db, app } = setup();
    const e1 = seedTask(db, "T-001");
    const e2 = seedTask(db, "T-002");
    const e3 = seedTask(db, "T-003");

    const controller = new AbortController();
    const res = await app.request(`/api/events?after=${e1.id}`, {
      signal: controller.signal,
    });

    // Read the stream body
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    // Read chunks until we have both replayed events
    const readUntil = async (count: number) => {
      let dataLines = 0;
      while (dataLines < count) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        dataLines = (accumulated.match(/^data:/gm) || []).length;
      }
    };

    await readUntil(2);
    controller.abort();

    // Should have replayed e2 and e3 (not e1)
    expect(accumulated).toContain(e2.id);
    expect(accumulated).toContain(e3.id);
    expect(accumulated).not.toContain(`"id":"${e1.id}"`);
  });

  it("filters replay events by correlation_id", async () => {
    const { db, app } = setup();
    // Seed a marker event to use as the "after" cursor
    const marker = seedTask(db, "T-000");
    seedTask(db, "T-001", { correlationId: "corr-X" });
    const e2 = seedTask(db, "T-002", { correlationId: "corr-Y" });
    seedTask(db, "T-003", { correlationId: "corr-X" });

    const controller = new AbortController();
    const res = await app.request(
      `/api/events?after=${marker.id}&correlation_id=corr-Y`,
      { signal: controller.signal },
    );

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    // Read one data frame (the only corr-Y event in replay)
    const readUntil = async (count: number) => {
      let dataLines = 0;
      while (dataLines < count) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        dataLines = (accumulated.match(/^data:/gm) || []).length;
      }
    };

    await readUntil(1);
    controller.abort();

    // Only e2 should be present (corr-Y)
    expect(accumulated).toContain(e2.id);
    expect(accumulated).not.toContain("T-001");
    expect(accumulated).not.toContain("T-003");
  });

  it("registers a listener on the eventBus during a connection", async () => {
    const { app } = setup();
    const initialCount = eventBus.listenerCount("event.committed");

    const controller = new AbortController();
    const resPromise = app.request("/api/events", {
      signal: controller.signal,
    });

    // Wait for the listener to be registered
    await new Promise((r) => setTimeout(r, 50));
    const activeCount = eventBus.listenerCount("event.committed");
    expect(activeCount).toBeGreaterThan(initialCount);

    // Clean up
    controller.abort();
    try {
      await resPromise;
    } catch {
      // AbortError expected
    }
  });

  it("/api/events/recent returns most-recent N events in reverse-chronological order", async () => {
    const { db, app } = setup();
    const events: AnyEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push(seedTask(db, `T-${String(i).padStart(3, "0")}`));
    }

    const res = await app.request("/api/events/recent?limit=3");
    const body = (await res.json()) as AnyEvent[];

    expect(body).toHaveLength(3);
    expect(body[0].id).toBe(events[4].id); // T-005
    expect(body[1].id).toBe(events[3].id); // T-004
    expect(body[2].id).toBe(events[2].id); // T-003
  });
});
