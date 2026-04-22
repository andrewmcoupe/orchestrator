/**
 * Maintenance subsection — worktree listing, bulk removal, rebuild projections.
 *
 * Data sources:
 *   GET  /api/worktrees                     — enriched worktree list
 *   POST /api/commands/worktree/remove      — bulk remove
 *   POST /api/maintenance/rebuild-projections — rebuild all projections
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { Trash2, RefreshCw, HardDrive, GitBranch } from "lucide-react";

// ============================================================================
// Types
// ============================================================================

type WorktreeEntry = {
  task_id: string;
  task_title: string | null;
  task_status: string;
  branch: string;
  worktree_path: string;
  created_days_ago: number;
  size_display: string;
};

// ============================================================================
// Hooks
// ============================================================================

function useWorktrees() {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/worktrees")
      .then((r) => r.json() as Promise<{ worktrees: WorktreeEntry[] }>)
      .then((data) => setWorktrees(data.worktrees ?? []))
      .catch(() => setWorktrees([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return { worktrees, loading, reload: load };
}

// Statuses that indicate the worktree should NOT be removed
const UNSAFE_STATUSES = new Set(["running", "approved", "queued", "awaiting_merge"]);

export function Maintenance() {
  const { worktrees, loading, reload } = useWorktrees();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [safeOnly, setSafeOnly] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<"ok" | "error" | null>(null);

  // Filter worktrees by safety
  const filtered = useMemo(() => {
    if (!safeOnly) return worktrees;
    return worktrees.filter((wt) => !UNSAFE_STATUSES.has(wt.task_status));
  }, [worktrees, safeOnly]);

  // Clear selection when filter changes
  useEffect(() => {
    setSelected(new Set());
  }, [safeOnly]);

  const toggleSelect = (taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const handleRemove = async () => {
    if (selected.size === 0) return;
    setRemoving(true);
    try {
      await fetch("/api/commands/worktree/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: Array.from(selected) }),
      });
      setSelected(new Set());
      reload();
    } finally {
      setRemoving(false);
    }
  };

  const handleRebuildAll = async () => {
    setRebuilding(true);
    setRebuildResult(null);
    try {
      const r = await fetch("/api/maintenance/rebuild-projections", { method: "POST" });
      const body = (await r.json()) as { ok: boolean };
      setRebuildResult(body.ok ? "ok" : "error");
      setTimeout(() => setRebuildResult(null), 3000);
    } catch {
      setRebuildResult("error");
      setTimeout(() => setRebuildResult(null), 3000);
    } finally {
      setRebuilding(false);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "running": return "text-status-warning";
      case "approved": return "text-purple-400";
      case "merged": return "text-status-healthy";
      case "orphaned": return "text-danger";
      default: return "text-text-tertiary";
    }
  };

  return (
    <div data-testid="maintenance-section" className="space-y-8">
      <h2 className="text-base font-semibold text-text-primary">Maintenance</h2>

      {/* ── Worktrees ────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Worktrees
            </h3>
            <p className="text-xs text-text-tertiary mt-0.5">
              Git worktrees created for tasks. Remove stale ones to free disk space.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={safeOnly}
                onChange={(e) => setSafeOnly(e.target.checked)}
                data-testid="safe-filter-toggle"
              />
              Only safely removable
            </label>
            <button
              onClick={handleRemove}
              disabled={selected.size === 0 || removing}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="remove-selected-btn"
            >
              <Trash2 className="h-3 w-3" />
              {removing ? "Removing…" : `Remove selected (${selected.size})`}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-text-secondary p-4">Loading worktrees…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-text-secondary p-4 border border-surface-tertiary bg-surface-secondary">
            {worktrees.length === 0
              ? "No worktrees found."
              : "No safely removable worktrees. Turn off the filter to see all."}
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((wt) => (
              <div
                key={wt.task_id}
                className="flex items-center gap-3 border border-surface-tertiary bg-surface-secondary px-4 py-3"
                data-testid={`worktree-row-${wt.task_id}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(wt.task_id)}
                  onChange={() => toggleSelect(wt.task_id)}
                  className="flex-shrink-0"
                  data-testid={`select-worktree-${wt.task_id}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {wt.task_title ?? wt.task_id}
                    </span>
                    <span className={`text-xs font-medium ${statusColor(wt.task_status)}`}>
                      {wt.task_status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-text-tertiary mt-0.5">
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {wt.branch}
                    </span>
                    <span>{wt.created_days_ago}d ago</span>
                    <span className="font-mono">{wt.task_id}</span>
                  </div>
                </div>
                <div className="text-xs text-text-tertiary font-mono flex-shrink-0">
                  {wt.size_display}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Rebuild projections ──────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">Rebuild Projections</h3>
        <p className="text-xs text-text-tertiary mb-3">
          Drops and rebuilds every projection table by replaying the full event log through each reducer.
          The event log is append-only and never modified. Use this after projection logic changes,
          to backfill newly added projections, or to recover from stale/diverged read models.
        </p>
        <button
          onClick={handleRebuildAll}
          disabled={rebuilding}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-surface-tertiary hover:bg-surface-inverse text-text-primary disabled:opacity-50"
          data-testid="rebuild-all-btn"
        >
          <RefreshCw className={`h-3 w-3 ${rebuilding ? "animate-spin" : ""}`} />
          {rebuilding
            ? "Rebuilding…"
            : rebuildResult === "ok"
              ? "Done"
              : rebuildResult === "error"
                ? "Error"
                : "Rebuild all projections"}
        </button>
      </div>
    </div>
  );
}
