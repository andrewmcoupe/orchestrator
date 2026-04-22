/**
 * Anthropic Messages API Adapter.
 *
 * Calls POST /v1/messages with streaming and translates Server-Sent Events
 * into canonical AppendEventInput objects. The caller pipes each through
 * appendAndProject(db, input) to persist them.
 *
 * This adapter is for judgment/extraction phases (auditor, proposition
 * extractor, classifier) — it does NOT detect file edits.
 *
 * When a `schema` is provided in transport_options, the request uses
 * Anthropic's tool-use technique to enforce structured JSON output:
 * a single tool named "structured_output" is defined with the JSON Schema
 * as its input_schema, and tool_choice forces the model to call it.
 *
 * A Fetcher abstraction allows injecting a fake response in tests without
 * mocking the global fetch.
 */

import type { AppendEventInput } from "../eventStore.js";
import type { PhaseName, TransportOptions } from "@shared/events.js";
import { computeCost } from "./modelPricing.js";
import { getCredential } from "../providers/credentials.js";

// ============================================================================
// Public types
// ============================================================================

type ApiTransportOptions = Extract<TransportOptions, { kind: "api" }>;

export type ApiInvokeOptions = {
  invocation_id: string;
  attempt_id: string;
  phase_name: PhaseName;
  model: string;
  /** Conversation messages sent to the API. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system_prompt?: string;
  prompt_version_id: string;
  context_manifest_hash: string;
  transport_options: ApiTransportOptions;
};

/** Injectable fetch abstraction — default is globalThis.fetch. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ============================================================================
// SSE parsing state
// ============================================================================

/**
 * Mutable state carried through the SSE event stream.
 * Exported so tests can construct it directly.
 */
export type SseState = {
  invocationId: string;
  attemptId: string;
  phaseName: PhaseName;
  tokensIn: number;
  tokensOut: number;
  /** Accumulated text from text_delta blocks. */
  textBuffer: string;
  /** Accumulated JSON from input_json_delta blocks (tool-use responses). */
  toolJsonBuffer: string;
  /** Type of the currently open content block. */
  activeBlockType: "text" | "tool_use" | null;
};

// ============================================================================
// buildRequestBody — pure request construction
// ============================================================================

type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  stream: true;
  messages: Array<{ role: string; content: string }>;
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: object }>;
  tool_choice?: { type: "tool"; name: string };
};

/**
 * Constructs the Anthropic API request body from invocation options.
 */
export function buildRequestBody(opts: ApiInvokeOptions): AnthropicRequestBody {
  const { transport_options: to } = opts;
  const body: AnthropicRequestBody = {
    model: opts.model,
    max_tokens: to.max_tokens,
    stream: true,
    messages: opts.messages,
  };

  if (opts.system_prompt) {
    body.system = opts.system_prompt;
  }

  if (to.schema) {
    // Force structured output via tool-use: define a single tool whose
    // input_schema matches the required response shape, then force a call.
    body.tools = [
      {
        name: "structured_output",
        description: "Return the response in the required structured format.",
        input_schema: to.schema,
      },
    ];
    body.tool_choice = { type: "tool", name: "structured_output" };
  }

  return body;
}

// ============================================================================
// translateSseEvent — pure SSE data → AppendEventInput[] translation
// ============================================================================

type SseEventData = Record<string, unknown>;

/**
 * Translates one parsed Anthropic SSE event into zero or more AppendEventInputs,
 * mutating `state` to track accumulated values across the stream.
 */
export function translateSseEvent(
  eventType: string,
  data: SseEventData,
  state: SseState,
  opts: ApiInvokeOptions,
): AppendEventInput[] {
  const actor = {
    kind: "cli" as const,
    transport: "anthropic-api" as const,
    invocation_id: state.invocationId,
  };
  const base = {
    aggregate_type: "attempt" as const,
    aggregate_id: state.attemptId,
    actor,
    correlation_id: state.attemptId,
  };

  switch (eventType) {
    case "message_start": {
      // Capture input tokens from the message_start event
      const message = data.message as { usage?: { input_tokens?: number } } | undefined;
      state.tokensIn = message?.usage?.input_tokens ?? 0;

      const started: AppendEventInput<"invocation.started"> = {
        ...base,
        type: "invocation.started",
        payload: {
          invocation_id: state.invocationId,
          attempt_id: state.attemptId,
          phase_name: state.phaseName,
          transport: "anthropic-api",
          model: opts.model,
          prompt_version_id: opts.prompt_version_id,
          context_manifest_hash: opts.context_manifest_hash,
        },
      };
      return [started];
    }

    case "content_block_start": {
      const block = data.content_block as { type?: string } | undefined;
      state.activeBlockType = (block?.type === "tool_use" ? "tool_use" : "text") as
        | "text"
        | "tool_use";
      return [];
    }

    case "content_block_delta": {
      const delta = data.delta as {
        type?: string;
        text?: string;
        partial_json?: string;
      } | undefined;

      if (delta?.type === "text_delta" && delta.text) {
        const msg: AppendEventInput<"invocation.assistant_message"> = {
          ...base,
          type: "invocation.assistant_message",
          payload: {
            invocation_id: state.invocationId,
            text: delta.text,
          },
        };
        return [msg];
      }

      if (delta?.type === "input_json_delta" && delta.partial_json) {
        // Buffer tool-use JSON — emit the complete value at message_stop
        state.toolJsonBuffer += delta.partial_json;
      }

      return [];
    }

    case "content_block_stop":
      // Reset active block type; buffered JSON is flushed at message_stop
      state.activeBlockType = null;
      return [];

    case "message_delta": {
      const usage = data.usage as { output_tokens?: number } | undefined;
      state.tokensOut = usage?.output_tokens ?? state.tokensOut;
      return [];
    }

    case "message_stop": {
      const events: AppendEventInput[] = [];

      // If there's buffered tool-use JSON, emit it as an assistant_message
      if (state.toolJsonBuffer) {
        const msg: AppendEventInput<"invocation.assistant_message"> = {
          ...base,
          type: "invocation.assistant_message",
          payload: {
            invocation_id: state.invocationId,
            text: state.toolJsonBuffer,
          },
        };
        events.push(msg);
      }

      const cost_usd = computeCost(opts.model, state.tokensIn, state.tokensOut);
      const completed: AppendEventInput<"invocation.completed"> = {
        ...base,
        type: "invocation.completed",
        payload: {
          invocation_id: state.invocationId,
          outcome: "success",
          tokens_in: state.tokensIn,
          tokens_out: state.tokensOut,
          cost_usd,
          duration_ms: 0, // SSE stream doesn't report duration; caller may override
          turns: 1,
        },
      };
      events.push(completed);
      return events;
    }

    default:
      return [];
  }
}

// ============================================================================
// SSE response parser
// ============================================================================

/**
 * Parses lines from an Anthropic SSE response body.
 * Yields { event, data } pairs for each complete SSE frame.
 */
async function* parseSseLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<{ event: string; data: SseEventData }> {
  if (!body) return;

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") continue;
          try {
            const parsed = JSON.parse(raw) as SseEventData;
            yield { event: currentEvent || (parsed.type as string) || "", data: parsed };
          } catch {
            // Skip malformed JSON lines
          }
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// invoke — the main async generator
// ============================================================================

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Calls the Anthropic Messages API with streaming and yields
 * AppendEventInput objects for each canonical event in the conversation.
 *
 * @param opts     Invocation parameters
 * @param fetcher  Injectable fetch function (default: globalThis.fetch)
 */
export async function* invoke(
  opts: ApiInvokeOptions,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): AsyncIterable<AppendEventInput> {
  const actor = {
    kind: "cli" as const,
    transport: "anthropic-api" as const,
    invocation_id: opts.invocation_id,
  };
  const base = {
    aggregate_type: "attempt" as const,
    aggregate_id: opts.attempt_id,
    actor,
    correlation_id: opts.attempt_id,
  };

  const state: SseState = {
    invocationId: opts.invocation_id,
    attemptId: opts.attempt_id,
    phaseName: opts.phase_name,
    tokensIn: 0,
    tokensOut: 0,
    textBuffer: "",
    toolJsonBuffer: "",
    activeBlockType: null,
  };

  let response: Response;
  try {
    const apiKey = getCredential("anthropic-api") ?? process.env.ANTHROPIC_API_KEY;
    response = await fetcher(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey ?? "",
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(buildRequestBody(opts)),
    });
  } catch (err) {
    const error = err as Error;
    const errInput: AppendEventInput<"invocation.errored"> = {
      ...base,
      type: "invocation.errored",
      payload: {
        invocation_id: opts.invocation_id,
        error: error.message ?? "Network error",
        error_category: "provider_error",
      },
    };
    yield errInput;
    return;
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; type?: string };
      };
      errorMessage = body.error?.message ?? errorMessage;
    } catch {
      // Ignore JSON parse errors on error responses
    }

    const errInput: AppendEventInput<"invocation.errored"> = {
      ...base,
      type: "invocation.errored",
      payload: {
        invocation_id: opts.invocation_id,
        error: errorMessage,
        error_category: "provider_error",
      },
    };
    yield errInput;
    return;
  }

  try {
    for await (const { event, data } of parseSseLines(response.body)) {
      const eventType = event || (data.type as string) || "";
      const inputs = translateSseEvent(eventType, data, state, opts);
      for (const input of inputs) {
        yield input;
      }
    }
  } catch (err) {
    const error = err as Error;
    const errInput: AppendEventInput<"invocation.errored"> = {
      ...base,
      type: "invocation.errored",
      payload: {
        invocation_id: opts.invocation_id,
        error: error.message ?? "Stream error",
        error_category: "provider_error",
      },
    };
    yield errInput;
  }
}
