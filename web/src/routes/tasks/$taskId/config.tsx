import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { TaskConfig } from "../../../screens/config/TaskConfig.js";

export const Route = createFileRoute("/tasks/$taskId/config")({
  component: ConfigDialog,
});

function ConfigDialog() {
  const { taskId } = useParams({ from: "/tasks/$taskId/config" });
  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  }, [navigate, taskId]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Popup className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-none bg-bg-primary outline-none">
          <TaskConfig taskId={taskId} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
