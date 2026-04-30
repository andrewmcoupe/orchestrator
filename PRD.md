# Add Gemini CLI as an AI Provider (Effect-based pilot)

## Overview

Add `gemini-cli` as a full-peer AI provider alongside `claude-code` and `codex`, capable of running orchestrator phases that read and edit files in worktrees. The new adapter is built using `effect` and `@effect/vitest` internally as a deliberate pilot; it exposes the same `async function*` boundary as the existing adapters so `server/phaseRunner.ts` dispatch and the other two providers are untouched. Cost tracking is intentionally omitted — only raw token counts are emitted.

## Add Spawner service and Gemini stream-json schemas

Create the foundational Effect primitives the adapter will build on. This task introduces no orchestrator wiring — just the service interface, the schema decoders, and the event mapper, all unit-tested in isolation.

- Create `server/adapters/gemini/spawner.ts`. Define an Effect `Context.Tag` named `Spawner` whose service shape is:
  ```ts
  interface Spawner {
    readonly spawn: (
      command: string,
      args: ReadonlyArray<string>,
      input: string,
    ) => Effect.Effect<SpawnHandle, SpawnError, never>;
  }
  ```
  where `SpawnHandle` exposes `stdout: Stream.Stream<string, never>` (line-delimited), `stderr: Stream.Stream<string, never>`, `exitCode: Effect.Effect<number, never>`, and `kill: Effect.Effect<void, never>`.
- Provide `SpawnerLive` (a `Layer` wrapping `node:child_process.spawn` with `Effect.acquireRelease` so interruption deterministically calls `kill('SIGTERM')`, falling back to `SIGKILL` after 2s). The live layer must split stdout into lines (handle partial chunks across reads) and pass `input` via stdin then close it.
- Create `server/adapters/gemini/schema.ts`. Use `effect/Schema` to define decoders for the three known Gemini stream-json variants captured from a real run:
  - `InitEvent`: `{ type: "init", timestamp: string, session_id: string, model: string }`
  - `MessageEvent`: `{ type: "message", timestamp: string, role: "user" | "assistant", content: string, delta?: boolean }`
  - `ResultEvent`: `{ type: "result", timestamp: string, status: "success" | "error", stats: { total_tokens: number, input_tokens: number, output_tokens: number, duration_ms: number, tool_calls: number } }`
  Export a discriminated union `GeminiStreamEvent` and a `decodeLine(line: string): Effect.Effect<Option<GeminiStreamEvent>, never>` that returns `None` for non-JSON lines or unknown `type` values (must NOT fail — Gemini emits stderr noise like `[STARTUP]` lines and `Loaded cached credentials` and may add new event variants in future versions). Log unknown variants at debug level via `Effect.logDebug`.
- Create `server/adapters/gemini/mapper.ts`. Export `mapEvent(event: GeminiStreamEvent, state: MapperState): { state: MapperState, emit: ReadonlyArray<AppendEventInput> }` where `AppendEventInput` is imported from `@shared/events`. Mapping rules:
  - `init` → emit one `invocation.started` with `provider_id: "gemini-cli"`, `model: event.model`, `session_id: event.session_id`.
  - `message` with `role: "assistant"` and `delta: true` → accumulate `content` into `state.assistantBuffer`; emit nothing.
  - `message` with `role: "assistant"` and `delta` falsy → flush buffer + this message, emit one `invocation.assistant_message`.
  - `message` with `role: "user"` → emit nothing (the orchestrator already has the prompt).
  - `result` → flush any remaining `assistantBuffer` as a final `invocation.assistant_message`, then emit one `invocation.completed` with `status: event.status`, `tokens: { input: event.stats.input_tokens, output: event.stats.output_tokens, total: event.stats.total_tokens }`, `duration_ms: event.stats.duration_ms`. Do NOT populate any cost/USD field.
- Tests live in `server/adapters/gemini/spawner.test.ts`, `schema.test.ts`, `mapper.test.ts` using `it.effect` from `@effect/vitest`. Cover: line splitting across chunked stdout reads; decoder returns `None` for the literal `[STARTUP] StartupProfiler.flush()` and `Loaded cached credentials` lines from the captured sample; mapper buffers assistant deltas correctly across multiple chunks; mapper emits `invocation.completed` exactly once per `result` event.
- **Unknown to verify at implementation time:** the JSON shape Gemini emits when `tool_calls > 0` (the captured sample had `tool_calls: 0`). Add a `// TODO(gemini-tools): capture and decode tool-call event variant` comment in `schema.ts` and define a permissive `unknown` fallthrough so tool-call events log + skip rather than crash.

## Build Gemini adapter with Effect program and async-generator boundary

Implement the Gemini adapter itself by composing the spawner, schema, and mapper from the prior task, then expose it through the existing `AsyncIterable<AppendEventInput>` contract used by `claudeCode.ts` and `codex.ts`.

- Create `server/adapters/gemini.ts`. Mirror the public signature of `server/adapters/claudeCode.ts`'s `invoke`:
  ```ts
  export async function* invoke(
    opts: GeminiInvokeOptions,
    blobStore: BlobStore,
    spawner?: Spawner,
    signal?: AbortSignal,
  ): AsyncIterable<AppendEventInput>
  ```
- Define `GeminiInvokeOptions` matching the `CLI` shape used by the other CLI adapters (`prompt: string`, `cwd: string`, `model?: string`, `permission_mode?: "default" | "accept_edits" | "bypass_permissions" | "plan"`, `sandbox?: boolean`, plus whatever fields the existing `ClaudeCodeInvokeOptions` carries that are transport-agnostic — match its shape).
- Build the spawn argv:
  - Always: `--output-format stream-json`, `--skip-trust`.
  - `--model <opts.model ?? "gemini-2.5-pro">`. Validate `opts.model` is non-empty; do not gate on a hardcoded model list.
  - `--approval-mode` mapping: `default → default`, `accept_edits → auto_edit`, `bypass_permissions → yolo`, `plan → plan`. Default to `default` if `permission_mode` is unset.
  - `--sandbox` only if `opts.sandbox === true` (default off — the worktree already provides isolation).
  - Pass `opts.prompt` via stdin, NOT as `-p`, to avoid argv length limits and shell-escaping issues.
- Internally, write the orchestration as an Effect program:
  - `Effect.acquireRelease` the `SpawnHandle` (release calls `kill`).
  - Run a stateful fold over `stdout.pipe(Stream.mapEffect(decodeLine), Stream.filterMap(identity), ...)` that threads `MapperState` and yields each batch of `AppendEventInput`s.
  - On `exitCode !== 0`, emit a final `invocation.completed` with `status: "error"` if no `result` event was seen.
- Wrap that Effect at the boundary: the public `async function*` builds a `Layer` providing `SpawnerLive` (or the injected test `Spawner`), runs the program via `Effect.runFork`, and pulls events out via a `Queue` bridged into a normal `for await` loop. Wire `signal.aborted` to `Fiber.interrupt(fiber)` so cancellation tears down the spawn deterministically.
- Tests in `server/adapters/gemini.test.ts`:
  - **Inner Effect tests** (`it.effect`): provide a fake `Spawner` `Layer` whose `stdout` stream replays the real captured sample (init + 2 assistant deltas + result), assert the program emits the correct `AppendEventInput[]` and exits cleanly. A second test scripts a non-zero exit code with no `result` event and asserts a synthetic `invocation.completed { status: "error" }` is appended.
  - **Outer wrapper test** (plain `vitest`): pass a fake spawner via the `spawner?` parameter, iterate `for await` over the returned `AsyncIterable`, assert the full event sequence matches expectations. One happy-path test is sufficient — detailed cases are covered by the inner tests.
  - **Cancellation test** (plain `vitest`): start iteration, call `controller.abort()`, assert the iterator returns and the fake spawner's `kill` was invoked.

## Wire Gemini adapter into phaseRunner dispatch

Plug the new adapter into `server/phaseRunner.ts` so tasks with `transport: "gemini-cli"` actually run. The registry entry and `CLI_TRANSPORTS` membership already exist — only dispatch wiring is missing.

- In `server/phaseRunner.ts`:
  - Import `invoke as geminiInvoke` from `./adapters/gemini`.
  - Add `geminiCliInvoker?: AdapterInvokeFn` to the `PhaseRunnerDeps` type (alongside `claudeCodeInvoker` and `codexInvoker` around lines 139–161).
  - In the dependency resolution block (around lines 346–361), add:
    ```ts
    const doGeminiInvoke =
      deps?.geminiCliInvoker ?? ((opts, bs) => geminiInvoke(opts, bs));
    ```
  - In the CLI dispatch branch (around lines 604–671), add an arm for `transport === "gemini-cli"` that calls `doGeminiInvoke` with the same `opts` shape used for `claude-code` and `codex`. The mapping from the orchestrator's transport_options → `GeminiInvokeOptions` must mirror what's done for `claude-code`: forward `permission_mode`, `cwd`, `prompt`, `model`. Ignore `max_budget_usd` if present (gemini-cli does not enforce budgets).
- Confirm `server/providers/registry.ts` line 49–55 already has the correct `gemini-cli` entry; if any field is wrong (e.g. `setup_hint`, `auth_method`), correct it but do not duplicate. The captured live sample shows `Loaded cached credentials` from a Google login, so `auth_method: "cli_login"` is correct.
- Add ONE integration test in `server/phaseRunner.test.ts` (or extend an existing one): construct a task with `phase.transport: "gemini-cli"`, inject a fake `geminiCliInvoker` that yields a scripted `AppendEventInput[]`, run the phase, assert the events are persisted and the phase completes. Mirror the structure of the existing `claude-code` integration test.
- Do NOT touch other adapters, the UI, or any cost/budget projections. The pilot deliberately keeps blast radius to the dispatch arm and the new adapter files.

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/adapters/gemini/spawner.ts` | NEW — Effect `Context.Tag` for `Spawner`, plus `SpawnerLive` Layer wrapping `child_process.spawn` with `Effect.acquireRelease` cleanup. |
| `server/adapters/gemini/spawner.test.ts` | NEW — `it.effect` tests for line-splitting and kill-on-interrupt. |
| `server/adapters/gemini/schema.ts` | NEW — `effect/Schema` decoders for `init`, `message`, `result` Gemini events plus permissive `decodeLine` that drops non-JSON / unknown variants. Includes TODO for tool-call variant. |
| `server/adapters/gemini/schema.test.ts` | NEW — `it.effect` tests covering real captured sample lines and stderr noise. |
| `server/adapters/gemini/mapper.ts` | NEW — Stateful `mapEvent` translating `GeminiStreamEvent` → `AppendEventInput[]`, buffering assistant deltas, no cost field. |
| `server/adapters/gemini/mapper.test.ts` | NEW — `it.effect` tests for delta buffering and single completion event. |
| `server/adapters/gemini.ts` | NEW — Public `async function* invoke(opts, blobStore, spawner?, signal?)` that composes spawner+schema+mapper inside an Effect program and bridges to `AsyncIterable<AppendEventInput>` with `AbortSignal` → `Fiber.interrupt`. |
| `server/adapters/gemini.test.ts` | NEW — Inner Effect tests + outer async-iterable wrapper test + cancellation test. |
| `server/phaseRunner.ts` | EDIT — Import `geminiInvoke`; add `geminiCliInvoker` to `PhaseRunnerDeps`; resolve `doGeminiInvoke`; add `gemini-cli` arm to CLI dispatch branch. |
| `server/phaseRunner.test.ts` | EDIT — One integration test with injected fake `geminiCliInvoker`. |
| `server/providers/registry.ts` | VERIFY (likely no change) — existing `gemini-cli` entry at lines 49–55 is correct per the live `cli_login` confirmation. |

## Out of Scope

- Migrating `claudeCode.ts` or `codex.ts` to Effect. The pilot is deliberately Gemini-only; a follow-up PRD can decide whether to migrate after evaluating this one.
- Refactoring `phaseRunner.ts`'s dispatch beyond adding the new arm.
- Cost / USD tracking for Gemini. Token counts are emitted; no `max_budget_usd` enforcement, no per-token rate table, no projections changes.
- UI changes (transport selectors, provider screens). The existing UI already lists `gemini-cli` from the registry; verify visually but do not modify.
- Capturing and decoding the Gemini tool-call event variant. Flagged as a known unknown in `schema.ts`; will be addressed once a real sample with `tool_calls > 0` is captured.
- Sandbox-mode (`--sandbox`) ergonomics beyond the opt-in flag — no container debugging, no fallback if sandbox fails.
- Adding Gemini to any preset task templates in `server/presets.ts`.

## Unknowns (orchestrator should raise pushback)

- **Tool-call event JSON shape** — not present in the captured sample. The schema must handle them defensively (log + skip) until a real sample is captured. Implementing agent should attempt to trigger one (e.g. ask Gemini to read a file) and update `schema.ts` if successful in the same PR; otherwise leave the TODO.
