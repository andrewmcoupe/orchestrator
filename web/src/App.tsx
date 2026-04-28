import { useState, useEffect, useRef, useCallback } from "react";
import { TopBar } from "./components/TopBar.js";
import { Rail } from "./components/Rail.js";
import { EventStreamStrip } from "./components/EventStreamStrip.js";
import { useSection } from "./hooks/useSection.js";
import { useHotkeys } from "./hooks/useHotkeys.js";
import { useSelectedTaskId } from "./hooks/useSelectedTaskId.js";
import { useEventStore, useProviderHealth, useRecentEvents, useTaskDetail } from "./store/eventStore.js";
import { createSSEClient } from "./lib/sse.js";
import type { SSEClient } from "./lib/sse.js";
import type { Section } from "./hooks/useSection.js";
import type { ProviderInfo } from "./components/TopBar.js";
import type { ProviderStatus } from "./components/ProviderPill.js";

/* Screens */
import { Tasks } from "./screens/tasks/Tasks.js";
import { Prompts } from "./screens/prompts/Prompts.js";
import { Providers } from "./screens/providers/Providers.js";
import { Measurement } from "./screens/measurement/Measurement.js";
import { Settings } from "./screens/settings/Settings.js";
import { Ingest } from "./screens/ingest/Ingest.js";
import { TaskConfig } from "./screens/config/TaskConfig.js";
import { Review } from "./screens/review/Review.js";
import { Guide } from "./screens/guide/Guide.js";

/** Extracts task id from the config route: #/tasks/:id/config */
function parseConfigTaskId(hash: string): string | null {
  const match = hash.match(/^#\/tasks\/([^/]+)\/config$/);
  return match ? match[1] : null;
}

/** Extracts taskId + attemptId from the review route: #/tasks/:taskId/review/:attemptId */
function parseReviewRoute(hash: string): { taskId: string; attemptId: string } | null {
  const match = hash.match(/^#\/tasks\/([^/]+)\/review\/([^/]+)$/);
  return match ? { taskId: match[1], attemptId: match[2] } : null;
}

const SCREENS: Record<Exclude<Section, "tasks">, (() => React.JSX.Element) | null> = {
  prompts: Prompts,
  providers: null, // rendered with focusedProvider prop
  measurement: Measurement,
  settings: Settings,
  guide: Guide,
};

export function App() {
  const [section, navigate] = useSection();
  const [stripVisible, setStripVisible] = useState(true);
  const [connected, setConnected] = useState(false);
  const sseRef = useRef<SSEClient | null>(null);

  // Track whether we're on the ingest overlay route (#/ingest)
  const [isIngest, setIsIngest] = useState(() => window.location.hash === "#/ingest");

  // Track whether we're on the config overlay route (#/tasks/:id/config)
  const [configTaskId, setConfigTaskId] = useState<string | null>(() =>
    parseConfigTaskId(window.location.hash),
  );

  // Track whether we're on the review overlay route (#/tasks/:id/review/:attemptId)
  const [reviewRoute, setReviewRoute] = useState<{ taskId: string; attemptId: string } | null>(() =>
    parseReviewRoute(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = () => {
      setIsIngest(window.location.hash === "#/ingest");
      setConfigTaskId(parseConfigTaskId(window.location.hash));
      setReviewRoute(parseReviewRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateToIngest = useCallback(() => {
    window.location.hash = "#/ingest";
  }, []);
  const navigateFromIngest = useCallback(() => {
    window.location.hash = "#/tasks";
  }, []);

  const navigateToConfig = useCallback((taskId: string) => {
    window.location.hash = `#/tasks/${taskId}/config`;
  }, []);
  const navigateFromConfig = useCallback(() => {
    // Return to the task detail (#/tasks/:id)
    if (configTaskId) window.location.hash = `#/tasks/${configTaskId}`;
    else window.location.hash = "#/tasks";
  }, [configTaskId]);

  const navigateToReview = useCallback((taskId: string, attemptId: string) => {
    window.location.hash = `#/tasks/${taskId}/review/${attemptId}`;
  }, []);
  const navigateFromReview = useCallback(() => {
    if (reviewRoute) window.location.hash = `#/tasks/${reviewRoute.taskId}`;
    else window.location.hash = "#/tasks";
  }, [reviewRoute]);

  // Track which provider to focus when navigating to the providers section
  const [focusedProvider, setFocusedProvider] = useState<string | undefined>(undefined);

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
        // Stub data while provider_health projection is empty
        { name: "claude", status: "unknown" as ProviderStatus },
        { name: "codex", status: "unknown" as ProviderStatus },
        { name: "gemini", status: "unknown" as ProviderStatus },
        { name: "local", status: "unknown" as ProviderStatus },
      ];

  // Derive correlation filter: when a task is selected, filter events to its current attempt
  const [selectedTaskId] = useSelectedTaskId();
  const selectedDetail = useTaskDetail(section === "tasks" ? selectedTaskId ?? undefined : undefined);
  const stripCorrelationId = section === "tasks" && selectedDetail?.current_attempt_id
    ? selectedDetail.current_attempt_id
    : undefined;

  // Latest event for the strip (filtered when a task is selected)
  const recentEvents = useRecentEvents(stripCorrelationId ? { correlationId: stripCorrelationId } : undefined);
  const latestEvent = recentEvents[0]
    ? {
        type: recentEvents[0].type,
        ts: recentEvents[0].ts,
        detail: recentEvents[0].aggregate_id,
      }
    : null;

  useHotkeys(navigate);

  // Hydrate on mount, then connect SSE
  useEffect(() => {
    hydrate().then(() => {
      const sse = createSSEClient();
      sseRef.current = sse;

      // Seed SSE with the latest hydrated event ID so it doesn't replay
      // events we already have from the REST hydration
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

  // Ingest overlay — full-screen, no rail or event strip
  if (isIngest) {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
        <Ingest onBack={navigateFromIngest} />
      </div>
    );
  }

  // Config overlay — full-screen, no rail or event strip
  if (configTaskId) {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
        <TaskConfig taskId={configTaskId} onBack={navigateFromConfig} />
      </div>
    );
  }

  // Review overlay — full-screen, no rail or event strip
  if (reviewRoute) {
    return (
      <Review
        taskId={reviewRoute.taskId}
        attemptId={reviewRoute.attemptId}
        onBack={navigateFromReview}
      />
    );
  }

  const Screen = section === "tasks" ? null : SCREENS[section];

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar
        section={section}
        providers={providers}
        onProviderClick={(name) => {
          setFocusedProvider(name);
          navigate("providers");
        }}
      />

      <div className="flex flex-1 min-h-0">
        <Rail active={section} onNavigate={navigate} />
        <main className="flex-1 min-h-0 overflow-hidden bg-bg-primary">
          {section === "tasks"
            ? <Tasks onIngest={navigateToIngest} onEditConfig={navigateToConfig} onReview={navigateToReview} />
            : section === "providers"
              ? <Providers focusedProvider={focusedProvider} />
              : Screen && <Screen />}
        </main>
      </div>

      <EventStreamStrip
        visible={stripVisible}
        connected={connected}
        latestEvent={latestEvent}
        events={recentEvents}
        onToggleFilter={() => {
          /* TODO: open filter panel */
        }}
        onToggleVisible={() => setStripVisible(false)}
      />
    </div>
  );
}
