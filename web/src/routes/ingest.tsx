import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Ingest } from "../screens/ingest/Ingest.js";
import {
  Dialog,
  DialogContent,
} from "../components/ui/dialog.js";

export const Route = createFileRoute("/ingest")({
  component: IngestRoute,
});

function IngestRoute() {
  const navigate = useNavigate();

  const handleClose = () => {
    navigate({ to: "/tasks" });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-[95vw] sm:max-w-[95vw] w-[95vw] h-[90vh] max-h-[90vh] overflow-y-auto p-0">
        <Ingest onBack={handleClose} />
      </DialogContent>
    </Dialog>
  );
}
