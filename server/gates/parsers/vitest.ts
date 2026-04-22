/**
 * Vitest / Jest failure parser.
 *
 * Parses the JSON reporter output from vitest --reporter=json or
 * jest --json. Both produce a compatible top-level shape.
 */

import type { GateFailure } from "./types.js";

type TestResult = {
  testFilePath?: string;
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  failureMessages?: string[];
  status?: string;
};

type SuiteResult = {
  testFilePath?: string;
  testResults?: TestResult[];
  status?: string;
};

type VitestJson = {
  testResults?: SuiteResult[];
  success?: boolean;
};

/** Parse vitest/jest JSON reporter output into structured failures. */
export function parseVitestOutput(output: string): GateFailure[] {
  let report: VitestJson;
  try {
    report = JSON.parse(output.trim()) as VitestJson;
  } catch {
    return [];
  }

  const failures: GateFailure[] = [];
  for (const suite of report.testResults ?? []) {
    for (const test of suite.testResults ?? []) {
      if (test.status === "failed") {
        const name = test.fullName ?? test.title ?? "unknown test";
        const file = suite.testFilePath ?? test.testFilePath ?? "unknown";
        const excerpt = (test.failureMessages ?? []).join("\n").slice(0, 500);
        failures.push({
          category: "test:failed",
          location: { path: file, line: 1 },
          excerpt: `${name}: ${excerpt}`,
        });
      }
    }
  }
  return failures;
}
