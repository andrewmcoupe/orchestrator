/**
 * Provider probing — checks whether each provider is reachable and healthy.
 *
 * CLI probes: run `<binary> --version` with a 2s timeout.
 *   - Success → status=healthy
 *   - Binary not found → status=down, error="not found"
 *   - Timeout / non-zero exit → status=degraded
 *
 * API probes: check for the env-var key, then hit the models-list endpoint.
 *   - Missing key → status=down, error="<ENV_VAR> not set in orchestrator/.env.local"
 *   - Successful list → status=healthy, models populated
 *   - HTTP error → status=degraded or down
 */

import { execa } from "execa";
import { getProviderConfig, PROVIDERS } from "./registry.js";
import { getCredential } from "./credentials.js";

export type ProbeResult = {
  status: "healthy" | "degraded" | "down";
  latency_ms?: number;
  models?: string[];
  error?: string;
  auth_present?: boolean;
};

// ============================================================================
// CLI probe
// ============================================================================

async function probeCli(binary: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await execa(binary, ["--version"], { timeout: 2000 });
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err: unknown) {
    const latency_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT means the binary is not on PATH
    if (message.includes("ENOENT") || message.includes("not found")) {
      return {
        status: "down",
        latency_ms,
        error: `${binary}: not found on PATH`,
      };
    }
    // Non-zero exit or timeout
    return { status: "degraded", latency_ms, error: message.slice(0, 200) };
  }
}

/** Post-version login probe for CLI providers. Returns true if authenticated. */
async function probeCliAuth(
  provider_id: string,
  binary: string,
): Promise<boolean> {
  try {
    if (provider_id === "claude-code") {
      const result = await execa(binary, ["auth", "status", "--json"], {
        timeout: 3000,
      });
      // `claude auth status` exits 0 even when logged out, so we must parse the
      // JSON body and read `loggedIn` rather than relying on the exit code.
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean };
      return parsed.loggedIn === true;
    }
    if (provider_id === "codex") {
      const result = await execa(binary, ["login", "status"], {
        timeout: 3000,
      });
      // codex writes "Logged in using …" to stderr, not stdout, so check both.
      const output = `${result.stdout}\n${result.stderr}`;
      return result.exitCode === 0 && output.includes("Logged in");
    }
  } catch {
    return false;
  }
  return false;
}

// ============================================================================
// API probe — Anthropic
// ============================================================================

async function probeAnthropicApi(apiKey: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5000),
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return {
        status: res.status === 401 ? "down" : "degraded",
        latency_ms,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const models = body.data?.map((m) => m.id) ?? [];
    return { status: "healthy", latency_ms, models };
  } catch (err: unknown) {
    return {
      status: "down",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

// ============================================================================
// API probe — OpenAI
// ============================================================================

async function probeOpenAiApi(apiKey: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return {
        status: res.status === 401 ? "down" : "degraded",
        latency_ms,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const models = body.data?.map((m) => m.id) ?? [];
    return { status: "healthy", latency_ms, models };
  } catch (err: unknown) {
    return {
      status: "down",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

// ============================================================================
// Main probe dispatcher
// ============================================================================

/** Probe a single provider and return the result. */
export async function probeProvider(provider_id: string): Promise<ProbeResult> {
  const config = getProviderConfig(provider_id);
  if (!config) {
    return { status: "down", error: `Unknown provider: ${provider_id}` };
  }

  if (config.kind === "cli") {
    const result = await probeCli(config.binary!);
    // Only run auth probe if binary was found (not down due to missing binary)
    if (result.status !== "down") {
      result.auth_present = await probeCliAuth(provider_id, config.binary!);
    } else {
      result.auth_present = false;
    }
    return result;
  }

  // API provider — load key from orchestrator/.env.local via credential store
  const apiKey = getCredential(provider_id);
  if (!apiKey) {
    return {
      status: "down",
      auth_present: false,
      error: `${config.env_var ?? "API key"} not set in .orchestrator/.env.local`,
    };
  }

  let result: ProbeResult;
  if (provider_id === "anthropic-api") result = await probeAnthropicApi(apiKey);
  else if (provider_id === "openai-api") result = await probeOpenAiApi(apiKey);
  else
    return {
      status: "down",
      auth_present: false,
      error: `No probe implementation for ${provider_id}`,
    };

  // API key was present; auth_present = true if probe didn't get a 401
  result.auth_present =
    result.status !== "down" || !result.error?.includes("401");
  return result;
}

/** Probe all registered providers in parallel. */
export async function probeAllProviders(): Promise<
  Record<string, ProbeResult>
> {
  const results = await Promise.all(
    PROVIDERS.map(
      async (p) => [p.provider_id, await probeProvider(p.provider_id)] as const,
    ),
  );
  return Object.fromEntries(results);
}
