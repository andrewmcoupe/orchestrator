/**
 * Unit tests for CLI login probe logic in probe.ts.
 *
 * Covers: claude-code auth, codex auth, gemini-cli (no auth check),
 * and binary-missing cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execa before importing probe
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Mock credentials (not used by CLI probes, but imported by probe.ts)
vi.mock("./credentials.js", () => ({
  getCredential: vi.fn(() => null),
}));

import { execa } from "execa";
import { probeProvider } from "./probe.js";

const mockExeca = vi.mocked(execa);

/** Helper to create a successful execa result */
function ok(stdout = "", stderr = ""): ReturnType<typeof execa> {
  return { exitCode: 0, stdout, stderr } as any;
}

describe("CLI login probe", () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  // ── claude-code ───────────────────────────────────────────────────────────

  it("claude-code logged in (loggedIn: true in JSON) → auth_present: true", async () => {
    // First call: --version (healthy)
    // Second call: auth status --json (success, loggedIn: true)
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockResolvedValueOnce(
        ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })),
      );

    const result = await probeProvider("claude-code");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      "claude",
      ["auth", "status", "--json"],
      { timeout: 3000 },
    );
  });

  it("claude-code logged out (exit 0 but loggedIn: false) → auth_present: false", async () => {
    // `claude auth status` exits 0 even when logged out — must read the JSON body.
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockResolvedValueOnce(ok(JSON.stringify({ loggedIn: false })));

    const result = await probeProvider("claude-code");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(false);
  });

  it("claude-code auth probe throws → auth_present: false", async () => {
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockRejectedValueOnce(new Error("ENOENT")); // auth status fails

    const result = await probeProvider("claude-code");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(false);
  });

  // ── codex ─────────────────────────────────────────────────────────────────

  it("codex logged in (exit 0 + stdout contains 'Logged in') → auth_present: true", async () => {
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockResolvedValueOnce(ok("Status: Logged in as user@example.com")); // login status

    const result = await probeProvider("codex");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith("codex", ["login", "status"], {
      timeout: 3000,
    });
  });

  it("codex not logged in (non-zero exit) → auth_present: false", async () => {
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockRejectedValueOnce(new Error("exit code 1")); // login status fails

    const result = await probeProvider("codex");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(false);
  });

  it("codex prints 'Logged in' on stderr (real CLI behavior) → auth_present: true", async () => {
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockResolvedValueOnce(ok("", "Logged in using ChatGPT")); // login status writes to stderr

    const result = await probeProvider("codex");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(true);
  });

  it("codex output missing 'Logged in' substring → auth_present: false", async () => {
    mockExeca
      .mockResolvedValueOnce(ok()) // --version
      .mockResolvedValueOnce(ok("Status: Not authenticated")); // exit 0 but no "Logged in"

    const result = await probeProvider("codex");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(false);
  });

  // ── gemini-cli ────────────────────────────────────────────────────────────

  it("gemini-cli always returns auth_present: false", async () => {
    mockExeca.mockResolvedValueOnce(ok()); // --version

    const result = await probeProvider("gemini-cli");

    expect(result.status).toBe("healthy");
    expect(result.auth_present).toBe(false);
    // Should only have called --version, no auth probe
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith("gemini", ["--version"], {
      timeout: 2000,
    });
  });

  // ── binary missing ────────────────────────────────────────────────────────

  it("binary missing (status=down) → auth_present: false, login check skipped", async () => {
    mockExeca.mockRejectedValueOnce(new Error("ENOENT: command not found"));

    const result = await probeProvider("claude-code");

    expect(result.status).toBe("down");
    expect(result.auth_present).toBe(false);
    // Only the --version call, no auth probe
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});
