import {
  createFileRoute,
  Outlet,
  useParams,
  useNavigate,
  Link,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTaskDetail, useTaskList } from "../store/eventStore.js";
import { TaskListSidebar } from "../screens/tasks/TaskListSidebar.js";
import { TaskDetailPane } from "../screens/tasks/TaskDetailPane.js";
import { DependencyGraph } from "../screens/tasks/DependencyGraph.js";
import { MergeDialog } from "../screens/review/MergeDialog.js";
import type { TaskStatus } from "@shared/events.js";
import { z } from "zod";
import { Logo } from "../components/Logo.js";

const statusFilterValues = ["ready", "running", "done", "blocked"] as const;
export type StatusFilterParam = (typeof statusFilterValues)[number];

const searchSchema = z.object({
  status: z.enum(statusFilterValues).optional(),
});

export const Route = createFileRoute("/tasks")({
  validateSearch: searchSchema,
  component: TasksLayout,
});

const APPROVED_STATUSES = new Set(["approved", "awaiting_merge"]);

type ViewMode = "list" | "graph";

const READY_STATUSES = new Set<TaskStatus>(["draft", "queued"]);
const RUNNING_STATUSES = new Set<TaskStatus>([
  "running",
  "paused",
  "revising",
  "awaiting_review",
]);
const DONE_STATUSES = new Set<TaskStatus>([
  "merged",
  "approved",
  "awaiting_merge",
]);
const BLOCKED_STATUSES = new Set<TaskStatus>(["blocked", "rejected"]);

function TasksLayout() {
  const tasks = useTaskList();
  const navigate = useNavigate();
  const { status: statusFilter } = Route.useSearch();

  const { data: archivedTasks } = useQuery({
    queryKey: ["archived_tasks"],
    queryFn: async () => {
      const res = await fetch("/api/projections/archived_tasks");
      if (!res.ok) return [];
      return res.json() as Promise<unknown[]>;
    },
  });
  const archivedCount = archivedTasks?.length ?? 0;

  // Get selected task ID from child route params
  const params = useParams({ strict: false }) as { taskId?: string };
  const selectedId = params.taskId ?? null;

  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedPrdId, setSelectedPrdId] = useState<string>("all");

  const taskDetail = useTaskDetail(selectedId ?? undefined);

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
    const opts: { value: string; label: string }[] = [
      { value: "all", label: "All" },
    ];
    for (const id of Array.from(prdIds).sort()) {
      opts.push({ value: id, label: id });
    }
    if (hasStandalone) opts.push({ value: "standalone", label: "Standalone" });
    return opts;
  }, [tasks]);

  const statusCounts = useMemo(() => {
    let ready = 0,
      running = 0,
      done = 0,
      blocked = 0;
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
      .catch(() => {});
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

  const selectedListRow = selectedId
    ? tasks.find((t) => t.task_id === selectedId)
    : undefined;

  // Merge dialog state
  const [mergeDialogTask, setMergeDialogTask] = useState<{
    taskId: string;
    taskTitle: string;
    attemptId: string;
  } | null>(null);
  const [mergeToast, setMergeToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setMergeToast(msg);
    setTimeout(() => setMergeToast(null), 2500);
  }, []);

  // Cmd+Shift+M — open merge dialog
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

  const handleViewDetails = useCallback(
    (taskId: string) => {
      navigate({ to: "/tasks/$taskId", params: { taskId } });
      setViewMode("list");
    },
    [navigate],
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* Status bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border-default bg-bg-secondary shrink-0">
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

        <div className="flex items-center gap-3 text-xs text-text-secondary">
          {(
            [
              {
                key: "ready",
                count: statusCounts.ready,
                color: "text-status-healthy",
              },
              {
                key: "running",
                count: statusCounts.running,
                color: "text-status-warning",
              },
              { key: "done", count: statusCounts.done, color: "text-blue-400" },
              {
                key: "blocked",
                count: statusCounts.blocked,
                color: "text-status-danger",
              },
            ] as const
          ).map(({ key, count, color }) => (
            <Link
              key={key}
              to="/tasks"
              search={{ status: statusFilter === key ? undefined : key }}
              className={`transition-colors hover:text-text-primary ${
                statusFilter === key ? `${color} font-medium` : ""
              }`}
            >
              <span className={`${color} font-medium`}>{count}</span> {key}
            </Link>
          ))}
          {archivedCount > 0 && (
            <Link
              to="/archive"
              className="hover:text-text-primary transition-colors"
            >
              <span className="text-text-tertiary font-medium">
                {archivedCount}
              </span>{" "}
              archived
            </Link>
          )}
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

      {/* View content */}
      {viewMode === "list" ? (
        <div className="flex flex-1 min-h-0">
          <TaskListSidebar
            tasks={tasks}
            selectedId={selectedId}
            currentBranch={currentBranch}
            statusFilter={statusFilter}
          />

          {selectedId && taskDetail ? (
            <TaskDetailPane
              detail={taskDetail}
              listRow={selectedListRow}
              allTasks={tasks}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <Logo size={58} />
              <p className="text-sm text-muted-foreground uppercase tracking-tight">
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

      {mergeToast && (
        <div
          role="status"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-bg-secondary border border-border-default px-4 py-2 text-sm text-text-primary shadow-lg pointer-events-none"
        >
          {mergeToast}
        </div>
      )}

      {/* Render child route dialogs (config, review) */}
      <Outlet />
    </div>
  );
}
