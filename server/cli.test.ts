/**
 * Tests for CLI entry point argument parsing and git validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs, isInsideGitRepo } from "./cli.js";
import fs from "node:fs";
import path from "node:path";

describe("parseArgs", () => {
  it("returns default port 4321 when no flags given", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ port: 4321, open: true, verbose: false });
  });

  it("parses --port flag", () => {
    const result = parseArgs(["--port", "8080"]);
    expect(result).toEqual({ port: 8080, open: true, verbose: false });
  });

  it("parses --port=value syntax", () => {
    const result = parseArgs(["--port=9999"]);
    expect(result).toEqual({ port: 9999, open: true, verbose: false });
  });

  it("returns { help: true } for --help flag", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it("returns { version: true } for --version flag", () => {
    expect(parseArgs(["--version"])).toEqual({ version: true });
  });

  it("returns { init: true } for --init flag", () => {
    expect(parseArgs(["--init"])).toEqual({ init: true });
  });

  it("--help takes precedence over other flags", () => {
    expect(parseArgs(["--port", "8080", "--help"])).toEqual({ help: true });
  });

  it("--version takes precedence over port but not help", () => {
    expect(parseArgs(["--port", "8080", "--version"])).toEqual({
      version: true,
    });
  });

  it("parses --no-open flag", () => {
    const result = parseArgs(["--no-open"]);
    expect(result).toEqual({ port: 4321, open: false, verbose: false });
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["--verbose"]);
    expect(result).toEqual({ port: 4321, open: true, verbose: true });
  });

  it("parses --quiet flag (default behavior)", () => {
    const result = parseArgs(["--quiet"]);
    expect(result).toEqual({ port: 4321, open: true, verbose: false });
  });

  it("combines multiple flags", () => {
    const result = parseArgs(["--port", "5000", "--no-open", "--verbose"]);
    expect(result).toEqual({ port: 5000, open: false, verbose: true });
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
