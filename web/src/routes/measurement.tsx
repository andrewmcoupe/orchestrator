import { createFileRoute } from "@tanstack/react-router";
import { Measurement } from "../screens/measurement/Measurement.js";

export const Route = createFileRoute("/measurement")({
  component: Measurement,
});
