import { createFileRoute } from "@tanstack/react-router";
import { Providers } from "../screens/providers/Providers.js";
import { z } from "zod";

const searchSchema = z.object({
  focus: z.string().optional(),
});

export const Route = createFileRoute("/providers")({
  validateSearch: searchSchema,
  component: ProvidersRoute,
});

function ProvidersRoute() {
  const { focus } = Route.useSearch();
  return <Providers focusedProvider={focus} />;
}
