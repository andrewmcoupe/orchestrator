/**
 * Settings routes tests — gate library CRUD, defaults, about, maintenance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { initProjections } from "../projectionRunner.js";
import "../projections/register.js";
import { createSettingsRoutes } from "./settings.js";

let db: Database.Database;
let app: ReturnType<typeof createSettingsRoutes>;

describe("Settings routes", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    initProjections(db);
    app = createSettingsRoutes(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── GET /api/settings/gates ──────────────────────────────────────────────
  describe("GET /api/settings/gates", () => {
    it("returns empty gates on fresh DB", async () => {
      const res = await app.request("/api/settings/gates");
      expect(res.status).toBe(200);
      const body = await res.json() as { all_gates: unknown[] };
      expect(body.all_gates).toEqual([]);
    });
  });

  // ── POST /api/commands/gate_library/add ──────────────────────────────────
  describe("POST /api/commands/gate_library/add", () => {
    it("adds a gate and returns the event", async () => {
      const res = await app.request("/api/commands/gate_library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "typecheck",
          command: "tsc --noEmit",
          required: true,
          timeout_seconds: 60,
          on_fail: "fail_task",
        }),
      });
      expect(res.status).toBe(200);
      const event = await res.json() as { type: string };
      expect(event.type).toBe("gate_library.gate_added");
    });

    it("gate appears in GET /api/settings/gates after add", async () => {
      await app.request("/api/commands/gate_library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "eslint",
          command: "eslint . --format json",
          required: false,
          timeout_seconds: 30,
          on_fail: "skip",
        }),
      });

      const res = await app.request("/api/settings/gates");
      const body = await res.json() as { all_gates: Array<{ name: string; source: string }> };
      const gate = body.all_gates.find((g) => g.name === "eslint");
      expect(gate).toBeDefined();
      expect(gate?.source).toBe("library");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await app.request("/api/commands/gate_library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/commands/gate_library/remove/:name ─────────────────────────
  describe("POST /api/commands/gate_library/remove/:name", () => {
    it("removes a previously added gate", async () => {
      await app.request("/api/commands/gate_library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "to-remove", command: "echo ok", required: true, timeout_seconds: 10, on_fail: "skip" }),
      });

      await app.request("/api/commands/gate_library/remove/to-remove", { method: "POST" });

      const res = await app.request("/api/settings/gates");
      const body = await res.json() as { all_gates: Array<{ name: string }> };
      expect(body.all_gates.find((g) => g.name === "to-remove")).toBeUndefined();
    });
  });

  // ── GET /api/settings/defaults ───────────────────────────────────────────
  describe("GET /api/settings/defaults", () => {
    it("returns defaults with false values on fresh DB", async () => {
      const res = await app.request("/api/settings/defaults");
      expect(res.status).toBe(200);
      const body = await res.json() as { auto_delete_worktree_on_merge: boolean };
      expect(body.auto_delete_worktree_on_merge).toBe(false);
    });
  });

  // ── POST /api/commands/settings/defaults ─────────────────────────────────
  describe("POST /api/commands/settings/defaults", () => {
    it("updates defaults and persists via event", async () => {
      const res = await app.request("/api/commands/settings/defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_delete_worktree_on_merge: true }),
      });
      expect(res.status).toBe(200);
      const event = await res.json() as { type: string };
      expect(event.type).toBe("settings.changed");

      const defRes = await app.request("/api/settings/defaults");
      const defaults = await defRes.json() as { auto_delete_worktree_on_merge: boolean };
      expect(defaults.auto_delete_worktree_on_merge).toBe(true);
    });

    it("returns 400 for empty body", async () => {
      const res = await app.request("/api/commands/settings/defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/commands/settings/auto-merge ──────────────────────────────
  describe("POST /api/commands/settings/auto-merge", () => {
    it("toggles auto_merge_enabled via settings event", async () => {
      const res = await app.request("/api/commands/settings/auto-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      const event = await res.json() as { type: string };
      expect(event.type).toBe("settings.auto_merge_enabled_set");

      const defRes = await app.request("/api/settings/defaults");
      const defaults = await defRes.json() as { auto_merge_enabled: boolean };
      expect(defaults.auto_merge_enabled).toBe(true);
    });

    it("returns 400 for non-boolean enabled", async () => {
      const res = await app.request("/api/commands/settings/auto-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/settings/about ──────────────────────────────────────────────
  describe("GET /api/settings/about", () => {
    it("returns version and event count", async () => {
      const res = await app.request("/api/settings/about");
      expect(res.status).toBe(200);
      const body = await res.json() as { version: string; event_count: number; projections: string[] };
      expect(body.version).toBeDefined();
      expect(typeof body.event_count).toBe("number");
      expect(Array.isArray(body.projections)).toBe(true);
      expect(body.projections).toContain("task_list");
    });
  });

  // ── POST /api/maintenance/rebuild/:projection ─────────────────────────────
  describe("POST /api/maintenance/rebuild/:projection", () => {
    it("rebuilds a valid projection", async () => {
      const res = await app.request("/api/maintenance/rebuild/preset", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; projection: string };
      expect(body.ok).toBe(true);
      expect(body.projection).toBe("preset");
    });

    it("returns 404 for unknown projection", async () => {
      const res = await app.request("/api/maintenance/rebuild/does-not-exist", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});
