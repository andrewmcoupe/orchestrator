/**
 * Tests for projection REST routes.
 *
 * Uses the Hono test client against an in-memory SQLite DB seeded
 * with events via appendAndProject.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createDb } from "../db.js";
import { runMigrations } from "../eventStore.js";
import { initProjections, appendAndProject } from "../projectionRunner.js";
import "../projections/register.js";
import { createProjectionRoutes } from "./projections.js";
import type { Actor, TaskConfig } from "@shared/events.js";
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

function setup(): { db: Database.Database; app: ReturnType<typeof createProjectionRoutes> } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-routes-"));
  const db = createDb(path.join(tmpDir, "test.db"));
  runMigrations(db);
  initProjections(db);
  const app = createProjectionRoutes(db);
  return { db, app };
}

function seedTask(db: Database.Database, taskId: string, opts: { title?: string } = {}) {
  appendAndProject(db, {
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: taskId,
    actor,
    payload: {
      task_id: taskId,
      title: opts.title ?? `Task ${taskId}`,
      preset_id: undefined,
      proposition_ids: [],
      config_snapshot: minimalConfig,
    },
  });
}

describe("GET /api/projections/task_list", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/task_list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns seeded tasks ordered by updated_at DESC", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001", { title: "First" });
    seedTask(db, "T-002", { title: "Second" });

    const res = await app.request("/api/projections/task_list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ task_id: string }>;
    expect(body).toHaveLength(2);
    // Most recent first
    expect(body[0].task_id).toBe("T-002");
    expect(body[1].task_id).toBe("T-001");
  });

  it("filters by prd_id via direct DB update", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");
    seedTask(db, "T-002");
    seedTask(db, "T-003");

    // Manually set prd_id (normally set by future ingestion events)
    db.prepare("UPDATE proj_task_list SET prd_id = ? WHERE task_id = ?").run("PRD-A", "T-001");
    db.prepare("UPDATE proj_task_list SET prd_id = ? WHERE task_id = ?").run("PRD-B", "T-002");
    db.prepare("UPDATE proj_task_list SET prd_id = ? WHERE task_id = ?").run("PRD-A", "T-003");

    const res = await app.request("/api/projections/task_list?prd_id=PRD-A");
    const body = (await res.json()) as Array<{ task_id: string }>;
    expect(body).toHaveLength(2);
    expect(body.every((r) => r.task_id === "T-001" || r.task_id === "T-003")).toBe(true);
  });

  it("filters by status", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");
    seedTask(db, "T-002");

    // Change T-001 to running via attempt.started
    appendAndProject(db, {
      type: "attempt.started",
      aggregate_type: "attempt",
      aggregate_id: "A-001",
      actor,
      correlation_id: "A-001",
      payload: {
        attempt_id: "A-001",
        task_id: "T-001",
        attempt_number: 1,
        config_snapshot: minimalConfig,
        triggered_by: "user_start",
      },
    });

    const res = await app.request("/api/projections/task_list?status=running");
    const body = (await res.json()) as Array<{ task_id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].task_id).toBe("T-001");
  });

  it("parses phase_models from JSON", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001");

    const res = await app.request("/api/projections/task_list");
    const body = (await res.json()) as Array<{ phase_models: Record<string, string> }>;
    expect(body[0].phase_models).toEqual({ implementer: "sonnet-4-6" });
  });
});

describe("GET /api/projections/task_detail/:task_id", () => {
  it("returns 404 for nonexistent task", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/task_detail/NOPE");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toBe("not_found");
    expect(body.detail).toContain("NOPE");
  });

  it("returns task detail with parsed JSON fields", async () => {
    const { db, app } = setup();
    seedTask(db, "T-001", { title: "My Task" });

    const res = await app.request("/api/projections/task_detail/T-001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_id).toBe("T-001");
    expect(body.title).toBe("My Task");
    expect(body.config.phases).toHaveLength(1);
    expect(body.preset_override_keys).toEqual([]);
    expect(body.proposition_ids).toEqual([]);
  });
});

describe("GET /api/projections/proposition", () => {
  it("returns empty array when projection table not created", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/proposition?prd_id=PRD-1");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/attempt/:attempt_id", () => {
  it("returns 404 for nonexistent attempt", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/attempt/NOPE");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toBe("not_found");
  });
});

describe("GET /api/projections/attempts", () => {
  it("returns empty array when no attempt table", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/attempts?task_id=T-001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/provider_health", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/provider_health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/prompt_library", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/prompt_library");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/ab_experiment", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/ab_experiment");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/cost_rollup", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/cost_rollup");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/projections/preset", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = setup();
    const res = await app.request("/api/projections/preset");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
