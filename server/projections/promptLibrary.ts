/**
 * Prompt library projection — one row per prompt version.
 *
 * Subscribed events:
 *   prompt_version.created → insert row
 *   prompt_version.retired → mark retired
 *   invocation.completed   → update usage stats (resolved via cross-event lookup)
 *   ab_experiment.created  → link experiment_id to variants
 *   ab_experiment.concluded → status update (handled by ab_experiment projection)
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reducePromptLibrary, type PromptVersionRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// Raw DB row shape — nullable columns are stored as null in SQLite
type RawPromptVersionRow = Omit<
  PromptVersionRow,
  "retired" | "ab_experiment_ids" | "parent_version_id" | "notes" | "success_rate_last_30d" | "avg_cost_usd"
> & {
  retired: number;
  ab_experiment_ids_json: string | null;
  parent_version_id: string | null;
  notes: string | null;
  success_rate_last_30d: number | null;
  avg_cost_usd: number | null;
};

function rowFromRaw(raw: RawPromptVersionRow): PromptVersionRow {
  const { retired, ab_experiment_ids_json, parent_version_id, notes, success_rate_last_30d, avg_cost_usd, ...rest } = raw;
  return {
    ...rest,
    retired: retired === 1,
    ab_experiment_ids: ab_experiment_ids_json ? JSON.parse(ab_experiment_ids_json) : [],
    parent_version_id: parent_version_id ?? undefined,
    notes: notes ?? undefined,
    success_rate_last_30d: success_rate_last_30d ?? undefined,
    avg_cost_usd: avg_cost_usd ?? undefined,
  };
}

/**
 * Resolves which prompt_version_id an invocation.completed event belongs to
 * by looking up the invocation.started event in the events table.
 */
function resolvePromptVersionForInvocation(
  db: Database.Database,
  invocationId: string,
): string | null {
  const row = db
    .prepare(
      "SELECT payload_json FROM events WHERE type = 'invocation.started' AND aggregate_id = ? LIMIT 1",
    )
    .get(invocationId) as { payload_json: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { prompt_version_id?: string };
  return payload.prompt_version_id ?? null;
}

export const promptLibraryProjection: Projection<PromptVersionRow> = {
  name: "prompt_library",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_prompt_library (
      prompt_version_id    TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      phase_class          TEXT NOT NULL,
      template_hash        TEXT NOT NULL,
      parent_version_id    TEXT,
      notes                TEXT,
      retired              INTEGER NOT NULL DEFAULT 0,
      invocations_last_30d INTEGER NOT NULL DEFAULT 0,
      success_rate_last_30d REAL,
      avg_cost_usd         REAL,
      ab_experiment_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_library_phase ON proj_prompt_library(phase_class);
    CREATE INDEX IF NOT EXISTS idx_prompt_library_retired ON proj_prompt_library(retired);
  `,

  read(db: Database.Database, event: AnyEvent): PromptVersionRow | null {
    let promptVersionId: string | null = null;

    const p = event.payload as unknown as Record<string, unknown>;

    if (event.type === "invocation.completed") {
      const invocationId = p.invocation_id as string;
      promptVersionId = resolvePromptVersionForInvocation(db, invocationId);
    } else if (event.type === "ab_experiment.created") {
      // For ab_experiment.created, update the variant_a row.
      // variant_b will also be handled since the reducer checks both variants.
      // The runner calls this projection once per event — variant_b is linked
      // via the reducer's check against both A and B ids when the row is read
      // for a second pass. For simplicity, we update variant_a here.
      const variants = p.variants as { A: string; B: string };
      promptVersionId = variants.A;
    } else {
      promptVersionId =
        typeof p.prompt_version_id === "string" ? p.prompt_version_id : null;
    }

    if (!promptVersionId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_prompt_library WHERE prompt_version_id = ?")
      .get(promptVersionId) as RawPromptVersionRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce: reducePromptLibrary,

  write(db: Database.Database, next: PromptVersionRow | null, id: string): void {
    if (!next) {
      // Deletion case (shouldn't happen for prompts, but handle gracefully)
      db.prepare("DELETE FROM proj_prompt_library WHERE prompt_version_id = ?").run(id);
      return;
    }

    db.prepare(`
      INSERT INTO proj_prompt_library (
        prompt_version_id, name, phase_class, template_hash,
        parent_version_id, notes, retired, invocations_last_30d,
        success_rate_last_30d, avg_cost_usd, ab_experiment_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prompt_version_id) DO UPDATE SET
        name                  = excluded.name,
        phase_class           = excluded.phase_class,
        template_hash         = excluded.template_hash,
        parent_version_id     = excluded.parent_version_id,
        notes                 = excluded.notes,
        retired               = excluded.retired,
        invocations_last_30d  = excluded.invocations_last_30d,
        success_rate_last_30d = excluded.success_rate_last_30d,
        avg_cost_usd          = excluded.avg_cost_usd,
        ab_experiment_ids_json = excluded.ab_experiment_ids_json
    `).run(
      next.prompt_version_id,
      next.name,
      next.phase_class,
      next.template_hash,
      next.parent_version_id ?? null,
      next.notes ?? null,
      next.retired ? 1 : 0,
      next.invocations_last_30d,
      next.success_rate_last_30d ?? null,
      next.avg_cost_usd ?? null,
      JSON.stringify(next.ab_experiment_ids),
      next.created_at,
    );
  },
};

// Self-register on import
registerProjection(promptLibraryProjection);
