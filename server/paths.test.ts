/**
 * Tests for centralized path resolution.
 *
 * Verifies all paths resolve from process.cwd() under .orchestrator/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import {
  getOrchestratorDir,
  getDefaultRepoRoot,
  getDbPath,
  getBlobsDir,
  getCredentialsPath,
  getWorktreesDir,
  getConfigPath,
} from "./paths.js";

describe("paths", () => {
  const fakeCwd = "/tmp/my-project";

  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getDefaultRepoRoot() returns process.cwd()", () => {
    expect(getDefaultRepoRoot()).toBe(fakeCwd);
  });

  it("getOrchestratorDir() returns <cwd>/.orchestrator", () => {
    expect(getOrchestratorDir()).toBe(path.join(fakeCwd, ".orchestrator"));
  });

  it("getDbPath() returns <cwd>/.orchestrator/events.db", () => {
    expect(getDbPath()).toBe(
      path.join(fakeCwd, ".orchestrator", "events.db"),
    );
  });

  it("getBlobsDir() returns <cwd>/.orchestrator/blobs", () => {
    expect(getBlobsDir()).toBe(
      path.join(fakeCwd, ".orchestrator", "blobs"),
    );
  });

  it("getCredentialsPath() returns <cwd>/.orchestrator/.env.local", () => {
    expect(getCredentialsPath()).toBe(
      path.join(fakeCwd, ".orchestrator", ".env.local"),
    );
  });

  it("getWorktreesDir() returns <cwd>/.orchestrator/worktrees", () => {
    expect(getWorktreesDir()).toBe(
      path.join(fakeCwd, ".orchestrator", "worktrees"),
    );
  });

  it("getConfigPath() returns <cwd>/.orchestrator/config.yaml", () => {
    expect(getConfigPath()).toBe(
      path.join(fakeCwd, ".orchestrator", "config.yaml"),
    );
  });
});
