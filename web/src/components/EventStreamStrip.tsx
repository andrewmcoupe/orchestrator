import { useState, useEffect, useRef, useCallback } from "react";
import type { AnyEvent } from "@shared/events.js";

type EventStreamStripProps = {
  /** Whether the strip is visible */
  visible?: boolean;
  /** Whether the SSE connection is live */
  connected?: boolean;
  /** Latest event to display in the collapsed strip */
  latestEvent?: {
    type: string;
    ts: string;
    detail?: string;
  } | null;
  /** Full list of recent events for the expanded panel */
  events?: AnyEvent[];
  onToggleFilter?: () => void;
  onToggleVisible?: () => void;
};

// ============================================================================
// Drag-to-resize hook
// ============================================================================

function useDragResize(
  initialHeight: number,
  minHeight: number,
  maxHeight: number,
) {
  const [height, setHeight] = useState(initialHeight);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startY.current = e.clientY;
      startHeight.current = height;
      setDragging(true);
    },
    [height],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e: MouseEvent) => {
      // Dragging up increases height (startY - clientY is positive when moving up)
      const delta = startY.current - e.clientY;
      const next = Math.min(maxHeight, Math.max(minHeight, startHeight.current + delta));
      setHeight(next);
    };

    const onMouseUp = () => setDragging(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, minHeight, maxHeight]);

  return { height, dragging, onMouseDown };
}

// ============================================================================
// Event row
// ============================================================================

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Colour-code event types for quick scanning
function eventTypeColor(type: string): string {
  if (type.startsWith("invocation.errored") || type.startsWith("attempt.killed")) return "text-status-danger";
  if (type.startsWith("attempt.completed") || type.startsWith("attempt.approved")) return "text-status-healthy";
  if (type.startsWith("phase.")) return "text-status-warning";
  if (type.startsWith("invocation.")) return "text-text-secondary";
  return "text-primary";
}

function EventRow({ event, selected, onClick }: { event: AnyEvent; selected?: boolean; onClick: () => void }) {
  // Extract a meaningful detail string from common payloads
  const payload = event.payload as unknown as Record<string, unknown>;
  const detail =
    (payload.phase_name as string) ??
    (payload.tool_name as string) ??
    (payload.outcome as string) ??
    (payload.title as string) ??
    event.aggregate_id;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 px-4 py-1 font-mono text-[11px] leading-5 w-full text-left cursor-pointer transition-colors ${
        selected ? "bg-secondary" : "hover:bg-secondary/50"
      }`}
    >
      <span className="text-text-tertiary w-16 shrink-0">{formatTime(event.ts)}</span>
      <span className={`w-52 shrink-0 truncate font-medium ${eventTypeColor(event.type)}`}>
        {event.type}
      </span>
      <span className="text-primary/40 truncate">{detail}</span>
    </button>
  );
}

// ============================================================================
// Event detail panel — slides in from right when an event is selected
// ============================================================================

function EventDetailPanel({ event, onClose }: { event: AnyEvent; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Panel */}
      <div
        className="relative w-full max-w-lg bg-bg-primary border-l border-border-default shadow-xl flex flex-col animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted bg-bg-secondary shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`font-mono text-sm font-medium ${eventTypeColor(event.type)}`}>
              {event.type}
            </span>
            <span className="text-xs text-text-tertiary">{formatTime(event.ts)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-lg leading-none px-2 cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Envelope metadata */}
        <div className="px-4 py-3 border-b border-border-muted text-xs space-y-1.5 bg-bg-secondary/50 shrink-0">
          <div className="flex gap-2">
            <span className="text-text-tertiary w-24 shrink-0">Event ID</span>
            <span className="font-mono text-text-secondary">{event.id}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-text-tertiary w-24 shrink-0">Aggregate</span>
            <span className="font-mono text-text-secondary">{event.aggregate_type} / {event.aggregate_id}</span>
          </div>
          {event.correlation_id && (
            <div className="flex gap-2">
              <span className="text-text-tertiary w-24 shrink-0">Correlation</span>
              <span className="font-mono text-text-secondary">{event.correlation_id}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-text-tertiary w-24 shrink-0">Actor</span>
            <span className="font-mono text-text-secondary">
              {typeof event.actor === "object" ? JSON.stringify(event.actor) : String(event.actor)}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-text-tertiary w-24 shrink-0">Timestamp</span>
            <span className="font-mono text-text-secondary">{event.ts}</span>
          </div>
        </div>

        {/* Payload JSON */}
        <div className="flex-1 overflow-y-auto p-4">
          <h4 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">Payload</h4>
          <pre className="font-mono text-xs text-text-primary bg-bg-secondary border border-border-muted p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

const STRIP_HEIGHT = 36; // collapsed strip height
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 500;

export function EventStreamStrip({
  visible = true,
  connected = false,
  latestEvent = null,
  events = [],
  onToggleFilter,
  onToggleVisible,
}: EventStreamStripProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AnyEvent | null>(null);
  const { height, dragging, onMouseDown } = useDragResize(200, MIN_PANEL_HEIGHT, MAX_PANEL_HEIGHT);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Heartbeat indicator: pulse every 15s while connected */
  const [heartbeat, setHeartbeat] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (!connected) return;
    timerRef.current = setInterval(() => {
      setHeartbeat(true);
      setTimeout(() => setHeartbeat(false), 300);
    }, 15_000);
    return () => clearInterval(timerRef.current);
  }, [connected]);

  // Auto-scroll to top when new events arrive (newest first)
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length, expanded]);

  if (!visible) return null;

  const time = latestEvent
    ? formatTime(latestEvent.ts)
    : "--:--:--";

  return (
    <div
      className="shrink-0 border-t border-border-default bg-strip-bg flex flex-col"
      style={{ height: expanded ? height + STRIP_HEIGHT : STRIP_HEIGHT }}
    >
      {/* Drag handle — only visible when expanded */}
      {expanded && (
        <div
          onMouseDown={onMouseDown}
          className={`h-1.5 cursor-row-resize flex items-center justify-center hover:bg-border-default/50 transition-colors ${
            dragging ? "bg-border-default/50" : ""
          }`}
        >
          <div className="w-8 h-0.5 rounded-full bg-text-tertiary/40" />
        </div>
      )}

      {/* Expanded event log */}
      {expanded && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {events.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
              No events yet.
            </div>
          ) : (
            events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                selected={selectedEvent?.id === event.id}
                onClick={() => setSelectedEvent(event)}
              />
            ))
          )}
        </div>
      )}

      {/* Event detail panel */}
      {selectedEvent && (
        <EventDetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}

      {/* Collapsed strip bar */}
      <footer className="flex items-center justify-between px-4 h-9 text-xs shrink-0">
        {/* Left: connection dot + time + event */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full transition-opacity ${
                connected ? "bg-status-healthy" : "bg-status-danger"
              } ${heartbeat ? "opacity-50" : ""}`}
            />
            <span className="text-text-secondary">stream</span>
          </span>
          <span className="text-text-tertiary">{time}</span>
          {latestEvent && (
            <>
              <span className="font-mono text-text-primary font-medium">{latestEvent.type}</span>
              {latestEvent.detail && (
                <span className="text-text-secondary truncate">{latestEvent.detail}</span>
              )}
            </>
          )}
        </div>

        {/* Right: expand/collapse + filter + hide */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="border border-border-default px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            {expanded ? "collapse" : "events"}
          </button>
          <button
            type="button"
            onClick={onToggleFilter}
            className="border border-border-default px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            filter
          </button>
          <button
            type="button"
            onClick={onToggleVisible}
            className="border border-border-default px-2 py-0.5 text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
          >
            hide
          </button>
        </div>
      </footer>
    </div>
  );
}

export type { EventStreamStripProps };
