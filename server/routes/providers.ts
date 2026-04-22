/**
 * Provider routes — on-demand probing and provider health reads.
 *
 * GET  /api/providers/probe/:id  — triggers an immediate probe for one
 *   provider, appends the result as a provider.probed event, returns the
 *   updated ProviderHealthRow.
 */

import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ProbeScheduler } from "../providers/probeScheduler.js";
import { getProviderConfig } from "../providers/registry.js";
import { appendAndProject } from "../projectionRunner.js";
import type { ProviderHealthRow } from "@shared/projections.js";

type RawRow = Omit<ProviderHealthRow, "models" | "auth_present"> & {
  models_json: string | null;
  auth_present: number;
};

function parseRow(raw: RawRow): ProviderHealthRow {
  const { models_json, auth_present, ...rest } = raw;
  return {
    ...rest,
    models: models_json ? (JSON.parse(models_json) as string[]) : undefined,
    auth_present: auth_present === 1,
  };
}

export function createProviderRoutes(
  db: Database.Database,
  scheduler: ProbeScheduler,
): Hono {
  const app = new Hono();

  /**
   * POST /api/providers/probe/:id
   * Trigger an on-demand re-probe for a single provider. Returns the updated
   * provider_health row.
   */
  app.post("/api/providers/probe/:id", async (c) => {
    const providerId = c.req.param("id");

    if (!getProviderConfig(providerId)) {
      return c.json(
        {
          type: "https://orchestrator/errors/not-found",
          title: "Provider not found",
          detail: `No provider registered with id: ${providerId}`,
        },
        404,
      );
    }

    await scheduler.probeOne(providerId);

    const raw = db
      .prepare("SELECT * FROM proj_provider_health WHERE provider_id = ?")
      .get(providerId) as RawRow | undefined;

    if (!raw) {
      return c.json(
        {
          type: "https://orchestrator/errors/not-found",
          title: "Provider health row not found after probe",
          detail: `provider_id: ${providerId}`,
        },
        404,
      );
    }

    return c.json(parseRow(raw));
  });

  /**
   * POST /api/providers/configure/:id
   * Update the configuration (binary_path, endpoint, auth_method) for a provider
   * by emitting a provider.configured event.
   */
  app.post("/api/providers/configure/:id", async (c) => {
    const providerId = c.req.param("id");
    const config = getProviderConfig(providerId);

    if (!config) {
      return c.json(
        {
          type: "https://orchestrator/errors/not-found",
          title: "Provider not found",
          detail: `No provider registered with id: ${providerId}`,
        },
        404,
      );
    }

    const bodySchema = z.object({
      binary_path: z.string().optional(),
      endpoint: z.string().optional(),
      auth_method: z.enum(["env_var", "keychain", "cli_login"]).optional(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { type: "https://orchestrator/errors/validation", title: "Validation error", detail: String(err) },
        400,
      );
    }

    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: providerId,
      actor: { kind: "user", user_id: "local" },
      payload: {
        provider_id: providerId,
        transport: config.transport,
        binary_path: body.binary_path ?? config.binary,
        endpoint: body.endpoint ?? config.endpoint,
        auth_method: body.auth_method ?? config.auth_method,
      },
    });

    const raw = db
      .prepare("SELECT * FROM proj_provider_health WHERE provider_id = ?")
      .get(providerId) as RawRow | undefined;

    if (!raw) {
      return c.json(
        {
          type: "https://orchestrator/errors/not-found",
          title: "Provider health row not found after configure",
          detail: `provider_id: ${providerId}`,
        },
        404,
      );
    }

    return c.json(parseRow(raw));
  });

  return app;
}
