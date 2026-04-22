/**
 * Provider registry — the canonical list of known provider IDs, their
 * transport kind, and how to invoke or authenticate them.
 *
 * CLI providers are invoked by running a binary. Auth is managed by the CLI
 * itself (we never touch credentials for these).
 *
 * API providers call a remote HTTP endpoint and require an env-var key loaded
 * from orchestrator/.env.local.
 */

import type { Transport } from "@shared/events.js";

export type ProviderKind = "cli" | "api";

export type ProviderConfig = {
  provider_id: string;
  transport: Transport;
  kind: ProviderKind;
  /** Binary name for CLI providers. */
  binary?: string;
  /** Base endpoint for API providers. */
  endpoint?: string;
  /** Environment variable name that holds the API key. */
  env_var?: string;
  auth_method: "env_var" | "keychain" | "cli_login";
};

export const PROVIDERS: ProviderConfig[] = [
  {
    provider_id: "claude-code",
    transport: "claude-code",
    kind: "cli",
    binary: "claude",
    auth_method: "cli_login",
  },
  {
    provider_id: "codex",
    transport: "codex",
    kind: "cli",
    binary: "codex",
    auth_method: "cli_login",
  },
  {
    provider_id: "aider",
    transport: "aider",
    kind: "cli",
    binary: "aider",
    auth_method: "cli_login",
  },
  {
    provider_id: "gemini-cli",
    transport: "gemini-cli",
    kind: "cli",
    binary: "gemini",
    auth_method: "cli_login",
  },
  {
    provider_id: "anthropic-api",
    transport: "anthropic-api",
    kind: "api",
    endpoint: "https://api.anthropic.com",
    env_var: "ANTHROPIC_API_KEY",
    auth_method: "env_var",
  },
  {
    provider_id: "openai-api",
    transport: "openai-api",
    kind: "api",
    endpoint: "https://api.openai.com",
    env_var: "OPENAI_API_KEY",
    auth_method: "env_var",
  },
];

/** Look up a provider config by its ID. Returns undefined if not found. */
export function getProviderConfig(
  provider_id: string,
): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.provider_id === provider_id);
}
