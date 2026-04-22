/**
 * pytest failure parser.
 *
 * Parses pytest --json-report output (via pytest-json-report plugin).
 * The report has a top-level `tests` array with nodeid, outcome, and longrepr.
 */

import type { GateFailure } from "./types.js";

type PytestTest = {
  nodeid?: string;
  outcome?: string;
  call?: { longrepr?: string };
};

type PytestReport = {
  tests?: PytestTest[];
};

// Match file::test_name or file.py::Class::test_name for a line hint
const NODEID_RE = /^(.+\.py)(?:::\S+)?(?::(\d+))?/;

/** Parse pytest --json-report output into structured failures. */
export function parsePytestOutput(output: string): GateFailure[] {
  let report: PytestReport;
  try {
    report = JSON.parse(output.trim()) as PytestReport;
  } catch {
    return [];
  }

  const failures: GateFailure[] = [];
  for (const test of report.tests ?? []) {
    if (test.outcome === "failed") {
      const nodeId = test.nodeid ?? "unknown";
      const m = nodeId.match(NODEID_RE);
      const filePath = m ? m[1] : nodeId;
      const line = m?.[2] ? parseInt(m[2], 10) : 1;
      const excerpt = (test.call?.longrepr ?? nodeId).slice(0, 500);
      failures.push({
        category: "pytest:failed",
        location: { path: filePath, line },
        excerpt,
      });
    }
  }
  return failures;
}
