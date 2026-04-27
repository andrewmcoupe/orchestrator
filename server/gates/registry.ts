/**
 * Gate registry — loads gate definitions from orchestrator/config.yaml
 * at startup and exposes them by name.
 *
 * Gates are keyed by their `name` field. Duplicate names are an error.
 * The registry is populated once at boot; reloading requires a restart.
 */

import type { GateConfig } from "@shared/events.js";
import { getConfigPath } from "../paths.js";
import { loadOrchestratorConfig } from "../config.js";

const CONFIG_PATH = getConfigPath();

// In-memory registry populated at startup
const _registry = new Map<string, GateConfig>();

/** Load gates from config.yaml into the registry. Idempotent: clears first. */
export function loadGateRegistry(configPath = CONFIG_PATH): void {
  _registry.clear();
  const config = loadOrchestratorConfig(configPath);
  for (const gate of config.gates) {
    if (_registry.has(gate.name)) {
      throw new Error(
        `Duplicate gate name "${gate.name}" in ${configPath}`,
      );
    }
    _registry.set(gate.name, gate);
  }
}

/** Return the GateConfig for a gate by name, or undefined if not found. */
export function getGateConfig(name: string): GateConfig | undefined {
  return _registry.get(name);
}

/** Return all registered gates (ordered as they appear in config.yaml). */
export function listGates(): GateConfig[] {
  return [..._registry.values()];
}

/** Register a gate programmatically (for testing). */
export function registerGate(gate: GateConfig): void {
  _registry.set(gate.name, gate);
}

/** Clear the registry (for testing). */
export function clearGateRegistry(): void {
  _registry.clear();
}
