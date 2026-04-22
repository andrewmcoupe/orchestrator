import { useCallback, useState } from "react";
import { SlidersHorizontal, ClipboardList } from "lucide-react";
import type { TaskDetailRow, TaskListRow } from "@shared/projections.js";
import type { TaskStatus, PhaseConfig, GateConfig, AnyEvent } from "@shared/events.js";
import { useTaskTimelineQuery } from "../../hooks/useQueries.js";
import { MergeDialog } from "../review/MergeDialog.js";

type TaskDetailPaneProps = {
  detail: TaskDetailRow;
  listRow?: TaskListRow;
  onEditConfig?: () => void;
  onReview?: (taskId: string, attemptId: string) => void;
};

// ============================================================================
// Status pill styling
// ============================================================================

const STATUS_PILL: Record<TaskStatus, string> = {
  draft: "bg-bg-tertiary text-text-secondary",
  queued: "bg-bg-tertiary text-text-secondary",
  running: "bg-status-warning/15 text-status-warning",
  paused: "bg-status-muted/15 text-status-muted",
  awaiting_review: "bg-status-warning/15 text-status-warning",
  revising: "bg-status-warning/15 text-status-warning",
  // approved = human has signed off, awaiting merge action
  approved: "bg-purple-500/15 text-purple-400",
  // awaiting_merge = merge process in flight (gates running, squashing, etc.)
  awaiting_merge: "bg-purple-500/15 text-purple-400",
  merged: "bg-status-healthy/15 text-status-healthy",
  rejected: "bg-status-danger/15 text-status-danger",
  archived: "bg-bg-tertiary text-text-tertiary",
  blocked: "bg-status-danger/15 text-status-danger",
};

// ============================================================================
// Phase box — shows model + prompt version + live status
// ============================================================================

type PhaseStatus = "done" | "running" | "pending";

function derivePhaseStatus(phase: PhaseConfig, currentPhase?: string, taskStatus?: TaskStatus): PhaseStatus {
  if (!taskStatus || taskStatus === "draft" || taskStatus === "queued") return "pending";
  if (taskStatus === "merged") return "done";
  if (currentPhase === phase.name) return "running";
  // If we're past this phase (based on config order), it's done
  return "pending";
}

const PHASE_STATUS_STYLES: Record<PhaseStatus, string> = {
  done: "border-status-healthy/40 bg-status-healthy/5",
  running: "border-status-warning/40 bg-status-warning/5",
  pending: "border-border-muted bg-bg-secondary",
};

const PHASE_DOT: Record<PhaseStatus, string> = {
  done: "bg-status-healthy",
  running: "bg-status-warning",
  pending: "bg-status-muted",
};

function PhaseBox({
  phase,
  currentPhase,
  taskStatus,
}: {
  phase: PhaseConfig;
  currentPhase?: string;
  taskStatus?: TaskStatus;
}) {
  const status = derivePhaseStatus(phase, currentPhase, taskStatus);
  const model = phase.model.split("/").pop() ?? phase.model;

  return (
    <div className={`flex-1 border px-4 py-3 min-w-[140px] ${PHASE_STATUS_STYLES[status]}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`inline-block h-2 w-2 rounded-full ${PHASE_DOT[status]}`} />
        <span className="text-sm font-medium text-text-primary">{phase.name}</span>
      </div>
      <div className="text-xs text-text-secondary font-mono">
        {model} &middot; {phase.prompt_version_id.slice(0, 6) || "v?"}
      </div>
    </div>
  );
}

// ============================================================================
// Gate pill
// ============================================================================

function GatePill({ gate }: { gate: GateConfig }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border-default bg-bg-secondary px-2.5 py-1 text-xs">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-muted" />
      <span className="text-text-primary">{gate.name}</span>
    </span>
  );
}

// ============================================================================
// Action buttons
// ============================================================================

const ACTIONS_BY_STATUS: Record<string, { label: string; action: string; destructive?: boolean }[]> = {
  draft: [
    { label: "Start", action: "start" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  queued: [
    { label: "Start", action: "start" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  running: [
    { label: "Pause", action: "pause" },
    { label: "Retry", action: "retry" },
    { label: "Kill", action: "kill" },
  ],
  paused: [
    { label: "Resume", action: "start" },
    { label: "Kill", action: "kill" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  awaiting_review: [
    { label: "Approve", action: "approve" },
    { label: "Reject", action: "reject" },
    { label: "Retry", action: "retry" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  approved: [
    { label: "Merge", action: "merge" },
    { label: "Unapprove", action: "unapprove" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  rejected: [
    { label: "Retry", action: "retry" },
    { label: "Archive", action: "archive", destructive: true },
  ],
  merged: [
    { label: "Archive", action: "archive", destructive: true },
  ],
  revising: [
    { label: "Pause", action: "pause" },
    { label: "Kill", action: "kill" },
  ],
};

function ActionButtons({ taskId, attemptId, status, onMerge }: { taskId: string; attemptId?: string; status: TaskStatus; onMerge?: () => void }) {
  const actions = ACTIONS_BY_STATUS[status] ?? [];

  const handleAction = useCallback(
    async (action: string) => {
      // Merge opens the confirm dialog instead of firing directly
      if (action === "merge") {
        onMerge?.();
        return;
      }

      const base = "/api/commands";
      let url: string;
      let body: Record<string, unknown> = {};

      switch (action) {
        case "start":
          url = `${base}/task/${taskId}/start`;
          break;
        case "pause":
          url = `${base}/task/${taskId}/pause`;
          break;
        case "kill":
          url = `${base}/task/${taskId}/kill`;
          break;
        case "retry":
          url = `${base}/task/${taskId}/retry`;
          break;
        case "approve":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/approve`;
          body = { rationale: "Manual approval" };
          break;
        case "reject":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/reject`;
          body = { rationale: "Manual rejection" };
          break;
        case "unapprove":
          if (!attemptId) return;
          url = `${base}/attempt/${attemptId}/unapprove`;
          break;
        case "archive":
          url = `${base}/task/${taskId}/archive`;
          break;
        default:
          return;
      }

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    [taskId, attemptId, onMerge],
  );

  if (actions.length === 0) return null;

  return (
    <div className="flex gap-2">
      {actions.map((a) => (
        <button
          key={a.action}
          type="button"
          onClick={() => handleAction(a.action)}
          className={`border px-4 py-1.5 text-sm transition-colors cursor-pointer ${
            a.destructive
              ? "border-status-danger/30 text-status-danger hover:bg-status-danger/10"
              : "border-border-default text-text-primary hover:bg-bg-secondary"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Retry policy summary
// ============================================================================

function retryPolicySummary(detail: TaskDetailRow): string {
  const p = detail.config.retry_policy;
  const parts: string[] = [];
  parts.push(`${p.on_typecheck_fail.max_attempts}\u00d7 on typecheck`);
  if (p.on_audit_reject === "escalate_to_human") {
    parts.push("escalate on audit reject");
  } else {
    parts.push(`${p.on_audit_reject} on audit reject`);
  }
  return parts.join(" \u00b7 ");
}

// ============================================================================
// Main component
// ============================================================================

export function TaskDetailPane({ detail, listRow, onEditConfig, onReview }: TaskDetailPaneProps) {
  const enabledPhases = detail.config.phases.filter((p) => p.enabled);
  const [showMergeDialog, setShowMergeDialog] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header: task ID + status + worktree + actions */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="font-mono text-sm text-text-secondary">{detail.task_id}</span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[detail.status]}`}>
              {detail.status}
            </span>
            {detail.worktree_branch && (
              <span className="text-xs text-text-tertiary font-mono">
                worktree: {detail.worktree_branch}
              </span>
            )}
          </div>
          <h2 className="text-xl font-semibold text-text-primary">{detail.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {onEditConfig && detail.status !== "merged" && detail.status !== "archived" && (
            <button
              type="button"
              onClick={onEditConfig}
              title="Edit config"
              className="flex items-center gap-1.5 border border-border-default px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-secondary transition-colors cursor-pointer"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Config
            </button>
          )}
          {onReview && detail.current_attempt_id && (
            detail.status === "awaiting_review" ? (
              <button
                type="button"
                onClick={() => onReview(detail.task_id, detail.current_attempt_id!)}
                title="Review diff and auditor verdict"
                className="flex items-center gap-1.5 border border-status-warning/40 bg-status-warning/5 px-3 py-1.5 text-xs text-status-warning hover:bg-status-warning/10 transition-colors cursor-pointer"
              >
                <ClipboardList className="h-3.5 w-3.5" />
                Review
              </button>
            ) : (detail.status === "merged" || detail.status === "rejected") ? (
              <button
                type="button"
                onClick={() => onReview(detail.task_id, detail.current_attempt_id!)}
                title="View diff from last attempt"
                className="flex items-center gap-1.5 border border-border-default px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-secondary transition-colors cursor-pointer"
              >
                <ClipboardList className="h-3.5 w-3.5" />
                View diff
              </button>
            ) : null
          )}
          <ActionButtons
            taskId={detail.task_id}
            attemptId={detail.current_attempt_id ?? undefined}
            status={detail.status}
            onMerge={() => setShowMergeDialog(true)}
          />
        </div>
      </div>

      {/* Merge confirmation dialog */}
      {showMergeDialog && (
        <MergeDialog
          taskId={detail.task_id}
          taskTitle={detail.title}
          currentBranch={detail.worktree_branch ?? null}
          priorGateRuns={[]}
          onClose={() => setShowMergeDialog(false)}
          onSuccess={() => setShowMergeDialog(false)}
        />
      )}

      {/* Proposition block */}
      {detail.proposition_ids.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Proposition</h3>
          <div className="border border-border-muted bg-bg-secondary p-4">
            <p className="text-sm text-text-primary leading-relaxed">
              {detail.proposition_ids.map((id) => (
                <span key={id} className="font-mono text-xs text-text-secondary">
                  {id}{" "}
                </span>
              ))}
            </p>
          </div>
        </section>
      )}

      {/* Phase pipeline */}
      <section className="mb-6">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Phases</h3>
        <div className="flex gap-3">
          {enabledPhases.map((phase) => (
            <PhaseBox
              key={phase.name}
              phase={phase}
              currentPhase={listRow?.current_phase ?? undefined}
              taskStatus={detail.status}
            />
          ))}
          {enabledPhases.length === 0 && (
            <p className="text-sm text-text-tertiary">No phases configured.</p>
          )}
        </div>
      </section>

      {/* Gates */}
      {detail.config.gates.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Gates</h3>
          <div className="flex flex-wrap gap-2">
            {detail.config.gates.map((gate) => (
              <GatePill key={gate.name} gate={gate} />
            ))}
          </div>
        </section>
      )}

      {/* Retry policy + attempt counter */}
      <section>
        <div className="flex items-center justify-between border border-border-muted bg-bg-secondary px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary">retry:</span>
            <span className="text-xs text-text-primary font-medium">
              {retryPolicySummary(detail)}
            </span>
          </div>
          {listRow && (
            <span className="text-xs text-text-secondary font-mono">
              attempt {listRow.attempt_count}/{detail.config.retry_policy.max_total_attempts}
            </span>
          )}
        </div>
      </section>

      {/* Task timeline */}
      <TaskTimeline taskId={detail.task_id} status={detail.status} />
    </div>
  );
}

// ============================================================================
// Task timeline
// ============================================================================

function timelineColor(type: string): string {
  if (type.includes("approved") || type.includes("passed") || type === "attempt.completed") return "bg-status-healthy";
  if (type.includes("failed") || type.includes("rejected") || type.includes("killed")) return "bg-status-danger";
  if (type.includes("started") || type.includes("running") || type.includes("phase.")) return "bg-status-warning";
  return "bg-status-muted";
}

function timelineDetail(event: AnyEvent): string {
  const p = event.payload as unknown as Record<string, unknown>;
  if (p.from && p.to) return `${p.from} → ${p.to}`;
  if (p.phase_name) return String(p.phase_name);
  if (p.outcome) return String(p.outcome);
  if (p.gate_name) return String(p.gate_name);
  if (p.verdict) return `verdict: ${p.verdict}`;
  if (p.title) return String(p.title);
  if (p.reason) return String(p.reason);
  return "";
}

function formatTimelineTs(ts: string): string {
  return new Date(ts).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function TaskTimeline({ taskId, status }: { taskId: string; status?: TaskStatus }) {
  const { data: events, isLoading } = useTaskTimelineQuery(taskId, status);

  if (isLoading) {
    return (
      <section className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3">Timeline</h3>
        <p className="text-xs text-text-tertiary">Loading…</p>
      </section>
    );
  }

  if (events.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3">Timeline</h3>
      <div className="relative pl-4 border-l border-border-muted">
        {events.map((event) => {
          const detail = timelineDetail(event);
          return (
            <div key={event.id} className="relative flex items-start gap-3 py-1.5">
              <div className={`absolute -left-[calc(1rem+3px)] top-2.5 h-1.5 w-1.5 rounded-full ${timelineColor(event.type)}`} />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-[10px] text-text-tertiary w-32 shrink-0 font-mono">
                  {formatTimelineTs(event.ts)}
                </span>
                <span className="text-xs font-mono font-medium text-text-primary truncate">
                  {event.type}
                </span>
                {detail && (
                  <span className="text-xs text-text-secondary truncate">{detail}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
