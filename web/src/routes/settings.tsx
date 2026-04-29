import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "../screens/settings/Settings.js";

export const Route = createFileRoute("/settings")({
  component: Settings,
});
