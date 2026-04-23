import {useCallback, useEffect, useRef, useState} from "react";
import {useEventStore, useTaskDetail, useTaskList,} from "../../store/eventStore.js";
import {useSelectedTaskId} from "../../hooks/useSelectedTaskId.js";
import {TaskListSidebar} from "./TaskListSidebar.js";
import {TaskDetailPane} from "./TaskDetailPane.js";
import {MergeDialog} from "../review/MergeDialog.js";

type TasksProps = {
  onIngest?: () => void;
  onEditConfig?: (taskId: string) => void;
  onReview?: (taskId: string, attemptId: string) => void;
};

/** Statuses that are approved-but-not-merged */
const APPROVED_STATUSES = new Set(["approved", "awaiting_merge"]);

/**
 * Cockpit screen — the default Tasks view.
 * Left sidebar shows the task list; right pane shows detail for the selected task.
 * Fetches task detail on demand from the server projection when a task is selected.
 */
export function Tasks({ onIngest, onEditConfig, onReview }: TasksProps) {
  const tasks = useTaskList();
  const [selectedId, selectTask] = useSelectedTaskId();

  // Fetch task detail when selected (the store may not have it from hydration)
  const taskDetail = useTaskDetail(selectedId ?? undefined);
  const applyEvent = useEventStore((s) => s.applyEvent);

  // Current branch of the main working tree — polled every 3s when approved tasks exist
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const branchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const approvedCount = tasks.filter((t) =>
    APPROVED_STATUSES.has(t.status),
  ).length;

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

  /** Navigate to the review screen for an approved task's merge action */
  const handleMergeIconClick = useCallback(
    (taskId: string, attemptId: string) => {
      onReview?.(taskId, attemptId);
    },
    [onReview],
  );

  return (
    <div className="flex h-full relative">
      <TaskListSidebar
        tasks={tasks}
        selectedId={selectedId}
        onSelect={selectTask}
        onIngest={onIngest}
        currentBranch={currentBranch}
        onMergeIconClick={onReview ? handleMergeIconClick : undefined}
      />

      {selectedId && taskDetail ? (
        <TaskDetailPane
          detail={taskDetail}
          listRow={selectedListRow}
          onEditConfig={
            onEditConfig ? () => onEditConfig(selectedId) : undefined
          }
          onReview={onReview}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">

          <p className="text-sm text-text-tertiary">
            {tasks.length > 0
              ? "Select a task to view details."
              : "No tasks yet. Ingest a PRD or create a task to get started."}
          </p>
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
