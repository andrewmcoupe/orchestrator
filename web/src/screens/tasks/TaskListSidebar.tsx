import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Search, GitMerge } from "lucide-react";
import type { TaskListRow } from "@shared/projections.js";
import type { TaskStatus } from "@shared/events.js";
import { useCreateTask } from "../../hooks/useTaskMutations.js";
import { Button } from "@shared/components/ui/button.js";

type StatusFilter = "all" | "active" | "approved" | "done";

type TaskListSidebarProps = {
  tasks: TaskListRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onIngest?: () => void;
  /** Current branch of the main working tree — shown on approved task rows. */
  currentBranch?: string | null;
  /** Called when the merge icon on an approved task row is clicked. */
  onMergeIconClick?: (taskId: string, attemptId: string) => void;
};

/** Status dot colour mapped to design tokens */
const STATUS_DOT: Record<TaskStatus, string> = {
  draft: "bg-status-muted",
  queued: "bg-status-muted",
  running: "bg-status-warning",
  paused: "bg-status-muted",
  awaiting_review: "bg-status-warning",
  revising: "bg-status-warning",
  // approved = ready to merge; purple to differentiate from running/done
  approved: "bg-purple-500",
  awaiting_merge: "bg-purple-500",
  merged: "bg-status-healthy",
  rejected: "bg-status-danger",
  archived: "bg-status-muted",
  blocked: "bg-status-danger",
};

/** Statuses that count as "active" for the filter */
const ACTIVE_STATUSES: Set<TaskStatus> = new Set([
  "running",
  "revising",
  "awaiting_review",
  "paused",
  "queued",
  "draft",
]);

/** Statuses that count as "done" for the filter */
const DONE_STATUSES: Set<TaskStatus> = new Set([
  "merged",
  "rejected",
  "archived",
]);

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

export function TaskListSidebar({
  tasks,
  selectedId,
  onSelect,
  onIngest,
  currentBranch,
  onMergeIconClick,
}: TaskListSidebarProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const createTask = useCreateTask();

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
          onSelect(data.payload.task_id);
        },
      },
    );
  }, [newTitle, createTask, onSelect]);

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
    // Status filter
    if (statusFilter === "active") {
      result = result.filter((t) => ACTIVE_STATUSES.has(t.status));
    } else if (statusFilter === "approved") {
      result = result.filter((t) => APPROVED_STATUSES.has(t.status));
    } else if (statusFilter === "done") {
      result = result.filter((t) => DONE_STATUSES.has(t.status));
    }
    return result;
  }, [tasks, search, statusFilter]);

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
          {/* Status filter dropdown */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Status filter"
            className="border border-border-default bg-bg-secondary px-1.5 py-1.5 text-xs text-text-secondary outline-none cursor-pointer hover:text-text-primary transition-colors"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="approved">Approved</option>
            <option value="done">Done</option>
          </select>
        </div>

        {/* "N ready to merge" counter */}
        {approvedCount > 0 && (
          <button
            type="button"
            onClick={() => setStatusFilter("approved")}
            className="text-left text-xs text-purple-400 hover:text-purple-300 transition-colors font-medium"
          >
            {approvedCount} ready to merge
          </button>
        )}

        <div className="flex gap-2">
          {onIngest && (
            <button
              type="button"
              onClick={onIngest}
              className="grow shrink-0 border border-border-default px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors font-medium"
              title="Ingest PRD"
            >
              + ingest
            </button>
          )}
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
                isApproved && !!task.current_attempt_id && !!onMergeIconClick;

              return (
                <button
                  key={task.task_id}
                  type="button"
                  onClick={() =>
                    onSelect(task.task_id === selectedId ? null : task.task_id)
                  }
                  className={`w-full text-left px-3 py-2.5 border-l-2 transition-colors cursor-pointer group ${
                    task.task_id === selectedId
                      ? "border-l-status-warning bg-bg-secondary"
                      : "border-l-transparent hover:bg-bg-secondary"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className={`inline-block h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[task.status]}`}
                    />
                    <span className="text-xs font-mono text-text-secondary">
                      {task.task_id}
                    </span>
                    {/* Merge icon for approved tasks — visible always (subtle), focus on hover */}
                    {canMerge && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Open merge review"
                        title="Open review to merge"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMergeIconClick(
                            task.task_id,
                            task.current_attempt_id!,
                          );
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            e.preventDefault();
                            onMergeIconClick(
                              task.task_id,
                              task.current_attempt_id!,
                            );
                          }
                        }}
                        className="ml-auto shrink-0 p-0.5 text-purple-400 opacity-50 hover:opacity-100 hover:text-purple-200 hover:bg-purple-900/20 transition-all cursor-pointer"
                      >
                        <GitMerge size={12} />
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium text-text-primary truncate flex items-center gap-1.5">
                    {task.title}
                    {task.status === "merged" && task.auto_merged && (
                      <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 bg-purple-500/15 text-purple-400 border border-purple-500/25">
                        auto
                      </span>
                    )}
                  </div>
                  <div
                    className={`text-xs mt-0.5 ${isApproved ? "text-purple-400" : "text-text-tertiary"}`}
                  >
                    {statusLine(task, currentBranch)}
                  </div>
                </button>
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
