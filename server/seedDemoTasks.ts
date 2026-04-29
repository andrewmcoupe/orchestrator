/**
 * Seeds a handful of demo tasks on first run so the UI isn't empty.
 *
 * Idempotent — if any task.created events already exist, this is a no-op.
 * All demo tasks use a "[demo]" prefix so they're easy to identify and clean up.
 */

import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { appendAndProject } from "./projectionRunner.js";
import { DEFAULT_TASK_CONFIG } from "@shared/projections.js";

const SEED_ACTOR = { kind: "system" as const, component: "seed" as const };

const monotonic = monotonicFactory();

interface DemoTask {
  title: string;
  /** Status to transition to after creation (tasks start as "queued") */
  targetStatus?: "running" | "merged";
}

const DEMO_TASKS: DemoTask[] = [
  {
    title: "[demo] Add a README.md with project setup instructions",
    targetStatus: "merged",
  },
  {
    title: "[demo] Set up a basic CI pipeline for linting and tests",
  },
  {
    title: "[demo] Audit dependencies for known security vulnerabilities",
  },
];

export function seedDemoTasks(db: Database.Database): void {
  // Skip if any tasks already exist (demo or real)
  const existing = db
    .prepare("SELECT id FROM events WHERE type = 'task.created' LIMIT 1")
    .get();
  if (existing) return;

  for (const demo of DEMO_TASKS) {
    const taskId = `T-${monotonic()}`;

    // Create the task (starts as "queued")
    appendAndProject(db, {
      type: "task.created",
      aggregate_type: "task",
      aggregate_id: taskId,
      actor: SEED_ACTOR,
      payload: {
        task_id: taskId,
        title: demo.title,
        proposition_ids: [],
        config_snapshot: DEFAULT_TASK_CONFIG,
      },
    });

    // Transition to target status if needed
    if (demo.targetStatus === "running") {
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: SEED_ACTOR,
        payload: {
          task_id: taskId,
          from: "queued",
          to: "running",
        },
      });
    } else if (demo.targetStatus === "merged") {
      // queued → running → merged
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: SEED_ACTOR,
        payload: {
          task_id: taskId,
          from: "queued",
          to: "running",
        },
      });
      appendAndProject(db, {
        type: "task.status_changed",
        aggregate_type: "task",
        aggregate_id: taskId,
        actor: SEED_ACTOR,
        payload: {
          task_id: taskId,
          from: "running",
          to: "merged",
        },
      });
    }
  }
}
