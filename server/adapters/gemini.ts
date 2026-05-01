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
import type { PermissionMode } from "@shared/events";
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
  permission_mode?: PermissionMode;
  sandbox?: boolean;
  prompt_version_id: string;
  context_manifest_hash: string;
};

// ============================================================================
// Arg builder
// ============================================================================

type GeminiApprovalMode = "default" | "auto_edit" | "yolo";

/** Translates the canonical orchestrator vocabulary to Gemini's --approval-mode
 *  values. Gemini has no `plan` mode — `plan` and `default` both map to
 *  `default`. `dontAsk` and `auto` map to `yolo` (fully autonomous). */
const PERMISSION_MODE_MAP: Record<PermissionMode, GeminiApprovalMode> = {
  default: "default",
  plan: "default",
  acceptEdits: "auto_edit",
  bypassPermissions: "yolo",
  dontAsk: "yolo",
  auto: "yolo",
};

export function buildArgs(opts: GeminiInvokeOptions): string[] {
  const model = opts.model && opts.model.length > 0 ? opts.model : "gemini-2.5-pro";
  const approvalMode = PERMISSION_MODE_MAP[opts.permission_mode ?? "default"];

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
const TAIL_BUFFER_BYTES = 4096;

function appendTail(buf: string, chunk: string): string {
  return (buf + chunk).slice(-TAIL_BUFFER_BYTES);
}

export function makeProgram(
  opts: GeminiInvokeOptions,
  queue: Queue.Queue<AppendEventInput | null>,
  blobStore: BlobStore,
): Effect.Effect<boolean, SpawnError, Spawner> {
  const args = buildArgs(opts);

  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* Spawner;
      const handle: SpawnHandle = yield* Effect.acquireRelease(
        spawner.spawn("gemini", args, opts.prompt, { cwd: opts.cwd }),
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

      // Rolling tail buffers — consuming both streams in full prevents the
      // child from blocking on a full OS pipe buffer.
      const stdoutTailRef = yield* Ref.make<string>("");
      const stderrTailRef = yield* Ref.make<string>("");

      // Drain stderr concurrently into a rolling tail buffer.
      const stderrFiber = yield* Effect.fork(
        handle.stderr.pipe(
          Stream.mapEffect((chunk) =>
            Ref.update(stderrTailRef, (buf) => appendTail(buf, chunk)),
          ),
          Stream.runDrain,
        ),
      );

      // Drain stdout: tee each line into the tail buffer, then decode + map.
      yield* handle.stdout.pipe(
        Stream.tap((line) =>
          Ref.update(stdoutTailRef, (buf) => appendTail(buf, line + "\n")),
        ),
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

      // Wait for process exit and stderr fiber to finish
      const exitCode = yield* handle.exitCode;
      yield* Fiber.join(stderrFiber);

      const finalState = yield* Ref.get(stateRef);
      const stdoutTail = yield* Ref.get(stdoutTailRef);
      const stderrTail = yield* Ref.get(stderrTailRef);

      const stdoutTailHash =
        stdoutTail.length > 0 ? blobStore.putBlob(stdoutTail).hash : null;
      const stderrTailHash =
        stderrTail.length > 0 ? blobStore.putBlob(stderrTail).hash : null;

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

      // Emit the single invocation.completed event with tail hashes attached.
      // Success path uses stats captured by the mapper from the result event;
      // failure path is synthetic. The exit code is encoded into exit_reason
      // so failures aren't lumped under the opaque "unknown".
      let completed: AppendEventInput<"invocation.completed">;
      if (finalState.result) {
        completed = {
          ...base,
          type: "invocation.completed",
          payload: {
            invocation_id: finalState.invocation_id,
            outcome: finalState.result.outcome,
            tokens_in: finalState.result.tokens_in,
            tokens_out: finalState.result.tokens_out,
            duration_ms: finalState.result.duration_ms,
            turns: 0,
            exit_reason:
              finalState.result.outcome === "success" ? "normal" : "unknown",
            stdout_tail_hash: stdoutTailHash,
            stderr_tail_hash: stderrTailHash,
            permission_blocked_on: null,
          },
        };
      } else {
        completed = {
          ...base,
          type: "invocation.completed",
          payload: {
            invocation_id: finalState.invocation_id,
            outcome: "failed",
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: 0,
            turns: 0,
            exit_reason: exitCode === 0 ? "unknown" : "crashed",
            stdout_tail_hash: stdoutTailHash,
            stderr_tail_hash: stderrTailHash,
            permission_blocked_on: null,
          },
        };
      }
      yield* Queue.offer(queue, completed);

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
  blobStore: BlobStore,
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
    makeProgram(opts, queue, blobStore).pipe(Effect.provide(layer)),
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
