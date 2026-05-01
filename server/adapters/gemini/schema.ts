/**
 * Gemini CLI stream-json schema decoders.
 *
 * Decodes NDJSON lines emitted by `gemini --output-format stream-json` into
 * typed event variants. Non-JSON lines and unknown event types are silently
 * dropped (returned as None) so the adapter never crashes on stderr noise
 * or future event variants.
 */

import { Schema } from "effect";
import { Effect, Option } from "effect";

// ============================================================================
// Event schemas
// ============================================================================

export const InitEvent = Schema.Struct({
  type: Schema.Literal("init"),
  timestamp: Schema.String,
  session_id: Schema.String,
  model: Schema.String,
});
export type InitEvent = typeof InitEvent.Type;

export const MessageEvent = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.String,
  role: Schema.Union(Schema.Literal("user"), Schema.Literal("assistant")),
  content: Schema.String,
  delta: Schema.optional(Schema.Boolean),
});
export type MessageEvent = typeof MessageEvent.Type;

export const ResultEvent = Schema.Struct({
  type: Schema.Literal("result"),
  timestamp: Schema.String,
  status: Schema.Union(Schema.Literal("success"), Schema.Literal("error")),
  stats: Schema.Struct({
    total_tokens: Schema.Number,
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    duration_ms: Schema.Number,
    tool_calls: Schema.Number,
  }),
});
export type ResultEvent = typeof ResultEvent.Type;

export const ToolUseEvent = Schema.Struct({
  type: Schema.Literal("tool_use"),
  timestamp: Schema.String,
  tool_name: Schema.String,
  tool_id: Schema.String,
  parameters: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type ToolUseEvent = typeof ToolUseEvent.Type;

export const ToolResultEvent = Schema.Struct({
  type: Schema.Literal("tool_result"),
  timestamp: Schema.String,
  tool_id: Schema.String,
  status: Schema.String,
  output: Schema.optional(Schema.String),
});
export type ToolResultEvent = typeof ToolResultEvent.Type;

export const GeminiStreamEvent = Schema.Union(
  InitEvent,
  MessageEvent,
  ResultEvent,
  ToolUseEvent,
  ToolResultEvent,
);
export type GeminiStreamEvent = typeof GeminiStreamEvent.Type;

// ============================================================================
// Line decoder
// ============================================================================

/**
 * Decode a single line from Gemini's stream-json output.
 *
 * Returns `None` for non-JSON lines (stderr noise like `[STARTUP]` lines,
 * `Loaded cached credentials`, etc.) and for JSON lines with an unknown
 * `type` value. Never fails — all errors are swallowed as `None`.
 */
export function decodeLine(
  line: string,
): Effect.Effect<Option.Option<GeminiStreamEvent>, never> {
  return Effect.gen(function* () {
    const trimmed = line.trim();
    if (trimmed === "") return Option.none();

    // Attempt JSON parse — non-JSON lines become None
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return Option.none();
    }

    // Must be an object with a string `type` field
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return Option.none();
    }

    // Try decoding as a known event variant
    const result = Schema.decodeUnknownEither(GeminiStreamEvent)(parsed);

    if (result._tag === "Right") {
      return Option.some(result.right);
    }

    // Unknown or malformed variant — log at debug and skip (permissive fallthrough)
    const typeValue = (parsed as Record<string, unknown>).type;
    yield* Effect.logDebug(`Unknown Gemini event type: ${String(typeValue)}`);
    return Option.none();
  });
}
