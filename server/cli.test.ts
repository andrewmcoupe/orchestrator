/**
 * Tests for CLI entry point argument parsing.
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli.js";

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
