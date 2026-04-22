import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { appendAndProject, initProjections } from "../projectionRunner.js";
import { createPromptCommandRoutes } from "./promptCommands.js";
import type { Actor } from "@shared/events.js";

// Register projections (includes promptLibrary and abExperiment)
import "../projections/register.js";

// ============================================================================
// Helpers
// ============================================================================

const actor: Actor = { kind: "user", user_id: "test" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  initProjections(db);
  return db;
}

async function req(
  app: ReturnType<typeof createPromptCommandRoutes>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

/** Seed a prompt version directly into the projection for use in tests. */
function seedPromptVersion(
  db: Database.Database,
  id: string,
  opts: { name?: string; phase_class?: string; template_hash?: string } = {},
) {
  appendAndProject(db, {
    type: "prompt_version.created",
    aggregate_type: "prompt_version",
    aggregate_id: id,
    actor,
    payload: {
      prompt_version_id: id,
      name: opts.name ?? `Prompt ${id}`,
      phase_class: opts.phase_class ?? "implementer",
      template: "template content",
      template_hash: opts.template_hash ?? "a".repeat(64),
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("prompt_version command routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createPromptCommandRoutes>;

  beforeEach(() => {
    db = makeDb();
    app = createPromptCommandRoutes(db);
  });

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  it("POST /api/commands/prompt_version/create returns 200 and event", async () => {
    const res = await req(app, "POST", "/api/commands/prompt_version/create", {
      name: "Implementer v1",
      phase_class: "implementer",
      template: "You are an implementer. Task: {{task}}",
    });
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("prompt_version.created");
    expect(event.payload.name).toBe("Implementer v1");
    expect(event.payload.phase_class).toBe("implementer");
  });

  it("new version appears in proj_prompt_library", async () => {
    await req(app, "POST", "/api/commands/prompt_version/create", {
      name: "Visible Prompt",
      phase_class: "auditor",
      template: "Audit this: {{content}}",
    });

    const row = db
      .prepare(
        "SELECT name FROM proj_prompt_library WHERE name = 'Visible Prompt'",
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("Visible Prompt");
  });

  it("returns 400 on missing required fields", async () => {
    const res = await req(app, "POST", "/api/commands/prompt_version/create", {
      phase_class: "implementer",
      // missing name and template
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });

  it("stores parent_version_id and notes when provided", async () => {
    const parentRes = await req(
      app,
      "POST",
      "/api/commands/prompt_version/create",
      {
        name: "Parent Prompt",
        phase_class: "implementer",
        template: "parent template",
      },
    );
    const parentEvent = await parentRes.json();
    const parentId = parentEvent.payload.prompt_version_id;

    const childRes = await req(
      app,
      "POST",
      "/api/commands/prompt_version/create",
      {
        name: "Child Prompt",
        phase_class: "implementer",
        template: "child template",
        parent_version_id: parentId,
        notes: "Improved version",
      },
    );
    expect(childRes.status).toBe(200);
    const childEvent = await childRes.json();
    expect(childEvent.payload.parent_version_id).toBe(parentId);
    expect(childEvent.payload.notes).toBe("Improved version");
  });

  // --------------------------------------------------------------------------
  // Retire
  // --------------------------------------------------------------------------

  it("POST /api/commands/prompt_version/:id/retire returns 200", async () => {
    seedPromptVersion(db, "pv-to-retire");

    const res = await req(
      app,
      "POST",
      "/api/commands/prompt_version/pv-to-retire/retire",
      {},
    );
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("prompt_version.retired");
  });

  it("retire marks the version as retired in the projection", async () => {
    seedPromptVersion(db, "pv-check-retired");

    await req(
      app,
      "POST",
      "/api/commands/prompt_version/pv-check-retired/retire",
      {},
    );

    const row = db
      .prepare(
        "SELECT retired FROM proj_prompt_library WHERE prompt_version_id = 'pv-check-retired'",
      )
      .get() as { retired: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.retired).toBe(1);
  });

  it("retire returns 404 for nonexistent prompt version", async () => {
    const res = await req(
      app,
      "POST",
      "/api/commands/prompt_version/does-not-exist/retire",
      {},
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });
});

describe("ab_experiment command routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createPromptCommandRoutes>;

  beforeEach(() => {
    db = makeDb();
    app = createPromptCommandRoutes(db);
    // Seed two prompt versions for experiments
    seedPromptVersion(db, "pv-a", { phase_class: "implementer" });
    seedPromptVersion(db, "pv-b", {
      phase_class: "implementer",
      template_hash: "b".repeat(64),
    });
  });

  // --------------------------------------------------------------------------
  // Create experiment
  // --------------------------------------------------------------------------

  it("POST /api/commands/ab_experiment/create returns 200 and event", async () => {
    const res = await req(app, "POST", "/api/commands/ab_experiment/create", {
      phase_class: "implementer",
      variant_a_id: "pv-a",
      variant_b_id: "pv-b",
    });
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("ab_experiment.created");
    expect(event.payload.phase_class).toBe("implementer");
    expect(event.payload.variants.A).toBe("pv-a");
    expect(event.payload.variants.B).toBe("pv-b");
  });

  it("new experiment appears in proj_ab_experiment", async () => {
    await req(app, "POST", "/api/commands/ab_experiment/create", {
      phase_class: "implementer",
      variant_a_id: "pv-a",
      variant_b_id: "pv-b",
    });

    const count = (
      db.prepare("SELECT COUNT(*) as n FROM proj_ab_experiment").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await req(app, "POST", "/api/commands/ab_experiment/create", {
      phase_class: "implementer",
      // missing variant_a_id and variant_b_id
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });

  it("returns 404 when variant_a_id does not exist", async () => {
    const res = await req(app, "POST", "/api/commands/ab_experiment/create", {
      phase_class: "implementer",
      variant_a_id: "nonexistent",
      variant_b_id: "pv-b",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when variant_b_id does not exist", async () => {
    const res = await req(app, "POST", "/api/commands/ab_experiment/create", {
      phase_class: "implementer",
      variant_a_id: "pv-a",
      variant_b_id: "nonexistent",
    });
    expect(res.status).toBe(404);
  });

  // --------------------------------------------------------------------------
  // Conclude experiment
  // --------------------------------------------------------------------------

  it("POST /api/commands/ab_experiment/:id/conclude returns 200", async () => {
    // Create experiment via direct event
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-to-conclude",
      actor,
      payload: {
        experiment_id: "exp-to-conclude",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [50, 50],
        bucket_key: "key",
      },
    });

    const res = await req(
      app,
      "POST",
      "/api/commands/ab_experiment/exp-to-conclude/conclude",
      {
        winner: "A",
        reason: "A was better",
        stats: {
          a: { n: 30, success_rate: 0.9, avg_cost_usd: 0.01 },
          b: { n: 30, success_rate: 0.7, avg_cost_usd: 0.015 },
        },
      },
    );
    expect(res.status).toBe(200);
    const event = await res.json();
    expect(event.type).toBe("ab_experiment.concluded");
  });

  it("returns 409 when concluding an already-concluded experiment", async () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-double-conclude",
      actor,
      payload: {
        experiment_id: "exp-double-conclude",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [50, 50],
        bucket_key: "key",
      },
    });
    appendAndProject(db, {
      type: "ab_experiment.concluded",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-double-conclude",
      actor,
      payload: {
        experiment_id: "exp-double-conclude",
        winner: "A",
        reason: "first time",
        stats: {
          a: { n: 10, success_rate: 0.8, avg_cost_usd: 0.01 },
          b: { n: 10, success_rate: 0.6, avg_cost_usd: 0.01 },
        },
      },
    });

    const res = await req(
      app,
      "POST",
      "/api/commands/ab_experiment/exp-double-conclude/conclude",
      {
        reason: "second time",
        stats: {
          a: { n: 10, success_rate: 0.8, avg_cost_usd: 0.01 },
          b: { n: 10, success_rate: 0.6, avg_cost_usd: 0.01 },
        },
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("conflict");
  });

  it("returns 404 when concluding a nonexistent experiment", async () => {
    const res = await req(
      app,
      "POST",
      "/api/commands/ab_experiment/ghost-exp/conclude",
      {
        reason: "does not exist",
        stats: {
          a: { n: 0, success_rate: 0, avg_cost_usd: 0 },
          b: { n: 0, success_rate: 0, avg_cost_usd: 0 },
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("conclude returns 400 on missing reason", async () => {
    appendAndProject(db, {
      type: "ab_experiment.created",
      aggregate_type: "ab_experiment",
      aggregate_id: "exp-bad-body",
      actor,
      payload: {
        experiment_id: "exp-bad-body",
        phase_class: "implementer",
        variants: { A: "pv-a", B: "pv-b" },
        split: [50, 50],
        bucket_key: "key",
      },
    });

    const res = await req(
      app,
      "POST",
      "/api/commands/ab_experiment/exp-bad-body/conclude",
      {
        // missing reason
        stats: {
          a: { n: 0, success_rate: 0, avg_cost_usd: 0 },
          b: { n: 0, success_rate: 0, avg_cost_usd: 0 },
        },
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });
});
