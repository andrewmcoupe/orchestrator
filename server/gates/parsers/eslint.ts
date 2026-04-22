/**
 * ESLint failure parser.
 *
 * Parses ESLint --format json output. The JSON shape is an array of
 * file results each containing a messages array.
 */

import type { GateFailure } from "./types.js";

type EslintMessage = {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
};

type EslintFileResult = {
  filePath: string;
  messages: EslintMessage[];
};

/** Parse ESLint JSON output into structured failures. */
export function parseEslintOutput(output: string): GateFailure[] {
  let results: EslintFileResult[];
  try {
    results = JSON.parse(output.trim()) as EslintFileResult[];
  } catch {
    // If JSON parse fails, return no failures (caller falls back to default)
    return [];
  }

  const failures: GateFailure[] = [];
  for (const file of results) {
    for (const msg of file.messages) {
      if (msg.severity > 0) {
        failures.push({
          category: `eslint:${msg.ruleId ?? "unknown"}`,
          location: {
            path: file.filePath,
            line: msg.line,
            col: msg.column,
          },
          excerpt: msg.message,
        });
      }
    }
  }
  return failures;
}
