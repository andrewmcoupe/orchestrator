/**
 * Tests for the Anthropic API adapter.
 *
 * All behaviors verified through the public interface (invoke(), translateSseEvent(),
 * buildRequestBody()). A fake fetcher is injected — no real HTTP calls.
 *
 * Covers:
 *   1. buildRequestBody — message construction (plain + schema-enforced)
 *   2. translateSseEvent — SSE line → AppendEventInput translation
 *   3. Full invoke() pipeline via fake fetcher
 *   4. Error handling: network error, API error, rate limit
 *   5. modelPricing cost table completeness
 */

import { describe, it, expect } from "vitest";
import {
  buildRequestBody,
  translateSseEvent,
  type ApiInvokeOptions,
  type SseState,
  invoke,
} from "./anthropicApi.js";
import { MODEL_PRICING, computeCost } from "./modelPricing.js";

// ============================================================================
// Helpers
// ============================================================================

const baseOpts: ApiInvokeOptions = {
  invocation_id: "inv-api-001",
  attempt_id: "att-api-001",
  phase_name: "auditor",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Is this implementation correct?" }],
  system_prompt: "You are an auditor.",
  prompt_version_id: "pv-api-001",
  context_manifest_hash: "def456",
  transport_options: { kind: "api", max_tokens: 1024 },
};

function makeFakeSseResponse(lines: string[]): Response {
  const body = lines.join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeErrorResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a minimal SSE stream for a text reply. */
function textStream(text: string, tokensIn = 10, tokensOut = 20): string[] {
  return [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_001", model: "claude-sonnet-4-6", usage: { input_tokens: tokensIn, output_tokens: 0 } } })}`,
    ``,
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: tokensOut } })}`,
    ``,
    `event: message_stop`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    ``,
  ];
}

/** Build a tool_use SSE stream for schema-enforced responses. */
function toolUseStream(jsonOutput: object, tokensIn = 15, tokensOut = 30): string[] {
  const text = JSON.stringify(jsonOutput);
  return [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_002", model: "claude-sonnet-4-6", usage: { input_tokens: tokensIn, output_tokens: 0 } } })}`,
    ``,
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_001", name: "structured_output", input: {} } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: text } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: tokensOut } })}`,
    ``,
    `event: message_stop`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    ``,
  ];
}

// ============================================================================
// modelPricing
// ============================================================================

describe("MODEL_PRICING", () => {
  it("has entries for claude-sonnet-4-6", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4-6"].input_per_1m).toBeGreaterThan(0);
    expect(MODEL_PRICING["claude-sonnet-4-6"].output_per_1m).toBeGreaterThan(0);
  });

  it("has entries for claude-opus-4-6", () => {
    expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined();
  });

  it("has entries for claude-haiku-4-5", () => {
    expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  it("computeCost calculates correctly for sonnet-4-6", () => {
    // 1M tokens = $3 in / $15 out (example pricing)
    const pricing = MODEL_PRICING["claude-sonnet-4-6"];
    const cost = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(pricing.input_per_1m + pricing.output_per_1m, 4);
  });

  it("computeCost returns 0 for unknown model", () => {
    expect(computeCost("unknown-model", 1000, 1000)).toBe(0);
  });
});

// ============================================================================
// buildRequestBody
// ============================================================================

describe("buildRequestBody", () => {
  it("includes model, messages, and max_tokens", () => {
    const body = buildRequestBody(baseOpts);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([
      { role: "user", content: "Is this implementation correct?" },
    ]);
    expect(body.stream).toBe(true);
  });

  it("includes system prompt when provided", () => {
    const body = buildRequestBody(baseOpts);
    expect(body.system).toBe("You are an auditor.");
  });

  it("omits system when not provided", () => {
    const opts: ApiInvokeOptions = { ...baseOpts, system_prompt: undefined };
    const body = buildRequestBody(opts);
    expect(body.system).toBeUndefined();
  });

  it("does NOT include tools when no schema provided", () => {
    const body = buildRequestBody(baseOpts);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("includes tools and forced tool_choice when schema provided", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const opts: ApiInvokeOptions = {
      ...baseOpts,
      transport_options: { kind: "api", max_tokens: 512, schema },
    };
    const body = buildRequestBody(opts);
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0].name).toBe("structured_output");
    expect(body.tools![0].input_schema).toEqual(schema);
    expect(body.tool_choice).toEqual({ type: "tool", name: "structured_output" });
  });
});

// ============================================================================
// translateSseEvent
// ============================================================================

describe("translateSseEvent", () => {
  function makeState(): SseState {
    return {
      invocationId: "inv-001",
      attemptId: "att-001",
      phaseName: "auditor",
      tokensIn: 0,
      tokensOut: 0,
      textBuffer: "",
      toolJsonBuffer: "",
      activeBlockType: null,
    };
  }

  it("message_start yields invocation.started and stores tokens_in", () => {
    const state = makeState();
    const data = { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 0 } } };
    const events = translateSseEvent("message_start", data, state, baseOpts);
    expect(state.tokensIn).toBe(42);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invocation.started");
    expect((events[0] as { type: "invocation.started"; payload: { invocation_id: string } }).payload.invocation_id).toBe("inv-001");
  });

  it("content_block_delta (text_delta) yields invocation.assistant_message", () => {
    const state = makeState();
    const data = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } };
    const events = translateSseEvent("content_block_delta", data, state, baseOpts);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invocation.assistant_message");
    expect((events[0] as { type: string; payload: { text: string } }).payload.text).toBe("Hello");
  });

  it("content_block_delta (input_json_delta) buffers without emitting", () => {
    const state = makeState();
    state.activeBlockType = "tool_use";
    const data = { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"foo":' } };
    const events = translateSseEvent("content_block_delta", data, state, baseOpts);
    expect(events).toHaveLength(0);
    expect(state.toolJsonBuffer).toBe('{"foo":');
  });

  it("message_delta stores output tokens", () => {
    const state = makeState();
    const data = { type: "message_delta", usage: { output_tokens: 55 } };
    const events = translateSseEvent("message_delta", data, state, baseOpts);
    expect(state.tokensOut).toBe(55);
    expect(events).toHaveLength(0);
  });

  it("message_stop yields invocation.completed with token/cost values", () => {
    const state = makeState();
    state.tokensIn = 10;
    state.tokensOut = 20;
    const data = { type: "message_stop" };
    const events = translateSseEvent("message_stop", data, state, baseOpts);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invocation.completed");
    const payload = (events[0] as { type: string; payload: { tokens_in: number; tokens_out: number; cost_usd: number } }).payload;
    expect(payload.tokens_in).toBe(10);
    expect(payload.tokens_out).toBe(20);
    expect(payload.cost_usd).toBeGreaterThan(0);
  });

  it("message_stop emits tool-use output as assistant_message when toolJsonBuffer has content", () => {
    const state = makeState();
    state.tokensIn = 15;
    state.tokensOut = 30;
    state.toolJsonBuffer = '{"verdict":"approve"}';
    const data = { type: "message_stop" };
    const events = translateSseEvent("message_stop", data, state, baseOpts);
    // Should emit assistant_message for tool output + invocation.completed
    const types = events.map((e) => e.type);
    expect(types).toContain("invocation.assistant_message");
    expect(types).toContain("invocation.completed");
  });
});

// ============================================================================
// invoke() — full pipeline via fake fetcher
// ============================================================================

describe("invoke()", () => {
  it("yields invocation.started, assistant_message, invocation.completed for a text reply", async () => {
    const fakeFetch = async (_url: string, _init: RequestInit): Promise<Response> =>
      makeFakeSseResponse(textStream("Good implementation.", 10, 20));

    const events: Array<{ type: string }> = [];
    for await (const e of invoke(baseOpts, fakeFetch)) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("invocation.started");
    expect(types).toContain("invocation.assistant_message");
    expect(types).toContain("invocation.completed");
  });

  it("invocation.completed has correct tokens and positive cost_usd", async () => {
    const fakeFetch = async () => makeFakeSseResponse(textStream("ok", 100, 200));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for await (const e of invoke(baseOpts, fakeFetch)) {
      events.push(e as unknown as { type: string; payload: Record<string, unknown> });
    }
    const completed = events.find((e) => e.type === "invocation.completed");
    expect(completed).toBeDefined();
    expect(completed!.payload.tokens_in).toBe(100);
    expect(completed!.payload.tokens_out).toBe(200);
    expect(completed!.payload.cost_usd).toBeGreaterThan(0);
  });

  it("yields invocation.assistant_message with tool_use JSON for schema-enforced response", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const opts: ApiInvokeOptions = {
      ...baseOpts,
      transport_options: { kind: "api", max_tokens: 512, schema },
    };
    const fakeFetch = async () =>
      makeFakeSseResponse(toolUseStream({ verdict: "approve" }));

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for await (const e of invoke(opts, fakeFetch)) {
      events.push(e as unknown as { type: string; payload: Record<string, unknown> });
    }

    const msgEvent = events.find((e) => e.type === "invocation.assistant_message");
    expect(msgEvent).toBeDefined();
    expect(msgEvent!.payload.text).toContain("verdict");
  });

  it("yields invocation.errored with provider_error on non-200 response", async () => {
    const fakeFetch = async () =>
      makeErrorResponse(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } });

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for await (const e of invoke(baseOpts, fakeFetch)) {
      events.push(e as unknown as { type: string; payload: Record<string, unknown> });
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invocation.errored");
    expect(events[0].payload.error_category).toBe("provider_error");
  });

  it("yields invocation.errored with provider_error when fetch throws", async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error("Network failure");
    };

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for await (const e of invoke(baseOpts, fakeFetch)) {
      events.push(e as unknown as { type: string; payload: Record<string, unknown> });
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("invocation.errored");
    expect(events[0].payload.error_category).toBe("provider_error");
  });

  it("sets aggregate_id to attempt_id and correlation_id to attempt_id", async () => {
    const fakeFetch = async () => makeFakeSseResponse(textStream("ok"));
    const events: Array<{ aggregate_id?: string; correlation_id?: string }> = [];
    for await (const e of invoke(baseOpts, fakeFetch)) {
      events.push(e as { aggregate_id?: string; correlation_id?: string });
    }
    for (const e of events) {
      expect(e.aggregate_id).toBe("att-api-001");
      expect(e.correlation_id).toBe("att-api-001");
    }
  });
});
