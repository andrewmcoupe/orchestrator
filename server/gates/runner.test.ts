/**
 * Gate runner tests.
 *
 * Tests cover:
 *  - Parsers: tsc, eslint, vitest, pytest, default
 *  - selectParser: command string routing
 *  - runGate: passing gate, failing gate, timed-out gate (using fake commands)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { initProjections } from "../projectionRunner.js";
import "../projections/register.js";
import { runGate, selectParser } from "./runner.js";
import { registerGate, clearGateRegistry } from "./registry.js";
import type { GateConfig } from "@shared/events.js";

// ============================================================================
// Parser unit tests
// ============================================================================

import { parseTscOutput } from "./parsers/tsc.js";
import { parseEslintOutput } from "./parsers/eslint.js";
import { parseVitestOutput } from "./parsers/vitest.js";
import { parsePytestOutput } from "./parsers/pytest.js";
import { parseDefaultOutput } from "./parsers/default.js";

describe("parseTscOutput", () => {
  it("parses a standard TSC error line", () => {
    const output =
      "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const failures = parseTscOutput(output);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "tsc:TS2322",
      location: { path: "src/foo.ts", line: 10, col: 5 },
      excerpt: "Type 'string' is not assignable to type 'number'.",
    });
  });

  it("returns empty array for output with no errors", () => {
    expect(parseTscOutput("Found 0 errors.")).toHaveLength(0);
  });

  it("parses multiple errors", () => {
    const output = [
      "src/a.ts(1,1): error TS1001: msg1",
      "src/b.ts(2,3): error TS1002: msg2",
    ].join("\n");
    expect(parseTscOutput(output)).toHaveLength(2);
  });
});

describe("parseEslintOutput", () => {
  it("parses ESLint JSON output", () => {
    const json = JSON.stringify([
      {
        filePath: "/app/src/foo.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "'x' is defined but never used.",
            line: 5,
            column: 7,
          },
        ],
      },
    ]);
    const failures = parseEslintOutput(json);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "eslint:no-unused-vars",
      location: { path: "/app/src/foo.ts", line: 5, col: 7 },
      excerpt: "'x' is defined but never used.",
    });
  });

  it("ignores severity 0 (info) messages", () => {
    const json = JSON.stringify([
      {
        filePath: "/app/src/foo.ts",
        messages: [
          {
            ruleId: "some-rule",
            severity: 0,
            message: "info",
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    expect(parseEslintOutput(json)).toHaveLength(0);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseEslintOutput("not json")).toHaveLength(0);
  });
});

describe("parseVitestOutput", () => {
  it("parses failed test results", () => {
    const json = JSON.stringify({
      success: false,
      testResults: [
        {
          testFilePath: "/app/src/foo.test.ts",
          testResults: [
            {
              fullName: "should add numbers",
              status: "failed",
              failureMessages: ["Expected 3 but received 4"],
            },
          ],
        },
      ],
    });
    const failures = parseVitestOutput(json);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "test:failed",
      location: { path: "/app/src/foo.test.ts", line: 1 },
    });
    expect(failures[0].excerpt).toContain("should add numbers");
  });

  it("returns empty array when all tests pass", () => {
    const json = JSON.stringify({
      success: true,
      testResults: [
        {
          testFilePath: "/app/src/foo.test.ts",
          testResults: [{ fullName: "ok", status: "passed" }],
        },
      ],
    });
    expect(parseVitestOutput(json)).toHaveLength(0);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseVitestOutput("not json")).toHaveLength(0);
  });
});

describe("parsePytestOutput", () => {
  it("parses pytest JSON report failures", () => {
    const json = JSON.stringify({
      tests: [
        {
          nodeid: "tests/test_foo.py::test_bar",
          outcome: "failed",
          call: { longrepr: "AssertionError: 1 != 2" },
        },
      ],
    });
    const failures = parsePytestOutput(json);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "pytest:failed",
      location: { path: "tests/test_foo.py" },
      excerpt: "AssertionError: 1 != 2",
    });
  });

  it("ignores passed tests", () => {
    const json = JSON.stringify({
      tests: [{ nodeid: "tests/test_foo.py::test_ok", outcome: "passed" }],
    });
    expect(parsePytestOutput(json)).toHaveLength(0);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parsePytestOutput("not json")).toHaveLength(0);
  });
});

describe("parseDefaultOutput", () => {
  it("captures stderr as a single failure", () => {
    const failures = parseDefaultOutput("", "some error occurred");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "gate:failed",
      excerpt: "some error occurred",
    });
  });

  it("falls back to stdout when stderr is empty", () => {
    const failures = parseDefaultOutput("stdout content", "");
    expect(failures[0].excerpt).toBe("stdout content");
  });

  it("returns empty array when both stdout and stderr are empty", () => {
    expect(parseDefaultOutput("", "")).toHaveLength(0);
  });

  it("truncates long output to 2000 chars", () => {
    const long = "x".repeat(3000);
    const failures = parseDefaultOutput("", long);
    expect(failures[0].excerpt).toHaveLength(2000);
  });
});

// ============================================================================
// selectParser tests
// ============================================================================

describe("selectParser", () => {
  it("selects tsc parser for tsc command", () => {
    const parser = selectParser("pnpm tsc --noEmit");
    // Should not crash on tsc-style output
    const result = parser("src/a.ts(1,2): error TS1001: oops", "");
    expect(result[0].category).toMatch(/^tsc:/);
  });

  it("selects tsc parser for typecheck command", () => {
    const parser = selectParser("pnpm typecheck");
    const result = parser("", "src/a.ts(1,2): error TS1001: oops");
    expect(result[0].category).toMatch(/^tsc:/);
  });

  it("selects eslint parser for eslint command", () => {
    const parser = selectParser("pnpm eslint --format json .");
    const json = JSON.stringify([
      {
        filePath: "/f.ts",
        messages: [
          { ruleId: "r", severity: 2, message: "m", line: 1, column: 1 },
        ],
      },
    ]);
    const result = parser(json, "");
    expect(result[0].category).toMatch(/^eslint:/);
  });

  it("selects vitest parser for vitest command", () => {
    const parser = selectParser("pnpm vitest run --reporter json");
    const json = JSON.stringify({
      testResults: [
        {
          testFilePath: "/f.test.ts",
          testResults: [
            { fullName: "t", status: "failed", failureMessages: ["e"] },
          ],
        },
      ],
    });
    const result = parser(json, "");
    expect(result[0].category).toBe("test:failed");
  });

  it("selects default parser for unknown commands", () => {
    const parser = selectParser("make lint");
    const result = parser("", "something failed");
    expect(result[0].category).toBe("gate:failed");
  });
});

// ============================================================================
// runGate integration tests (using real in-memory SQLite)
// ============================================================================

describe("runGate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    initProjections(db);
    clearGateRegistry();
  });

  afterEach(() => {
    db.close();
    clearGateRegistry();
  });

  const baseGate: GateConfig = {
    name: "test-gate",
    command: "true", // Unix true — always exits 0
    required: true,
    timeout_seconds: 5,
    on_fail: "fail_task",
  };

  it("appends gate.started + gate.passed for a passing command", async () => {
    registerGate(baseGate);
    const result = await runGate(db, baseGate, "attempt-001", "/tmp");
    expect(result.status).toBe("passed");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.failures).toBeUndefined();

    // Check events were written
    const events = db
      .prepare("SELECT type FROM events ORDER BY ts ASC")
      .all() as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("gate.started");
    expect(types).toContain("gate.passed");
  });

  it("appends gate.started + gate.failed for a failing command", async () => {
    const failGate: GateConfig = {
      ...baseGate,
      command: "false", // exits 1
    };
    // Use the default parser (no specific parser for "false")
    const result = await runGate(db, failGate, "attempt-002", "/tmp");
    expect(result.status).toBe("failed");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    const events = db
      .prepare("SELECT type FROM events ORDER BY ts ASC")
      .all() as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("gate.started");
    expect(types).toContain("gate.failed");
  });

  it("uses the injected parser on failure", async () => {
    const failGate: GateConfig = {
      ...baseGate,
      command: "false",
    };
    const customParser = (_stdout: string, _stderr: string) => [
      { category: "custom:failure", excerpt: "custom excerpt" },
    ];
    const result = await runGate(
      db,
      failGate,
      "attempt-003",
      "/tmp",
      customParser,
    );
    expect(result.status).toBe("failed");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].category).toBe("custom:failure");
  });

  it("sets correlation_id on all gate events", async () => {
    registerGate(baseGate);
    await runGate(db, baseGate, "attempt-123", "/tmp");

    const events = db
      .prepare(
        "SELECT type, correlation_id FROM events WHERE type IN ('gate.started', 'gate.passed')",
      )
      .all() as Array<{ type: string; correlation_id: string }>;
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.correlation_id).toBe("attempt-123");
    }
  });

  it("appends gate.timed_out for a command that exceeds timeout", async () => {
    const slowGate: GateConfig = {
      ...baseGate,
      command: "sleep 60",
      timeout_seconds: 0.1, // 100ms
    };
    const result = await runGate(db, slowGate, "attempt-timeout", "/tmp");
    expect(result.status).toBe("timed_out");

    const events = db
      .prepare("SELECT type FROM events ORDER BY ts ASC")
      .all() as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("gate.started");
    expect(types).toContain("gate.timed_out");
  }, 30_000);
});
