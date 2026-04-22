/**
 * Prompt version and A/B experiment command endpoints.
 *
 * POST /api/commands/prompt_version/create        — creates a new prompt version
 * POST /api/commands/prompt_version/:id/retire    — marks a prompt as retired
 * POST /api/commands/ab_experiment/create         — creates an A/B experiment
 * POST /api/commands/ab_experiment/:id/conclude   — concludes an experiment
 */

import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { appendAndProject } from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import { putBlob } from "../blobStore.js";
import { createHash } from "node:crypto";

const DEFAULT_ACTOR: Actor = { kind: "user", user_id: "local" };

function hashTemplate(template: string): string {
  return createHash("sha256").update(template).digest("hex");
}

// ============================================================================
// Request body schemas
// ============================================================================

const CreatePromptVersionBody = z.object({
  name: z.string().min(1),
  phase_class: z.string().min(1),
  template: z.string().min(1),
  parent_version_id: z.string().optional(),
  notes: z.string().optional(),
});

const RetireBody = z.object({ reason: z.string().optional() });

const CreateAbExperimentBody = z.object({
  phase_class: z.string().min(1),
  variant_a_id: z.string().min(1),
  variant_b_id: z.string().min(1),
  split: z.tuple([z.number(), z.number()]).default([50, 50]),
  bucket_key: z.string().default("${task_id}:${phase_name}"),
});

const ConcludeBody = z.object({
  winner: z.enum(["A", "B", "none"]).optional(),
  reason: z.string().min(1),
  stats: z.object({
    a: z.object({ n: z.number(), success_rate: z.number(), avg_cost_usd: z.number() }),
    b: z.object({ n: z.number(), success_rate: z.number(), avg_cost_usd: z.number() }),
  }),
});

// ============================================================================
// Route factory
// ============================================================================

export function createPromptCommandRoutes(db: Database.Database): Hono {
  const routes = new Hono();

  // ── POST /api/commands/prompt_version/create ───────────────────────────
  routes.post("/api/commands/prompt_version/create", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreatePromptVersionBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
    }

    const { name, phase_class, template, parent_version_id, notes } = parsed.data;
    const prompt_version_id = ulid();
    const template_hash = hashTemplate(template);

    // Store template content in content-addressable blob store (synchronous)
    putBlob(template);

    const event = appendAndProject(db, {
      type: "prompt_version.created",
      aggregate_type: "prompt_version",
      aggregate_id: prompt_version_id,
      actor: DEFAULT_ACTOR,
      payload: {
        prompt_version_id,
        name,
        phase_class,
        template,
        template_hash,
        parent_version_id,
        notes,
      },
    });

    return c.json(event, 200);
  });

  // ── POST /api/commands/prompt_version/:id/retire ───────────────────────
  routes.post("/api/commands/prompt_version/:id/retire", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = RetireBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
    }

    // Check the prompt version exists in the projection
    const row = db
      .prepare("SELECT prompt_version_id FROM proj_prompt_library WHERE prompt_version_id = ?")
      .get(id);
    if (!row) {
      return c.json({ error: "not_found", detail: `Prompt version '${id}' not found` }, 404);
    }

    const event = appendAndProject(db, {
      type: "prompt_version.retired",
      aggregate_type: "prompt_version",
      aggregate_id: id,
      actor: DEFAULT_ACTOR,
      payload: { prompt_version_id: id, reason: parsed.data.reason },
    });

    return c.json(event, 200);
  });

  // ── POST /api/commands/ab_experiment/create ────────────────────────────
  routes.post("/api/commands/ab_experiment/create", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateAbExperimentBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
    }

    const { phase_class, variant_a_id, variant_b_id, split, bucket_key } = parsed.data;
    const experiment_id = ulid();

    // Validate that both prompt versions exist in the library
    const aRow = db
      .prepare("SELECT prompt_version_id FROM proj_prompt_library WHERE prompt_version_id = ?")
      .get(variant_a_id);
    if (!aRow) {
      return c.json({ error: "not_found", detail: `Prompt version A '${variant_a_id}' not found` }, 404);
    }

    const bRow = db
      .prepare("SELECT prompt_version_id FROM proj_prompt_library WHERE prompt_version_id = ?")
      .get(variant_b_id);
    if (!bRow) {
      return c.json({ error: "not_found", detail: `Prompt version B '${variant_b_id}' not found` }, 404);
    }

    const event = appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: experiment_id,
      actor: DEFAULT_ACTOR,
      payload: {
        experiment_id,
        phase_class,
        variants: { A: variant_a_id, B: variant_b_id },
        split,
        bucket_key,
      },
    });

    return c.json(event, 200);
  });

  // ── POST /api/commands/ab_experiment/:id/conclude ──────────────────────
  routes.post("/api/commands/ab_experiment/:id/conclude", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = ConcludeBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
    }

    const row = db
      .prepare("SELECT status FROM proj_ab_experiment WHERE experiment_id = ?")
      .get(id) as { status: string } | undefined;
    if (!row) {
      return c.json({ error: "not_found", detail: `Experiment '${id}' not found` }, 404);
    }
    if (row.status === "concluded") {
      return c.json({ error: "conflict", detail: "Experiment already concluded" }, 409);
    }

    const event = appendAndProject(db, {
      type: "ab_experiment.concluded",
      aggregate_type: "ab_experiment",
      aggregate_id: id,
      actor: DEFAULT_ACTOR,
      payload: {
        experiment_id: id,
        winner: parsed.data.winner,
        reason: parsed.data.reason,
        stats: parsed.data.stats,
      },
    });

    return c.json(event, 200);
  });

  return routes;
}
