import { describe, expect, it } from "vitest";
import type { GeminiStreamEvent } from "./schema.js";
import { mapEvent, createInitialState } from "./mapper.js";

const state = createInitialState({
  invocation_id: "inv-1",
  attempt_id: "att-1",
  phase_name: "implementer",
  prompt_version_id: "pv-1",
  context_manifest_hash: "hash-1",
});

describe("mapEvent", () => {
  // ── AC 2: init → invocation.started ─────────────────────────────────
  it("emits invocation.started from init event with correct fields", () => {
    const event: GeminiStreamEvent = {
      type: "init",
      timestamp: "2025-01-01T00:00:00Z",
      session_id: "sess-abc",
      model: "gemini-2.5-pro",
    };
    const { state: nextState, emit } = mapEvent(event, state);
    expect(emit).toHaveLength(1);
    expect(emit[0]!.type).toBe("invocation.started");
    const payload = emit[0]!.payload as unknown as Record<string, unknown>;
    expect(payload.model).toBe("gemini-2.5-pro");
    expect(payload.session_id).toBe("sess-abc");
    // provider_id is expressed via actor.transport
    expect((emit[0]!.actor as unknown as Record<string, unknown>).transport).toBe("gemini-cli");
    // session_id captured in state
    expect(nextState.session_id).toBe("sess-abc");
  });

  // ── AC 3 & 9: assistant delta buffering ─────────────────────────────
  it("accumulates assistant deltas without emitting", () => {
    const delta1: GeminiStreamEvent = {
      type: "message",
      timestamp: "t1",
      role: "assistant",
      content: "Hello ",
      delta: true,
    };
    const delta2: GeminiStreamEvent = {
      type: "message",
      timestamp: "t2",
      role: "assistant",
      content: "world",
      delta: true,
    };

    const r1 = mapEvent(delta1, state);
    expect(r1.emit).toHaveLength(0);
    expect(r1.state.assistantBuffer).toBe("Hello ");

    const r2 = mapEvent(delta2, r1.state);
    expect(r2.emit).toHaveLength(0);
    expect(r2.state.assistantBuffer).toBe("Hello world");
  });

  // ── AC 9: multiple sequential deltas then flush ─────────────────────
  it("buffers multiple sequential deltas and flushes on non-delta message", () => {
    const deltas: GeminiStreamEvent[] = [
      { type: "message", timestamp: "t1", role: "assistant", content: "A", delta: true },
      { type: "message", timestamp: "t2", role: "assistant", content: "B", delta: true },
      { type: "message", timestamp: "t3", role: "assistant", content: "C", delta: true },
    ];
    const flush: GeminiStreamEvent = {
      type: "message",
      timestamp: "t4",
      role: "assistant",
      content: "D",
    };

    let s = state;
    for (const d of deltas) {
      const r = mapEvent(d, s);
      expect(r.emit).toHaveLength(0);
      s = r.state;
    }
    expect(s.assistantBuffer).toBe("ABC");

    const r = mapEvent(flush, s);
    expect(r.emit).toHaveLength(1);
    expect(r.emit[0]!.type).toBe("invocation.assistant_message");
    const payload = r.emit[0]!.payload as unknown as Record<string, unknown>;
    expect(payload.text).toBe("ABCD");
    expect(r.state.assistantBuffer).toBe("");
  });

  // ── AC 4: non-delta assistant flushes buffer ────────────────────────
  it("flushes buffer on non-delta assistant message", () => {
    const stateWithBuffer = { ...state, assistantBuffer: "buffered " };
    const event: GeminiStreamEvent = {
      type: "message",
      timestamp: "t",
      role: "assistant",
      content: "final",
    };
    const { state: nextState, emit } = mapEvent(event, stateWithBuffer);
    expect(emit).toHaveLength(1);
    expect(emit[0]!.type).toBe("invocation.assistant_message");
    expect((emit[0]!.payload as unknown as Record<string, unknown>).text).toBe("buffered final");
    expect(nextState.assistantBuffer).toBe("");
  });

  // ── AC 5: user message → emit nothing ───────────────────────────────
  it("emits nothing for user messages", () => {
    const event: GeminiStreamEvent = {
      type: "message",
      timestamp: "t",
      role: "user",
      content: "prompt text",
    };
    const { emit } = mapEvent(event, state);
    expect(emit).toHaveLength(0);
  });

  // ── AC 6: result flushes remaining buffer ───────────────────────────
  it("flushes remaining assistant buffer on result event", () => {
    const stateWithBuffer = { ...state, assistantBuffer: "leftover" };
    const event: GeminiStreamEvent = {
      type: "result",
      timestamp: "t",
      status: "success",
      stats: { total_tokens: 100, input_tokens: 50, output_tokens: 50, duration_ms: 500, tool_calls: 0 },
    };
    const { emit } = mapEvent(event, stateWithBuffer);
    // Should have assistant_message + completed
    expect(emit).toHaveLength(2);
    expect(emit[0]!.type).toBe("invocation.assistant_message");
    expect((emit[0]!.payload as unknown as Record<string, unknown>).text).toBe("leftover");
    expect(emit[1]!.type).toBe("invocation.completed");
  });

  // ── AC 7 & 10: result → exactly one invocation.completed ────────────
  it("emits exactly one invocation.completed per result event", () => {
    const event: GeminiStreamEvent = {
      type: "result",
      timestamp: "t",
      status: "success",
      stats: { total_tokens: 200, input_tokens: 80, output_tokens: 120, duration_ms: 1234, tool_calls: 2 },
    };
    const { emit } = mapEvent(event, state);
    const completedEvents = emit.filter((e) => e.type === "invocation.completed");
    expect(completedEvents).toHaveLength(1);

    const payload = completedEvents[0]!.payload as unknown as Record<string, unknown>;
    expect(payload.outcome).toBe("success");
    expect(payload.tokens_in).toBe(80);
    expect(payload.tokens_out).toBe(120);
    expect(payload.duration_ms).toBe(1234);
  });

  // ── AC 8: no cost/USD field on completed ────────────────────────────
  it("does not populate cost or USD field on invocation.completed", () => {
    const event: GeminiStreamEvent = {
      type: "result",
      timestamp: "t",
      status: "success",
      stats: { total_tokens: 100, input_tokens: 50, output_tokens: 50, duration_ms: 500, tool_calls: 0 },
    };
    const { emit } = mapEvent(event, state);
    const completed = emit.find((e) => e.type === "invocation.completed")!;
    const payload = completed.payload as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty("cost_usd");
  });

  // ── AC 7: result with error status ──────────────────────────────────
  it("maps error result status to failed outcome", () => {
    const event: GeminiStreamEvent = {
      type: "result",
      timestamp: "t",
      status: "error",
      stats: { total_tokens: 10, input_tokens: 5, output_tokens: 5, duration_ms: 100, tool_calls: 0 },
    };
    const { emit } = mapEvent(event, state);
    const completed = emit.find((e) => e.type === "invocation.completed")!;
    const payload = completed.payload as unknown as Record<string, unknown>;
    expect(payload.outcome).toBe("failed");
  });

  it("does not emit events for decoded tool_use and tool_result events yet", () => {
    const toolUse: GeminiStreamEvent = {
      type: "tool_use",
      timestamp: "t1",
      tool_name: "read_file",
      tool_id: "read_file-1",
      parameters: { file_path: "package.json" },
    };
    const toolResult: GeminiStreamEvent = {
      type: "tool_result",
      timestamp: "t2",
      tool_id: "read_file-1",
      status: "success",
      output: "",
    };

    const r1 = mapEvent(toolUse, state);
    expect(r1.emit).toHaveLength(0);
    const r2 = mapEvent(toolResult, r1.state);
    expect(r2.emit).toHaveLength(0);
  });
});
