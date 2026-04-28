import { useState, useEffect, useRef } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@web/src/components/ui/tooltip";
import { ThemeProvider } from "../components/theme-provider.js";
import { TopBar } from "../components/TopBar.js";
import { Rail } from "../components/Rail.js";
import { EventStreamStrip } from "../components/EventStreamStrip.js";
import { useEventStore, useProviderHealth, useRecentEvents, useTaskDetail } from "../store/eventStore.js";
import { createSSEClient } from "../lib/sse.js";
import type { SSEClient } from "../lib/sse.js";
import type { ProviderInfo } from "../components/TopBar.js";
import type { ProviderStatus } from "../components/ProviderPill.js";

const queryClient = new QueryClient();

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [stripVisible, setStripVisible] = useState(true);
  const [connected, setConnected] = useState(false);
  const sseRef = useRef<SSEClient | null>(null);

  const hydrate = useEventStore((s) => s.hydrate);
  const applyEvent = useEventStore((s) => s.applyEvent);

  // Provider health from the store (falls back to stubs for fresh DBs)
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

  // Derive correlation filter for the event stream strip
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

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="orchestrator-ui-theme">
        <TooltipProvider>
          <div className="flex flex-col h-screen overflow-hidden">
            <TopBar
              section="tasks"
              providers={providers}
              onProviderClick={() => {}}
            />

            <div className="flex flex-1 min-h-0">
              <Rail active="tasks" onNavigate={() => {}} />
              <main className="flex-1 min-h-0 overflow-hidden bg-bg-primary">
                <Outlet />
              </main>
            </div>

            <EventStreamStrip
              visible={stripVisible}
              connected={connected}
              latestEvent={latestEvent}
              events={recentEvents}
              onToggleFilter={() => {}}
              onToggleVisible={() => setStripVisible(false)}
            />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
