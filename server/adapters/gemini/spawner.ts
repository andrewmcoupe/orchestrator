/**
 * Spawner Effect service for launching child processes.
 *
 * Provides a deterministic cleanup model: Effect interruption sends SIGTERM,
 * with a SIGKILL fallback after 2 seconds if the process has not exited.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { Context, Effect, Layer, Stream, Deferred } from "effect";

// ============================================================================
// Error type
// ============================================================================

export class SpawnError {
  readonly _tag = "SpawnError";
  constructor(readonly message: string) {}
}

// ============================================================================
// SpawnHandle
// ============================================================================

export interface SpawnHandle {
  readonly stdout: Stream.Stream<string, never>;
  readonly stderr: Stream.Stream<string, never>;
  readonly exitCode: Effect.Effect<number, never>;
  readonly kill: Effect.Effect<void, never>;
}

// ============================================================================
// Spawner service
// ============================================================================

export interface Spawner {
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    input: string,
  ) => Effect.Effect<SpawnHandle, SpawnError, never>;
}

export const Spawner = Context.GenericTag<Spawner>("Spawner");

// ============================================================================
// Line splitter
// ============================================================================

/**
 * Splits a raw string stream into newline-delimited strings, handling partial
 * chunks across reads. Flushes any trailing content when the stream ends.
 */
export function lineSplit(raw: Stream.Stream<string, never>): Stream.Stream<string, never> {
  return Stream.unwrap(
    Effect.sync(() => {
      const bufferRef = { current: "" };

      const mainLines = raw.pipe(
        Stream.mapConcat((chunk: string) => {
          const combined = bufferRef.current + chunk;
          const parts = combined.split("\n");
          bufferRef.current = parts.pop()!;
          return parts;
        }),
      );

      const flush = Stream.suspend(() => {
        if (bufferRef.current.length > 0) {
          return Stream.make(bufferRef.current);
        }
        return Stream.empty;
      });

      return Stream.concat(mainLines, flush);
    }),
  );
}

// ============================================================================
// Helpers
// ============================================================================

function readableToStream(readable: Readable): Stream.Stream<string, never> {
  return Stream.async<string, never>((emit) => {
    readable.setEncoding("utf-8");
    readable.on("data", (chunk: string) => {
      emit.single(chunk);
    });
    readable.on("end", () => {
      emit.end();
    });
    readable.on("error", () => {
      emit.end();
    });
  });
}

// ============================================================================
// SpawnerLive
// ============================================================================

export const SpawnerLive: Layer.Layer<Spawner> = Layer.succeed(
  Spawner,
  Spawner.of({
    spawn: (command, args, input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const proc = nodeSpawn(command, args as string[], {
            stdio: ["pipe", "pipe", "pipe"],
          });

          let exited = false;

          const exitDeferred = yield* Deferred.make<number>();

          proc.on("close", (code) => {
            exited = true;
            Effect.runFork(Deferred.succeed(exitDeferred, code ?? 1));
          });

          proc.on("error", () => {
            exited = true;
            Effect.runFork(Deferred.succeed(exitDeferred, 1));
          });

          // Write input to stdin then close it
          proc.stdin!.write(input, () => {
            proc.stdin!.end();
          });

          const killFn = () => {
            if (!exited) {
              proc.kill("SIGTERM");
              const timer = setTimeout(() => {
                if (!exited) {
                  proc.kill("SIGKILL");
                }
              }, 2000);
              timer.unref();
            }
          };

          const handle: SpawnHandle = {
            stdout: lineSplit(readableToStream(proc.stdout!)),
            stderr: readableToStream(proc.stderr!),
            exitCode: Deferred.await(exitDeferred),
            kill: Effect.sync(killFn),
          };

          return { handle, killFn };
        }),
        // Release: deterministically kill on interruption
        ({ killFn }) => Effect.sync(killFn),
      ).pipe(Effect.map(({ handle }) => handle)),
  }),
);
