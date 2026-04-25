/**
 * Graph layout storage — singleton row storing the computed layout blob.
 *
 * This is NOT a standard event-reduced projection. The layout is recomputed
 * from the full task graph (via the elkjs layout engine) and atomically
 * replaced each time the graph changes.
 */

import type Database from "better-sqlite3";

// ============================================================================
// Types
// ============================================================================

export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutMeta {
  critical_path: string[];
  direction: string;
}

export interface GraphLayoutBlob {
  nodes: Record<string, NodePosition>;
  edges: LayoutEdge[];
  meta: LayoutMeta;
}

// ============================================================================
// Table DDL
// ============================================================================

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS proj_graph_layout (
    id          TEXT PRIMARY KEY DEFAULT 'singleton',
    layout_json TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
`;

/**
 * Create the proj_graph_layout table. Idempotent — safe to call at boot.
 */
export function createGraphLayoutTable(db: Database.Database): void {
  db.exec(CREATE_SQL);
}

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Read the current graph layout blob. Returns null if no layout has been computed yet.
 */
export function readGraphLayout(db: Database.Database): GraphLayoutBlob | null {
  const row = db
    .prepare("SELECT layout_json FROM proj_graph_layout WHERE id = 'singleton'")
    .get() as { layout_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.layout_json) as GraphLayoutBlob;
}

/**
 * Atomically replace the graph layout blob.
 */
export function writeGraphLayout(
  db: Database.Database,
  layout: GraphLayoutBlob,
): void {
  db.prepare(
    `INSERT INTO proj_graph_layout (id, layout_json, updated_at)
     VALUES ('singleton', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       layout_json = excluded.layout_json,
       updated_at  = excluded.updated_at`,
  ).run(JSON.stringify(layout), new Date().toISOString());
}
