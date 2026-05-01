/**
 * Gemini CLI Adapter.
 *
 * Spawns `gemini` with --output-format stream-json and translates its NDJSON
 * output into canonical AppendEventInput objects via an Effect program that
 * manages process lifecycle with acquireRelease.
 *
 * The public async generator bridges from Effect → AsyncIterable, with
 * AbortSignal wired to Fiber.interrupt for deterministic cancellation.
 */

import {
  Effect,
  Stream,
  Queue,
  Fiber,
  Layer,
  Ref,
  Option,
} from "effect";
import type { BlobStore } from "../blobStore.js";
import type { AppendEventInput } from "../eventStore.js";
import { Spawner, SpawnerLive } from "./gemini/spawner.js";
import type { SpawnError, SpawnHandle } from "./gemini/spawner.js";
import { decodeLine } from "./gemini/schema.js";
import type { GeminiStreamEvent } from "./gemini/schema.js";
import { mapEvent, createInitialState } from "./gemini/mapper.js";
import type { MapperState } from "./gemini/mapper.js";

// ============================================================================
// Public types
// ============================================================================

export type GeminiInvokeOptions = {
  invocation_id: string;
  attempt_id: string;
  phase_name: string;
  prompt: string;
  cwd: string;
  model?: string;
  permission_mode?: "default" | "accept_edits" | "bypass_permissions" | "plan";
  sandbox?: boolean;
  prompt_version_id: string;
  context_manifest_hash: string;
};

// ============================================================================
// Arg builder
// ============================================================================

const PERMISSION_MODE_MAP: Record<string, string> = {
  default: "default",
  accept_edits: "auto_edit",
  bypass_permissions: "yolo",
  plan: "plan",
};

export function buildArgs(opts: GeminiInvokeOptions): string[] {
  const model = opts.model && opts.model.length > 0 ? opts.model : "gemini-2.5-pro";
  const approvalMode = PERMISSION_MODE_MAP[opts.permission_mode ?? "default"] ?? "default";

  const args: string[] = [
    "--output-format",
    "stream-json",
    "--skip-trust",
    "--model",
    model,
    "--approval-mode",
    approvalMode,
  ];

  if (opts.sandbox === true) {
    args.push("--sandbox");
  }

  return args;
}

// ============================================================================
// Inner Effect program
// ============================================================================

/**
 * The core Effect program that acquires a SpawnHandle via acquireRelease,
 * folds over stdout lines through decode+map, and pushes AppendEventInput
 * batches into the queue. Emits a synthetic error completion on non-zero
 * exit if no result event was seen.
 */
export function makeProgram(
  opts: GeminiInvokeOptions,
  queue: Queue.Queue<AppendEventInput | null>,
): Effect.Effect<boolean, SpawnError, Spawner> {
  const args = buildArgs(opts);

  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* Spawner;
      // AC 10: acquireRelease manages SpawnHandle — release calls kill
      const handle: SpawnHandle = yield* Effect.acquireRelease(
        spawner.spawn("gemini", args, opts.prompt),
        (h) => h.kill,
      );

      const stateRef = yield* Ref.make<MapperState>(
        createInitialState({
          invocation_id: opts.invocation_id,
          attempt_id: opts.attempt_id,
          phase_name: opts.phase_name,
          prompt_version_id: opts.prompt_version_id,
          context_manifest_hash: opts.context_manifest_hash,
        }),
      );

      // Process stdout lines through decode → filter → map pipeline
      yield* handle.stdout.pipe(
        Stream.mapEffect((line) => decodeLine(line)),
        Stream.filterMap((opt: Option.Option<GeminiStreamEvent>) => opt),
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const currentState = yield* Ref.get(stateRef);
            const { state: nextState, emit } = mapEvent(event, currentState);
            yield* Ref.set(stateRef, nextState);

            for (const e of emit) {
              yield* Queue.offer(queue, e);
            }
          }),
        ),
        Stream.runDrain,
      );

      // Wait for process exit
      const exitCode = yield* handle.exitCode;
      const finalState = yield* Ref.get(stateRef);

      // If non-zero exit and no result event, emit synthetic error completion
      if (exitCode !== 0 && !finalState.seenResult) {
        const base = {
          aggregate_type: "attempt" as const,
          aggregate_id: finalState.attempt_id,
          actor: {
            kind: "cli" as const,
            transport: "gemini-cli" as const,
            invocation_id: finalState.invocation_id,
          },
          correlation_id: finalState.attempt_id,
        };

        yield* Queue.offer(queue, {
          ...base,
          type: "invocation.completed",
          payload: {
            invocation_id: finalState.invocation_id,
            outcome: "failed",
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            turns: 0,
            exit_reason: "unknown",
            stdout_tail_hash: null,
            stderr_tail_hash: null,
            permission_blocked_on: null,
          },
        } satisfies AppendEventInput<"invocation.completed">);
      }

      // Signal end-of-stream
      yield* Queue.offer(queue, null);

      return finalState.seenResult;
    }),
  ).pipe(
    // On fiber interruption, push null sentinel so the async generator unblocks
    Effect.onInterrupt(() => Queue.offer(queue, null)),
  );
}

// ============================================================================
// Public async generator
// ============================================================================

export async function* invoke(
  opts: GeminiInvokeOptions,
  _blobStore: BlobStore,
  spawner?: Spawner,
  signal?: AbortSignal,
): AsyncIterable<AppendEventInput> {
  // Build the layer — use injected spawner or default SpawnerLive
  const layer = spawner
    ? Layer.succeed(Spawner, spawner)
    : SpawnerLive;

  // Create queue to bridge Effect → async iteration
  const queue = Effect.runSync(Queue.unbounded<AppendEventInput | null>());

  // Fork the program via Effect.runFork
  const fiber = Effect.runFork(
    makeProgram(opts, queue).pipe(Effect.provide(layer)),
  );

  // Wire AbortSignal → Fiber.interrupt
  if (signal) {
    if (signal.aborted) {
      Effect.runFork(Fiber.interrupt(fiber));
    } else {
      const onAbort = () => {
        Effect.runFork(Fiber.interrupt(fiber));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Pull events from the queue until null sentinel
  try {
    while (true) {
      const item = await Effect.runPromise(Queue.take(queue));
      if (item === null) break;
      yield item;
    }
  } finally {
    // Ensure cleanup on early break from for-await
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
  }
}
