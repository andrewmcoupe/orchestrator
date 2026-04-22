/**
 * SQLite database singleton via better-sqlite3.
 *
 * Uses WAL mode for concurrent reads during writes. The DB file lives at
 * orchestrator/.data/events.db — the .data/ directory is gitignored.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let instance: Database.Database | null = null;

/**
 * Returns the singleton database connection.
 * Accepts an optional path override for testing (in-memory or temp file).
 */
export function getDb(dbPath?: string): Database.Database {
  if (instance) return instance;

  const resolvedPath =
    dbPath ?? path.resolve(import.meta.dirname, "..", ".data", "events.db");

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  instance = db;
  return db;
}

/**
 * Creates a fresh database connection (not the singleton).
 * Used for tests that need isolated databases.
 */
export function createDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return db;
}

/** Close and reset the singleton (for tests / shutdown). */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
