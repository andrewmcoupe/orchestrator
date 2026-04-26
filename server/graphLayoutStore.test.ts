import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  createGraphLayoutTable,
  writeGraphLayout,
  readGraphLayout,
  type GraphLayoutBlob,
} from "./graphLayoutStore.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  createGraphLayoutTable(db);
  return db;
}

const SAMPLE_LAYOUT: GraphLayoutBlob = {
  nodes: {
    "task-1": { x: 0, y: 0, width: 200, height: 72 },
    "task-2": { x: 0, y: 132, width: 200, height: 72 },
  },
  edges: [{ source: "task-1", target: "task-2" }],
  meta: { critical_path: ["task-1", "task-2"], direction: "DOWN" },
};

describe("graphLayoutStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns null when no layout has been written", () => {
    expect(readGraphLayout(db)).toBeNull();
  });

  it("writes and reads a layout blob", () => {
    writeGraphLayout(db, SAMPLE_LAYOUT);
    const result = readGraphLayout(db);
    expect(result).toEqual(SAMPLE_LAYOUT);
  });

  it("atomically replaces the layout on subsequent writes", () => {
    writeGraphLayout(db, SAMPLE_LAYOUT);

    const updated: GraphLayoutBlob = {
      nodes: {
        "task-3": { x: 10, y: 20, width: 200, height: 72 },
      },
      edges: [],
      meta: { critical_path: ["task-3"], direction: "DOWN" },
    };
    writeGraphLayout(db, updated);

    const result = readGraphLayout(db);
    expect(result).toEqual(updated);

    // Only one row in the table
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM proj_graph_layout")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("createGraphLayoutTable is idempotent", () => {
    // Should not throw when called again
    createGraphLayoutTable(db);
    createGraphLayoutTable(db);

    writeGraphLayout(db, SAMPLE_LAYOUT);
    expect(readGraphLayout(db)).toEqual(SAMPLE_LAYOUT);
  });
});
