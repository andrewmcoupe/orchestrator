import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { GateConfig } from "@shared/events.js";
import { getConfigPath } from "./paths.js";

export const INGEST_TRANSPORTS = ["claude-code", "codex"] as const;
export type IngestTransport = (typeof INGEST_TRANSPORTS)[number];

export const DEFAULT_INGEST_CONFIG = {
  transport: "claude-code",
  model: "claude-sonnet-4-6",
} satisfies IngestConfig;

export type IngestConfig = {
  transport: IngestTransport;
  model: string;
};

export type OrchestratorConfig = {
  project_name?: string;
  gates: GateConfig[];
  ingest: IngestConfig;
};

const ingestConfigSchema = z
  .object({
    transport: z.enum(INGEST_TRANSPORTS),
    model: z.string().min(1),
  })
  .default(DEFAULT_INGEST_CONFIG);

const orchestratorConfigSchema = z
  .object({
    project_name: z.string().optional(),
    gates: z.array(z.custom<GateConfig>()).default([]),
    ingest: ingestConfigSchema,
  })
  .passthrough();

let loadedConfig: OrchestratorConfig = {
  gates: [],
  ingest: DEFAULT_INGEST_CONFIG,
};

export function loadOrchestratorConfig(
  configPath = getConfigPath(),
): OrchestratorConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    loadedConfig = {
      gates: [],
      ingest: DEFAULT_INGEST_CONFIG,
    };
    return loadedConfig;
  }

  const parsedYaml = parseYaml(raw) as unknown;
  const parsed = orchestratorConfigSchema.safeParse(parsedYaml ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid config.yaml at ${configPath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  loadedConfig = {
    project_name: parsed.data.project_name,
    gates: parsed.data.gates,
    ingest: parsed.data.ingest,
  };
  return loadedConfig;
}

export function getOrchestratorConfig(): OrchestratorConfig {
  return loadedConfig;
}

export function getIngestConfig(): IngestConfig {
  return loadedConfig.ingest;
}
