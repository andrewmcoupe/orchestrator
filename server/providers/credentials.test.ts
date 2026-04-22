/**
 * Tests for the credentials module.
 * Credentials are loaded from orchestrator/.env.local at boot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test via the factory function so each test gets a fresh instance
import { createCredentialStore } from "./credentials.js";

describe("credentials", () => {
  let tmpDir: string;
  let envLocalPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `creds-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    envLocalPath = join(tmpDir, ".env.local");
  });

  afterEach(() => {
    try { unlinkSync(envLocalPath); } catch { /* may not exist */ }
  });

  // ── Slice 1: basic key loading ──────────────────────────────────────────────

  it("returns the API key for a known API provider", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=sk-ant-test123\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBe("sk-ant-test123");
  });

  it("returns null for a provider whose key is not in the file", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=sk-ant-test\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("openai-api")).toBeNull();
  });

  it("returns null when .env.local does not exist", () => {
    // No file written — envLocalPath does not exist
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBeNull();
  });

  // ── Slice 2: hasCredential helper ───────────────────────────────────────────

  it("hasCredential returns true when key is present and non-empty", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=sk-ant-test\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.hasCredential("anthropic-api")).toBe(true);
  });

  it("hasCredential returns false when key is absent", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=sk-ant-test\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.hasCredential("openai-api")).toBe(false);
  });

  // ── Slice 3: CLI providers always return null ───────────────────────────────

  it("returns null for a CLI provider (they manage their own auth)", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=sk-ant-test\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("claude-code")).toBeNull();
    expect(store.getCredential("codex")).toBeNull();
    expect(store.getCredential("aider")).toBeNull();
    expect(store.getCredential("gemini-cli")).toBeNull();
  });

  // ── Slice 4: file parsing edge cases ───────────────────────────────────────

  it("ignores comment lines starting with #", () => {
    writeFileSync(
      envLocalPath,
      "# This is a comment\nANTHROPIC_API_KEY=sk-real\n# Another comment\n",
    );
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBe("sk-real");
  });

  it("ignores blank lines", () => {
    writeFileSync(envLocalPath, "\nANTHROPIC_API_KEY=sk-real\n\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBe("sk-real");
  });

  it("trims whitespace from values", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=  sk-trimmed  \n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBe("sk-trimmed");
  });

  it("strips surrounding quotes from values", () => {
    writeFileSync(envLocalPath, 'ANTHROPIC_API_KEY="sk-quoted"\n');
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBe("sk-quoted");
  });

  it("treats an empty value as absent", () => {
    writeFileSync(envLocalPath, "ANTHROPIC_API_KEY=\n");
    const store = createCredentialStore(envLocalPath);
    expect(store.getCredential("anthropic-api")).toBeNull();
    expect(store.hasCredential("anthropic-api")).toBe(false);
  });

  // ── Slice 5: Google API key ─────────────────────────────────────────────────

  it("loads GOOGLE_API_KEY for gemini API (future use)", () => {
    writeFileSync(envLocalPath, "GOOGLE_API_KEY=goog-test\n");
    const store = createCredentialStore(envLocalPath);
    // Not a provider_id lookup — expose raw key access for future use
    expect(store.getRawKey("GOOGLE_API_KEY")).toBe("goog-test");
  });
});
