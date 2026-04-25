import { useCallback, useEffect, useRef } from "react";
import type { TaskStatus } from "@shared/events.js";
import { Button } from "@web/src/components/ui/button";

export type TaskDetailCardData = {
  taskId: string;
  title: string;
  status: TaskStatus;
  attempt_count: number;
  max_total_attempts: number;
  /** Screen-space position for the card */
  screenX: number;
  screenY: number;
};

type TaskDetailCardProps = {
  data: TaskDetailCardData;
  onDismiss: () => void;
  onViewDetails?: (taskId: string) => void;
};

const STATUS_PILL: Record<TaskStatus, string> = {
  draft: "bg-bg-tertiary text-text-secondary",
  queued: "bg-bg-tertiary text-text-secondary",
  running: "bg-status-warning/15 text-status-warning",
  paused: "bg-status-muted/15 text-status-muted",
  awaiting_review: "bg-status-warning/15 text-status-warning",
  revising: "bg-status-warning/15 text-status-warning",
  approved: "bg-purple-500/15 text-purple-400",
  awaiting_merge: "bg-purple-500/15 text-purple-400",
  merged: "bg-status-healthy/15 text-status-healthy",
  rejected: "bg-status-danger/15 text-status-danger",
  archived: "bg-bg-tertiary text-text-tertiary",
  blocked: "bg-status-danger/15 text-status-danger",
};

/** Task-level actions available from the graph card (no attemptId needed). */
const CARD_ACTIONS: Record<
  string,
  { label: string; action: string; destructive?: boolean }[]
> = {
  draft: [{ label: "Start", action: "start" }],
  queued: [{ label: "Start", action: "start" }],
  running: [
    { label: "Pause", action: "pause" },
    { label: "Retry", action: "retry" },
    { label: "Kill", action: "kill", destructive: true },
  ],
  paused: [
    { label: "Resume", action: "start" },
    { label: "Kill", action: "kill", destructive: true },
  ],
  awaiting_review: [{ label: "Retry", action: "retry" }],
  approved: [],
  rejected: [{ label: "Retry", action: "retry" }],
  merged: [],
  revising: [
    { label: "Pause", action: "pause" },
    { label: "Kill", action: "kill", destructive: true },
  ],
  awaiting_merge: [],
  blocked: [],
  archived: [],
};

export function TaskDetailCard({
  data,
  onDismiss,
  onViewDetails,
}: TaskDetailCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  // Dismiss on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Use a timeout so the click that opened the card doesn't immediately close it
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handler);
    };
  }, [onDismiss]);

  const handleAction = useCallback(
    async (action: string) => {
      const base = "/api/commands";
      let url: string;
      switch (action) {
        case "start":
          url = `${base}/task/${data.taskId}/start`;
          break;
        case "pause":
          url = `${base}/task/${data.taskId}/pause`;
          break;
        case "kill":
          url = `${base}/task/${data.taskId}/kill`;
          break;
        case "retry":
          url = `${base}/task/${data.taskId}/retry`;
          break;
        case "archive":
          url = `${base}/task/${data.taskId}/archive`;
          break;
        default:
          return;
      }
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    },
    [data.taskId],
  );

  const actions = CARD_ACTIONS[data.status] ?? [];

  return (
    <div
      ref={cardRef}
      className="absolute z-50 w-64 bg-bg-secondary border border-border-default shadow-lg"
      style={{ left: data.screenX, top: data.screenY }}
      data-testid="task-detail-card"
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-[10px] text-text-tertiary">
            {data.taskId}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL[data.status]}`}
          >
            {data.status.replace(/_/g, " ")}
          </span>
        </div>
        <p className="text-sm text-text-primary font-medium leading-snug">
          {data.title}
        </p>
        <div className="mt-1.5 text-[10px] text-text-tertiary font-mono">
          Attempt {data.attempt_count}/{data.max_total_attempts}
        </div>
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <Button
              key={a.action}
              size="xs"
              variant={a.destructive ? "destructive" : "outline"}
              onClick={() => handleAction(a.action)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}

      {/* View details link */}
      {onViewDetails && (
        <div className="border-t border-border-muted px-3 py-2">
          <button
            type="button"
            onClick={() => onViewDetails(data.taskId)}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            View details &rarr;
          </button>
        </div>
      )}
    </div>
  );
}
