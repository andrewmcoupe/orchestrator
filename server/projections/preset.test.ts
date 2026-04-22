import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import {
  appendAndProject,
  initProjections,
  rebuildProjection,
} from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import type { PresetRow } from "@shared/projections.js";

// Register all projections including preset
import "./register.js";

// ============================================================================
// Fixtures
// ============================================================================

const actor: Actor = { kind: "system", component: "scheduler" };

const SAMPLE_CONFIG = {
  phases: [
    {
      name: "implementer",
      enabled: true,
      transport: "claude-code",
      model: "claude-sonnet-4-6",
      prompt_version_id: "default",
      transport_options: { kind: "cli", bare: true, max_turns: 10, max_budget_usd: 1, permission_mode: "acceptEdits" },
      context_policy: { symbol_graph_depth: 2, include_tests: true, include_similar_patterns: false, token_budget: 8000 },
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

function getRow(db: Database.Database, presetId: string): PresetRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_preset WHERE preset_id = ?")
    .get(presetId) as
    | (Omit<PresetRow, "config"> & { config_json: string })
    | undefined;
  if (!raw) return null;
  const { config_json, ...rest } = raw;
  return { ...rest, config: JSON.parse(config_json) };
}

// ============================================================================
// Tests
// ============================================================================

describe("preset projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("proj_preset table is created on first run", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proj_preset'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("proj_preset");
  });

  it("creates a row on preset.created", () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-my-preset",
      actor,
      payload: {
        preset_id: "preset-my-preset",
        name: "My Preset",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    const row = getRow(db, "preset-my-preset");
    expect(row).not.toBeNull();
    expect(row!.preset_id).toBe("preset-my-preset");
    expect(row!.name).toBe("My Preset");
    expect(row!.task_class).toBe("new-feature");
    expect(row!.config.phases).toHaveLength(1);
    expect(row!.config.phases[0].name).toBe("implementer");
    expect(row!.updated_at).toBeTruthy();
  });

  it("preset.created is idempotent (second event does not overwrite)", () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-my-preset",
      actor,
      payload: {
        preset_id: "preset-my-preset",
        name: "My Preset",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    const firstTs = getRow(db, "preset-my-preset")!.updated_at;

    // Second create should not change the row (reduce returns current)
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-my-preset",
      actor,
      payload: {
        preset_id: "preset-my-preset",
        name: "My Preset Renamed",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    const row = getRow(db, "preset-my-preset");
    expect(row!.name).toBe("My Preset"); // name unchanged
    expect(row!.updated_at).toBe(firstTs);
  });

  it("updates config on preset.updated", () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-my-preset",
      actor,
      payload: {
        preset_id: "preset-my-preset",
        name: "My Preset",
        task_class: "new-feature",
        config: SAMPLE_CONFIG as never,
      },
    });

    const updatedGates = [
      { name: "typecheck", command: "pnpm typecheck", required: true, timeout_seconds: 60, on_fail: "retry" },
    ];

    appendAndProject(db, {
      type: "preset.updated",
      aggregate_type: "preset",
      aggregate_id: "preset-my-preset",
      actor,
      payload: {
        preset_id: "preset-my-preset",
        config_diff: { gates: updatedGates } as never,
      },
    });

    const row = getRow(db, "preset-my-preset");
    expect(row!.config.gates).toHaveLength(1);
    expect(row!.config.gates[0].name).toBe("typecheck");
    // phases should still be intact (shallow merge keeps them)
    expect(row!.config.phases).toHaveLength(1);
  });

  it("removes row on preset.deleted", () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-to-delete",
      actor,
      payload: {
        preset_id: "preset-to-delete",
        name: "Temp Preset",
        task_class: "bugfix",
        config: SAMPLE_CONFIG as never,
      },
    });

    expect(getRow(db, "preset-to-delete")).not.toBeNull();

    appendAndProject(db, {
      type: "preset.deleted",
      aggregate_type: "preset",
      aggregate_id: "preset-to-delete",
      actor,
      payload: { preset_id: "preset-to-delete" },
    });

    expect(getRow(db, "preset-to-delete")).toBeNull();
    // But the event should still be in the event log
    const events = db
      .prepare("SELECT type FROM events WHERE aggregate_id = 'preset-to-delete'")
      .all() as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain("preset.deleted");
  });

  it("rebuild produces identical state", () => {
    appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: "preset-rebuild-test",
      actor,
      payload: {
        preset_id: "preset-rebuild-test",
        name: "Rebuild Test",
        task_class: "refactor",
        config: SAMPLE_CONFIG as never,
      },
    });

    appendAndProject(db, {
      type: "preset.updated",
      aggregate_type: "preset",
      aggregate_id: "preset-rebuild-test",
      actor,
      payload: {
        preset_id: "preset-rebuild-test",
        config_diff: { gates: [{ name: "typecheck", command: "pnpm typecheck", required: true, timeout_seconds: 60, on_fail: "retry" }] } as never,
      },
    });

    const before = getRow(db, "preset-rebuild-test");
    rebuildProjection(db, "preset");
    const after = getRow(db, "preset-rebuild-test");

    expect(after).toEqual(before);
  });

  it("multiple presets coexist independently", () => {
    for (const id of ["preset-a", "preset-b", "preset-c"]) {
      appendAndProject(db, {
        type: "preset.created",
        aggregate_type: "preset",
        aggregate_id: id,
        actor,
        payload: {
          preset_id: id,
          name: `Preset ${id}`,
          task_class: "new-feature",
          config: SAMPLE_CONFIG as never,
        },
      });
    }

    const rows = db
      .prepare("SELECT preset_id FROM proj_preset ORDER BY preset_id")
      .all() as Array<{ preset_id: string }>;
    expect(rows.map((r) => r.preset_id)).toEqual(["preset-a", "preset-b", "preset-c"]);
  });
});
