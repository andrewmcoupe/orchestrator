import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Ingest } from "../screens/ingest/Ingest.js";

export const Route = createFileRoute("/ingest")({
  component: IngestDialog,
});

function IngestDialog() {
  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    navigate({ to: "/tasks" });
  }, [navigate]);

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
          <Ingest />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
