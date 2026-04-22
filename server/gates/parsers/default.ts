/**
 * Default gate output parser.
 *
 * Used when no specific parser matches the gate command. Captures the
 * first 2000 chars of stderr (or stdout if stderr is empty) as a single
 * failure excerpt.
 */

import type { GateFailure } from "./types.js";

/** Capture stderr (falling back to stdout) as a single failure. */
export function parseDefaultOutput(
  stdout: string,
  stderr: string,
): GateFailure[] {
  const raw = stderr.trim() || stdout.trim();
  if (!raw) return [];
  return [
    {
      category: "gate:failed",
      excerpt: raw.slice(0, 2000),
    },
  ];
}
