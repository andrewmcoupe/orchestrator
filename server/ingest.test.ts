/**
 * Tests for the PRD ingest pipeline.
 *
 * Uses an injectable Fetcher to avoid real HTTP calls. The fake fetcher
 * returns a pre-built Anthropic SSE stream containing a tool_use response
 * with the extraction JSON.
 *
 * Covers:
 *   1. Happy path: prd.ingested + proposition.extracted + task.drafted + pushback.raised
 *   2. Propositions appear in proj_proposition
 *   3. Draft tasks appear in proj_task_list with status=draft
 *   4. Pushbacks appear in proposition.active_pushback_ids
 *   5. Retry on validation failure (malformed JSON), up to MAX_RETRIES
 *   6. Error propagation after exhausting retries
 *   7. seedIngestPromptVersion idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { runMigrations } from "./eventStore.js";
import { initProjections, eventBus } from "./projectionRunner.js";
import "./projections/register.js";
import { ingestPrd, seedIngestPromptVersion, INGEST_PROMPT_VERSION_ID } from "./ingest.js";
import type { Fetcher } from "./adapters/anthropicApi.js";

// ============================================================================
// Helpers — fake SSE stream builders
// ============================================================================

/** Build an Anthropic SSE stream containing a tool_use response. */
function makeToolUseStream(jsonOutput: object): string {
  const text = JSON.stringify(jsonOutput);
  const lines = [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_001", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 0 } } })}`,
    ``,
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_001", name: "structured_output", input: {} } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: text } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } })}`,
    ``,
    `event: message_stop`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    ``,
  ];
  return lines.join("\n") + "\n";
}

function makeFakeFetcher(response: object): Fetcher {
  return async (_url, _init) =>
    new Response(makeToolUseStream(response), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
}

function makeErrorFetcher(): Fetcher {
  return async (_url, _init) =>
    new Response(JSON.stringify({ error: { message: "Overloaded" } }), {
      status: 529,
      headers: { "Content-Type": "application/json" },
    });
}

/** Returns a fetcher that returns invalid JSON the first N times, then a valid response. */
function makeFlakyFetcher(failCount: number, goodResponse: object): Fetcher {
  let calls = 0;
  return async (_url, _init) => {
    calls++;
    if (calls <= failCount) {
      return new Response(makeToolUseStream({ not_valid: true }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(makeToolUseStream(goodResponse), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const SAMPLE_EXTRACTION = {
  propositions: [
    {
      id: "P-001",
      text: "The system must support user authentication via email and password.",
      source_span: { section: "Authentication", line_start: 10, line_end: 12 },
      confidence: 0.95,
    },
    {
      id: "P-002",
      text: "Passwords must be hashed using bcrypt with a minimum cost factor of 12.",
      source_span: { section: "Authentication", line_start: 14, line_end: 15 },
      confidence: 0.9,
    },
    {
      id: "P-003",
      text: "The API must return structured JSON error responses.",
      source_span: { section: "API Design", line_start: 30, line_end: 31 },
      confidence: 0.85,
    },
  ],
  draft_tasks: [
    { title: "Implement authentication", proposition_ids: ["P-001", "P-002"] },
    { title: "API error handling", proposition_ids: ["P-003"] },
  ],
  pushbacks: [
    {
      proposition_id: "P-002",
      kind: "advisory",
      rationale: "bcrypt cost factor may need tuning based on hardware",
      suggested_resolutions: [
        "Make cost factor configurable",
        "Document recommended range",
      ],
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe("ingestPrd", () => {
  let db: Database.Database;
  let prdPath: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    initProjections(db);

    // Write a temp PRD file
    prdPath = join(tmpdir(), `test-prd-${Date.now()}.md`);
    writeFileSync(
      prdPath,
      "# Test PRD\n\n## Authentication\n\nUsers must be able to log in.\n",
    );
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
    try {
      unlinkSync(prdPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it("emits prd.ingested event with correct metadata", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    const prdEvent = db
      .prepare("SELECT * FROM events WHERE type = 'prd.ingested' LIMIT 1")
      .get() as { payload_json: string; aggregate_id: string } | undefined;

    expect(prdEvent).toBeDefined();
    const payload = JSON.parse(prdEvent!.payload_json) as Record<string, unknown>;
    expect(payload.path).toBe(prdPath);
    expect(payload.extractor_model).toBe("claude-sonnet-4-6");
    expect(payload.extractor_prompt_version_id).toBe(INGEST_PROMPT_VERSION_ID);
    expect(typeof payload.content_hash).toBe("string");
    expect((payload.content_hash as string).length).toBe(64); // sha256 hex
    expect(result.prd_id).toBe(payload.prd_id);
  });

  it("emits proposition.extracted events and populates proj_proposition", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    expect(result.propositions).toHaveLength(3);

    const rows = db
      .prepare("SELECT * FROM proj_proposition WHERE prd_id = ?")
      .all(result.prd_id) as Array<{
        proposition_id: string;
        text: string;
        confidence: number;
        active_pushback_ids_json: string;
      }>;

    expect(rows).toHaveLength(3);

    const texts = rows.map((r) => r.text);
    expect(texts).toContain(
      "The system must support user authentication via email and password.",
    );
    expect(texts).toContain(
      "Passwords must be hashed using bcrypt with a minimum cost factor of 12.",
    );
    expect(texts).toContain(
      "The API must return structured JSON error responses.",
    );
  });

  it("emits task.drafted events and creates draft rows in task_list", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    expect(result.draft_tasks).toHaveLength(2);

    // task.drafted now subscribes to task_list → rows appear with status=draft
    const draftRows = db
      .prepare("SELECT * FROM proj_task_list WHERE status = 'draft'")
      .all() as Array<{ task_id: string; title: string; status: string }>;

    expect(draftRows).toHaveLength(2);
    const titles = draftRows.map((r) => r.title);
    expect(titles).toContain("Implement authentication");
    expect(titles).toContain("API error handling");
  });

  it("emits pushback.raised events and adds pushback_id to proposition", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    expect(result.pushback_count).toBe(1);

    // Find the proposition for "Passwords must be hashed..."
    const prop = result.propositions.find((p) =>
      p.text.includes("bcrypt"),
    );
    expect(prop).toBeDefined();

    // Check it has an active pushback in the projection
    const row = db
      .prepare(
        "SELECT active_pushback_ids_json FROM proj_proposition WHERE proposition_id = ?",
      )
      .get(prop!.proposition_id) as
      | { active_pushback_ids_json: string }
      | undefined;

    expect(row).toBeDefined();
    const ids = JSON.parse(row!.active_pushback_ids_json) as string[];
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^PUSHBACK-/);
  });

  it("resolves proposition IDs from P-001 style to ULIDs in draft tasks", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    const authTask = result.draft_tasks.find(
      (t) => t.title === "Implement authentication",
    );
    expect(authTask).toBeDefined();
    // Should have 2 resolved proposition IDs
    expect(authTask!.proposition_ids).toHaveLength(2);
    // IDs should be ULID-based (start with PROP-)
    for (const id of authTask!.proposition_ids) {
      expect(id).toMatch(/^PROP-/);
    }
  });

  it("retries on validation failure (flaky fetcher succeeds on 3rd call)", async () => {
    const result = await ingestPrd(
      db,
      { path: prdPath },
      makeFlakyFetcher(2, SAMPLE_EXTRACTION),
    );

    // Should still succeed
    expect(result.propositions).toHaveLength(3);
  });

  it("throws after exhausting retries", async () => {
    // fail all 3 attempts (attempts 0, 1, 2 = MAX_RETRIES + 1 = 3 total)
    await expect(
      ingestPrd(db, { path: prdPath }, makeFlakyFetcher(3, SAMPLE_EXTRACTION)),
    ).rejects.toThrow(/Ingest extraction failed after/);
  });

  it("throws when the PRD file does not exist", async () => {
    await expect(
      ingestPrd(db, { path: "/nonexistent/path.md" }, makeFakeFetcher(SAMPLE_EXTRACTION)),
    ).rejects.toThrow();
  });

  it("all events share the same correlation_id (prd_id)", async () => {
    const result = await ingestPrd(db, { path: prdPath }, makeFakeFetcher(SAMPLE_EXTRACTION));

    const events = db
      .prepare(
        "SELECT type, correlation_id FROM events WHERE correlation_id = ?",
      )
      .all(result.prd_id) as Array<{ type: string; correlation_id: string }>;

    // All proposition, task.drafted, and pushback events should be correlated
    const types = events.map((e) => e.type);
    expect(types).toContain("proposition.extracted");
    expect(types).toContain("task.drafted");
    expect(types).toContain("pushback.raised");
    // Every event should have the prd_id as correlation_id
    for (const e of events) {
      expect(e.correlation_id).toBe(result.prd_id);
    }
  });
});

const PRD_CONTENT = "# Test PRD\n\n## Authentication\n\nUsers must be able to log in.\n";

describe("ingestPrd — content mode", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    initProjections(db);
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
  });

  it("accepts { content: string } and skips file I/O", async () => {
    const result = await ingestPrd(
      db,
      { content: PRD_CONTENT },
      makeFakeFetcher(SAMPLE_EXTRACTION),
    );

    expect(result.propositions).toHaveLength(3);
    expect(result.prd_id).toMatch(/^PRD-/);
  });

  it("sets path to null in prd.ingested event when content mode is used", async () => {
    await ingestPrd(
      db,
      { content: PRD_CONTENT },
      makeFakeFetcher(SAMPLE_EXTRACTION),
    );

    const prdEvent = db
      .prepare("SELECT payload_json FROM events WHERE type = 'prd.ingested' LIMIT 1")
      .get() as { payload_json: string } | undefined;

    expect(prdEvent).toBeDefined();
    const payload = JSON.parse(prdEvent!.payload_json) as Record<string, unknown>;
    expect(payload.path).toBeNull();
    expect(payload.content).toBe(PRD_CONTENT);
  });

  it("computes size_bytes, lines, and content_hash from content in content mode", async () => {
    await ingestPrd(
      db,
      { content: PRD_CONTENT },
      makeFakeFetcher(SAMPLE_EXTRACTION),
    );

    const prdEvent = db
      .prepare("SELECT payload_json FROM events WHERE type = 'prd.ingested' LIMIT 1")
      .get() as { payload_json: string } | undefined;

    const payload = JSON.parse(prdEvent!.payload_json) as Record<string, unknown>;
    expect(payload.size_bytes).toBe(Buffer.byteLength(PRD_CONTENT));
    expect(payload.lines).toBe(PRD_CONTENT.split("\n").length);
    expect(typeof payload.content_hash).toBe("string");
    expect((payload.content_hash as string).length).toBe(64);
  });

  it("computes size_bytes, lines, and content_hash from file content in path mode", async () => {
    const prdPath = join(tmpdir(), `test-prd-content-${Date.now()}.md`);
    writeFileSync(prdPath, PRD_CONTENT);

    try {
      await ingestPrd(
        db,
        { path: prdPath },
        makeFakeFetcher(SAMPLE_EXTRACTION),
      );

      const prdEvent = db
        .prepare("SELECT payload_json FROM events WHERE type = 'prd.ingested' LIMIT 1")
        .get() as { payload_json: string } | undefined;

      const payload = JSON.parse(prdEvent!.payload_json) as Record<string, unknown>;
      expect(payload.path).toBe(prdPath);
      expect(payload.content).toBe(PRD_CONTENT);
      expect(payload.size_bytes).toBe(Buffer.byteLength(PRD_CONTENT));
      expect(payload.lines).toBe(PRD_CONTENT.split("\n").length);
      expect((payload.content_hash as string).length).toBe(64);
    } finally {
      try { unlinkSync(prdPath); } catch { /* ignore */ }
    }
  });
});

describe("seedIngestPromptVersion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    initProjections(db);
  });

  afterEach(() => {
    db.close();
    eventBus.removeAllListeners();
  });

  it("creates a prompt_version.created event on first call", () => {
    seedIngestPromptVersion(db);

    const row = db
      .prepare(
        "SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'prompt_version.created'",
      )
      .get(INGEST_PROMPT_VERSION_ID) as { payload_json: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    expect(payload.name).toBe("ingest-v1");
    expect(payload.phase_class).toBe("ingest");
    expect(typeof payload.template_hash).toBe("string");
  });

  it("is idempotent — calling twice creates only one event", () => {
    seedIngestPromptVersion(db);
    seedIngestPromptVersion(db);

    const count = (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM events WHERE aggregate_id = ? AND type = 'prompt_version.created'",
        )
        .get(INGEST_PROMPT_VERSION_ID) as { n: number }
    ).n;

    expect(count).toBe(1);
  });
});
