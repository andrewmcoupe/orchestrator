import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useNavigate, useParams} from "@tanstack/react-router";
import {useEventStore, useTaskDetail, useTaskList,} from "../../store/eventStore.js";
import {TaskListSidebar} from "./TaskListSidebar.js";
import {TaskDetailPane} from "./TaskDetailPane.js";
import {DependencyGraph} from "./DependencyGraph.js";
import {MergeDialog} from "../review/MergeDialog.js";
import type {TaskStatus} from "@shared/events.js";

type TasksProps = {};

/** Statuses that are approved-but-not-merged */
const APPROVED_STATUSES = new Set(["approved", "awaiting_merge"]);

type ViewMode = "list" | "graph";

const READY_STATUSES = new Set<TaskStatus>(["draft", "queued"]);
const RUNNING_STATUSES = new Set<TaskStatus>(["running", "paused", "revising", "awaiting_review"]);
const DONE_STATUSES = new Set<TaskStatus>(["merged", "approved", "awaiting_merge", "archived"]);
const BLOCKED_STATUSES = new Set<TaskStatus>(["blocked", "rejected"]);

/**
 * Cockpit screen — the default Tasks view.
 * Supports list mode (sidebar + detail pane) and graph mode (full-width dependency graph).
 */
export function Tasks({}: TasksProps) {
  const tasks = useTaskList();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { taskId?: string };
  const selectedId = params.taskId ?? null;
  const selectTask = useCallback(
    (id: string | null) => {
      if (id) {
        navigate({ to: "/tasks/$taskId", params: { taskId: id } });
      } else {
        navigate({ to: "/tasks" });
      }
    },
    [navigate],
  );
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedPrdId, setSelectedPrdId] = useState<string>("all");

  // Fetch task detail when selected (the store may not have it from hydration)
  const taskDetail = useTaskDetail(selectedId ?? undefined);
  const applyEvent = useEventStore((s) => s.applyEvent);

  // Current branch of the main working tree — polled every 3s when approved tasks exist
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const branchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const approvedCount = tasks.filter((t) =>
    APPROVED_STATUSES.has(t.status),
  ).length;

  const prdOptions = useMemo(() => {
    const prdIds = new Set<string>();
    let hasStandalone = false;
    for (const t of tasks) {
      if (t.prd_id) prdIds.add(t.prd_id);
      else hasStandalone = true;
    }
    const opts: { value: string; label: string }[] = [{ value: "all", label: "All" }];
    for (const id of Array.from(prdIds).sort()) {
      opts.push({ value: id, label: id });
    }
    if (hasStandalone) opts.push({ value: "standalone", label: "Standalone" });
    return opts;
  }, [tasks]);

  const statusCounts = useMemo(() => {
    let ready = 0, running = 0, done = 0, blocked = 0;
    for (const t of tasks) {
      if (READY_STATUSES.has(t.status)) ready++;
      else if (RUNNING_STATUSES.has(t.status)) running++;
      else if (DONE_STATUSES.has(t.status)) done++;
      else if (BLOCKED_STATUSES.has(t.status)) blocked++;
    }
    return { ready, running, done, blocked };
  }, [tasks]);

  const fetchCurrentBranch = useCallback(() => {
    fetch("/api/repo/current-branch")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { branch: string } | null) => {
        if (data?.branch) setCurrentBranch(data.branch);
      })
      .catch(() => {
        /* ignore network errors */
      });
  }, []);

  useEffect(() => {
    if (approvedCount > 0) {
      fetchCurrentBranch();
      branchPollRef.current = setInterval(fetchCurrentBranch, 3000);
    }
    return () => {
      if (branchPollRef.current) clearInterval(branchPollRef.current);
    };
  }, [approvedCount, fetchCurrentBranch]);

  // Hydrate task detail from REST if not in store
  useEffect(() => {
    if (!selectedId || taskDetail) return;
    fetch(`/api/projections/task_detail/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((detail) => {
        if (detail) {
          // Seed the store with this task detail
          useEventStore.setState((s) => ({
            taskDetail: { ...s.taskDetail, [selectedId]: detail },
          }));
        }
      })
      .catch(() => {
        /* task may not exist */
      });
  }, [selectedId, taskDetail, applyEvent]);

  // Find matching list row for the selected task
  const selectedListRow = selectedId
    ? tasks.find((t) => t.task_id === selectedId)
    : undefined;

  // ── Merge dialog state (opened via Cmd+Shift+M shortcut) ─────────────────
  const [mergeDialogTask, setMergeDialogTask] = useState<{
    taskId: string;
    taskTitle: string;
    attemptId: string;
  } | null>(null);
  const [mergeToast, setMergeToast] = useState<string | null>(null);

  // Show a brief toast then auto-dismiss
  const showToast = useCallback((msg: string) => {
    setMergeToast(msg);
    setTimeout(() => setMergeToast(null), 2500);
  }, []);

  // Cmd+Shift+M — open merge dialog for the selected approved task
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key !== "M") return;
      e.preventDefault();
      if (!selectedId) {
        showToast("Select a task first");
        return;
      }
      const task = tasks.find((t) => t.task_id === selectedId);
      if (!task || !APPROVED_STATUSES.has(task.status)) {
        showToast("Task must be approved before merging");
        return;
      }
      if (!task.current_attempt_id) {
        showToast("No active attempt found for this task");
        return;
      }
      setMergeDialogTask({
        taskId: task.task_id,
        taskTitle: task.title,
        attemptId: task.current_attempt_id,
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, tasks, showToast]);

  /** Switch to list view and select a task (used by graph's "View details" link) */
  const handleViewDetails = useCallback(
    (taskId: string) => {
      selectTask(taskId);
      setViewMode("list");
    },
    [selectTask],
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* ── Status bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border-default bg-bg-secondary shrink-0">
        {/* View toggle */}
        <div className="flex items-center rounded border border-border-default overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={`px-2.5 py-1 transition-colors cursor-pointer ${
              viewMode === "list"
                ? "bg-bg-tertiary text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
            aria-pressed={viewMode === "list"}
          >
            List
          </button>
          <button
            type="button"
            onClick={() => setViewMode("graph")}
            className={`px-2.5 py-1 transition-colors cursor-pointer ${
              viewMode === "graph"
                ? "bg-bg-tertiary text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
            aria-pressed={viewMode === "graph"}
          >
            Graph
          </button>
        </div>

        <div className="w-px h-4 bg-border-default" />

        {/* Status counts */}
        <div className="flex items-center gap-3 text-xs text-text-secondary">
          <span>
            <span className="text-status-healthy font-medium">{statusCounts.ready}</span> ready
          </span>
          <span>
            <span className="text-status-warning font-medium">{statusCounts.running}</span> running
          </span>
          <span>
            <span className="text-blue-400 font-medium">{statusCounts.done}</span> done
          </span>
          <span>
            <span className="text-status-danger font-medium">{statusCounts.blocked}</span> blocked
          </span>
        </div>

        {viewMode === "graph" && prdOptions.length > 1 && (
          <>
            <div className="w-px h-4 bg-border-default" />
            <select
              value={selectedPrdId}
              onChange={(e) => setSelectedPrdId(e.target.value)}
              className="text-xs bg-bg-primary border border-border-default rounded px-2 py-1 text-text-primary cursor-pointer"
            >
              {prdOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* ── View content ───────────────────────────────────────────── */}
      {viewMode === "list" ? (
        <div className="flex flex-1 min-h-0">
          <TaskListSidebar
            tasks={tasks}
            selectedId={selectedId}
            currentBranch={currentBranch}
          />

          {selectedId && taskDetail ? (
            <TaskDetailPane
              detail={taskDetail}
              listRow={selectedListRow}
              allTasks={tasks}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-tertiary opacity-40"
              >
                <path d="M12 22V12" />
                <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
                <rect x="7" y="2" width="10" height="8" rx="2" />
                <path d="M6 2v4" />
                <path d="M18 2v4" />
              </svg>
              <p className="text-sm text-text-tertiary">
                {tasks.length > 0
                  ? "Select a task to view details."
                  : "No tasks yet. Ingest a PRD or create a task to get started."}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <DependencyGraph
            onViewDetails={handleViewDetails}
            prdId={selectedPrdId === "all" ? undefined : selectedPrdId}
          />
        </div>
      )}

      {/* Merge dialog — opened via Cmd+Shift+M from approved task */}
      {mergeDialogTask && (
        <MergeDialog
          taskId={mergeDialogTask.taskId}
          taskTitle={mergeDialogTask.taskTitle}
          currentBranch={currentBranch}
          priorGateRuns={[]}
          onClose={() => setMergeDialogTask(null)}
          onSuccess={() => setMergeDialogTask(null)}
        />
      )}

      {/* Toast for Cmd+Shift+M on non-approved task */}
      {mergeToast && (
        <div
          role="status"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-bg-secondary border border-border-default px-4 py-2 text-sm text-text-primary shadow-lg pointer-events-none"
        >
          {mergeToast}
        </div>
      )}
    </div>
  );
}
