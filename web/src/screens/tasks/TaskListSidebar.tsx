import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Search, GitMerge, Lock, AlertTriangle } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TaskListRow } from "@shared/projections.js";
import type { TaskStatus } from "@shared/events.js";
import type { StatusFilterParam } from "../../routes/tasks.js";
import { useCreateTask } from "../../hooks/useTaskMutations.js";
import { Button } from "@web/src/components/ui/button.js";

type TaskListSidebarProps = {
  tasks: TaskListRow[];
  selectedId: string | null;
  /** Current branch of the main working tree — shown on approved task rows. */
  currentBranch?: string | null;
  /** Status filter from URL search param */
  statusFilter?: StatusFilterParam;
};

/** Status dot colour — synced with the status count strip in the toolbar */
const STATUS_DOT: Record<TaskStatus, string> = {
  draft: "bg-status-muted",
  queued: "bg-status-healthy",       // "ready" = green
  running: "bg-status-warning",
  paused: "bg-status-warning",
  awaiting_review: "bg-status-warning",
  revising: "bg-status-warning",
  approved: "bg-blue-400",           // "done" = blue
  awaiting_merge: "bg-blue-400",
  merged: "bg-blue-400",
  rejected: "bg-status-danger",
  archived: "bg-status-muted",
  blocked: "bg-status-danger",
};

/** Statuses that count as "approved" for the filter */
const APPROVED_STATUSES: Set<TaskStatus> = new Set([
  "approved",
  "awaiting_merge",
]);

/** Human-readable status line for the sidebar */
function statusLine(row: TaskListRow, currentBranch?: string | null): string {
  // Approved tasks get a special "ready to merge" line
  if (APPROVED_STATUSES.has(row.status)) {
    const branch = currentBranch ?? "main";
    return `ready to merge → ${branch}`;
  }
  const parts: string[] = [row.status];
  if (
    row.current_phase &&
    (row.status === "running" || row.status === "revising")
  ) {
    parts.push(row.current_phase);
  }
  if (row.pushback_count > 0) {
    parts.push("spec pushback");
  }
  if (row.status === "awaiting_review") {
    parts[0] = "auditor flagged";
  }
  return parts.join(" \u00b7 ");
}

/** Group tasks by prd_id for PRD group headers */
function groupByPrd(
  tasks: TaskListRow[],
): { prdId: string | null; label: string; tasks: TaskListRow[] }[] {
  const groups = new Map<string | null, TaskListRow[]>();
  for (const t of tasks) {
    const key = t.prd_id ?? null;
    const group = groups.get(key);
    if (group) {
      group.push(t);
    } else {
      groups.set(key, [t]);
    }
  }
  return Array.from(groups.entries()).map(([prdId, tasks]) => ({
    prdId,
    label: prdId ?? "Standalone Tasks",
    tasks,
  }));
}

const READY_STATUSES: Set<TaskStatus> = new Set(["draft", "queued"]);
const RUNNING_STATUSES: Set<TaskStatus> = new Set(["running", "paused", "revising", "awaiting_review"]);
const DONE_STATUSES_SIDEBAR: Set<TaskStatus> = new Set(["merged", "approved", "awaiting_merge"]);
const BLOCKED_STATUSES_SIDEBAR: Set<TaskStatus> = new Set(["blocked", "rejected"]);

export function TaskListSidebar({
  tasks,
  selectedId,
  currentBranch,
  statusFilter,
}: TaskListSidebarProps) {
  const [search, setSearch] = useState("");
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const createTask = useCreateTask();
  const navigate = useNavigate();

  // Count of tasks in approved/awaiting_merge state (for the "N ready to merge" counter)
  const approvedCount = useMemo(
    () => tasks.filter((t) => APPROVED_STATUSES.has(t.status)).length,
    [tasks],
  );

  // Focus input when the inline form appears
  useEffect(() => {
    if (showNewTask) inputRef.current?.focus();
  }, [showNewTask]);

  const wordCount = newTitle.trim().split(/\s+/).filter(Boolean).length;
  const isTooShort = newTitle.trim().length > 0 && wordCount < 5;

  const handleCreate = useCallback(() => {
    const title = newTitle.trim();
    if (!title || title.split(/\s+/).filter(Boolean).length < 5) return;
    createTask.mutate(
      { title },
      {
        onSuccess: (data) => {
          setNewTitle("");
          setShowNewTask(false);
          navigate({
            to: "/tasks/$taskId",
            params: { taskId: data.payload.task_id },
          });
        },
      },
    );
  }, [newTitle, createTask, navigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleCreate();
      if (e.key === "Escape") {
        setShowNewTask(false);
        setNewTitle("");
      }
    },
    [handleCreate],
  );

  const filtered = useMemo(() => {
    let result = tasks;
    // Text search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.task_id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.status.toLowerCase().includes(q),
      );
    }
    // URL-based status filter
    if (statusFilter === "ready") {
      result = result.filter((t) => READY_STATUSES.has(t.status));
    } else if (statusFilter === "running") {
      result = result.filter((t) => RUNNING_STATUSES.has(t.status));
    } else if (statusFilter === "done") {
      result = result.filter((t) => DONE_STATUSES_SIDEBAR.has(t.status));
    } else if (statusFilter === "blocked") {
      result = result.filter((t) => BLOCKED_STATUSES_SIDEBAR.has(t.status));
    } else {
      // No filter — show all except drafts
      result = result.filter((t) => t.status !== "draft");
    }
    return result;
  }, [tasks, search, statusFilter]);

  /** Map task_id → status for dependency failure detection */
  const statusMap = useMemo(() => {
    const map = new Map<string, TaskStatus>();
    for (const t of tasks) map.set(t.task_id, t.status);
    return map;
  }, [tasks]);

  const TERMINAL_FAILURE: Set<TaskStatus> = useMemo(
    () => new Set(["rejected", "archived"]),
    [],
  );

  const groups = useMemo(() => groupByPrd(filtered), [filtered]);

  return (
    <aside className="w-72 shrink-0 border-r border-border-default bg-bg-primary flex flex-col overflow-hidden">
      {/* Search + actions */}
      <div className="p-3 flex flex-col gap-2 border-b border-border-muted">
        <div className="flex flex-col gap-2">
          <div className="flex-1 flex items-center gap-2 border border-border-default bg-bg-secondary px-2.5 py-1.5">
            <Search size={14} className="text-text-tertiary shrink-0" />
            <input
              type="text"
              placeholder="search tasks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none flex-1 min-w-0"
            />
          </div>
        </div>

        {/* "N ready to merge" counter */}
        {approvedCount > 0 && (
          <Link
            to="/tasks"
            search={{ status: statusFilter === "done" ? undefined : "done" }}
            className="text-left text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
          >
            {approvedCount} ready to merge
          </Link>
        )}

        <div className="flex gap-2">
          <Link
            to="/ingest"
            className="grow shrink-0 border border-border-default px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors font-medium text-center"
            title="Ingest PRD"
          >
            + ingest
          </Link>
          <button
            type="button"
            onClick={() => setShowNewTask((v) => !v)}
            className="shrink-0 flex border border-border-default p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors text-lg leading-none cursor-pointer"
            title="New task"
          >
            +
          </button>
        </div>
      </div>

      {/* Inline new-task form */}
      {showNewTask && (
        <div className="px-3 py-2 border-b border-border-muted bg-bg-secondary">
          <input
            ref={inputRef}
            type="text"
            placeholder="Task title…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={createTask.isPending}
            className="w-full border border-border-default bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none mb-2"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-tertiary">
              {isTooShort
                ? `${5 - wordCount} more ${5 - wordCount === 1 ? "word" : "words"} needed`
                : "Enter to create · Esc to cancel"}
            </span>
            <Button
              size="xs"
              onClick={handleCreate}
              disabled={!newTitle.trim() || isTooShort || createTask.isPending}
            >
              {createTask.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
          {createTask.isError && (
            <p className="text-xs text-status-danger mt-1">
              {createTask.error.message}
            </p>
          )}
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-3 pt-4 pb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-medium">
                {group.label}
              </span>
            </div>
            {group.tasks.map((task) => {
              const isApproved = APPROVED_STATUSES.has(task.status);
              const canMerge =
                isApproved && !!task.current_attempt_id;
              const isBlocked = !!task.blocked;
              const hasFailedDep =
                isBlocked &&
                (task.depends_on ?? []).some((id) => {
                  const s = statusMap.get(id);
                  return s != null && TERMINAL_FAILURE.has(s);
                });

              return (
                <Link
                  key={task.task_id}
                  to="/tasks/$taskId"
                  params={{ taskId: task.task_id }}
                  className={`block w-full text-left px-3 py-2.5 border-l-2 transition-colors cursor-pointer group ${
                    task.task_id === selectedId
                      ? "border-l-status-warning bg-bg-secondary"
                      : "border-l-transparent hover:bg-bg-secondary"
                  }${isBlocked ? " opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className={`inline-block h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[task.status]}`}
                    />
                    <span className="text-xs font-mono text-text-secondary">
                      {task.task_id}
                    </span>
                    {isBlocked && (
                      <Lock size={12} className="shrink-0 text-text-tertiary" aria-label="Blocked" />
                    )}
                    {hasFailedDep && (
                      <AlertTriangle size={12} className="shrink-0 text-status-danger" aria-label="Dependency failed" />
                    )}
                    {/* Merge icon for approved tasks — navigates to review */}
                    {canMerge && (
                      <Link
                        to="/tasks/$taskId/review/$attemptId"
                        params={{
                          taskId: task.task_id,
                          attemptId: task.current_attempt_id!,
                        }}
                        aria-label="Open merge review"
                        title="Open review to merge"
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto shrink-0 p-0.5 text-blue-400 opacity-50 hover:opacity-100 hover:text-blue-300 hover:bg-blue-900/20 transition-all cursor-pointer"
                      >
                        <GitMerge size={12} />
                      </Link>
                    )}
                  </div>
                  <div className="text-sm font-medium text-text-primary truncate flex items-center gap-1.5">
                    {task.title}
                    {task.status === "merged" && task.auto_merged && (
                      <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 bg-blue-400/15 text-blue-400 border border-blue-400/25">
                        auto
                      </span>
                    )}
                  </div>
                  <div
                    className={`text-xs mt-0.5 ${isApproved ? "text-blue-400" : "text-text-tertiary"}`}
                  >
                    {isBlocked
                      ? `Blocked by ${(task.depends_on ?? []).join(", ")}`
                      : statusLine(task, currentBranch)}
                  </div>
                </Link>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-text-tertiary p-4 text-center">
            {search ? "No tasks match your search." : "No tasks yet."}
          </p>
        )}
      </div>
    </aside>
  );
}
