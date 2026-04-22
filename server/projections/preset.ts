/**
 * Preset projection — one row per preset, powering the config modal dropdown
 * and the Settings → Presets view.
 *
 * preset.created → upserts a new row (idempotent)
 * preset.updated → shallow-merges config_diff onto the existing config
 * preset.deleted → deletes the row (event log retains history)
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reducePreset, type PresetRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (config stored as JSON text)
// ============================================================================

type RawPresetRow = Omit<PresetRow, "config"> & { config_json: string };

function rowFromRaw(raw: RawPresetRow): PresetRow {
  const { config_json, ...rest } = raw;
  return { ...rest, config: JSON.parse(config_json) };
}

// ============================================================================
// Helpers
// ============================================================================

function extractPresetId(event: AnyEvent): string | null {
  const p = event.payload as unknown as Record<string, unknown>;
  return typeof p.preset_id === "string" ? p.preset_id : null;
}

// ============================================================================
// Projection definition
// ============================================================================

export const presetProjection: Projection<PresetRow> = {
  name: "preset",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_preset (
      preset_id   TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      task_class  TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_preset_task_class ON proj_preset(task_class);
  `,

  read(db: Database.Database, event: AnyEvent): PresetRow | null {
    const presetId = extractPresetId(event);
    if (!presetId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_preset WHERE preset_id = ?")
      .get(presetId) as RawPresetRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reducePreset,

  write(db: Database.Database, next: PresetRow | null, id: string): void {
    if (!next) {
      // preset.deleted — remove the row; id = event.aggregate_id = preset_id
      db.prepare("DELETE FROM proj_preset WHERE preset_id = ?").run(id);
      return;
    }

    db.prepare(
      `INSERT INTO proj_preset (preset_id, name, task_class, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(preset_id) DO UPDATE SET
         name        = excluded.name,
         task_class  = excluded.task_class,
         config_json = excluded.config_json,
         updated_at  = excluded.updated_at`,
    ).run(
      next.preset_id,
      next.name,
      next.task_class,
      JSON.stringify(next.config),
      next.updated_at,
    );
  },
};

// Self-register on import
registerProjection(presetProjection);
