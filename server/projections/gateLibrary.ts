/**
 * Gate library projection — one row per custom gate in the shared library.
 * Gates in config.yaml are not stored here; only gates added/updated via UI.
 */
import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceGateLibrary, type GateLibraryRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

function extractGateName(event: AnyEvent): string | null {
  const p = event.payload as unknown as Record<string, unknown>;
  if (typeof p.gate_name === "string") return p.gate_name;
  if (typeof p.gate === "object" && p.gate !== null) {
    const gate = p.gate as Record<string, unknown>;
    if (typeof gate.name === "string") return gate.name;
  }
  return null;
}

export const gateLibraryProjection: Projection<GateLibraryRow> = {
  name: "gate_library",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_gate_library (
      gate_name        TEXT PRIMARY KEY,
      command          TEXT NOT NULL,
      required         INTEGER NOT NULL DEFAULT 1,
      timeout_seconds  INTEGER NOT NULL DEFAULT 30,
      on_fail          TEXT NOT NULL DEFAULT 'fail_task',
      updated_at       TEXT NOT NULL
    );
  `,

  read(db: Database.Database, event: AnyEvent): GateLibraryRow | null {
    const name = extractGateName(event);
    if (!name) return null;
    const row = db
      .prepare("SELECT * FROM proj_gate_library WHERE gate_name = ?")
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      gate_name: row.gate_name as string,
      command: row.command as string,
      required: Boolean(row.required),
      timeout_seconds: row.timeout_seconds as number,
      on_fail: row.on_fail as GateLibraryRow["on_fail"],
      updated_at: row.updated_at as string,
    };
  },

  reduce: reduceGateLibrary,

  write(db: Database.Database, next: GateLibraryRow | null, id: string): void {
    if (!next) {
      // gate_library.gate_removed — id is aggregate_id = gate_name
      db.prepare("DELETE FROM proj_gate_library WHERE gate_name = ?").run(id);
      return;
    }
    db.prepare(`
      INSERT INTO proj_gate_library (gate_name, command, required, timeout_seconds, on_fail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gate_name) DO UPDATE SET
        command         = excluded.command,
        required        = excluded.required,
        timeout_seconds = excluded.timeout_seconds,
        on_fail         = excluded.on_fail,
        updated_at      = excluded.updated_at
    `).run(
      next.gate_name,
      next.command,
      next.required ? 1 : 0,
      next.timeout_seconds,
      next.on_fail,
      next.updated_at,
    );
  },
};

registerProjection(gateLibraryProjection);
