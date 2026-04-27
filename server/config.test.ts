import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INGEST_CONFIG,
  getIngestConfig,
  loadOrchestratorConfig,
} from "./config.js";

describe("orchestrator config", () => {
  afterEach(() => {
    loadOrchestratorConfig(join(tmpdir(), "missing-orchestrator-config.yaml"));
  });

  function writeConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-config-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, contents, "utf-8");
    return configPath;
  }

  it("defaults ingest config when block is absent", () => {
    const configPath = writeConfig("project_name: test\n");

    try {
      const config = loadOrchestratorConfig(configPath);
      expect(config.ingest).toEqual(DEFAULT_INGEST_CONFIG);
      expect(getIngestConfig()).toEqual(DEFAULT_INGEST_CONFIG);
    } finally {
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  });

  it("parses ingest transport and model", () => {
    const configPath = writeConfig(`
ingest:
  transport: codex
  model: gpt-5.5
`);

    try {
      const config = loadOrchestratorConfig(configPath);
      expect(config.ingest).toEqual({ transport: "codex", model: "gpt-5.5" });
    } finally {
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  });

  it("rejects unsupported ingest transport", () => {
    const configPath = writeConfig(`
ingest:
  transport: openai-api
  model: gpt-5.5
`);

    try {
      expect(() => loadOrchestratorConfig(configPath)).toThrow(/ingest\.transport/);
    } finally {
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  });
});
