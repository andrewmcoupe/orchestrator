/**
 * Tests for unified prompt seeding from bundled prompts/*.md files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./eventStore.js";
import { initProjections, eventBus } from "./projectionRunner.js";
import "./projections/register.js";
import { seedPrompts, discoverPromptFiles, parsePromptFilename } from "./seedPrompts.js";
import { createBlobStore } from "./blobStore.js";

// ============================================================================
// Helpers
// ============================================================================

const tmpBase = path.join(
  process.env.TMPDIR || "/tmp",
  "orchestrator-seed-prompts-test",
);

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  initProjections(db);
  return db;
}

function countPromptEvents(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM events WHERE type = 'prompt_version.created'",
      )
      .get() as { n: number }
  ).n;
}

function getPromptEvent(
  db: Database.Database,
  aggregateId: string,
): { payload_json: string } | undefined {
  return db
    .prepare(
      "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'prompt_version.created'",
    )
    .get(aggregateId) as { payload_json: string } | undefined;
}

// ============================================================================
// parsePromptFilename
// ============================================================================

describe("parsePromptFilename", () => {
  it("parses standard prompt filename", () => {
    const result = parsePromptFilename("ingest-v1.md");
    expect(result).toEqual({
      id: "pv-ingest-v1",
      name: "ingest-v1",
      phaseClass: "ingest",
    });
  });

  it("parses multi-word phase class", () => {
    const result = parsePromptFilename("test-author-v2.md");
    expect(result).toEqual({
      id: "pv-test-author-v2",
      name: "test-author-v2",
      phaseClass: "test-author",
    });
  });

  it("returns null for non-matching filenames", () => {
    expect(parsePromptFilename("README.md")).toBeNull();
    expect(parsePromptFilename("notes.txt")).toBeNull();
  });
});

// ============================================================================
// discoverPromptFiles
// ============================================================================

describe("discoverPromptFiles", () => {
  beforeEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("discovers .md files matching the naming convention", () => {
    fs.writeFileSync(path.join(tmpBase, "ingest-v1.md"), "prompt content");
    fs.writeFileSync(path.join(tmpBase, "auditor-v1.md"), "auditor content");
    fs.writeFileSync(path.join(tmpBase, "README.md"), "not a prompt");

    const files = discoverPromptFiles(tmpBase);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name)).toContain("ingest-v1");
    expect(files.map((f) => f.name)).toContain("auditor-v1");
  });

  it("returns empty array if directory has no matching files", () => {
    fs.writeFileSync(path.join(tmpBase, "README.md"), "not a prompt");
    const files = discoverPromptFiles(tmpBase);
    expect(files).toHaveLength(0);
  });
});

// ============================================================================
// seedPrompts
// ============================================================================

describe("seedPrompts", () => {
  let db: Database.Database;
  let promptsDir: string;
  let blobsDir: string;

  beforeEach(() => {
    db = setupDb();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });

    promptsDir = path.join(tmpBase, "prompts");
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(path.join(promptsDir, "ingest-v1.md"), "ingest template");
    fs.writeFileSync(path.join(promptsDir, "auditor-v1.md"), "auditor template");

    blobsDir = path.join(tmpBase, "blobs");
    fs.mkdirSync(blobsDir);
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("seeds prompt events when DB is empty", () => {
    const blobStore = createBlobStore(blobsDir);
    seedPrompts(db, promptsDir, blobStore);

    expect(countPromptEvents(db)).toBe(2);
  });

  it("creates correct event payloads", () => {
    const blobStore = createBlobStore(blobsDir);
    seedPrompts(db, promptsDir, blobStore);

    const row = getPromptEvent(db, "pv-ingest-v1");
    expect(row).toBeDefined();

    const payload = JSON.parse(row!.payload_json);
    expect(payload.prompt_version_id).toBe("pv-ingest-v1");
    expect(payload.name).toBe("ingest-v1");
    expect(payload.phase_class).toBe("ingest");
    expect(payload.template).toBe("ingest template");
    expect(typeof payload.template_hash).toBe("string");
  });

  it("stores templates in blob store", () => {
    const blobStore = createBlobStore(blobsDir);
    seedPrompts(db, promptsDir, blobStore);

    const row = getPromptEvent(db, "pv-ingest-v1");
    const payload = JSON.parse(row!.payload_json);
    expect(blobStore.hasBlob(payload.template_hash)).toBe(true);
    expect(blobStore.getBlob(payload.template_hash)!.toString()).toBe(
      "ingest template",
    );
  });

  it("is idempotent — calling twice creates events only once", () => {
    const blobStore = createBlobStore(blobsDir);
    seedPrompts(db, promptsDir, blobStore);
    seedPrompts(db, promptsDir, blobStore);

    expect(countPromptEvents(db)).toBe(2);
  });

  it("seeds new prompt files while skipping already-seeded ones", () => {
    const blobStore = createBlobStore(blobsDir);
    // Seed once
    seedPrompts(db, promptsDir, blobStore);
    expect(countPromptEvents(db)).toBe(2);

    // Add a new prompt file
    fs.writeFileSync(
      path.join(promptsDir, "reviewer-v1.md"),
      "reviewer template",
    );

    // Seed again — should pick up the new file but not re-create existing ones
    seedPrompts(db, promptsDir, blobStore);

    expect(countPromptEvents(db)).toBe(3);
    expect(getPromptEvent(db, "pv-reviewer-v1")).toBeDefined();
  });

  it("populates the prompt library projection", () => {
    const blobStore = createBlobStore(blobsDir);
    seedPrompts(db, promptsDir, blobStore);

    const rows = db
      .prepare("SELECT * FROM proj_prompt_library")
      .all() as { prompt_version_id: string; name: string }[];

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toContain("ingest-v1");
    expect(rows.map((r) => r.name)).toContain("auditor-v1");
  });
});
