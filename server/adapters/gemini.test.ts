/**
 * gemini.test.ts — inner Effect tests, outer wrapper test, and cancellation test
 * for the Gemini CLI adapter.
 */

import { it } from "@effect/vitest";
import { describe, expect, it as vitestIt } from "vitest";
import { Effect, Stream, Queue, Deferred, Layer } from "effect";
import type { AppendEventInput } from "../eventStore.js";
import { Spawner, type SpawnHandle } from "./gemini/spawner.js";
import { makeProgram, invoke, buildArgs, type GeminiInvokeOptions } from "./gemini.js";

// ============================================================================
// Fixtures
// ============================================================================

const baseOpts: GeminiInvokeOptions = {
  invocation_id: "inv-1",
  attempt_id: "att-1",
  phase_name: "implementer",
  prompt: "Write hello world",
  cwd: "/tmp/test",
  prompt_version_id: "pv-1",
  context_manifest_hash: "hash-1",
};

const fakeBlobStore = {
  putBlob: (_content: string | Buffer) => ({ hash: "blob-hash" }),
  getBlob: () => null,
  hasBlob: () => false,
};

/** Captured real sample lines: init + 2 assistant deltas + result */
const SAMPLE_LINES = [
  JSON.stringify({
    type: "init",
    timestamp: "2025-01-01T00:00:00Z",
    session_id: "sess-abc",
    model: "gemini-2.5-pro",
  }),
  JSON.stringify({
    type: "message",
    timestamp: "2025-01-01T00:00:01Z",
    role: "assistant",
    content: "Hello ",
    delta: true,
  }),
  JSON.stringify({
    type: "message",
    timestamp: "2025-01-01T00:00:02Z",
    role: "assistant",
    content: "world",
    delta: true,
  }),
  JSON.stringify({
    type: "result",
    timestamp: "2025-01-01T00:00:03Z",
    status: "success",
    stats: {
      total_tokens: 100,
      input_tokens: 50,
      output_tokens: 50,
      duration_ms: 1234,
      tool_calls: 0,
    },
  }),
];

/** Creates a fake Spawner that replays the given lines with specified exit code */
function makeFakeSpawner(lines: string[], exitCode = 0): Spawner {
  return Spawner.of({
    spawn: (_command, _args, _input) =>
      Effect.gen(function* () {
        const exitDeferred = yield* Deferred.make<number>();

        const stdout = Stream.concat(
          Stream.fromIterable(lines),
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(exitDeferred, exitCode);
              return undefined as never;
            }),
          ).pipe(Stream.filter(() => false)),
        );

        const handle: SpawnHandle = {
          stdout,
          stderr: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          kill: Effect.sync(() => {}),
        };

        return handle;
      }),
  });
}

/**
 * Creates a fake Spawner whose stdout blocks after the first event (init).
 * Used for cancellation testing — the iterator will hang until interrupted.
 */
function makeFakeSpawnerWithControl() {
  let killed = false;

  const spawner = Spawner.of({
    spawn: (_command, _args, _input) =>
      Effect.succeed({
        stdout: Stream.concat(
          Stream.fromIterable(SAMPLE_LINES.slice(0, 1)),
          Stream.never,
        ),
        stderr: Stream.empty,
        exitCode: Effect.never,
        kill: Effect.sync(() => {
          killed = true;
        }),
      } satisfies SpawnHandle),
  });

  return {
    spawner,
    wasKilled: () => killed,
  };
}

// ============================================================================
// buildArgs tests
// ============================================================================

describe("buildArgs", () => {
  vitestIt("always includes --output-format stream-json and --skip-trust", () => {
    const args = buildArgs(baseOpts);
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--skip-trust");
  });

  vitestIt("defaults model to gemini-2.5-pro when unset", () => {
    const args = buildArgs({ ...baseOpts, model: undefined });
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
  });

  vitestIt("defaults model to gemini-2.5-pro when empty string", () => {
    const args = buildArgs({ ...baseOpts, model: "" });
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-2.5-pro");
  });

  vitestIt("uses provided model", () => {
    const args = buildArgs({ ...baseOpts, model: "gemini-2.5-flash" });
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-2.5-flash");
  });

  vitestIt("maps permission_mode to --approval-mode correctly", () => {
    const cases: Array<[GeminiInvokeOptions["permission_mode"], string]> = [
      [undefined, "default"],
      ["default", "default"],
      ["accept_edits", "auto_edit"],
      ["bypass_permissions", "yolo"],
      ["plan", "plan"],
    ];
    for (const [mode, expected] of cases) {
      const args = buildArgs({ ...baseOpts, permission_mode: mode });
      expect(args[args.indexOf("--approval-mode") + 1]).toBe(expected);
    }
  });

  vitestIt("includes --sandbox only when opts.sandbox === true", () => {
    expect(buildArgs(baseOpts)).not.toContain("--sandbox");
    expect(buildArgs({ ...baseOpts, sandbox: false })).not.toContain("--sandbox");
    expect(buildArgs({ ...baseOpts, sandbox: true })).toContain("--sandbox");
  });
});

// ============================================================================
// Inner Effect tests
// ============================================================================

describe("gemini adapter — inner Effect program", () => {
  it.effect("replays captured sample and emits correct AppendEventInput sequence", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<AppendEventInput | null>();
      const spawner = makeFakeSpawner(SAMPLE_LINES, 0);
      const layer = Layer.succeed(Spawner, spawner);

      const seenResult = yield* makeProgram(baseOpts, queue).pipe(Effect.provide(layer));

      expect(seenResult).toBe(true);

      // Collect all events from the queue
      const events: AppendEventInput[] = [];
      while (true) {
        const item = yield* Queue.take(queue);
        if (item === null) break;
        events.push(item);
      }

      // Should have: invocation.started, invocation.assistant_message (flushed by result), invocation.completed
      expect(events.length).toBe(3);
      expect(events[0]!.type).toBe("invocation.started");
      expect(events[1]!.type).toBe("invocation.assistant_message");
      expect(events[2]!.type).toBe("invocation.completed");

      // Verify assistant message contains buffered deltas
      const msgPayload = events[1]!.payload as { text: string };
      expect(msgPayload.text).toBe("Hello world");

      // Verify completed has success outcome
      const completedPayload = events[2]!.payload as { outcome: string };
      expect(completedPayload.outcome).toBe("success");
    }),
  );

  it.effect("emits synthetic invocation.completed with status error on non-zero exit without result", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<AppendEventInput | null>();
      // Only init + 1 delta, no result event, exit code 1
      const linesNoResult = SAMPLE_LINES.slice(0, 2);
      const spawner = makeFakeSpawner(linesNoResult, 1);
      const layer = Layer.succeed(Spawner, spawner);

      const seenResult = yield* makeProgram(baseOpts, queue).pipe(Effect.provide(layer));

      expect(seenResult).toBe(false);

      const events: AppendEventInput[] = [];
      while (true) {
        const item = yield* Queue.take(queue);
        if (item === null) break;
        events.push(item);
      }

      // Should have: invocation.started + synthetic invocation.completed
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("invocation.started");

      const last = events[events.length - 1]!;
      expect(last.type).toBe("invocation.completed");
      const payload = last.payload as { outcome: string };
      expect(payload.outcome).toBe("failed");
    }),
  );
});

// ============================================================================
// Outer wrapper test (plain vitest)
// ============================================================================

describe("gemini adapter — outer async iterable wrapper", () => {
  vitestIt("iterates for-await and yields correct event sequence", async () => {
    const spawner = makeFakeSpawner(SAMPLE_LINES, 0);
    const events: AppendEventInput[] = [];

    for await (const event of invoke(baseOpts, fakeBlobStore, spawner)) {
      events.push(event);
    }

    expect(events.length).toBe(3);
    expect(events[0]!.type).toBe("invocation.started");
    expect(events[1]!.type).toBe("invocation.assistant_message");
    expect(events[2]!.type).toBe("invocation.completed");

    const completedPayload = events[2]!.payload as { outcome: string };
    expect(completedPayload.outcome).toBe("success");
  });
});

// ============================================================================
// Cancellation test (plain vitest)
// ============================================================================

describe("gemini adapter — cancellation", () => {
  vitestIt("aborts iteration and kills spawner on AbortSignal", async () => {
    const { spawner, wasKilled } = makeFakeSpawnerWithControl();
    const controller = new AbortController();

    const events: AppendEventInput[] = [];
    const iter = invoke(baseOpts, fakeBlobStore, spawner, controller.signal);
    const iterator = (iter as AsyncGenerator<AppendEventInput>)[Symbol.asyncIterator]();

    // Read the first event (init)
    const first = await iterator.next();
    expect(first.done).toBe(false);
    events.push(first.value);
    expect(events[0]!.type).toBe("invocation.started");

    // Abort — fiber interruption pushes null sentinel, unblocking the iterator
    controller.abort();

    // The iterator should return cleanly without any timeout race
    const result = await iterator.next();

    expect(result.done).toBe(true);
    expect(wasKilled()).toBe(true);
  });
});
