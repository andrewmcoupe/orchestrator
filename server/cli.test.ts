/**
 * Tests for CLI entry point argument parsing and git validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs, isInsideGitRepo } from "./cli.js";
import fs from "node:fs";
import path from "node:path";

describe("parseArgs", () => {
  it("returns default port 4321 when no flags given", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ port: 4321 });
  });

  it("parses --port flag", () => {
    const result = parseArgs(["--port", "8080"]);
    expect(result).toEqual({ port: 8080 });
  });

  it("parses --port=value syntax", () => {
    const result = parseArgs(["--port=9999"]);
    expect(result).toEqual({ port: 9999 });
  });

  it("returns { help: true } for --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result).toEqual({ help: true });
  });

  it("returns { version: true } for --version flag", () => {
    const result = parseArgs(["--version"]);
    expect(result).toEqual({ version: true });
  });

  it("--help takes precedence over other flags", () => {
    const result = parseArgs(["--port", "8080", "--help"]);
    expect(result).toEqual({ help: true });
  });

  it("--version takes precedence over port but not help", () => {
    const result = parseArgs(["--port", "8080", "--version"]);
    expect(result).toEqual({ version: true });
  });

  it("throws on invalid port value", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow();
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--unknown"])).toThrow();
  });
});

describe("isInsideGitRepo", () => {
  const tmpBase = path.join(
    process.env.TMPDIR || "/tmp",
    "orchestrator-git-test",
  );

  beforeEach(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("returns true when .git exists in the given directory", () => {
    const dir = path.join(tmpBase, "repo-direct");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    expect(isInsideGitRepo(dir)).toBe(true);
  });

  it("returns true when .git exists in a parent directory", () => {
    const repoRoot = path.join(tmpBase, "repo-parent");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    const nested = path.join(repoRoot, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    expect(isInsideGitRepo(nested)).toBe(true);
  });

  it("returns false when no .git exists in any ancestor", () => {
    const noGit = path.join(tmpBase, "no-git", "sub");
    fs.mkdirSync(noGit, { recursive: true });
    expect(isInsideGitRepo(noGit)).toBe(false);
  });
});
