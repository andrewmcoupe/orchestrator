import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, ClipboardList, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../components/ui/dialog.js";
import type { TaskDetailRow } from "@shared/projections.js";

export const Route = createFileRoute("/archive")({
  component: Archive,
});

function Archive() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);

  const { data: archivedTasks = [], isLoading } = useQuery({
    queryKey: ["archived_tasks"],
    queryFn: async () => {
      const res = await fetch("/api/projections/archived_tasks");
      if (!res.ok) return [];
      return res.json() as Promise<TaskDetailRow[]>;
    },
  });

  const deleteOne = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(`/api/commands/task/${taskId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete task");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["archived_tasks"] });
      setDeleteTarget(null);
    },
  });

  const deleteAll = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/commands/archived_tasks", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete archived tasks");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["archived_tasks"] });
      setShowDeleteAll(false);
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-default bg-bg-secondary shrink-0">
        <div className="flex items-center gap-3">
          <Link
            to="/tasks"
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-sm font-medium text-text-primary">
            Archived Tasks
          </h1>
          <span className="text-xs text-text-tertiary">
            {archivedTasks.length} {archivedTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        {archivedTasks.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteAll(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete all
          </Button>
        )}
      </div>

      {/* Task list */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">Loading...</p>
        </div>
      ) : archivedTasks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-tertiary">No archived tasks.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {archivedTasks.map((task) => (
            <div
              key={task.task_id}
              className="flex items-center justify-between px-4 py-3 border-b border-border-muted hover:bg-bg-secondary transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm text-text-primary truncate">
                  {task.title}
                </p>
                <p className="text-xs text-text-tertiary mt-0.5">
                  {task.task_id}
                  {task.prd_id && <span> · {task.prd_id}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {task.current_attempt_id && (
                  <Link
                    to="/tasks/$taskId/review/$attemptId"
                    params={{
                      taskId: task.task_id,
                      attemptId: task.current_attempt_id,
                    }}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <ClipboardList className="h-3.5 w-3.5" />
                    View diff
                  </Link>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteTarget({ id: task.task_id, title: task.title })}
                  className="text-text-tertiary hover:text-status-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete single task confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete archived task</DialogTitle>
            <DialogDescription>
              Permanently remove "{deleteTarget?.title}" from the archive? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteOne.mutate(deleteTarget.id)}
              disabled={deleteOne.isPending}
            >
              {deleteOne.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete all confirmation */}
      <Dialog open={showDeleteAll} onOpenChange={setShowDeleteAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all archived tasks</DialogTitle>
            <DialogDescription>
              Permanently remove all {archivedTasks.length} archived tasks? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => deleteAll.mutate()}
              disabled={deleteAll.isPending}
            >
              {deleteAll.isPending ? "Deleting..." : `Delete all (${archivedTasks.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
