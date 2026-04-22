/**
 * Settings projection — single row storing global defaults.
 * settings_id is always "global".
 */
import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceSettings, type GlobalSettingsRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

export const settingsProjection: Projection<GlobalSettingsRow> = {
  name: "settings",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_settings (
      settings_id                    TEXT PRIMARY KEY,
      default_preset_id              TEXT,
      auto_delete_worktree_on_merge  INTEGER NOT NULL DEFAULT 0,
      auto_pause_on_external_fs_change INTEGER NOT NULL DEFAULT 0,
      auto_merge_enabled             INTEGER NOT NULL DEFAULT 0,
      updated_at                     TEXT NOT NULL
    );
  `,

  read(db: Database.Database, _event: AnyEvent): GlobalSettingsRow | null {
    const row = db
      .prepare("SELECT * FROM proj_settings WHERE settings_id = 'global'")
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      settings_id: "global",
      default_preset_id: (row.default_preset_id as string | null) ?? null,
      auto_delete_worktree_on_merge: Boolean(row.auto_delete_worktree_on_merge),
      auto_pause_on_external_fs_change: Boolean(row.auto_pause_on_external_fs_change),
      auto_merge_enabled: Boolean(row.auto_merge_enabled),
      updated_at: row.updated_at as string,
    };
  },

  reduce: reduceSettings,

  write(db: Database.Database, next: GlobalSettingsRow | null): void {
    if (!next) return; // settings row is never deleted
    db.prepare(`
      INSERT INTO proj_settings (settings_id, default_preset_id, auto_delete_worktree_on_merge, auto_pause_on_external_fs_change, auto_merge_enabled, updated_at)
      VALUES ('global', ?, ?, ?, ?, ?)
      ON CONFLICT(settings_id) DO UPDATE SET
        default_preset_id              = excluded.default_preset_id,
        auto_delete_worktree_on_merge  = excluded.auto_delete_worktree_on_merge,
        auto_pause_on_external_fs_change = excluded.auto_pause_on_external_fs_change,
        auto_merge_enabled             = excluded.auto_merge_enabled,
        updated_at                     = excluded.updated_at
    `).run(
      next.default_preset_id ?? null,
      next.auto_delete_worktree_on_merge ? 1 : 0,
      next.auto_pause_on_external_fs_change ? 1 : 0,
      next.auto_merge_enabled ? 1 : 0,
      next.updated_at,
    );
  },
};

registerProjection(settingsProjection);
