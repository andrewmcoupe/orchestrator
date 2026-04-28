import { useState, useEffect, useRef } from "react";
import { createRootRoute, Outlet, useNavigate, useMatches } from "@tanstack/react-router";
import { useHotkeys } from "../hooks/useHotkeys.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@web/src/components/ui/tooltip";
import { ThemeProvider } from "../components/theme-provider.js";
import { TopBar } from "../components/TopBar.js";
import { Rail } from "../components/Rail.js";
import { EventStreamStrip } from "../components/EventStreamStrip.js";
import { useEventStore, useProviderHealth, useRecentEvents } from "../store/eventStore.js";
import { createSSEClient } from "../lib/sse.js";
import type { SSEClient } from "../lib/sse.js";
import type { ProviderInfo } from "../components/TopBar.js";
import type { ProviderStatus } from "../components/ProviderPill.js";

const queryClient = new QueryClient();

type Section = "tasks" | "prompts" | "providers" | "measurement" | "settings" | "guide" | "ingest";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [connected, setConnected] = useState(false);
  const sseRef = useRef<SSEClient | null>(null);
  const navigate = useNavigate();

  const hydrate = useEventStore((s) => s.hydrate);
  const applyEvent = useEventStore((s) => s.applyEvent);

  // Derive active section from the current route
  const matches = useMatches();
  const topPath = matches[1]?.pathname?.split("/").filter(Boolean)[0] ?? "tasks";
  const activeSection = (["tasks", "prompts", "providers", "measurement", "settings", "guide", "ingest"].includes(topPath)
    ? topPath
    : "tasks") as Section;

  // Provider health from the store
  const providerHealthRows = useProviderHealth();
  const providers: ProviderInfo[] = providerHealthRows.length > 0
    ? providerHealthRows.map((r) => ({
        name: r.provider_id,
        status: r.status as ProviderStatus,
      }))
    : [
        { name: "claude", status: "unknown" as ProviderStatus },
        { name: "codex", status: "unknown" as ProviderStatus },
        { name: "gemini", status: "unknown" as ProviderStatus },
        { name: "local", status: "unknown" as ProviderStatus },
      ];

  const recentEvents = useRecentEvents();
  const latestEvent = recentEvents[0]
    ? {
        type: recentEvents[0].type,
        ts: recentEvents[0].ts,
        detail: recentEvents[0].aggregate_id,
      }
    : null;

  // Hydrate on mount, then connect SSE
  useEffect(() => {
    hydrate().then(() => {
      const sse = createSSEClient();
      sseRef.current = sse;

      const hydratedEvents = useEventStore.getState().recentEvents;
      if (hydratedEvents.length > 0) {
        sse.setLastSeenId(hydratedEvents[0].id);
      }

      sse.subscribe(applyEvent);
      sse.onConnection(setConnected);
      sse.connect();
    });

    return () => {
      sseRef.current?.close();
    };
  }, [hydrate, applyEvent]);

  // Keyboard shortcuts for section navigation (⌘1..⌘5)
  useHotkeys(navigate);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="orchestrator-ui-theme">
        <TooltipProvider>
          <div className="flex flex-col h-screen overflow-hidden">
            <TopBar
              section={activeSection}
              providers={providers}
            />

            <div className="flex flex-1 min-h-0">
              <Rail />
              <main className="flex-1 min-h-0 overflow-hidden bg-bg-primary">
                <Outlet />
              </main>
            </div>

            <EventStreamStrip
              connected={connected}
              latestEvent={latestEvent}
              events={recentEvents}
            />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
