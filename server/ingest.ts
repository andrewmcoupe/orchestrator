/**
 * PRD Ingest — reads a PRD file, calls the Anthropic API to extract
 * propositions, and emits the canonical events.
 *
 * Depends on:
 *   - anthropicApi adapter for structured-output extraction
 *   - appendAndProject for transactional event writes
 *   - proposition projection (registered at import of register.ts)
 *
 * Injectable fetcher enables unit testing without real HTTP calls.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import type Database from "better-sqlite3";
import { appendAndProject } from "./projectionRunner.js";
import type { Actor } from "@shared/events.js";
import type { PropositionRow } from "@shared/projections.js";
import { invoke as cliInvoke } from "./adapters/claudeCode.js";
import { createBlobStore } from "./blobStore.js";
import { getDefaultRepoRoot, getBlobsDir } from "./paths.js";
import { topoSort } from "@shared/dependency.js";

// ============================================================================
// Constants
// ============================================================================

export const INGEST_PROMPT_VERSION_ID = "pv-ingest-v1";
const INGEST_MODEL = "claude-sonnet-4-6";
const MAX_RETRIES = 2;

const INGEST_ACTOR: Actor = { kind: "system", component: "gate_runner" };
// gate_runner is the closest existing system component; ingest is a
// system-originated extraction. A future PR can add "ingest" to Actor.

// ============================================================================
// Extraction schema (Zod for validation + JSON Schema for API enforcement)
// ============================================================================

const extractionSchema = z.object({
  propositions: z.array(
    z.object({
      id: z.string(),
      text: z.string().min(1),
      source_span: z.object({
        section: z.string(),
        line_start: z.number().int().nonnegative(),
        line_end: z.number().int().nonnegative(),
      }),
      confidence: z.number().min(0).max(1),
    }),
  ),
  draft_tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
      proposition_ids: z.array(z.string()),
      depends_on: z.array(z.string()),
    }),
  ),
  pushbacks: z.array(
    z.object({
      proposition_id: z.string(),
      kind: z.enum(["blocking", "advisory", "question"]),
      rationale: z.string().min(1),
      suggested_resolutions: z.array(z.string()),
    }),
  ),
});

type ExtractionResult = z.infer<typeof extractionSchema>;

/** Raw JSON Schema sent to the Anthropic tool-use endpoint. */
const EXTRACTION_JSON_SCHEMA: object = {
  type: "object",
  properties: {
    propositions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          source_span: {
            type: "object",
            properties: {
              section: { type: "string" },
              line_start: { type: "number" },
              line_end: { type: "number" },
            },
            required: ["section", "line_start", "line_end"],
          },
          confidence: { type: "number" },
        },
        required: ["id", "text", "source_span", "confidence"],
      },
    },
    draft_tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Temporary draft task ID using DT-001, DT-002, etc." },
          title: { type: "string" },
          proposition_ids: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" }, description: "Array of DT-* IDs that this task depends on" },
        },
        required: ["id", "title", "proposition_ids", "depends_on"],
      },
    },
    pushbacks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          proposition_id: { type: "string" },
          kind: { type: "string", enum: ["blocking", "advisory", "question"] },
          rationale: { type: "string" },
          suggested_resolutions: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "proposition_id",
          "kind",
          "rationale",
          "suggested_resolutions",
        ],
      },
    },
  },
  required: ["propositions", "draft_tasks", "pushbacks"],
};

// ============================================================================
// Prompt loading
// ============================================================================

function loadPromptTemplate(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(__dirname, "..", "prompts", "ingest-v1.md");
  return readFileSync(promptPath, "utf-8");
}

// ============================================================================
// Extraction — calls the API with retry on validation failure
// ============================================================================

async function callExtractionCli(
  prd_id: string,
  content: string,
): Promise<ExtractionResult> {
  const systemPrompt = loadPromptTemplate();
  const blobStore = createBlobStore(getBlobsDir());
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const invocationId = `INV-${ulid()}`;
    let assistantText = "";
    let cliErrored = false;

    console.log(`[ingest] attempt ${attempt + 1}/${MAX_RETRIES + 1} for ${prd_id} (model: ${INGEST_MODEL}, transport: claude-code)`);
    console.log(`[ingest] content length: ${content.length} chars`);

    const prompt = `${systemPrompt}\n\n---\n\n${content}`;

    const opts = {
      invocation_id: invocationId,
      attempt_id: prd_id,
      phase_name: "ingest" as const,
      model: INGEST_MODEL,
      prompt,
      prompt_version_id: INGEST_PROMPT_VERSION_ID,
      context_manifest_hash: "",
      cwd: getDefaultRepoRoot(),
      transport_options: {
        kind: "cli" as const,
        max_turns: 1,
        max_budget_usd: 2,
        permission_mode: "bypassPermissions" as const,
        disallowed_tools: ["ToolSearch", "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent", "Skill", "NotebookEdit"],
        schema: EXTRACTION_JSON_SCHEMA,
      },
    };

    console.log(`[ingest] calling Claude Code CLI...`);
    const startTime = Date.now();

    for await (const event of cliInvoke(opts, blobStore)) {
      console.log(`[ingest] received event: ${event.type} (+${Date.now() - startTime}ms)`);
      if (event.type === "invocation.assistant_message") {
        assistantText += (event.payload as { text: string }).text;
      }
      if (event.type === "invocation.tool_called") {
        // When using --json-schema, Claude Code returns the structured output
        // as a tool call. Retrieve the args from the blob store.
        // Filter to only capture the structured output tool — ignore other
        // tool calls (e.g. ToolSearch) that Claude may invoke.
        const payload = event.payload as { tool_name: string; args_hash: string };
        console.log(`[ingest] tool_called: ${payload.tool_name}`);
        if (payload.tool_name === "StructuredOutput") {
          const blob = blobStore.getBlob(payload.args_hash);
          if (blob) {
            assistantText = blob.toString("utf-8");
            console.log(`[ingest] captured structured_output args (${assistantText.length} chars)`);
          }
        } else {
          console.log(`[ingest] ignoring tool call: ${payload.tool_name}`);
        }
      }
      if (event.type === "invocation.errored") {
        cliErrored = true;
        const errorPayload = event.payload as { error: string };
        console.error(`[ingest] CLI error: ${errorPayload.error}`);
        lastError = new Error(errorPayload.error ?? "CLI error");
        break;
      }
    }

    console.log(`[ingest] CLI call completed in ${Date.now() - startTime}ms (errored: ${cliErrored}, textLen: ${assistantText.length})`);

    if (!cliErrored && assistantText) {
      try {
        const parsed: unknown = JSON.parse(assistantText);
        console.log(`[ingest] raw LLM response:`, JSON.stringify(parsed, null, 2));
        const result = extractionSchema.parse(parsed);
        console.log(`[ingest] extraction succeeded: ${result.propositions.length} propositions, ${result.draft_tasks.length} tasks, ${result.pushbacks.length} pushbacks`);
        return result;
      } catch (err) {
        console.error(`[ingest] parse/validation failed:`, err instanceof Error ? err.message : err);
        console.error(`[ingest] raw assistantText:`, assistantText.slice(0, 2000));
        lastError =
          err instanceof Error ? err : new Error("Validation failed");
        // continue to next retry
      }
    } else if (cliErrored && attempt === MAX_RETRIES) {
      break;
    }
  }

  throw new Error(
    `Ingest extraction failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

// ============================================================================
// Public API
// ============================================================================

export interface TaskDraftSummary {
  task_id: string;
  title: string;
  proposition_ids: string[];
  depends_on: string[];
}

export interface IngestResult {
  prd_id: string;
  propositions: PropositionRow[];
  draft_tasks: TaskDraftSummary[];
  pushback_count: number;
}

export type IngestInput = { path: string } | { content: string };

/**
 * Ingest a PRD: extract propositions via the LLM and emit canonical events.
 *
 * Accepts either `{ path }` (reads the file) or `{ content }` (uses the
 * string directly, sets path to null in the event payload).
 */
export type Extractor = (prd_id: string, content: string) => Promise<ExtractionResult>;

export async function ingestPrd(
  db: Database.Database,
  input: IngestInput,
  extractor?: Extractor,
): Promise<IngestResult> {
  // Resolve content from either input mode
  const resolvedPath: string | null = "path" in input ? input.path : null;
  const content = "content" in input ? input.content : readFileSync(input.path, "utf-8");
  const lines = content.split("\n").length;
  const size_bytes = Buffer.byteLength(content);
  const content_hash = createHash("sha256").update(content).digest("hex");

  // Assign IDs
  const prd_id = `PRD-${ulid()}`;

  // Emit prd.ingested
  appendAndProject(db, {
    type: "prd.ingested",
    aggregate_type: "prd",
    aggregate_id: prd_id,
    actor: INGEST_ACTOR,
    payload: {
      prd_id,
      path: resolvedPath,
      size_bytes,
      lines,
      extractor_model: INGEST_MODEL,
      extractor_prompt_version_id: INGEST_PROMPT_VERSION_ID,
      content_hash,
      content,
    },
  });

  // Call extraction (injectable for tests, defaults to real CLI)
  const extract = extractor ?? callExtractionCli;
  const extracted = await extract(prd_id, content);

  // Run topological sort to detect and strip cycle-causing edges
  const topoResult = topoSort(
    extracted.draft_tasks.map((t) => ({ id: t.id, depends_on: [...t.depends_on] })),
  );

  // Apply stripped edges back to the extracted draft tasks
  if (topoResult.stripped.length > 0) {
    const strippedEdges = new Map<string, Set<string>>();
    for (const { from, to } of topoResult.stripped) {
      if (!strippedEdges.has(from)) strippedEdges.set(from, new Set());
      strippedEdges.get(from)!.add(to);
    }
    for (const draft of extracted.draft_tasks) {
      const removed = strippedEdges.get(draft.id);
      if (removed) {
        draft.depends_on = draft.depends_on.filter((dep) => !removed.has(dep));
      }
    }
  }

  // Map extracted prop IDs ("P-001" etc.) → assigned ULIDs
  const idMap = new Map<string, string>();

  // Emit proposition.extracted for each extracted proposition
  const propositions: PropositionRow[] = [];
  for (const prop of extracted.propositions) {
    const proposition_id = `PROP-${ulid()}`;
    idMap.set(prop.id, proposition_id);

    const now = new Date().toISOString();
    appendAndProject(db, {
      type: "proposition.extracted",
      aggregate_type: "proposition",
      aggregate_id: proposition_id,
      actor: INGEST_ACTOR,
      correlation_id: prd_id,
      payload: {
        proposition_id,
        prd_id,
        text: prop.text,
        source_span: prop.source_span,
        confidence: prop.confidence,
      },
    });

    propositions.push({
      proposition_id,
      prd_id,
      text: prop.text,
      source_span: prop.source_span,
      confidence: prop.confidence,
      active_pushback_ids: [],
      updated_at: now,
    });
  }

  // Map DT-* IDs → assigned T-{ULID} task IDs
  const taskIdMap = new Map<string, string>();
  for (const draft of extracted.draft_tasks) {
    taskIdMap.set(draft.id, `T-${ulid()}`);
  }

  // Emit task.drafted for each draft task grouping (skip duplicates by title)
  const draft_tasks: TaskDraftSummary[] = [];
  for (const draft of extracted.draft_tasks) {
    // Skip if a task with the same title already exists
    const existing = db
      .prepare("SELECT task_id FROM proj_task_list WHERE LOWER(title) = LOWER(?)")
      .get(draft.title) as { task_id: string } | undefined;
    if (existing) {
      // Remap the draft ID to the existing task so dependency resolution still works
      taskIdMap.set(draft.id, existing.task_id);
      continue;
    }

    const task_id = taskIdMap.get(draft.id)!;
    // Resolve proposition IDs from the LLM's "P-001" style IDs to ULIDs
    const resolvedIds = draft.proposition_ids
      .map((id) => idMap.get(id))
      .filter((id): id is string => id !== undefined);

    // Resolve DT-* depends_on IDs to T-{ULID} task IDs
    const resolvedDeps = draft.depends_on
      .map((id) => taskIdMap.get(id))
      .filter((id): id is string => id !== undefined);

    appendAndProject(db, {
      type: "task.drafted",
      aggregate_type: "task",
      aggregate_id: task_id,
      actor: INGEST_ACTOR,
      correlation_id: prd_id,
      payload: {
        task_id,
        title: draft.title,
        proposition_ids: resolvedIds,
        proposed_by: "agent",
      },
    });

    // Emit task.dependency.set if this task has dependencies
    if (resolvedDeps.length > 0) {
      appendAndProject(db, {
        type: "task.dependency.set",
        aggregate_type: "task",
        aggregate_id: task_id,
        actor: INGEST_ACTOR,
        correlation_id: prd_id,
        payload: {
          task_id,
          depends_on: resolvedDeps,
        },
      });
    }

    draft_tasks.push({ task_id, title: draft.title, proposition_ids: resolvedIds, depends_on: resolvedDeps });
  }

  // Emit pushback.raised for each flagged proposition
  let pushback_count = 0;
  for (const pushback of extracted.pushbacks) {
    const resolvedPropId = idMap.get(pushback.proposition_id);
    if (!resolvedPropId) continue; // skip if proposition ID didn't resolve

    const pushback_id = `PUSHBACK-${ulid()}`;
    appendAndProject(db, {
      type: "pushback.raised",
      aggregate_type: "pushback",
      aggregate_id: pushback_id,
      actor: INGEST_ACTOR,
      correlation_id: prd_id,
      payload: {
        pushback_id,
        proposition_id: resolvedPropId,
        kind: pushback.kind,
        rationale: pushback.rationale,
        suggested_resolutions: pushback.suggested_resolutions,
        raised_by: { phase: "ingest" as const, model: INGEST_MODEL },
      },
    });
    pushback_count++;
  }

  // Emit advisory pushback for any cycle edges that were stripped
  if (topoResult.stripped.length > 0) {
    const edgeDescriptions = topoResult.stripped
      .map(({ from, to }) => `${from} → ${to}`)
      .join(", ");

    const pushback_id = `PUSHBACK-${ulid()}`;
    // Use the first proposition ID as a reference anchor (cycle is cross-task)
    const anchorPropId = extracted.propositions[0]
      ? idMap.get(extracted.propositions[0].id) ?? ""
      : "";

    appendAndProject(db, {
      type: "pushback.raised",
      aggregate_type: "pushback",
      aggregate_id: pushback_id,
      actor: INGEST_ACTOR,
      correlation_id: prd_id,
      payload: {
        pushback_id,
        proposition_id: anchorPropId,
        kind: "advisory" as const,
        rationale: `Circular dependency cycle detected and stripped: ${edgeDescriptions}`,
        suggested_resolutions: [
          "Review task ordering to eliminate circular dependencies",
          "Split tightly-coupled tasks into smaller units",
        ],
        raised_by: { phase: "ingest" as const, model: INGEST_MODEL },
      },
    });
    pushback_count++;
  }

  return { prd_id, propositions, draft_tasks, pushback_count };
}

// ============================================================================
// Boot-time seeding of the ingest prompt version
// ============================================================================

/**
 * Emits a prompt_version.created event for ingest-v1.md if it hasn't been
 * seeded yet. Idempotent — checks the event log before emitting.
 */
export function seedIngestPromptVersion(db: Database.Database): void {
  const existing = db
    .prepare(
      "SELECT id FROM events WHERE aggregate_id = ? AND type = 'prompt_version.created' LIMIT 1",
    )
    .get(INGEST_PROMPT_VERSION_ID);

  if (existing) return;

  const template = loadPromptTemplate();
  const template_hash = createHash("sha256").update(template).digest("hex");

  appendAndProject(db, {
    type: "prompt_version.created",
    aggregate_type: "prompt_version",
    aggregate_id: INGEST_PROMPT_VERSION_ID,
    actor: INGEST_ACTOR,
    payload: {
      prompt_version_id: INGEST_PROMPT_VERSION_ID,
      name: "ingest-v1",
      phase_class: "ingest",
      template,
      template_hash,
      notes: "Initial proposition extraction prompt",
    },
  });
}
