/**
 * Tests for the .orchestrator/ directory scaffolding.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  scaffold,
  isAlreadyScaffolded,
  ensureGitignoreEntry,
} from "./scaffold.js";

const tmpBase = path.join(
  process.env.TMPDIR || "/tmp",
  "orchestrator-scaffold-test",
);

describe("scaffold", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // Clean slate
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });
    process.chdir(tmpBase);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("creates .orchestrator/ directory", () => {
    scaffold();
    expect(fs.existsSync(path.join(tmpBase, ".orchestrator"))).toBe(true);
  });

  it("creates blobs/ subdirectory", () => {
    scaffold();
    expect(fs.existsSync(path.join(tmpBase, ".orchestrator", "blobs"))).toBe(
      true,
    );
  });

  it("creates worktrees/ subdirectory", () => {
    scaffold();
    expect(
      fs.existsSync(path.join(tmpBase, ".orchestrator", "worktrees")),
    ).toBe(true);
  });

  it("creates config.yaml from template", () => {
    scaffold();
    const configPath = path.join(tmpBase, ".orchestrator", "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("project_name");
  });

  it("creates .env.local from template", () => {
    scaffold();
    const envPath = path.join(tmpBase, ".orchestrator", ".env.local");
    expect(fs.existsSync(envPath)).toBe(true);
    const contents = fs.readFileSync(envPath, "utf8");
    expect(contents).toContain("ANTHROPIC_API_KEY");
  });

  it("returns list of created paths", () => {
    const result = scaffold();
    expect(result.created.length).toBeGreaterThan(0);
    // Use realpath-resolved cwd since paths.ts uses process.cwd()
    const cwd = process.cwd();
    expect(result.created).toContain(path.join(cwd, ".orchestrator"));
    expect(result.created).toContain(
      path.join(cwd, ".orchestrator", "blobs"),
    );
    expect(result.created).toContain(
      path.join(cwd, ".orchestrator", "worktrees"),
    );
  });

  it("is idempotent — returns empty if already scaffolded", () => {
    scaffold();
    const result = scaffold();
    expect(result.created).toEqual([]);
  });

  it("adds .orchestrator/ to .gitignore", () => {
    scaffold();
    const gitignore = fs.readFileSync(
      path.join(tmpBase, ".gitignore"),
      "utf8",
    );
    expect(gitignore).toContain(".orchestrator/");
  });

  it("creates .gitignore if it doesn't exist", () => {
    expect(fs.existsSync(path.join(tmpBase, ".gitignore"))).toBe(false);
    scaffold();
    expect(fs.existsSync(path.join(tmpBase, ".gitignore"))).toBe(true);
  });
});

describe("isAlreadyScaffolded", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });
    process.chdir(tmpBase);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("returns false when .orchestrator/ does not exist", () => {
    expect(isAlreadyScaffolded()).toBe(false);
  });

  it("returns true when .orchestrator/ exists", () => {
    fs.mkdirSync(path.join(tmpBase, ".orchestrator"));
    expect(isAlreadyScaffolded()).toBe(true);
  });
});

describe("ensureGitignoreEntry", () => {
  beforeEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("creates .gitignore with entry if file doesn't exist", () => {
    ensureGitignoreEntry(tmpBase);
    const contents = fs.readFileSync(path.join(tmpBase, ".gitignore"), "utf8");
    expect(contents).toBe(".orchestrator/\n");
  });

  it("appends entry to existing .gitignore", () => {
    fs.writeFileSync(path.join(tmpBase, ".gitignore"), "node_modules/\n");
    ensureGitignoreEntry(tmpBase);
    const contents = fs.readFileSync(path.join(tmpBase, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules/\n.orchestrator/\n");
  });

  it("does not duplicate entry if already present", () => {
    fs.writeFileSync(
      path.join(tmpBase, ".gitignore"),
      "node_modules/\n.orchestrator/\n",
    );
    ensureGitignoreEntry(tmpBase);
    const contents = fs.readFileSync(path.join(tmpBase, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules/\n.orchestrator/\n");
  });

  it("handles .gitignore without trailing newline", () => {
    fs.writeFileSync(path.join(tmpBase, ".gitignore"), "node_modules/");
    ensureGitignoreEntry(tmpBase);
    const contents = fs.readFileSync(path.join(tmpBase, ".gitignore"), "utf8");
    expect(contents).toBe("node_modules/\n.orchestrator/\n");
  });
});
