/**
 * Preset command endpoints — CRUD operations that emit preset events.
 *
 * POST /api/commands/preset/create
 * POST /api/commands/preset/update/:id
 * POST /api/commands/preset/delete/:id
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { appendAndProject } from "../projectionRunner.js";
import type { Actor, TaskConfig } from "@shared/events.js";

const DEFAULT_ACTOR: Actor = { kind: "user", user_id: "local" };

// ============================================================================
// Request body schemas
// ============================================================================

const createPresetBody = z.object({
  /** Optional explicit ID; if omitted, derived from name. */
  preset_id: z.string().min(1).optional(),
  name: z.string().min(1),
  task_class: z.string().min(1),
  config: z.record(z.unknown()),
});

const updatePresetBody = z.object({
  config_diff: z.record(z.unknown()),
});

// ============================================================================
// Helpers
// ============================================================================

function getPreset(
  db: Database.Database,
  presetId: string,
): { preset_id: string } | undefined {
  return db
    .prepare("SELECT preset_id FROM proj_preset WHERE preset_id = ?")
    .get(presetId) as { preset_id: string } | undefined;
}

function notFound(id: string) {
  return Response.json(
    { type: "not_found", status: 404, detail: `Preset '${id}' not found` },
    { status: 404 },
  );
}

function conflict(message: string) {
  return Response.json(
    { type: "conflict", status: 409, detail: message },
    { status: 409 },
  );
}

function badRequest(detail: string | z.ZodError) {
  if (detail instanceof z.ZodError) {
    return Response.json(
      {
        type: "validation_error",
        status: 400,
        detail: "Request body validation failed",
        errors: detail.errors,
      },
      { status: 400 },
    );
  }
  return Response.json(
    { type: "bad_request", status: 400, detail },
    { status: 400 },
  );
}

// ============================================================================
// Route factory
// ============================================================================

export function createPresetCommandRoutes(db: Database.Database) {
  const app = new Hono();

  // --------------------------------------------------------------------------
  // POST /api/commands/preset/create
  // --------------------------------------------------------------------------
  app.post("/api/commands/preset/create", async (c) => {
    const parsed = createPresetBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const { name, task_class, config } = parsed.data;
    const preset_id =
      parsed.data.preset_id ??
      `preset-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    if (getPreset(db, preset_id)) {
      return conflict(`Preset '${preset_id}' already exists`);
    }

    const event = appendAndProject(db, {
      type: "preset.created",
      aggregate_type: "preset",
      aggregate_id: preset_id,
      actor: DEFAULT_ACTOR,
      payload: {
        preset_id,
        name,
        task_class,
        config: config as unknown as TaskConfig,
      },
    });

    return c.json(event);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/preset/update/:id
  // --------------------------------------------------------------------------
  app.post("/api/commands/preset/update/:id", async (c) => {
    const presetId = c.req.param("id");
    if (!getPreset(db, presetId)) return notFound(presetId);

    const parsed = updatePresetBody.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const event = appendAndProject(db, {
      type: "preset.updated",
      aggregate_type: "preset",
      aggregate_id: presetId,
      actor: DEFAULT_ACTOR,
      payload: {
        preset_id: presetId,
        config_diff: parsed.data.config_diff as Partial<TaskConfig>,
      },
    });

    return c.json(event);
  });

  // --------------------------------------------------------------------------
  // POST /api/commands/preset/delete/:id
  // --------------------------------------------------------------------------
  app.post("/api/commands/preset/delete/:id", (c) => {
    const presetId = c.req.param("id");
    if (!getPreset(db, presetId)) return notFound(presetId);

    const event = appendAndProject(db, {
      type: "preset.deleted",
      aggregate_type: "preset",
      aggregate_id: presetId,
      actor: DEFAULT_ACTOR,
      payload: { preset_id: presetId },
    });

    return c.json(event);
  });

  return app;
}
