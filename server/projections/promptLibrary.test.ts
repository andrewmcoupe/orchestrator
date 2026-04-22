import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import {
  appendAndProject,
  initProjections,
  rebuildProjection,
} from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import type { PromptVersionRow } from "@shared/projections.js";

// Register all projections including promptLibrary
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

function getRow(db: Database.Database, promptVersionId: string): PromptVersionRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_prompt_library WHERE prompt_version_id = ?")
    .get(promptVersionId) as
    | (Omit<PromptVersionRow, "retired" | "ab_experiment_ids"> & {
        retired: number;
        ab_experiment_ids_json: string | null;
      })
    | undefined;
  if (!raw) return null;
  const { retired, ab_experiment_ids_json, ...rest } = raw;
  return {
    ...rest,
    retired: retired === 1,
    ab_experiment_ids: ab_experiment_ids_json
      ? JSON.parse(ab_experiment_ids_json)
      : [],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("prompt_library projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("proj_prompt_library table is created on first run", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proj_prompt_library'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("proj_prompt_library");
  });

  it("creates a row on prompt_version.created", () => {
    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-001",
      actor,
      payload: {
        prompt_version_id: "pv-001",
        name: "Implementer v1",
        phase_class: "implementer",
        template: "You are an implementer. Task: {{task}}",
        template_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
        parent_version_id: undefined,
        notes: "Initial version",
      },
    });

    const row = getRow(db, "pv-001");
    expect(row).not.toBeNull();
    expect(row!.prompt_version_id).toBe("pv-001");
    expect(row!.name).toBe("Implementer v1");
    expect(row!.phase_class).toBe("implementer");
    expect(row!.template_hash).toBe("abc123def456abc123def456abc123def456abc123def456abc123def456abc1");
    expect(row!.retired).toBe(false);
    expect(row!.invocations_last_30d).toBe(0);
    expect(row!.ab_experiment_ids).toEqual([]);
    expect(row!.notes).toBe("Initial version");
  });

  it("prompt_version.created is idempotent (second event is a no-op)", () => {
    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-idem",
      actor,
      payload: {
        prompt_version_id: "pv-idem",
        name: "Original Name",
        phase_class: "auditor",
        template: "template",
        template_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-idem",
      actor,
      payload: {
        prompt_version_id: "pv-idem",
        name: "Renamed",
        phase_class: "auditor",
        template: "template",
        template_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    const row = getRow(db, "pv-idem");
    // First write wins — name should be unchanged
    expect(row!.name).toBe("Original Name");
  });

  it("prompt_version.retired sets retired=true", () => {
    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-retire",
      actor,
      payload: {
        prompt_version_id: "pv-retire",
        name: "Retiring Soon",
        phase_class: "implementer",
        template: "old template",
        template_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    expect(getRow(db, "pv-retire")!.retired).toBe(false);

    appendAndProject(db, {
      type: "prompt_version.retired",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-retire",
      actor,
      payload: { prompt_version_id: "pv-retire", reason: "Replaced by v2" },
    });

    expect(getRow(db, "pv-retire")!.retired).toBe(true);
  });

  it("invocation.completed increments usage stats via invocation.started cross-lookup", () => {
    // First, create the prompt version
    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-stats",
      actor,
      payload: {
        prompt_version_id: "pv-stats",
        name: "Stats Test",
        phase_class: "implementer",
        template: "template",
        template_hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    });

    // Write an invocation.started event so the cross-lookup resolves
    appendAndProject(db, {
      type: "invocation.started",
      aggregate_type: "attempt",
      aggregate_id: "inv-001",
      actor,
      payload: {
        invocation_id: "inv-001",
        attempt_id: "attempt-001",
        phase_name: "implementer",
        transport: "claude-code",
        model: "claude-sonnet-4-6",
        prompt_version_id: "pv-stats",
        context_manifest_hash: "ctx-hash",
      },
    });

    // Now fire invocation.completed — should update pv-stats
    appendAndProject(db, {
      type: "invocation.completed",
      aggregate_type: "attempt",
      aggregate_id: "inv-001",
      actor,
      payload: {
        invocation_id: "inv-001",
        outcome: "success",
        tokens_in: 100,
        tokens_out: 200,
        cost_usd: 0.005,
        duration_ms: 1000,
        turns: 3,
      },
    });

    const row = getRow(db, "pv-stats");
    expect(row!.invocations_last_30d).toBe(1);
    expect(row!.success_rate_last_30d).toBeCloseTo(1.0);
    expect(row!.avg_cost_usd).toBeCloseTo(0.005);
  });

  it("rebuild produces identical state", () => {
    appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-rebuild",
      actor,
      payload: {
        prompt_version_id: "pv-rebuild",
        name: "Rebuild Test",
        phase_class: "auditor",
        template: "template content",
        template_hash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        notes: "For rebuild test",
      },
    });

    appendAndProject(db, {
      type: "prompt_version.retired",
      aggregate_type: "prompt_version",
      aggregate_id: "pv-rebuild",
      actor,
      payload: { prompt_version_id: "pv-rebuild" },
    });

    const before = getRow(db, "pv-rebuild");
    rebuildProjection(db, "prompt_library");
    const after = getRow(db, "pv-rebuild");

    expect(after).toEqual(before);
  });

  it("multiple prompt versions coexist independently", () => {
    for (const id of ["pv-a", "pv-b", "pv-c"]) {
      appendAndProject(db, {
        type: "prompt_version.created",
        aggregate_type: "prompt_version",
        aggregate_id: id,
        actor,
        payload: {
          prompt_version_id: id,
          name: `Prompt ${id}`,
          phase_class: "implementer",
          template: `template for ${id}`,
          template_hash: `${"e".repeat(63)}${id === "pv-a" ? "1" : id === "pv-b" ? "2" : "3"}`,
        },
      });
    }

    const rows = db
      .prepare(
        "SELECT prompt_version_id FROM proj_prompt_library ORDER BY prompt_version_id",
      )
      .all() as Array<{ prompt_version_id: string }>;
    expect(rows.map((r) => r.prompt_version_id)).toEqual(["pv-a", "pv-b", "pv-c"]);
  });
});
