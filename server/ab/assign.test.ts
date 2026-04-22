import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { appendAndProject, initProjections } from "../projectionRunner.js";
import type { Actor } from "@shared/events.js";
import { assign } from "./assign.js";

// Register projections (includes ab_experiment)
import "../projections/register.js";

const actor: Actor = { kind: "user", user_id: "test" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

/** Seeds one experiment into the projection table via events. */
function seedExperiment(
  db: Database.Database,
  experimentId: string,
  splitA: number,
): void {
  appendAndProject(db, {
    type: "ab_experiment.created",
    aggregate_type: "ab_experiment",
    aggregate_id: experimentId,
    actor,
    payload: {
      experiment_id: experimentId,
      phase_class: "implementer",
      variants: { A: `pv-${experimentId}-a`, B: `pv-${experimentId}-b` },
      split: [splitA, 100 - splitA],
      bucket_key: "${task_id}:implementer",
    },
  });
}

describe("assign", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("throws for an unknown experiment", () => {
    expect(() => assign(db, "nonexistent-exp", "task-1", "implementer")).toThrow(
      "Unknown experiment: nonexistent-exp",
    );
  });

  it("returns 'A' or 'B' for a known experiment", () => {
    seedExperiment(db, "exp-basic", 50);
    const variant = assign(db, "exp-basic", "task-1", "implementer");
    expect(["A", "B"]).toContain(variant);
  });

  it("is deterministic — same inputs always return the same variant", () => {
    seedExperiment(db, "exp-det", 50);
    const first = assign(db, "exp-det", "task-abc", "implementer");
    const second = assign(db, "exp-det", "task-abc", "implementer");
    const third = assign(db, "exp-det", "task-abc", "implementer");
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("different task_ids can produce different variants", () => {
    seedExperiment(db, "exp-diff", 50);
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(assign(db, "exp-diff", `task-${i}`, "implementer"));
    }
    // With 100 tasks and a 50/50 split, we should see both variants
    expect(results).toContain("A");
    expect(results).toContain("B");
  });

  it("50/50 split distributes within ~5% of equal across 1000 task_ids", () => {
    seedExperiment(db, "exp-50-50", 50);
    let countA = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (assign(db, "exp-50-50", `task-${i}`, "implementer") === "A") {
        countA++;
      }
    }
    const ratioA = countA / total;
    // Expect approximately 50%, within 5%
    expect(ratioA).toBeGreaterThan(0.45);
    expect(ratioA).toBeLessThan(0.55);
  });

  it("70/30 split routes ~70% to variant A", () => {
    seedExperiment(db, "exp-70-30", 70);
    let countA = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (assign(db, "exp-70-30", `task-${i}`, "implementer") === "A") {
        countA++;
      }
    }
    const ratioA = countA / total;
    // Expect approximately 70%, within 5%
    expect(ratioA).toBeGreaterThan(0.65);
    expect(ratioA).toBeLessThan(0.75);
  });

  it("phase_name is included in the bucket key — different phases can get different variants", () => {
    seedExperiment(db, "exp-phase", 50);
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(assign(db, "exp-phase", `task-${i}`, "implementer"));
      results.add(assign(db, "exp-phase", `task-${i}`, "auditor"));
    }
    // Should see both variants across different phases
    expect(results.size).toBeGreaterThan(1);
  });

  it("100/0 split always returns A", () => {
    seedExperiment(db, "exp-all-a", 100);
    for (let i = 0; i < 20; i++) {
      expect(assign(db, "exp-all-a", `task-${i}`, "implementer")).toBe("A");
    }
  });

  it("0/100 split always returns B", () => {
    seedExperiment(db, "exp-all-b", 0);
    for (let i = 0; i < 20; i++) {
      expect(assign(db, "exp-all-b", `task-${i}`, "implementer")).toBe("B");
    }
  });
});
