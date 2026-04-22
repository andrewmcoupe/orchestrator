// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSSEClient } from "./sse.js";
import type { AnyEvent } from "@shared/events.js";

// Minimal mock EventSource for unit tests
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = MockEventSource.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Simulate async open
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // Helper to push a message from tests
  _pushMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

// Inject mock into globalThis
let lastEventSource: MockEventSource | null = null;

beforeEach(() => {
  lastEventSource = null;
  (globalThis as Record<string, unknown>).EventSource = class extends MockEventSource {
    constructor(url: string) {
      super(url);
      lastEventSource = this;
    }
  };
  // Copy static constants
  (globalThis as Record<string, unknown>).EventSource = Object.assign(
    (globalThis as Record<string, unknown>).EventSource as object,
    { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
  );
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).EventSource;
});

function fakeEvent(overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    type: "task.created",
    aggregate_type: "task",
    aggregate_id: "T-001",
    version: 1,
    ts: "2026-04-21T12:00:00.000Z",
    actor: { kind: "user", user_id: "local" },
    correlation_id: undefined,
    causation_id: undefined,
    payload: {
      task_id: "T-001",
      title: "Test task",
      proposition_ids: [],
      config_snapshot: { phases: [], gates: [], retry_policy: {} },
    },
    ...overrides,
  } as unknown as AnyEvent;
}

describe("SSE client", () => {
  it("connects and reports connected state", async () => {
    const client = createSSEClient();
    const states: boolean[] = [];
    client.onConnection((c) => states.push(c));
    client.connect();

    // Wait for mock async open
    await new Promise((r) => setTimeout(r, 10));

    expect(states).toContain(true);
    expect(client.connected()).toBe(true);
  });

  it("delivers parsed events to subscribers", async () => {
    const client = createSSEClient();
    const events: AnyEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.connect();

    await new Promise((r) => setTimeout(r, 10));

    const ev = fakeEvent();
    lastEventSource!._pushMessage(JSON.stringify(ev));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.created");
  });

  it("tracks lastSeenId from received events", async () => {
    const client = createSSEClient();
    client.subscribe(() => {});
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    expect(client.lastSeenId()).toBeUndefined();

    lastEventSource!._pushMessage(JSON.stringify(fakeEvent({ id: "EV-100" })));
    expect(client.lastSeenId()).toBe("EV-100");

    lastEventSource!._pushMessage(JSON.stringify(fakeEvent({ id: "EV-200" })));
    expect(client.lastSeenId()).toBe("EV-200");
  });

  it("builds URL with after and correlation_id params", () => {
    const client = createSSEClient({
      url: "/api/events",
      correlationId: "COR-1",
    });
    client.subscribe(() => {});
    client.connect();

    // First connect: no after param yet, but correlation_id is set
    expect(lastEventSource!.url).toContain("correlation_id=COR-1");
  });

  it("ignores empty/heartbeat messages", async () => {
    const client = createSSEClient();
    const events: AnyEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    lastEventSource!._pushMessage("");
    lastEventSource!._pushMessage("   ");

    expect(events).toHaveLength(0);
  });

  it("ignores malformed JSON", async () => {
    const client = createSSEClient();
    const events: AnyEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    lastEventSource!._pushMessage("{invalid json");
    expect(events).toHaveLength(0);
  });

  it("unsubscribe removes the listener", async () => {
    const client = createSSEClient();
    const events: AnyEvent[] = [];
    const unsub = client.subscribe((e) => events.push(e));
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    unsub();
    lastEventSource!._pushMessage(JSON.stringify(fakeEvent()));
    expect(events).toHaveLength(0);
  });

  it("close shuts down the EventSource", async () => {
    const client = createSSEClient();
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    expect(client.connected()).toBe(true);
    client.close();
    expect(client.connected()).toBe(false);
    expect(lastEventSource!.readyState).toBe(MockEventSource.CLOSED);
  });

  it("sets connected to false on error", async () => {
    const client = createSSEClient();
    const states: boolean[] = [];
    client.onConnection((c) => states.push(c));
    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    // Simulate error with EventSource still connecting (not fully closed)
    lastEventSource!.readyState = MockEventSource.CONNECTING;
    lastEventSource!.onerror?.(new Event("error"));

    expect(states).toContain(false);
  });
});
