import { createFileRoute } from "@tanstack/react-router";
import { Guide } from "../screens/guide/Guide.js";

export const Route = createFileRoute("/guide")({
  component: Guide,
});
