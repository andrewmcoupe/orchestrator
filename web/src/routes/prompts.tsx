import { createFileRoute } from "@tanstack/react-router";
import { Prompts } from "../screens/prompts/Prompts.js";

export const Route = createFileRoute("/prompts")({
  component: Prompts,
});
