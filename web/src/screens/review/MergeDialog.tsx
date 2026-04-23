/**
 * MergeDialog — confirmation modal for the merge workflow.
 *
 * Opened when the user clicks "Merge into <branch>" on the ApprovedFooter.
 *
 * Phase machine:
 *   confirming → POST merge endpoint
 *     ↳ merging      → show spinner while in-flight
 *     ↳ drifted      → show drift warning + "Merge anyway"
 *     ↳ gate_failed  → show gate failure list + "Back to review"
 *     ↳ conflicted   → show conflict paths + open editor + retry
 *
 * When the merge succeeds, onSuccess() is called — the task will transition
 * to 'merged' via SSE and the footer will update in Review.tsx.
 */

import { useState, useEffect, useCallback } from "react";
import {
  GitMerge,
  AlertTriangle,
  XCircle,
  FolderOpen,
  RefreshCcw,
  ChevronLeft,
  Loader2,
} from "lucide-react";
import type { GateRunSummary } from "@shared/projections.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@web/src/components/ui/dialog";

// ============================================================================
// Types
// ============================================================================

type OnMergeConfig = {
  strategy: "squash" | "merge" | "ff-only";
  auto_delete_worktree: boolean;
  preserve_branch: boolean;
};

type GateFailureItem = {
  category: string;
  location?: { path: string; line: number; col?: number };
  excerpt: string;
};

type DialogPhase =
  | { name: "confirming" }
  | { name: "merging" }
  | { name: "drifted"; commits_ahead: number }
  | { name: "gate_failed"; failures: GateFailureItem[] }
  | { name: "conflicted"; paths: string[] }
  | { name: "error"; message: string };

export type MergeDialogProps = {
  taskId: string;
  taskTitle: string;
  currentBranch: string | null;
  /** Gate runs from the prior attempt — used to show estimated gate durations. */
  priorGateRuns: GateRunSummary[];
  onClose: () => void;
  onSuccess: () => void;
};

// ============================================================================
// Utility helpers
// ============================================================================

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

// ============================================================================
// MergeDialog
// ============================================================================

export function MergeDialog({
  taskId,
  taskTitle,
  currentBranch,
  priorGateRuns,
  onClose,
  onSuccess,
}: MergeDialogProps) {
  const [config, setConfig] = useState<OnMergeConfig>({
    strategy: "squash",
    auto_delete_worktree: true,
    preserve_branch: false,
  });
  const [commitMessage, setCommitMessage] = useState(taskTitle);
  const [phase, setPhase] = useState<DialogPhase>({ name: "confirming" });

  // Fetch the on_merge config from the server on mount
  useEffect(() => {
    fetch("/api/config/on_merge")
      .then((r) => r.json())
      .then((data: Partial<OnMergeConfig>) => {
        setConfig((prev) => ({ ...prev, ...data }));
      })
      .catch(() => {
        // Keep defaults on failure
      });
  }, []);

  const branchLabel = currentBranch ?? "…";
  const isSquash = config.strategy === "squash";

  // ── Merge execution ──────────────────────────────────────────────────────

  const executeMerge = useCallback(
    async (force = false) => {
      setPhase({ name: "merging" });
      try {
        const res = await fetch(`/api/commands/task/${taskId}/merge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            into_branch: currentBranch ?? undefined,
            force,
            // Only include commit_message override for squash (non-auto-generated strategies)
            ...(isSquash ? { commit_message: commitMessage } : {}),
          }),
        });

        const result = await res.json();

        if (result.outcome === "merged") {
          onSuccess();
          return;
        }
        if (result.outcome === "drifted") {
          setPhase({
            name: "drifted",
            commits_ahead: result.commits_ahead ?? 0,
          });
          return;
        }
        if (result.outcome === "conflicted") {
          setPhase({
            name: "conflicted",
            paths: result.conflicting_paths ?? [],
          });
          return;
        }
        if (result.outcome === "gate_failed") {
          setPhase({ name: "gate_failed", failures: result.failures ?? [] });
          return;
        }
        // Unexpected response
        setPhase({
          name: "error",
          message: result.detail ?? "Unexpected merge outcome",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setPhase({ name: "error", message: msg });
      }
    },
    [taskId, currentBranch, isSquash, commitMessage, onSuccess],
  );

  const handleOpenEditor = useCallback(() => {
    fetch(`/api/worktree/${taskId}/open`).catch(() => {});
  }, [taskId]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="merge-dialog"
        showCloseButton={phase.name !== "merging"}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge size={16} className="text-purple-400 shrink-0" />
            Merge into{" "}
            <span className="font-mono text-purple-300">{branchLabel}</span>?
          </DialogTitle>
          <DialogDescription>
            Squash-merge the worktree branch into your current branch.
          </DialogDescription>
        </DialogHeader>

        {/* ── Body — phase-specific content ───────────────────────── */}
        <div>
          {phase.name === "confirming" && (
            <ConfirmingView
              strategy={config.strategy}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              priorGateRuns={priorGateRuns}
              isSquash={isSquash}
            />
          )}

          {phase.name === "drifted" && (
            <DriftedView commits_ahead={phase.commits_ahead} />
          )}

          {phase.name === "merging" && <MergingView />}

          {phase.name === "gate_failed" && (
            <GateFailedView failures={phase.failures} />
          )}

          {phase.name === "conflicted" && (
            <ConflictedView
              paths={phase.paths}
              taskId={taskId}
              onOpenEditor={handleOpenEditor}
            />
          )}

          {phase.name === "error" && <ErrorView message={phase.message} />}
        </div>

        {/* ── Footer — action buttons per phase ───────────────────── */}
        <DialogFooter>
          {(phase.name === "confirming" || phase.name === "drifted") && (
            <button
              type="button"
              data-testid="cancel-btn"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-text-secondary border border-border-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          )}

          {phase.name === "confirming" && (
            <button
              type="button"
              data-testid="confirm-merge-btn"
              onClick={() => executeMerge(false)}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-purple-600 text-white hover:bg-purple-500 transition-colors"
            >
              <GitMerge size={13} />
              Confirm merge
            </button>
          )}

          {phase.name === "drifted" && (
            <button
              type="button"
              data-testid="merge-anyway-btn"
              onClick={() => executeMerge(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-status-warning text-white hover:bg-status-warning/90 transition-colors"
            >
              <GitMerge size={13} />
              Merge anyway
            </button>
          )}

          {phase.name === "gate_failed" && (
            <button
              type="button"
              data-testid="back-to-review-btn"
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary border border-border-muted hover:text-text-primary transition-colors"
            >
              <ChevronLeft size={13} />
              Back
            </button>
          )}

          {phase.name === "conflicted" && (
            <>
              <button
                type="button"
                data-testid="cancel-btn"
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-text-secondary border border-border-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="retry-merge-btn"
                onClick={() => executeMerge(false)}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-purple-600 text-white hover:bg-purple-500 transition-colors"
              >
                <RefreshCcw size={13} />
                Retry merge
              </button>
            </>
          )}

          {phase.name === "error" && (
            <button
              type="button"
              data-testid="back-to-review-btn"
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary border border-border-muted hover:text-text-primary transition-colors"
            >
              <ChevronLeft size={13} />
              Back
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// ConfirmingView
// ============================================================================

function ConfirmingView({
  strategy,
  commitMessage,
  onCommitMessageChange,
  priorGateRuns,
  isSquash,
}: {
  strategy: string;
  commitMessage: string;
  onCommitMessageChange: (msg: string) => void;
  priorGateRuns: GateRunSummary[];
  isSquash: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Strategy badge */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary">Strategy:</span>
        <span
          data-testid="strategy-badge"
          className="text-xs font-mono px-2 py-0.5 rounded-full bg-bg-tertiary border border-border-muted text-text-secondary"
        >
          {strategy}
        </span>
      </div>

      {/* Commit message */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="commit-msg" className="text-xs text-text-secondary">
          {isSquash ? "Commit message" : "Commit message (auto-generated)"}
        </label>
        <textarea
          id="commit-msg"
          data-testid="commit-message-input"
          value={commitMessage}
          readOnly={!isSquash}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          rows={3}
          className={`w-full border px-3 py-2 text-sm font-mono resize-none outline-none ${
            isSquash
              ? "border-border-muted text-text-primary focus:border-purple-500/50"
              : "border-border-muted text-text-secondary cursor-not-allowed"
          }`}
        />
      </div>

      {/* Gate preview */}
      {priorGateRuns.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">
            Gates that will run:
          </span>
          <ul data-testid="gate-preview-list" className="flex flex-col gap-1">
            {priorGateRuns.map((g) => (
              <li
                key={g.gate_run_id}
                className="flex items-center justify-between text-xs px-2.5 py-1.5 bg-bg-primary border border-border-muted"
              >
                <span className="font-mono text-text-primary">
                  {g.gate_name}
                </span>
                {g.duration_ms !== undefined && (
                  <span className="text-text-tertiary">
                    ~{formatDurationMs(g.duration_ms)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DriftedView
// ============================================================================

function DriftedView({ commits_ahead }: { commits_ahead: number }) {
  return (
    <div
      data-testid="drift-warning"
      className="flex flex-col gap-3 border border-status-warning/30 bg-status-warning/5 p-4"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={14} className="text-status-warning shrink-0" />
        <span className="text-sm font-medium text-status-warning">
          Target branch has advanced
        </span>
      </div>
      <p className="text-xs text-text-secondary">
        The target branch has{" "}
        <span className="font-mono text-text-primary">{commits_ahead}</span>{" "}
        {commits_ahead === 1 ? "commit" : "commits"} ahead of this worktree's
        base. The merge may still succeed, but there could be conflicts.
      </p>
    </div>
  );
}

// ============================================================================
// MergingView
// ============================================================================

function MergingView() {
  return (
    <div
      data-testid="merging-progress"
      className="flex flex-col items-center gap-4 py-6"
    >
      <Loader2 size={24} className="text-purple-400 animate-spin" />
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm text-text-primary font-medium">
          Running pre-merge gates…
        </span>
        <span className="text-xs text-text-tertiary">
          This may take a moment
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// GateFailedView
// ============================================================================

function GateFailedView({ failures }: { failures: GateFailureItem[] }) {
  return (
    <div data-testid="gate-failed-view" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <XCircle size={14} className="text-status-danger shrink-0" />
        <span className="text-sm font-medium text-status-danger">
          Pre-merge gates failed
        </span>
      </div>
      <p className="text-xs text-text-secondary">
        The following issues must be resolved before merging:
      </p>
      <ul className="flex flex-col gap-2 max-h-48 overflow-y-auto">
        {failures.map((f, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: static list, no reorder
            key={i}
            className="flex flex-col gap-0.5 bg-status-danger/5 border border-status-danger/20 px-3 py-2"
          >
            <span className="text-xs font-mono text-status-danger">
              {f.category}
            </span>
            {f.location && (
              <span className="text-xs font-mono text-text-tertiary">
                {f.location.path}:{f.location.line}
                {f.location.col !== undefined ? `:${f.location.col}` : ""}
              </span>
            )}
            <span className="text-xs text-text-secondary">{f.excerpt}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// ConflictedView
// ============================================================================

function ConflictedView({
  paths,
  taskId,
  onOpenEditor,
}: {
  paths: string[];
  taskId: string;
  onOpenEditor: () => void;
}) {
  return (
    <div data-testid="conflict-view" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={14} className="text-status-danger shrink-0" />
        <span className="text-sm font-medium text-status-danger">
          Merge conflict
        </span>
      </div>
      <p className="text-xs text-text-secondary">
        The following{" "}
        {paths.length === 1 ? "file has" : `${paths.length} files have`}{" "}
        conflicts. Resolve them in the worktree, then retry the merge.
      </p>
      <ul className="flex flex-col gap-1 max-h-32 overflow-y-auto">
        {paths.map((p) => (
          <li
            key={p}
            className="text-xs font-mono text-text-primary px-2.5 py-1 bg-bg-primary border border-border-muted"
          >
            {p}
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="open-editor-conflict-btn"
        onClick={onOpenEditor}
        className="flex items-center gap-1.5 self-start px-3 py-1.5 text-sm border border-border-muted text-text-secondary hover:text-text-primary transition-colors"
      >
        <FolderOpen size={13} />
        Open worktree in editor
      </button>
    </div>
  );
}

// ============================================================================
// ErrorView
// ============================================================================

function ErrorView({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-2 border border-status-danger/30 bg-status-danger/5 p-4">
      <div className="flex items-center gap-2">
        <XCircle size={14} className="text-status-danger shrink-0" />
        <span className="text-sm font-medium text-status-danger">
          Merge failed
        </span>
      </div>
      <p className="text-xs text-text-secondary font-mono">{message}</p>
    </div>
  );
}
