/**
 * Deterministic A/B variant assignment.
 *
 * Given an experiment and a task context (task_id + phase_name), consistently
 * returns the same variant ("A" or "B") every time. Stability is guaranteed by
 * hashing the evaluated bucket key with SHA-256 — same inputs always produce
 * the same bucket number, and the same bucket always maps to the same variant.
 *
 * The split is read from the proj_ab_experiment table (split_a column), so a
 * 70/30 split will route ~70% of unique task:phase combinations to variant A.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Assigns a variant for the given experiment, task, and phase.
 *
 * Algorithm:
 *   1. Load the experiment row (split_a weight from 0–100).
 *   2. Compute SHA-256 of "${taskId}:${phaseName}".
 *   3. Take the first 8 hex chars as a uint32, mod 100 → bucket [0, 99].
 *   4. If bucket < split_a, return "A"; otherwise return "B".
 *
 * Throws if the experiment is not found in the database.
 */
export function assign(
  db: Database.Database,
  experimentId: string,
  taskId: string,
  phaseName: string,
): "A" | "B" {
  const row = db
    .prepare(
      "SELECT split_a, bucket_key FROM proj_ab_experiment WHERE experiment_id = ?",
    )
    .get(experimentId) as { split_a: number; bucket_key: string } | undefined;

  if (!row) throw new Error(`Unknown experiment: ${experimentId}`);

  // Evaluate the bucket key by substituting task_id and phase_name
  const bucketKey = `${taskId}:${phaseName}`;

  // SHA-256 of the key, take first 8 hex chars → uint32 → mod 100
  const hash = createHash("sha256").update(bucketKey).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;

  return bucket < row.split_a ? "A" : "B";
}
