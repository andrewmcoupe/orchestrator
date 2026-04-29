/**
 * ProviderHealth projection — one row per provider showing live status,
 * latency, and config. Powers the top-bar pills and Providers section.
 *
 * Unlike task projections the provider_id is stable and always present in
 * provider.* event payloads, so no indirect lookup is needed.
 */

import type Database from "better-sqlite3";
import type { AnyEvent } from "@shared/events.js";
import { reduceProviderHealth, type ProviderHealthRow } from "@shared/projections.js";
import { registerProjection, type Projection } from "../projectionRunner.js";

// ============================================================================
// Raw DB row (models stored as JSON text)
// ============================================================================

type RawProviderHealthRow = Omit<ProviderHealthRow, "models" | "auth_present"> & {
  models_json: string | null;
  auth_present: number; // SQLite stores booleans as 0/1
};

function rowFromRaw(raw: RawProviderHealthRow): ProviderHealthRow {
  const { models_json, auth_present, ...rest } = raw;
  return {
    ...rest,
    models: models_json ? (JSON.parse(models_json) as string[]) : undefined,
    auth_present: auth_present === 1,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function extractProviderId(event: AnyEvent): string | null {
  const p = event.payload as unknown as Record<string, unknown>;
  return typeof p.provider_id === "string" ? p.provider_id : null;
}

/** Derive auth_present from whether the configured env-var is set. */
function deriveAuthPresent(event: AnyEvent): boolean {
  // For provider.configured events we can check env vars
  if (event.type !== "provider.configured") return false;
  const p = event.payload;
  if (p.auth_method === "cli_login") {
    // CLI providers manage their own auth — we can't tell from here
    return false;
  }
  // For env_var auth, derive the var name from the transport
  const envVarMap: Record<string, string> = {
    "anthropic-api": "ANTHROPIC_API_KEY",
    "openai-api": "OPENAI_API_KEY",
  };
  const envVar = envVarMap[p.provider_id];
  return envVar ? !!process.env[envVar] : false;
}

// ============================================================================
// Projection definition
// ============================================================================

export const providerHealthProjection: Projection<ProviderHealthRow> = {
  name: "provider_health",

  createSql: `
    CREATE TABLE IF NOT EXISTS proj_provider_health (
      provider_id   TEXT PRIMARY KEY,
      transport     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'unknown',
      latency_ms    INTEGER,
      last_probe_at TEXT,
      last_error    TEXT,
      models_json   TEXT,
      binary_path   TEXT,
      endpoint      TEXT,
      auth_method   TEXT,
      auth_present  INTEGER NOT NULL DEFAULT 0
    );
  `,

  read(db: Database.Database, event: AnyEvent): ProviderHealthRow | null {
    const providerId = extractProviderId(event);
    if (!providerId) return null;

    const raw = db
      .prepare("SELECT * FROM proj_provider_health WHERE provider_id = ?")
      .get(providerId) as RawProviderHealthRow | undefined;

    return raw ? rowFromRaw(raw) : null;
  },

  reduce(
    current: ProviderHealthRow | null,
    event: AnyEvent,
  ): ProviderHealthRow | null {
    // Augment provider.configured with current auth_present status
    if (event.type === "provider.configured") {
      const next = reduceProviderHealth(current, event);
      if (!next) return null;
      // For CLI providers, the shared reducer already preserves auth_present
      // from the DB (or defaults to false). For env_var auth, derive from env.
      if (event.payload.auth_method !== "cli_login") {
        const authPresent = deriveAuthPresent(event);
        return { ...next, auth_present: authPresent };
      }
      return next;
    }
    return reduceProviderHealth(current, event);
  },

  write(
    db: Database.Database,
    next: ProviderHealthRow | null,
    _id: string,
  ): void {
    if (!next) return; // providers are never deleted from the projection

    db.prepare(
      `INSERT INTO proj_provider_health
         (provider_id, transport, status, latency_ms, last_probe_at, last_error,
          models_json, binary_path, endpoint, auth_method, auth_present)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         transport     = excluded.transport,
         status        = excluded.status,
         latency_ms    = excluded.latency_ms,
         last_probe_at = excluded.last_probe_at,
         last_error    = excluded.last_error,
         models_json   = excluded.models_json,
         binary_path   = excluded.binary_path,
         endpoint      = excluded.endpoint,
         auth_method   = excluded.auth_method,
         auth_present  = excluded.auth_present`,
    ).run(
      next.provider_id,
      next.transport,
      next.status,
      next.latency_ms ?? null,
      next.last_probe_at ?? null,
      next.last_error ?? null,
      next.models ? JSON.stringify(next.models) : null,
      next.binary_path ?? null,
      next.endpoint ?? null,
      next.auth_method ?? null,
      next.auth_present ? 1 : 0,
    );
  },
};

// Self-register on import
registerProjection(providerHealthProjection);
