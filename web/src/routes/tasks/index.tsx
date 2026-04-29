import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/")({
  component: TasksIndex,
});

function TasksIndex() {
  return null;
}
