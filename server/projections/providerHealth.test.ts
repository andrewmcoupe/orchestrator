import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import {
  appendAndProject,
  initProjections,
  rebuildProjection,
} from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import type { ProviderHealthRow } from "@shared/projections.js";

// Register all projections including providerHealth
import "./register.js";

// ============================================================================
// Fixtures
// ============================================================================

const actor: Actor = { kind: "system", component: "probe" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

function getRow(
  db: Database.Database,
  provider_id: string,
): ProviderHealthRow | null {
  const raw = db
    .prepare("SELECT * FROM proj_provider_health WHERE provider_id = ?")
    .get(provider_id) as
    | (Omit<ProviderHealthRow, "models" | "auth_present"> & {
        models_json: string | null;
        auth_present: number;
      })
    | undefined;
  if (!raw) return null;
  const { models_json, auth_present, ...rest } = raw;
  return {
    ...rest,
    models: models_json ? (JSON.parse(models_json) as string[]) : undefined,
    auth_present: auth_present === 1,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("providerHealth projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("creates a row on provider.configured", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        transport: "claude-code",
        binary_path: "claude",
        auth_method: "cli_login",
      },
    });

    const row = getRow(db, "claude-code");
    expect(row).not.toBeNull();
    expect(row!.provider_id).toBe("claude-code");
    expect(row!.transport).toBe("claude-code");
    expect(row!.binary_path).toBe("claude");
    expect(row!.auth_method).toBe("cli_login");
    expect(row!.status).toBe("unknown");
  });

  it("updates status on provider.probed", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        transport: "claude-code",
        auth_method: "cli_login",
      },
    });

    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        status: "healthy",
        latency_ms: 120,
        models_listed: ["claude-sonnet-4-6", "claude-opus-4-7"],
      },
    });

    const row = getRow(db, "claude-code");
    expect(row!.status).toBe("healthy");
    expect(row!.latency_ms).toBe(120);
    expect(row!.models).toEqual(["claude-sonnet-4-6", "claude-opus-4-7"]);
    expect(row!.last_probe_at).toBeTruthy();
  });

  it("records error on down probe", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        transport: "claude-code",
        auth_method: "cli_login",
      },
    });

    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        status: "down",
        error: "claude: not found on PATH",
      },
    });

    const row = getRow(db, "claude-code");
    expect(row!.status).toBe("down");
    expect(row!.last_error).toBe("claude: not found on PATH");
  });

  it("updates auth_method on provider.auth_changed", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "anthropic-api",
      actor,
      payload: {
        provider_id: "anthropic-api",
        transport: "anthropic-api",
        auth_method: "env_var",
        endpoint: "https://api.anthropic.com",
      },
    });

    await appendAndProject(db, {
      type: "provider.auth_changed",
      aggregate_type: "provider",
      aggregate_id: "anthropic-api",
      actor,
      payload: {
        provider_id: "anthropic-api",
        auth_method: "keychain",
      },
    });

    const row = getRow(db, "anthropic-api");
    expect(row!.auth_method).toBe("keychain");
  });

  it("sets auth_present true when env_var provider probes healthy", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "anthropic-api",
      actor,
      payload: {
        provider_id: "anthropic-api",
        transport: "anthropic-api",
        auth_method: "env_var",
        endpoint: "https://api.anthropic.com",
      },
    });

    // Before probe, auth_present defaults to false
    expect(getRow(db, "anthropic-api")!.auth_present).toBe(false);

    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "anthropic-api",
      actor,
      payload: {
        provider_id: "anthropic-api",
        status: "healthy",
        latency_ms: 200,
        models_listed: ["claude-sonnet-4-6"],
      },
    });

    expect(getRow(db, "anthropic-api")!.auth_present).toBe(true);
  });

  it("sets auth_present false when env_var provider probe fails", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "openai-api",
      actor,
      payload: {
        provider_id: "openai-api",
        transport: "openai-api",
        auth_method: "env_var",
        endpoint: "https://api.openai.com",
      },
    });

    // Healthy probe first
    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "openai-api",
      actor,
      payload: { provider_id: "openai-api", status: "healthy", latency_ms: 100 },
    });
    expect(getRow(db, "openai-api")!.auth_present).toBe(true);

    // Then a failed probe (e.g. key revoked)
    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "openai-api",
      actor,
      payload: { provider_id: "openai-api", status: "down", error: "HTTP 401" },
    });
    expect(getRow(db, "openai-api")!.auth_present).toBe(false);
  });

  it("does not change auth_present for cli_login providers on probe", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        transport: "claude-code",
        auth_method: "cli_login",
      },
    });

    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: { provider_id: "claude-code", status: "healthy", latency_ms: 20 },
    });

    // cli_login providers don't track auth_present
    expect(getRow(db, "claude-code")!.auth_present).toBe(false);
  });

  it("probe for unknown provider does not create row", async () => {
    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "nonexistent",
      actor,
      payload: {
        provider_id: "nonexistent",
        status: "down",
        error: "no config",
      },
    });

    const row = getRow(db, "nonexistent");
    expect(row).toBeNull();
  });

  it("multiple probes keep latest status", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "openai-api",
      actor,
      payload: {
        provider_id: "openai-api",
        transport: "openai-api",
        auth_method: "env_var",
        endpoint: "https://api.openai.com",
      },
    });

    for (const status of ["healthy", "degraded", "healthy"] as const) {
      await appendAndProject(db, {
        type: "provider.probed",
        aggregate_type: "provider",
        aggregate_id: "openai-api",
        actor,
        payload: { provider_id: "openai-api", status },
      });
    }

    const row = getRow(db, "openai-api");
    expect(row!.status).toBe("healthy");
  });

  it("rebuild produces identical state", async () => {
    await appendAndProject(db, {
      type: "provider.configured",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        transport: "claude-code",
        auth_method: "cli_login",
      },
    });
    await appendAndProject(db, {
      type: "provider.probed",
      aggregate_type: "provider",
      aggregate_id: "claude-code",
      actor,
      payload: {
        provider_id: "claude-code",
        status: "healthy",
        latency_ms: 42,
      },
    });

    const before = getRow(db, "claude-code");
    rebuildProjection(db, "provider_health");
    const after = getRow(db, "claude-code");

    expect(after).toEqual(before);
  });

  it("proj_provider_health table created on first run", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='proj_provider_health'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("proj_provider_health");
  });
});
