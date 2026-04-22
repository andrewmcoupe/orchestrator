/**
 * Tests that bundled template files meet distribution requirements.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const templatesDir = path.join(repoRoot, "templates");

describe("templates/config.yaml", () => {
  const configPath = path.join(templatesDir, "config.yaml");

  it("exists", () => {
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("includes project_name field", () => {
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("project_name");
  });

  it("includes gate examples", () => {
    const contents = fs.readFileSync(configPath, "utf8");
    // Must show users how to configure gates (commented or not)
    expect(contents).toMatch(/gates/);
    expect(contents).toMatch(/command:/);
    expect(contents).toMatch(/name:/);
  });

  it("includes merge workflow configuration", () => {
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("on_merge");
    expect(contents).toContain("strategy");
  });
});

describe("templates/.env.local", () => {
  const envPath = path.join(templatesDir, ".env.local");

  it("exists", () => {
    expect(fs.existsSync(envPath)).toBe(true);
  });

  it("includes ANTHROPIC_API_KEY placeholder", () => {
    const contents = fs.readFileSync(envPath, "utf8");
    expect(contents).toContain("ANTHROPIC_API_KEY");
  });

  it("has all keys commented out (no real secrets)", () => {
    const contents = fs.readFileSync(envPath, "utf8");
    const nonCommentLines = contents
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(nonCommentLines).toEqual([]);
  });
});

describe("package.json includes templates in files array", () => {
  it("lists templates/ in files", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(pkg.files).toContain("templates/");
  });
});
