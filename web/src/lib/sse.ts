/**
 * SSE client — connects to /api/events and streams canonical events.
 *
 * Features:
 * - Reconnects automatically with ?after=<lastSeenId> so no events are missed
 * - Supports correlation_id filtering
 * - Exposes subscribe/unsubscribe for listeners
 * - Tracks connection state for the UI strip indicator
 */

import type { AnyEvent } from "@shared/events.js";

type SSEListener = (event: AnyEvent) => void;
type ConnectionListener = (connected: boolean) => void;

type SSEClientOptions = {
  /** Base URL for the SSE endpoint (default: /api/events) */
  url?: string;
  /** Only emit events matching this correlation_id */
  correlationId?: string | null;
};

export type SSEClient = {
  /** Subscribe to incoming events. Returns unsubscribe function. */
  subscribe: (listener: SSEListener) => () => void;
  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onConnection: (listener: ConnectionListener) => () => void;
  /** The last-seen event id (for reconnect handover). */
  lastSeenId: () => string | undefined;
  /** Open the connection. */
  connect: () => void;
  /** Close the connection permanently. */
  close: () => void;
  /** Whether the EventSource is currently connected. */
  connected: () => boolean;
};

export function createSSEClient(options: SSEClientOptions = {}): SSEClient {
  const { url = "/api/events", correlationId = null } = options;

  const listeners = new Set<SSEListener>();
  const connectionListeners = new Set<ConnectionListener>();
  let lastId: string | undefined;
  let source: EventSource | null = null;
  let isConnected = false;

  function buildUrl(): string {
    const params = new URLSearchParams();
    if (lastId) params.set("after", lastId);
    if (correlationId) params.set("correlation_id", correlationId);
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  function setConnected(value: boolean) {
    if (isConnected === value) return;
    isConnected = value;
    for (const listener of connectionListeners) {
      listener(value);
    }
  }

  function handleMessage(raw: MessageEvent) {
    // SSE heartbeat comments arrive as empty messages — skip them
    if (!raw.data || raw.data.trim() === "") return;

    try {
      const event = JSON.parse(raw.data) as AnyEvent;
      lastId = event.id;
      for (const listener of listeners) {
        listener(event);
      }
    } catch {
      // Malformed data — ignore (heartbeat comments, etc.)
    }
  }

  function connect() {
    if (source) {
      source.close();
    }

    source = new EventSource(buildUrl());

    source.onopen = () => {
      setConnected(true);
    };

    source.onmessage = handleMessage;

    source.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects. On reconnect it calls onopen again.
      // We rebuild the URL with ?after= so the server replays missed events.
      if (source && source.readyState === EventSource.CLOSED) {
        // Fully closed — reconnect manually after a short delay
        setTimeout(connect, 2000);
      }
    };
  }

  function close() {
    if (source) {
      source.close();
      source = null;
    }
    setConnected(false);
  }

  return {
    subscribe(listener: SSEListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onConnection(listener: ConnectionListener) {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    lastSeenId: () => lastId,
    connect,
    close,
    connected: () => isConnected,
  };
}
