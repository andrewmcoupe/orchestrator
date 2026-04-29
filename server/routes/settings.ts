/**
 * Settings routes — gate library CRUD, global defaults, about info,
 * and maintenance operations.
 */
import { Hono } from "hono";
import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { appendAndProject, rebuildProjection } from "../projectionRunner.js";
import { listGates, registerGate, clearGateRegistry, loadGateRegistry } from "../gates/registry.js";
import type { Actor, GateConfig } from "@shared/events.js";
import type { ProjectionName } from "@shared/projections.js";
import { getDbPath, getCredentialsPath, getDefaultRepoRoot } from "../paths.js";

const DEFAULT_ACTOR: Actor = { kind: "user", user_id: "local" };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
).version as string;

const DB_PATH = getDbPath();

const gateConfigBodySchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  required: z.boolean(),
  timeout_seconds: z.number().int().positive(),
  on_fail: z.enum(["retry", "retry_with_context", "skip", "fail_task"]),
});

const defaultsBodySchema = z.object({
  default_preset_id: z.string().nullable().optional(),
  auto_delete_worktree_on_merge: z.boolean().optional(),
  auto_pause_on_external_fs_change: z.boolean().optional(),
});

const VALID_PROJECTION_NAMES: ProjectionName[] = [
  "task_list", "task_detail", "proposition", "attempt",
  "provider_health", "prompt_library", "ab_experiment",
  "cost_rollup", "preset", "settings", "gate_library",
];

function badRequest(detail: string | z.ZodError) {
  if (detail instanceof z.ZodError) {
    return Response.json(
      { type: "validation_error", status: 400, detail: "Request body validation failed", errors: detail.errors },
      { status: 400 },
    );
  }
  return Response.json({ type: "bad_request", status: 400, detail }, { status: 400 });
}

export function createSettingsRoutes(db: Database.Database) {
  const app = new Hono();

  // ── GET /api/settings/gates ──────────────────────────────────────────────
  // Returns union of config.yaml gates + proj_gate_library (custom gates)
  app.get("/api/settings/gates", (c) => {
    const configGates = listGates();

    // Also fetch custom gates from projection (may not exist yet)
    let customGates: GateConfig[] = [];
    try {
      const rows = db
        .prepare("SELECT * FROM proj_gate_library ORDER BY gate_name")
        .all() as Array<Record<string, unknown>>;
      customGates = rows.map((r) => ({
        name: r.gate_name as string,
        command: r.command as string,
        required: Boolean(r.required),
        timeout_seconds: r.timeout_seconds as number,
        on_fail: r.on_fail as GateConfig["on_fail"],
      }));
    } catch {
      // table not yet created — ignore
    }

    // Custom gates override config.yaml gates of the same name
    const customNames = new Set(customGates.map((g) => g.name));
    const configOnlyGates = configGates.filter((g) => !customNames.has(g.name));

    return c.json({
      config_gates: configGates,
      library_gates: customGates,
      all_gates: [
        ...configOnlyGates.map((g) => ({ ...g, source: "config" as const })),
        ...customGates.map((g) => ({ ...g, source: "library" as const })),
      ],
      config_gate_names: [...new Set(configGates.map((g) => g.name))],
    });
  });

  // ── POST /api/commands/gate_library/add ─────────────────────────────────
  app.post("/api/commands/gate_library/add", async (c) => {
    const parsed = gateConfigBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    const gate = parsed.data;
    const event = appendAndProject(db, {
      type: "gate_library.gate_added",
      aggregate_type: "gate_library",
      aggregate_id: gate.name,
      actor: DEFAULT_ACTOR,
      payload: { gate },
    });

    // Also register in the in-memory registry so it's immediately usable
    registerGate(gate);

    return c.json(event);
  });

  // ── POST /api/commands/gate_library/update/:name ─────────────────────────
  app.post("/api/commands/gate_library/update/:name", async (c) => {
    const name = c.req.param("name");
    const parsed = gateConfigBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    // name from URL takes precedence
    const gate = { ...parsed.data, name };
    const event = appendAndProject(db, {
      type: "gate_library.gate_updated",
      aggregate_type: "gate_library",
      aggregate_id: name,
      actor: DEFAULT_ACTOR,
      payload: { gate_name: name, gate },
    });

    // Update in-memory registry
    registerGate(gate);

    return c.json(event);
  });

  // ── POST /api/commands/gate_library/remove/:name ─────────────────────────
  app.post("/api/commands/gate_library/remove/:name", (c) => {
    const name = c.req.param("name");
    const event = appendAndProject(db, {
      type: "gate_library.gate_removed",
      aggregate_type: "gate_library",
      aggregate_id: name,
      actor: DEFAULT_ACTOR,
      payload: { gate_name: name },
    });

    // Clear and reload registry to remove the gate
    clearGateRegistry();
    loadGateRegistry();

    return c.json(event);
  });

  // ── GET /api/settings/defaults ───────────────────────────────────────────
  app.get("/api/settings/defaults", (c) => {
    let row: Record<string, unknown> | undefined;
    try {
      row = db
        .prepare("SELECT * FROM proj_settings WHERE settings_id = 'global'")
        .get() as Record<string, unknown> | undefined;
    } catch {
      // table not yet created
    }

    if (!row) {
      return c.json({
        settings_id: "global",
        default_preset_id: null,
        auto_delete_worktree_on_merge: false,
        auto_pause_on_external_fs_change: false,
        auto_merge_enabled: false,
      });
    }

    return c.json({
      settings_id: "global",
      default_preset_id: row.default_preset_id ?? null,
      auto_delete_worktree_on_merge: Boolean(row.auto_delete_worktree_on_merge),
      auto_pause_on_external_fs_change: Boolean(row.auto_pause_on_external_fs_change),
      auto_merge_enabled: Boolean(row.auto_merge_enabled),
    });
  });

  // ── POST /api/commands/settings/defaults ─────────────────────────────────
  app.post("/api/commands/settings/defaults", async (c) => {
    const parsed = defaultsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(parsed.error);

    if (Object.keys(parsed.data).length === 0) {
      return badRequest("No changes provided");
    }

    const event = appendAndProject(db, {
      type: "settings.changed",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: DEFAULT_ACTOR,
      payload: { settings_id: "global", changes: parsed.data },
    });

    return c.json(event);
  });

  // ── POST /api/commands/settings/auto-merge ──────────────────────────────
  app.post("/api/commands/settings/auto-merge", async (c) => {
    const body = await c.req.json() as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return badRequest("'enabled' must be a boolean");
    }

    const event = appendAndProject(db, {
      type: "settings.auto_merge_enabled_set",
      aggregate_type: "settings",
      aggregate_id: "global",
      actor: DEFAULT_ACTOR,
      payload: { enabled: body.enabled },
    });

    return c.json(event);
  });

  // ── GET /api/settings/about ──────────────────────────────────────────────
  app.get("/api/settings/about", (c) => {
    let eventCount = 0;
    let dbSizeBytes = 0;

    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
      eventCount = row.cnt;
    } catch { /* ignore */ }

    try {
      if (existsSync(DB_PATH)) {
        dbSizeBytes = statSync(DB_PATH).size;
      }
    } catch { /* ignore */ }

    return c.json({
      version: VERSION,
      event_count: eventCount,
      db_size_bytes: dbSizeBytes,
      db_path: DB_PATH,
      env_local_path: getCredentialsPath(),
      repo_root: getDefaultRepoRoot(),
      projections: VALID_PROJECTION_NAMES,
    });
  });

  // ── POST /api/maintenance/rebuild/:projection ─────────────────────────────
  app.post("/api/maintenance/rebuild/:projection", (c) => {
    const name = c.req.param("projection") as ProjectionName;
    if (!VALID_PROJECTION_NAMES.includes(name)) {
      return Response.json(
        { type: "not_found", status: 404, detail: `Unknown projection '${name}'` },
        { status: 404 },
      );
    }

    try {
      rebuildProjection(db, name);
      return c.json({ ok: true, projection: name });
    } catch (err) {
      return Response.json(
        { type: "server_error", status: 500, detail: String(err) },
        { status: 500 },
      );
    }
  });

  return app;
}
