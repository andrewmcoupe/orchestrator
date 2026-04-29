import { AlertTriangle } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useProviderHealth, useHydrated } from "../store/eventStore.js";

export function NoProvidersBanner() {
  const providerHealthRows = useProviderHealth();
  const hydrated = useHydrated();

  // Don't render while still hydrating
  if (!hydrated) return null;

  // Don't render if no provider data yet (still loading)
  if (providerHealthRows.length === 0) return null;

  // Hide if any provider is available
  const anyAvailable = providerHealthRows.some(
    (r) => r.auth_present || r.status === "healthy",
  );
  if (anyAvailable) return null;

  return (
    <div
      data-testid="no-providers-banner"
      className="w-full bg-status-danger border-b border-status-danger/20 px-4 py-2 flex items-center gap-3"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="flex-1 text-sm">
        <span className="font-semibold">No AI providers available.</span>{" "}
        Add an API key to{" "}
        <code className="font-mono">.orchestrator/.env.local</code> or sign in
        via a CLI tool (e.g.{" "}
        <code className="font-mono">claude login</code>) to start running
        tasks.
      </div>
      <Link
        to="/providers"
        className="shrink-0 text-xs font-medium px-3 py-1 bg-bg-inverse text-text-inverse hover:opacity-80 transition-opacity"
      >
        Open provider settings
      </Link>
    </div>
  );
}
