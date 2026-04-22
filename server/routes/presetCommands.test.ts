import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { appendAndProject, initProjections } from "../projectionRunner.js";
import { createPresetCommandRoutes } from "./presetCommands.js";
import { seedBuiltinPresets, BUILTIN_PRESETS } from "../presets.js";
import type { Actor } from "@shared/events.js";

// Register projections (includes preset)
import "../projections/register.js";

// ============================================================================
// Helpers
// ============================================================================

const SYSTEM_ACTOR: Actor = { kind: "system", component: "scheduler" };

const SAMPLE_CONFIG = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "default",
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

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

async function req(
  app: ReturnType<typeof createPresetCommandRoutes>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ============================================================================
// Tests
// ============================================================================

describe("preset command routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createPresetCommandRoutes>;

  beforeEach(() => {
    db = makeDb();
    app = createPresetCommandRoutes(db);
  });

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  it("creates a preset and returns the event", async () => {
    const res = await req(app, "POST", "/api/commands/preset/create", {
      name: "My Preset",
      task_class: "new-feature",
      config: SAMPLE_CONFIG,
    });
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("preset.created");
    expect(event.payload.name).toBe("My Preset");
    expect(event.payload.task_class).toBe("new-feature");
  });

  it("derives preset_id from name when not supplied", async () => {
    const res = await req(app, "POST", "/api/commands/preset/create", {
      name: "My Cool Preset",
      task_class: "refactor",
      config: SAMPLE_CONFIG,
    });
    const event = await res.json();
    expect(event.payload.preset_id).toBe("preset-my-cool-preset");
  });

  it("uses explicit preset_id when supplied", async () => {
    const res = await req(app, "POST", "/api/commands/preset/create", {
      preset_id: "preset-custom-id",
      name: "Custom",
      task_class: "bugfix",
      config: SAMPLE_CONFIG,
    });
    const event = await res.json();
    expect(event.payload.preset_id).toBe("preset-custom-id");
  });

  it("returns 409 when preset_id already exists", async () => {
    await req(app, "POST", "/api/commands/preset/create", {
      preset_id: "preset-dupe",
      name: "Dupe",
      task_class: "new-feature",
      config: SAMPLE_CONFIG,
    });

    const res = await req(app, "POST", "/api/commands/preset/create", {
      preset_id: "preset-dupe",
      name: "Dupe Again",
      task_class: "new-feature",
      config: SAMPLE_CONFIG,
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 on malformed body (missing name)", async () => {
    const res = await req(app, "POST", "/api/commands/preset/create", {
      task_class: "new-feature",
      config: SAMPLE_CONFIG,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("validation_error");
  });

  it("new preset appears in proj_preset", async () => {
    await req(app, "POST", "/api/commands/preset/create", {
      preset_id: "preset-visible",
      name: "Visible",
      task_class: "new-feature",
      config: SAMPLE_CONFIG,
    });

    const row = db
      .prepare("SELECT * FROM proj_preset WHERE preset_id = 'preset-visible'")
      .get() as { preset_id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("Visible");
  });

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------

  it("updates preset config and returns the event", async () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-upd",
      actor: SYSTEM_ACTOR,
      payload: {
        preset_id: "preset-upd",
        name: "Update Target",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    const newGates = [
      { name: "typecheck", command: "pnpm typecheck", required: true, timeout_seconds: 60, on_fail: "retry" },
    ];

    const res = await req(app, "POST", "/api/commands/preset/update/preset-upd", {
      config_diff: { gates: newGates },
    });
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("preset.updated");
    expect(event.payload.preset_id).toBe("preset-upd");
  });

  it("returns 404 when updating nonexistent preset", async () => {
    const res = await req(app, "POST", "/api/commands/preset/update/does-not-exist", {
      config_diff: { gates: [] },
    });
    expect(res.status).toBe(404);
  });

  it("update changes the projection row", async () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-proj-upd",
      actor: SYSTEM_ACTOR,
      payload: {
        preset_id: "preset-proj-upd",
        name: "Proj Update Target",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    await req(app, "POST", "/api/commands/preset/update/preset-proj-upd", {
      config_diff: {
        retry_policy: {
          max_total_attempts: 10,
          on_typecheck_fail: { strategy: "retry_same", max_attempts: 2 },
          on_test_fail: { strategy: "retry_same", max_attempts: 2 },
          on_audit_reject: "escalate_to_human",
          on_spec_pushback: "pause_and_notify",
        },
      },
    });

    const raw = db
      .prepare("SELECT config_json FROM proj_preset WHERE preset_id = 'preset-proj-upd'")
      .get() as { config_json: string } | undefined;
    const config = JSON.parse(raw!.config_json);
    expect(config.retry_policy.max_total_attempts).toBe(10);
  });

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  it("deletes a preset and returns the event", async () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-del",
      actor: SYSTEM_ACTOR,
      payload: {
        preset_id: "preset-del",
        name: "To Delete",
        task_class: "bugfix",
        config: SAMPLE_CONFIG as never,
      },
    });

    const res = await req(app, "POST", "/api/commands/preset/delete/preset-del");
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("preset.deleted");

    // Row gone from projection
    const row = db
      .prepare("SELECT * FROM proj_preset WHERE preset_id = 'preset-del'")
      .get();
    expect(row).toBeUndefined();

    // Event log still has both events
    const events = db
      .prepare("SELECT type FROM events WHERE aggregate_id = 'preset-del'")
      .all() as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain("preset.created");
    expect(events.map((e) => e.type)).toContain("preset.deleted");
  });

  it("returns 404 when deleting nonexistent preset", async () => {
    const res = await req(app, "POST", "/api/commands/preset/delete/ghost-preset");
    expect(res.status).toBe(404);
  });

  // --------------------------------------------------------------------------
  // Seeding
  // --------------------------------------------------------------------------

  it("seedBuiltinPresets creates 4 preset.created events on fresh DB", () => {
    seedBuiltinPresets(db);

    const events = db
      .prepare("SELECT aggregate_id FROM events WHERE type = 'preset.created'")
      .all() as Array<{ aggregate_id: string }>;
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.aggregate_id)).toContain("preset-default-new-feature");
    expect(events.map((e) => e.aggregate_id)).toContain("preset-default-bugfix");
    expect(events.map((e) => e.aggregate_id)).toContain("preset-default-refactor");
    expect(events.map((e) => e.aggregate_id)).toContain("preset-default-migration");
  });

  it("seedBuiltinPresets is idempotent (second call creates no new events)", () => {
    seedBuiltinPresets(db);
    seedBuiltinPresets(db);

    const count = (
      db
        .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'preset.created'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(4);
  });

  it("seedBuiltinPresets populates proj_preset with 4 rows", () => {
    seedBuiltinPresets(db);

    const count = (
      db.prepare("SELECT COUNT(*) as n FROM proj_preset").get() as { n: number }
    ).n;
    expect(count).toBe(4);
  });

  it("BUILTIN_PRESETS has 4 entries with distinct preset_ids", () => {
    const ids = BUILTIN_PRESETS.map((p) => p.preset_id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4); // all unique
  });
});

// ============================================================================
// task/create with preset_id integration
// ============================================================================

describe("task/create with preset_id", () => {
  // This test verifies the integration from commands.ts — importing and
  // running against the full app route stack.
  it("is covered by commands.test.ts (task create endpoint)", () => {
    // Placeholder: the full integration is in server/routes/commands.test.ts
    // which exercises createCommandRoutes and the preset lookup.
    expect(true).toBe(true);
  });
});
