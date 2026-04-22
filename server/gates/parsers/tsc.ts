/**
 * TSC failure parser.
 *
 * Parses TypeScript compiler stderr/stdout lines of the form:
 *   path/to/file.ts(line,col): error TS2322: Type '...' is not assignable to ...
 */

import type { GateFailure } from "./types.js";

// Matches: file.ts(10,5): error TS2322: message
const TSC_ERROR_RE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/** Parse tsc output lines into structured failures. */
export function parseTscOutput(output: string): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const line of output.split("\n")) {
    const m = line.trim().match(TSC_ERROR_RE);
    if (m) {
      const [, path, lineStr, colStr, code, message] = m;
      failures.push({
        category: `tsc:${code}`,
        location: {
          path: path.trim(),
          line: parseInt(lineStr, 10),
          col: parseInt(colStr, 10),
        },
        excerpt: message.trim(),
      });
    }
  }
  return failures;
}
