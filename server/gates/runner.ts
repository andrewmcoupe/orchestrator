/**
 * Gate runner — executes a configured gate command in a worktree and
 * translates the outcome into canonical events.
 *
 * Dispatch:
 *   runGate(db, gate, attempt_id, worktree_path) → {status, failures?, duration_ms}
 *
 * Events appended via appendAndProject:
 *   gate.started → gate.passed | gate.failed | gate.timed_out
 *
 * Failure parsing is delegated to specialised parsers selected by
 * inspecting the gate command string:
 *   - tsc / typecheck      → parseTscOutput
 *   - eslint               → parseEslintOutput
 *   - vitest / jest        → parseVitestOutput
 *   - pytest               → parsePytestOutput
 *   - anything else        → parseDefaultOutput (stderr capture)
 *
 * The parser is injected via the optional `parser` param for unit tests.
 */

import { execa, ExecaError } from "execa";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { appendAndProject } from "../projectionRunner.js";
import type { GateConfig } from "@shared/events.js";
import type { GateFailure } from "./parsers/types.js";
import { parseTscOutput } from "./parsers/tsc.js";
import { parseEslintOutput } from "./parsers/eslint.js";
import { parseVitestOutput } from "./parsers/vitest.js";
import { parsePytestOutput } from "./parsers/pytest.js";
import { parseDefaultOutput } from "./parsers/default.js";

// ============================================================================
// Public types
// ============================================================================

export type GateRunStatus = "passed" | "failed" | "timed_out";

export type GateRunResult = {
  status: GateRunStatus;
  failures?: GateFailure[];
  duration_ms: number;
};

/** Injected parser for unit tests (replaces the auto-selected parser). */
export type OutputParser = (stdout: string, stderr: string) => GateFailure[];

// ============================================================================
// Parser selection
// ============================================================================

/**
 * Select the appropriate parser by inspecting the gate command string.
 * Order matters: more-specific checks first.
 */
export function selectParser(command: string): OutputParser {
  const cmd = command.toLowerCase();
  if (cmd.includes("tsc") || cmd.includes("typecheck")) {
    return (stdout, stderr) => parseTscOutput(stderr || stdout);
  }
  if (cmd.includes("eslint")) {
    return (stdout) => {
      const r = parseEslintOutput(stdout);
      return r.length > 0 ? r : parseEslintOutput(stdout);
    };
  }
  if (cmd.includes("vitest") || cmd.includes("jest")) {
    return (stdout, stderr) => {
      const r = parseVitestOutput(stdout);
      return r.length > 0 ? r : parseVitestOutput(stderr);
    };
  }
  if (cmd.includes("pytest")) {
    return (stdout, stderr) => {
      const r = parsePytestOutput(stdout);
      return r.length > 0 ? r : parsePytestOutput(stderr);
    };
  }
  return parseDefaultOutput;
}

// ============================================================================
// runGate
// ============================================================================

/**
 * Execute a gate command in the given worktree, append gate events, and
 * return the outcome.
 *
 * @param db          - SQLite database for appending events.
 * @param gate        - Gate configuration (name, command, timeout_seconds, …).
 * @param attempt_id  - The current attempt this gate belongs to.
 * @param worktree_path - Absolute path to the task worktree (used as cwd).
 * @param parser      - Optional output parser override (for testing).
 */
export async function runGate(
  db: Database.Database,
  gate: GateConfig,
  attempt_id: string,
  worktree_path: string,
  parser?: OutputParser,
): Promise<GateRunResult> {
  const gate_run_id = ulid();
  const actor = { kind: "system" as const, component: "gate_runner" as const };
  const aggregate_id = `gate-run:${gate_run_id}`;

  // Emit gate.started
  await appendAndProject(db, {
    type: "gate.started",
    aggregate_type: "gate",
    aggregate_id,
    actor,
    correlation_id: attempt_id,
    payload: {
      gate_run_id,
      gate_name: gate.name,
      attempt_id,
    },
  });

  const start = Date.now();
  const resolve_parser = parser ?? selectParser(gate.command);

  try {
    const result = await execa(gate.command, {
      shell: true,
      cwd: worktree_path,
      timeout: gate.timeout_seconds * 1000,
      reject: false, // We inspect exitCode manually
      all: true,
    });

    const duration_ms = Date.now() - start;

    // With reject: false, execa sets timedOut=true instead of throwing
    if (result.timedOut) {
      await appendAndProject(db, {
        type: "gate.timed_out",
        aggregate_type: "gate",
        aggregate_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          gate_run_id,
          gate_name: gate.name,
          elapsed_ms: duration_ms,
        },
      });
      return { status: "timed_out", duration_ms };
    }

    if (result.exitCode === 0) {
      // Gate passed
      await appendAndProject(db, {
        type: "gate.passed",
        aggregate_type: "gate",
        aggregate_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          gate_run_id,
          gate_name: gate.name,
          duration_ms,
        },
      });
      return { status: "passed", duration_ms };
    }

    // Gate failed — parse output
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const failures = resolve_parser(stdout, stderr);

    await appendAndProject(db, {
      type: "gate.failed",
      aggregate_type: "gate",
      aggregate_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        gate_run_id,
        gate_name: gate.name,
        duration_ms,
        failures,
      },
    });
    return { status: "failed", failures, duration_ms };
  } catch (err) {
    const duration_ms = Date.now() - start;

    // execa throws on timeout (ETIMEDOUT / timedOut flag)
    const isTimeout =
      err instanceof ExecaError &&
      (err.timedOut === true || err.code === "ETIMEDOUT");

    if (isTimeout) {
      await appendAndProject(db, {
        type: "gate.timed_out",
        aggregate_type: "gate",
        aggregate_id,
        actor,
        correlation_id: attempt_id,
        payload: {
          gate_run_id,
          gate_name: gate.name,
          elapsed_ms: duration_ms,
        },
      });
      return { status: "timed_out", duration_ms };
    }

    // Unexpected error — treat as a failure with the error message
    const excerpt =
      err instanceof Error ? err.message : String(err);
    const failures: GateFailure[] = [
      { category: "gate:error", excerpt: excerpt.slice(0, 2000) },
    ];

    await appendAndProject(db, {
      type: "gate.failed",
      aggregate_type: "gate",
      aggregate_id,
      actor,
      correlation_id: attempt_id,
      payload: {
        gate_run_id,
        gate_name: gate.name,
        duration_ms,
        failures,
      },
    });
    return { status: "failed", failures, duration_ms };
  }
}
