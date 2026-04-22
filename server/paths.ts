/**
 * Centralized path resolution.
 *
 * All runtime paths resolve from process.cwd() so the orchestrator works
 * correctly when installed as a global npm package (npx). Data lives under
 * <cwd>/.orchestrator/ which is gitignored.
 *
 * Prompts are bundled with the package and resolve from import.meta.dirname.
 */

import path from "node:path";

// ============================================================================
// Core root
// ============================================================================

/**
 * Returns the orchestrator data directory: <cwd>/.orchestrator/
 * All mutable state (db, blobs, worktrees, config, credentials) lives here.
 */
export function getOrchestratorDir(): string {
  return path.join(process.cwd(), ".orchestrator");
}

/**
 * Returns process.cwd() — the host repo root.
 * When run via `npx`, this is the directory the user invoked from.
 */
export function getDefaultRepoRoot(): string {
  return process.cwd();
}

// ============================================================================
// Individual paths
// ============================================================================

/** SQLite database: <cwd>/.orchestrator/events.db */
export function getDbPath(): string {
  return path.join(getOrchestratorDir(), "events.db");
}

/** Content-addressable blob store: <cwd>/.orchestrator/blobs/ */
export function getBlobsDir(): string {
  return path.join(getOrchestratorDir(), "blobs");
}

/** API credentials: <cwd>/.orchestrator/.env.local */
export function getCredentialsPath(): string {
  return path.join(getOrchestratorDir(), ".env.local");
}

/** Git worktrees: <cwd>/.orchestrator/worktrees/ */
export function getWorktreesDir(): string {
  return path.join(getOrchestratorDir(), "worktrees");
}

/** Project config: <cwd>/.orchestrator/config.yaml */
export function getConfigPath(): string {
  return path.join(getOrchestratorDir(), "config.yaml");
}
