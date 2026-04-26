# Codex CLI Adapter

## Overview

The orchestrator currently only supports Claude Code as a CLI transport. This PRD adds a dedicated Codex CLI adapter (`server/adapters/codex.ts`) that spawns `codex exec --json` and translates its NDJSON event stream into the orchestrator's canonical `AppendEventInput` events. This enables phases to be configured with `transport: "codex"` and run against OpenAI models via the Codex CLI.

## Adapter — `server/adapters/codex.ts`

### New file, separate from Claude Code adapter

- Create `server/adapters/codex.ts` as a standalone adapter file.
- Export `invoke()` as an async generator yielding `AppendEventInput` objects.
- Export `buildArgs()` that constructs the CLI invocation.
- Export `translateLine()` that handles all Codex NDJSON event types.
- Use the same `Spawner` type abstraction as `claudeCode.ts` for test injection.

### CLI invocation shape

- Binary: `codex exec --json --ephemeral --cd <cwd> --model <model> <prompt>`
- `--ephemeral` to prevent Codex from writing its own session files.
- `--output-schema <path>` when the phase has a `schema` transport option (write JSON schema to a temp file).

### Permission mode mapping

Map the existing `permission_mode` transport option to Codex flags:

| `permission_mode` | Codex flags |
|---|---|
| `acceptEdits` / `auto` | `--full-auto` |
| `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |
| `plan` / `default` | `--sandbox read-only --ask-for-approval untrusted` |

### NDJSON event translation

Codex emits three item types: `agent_message`, `command_execution`, and `file_change`.

| Codex event | Canonical event(s) |
|---|---|
| `thread.started` | `invocation.started` |
| `turn.started` | (no event — internal bookkeeping only) |
| `item.started` (command_execution) | `invocation.tool_called` (command stored in blob store) |
| `item.completed` (command_execution) | `invocation.tool_returned` + run `git diff` for file edit detection |
| `item.started` (file_change) | `invocation.tool_called` |
| `item.completed` (file_change) | `invocation.tool_returned` + `invocation.file_edited` from structured change data (`path`, `kind`) + `git diff` safety net |
| `item.completed` (agent_message) | `invocation.assistant_message` |
| `turn.completed` | `invocation.completed` with token counts |

### File edit detection — hybrid approach

- `file_change` items: emit `invocation.file_edited` directly from the structured `changes` array (each entry has `path` and `kind`: `add`, `modify`, `delete`).
- `command_execution` items: run `git diff` via `detectFileEdits` after each completion as a safety net, since shell commands can modify worktree files without going through `apply_patch`.
- Reuse the existing `seenSnapshot` pattern from `claudeCode.ts`.

### Token and cost tracking

- `turn.completed` provides `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
- Pass through token counts on `invocation.completed`.
- Set `total_cost_usd: 0` — Codex does not report cost. OpenAI model pricing can be added to `modelPricing.ts` as a follow-up.

### Error handling

- Same subprocess exit code classification pattern as `claudeCode.ts` via `classifySubprocessError`.
- `command_execution` with non-zero `exit_code` → `invocation.tool_returned` (tool-level error, not adapter-level).
- Missing `turn.completed` (process crash/kill) → classify from exit code, map to `ExitReason`.
- No permission-hang detection in initial implementation (we always pass `--full-auto` or `--yolo`).

## Phase Runner Updates

### Rename `cliInvoker` to `claudeCodeInvoker`

- Rename the existing `cliInvoker` field in `PhaseRunnerDeps` to `claudeCodeInvoker`.
- Update `runAttempt` and all tests that inject `cliInvoker`.

### Add `codexInvoker` to `PhaseRunnerDeps`

- Add `codexInvoker?: AdapterInvokeFn` to `PhaseRunnerDeps`.
- Default to `codex.invoke` from the new adapter.
- Route by transport name: if `phase.transport === "codex"` → `codexInvoker`, else → `claudeCodeInvoker`.

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/adapters/codex.ts` | New file — Codex CLI adapter with invoke, buildArgs, translateLine |
| `server/phaseRunner.ts` | Rename `cliInvoker` → `claudeCodeInvoker`, add `codexInvoker`, route by transport name |
| `shared/events.ts` | No changes needed — `"codex"` already in `Transport` union and `CLI_TRANSPORTS` |
| `server/adapters/codex.test.ts` | New file — tests using injected Spawner (no real subprocess) |
| `server/phaseRunner.test.ts` | Update tests for renamed dep, add test for codex transport routing |
