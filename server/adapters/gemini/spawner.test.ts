import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Stream, Chunk } from "effect";
import { lineSplit } from "./spawner.js";

describe("lineSplit", () => {
  it.effect("splits complete lines", () =>
    Effect.gen(function* () {
      const input = Stream.make("hello\nworld\n");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["hello", "world"]);
    }),
  );

  it.effect("handles partial chunks across multiple reads", () =>
    Effect.gen(function* () {
      // Simulate chunked delivery: "hel" + "lo\nwor" + "ld\n"
      const input = Stream.make("hel", "lo\nwor", "ld\n");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["hello", "world"]);
    }),
  );

  it.effect("handles line split exactly at chunk boundary", () =>
    Effect.gen(function* () {
      // "line1\n" arrives in one chunk, "line2\n" in another
      const input = Stream.make("line1\n", "line2\n");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["line1", "line2"]);
    }),
  );

  it.effect("flushes trailing content without final newline", () =>
    Effect.gen(function* () {
      const input = Stream.make("hello\nworld");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["hello", "world"]);
    }),
  );

  it.effect("handles single chunk with no newlines", () =>
    Effect.gen(function* () {
      const input = Stream.make("no-newline");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["no-newline"]);
    }),
  );

  it.effect("handles empty input", () =>
    Effect.gen(function* () {
      const input = Stream.empty;
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual([]);
    }),
  );

  it.effect("handles multiple newlines producing empty strings between them", () =>
    Effect.gen(function* () {
      const input = Stream.make("a\n\nb\n");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["a", "", "b"]);
    }),
  );

  it.effect("handles many small chunks building up one line", () =>
    Effect.gen(function* () {
      const input = Stream.make("a", "b", "c", "d", "\n", "e", "f", "\n");
      const lines = yield* Stream.runCollect(lineSplit(input));
      expect(Chunk.toArray(lines)).toEqual(["abcd", "ef"]);
    }),
  );
});
