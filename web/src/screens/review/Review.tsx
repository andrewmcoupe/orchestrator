/**
 * Review — Diff Review Screen
 * Route: #/tasks/:taskId/review/:attemptId
 *
 * Shows the auditor verdict, concerns with inline diff annotations,
 * gate results, and action buttons (approve / reject / retry-with-feedback).
 *
 * Footer state is driven by the task's status:
 *   awaiting_review → 4 action buttons
 *   approved        → merge CTA + unapprove + open-in-editor
 *   merged          → read-only merged summary
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronLeft,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Coins,
  FileCode2,
  MessageSquareWarning,
  RefreshCcw,
  ThumbsUp,
  ThumbsDown,
  GitMerge,
  Undo2,
} from "lucide-react";
import type { AttemptRow, AuditSummary, GateRunSummary, PhaseRunSummary } from "@shared/projections.js";
import type { AuditConcern, TaskStatus } from "@shared/events.js";
import { useTaskDetail, useLatestAssistantMessage } from "../../store/eventStore.js";
import { MergeDialog } from "./MergeDialog.js";

// ============================================================================
// Types
// ============================================================================

type ReviewProps = {
  taskId: string;
  attemptId: string;
  onBack: () => void;
};

/** Shape of the task_detail REST response used by the review screen */
type LoadedTaskDetail = {
  task_id: string;
  title: string;
  status: TaskStatus;
  updated_at: string;
  worktree_path?: string;
  merge_commit_sha?: string;
  merged_into_branch?: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "not_found" }
  | {
      status: "loaded";
      attempt: AttemptRow;
      taskTitle: string;
      taskDetail: LoadedTaskDetail;
    };

/** A parsed line from a unified diff */
type DiffLine =
  | { kind: "header"; content: string }
  | { kind: "hunk"; content: string }
  | { kind: "add"; content: string; newLine: number }
  | { kind: "remove"; content: string; oldLine: number }
  | { kind: "context"; content: string; newLine: number; oldLine: number };

// ============================================================================
// Diff parsing
// ============================================================================

function parseUnifiedDiff(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      result.push({ kind: "header", content: line });
    } else if (line.startsWith("@@")) {
      // @@ -10,3 +12,7 @@
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ kind: "hunk", content: line });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ kind: "add", content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({ kind: "remove", content: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith("\\")) {
      // "No newline at end of file" — skip
    } else if (line.length > 0) {
      result.push({
        kind: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return result;
}

// ============================================================================
// Split a unified diff into per-file sections
// ============================================================================

function splitDiffByFile(raw: string): Record<string, DiffLine[]> {
  const result: Record<string, DiffLine[]> = {};
  const sections = raw.split(/^(?=diff --git )/m);

  for (const section of sections) {
    if (!section.trim()) continue;
    // Extract file path from "diff --git a/... b/..."
    const match = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!match) continue;
    const filePath = match[1];
    result[filePath] = parseUnifiedDiff(section);
  }

  return result;
}

// ============================================================================
// Verdict styling
// ============================================================================

const VERDICT_CONFIG = {
  approve: {
    label: "Approve",
    cardCls: "border-status-healthy/40 bg-status-healthy/5",
    textCls: "text-status-healthy",
    icon: CheckCircle2,
  },
  revise: {
    label: "Revise",
    cardCls: "border-status-warning/40 bg-status-warning/5",
    textCls: "text-status-warning",
    icon: AlertTriangle,
  },
  reject: {
    label: "Reject",
    cardCls: "border-status-danger/40 bg-status-danger/5",
    textCls: "text-status-danger",
    icon: XCircle,
  },
};

// ============================================================================
// Concern styling
// ============================================================================

const CONCERN_CATEGORY_CLS: Record<AuditConcern["category"], string> = {
  correctness: "bg-status-danger/10 text-status-danger border-status-danger/30",
  completeness: "bg-status-warning/10 text-status-warning border-status-warning/30",
  security: "bg-status-danger/10 text-status-danger border-status-danger/30",
  performance: "bg-status-warning/10 text-status-warning border-status-warning/30",
  style: "bg-bg-tertiary text-text-secondary border-border-muted",
  nit: "bg-bg-tertiary text-text-tertiary border-border-muted",
};

const CONCERN_SEVERITY_CLS: Record<AuditConcern["severity"], string> = {
  blocking: "bg-status-danger/10 text-status-danger border-status-danger/30",
  advisory: "bg-status-muted/10 text-status-muted border-status-muted/30",
};

// ============================================================================
// Gate pill styling
// ============================================================================

const GATE_STATUS_CLS: Record<GateRunSummary["status"], string> = {
  passed: "bg-status-healthy/10 text-status-healthy border-status-healthy/30",
  failed: "bg-status-danger/10 text-status-danger border-status-danger/30",
  timed_out: "bg-status-warning/10 text-status-warning border-status-warning/30",
  running: "bg-status-warning/10 text-status-warning border-status-warning/30",
  pending: "bg-bg-tertiary text-text-secondary border-border-muted",
  skipped: "bg-bg-tertiary text-text-tertiary border-border-muted",
};

// ============================================================================
// Helper: format duration
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

// ============================================================================
// Helper: format cost
// ============================================================================

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

// ============================================================================
// Helper: format relative time
// ============================================================================

function formatTimeAgo(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ============================================================================
// Sub-components
// ============================================================================

function LoadingSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading">
      <div className="h-6 w-6 rounded-full border-2 border-text-tertiary border-t-transparent animate-spin" />
    </div>
  );
}

function NotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <p className="text-text-secondary">Attempt not found.</p>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-secondary text-text-secondary hover:text-text-primary"
        aria-label="back"
      >
        <ChevronLeft size={14} /> Back
      </button>
    </div>
  );
}

/** Verdict card — prominent colored block with summary and concerns */
function VerdictCard({ audit }: { audit: AuditSummary }) {
  const cfg = VERDICT_CONFIG[audit.verdict];
  const Icon = cfg.icon;

  return (
    <div
      data-testid="verdict-card"
      className={`border p-4 ${cfg.cardCls}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon size={18} className={cfg.textCls} />
        <span className={`text-base font-semibold capitalize ${cfg.textCls}`}>{cfg.label}</span>
        <span className="ml-auto text-sm text-text-secondary">
          {Math.round(audit.confidence * 100)}% confidence
        </span>
      </div>

      {audit.summary && (
        <p className="text-sm text-text-secondary mb-3">{audit.summary}</p>
      )}

      {audit.concerns.length > 0 && (
        <ol className="mt-3 space-y-2">
          {audit.concerns.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: concerns are ordered and stable
            <li key={i} className="flex flex-col gap-1 pl-2 border-l-2 border-border-muted">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-text-tertiary font-mono">#{i + 1}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 border ${CONCERN_CATEGORY_CLS[c.category]}`}
                >
                  {c.category}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 border ${CONCERN_SEVERITY_CLS[c.severity]}`}
                >
                  {c.severity}
                </span>
                {c.anchor && (
                  <button
                    type="button"
                    className="text-xs font-mono text-text-secondary hover:text-text-primary underline underline-offset-2"
                    title={`Go to ${c.anchor.path}:${c.anchor.line}`}
                  >
                    {c.anchor.path}:{c.anchor.line}
                  </button>
                )}
              </div>
              <p className="text-sm text-text-primary">{c.rationale}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Phase strip — one pill per phase showing model and A/B variant badge */
function PhaseStrip({ phases }: { phases: Record<string, PhaseRunSummary> }) {
  const entries = Object.values(phases);
  if (entries.length === 0) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">Phases</span>
      {entries.map((phase) => (
        <div
          key={phase.phase_name}
          className="flex items-center gap-1.5 px-2 py-1 border border-border-muted bg-bg-secondary text-xs"
        >
          <span className="text-text-secondary capitalize">{phase.phase_name}</span>
          {phase.model && (
            <span className="text-text-tertiary font-mono">{phase.model.split("/").pop()}</span>
          )}
          {phase.ab_variant && (
            <span
              data-testid={`ab-variant-${phase.phase_name}`}
              className="px-1.5 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25"
            >
              {phase.ab_variant}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Gate run pills */
function GatesStrip({ gates }: { gates: GateRunSummary[] }) {
  if (gates.length === 0) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">Gates</span>
      {gates.map((g) => (
        <span
          key={g.gate_run_id}
          data-testid={`gate-${g.gate_name}`}
          className={`text-xs px-2 py-0.5 border font-mono ${GATE_STATUS_CLS[g.status]}`}
          title={g.duration_ms ? formatDuration(g.duration_ms) : undefined}
        >
          <span>{g.gate_name}</span>
          {g.failure_count ? ` (${g.failure_count})` : ""}
          {g.duration_ms ? ` · ${formatDuration(g.duration_ms)}` : ""}
        </span>
      ))}
    </div>
  );
}

/** Diff viewer — renders parsed diff lines with color-coding */
function DiffPane({
  lines,
  concerns,
  filePath,
}: {
  lines: DiffLine[];
  concerns: AuditConcern[];
  filePath: string;
}) {
  // Build a map from new-file line number → concerns for inline annotation
  const concernsByLine = new Map<number, AuditConcern[]>();
  for (const c of concerns) {
    if (c.anchor && c.anchor.path === filePath) {
      const arr = concernsByLine.get(c.anchor.line) ?? [];
      arr.push(c);
      concernsByLine.set(c.anchor.line, arr);
    }
  }

  return (
    <div className="font-mono text-xs overflow-auto bg-bg-primary border border-border-muted">
      {lines.map((line, idx) => {
        let cls = "px-3 py-0.5 whitespace-pre";
        let prefix = " ";

        if (line.kind === "header") {
          cls += " text-text-tertiary bg-bg-secondary";
        } else if (line.kind === "hunk") {
          cls += " text-text-secondary bg-bg-tertiary border-y border-border-muted";
        } else if (line.kind === "add") {
          cls += " bg-status-healthy/8 text-status-healthy";
          prefix = "+";
        } else if (line.kind === "remove") {
          cls += " bg-status-danger/8 text-status-danger";
          prefix = "-";
        } else {
          cls += " text-text-secondary";
        }

        const newLineNo = line.kind === "add" || line.kind === "context" ? line.newLine : undefined;
        const inlineConcerns = newLineNo !== undefined ? (concernsByLine.get(newLineNo) ?? []) : [];

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          <div key={idx}>
            <div className={cls}>
              <span className="select-none text-text-tertiary mr-2">
                {newLineNo !== undefined ? String(newLineNo).padStart(4) : "    "}
              </span>
              <span className="select-none mr-1">{prefix}</span>
              <span>{line.content}</span>
            </div>
            {inlineConcerns.map((c, ci) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: concerns per line are positional
              <div key={ci} className="flex items-start gap-2 px-4 py-1.5 bg-status-warning/5 border-l-2 border-status-warning text-xs">
                <MessageSquareWarning size={12} className="text-status-warning mt-0.5 shrink-0" />
                <span className="text-text-primary">{c.rationale}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

export function Review({ taskId, attemptId, onBack }: ReviewProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Per-file parsed diffs, split from the full worktree diff
  const [fileDiffs, setFileDiffs] = useState<Record<string, DiffLine[]>>({});
  const [diffLoading, setDiffLoading] = useState(false);
  // Empty-attempt fallback: the attempt number whose diff we're actually showing
  const [effectiveAttemptNumber, setEffectiveAttemptNumber] = useState<number | null>(null);
  // null = not determined yet, "none" = no prior non-empty attempt exists
  const [emptyBannerState, setEmptyBannerState] = useState<"none" | "fallback" | null>(null);

  // Current HEAD branch — polled every 3s when task is in 'approved' state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const branchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Controls visibility of the merge confirmation dialog
  const [showMergeDialog, setShowMergeDialog] = useState(false);

  // Live task status from the Zustand store (updated via SSE).
  // When undefined (task not yet in store), fall back to REST-loaded status.
  const storeDetail = useTaskDetail(taskId);

  // Last assistant message — shown on the review page when the attempt is empty
  const lastAssistantMessage = useLatestAssistantMessage(attemptId);

  // ── Load attempt + task detail ────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [attemptRes, taskRes] = await Promise.all([
        fetch(`/api/projections/attempt/${attemptId}`),
        fetch(`/api/projections/task_detail/${taskId}`),
      ]);

      if (cancelled) return;

      if (!attemptRes.ok) {
        setLoadState({ status: "not_found" });
        return;
      }

      const attempt: AttemptRow = await attemptRes.json();
      const taskDetailRaw: LoadedTaskDetail | null = taskRes.ok
        ? (await taskRes.json() as LoadedTaskDetail)
        : null;

      const taskTitle = taskDetailRaw?.title ?? taskId;

      if (!cancelled) {
        setLoadState({
          status: "loaded",
          attempt,
          taskTitle,
          taskDetail: taskDetailRaw ?? {
            task_id: taskId,
            title: taskId,
            status: "awaiting_review",
            updated_at: new Date().toISOString(),
          },
        });
      }

      // Determine which attempt's diff to show.
      // Prefer the current attempt's diff_hash (which captures the full branch
      // diff from base_sha) even when the attempt itself is "empty" (no new edits).
      const phaseEntries = Object.values(attempt.phases) as Array<{ diff_hash?: string }>;
      const diffHash = phaseEntries.reduce<string | undefined>(
        (acc, p) => p.diff_hash ?? acc,
        undefined,
      );

      if (diffHash && !cancelled) {
        // Current attempt has a captured diff — use it directly
        setDiffLoading(true);
        try {
          const diffRes = await fetch(`/api/blobs/${diffHash}`);
          if (diffRes.ok) {
            const raw = await diffRes.text();
            const perFile = splitDiffByFile(raw);
            if (!cancelled) setFileDiffs(perFile);
          }
        } finally {
          if (!cancelled) setDiffLoading(false);
        }
      } else if (attempt.empty === true) {
        // No diff on this attempt — try falling back to the effective prior attempt
        const effectiveId = attempt.effective_diff_attempt_id;
        if (!effectiveId) {
          if (!cancelled) setEmptyBannerState("none");
        } else if (effectiveId !== attemptId) {
          if (!cancelled) setDiffLoading(true);
          try {
            const effRes = await fetch(`/api/projections/attempt/${effectiveId}`);
            if (effRes.ok && !cancelled) {
              const effAttempt: AttemptRow = await effRes.json();
              setEmptyBannerState("fallback");
              setEffectiveAttemptNumber(effAttempt.attempt_number);

              const effPhases = Object.values(effAttempt.phases) as Array<{ diff_hash?: string }>;
              const effDiffHash = effPhases.reduce<string | undefined>(
                (acc, p) => p.diff_hash ?? acc,
                undefined,
              );
              if (effDiffHash && !cancelled) {
                const diffRes = await fetch(`/api/blobs/${effDiffHash}`);
                if (diffRes.ok) {
                  const raw = await diffRes.text();
                  const perFile = splitDiffByFile(raw);
                  if (!cancelled) setFileDiffs(perFile);
                }
              }
            }
          } finally {
            if (!cancelled) setDiffLoading(false);
          }
        }
      }
    }

    load().catch(() => {
      if (!cancelled) setLoadState({ status: "not_found" });
    });

    return () => {
      cancelled = true;
    };
  }, [attemptId, taskId]);

  // ── Derive the current task status (SSE store wins over REST) ─────────────

  const taskDetail =
    loadState.status === "loaded" ? loadState.taskDetail : null;

  const taskStatus: TaskStatus =
    storeDetail?.status ??
    taskDetail?.status ??
    "awaiting_review";

  // ── Poll current branch every 3s when task is in 'approved' state ─────────

  useEffect(() => {
    async function fetchBranch() {
      try {
        const res = await fetch("/api/repo/current-branch");
        if (res.ok) {
          const { branch } = (await res.json()) as { branch: string };
          setCurrentBranch(branch);
        }
      } catch {
        // Network error — leave currentBranch unchanged
      }
    }

    if (taskStatus === "approved") {
      fetchBranch();
      branchPollRef.current = setInterval(fetchBranch, 3_000);
    } else {
      if (branchPollRef.current) {
        clearInterval(branchPollRef.current);
        branchPollRef.current = null;
      }
    }

    return () => {
      if (branchPollRef.current) {
        clearInterval(branchPollRef.current);
        branchPollRef.current = null;
      }
    };
  }, [taskStatus]);

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleApprove = useCallback(() => {
    // Don't navigate away — let the SSE-driven status update re-render the footer
    fetch(`/api/commands/attempt/${attemptId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rationale: "Approved via review UI" }),
    }).catch(() => {});
  }, [attemptId]);

  const handleReject = useCallback(() => {
    fetch(`/api/commands/attempt/${attemptId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rationale: "Rejected via review UI" }),
    }).then(onBack);
  }, [attemptId, onBack]);

  const handleRetryWithFeedback = useCallback(() => {
    fetch(`/api/commands/attempt/${attemptId}/retry-with-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then(onBack);
  }, [attemptId, onBack]);

  const handleUnapprove = useCallback(() => {
    fetch(`/api/commands/attempt/${attemptId}/unapprove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
  }, [attemptId]);

  const handleMerge = useCallback(() => {
    setShowMergeDialog(true);
  }, []);



  // ── Render ────────────────────────────────────────────────────────────────

  if (loadState.status === "loading") {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
        <ReviewHeader taskTitle="" taskId={taskId} attemptNumber={0} onBack={onBack} />
        <LoadingSpinner />
      </div>
    );
  }

  if (loadState.status === "not_found") {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
        <ReviewHeader taskTitle="" taskId={taskId} attemptNumber={0} onBack={onBack} />
        <NotFound onBack={onBack} />
      </div>
    );
  }

  const { attempt, taskTitle } = loadState;
  const audit = attempt.audit;
  const verdictConfig = audit ? VERDICT_CONFIG[audit.verdict] : null;

  // Merge info — prefer live store data, fall back to REST-loaded task detail
  const mergeCommitSha =
    storeDetail?.merge_commit_sha ?? taskDetail?.merge_commit_sha;
  const mergedIntoBranch =
    storeDetail?.merged_into_branch ?? taskDetail?.merged_into_branch;

  // Approval timestamp — use task_detail.updated_at when status is approved
  const approvedAt = taskDetail?.updated_at;

  // Build file tabs from the captured diff (primary) or files_changed (fallback).
  // When a diff blob is available, compute line counts from the parsed diff
  // since invocation.file_edited events may have 0/0 counts (e.g. Codex
  // stages changes internally so git diff HEAD returns nothing).
  const diffFiles = Object.keys(fileDiffs);
  const fileTabs = diffFiles.length > 0
    ? diffFiles.map((path) => {
        const lines = fileDiffs[path];
        const added = lines.filter((l) => l.kind === "add").length;
        const removed = lines.filter((l) => l.kind === "remove").length;
        return { path, lines_added: added, lines_removed: removed };
      })
    : attempt.files_changed;

  // Main phases summary
  const phaseEntries = Object.values(attempt.phases) as PhaseRunSummary[];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
      {/* ── Merge confirmation dialog (portal-style overlay) ─────────── */}
      {showMergeDialog && (
        <MergeDialog
          taskId={taskId}
          taskTitle={taskTitle}
          currentBranch={currentBranch}
          priorGateRuns={attempt.gate_runs}
          onClose={() => setShowMergeDialog(false)}
          onSuccess={() => setShowMergeDialog(false)}
        />
      )}

      {/* ── Top Bar ─────────────────────────────────────────────────────── */}
      <ReviewHeader
        taskTitle={taskTitle}
        taskId={taskId}
        attemptNumber={attempt.attempt_number}
        onBack={onBack}
      />

      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 p-4">
        {/* ── Meta strip ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-4 text-xs text-text-secondary flex-wrap bg-bg-secondary border border-border-muted px-3 py-2">
          {phaseEntries.length > 0 && (
            <span className="font-mono">{phaseEntries[0].model?.split("/").pop()}</span>
          )}
          {attempt.duration_ms && (
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {formatDuration(attempt.duration_ms)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span>↑ {attempt.tokens_in_total.toLocaleString()}</span>
            <span>↓ {attempt.tokens_out_total.toLocaleString()}</span>
          </span>
          <span className="flex items-center gap-1">
            <Coins size={11} />
            {formatCost(attempt.cost_usd_total)}
          </span>
        </div>

        {/* ── Phase strip ───────────────────────────────────────────────── */}
        <PhaseStrip phases={attempt.phases} />

        {/* ── Shadow-mode advisory note ──────────────────────────────── */}
        {attempt.config_snapshot?.shadow_mode &&
          attempt.config_snapshot?.auto_merge_policy &&
          attempt.config_snapshot.auto_merge_policy !== "off" && (
          <div
            data-testid="would-auto-merge-note"
            className="border border-purple-500/25 bg-purple-500/5 px-4 py-2.5 text-sm text-purple-300 flex items-center gap-2"
          >
            <span className="shrink-0 text-purple-400">~</span>
            This task <strong>would have auto-merged</strong> under policy{" "}
            <code className="font-mono text-xs text-purple-400">
              {attempt.config_snapshot.auto_merge_policy}
            </code>{" "}
            — shadow mode is active.
          </div>
        )}

        {/* ── No-changes explanation banner ─────────────────────────────── */}
        {(attempt.empty || attempt.outcome === "no_changes") && !audit && (
          <div className="border border-status-muted/30 bg-status-muted/5 px-4 py-3 flex items-start gap-3">
            <AlertTriangle size={16} className="text-status-muted shrink-0 mt-0.5" />
            <div className="text-sm space-y-1.5">
              <p className="font-medium text-text-primary">No changes were made</p>
              <p className="text-text-secondary leading-relaxed">
                The implementer completed without producing file changes. The auditor was skipped because there was nothing to review.
              </p>
            </div>
          </div>
        )}

        {/* ── Verdict card ──────────────────────────────────────────────── */}
        {audit ? (
          <VerdictCard audit={audit} />
        ) : !(attempt.empty || attempt.outcome === "no_changes") ? (
          <div className="border border-border-muted p-4 text-text-secondary text-sm">
            No auditor verdict for this attempt.
          </div>
        ) : null}

        {/* ── Gates strip ───────────────────────────────────────────────── */}
        <GatesStrip gates={attempt.gate_runs} />

        {/* ── Empty-attempt banner ────────────────────────────────────────── */}
        {emptyBannerState === "fallback" && effectiveAttemptNumber != null && (
          <div
            data-testid="empty-attempt-banner"
            className="border border-status-warning/25 bg-status-warning/5 px-4 py-2.5 text-sm text-status-warning"
          >
            This attempt made no changes. Showing diff from attempt #{effectiveAttemptNumber}.
          </div>
        )}
        {emptyBannerState === "none" && (
          <div
            data-testid="empty-attempt-banner"
            className="border border-border-muted bg-bg-secondary px-4 py-2.5 text-sm text-text-secondary"
          >
            No attempts have produced changes yet.
          </div>
        )}

        {/* ── Implementer's last message ──────────────────────────────────── */}
        {lastAssistantMessage && (
          <div className="border border-border-muted bg-bg-secondary px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-text-tertiary mb-1.5">Implementer</p>
            <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{lastAssistantMessage}</p>
          </div>
        )}

        {/* ── File tabs + diff viewer ────────────────────────────────────── */}
        {fileTabs.length > 0 && (
          <div className="flex flex-col gap-2">
            {/* File tabs */}
            <div className="flex items-center gap-1 flex-wrap">
              {fileTabs.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setSelectedFile(f.path)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono border transition-colors ${
                    selectedFile === f.path
                      ? "bg-bg-inverse text-text-inverse border-transparent"
                      : "bg-bg-secondary text-text-secondary border-border-muted hover:text-text-primary"
                  }`}
                >
                  <FileCode2 size={11} />
                  {f.path}
                  <span className="text-status-healthy">+{f.lines_added}</span>
                  <span className="text-status-danger">-{f.lines_removed}</span>
                </button>
              ))}
            </div>

            {/* Diff pane */}
            {selectedFile && (
              diffLoading ? (
                <div className="flex items-center justify-center h-24">
                  <div className="h-4 w-4 rounded-full border border-text-tertiary border-t-transparent animate-spin" role="status" />
                </div>
              ) : fileDiffs[selectedFile] ? (
                <DiffPane
                  lines={fileDiffs[selectedFile]}
                  concerns={audit?.concerns ?? []}
                  filePath={selectedFile}
                />
              ) : (
                <div className="text-xs text-text-tertiary p-3 bg-bg-secondary border border-border-muted">
                  Diff not available for this file.
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* ── Footer — state-driven ───────────────────────────────────────── */}
      {taskStatus === "approved" ? (
        <ApprovedFooter
          taskId={taskId}
          currentBranch={currentBranch}
          approvedAt={approvedAt}
          onMerge={handleMerge}
          onUnapprove={handleUnapprove}
        />
      ) : taskStatus === "merged" ? (
        <MergedFooter
          mergeCommitSha={mergeCommitSha}
          mergedIntoBranch={mergedIntoBranch}
          mergedAt={taskDetail?.updated_at}
        />
      ) : (
        <AwaitingReviewFooter
          verdict={audit?.verdict}
          confidence={audit?.confidence}
          verdictConfig={verdictConfig}
          onApprove={handleApprove}
          onReject={handleReject}
          onRetryWithFeedback={handleRetryWithFeedback}
        />
      )}
    </div>
  );
}

// ============================================================================
// ReviewHeader
// ============================================================================

function ReviewHeader({
  taskTitle,
  taskId,
  attemptNumber,
  onBack,
}: {
  taskTitle: string;
  taskId: string;
  attemptNumber: number;
  onBack: () => void;
}) {
  return (
    <header className="flex items-center gap-3 px-4 py-3 border-b border-border-muted bg-bg-secondary shrink-0">
      <button
        type="button"
        onClick={onBack}
        aria-label="back"
        data-testid="back-btn"
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronLeft size={16} />
        Back
      </button>

      <div className="h-4 w-px bg-border-muted" />

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-mono text-text-tertiary shrink-0">{taskId}</span>
        {taskTitle && (
          <span className="text-sm text-text-primary font-medium truncate">{taskTitle}</span>
        )}
      </div>

      {attemptNumber > 0 && (
        <span
          data-testid="attempt-pill"
          className="ml-auto text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary border border-border-muted font-mono"
        >
          {`#${attemptNumber}`}
        </span>
      )}
    </header>
  );
}

// ============================================================================
// AwaitingReviewFooter — four action buttons (state 1)
// ============================================================================

function AwaitingReviewFooter({
  verdict,
  confidence,
  verdictConfig,
  onApprove,
  onReject,
  onRetryWithFeedback,
}: {
  verdict?: AuditSummary["verdict"];
  confidence?: number;
  verdictConfig: (typeof VERDICT_CONFIG)[keyof typeof VERDICT_CONFIG] | null;
  onApprove: () => void;
  onReject: () => void;
  onRetryWithFeedback: () => void;
}) {
  // Accent the recommended action based on the verdict
  const approveAccent =
    verdict === "approve"
      ? "bg-status-healthy text-white hover:bg-status-healthy/90"
      : "bg-bg-secondary text-text-secondary border border-border-muted hover:text-text-primary";

  const retryAccent =
    verdict === "revise"
      ? "bg-status-warning text-white hover:bg-status-warning/90"
      : "bg-bg-secondary text-text-secondary border border-border-muted hover:text-text-primary";

  const rejectAccent =
    verdict === "reject"
      ? "bg-status-danger text-white hover:bg-status-danger/90"
      : "bg-bg-secondary text-text-secondary border border-border-muted hover:text-text-primary";

  return (
    <footer
      data-testid="footer-awaiting-review"
      className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-muted bg-bg-secondary shrink-0"
    >
      <button
        type="button"
        onClick={onReject}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${rejectAccent}`}
      >
        <ThumbsDown size={14} />
        Reject task
      </button>

{verdict && (verdict !== "approve" || (confidence != null && confidence < 0.95)) && (
        <button
          type="button"
          onClick={onRetryWithFeedback}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${retryAccent}`}
        >
          <RefreshCcw size={14} />
          Retry with feedback
        </button>
      )}

      <button
        type="button"
        onClick={onApprove}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${approveAccent}`}
      >
        <ThumbsUp size={14} />
        Approve as-is
      </button>
    </footer>
  );
}

// ============================================================================
// ApprovedFooter — merge CTA + summary strip (state 2)
// ============================================================================

function ApprovedFooter({
  taskId,
  currentBranch,
  approvedAt,
  onMerge,
  onUnapprove,
}: {
  taskId: string;
  currentBranch: string | null;
  approvedAt?: string;
  onMerge: () => void;
  onUnapprove: () => void;
}) {
  const branchLabel = currentBranch ?? "…";

  return (
    <footer
      data-testid="footer-approved"
      className="flex items-center gap-3 px-4 py-3 border-t border-purple-500/30 bg-purple-500/5 shrink-0"
    >
      {/* Approval summary strip */}
      <div
        data-testid="approved-summary-strip"
        className="flex items-center gap-2 text-xs text-text-secondary min-w-0"
      >
        <CheckCircle2 size={13} className="text-purple-400 shrink-0" />
        <span className="text-purple-300 font-medium">Approved</span>
        {approvedAt && (
          <span className="text-text-tertiary">{formatTimeAgo(approvedAt)}</span>
        )}
      </div>

      <div className="flex-1" />

      {/* Unapprove (text link) */}
      <button
        type="button"
        onClick={onUnapprove}
        className="flex items-center gap-1 px-2 py-1.5 text-sm text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <Undo2 size={13} />
        Unapprove
      </button>

      {/* Merge CTA — primary action */}
      <button
        type="button"
        onClick={onMerge}
        className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium transition-colors bg-purple-600 text-white hover:bg-purple-500"
      >
        <GitMerge size={14} />
        Merge into `{branchLabel}`
      </button>
    </footer>
  );
}

// ============================================================================
// MergedFooter — read-only merged summary (state 3)
// ============================================================================

function MergedFooter({
  mergeCommitSha,
  mergedIntoBranch,
  mergedAt,
}: {
  mergeCommitSha?: string;
  mergedIntoBranch?: string;
  mergedAt?: string;
}) {
  const shortSha = mergeCommitSha ? mergeCommitSha.slice(0, 7) : null;

  return (
    <footer
      data-testid="footer-merged"
      className="flex items-center gap-3 px-4 py-3 border-t border-status-healthy/20 bg-status-healthy/5 shrink-0"
    >
      <CheckCircle2 size={14} className="text-status-healthy shrink-0" />
      <span className="text-sm text-text-secondary">
        Merged
        {mergedIntoBranch && (
          <> into <span className="font-mono text-text-primary">{mergedIntoBranch}</span></>
        )}
        {shortSha && (
          <> as <span className="font-mono text-text-primary">{shortSha}</span></>
        )}
        {mergedAt && (
          <span className="text-text-tertiary ml-1">· {formatTimeAgo(mergedAt)}</span>
        )}
      </span>
    </footer>
  );
}
