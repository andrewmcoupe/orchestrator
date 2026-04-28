import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TaskConfig } from "../../../screens/config/TaskConfig.js";
import {
  Dialog,
  DialogContent,
} from "../../../components/ui/dialog.js";

export const Route = createFileRoute("/tasks/$taskId/config")({
  component: ConfigRoute,
});

function ConfigRoute() {
  const { taskId } = Route.useParams();
  const navigate = useNavigate();

  const handleClose = () => {
    navigate({ to: "/tasks/$taskId", params: { taskId } });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-[95vw] sm:max-w-[95vw] w-[95vw] h-[90vh] max-h-[90vh] overflow-y-auto p-0">
        <TaskConfig taskId={taskId} onBack={handleClose} />
      </DialogContent>
    </Dialog>
  );
}
