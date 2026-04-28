import { createFileRoute } from "@tanstack/react-router";
import { Tasks } from "../screens/tasks/Tasks.js";

export const Route = createFileRoute("/tasks")({
  component: Tasks,
});
