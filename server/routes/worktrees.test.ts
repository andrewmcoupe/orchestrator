/**
 * Worktree management routes tests.
 *
 * Tests:
 *   GET  /api/worktrees                    — list worktrees correlated with tasks
 *   POST /api/commands/worktree/remove     — bulk worktree removal
 *   POST /api/maintenance/rebuild-projections — rebuild all projections at once
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../eventStore.js";
import { initProjections } from "../projectionRunner.js";
import "../projections/register.js";
import { createWorktreeRoutes } from "./worktrees.js";

// Mock the worktree and execa modules
vi.mock("../worktree.js", () => ({
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  getDefaultRepoRoot: vi.fn(() => "/host/repo"),
}));

vi.mock("execa", () => ({
  execa: vi.fn(() => Promise.resolve({ stdout: "100K\t." })),
}));

import { listWorktrees, removeWorktree } from "../worktree.js";

const mockListWorktrees = vi.mocked(listWorktrees);
const mockRemoveWorktree = vi.mocked(removeWorktree);

let db: Database.Database;
let app: ReturnType<typeof createWorktreeRoutes>;

describe("Worktree routes", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    initProjections(db);
    app = createWorktreeRoutes(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  // ── GET /api/worktrees ──────────────────────────────────────────────────
  describe("GET /api/worktrees", () => {
    it("returns empty list when no worktrees exist", async () => {
      mockListWorktrees.mockResolvedValue([
        // Main worktree only (no wt/ branches)
        { worktreePath: "/host/repo", branch: "main", commitHash: "abc123" },
      ]);

      const res = await app.request("/api/worktrees");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { worktrees: unknown[] };
      expect(body.worktrees).toEqual([]);
    });

    it("returns worktrees correlated with tasks via branch name", async () => {
      // Seed a task in the task_detail projection
      db.prepare(
        `INSERT INTO proj_task_detail (task_id, title, status, config_json, preset_override_keys_json, proposition_ids_json, worktree_path, worktree_branch, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "T-001", "Fix login bug", "running",
        "{}", "[]", "[]",
        "/host/repo/.orchestrator-worktrees/T-001", "wt/T-001",
        "evt-1", new Date().toISOString(),
      );

      mockListWorktrees.mockResolvedValue([
        { worktreePath: "/host/repo", branch: "main", commitHash: "abc123" },
        { worktreePath: "/host/repo/.orchestrator-worktrees/T-001", branch: "wt/T-001", commitHash: "def456" },
      ]);

      const res = await app.request("/api/worktrees");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        worktrees: Array<{
          task_id: string;
          task_title: string;
          task_status: string;
          branch: string;
          worktree_path: string;
        }>;
      };
      expect(body.worktrees).toHaveLength(1);
      expect(body.worktrees[0].task_id).toBe("T-001");
      expect(body.worktrees[0].task_title).toBe("Fix login bug");
      expect(body.worktrees[0].task_status).toBe("running");
      expect(body.worktrees[0].branch).toBe("wt/T-001");
    });

    it("marks worktrees as orphaned when no matching task exists", async () => {
      mockListWorktrees.mockResolvedValue([
        { worktreePath: "/host/repo", branch: "main", commitHash: "abc123" },
        { worktreePath: "/host/repo/.orchestrator-worktrees/T-GONE", branch: "wt/T-GONE", commitHash: "fff999" },
      ]);

      const res = await app.request("/api/worktrees");
      const body = (await res.json()) as {
        worktrees: Array<{ task_id: string; task_status: string }>;
      };
      expect(body.worktrees).toHaveLength(1);
      expect(body.worktrees[0].task_id).toBe("T-GONE");
      expect(body.worktrees[0].task_status).toBe("orphaned");
    });

    it("excludes the main worktree from results", async () => {
      mockListWorktrees.mockResolvedValue([
        { worktreePath: "/host/repo", branch: "main", commitHash: "abc123" },
      ]);

      const res = await app.request("/api/worktrees");
      const body = (await res.json()) as { worktrees: unknown[] };
      expect(body.worktrees).toHaveLength(0);
    });
  });

  // ── POST /api/commands/worktree/remove ────────────────────────────────────
  describe("POST /api/commands/worktree/remove", () => {
    it("removes worktrees for given task_ids", async () => {
      mockRemoveWorktree.mockResolvedValue(undefined);

      const res = await app.request("/api/commands/worktree/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: ["T-001", "T-002"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: string[]; errors: unknown[] };
      expect(body.removed).toEqual(["T-001", "T-002"]);
      expect(body.errors).toEqual([]);
      expect(mockRemoveWorktree).toHaveBeenCalledTimes(2);
    });

    it("returns 400 for empty task_ids array", async () => {
      const res = await app.request("/api/commands/worktree/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing task_ids", async () => {
      const res = await app.request("/api/commands/worktree/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("reports errors per-task without failing the whole batch", async () => {
      mockRemoveWorktree
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("locked"));

      const res = await app.request("/api/commands/worktree/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: ["T-OK", "T-FAIL"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        removed: string[];
        errors: Array<{ task_id: string; error: string }>;
      };
      expect(body.removed).toEqual(["T-OK"]);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].task_id).toBe("T-FAIL");
    });
  });

  // ── POST /api/maintenance/rebuild-projections ──────────────────────────────
  describe("POST /api/maintenance/rebuild-projections", () => {
    it("rebuilds all registered projections", async () => {
      const res = await app.request("/api/maintenance/rebuild-projections", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        rebuilt: string[];
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.rebuilt)).toBe(true);
      expect(body.rebuilt.length).toBeGreaterThan(0);
    });
  });
});
