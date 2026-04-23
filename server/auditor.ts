/**
 * Auditor module — verdict schema, prompt seeding, and verdict parsing.
 *
 * The auditor phase uses the anthropicApi adapter with schema-enforced
 * structured output. This module owns:
 *   1. VERDICT_JSON_SCHEMA — the JSON Schema for the structured_output tool.
 *   2. seedAuditorPromptVersion(db) — idempotent boot-time prompt seeding.
 *   3. parseVerdict(text) — validates the raw JSON from the model response.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { z } from "zod";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { appendAndProject } from "./projectionRunner.js";
import type { Actor, AuditConcern } from "@shared/events.js";

// ============================================================================
// Constants
// ============================================================================

export const AUDITOR_PROMPT_VERSION_ID = "pv-auditor-v1";
export const AUDITOR_MODEL = "claude-opus-4-6";

const AUDITOR_ACTOR: Actor = { kind: "system", component: "gate_runner" };

// ============================================================================
// Verdict JSON Schema (passed to the API as transport_options.schema)
// ============================================================================

/**
 * JSON Schema for the verdict structured_output tool.
 * This is sent to the Anthropic API to enforce a typed response.
 */
export const VERDICT_JSON_SCHEMA: object = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "revise", "reject"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    summary: {
      type: "string",
      minLength: 1,
    },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "correctness",
              "completeness",
              "style",
              "performance",
              "security",
              "nit",
            ],
          },
          severity: {
            type: "string",
            enum: ["blocking", "advisory"],
          },
          anchor: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "integer" },
              col: { type: "integer" },
            },
            required: ["path", "line"],
          },
          rationale: {
            type: "string",
            minLength: 1,
          },
          reference_proposition_id: {
            type: "string",
          },
        },
        required: ["category", "severity", "rationale"],
      },
    },
  },
  required: ["verdict", "confidence", "summary", "concerns"],
};

// ============================================================================
// Verdict Zod schema (runtime validation)
// ============================================================================

const auditConcernSchema = z.object({
  category: z.enum([
    "correctness",
    "completeness",
    "style",
    "performance",
    "security",
    "nit",
  ]),
  severity: z.enum(["blocking", "advisory"]),
  anchor: z
    .object({ path: z.string(), line: z.number().int(), col: z.number().int().optional() })
    .optional(),
  rationale: z.string().min(1),
  reference_proposition_id: z.string().optional(),
});

const verdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  concerns: z.array(auditConcernSchema),
});

export type ParsedVerdict = z.infer<typeof verdictSchema>;

/**
 * Parse and validate the JSON text returned by the auditor model.
 * Throws if the text is not valid JSON or does not match the verdict schema.
 */
export function parseVerdict(text: string): ParsedVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Auditor response is not valid JSON: ${text.slice(0, 200)}`);
  }
  return verdictSchema.parse(raw);
}

// ============================================================================
// Prompt seeding
// ============================================================================

function loadAuditorTemplate(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, "..", "..", "prompts", "auditor-v1.md"), "utf-8");
}

/**
 * Emits a prompt_version.created event for auditor-v1.md if not already seeded.
 * Idempotent — checks the event log before emitting.
 */
export function seedAuditorPromptVersion(db: Database.Database): void {
  const existing = db
    .prepare(
      "SELECT id FROM events WHERE aggregate_id = ? AND type = 'prompt_version.created' LIMIT 1",
    )
    .get(AUDITOR_PROMPT_VERSION_ID);

  if (existing) return;

  const template = loadAuditorTemplate();
  const template_hash = createHash("sha256").update(template).digest("hex");

  appendAndProject(db, {
    type: "prompt_version.created",
    aggregate_type: "prompt_version",
    aggregate_id: AUDITOR_PROMPT_VERSION_ID,
    actor: AUDITOR_ACTOR,
    payload: {
      prompt_version_id: AUDITOR_PROMPT_VERSION_ID,
      name: "auditor-v1",
      phase_class: "auditor",
      template,
      template_hash,
      notes: "Initial auditor verdict prompt",
    },
  });
}

// ============================================================================
// Audit ID helper
// ============================================================================

/** Generate a new audit event aggregate_id. */
export function newAuditId(): string {
  return `audit-${ulid()}`;
}
