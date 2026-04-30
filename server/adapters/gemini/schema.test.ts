import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Option } from "effect";
import { decodeLine } from "./schema.js";

describe("decodeLine", () => {
  it.effect("returns None for the literal '[STARTUP] StartupProfiler.flush()' line", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine("[STARTUP] StartupProfiler.flush()");
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("returns None for the literal 'Loaded cached credentials' line", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine("Loaded cached credentials");
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("returns None for empty lines", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine("");
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("returns None for JSON with unknown type", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine(JSON.stringify({ type: "tool_call", data: {} }));
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("decodes a valid init event", () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        type: "init",
        timestamp: "2025-01-01T00:00:00Z",
        session_id: "sess-123",
        model: "gemini-2.5-pro",
      });
      const result = yield* decodeLine(line);
      expect(Option.isSome(result)).toBe(true);
      const event = Option.getOrThrow(result);
      expect(event.type).toBe("init");
      if (event.type === "init") {
        expect(event.model).toBe("gemini-2.5-pro");
        expect(event.session_id).toBe("sess-123");
      }
    }),
  );

  it.effect("decodes a valid message event", () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        type: "message",
        timestamp: "2025-01-01T00:00:01Z",
        role: "assistant",
        content: "Hello",
        delta: true,
      });
      const result = yield* decodeLine(line);
      expect(Option.isSome(result)).toBe(true);
      const event = Option.getOrThrow(result);
      expect(event.type).toBe("message");
      if (event.type === "message") {
        expect(event.role).toBe("assistant");
        expect(event.content).toBe("Hello");
        expect(event.delta).toBe(true);
      }
    }),
  );

  it.effect("decodes a valid result event", () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        type: "result",
        timestamp: "2025-01-01T00:00:02Z",
        status: "success",
        stats: {
          total_tokens: 100,
          input_tokens: 50,
          output_tokens: 50,
          duration_ms: 1234,
          tool_calls: 0,
        },
      });
      const result = yield* decodeLine(line);
      expect(Option.isSome(result)).toBe(true);
      const event = Option.getOrThrow(result);
      expect(event.type).toBe("result");
      if (event.type === "result") {
        expect(event.status).toBe("success");
        expect(event.stats.total_tokens).toBe(100);
      }
    }),
  );

  it.effect("never fails on malformed JSON", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine("{not valid json}");
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("returns None for JSON without a type field", () =>
    Effect.gen(function* () {
      const result = yield* decodeLine(JSON.stringify({ foo: "bar" }));
      expect(Option.isNone(result)).toBe(true);
    }),
  );
});
