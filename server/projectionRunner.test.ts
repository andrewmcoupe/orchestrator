import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import { runMigrations, readEvents } from "./eventStore.js";
import type { AppendEventInput } from "./eventStore.js";
import type { Actor, TaskConfig, AnyEvent } from "@shared/events.js";
import type { TaskListRow, ProjectionName } from "@shared/projections.js";
import { reduceTaskList } from "@shared/projections.js";
import {
  appendAndProject,
  rebuildProjection,
  registerProjection,
  initProjections,
  eventBus,
  getRegisteredProjections,
  type Projection,
} from "./projectionRunner.js";

// ============================================================================
// Test helpers
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
// Minimal task_list projection for testing
// ============================================================================

const taskListProjection: Projection<TaskListRow> = {
  name: "task_list",
  createSql: `
    CREATE TABLE IF NOT EXISTS proj_task_list (
      task_id            TEXT PRIMARY KEY,
      prd_id             TEXT,
      title              TEXT NOT NULL,
      status             TEXT NOT NULL,
      current_phase      TEXT,
      current_attempt_id TEXT,
      attempt_count      INTEGER NOT NULL DEFAULT 0,
      pushback_count     INTEGER NOT NULL DEFAULT 0,
      phase_models_json  TEXT,
      last_event_ts      TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
  `,

  read(db: Database.Database, event: AnyEvent): TaskListRow | null {
    const taskId = extractTaskId(event);
    if (!taskId) return null;

    const row = db
      .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
      .get(taskId) as RawTaskListRow | undefined;

    if (!row) return null;
    return {
      ...row,
      phase_models: row.phase_models_json
        ? JSON.parse(row.phase_models_json)
        : {},
    };
  },

  reduce: reduceTaskList,

  write(db: Database.Database, next: TaskListRow | null, _id: string): void {
    if (!next) {
      // Archived — delete the row. We need the task_id from somewhere,
      // but write is only called after reduce returns null, meaning the
      // previous read found a row. The runner passes aggregate_id.
      // For safety: if no row exists, this is a no-op.
      db.prepare("DELETE FROM proj_task_list WHERE task_id = ?").run(_id);
      return;
    }

    db.prepare(
      `INSERT INTO proj_task_list
         (task_id, prd_id, title, status, current_phase, current_attempt_id,
          attempt_count, pushback_count, phase_models_json, last_event_ts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         prd_id = excluded.prd_id,
         title = excluded.title,
         status = excluded.status,
         current_phase = excluded.current_phase,
         current_attempt_id = excluded.current_attempt_id,
         attempt_count = excluded.attempt_count,
         pushback_count = excluded.pushback_count,
         phase_models_json = excluded.phase_models_json,
         last_event_ts = excluded.last_event_ts,
         updated_at = excluded.updated_at`,
    ).run(
      next.task_id,
      next.prd_id ?? null,
      next.title,
      next.status,
      next.current_phase ?? null,
      next.current_attempt_id ?? null,
      next.attempt_count,
      next.pushback_count,
      JSON.stringify(next.phase_models),
      next.last_event_ts,
      next.updated_at,
    );
  },
};

type RawTaskListRow = Omit<TaskListRow, "phase_models"> & {
  phase_models_json: string | null;
};

/** Extract task_id from various event payloads. */
function extractTaskId(event: AnyEvent): string | null {
  const p = event.payload as unknown as Record<string, unknown>;
  if ("task_id" in p) return p.task_id as string;
  return null;
}

// ============================================================================
// Test suite
// ============================================================================

describe("projectionRunner", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Clear the global registry between tests
    const reg = getRegisteredProjections();
    reg.clear();

    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Register and init the test projection
    registerProjection(taskListProjection);
    initProjections(db);
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
  });

  // --------------------------------------------------------------------------
  // appendAndProject
  // --------------------------------------------------------------------------

  describe("appendAndProject", () => {
    it("writes the event and updates the projection atomically", () => {
      const event = appendAndProject(db, makeTaskCreatedInput("task-1"));

      // Event written
      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event.id);

      // Projection updated
      const row = db
        .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
        .get("task-1") as RawTaskListRow;
      expect(row).toBeDefined();
      expect(row.title).toBe("Test task");
      expect(row.status).toBe("queued");
    });

    it("updates the projection watermark for each subscribed projection", () => {
      const event = appendAndProject(db, makeTaskCreatedInput("task-1"));

      const watermark = db
        .prepare(
          "SELECT * FROM projection_watermarks WHERE projection_name = ?",
        )
        .get("task_list") as {
        projection_name: string;
        last_event_id: string;
        updated_at: string;
      };

      expect(watermark).toBeDefined();
      expect(watermark.last_event_id).toBe(event.id);
    });

    it("handles events with no subscribed projections", () => {
      // prd.ingested has no subscriptions
      const event = appendAndProject(db, {
        type: "prd.ingested",
        aggregate_type: "prd",
        aggregate_id: "prd-1",
        actor: testActor,
        payload: {
          prd_id: "prd-1",
          path: "/test.md",
          size_bytes: 1000,
          lines: 50,
          extractor_model: "sonnet-4-6",
          extractor_prompt_version_id: "pv-1",
          content_hash: "abc123",
          content: "# Test PRD",
        },
      });

      expect(event.type).toBe("prd.ingested");
      const events = readEvents(db);
      expect(events).toHaveLength(1);
    });

    it("applies multiple events to the same projection row", () => {
      appendAndProject(db, makeTaskCreatedInput("task-1"));

      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1", from: "queued", to: "running" },
      });

      const row = db
        .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
        .get("task-1") as RawTaskListRow;
      expect(row.status).toBe("running");
    });

    it("deletes projection row when reducer returns null (task.archived)", () => {
      appendAndProject(db, makeTaskCreatedInput("task-1"));

      // Verify row exists
      let row = db
        .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
        .get("task-1");
      expect(row).toBeDefined();

      // Archive removes from task_list
      appendAndProject(db, {
        type: "task.archived",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1" },
      });

      row = db
        .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
        .get("task-1");
      expect(row).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Transaction rollback on reducer error
  // --------------------------------------------------------------------------

  describe("reducer-throws rollback", () => {
    it("rolls back both event and projection on reducer error", () => {
      // Register a projection that throws during reduce
      const throwingProjection: Projection<TaskListRow> = {
        ...taskListProjection,
        name: "task_detail" as ProjectionName,
        createSql: `
          CREATE TABLE IF NOT EXISTS proj_task_detail (
            task_id TEXT PRIMARY KEY,
            dummy   TEXT
          );
        `,
        reduce(_current, _event) {
          throw new Error("Reducer kaboom!");
        },
      };

      registerProjection(throwingProjection);
      db.exec(throwingProjection.createSql);

      // task.created subscribes to both task_list and task_detail
      expect(() =>
        appendAndProject(db, makeTaskCreatedInput("task-fail")),
      ).toThrow("Reducer kaboom!");

      // No event written
      const events = readEvents(db);
      expect(events).toHaveLength(0);

      // No projection row written
      const row = db
        .prepare("SELECT * FROM proj_task_list WHERE task_id = ?")
        .get("task-fail");
      expect(row).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // event.committed emitter
  // --------------------------------------------------------------------------

  describe("event.committed emitter", () => {
    it("emits committed events only after the transaction succeeds", () => {
      const received: AnyEvent[] = [];
      eventBus.on("event.committed", (event: AnyEvent) => {
        // Verify the event is actually in the DB at this point
        const events = readEvents(db, { after: "" });
        const found = events.find((e) => e.id === event.id);
        expect(found).toBeDefined();
        received.push(event);
      });

      appendAndProject(db, makeTaskCreatedInput("task-1"));
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("task.created");
    });

    it("does NOT emit when the transaction rolls back", () => {
      const received: AnyEvent[] = [];
      eventBus.on("event.committed", (event: AnyEvent) => {
        received.push(event);
      });

      // Register a throwing projection
      const throwingProjection: Projection<TaskListRow> = {
        ...taskListProjection,
        name: "task_detail" as ProjectionName,
        createSql:
          "CREATE TABLE IF NOT EXISTS proj_task_detail (task_id TEXT PRIMARY KEY, dummy TEXT);",
        reduce() {
          throw new Error("boom");
        },
      };
      registerProjection(throwingProjection);
      db.exec(throwingProjection.createSql);

      try {
        appendAndProject(db, makeTaskCreatedInput("task-fail"));
      } catch {
        // expected
      }

      expect(received).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // rebuildProjection
  // --------------------------------------------------------------------------

  describe("rebuildProjection", () => {
    it("rebuilds from the event log and produces identical state", () => {
      // Build up state through appendAndProject
      appendAndProject(db, makeTaskCreatedInput("task-1", "Task One"));
      appendAndProject(db, makeTaskCreatedInput("task-2", "Task Two"));
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1", from: "queued", to: "running" },
      });

      // Snapshot the current state
      const beforeRows = db
        .prepare("SELECT * FROM proj_task_list ORDER BY task_id")
        .all() as RawTaskListRow[];

      // Rebuild
      rebuildProjection(db, "task_list");

      // Verify identical state
      const afterRows = db
        .prepare("SELECT * FROM proj_task_list ORDER BY task_id")
        .all() as RawTaskListRow[];

      expect(afterRows).toHaveLength(beforeRows.length);
      for (let i = 0; i < beforeRows.length; i++) {
        expect(afterRows[i].task_id).toBe(beforeRows[i].task_id);
        expect(afterRows[i].title).toBe(beforeRows[i].title);
        expect(afterRows[i].status).toBe(beforeRows[i].status);
        expect(afterRows[i].attempt_count).toBe(beforeRows[i].attempt_count);
      }
    });

    it("handles rebuild with archived (deleted) rows correctly", () => {
      appendAndProject(db, makeTaskCreatedInput("task-1"));
      appendAndProject(db, {
        type: "task.archived",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1" },
      });

      // Verify row was deleted by appendAndProject before rebuild
      const beforeRebuild = db
        .prepare("SELECT * FROM proj_task_list")
        .all();
      expect(beforeRebuild).toHaveLength(0);

      // Check events stored
      rebuildProjection(db, "task_list");

      const rows = db.prepare("SELECT * FROM proj_task_list").all();
      expect(rows).toHaveLength(0);
    });

    it("throws for an unregistered projection name", () => {
      expect(() =>
        rebuildProjection(db, "nonexistent" as ProjectionName),
      ).toThrow("No projection registered");
    });

    it("is deterministic across multiple runs", () => {
      appendAndProject(db, makeTaskCreatedInput("task-1"));
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: "task-1",
        actor: testActor,
        payload: { task_id: "task-1", from: "queued", to: "running" },
      });

      rebuildProjection(db, "task_list");
      const first = db
        .prepare("SELECT * FROM proj_task_list")
        .all() as RawTaskListRow[];

      rebuildProjection(db, "task_list");
      const second = db
        .prepare("SELECT * FROM proj_task_list")
        .all() as RawTaskListRow[];

      expect(first).toEqual(second);
    });
  });

  // --------------------------------------------------------------------------
  // Registry
  // --------------------------------------------------------------------------

  describe("registry", () => {
    it("initProjections creates tables for all registered projections", () => {
      // proj_task_list should already exist from beforeEach
      const info = db
        .prepare("PRAGMA table_info(proj_task_list)")
        .all() as Array<{ name: string }>;
      expect(info.length).toBeGreaterThan(0);
    });

    it("skips unregistered projections silently during append", () => {
      // task.created subscribes to task_list and task_detail
      // task_detail is not registered, so it should be skipped
      const reg = getRegisteredProjections();
      reg.delete("task_detail" as ProjectionName);

      expect(() =>
        appendAndProject(db, makeTaskCreatedInput("task-1")),
      ).not.toThrow();
    });
  });
});
