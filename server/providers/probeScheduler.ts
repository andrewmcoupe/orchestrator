/**
 * Probe scheduler — runs probeProvider for each enabled provider on a 60s
 * interval and on demand. Results are appended as provider.probed events
 * through appendAndProject so they flow to projections and SSE clients.
 *
 * Also emits provider.configured on first boot for each known provider so
 * the projection table is seeded even before the first probe runs.
 */

import type Database from "better-sqlite3";
import { appendAndProject } from "../projectionRunner.js";
import { PROVIDERS, getProviderConfig } from "./registry.js";
import { probeProvider } from "./probe.js";

const PROBE_INTERVAL_MS = 60_000;

const actor = { kind: "system" as const, component: "probe" as const };

// ============================================================================
// Boot: emit provider.configured for all known providers
// ============================================================================

/**
 * Emit a provider.configured event for each known provider if it hasn't been
 * configured yet. Idempotent — we check whether the row already exists in
 * proj_provider_health before emitting.
 */
export async function configureProviders(db: Database.Database): Promise<void> {
  for (const p of PROVIDERS) {
    // Check if provider already has a row in proj_provider_health
    let alreadyConfigured = false;
    try {
      const row = db
        .prepare("SELECT provider_id FROM proj_provider_health WHERE provider_id = ?")
        .get(p.provider_id);
      alreadyConfigured = !!row;
    } catch {
      // Table may not exist yet — will be created by initProjections
      alreadyConfigured = false;
    }

    if (!alreadyConfigured) {
      await appendAndProject(db, {
        type: "provider.configured",
        aggregate_type: "provider",
        aggregate_id: p.provider_id,
        actor,
        payload: {
          provider_id: p.provider_id,
          transport: p.transport,
          binary_path: p.binary,
          endpoint: p.endpoint,
          auth_method: p.auth_method,
        },
      });
    }
  }
}

// ============================================================================
// Probe a single provider and append the result as an event
// ============================================================================

export async function probeOne(
  db: Database.Database,
  provider_id: string,
): Promise<void> {
  const config = getProviderConfig(provider_id);
  if (!config) throw new Error(`Unknown provider: ${provider_id}`);

  const result = await probeProvider(provider_id);
  await appendAndProject(db, {
    type: "provider.probed",
    aggregate_type: "provider",
    aggregate_id: provider_id,
    actor,
    payload: {
      provider_id,
      status: result.status,
      latency_ms: result.latency_ms,
      error: result.error,
      models_listed: result.models,
    },
  });
}

// ============================================================================
// Scheduler
// ============================================================================

export type ProbeScheduler = {
  /** Start probing. Runs an immediate probe cycle, then every 60s. */
  start: () => void;
  /** Stop the scheduler (clears the interval). */
  stop: () => void;
  /** Trigger an immediate on-demand probe for a single provider. */
  probeOne: (provider_id: string) => Promise<void>;
};

export function createProbeScheduler(db: Database.Database): ProbeScheduler {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function runAllProbes(): Promise<void> {
    await Promise.allSettled(
      PROVIDERS.map((p) => probeOne(db, p.provider_id)),
    );
  }

  return {
    start() {
      // Immediate first probe, then periodic
      void runAllProbes();
      intervalId = setInterval(() => void runAllProbes(), PROBE_INTERVAL_MS);
    },
    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    probeOne: (provider_id: string) => probeOne(db, provider_id),
  };
}
