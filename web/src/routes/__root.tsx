import { useState, useEffect, useRef } from "react";
import { createRootRoute, Outlet, useNavigate, useMatches } from "@tanstack/react-router";
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
  const [stripVisible, setStripVisible] = useState(true);
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

  // Keyboard shortcuts for section navigation
  useEffect(() => {
    const sections = ["/tasks", "/prompts", "/providers", "/measurement", "/settings"] as const;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= 5) {
        e.preventDefault();
        navigate({ to: sections[idx - 1] });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  const handleNavigate = (section: string) => {
    navigate({ to: `/${section}` as any });
  };

  const handleProviderClick = (name: string) => {
    navigate({ to: "/providers", search: { focus: name } });
  };

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="orchestrator-ui-theme">
        <TooltipProvider>
          <div className="flex flex-col h-screen overflow-hidden">
            <TopBar
              section={activeSection}
              providers={providers}
              onProviderClick={handleProviderClick}
            />

            <div className="flex flex-1 min-h-0">
              <Rail active={activeSection} onNavigate={handleNavigate} />
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
              onToggleVisible={() => setStripVisible((v) => !v)}
            />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
