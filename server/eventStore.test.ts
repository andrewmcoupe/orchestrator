import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, appendEvent, readEvents } from "./eventStore.js";
import type { AppendEventInput } from "./eventStore.js";
import type { Actor, TaskConfig } from "@shared/events.js";

// ============================================================================
// Helpers
// ============================================================================

const testActor: Actor = { kind: "user", user_id: "test-user" };

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
    on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
    on_test_fail: { strategy: "retry_same", max_attempts: 2 },
    on_audit_reject: "escalate_to_human",
    on_spec_pushback: "pause_and_notify",
    max_total_attempts: 3,
  },
};

function makeTaskCreatedInput(
  taskId: string,
  title = "Test task",
): AppendEventInput<"task.created"> {
  return {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor: testActor,
    payload: {
      task_id: taskId,
      title,
      proposition_ids: ["prop-1"],
      config_snapshot: minimalConfig,
    },
  };
}

// ============================================================================
// Test suite
// ============================================================================

describe("eventStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // Migration
  // --------------------------------------------------------------------------

  describe("runMigrations", () => {
    it("creates the events table with the expected columns", () => {
      const info = db.prepare("PRAGMA table_info(events)").all() as Array<{
        name: string;
      }>;
      const columns = info.map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "id",
          "type",
          "aggregate_type",
          "aggregate_id",
          "version",
          "ts",
          "actor_json",
          "correlation_id",
          "causation_id",
          "payload_json",
        ]),
      );
    });

    it("creates the UNIQUE(aggregate_id, version) constraint", () => {
      const indices = db
        .prepare("PRAGMA index_list(events)")
        .all() as Array<{ name: string; unique: number }>;
      const uniqueIndices = indices.filter((i) => i.unique === 1);
      // Should have at least the UNIQUE constraint index
      expect(uniqueIndices.length).toBeGreaterThanOrEqual(1);
    });

    it("creates the projection_watermarks table", () => {
      const info = db
        .prepare("PRAGMA table_info(projection_watermarks)")
        .all() as Array<{ name: string }>;
      const columns = info.map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining(["projection_name", "last_event_id", "updated_at"]),
      );
    });

    it("is idempotent — running twice does not throw", () => {
      expect(() => runMigrations(db)).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // appendEvent + readEvents round trip
  // --------------------------------------------------------------------------

  describe("append-and-read round trip", () => {
    it("assigns a ULID id and ISO timestamp", () => {
      const event = appendEvent(db, makeTaskCreatedInput("task-1"));
      expect(event.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("assigns version = 1 for the first event on an aggregate", () => {
      const event = appendEvent(db, makeTaskCreatedInput("task-1"));
      expect(event.version).toBe(1);
    });

    it("reads back the same event that was appended", () => {
      const written = appendEvent(db, makeTaskCreatedInput("task-1"));
      const [read] = readEvents(db);
      expect(read.id).toBe(written.id);
      expect(read.type).toBe("task.created");
      expect(read.aggregate_id).toBe("task-1");
      expect(read.payload).toEqual(written.payload);
      expect(read.actor).toEqual(testActor);
    });

    it("preserves correlation_id and causation_id", () => {
      const input = makeTaskCreatedInput("task-1");
      input.correlation_id = "corr-123";
      input.causation_id = "cause-456";
      appendEvent(db, input);
      const [read] = readEvents(db);
      expect(read.correlation_id).toBe("corr-123");
      expect(read.causation_id).toBe("cause-456");
    });
  });

  // --------------------------------------------------------------------------
  // Version monotonicity
  // --------------------------------------------------------------------------

  describe("version assignment", () => {
    it("assigns monotonic versions per aggregate_id", () => {
      const e1 = appendEvent(db, makeTaskCreatedInput("task-1"));
      const e2 = appendEvent(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1", from: "queued", to: "running" },
      });
      const e3 = appendEvent(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1", from: "running", to: "paused" },
      });
      expect(e1.version).toBe(1);
      expect(e2.version).toBe(2);
      expect(e3.version).toBe(3);
    });

    it("maintains separate version sequences per aggregate_id", () => {
      const a = appendEvent(db, makeTaskCreatedInput("task-a"));
      const b = appendEvent(db, makeTaskCreatedInput("task-b"));
      expect(a.version).toBe(1);
      expect(b.version).toBe(1);
    });

    it("enforces UNIQUE(aggregate_id, version) constraint", () => {
      appendEvent(db, makeTaskCreatedInput("task-1"));
      // Force-insert a duplicate version to verify the constraint
      expect(() =>
        db
          .prepare(
            `INSERT INTO events (id, type, aggregate_type, aggregate_id, version, ts, actor_json, correlation_id, causation_id, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "FORCED-ID",
            "task.created",
            "task",
            "task-1",
            1, // duplicate version
            new Date().toISOString(),
            JSON.stringify(testActor),
            null,
            null,
            "{}",
          ),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });

  // --------------------------------------------------------------------------
  // Payload validation
  // --------------------------------------------------------------------------

  describe("schema validation", () => {
    it("rejects a payload that fails its Zod schema", () => {
      expect(() =>
        appendEvent(db, {
          type: "task.created",
          aggregate_type: "task",
          aggregate_id: "task-bad",
          actor: testActor,
          // Missing required fields
          payload: { task_id: "task-bad" } as never,
        }),
      ).toThrow(/Payload validation failed for task.created/);
    });

    it("includes field-level error details in the message", () => {
      try {
        appendEvent(db, {
          type: "task.status_changed",
          aggregate_type: "task",
          aggregate_id: "task-1",
          actor: testActor,
          payload: { task_id: "task-1", from: "queued" } as never,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("to:");
      }
    });

    it("does not write the event when validation fails", () => {
      try {
        appendEvent(db, {
          type: "task.created",
          aggregate_type: "task",
          aggregate_id: "task-orphan",
          actor: testActor,
          payload: {} as never,
        });
      } catch {
        // expected
      }
      const events = readEvents(db, { aggregate_id: "task-orphan" });
      expect(events).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // readEvents filters
  // --------------------------------------------------------------------------

  describe("readEvents filters", () => {
    beforeEach(() => {
      // Seed: 3 events on task-1, 1 on task-2
      appendEvent(db, {
        ...makeTaskCreatedInput("task-1"),
        correlation_id: "corr-a",
      });
      appendEvent(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        correlation_id: "corr-a",
        payload: { task_id: "task-1", from: "queued", to: "running" },
      });
      appendEvent(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        correlation_id: "corr-b",
        payload: { task_id: "task-1", from: "running", to: "paused" },
      });
      appendEvent(db, {
        ...makeTaskCreatedInput("task-2", "Other task"),
        correlation_id: "corr-c",
      });
    });

    it("returns all events when no filters given", () => {
      const all = readEvents(db);
      expect(all).toHaveLength(4);
    });

    it("filters by correlation_id", () => {
      const filtered = readEvents(db, { correlation_id: "corr-a" });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((e) => e.correlation_id === "corr-a")).toBe(true);
    });

    it("filters by aggregate_id", () => {
      const filtered = readEvents(db, { aggregate_id: "task-2" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].aggregate_id).toBe("task-2");
    });

    it("filters by after (cursor pagination)", () => {
      const all = readEvents(db);
      const afterSecond = readEvents(db, { after: all[1].id });
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0].id).toBe(all[2].id);
    });

    it("respects limit", () => {
      const limited = readEvents(db, { limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("combines multiple filters", () => {
      const all = readEvents(db);
      // after=first event skips it, aggregate_id=task-1 excludes task-2, limit=1
      const filtered = readEvents(db, {
        aggregate_id: "task-1",
        after: all[0].id,
        limit: 1,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].aggregate_id).toBe("task-1");
      // The first task-1 event (version 1) is skipped by after, so we get version 2
      expect(filtered[0].type).toBe("task.status_changed");
    });
  });
});
