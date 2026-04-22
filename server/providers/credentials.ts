/**
 * Credential loading for API providers.
 *
 * API keys are read from orchestrator/.env.local at boot. The file is never
 * imported into event payloads or logs — only the boolean `auth_present` flag
 * reaches the outside world.
 *
 * CLI providers (claude-code, codex, aider, gemini-cli) manage their own
 * credentials; this module always returns null for them.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { getProviderConfig } from "./registry.js";

const logger = pino({ name: "credentials" });

// Map of env var name → secret value, populated once at boot.
type KeyMap = Map<string, string>;

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a .env-style file into a key→value map.
 * Supports: comments (#), blank lines, quoted values, trimmed whitespace.
 */
function parseEnvFile(content: string): KeyMap {
  const map: KeyMap = new Map();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && value) {
      map.set(key, value);
    }
  }
  return map;
}

// ============================================================================
// Credential store factory
// ============================================================================

export type CredentialStore = {
  /**
   * Returns the API key for an API provider, or null if not set / not
   * applicable (CLI providers always return null).
   */
  getCredential: (provider_id: string) => string | null;
  /** Returns true iff the provider has a non-empty credential. */
  hasCredential: (provider_id: string) => boolean;
  /** Direct access to a raw env-var key (e.g. GOOGLE_API_KEY). */
  getRawKey: (envVarName: string) => string | null;
};

export function createCredentialStore(envLocalPath: string): CredentialStore {
  let keys: KeyMap;

  if (!existsSync(envLocalPath)) {
    logger.warn(
      { path: envLocalPath },
      "orchestrator/.env.local not found — API providers will be marked as down",
    );
    keys = new Map();
  } else {
    const content = readFileSync(envLocalPath, "utf8");
    keys = parseEnvFile(content);
  }

  function getCredential(provider_id: string): string | null {
    const config = getProviderConfig(provider_id);
    if (!config) return null;
    // CLI providers manage their own auth
    if (config.kind === "cli") return null;
    if (!config.env_var) return null;

    return keys.get(config.env_var) ?? null;
  }

  function hasCredential(provider_id: string): boolean {
    return getCredential(provider_id) !== null;
  }

  function getRawKey(envVarName: string): string | null {
    return keys.get(envVarName) ?? null;
  }

  return { getCredential, hasCredential, getRawKey };
}

// ============================================================================
// Singleton — loaded once at server boot from the standard path
// ============================================================================

const defaultEnvLocalPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".env.local",
);

let _singleton: CredentialStore | null = null;

/** Returns the singleton credential store, loading from disk on first call. */
export function getCredentials(): CredentialStore {
  if (!_singleton) {
    _singleton = createCredentialStore(defaultEnvLocalPath);
  }
  return _singleton;
}

/** Convenience: get credential for a provider via the singleton. */
export function getCredential(provider_id: string): string | null {
  return getCredentials().getCredential(provider_id);
}

/** Convenience: check credential presence via the singleton. */
export function hasCredential(provider_id: string): boolean {
  return getCredentials().hasCredential(provider_id);
}
