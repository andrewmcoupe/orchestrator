# Invocation Exit Classification & Subprocess Observability

## Overview

When a Claude Code subprocess exits unexpectedly — permission prompt hang, budget exceeded, crash — the orchestrator captures only a bare `outcome: "success" | "failed" | "aborted"` with no detail about why. The user sees `phase.completed implementer` in the timeline and has no idea the process was hung on a permission prompt for 5 minutes before timing out. This PRD adds structured exit classification, raw output capture, permission-hang detection, and exit-reason-aware retry policies.

## Subprocess Output Capture

### CLI adapter — capture stdout/stderr tails

- Always capture the last ~4KB of both stdout and stderr from the Claude Code subprocess.
- Store each tail in the blob store as a separate blob.
- Reference both by hash on `invocation.completed` as `stdout_tail_hash: string | null` and `stderr_tail_hash: string | null`.
- Capture is best-effort — if the blob store write fails, the hashes are null and the invocation still completes normally.

## Exit Reason Classification

### CLI adapter — structured `exit_reason` enum

- Classify every invocation exit into a structured enum:
  ```
  "normal" | "timeout" | "budget_exceeded" | "turn_limit" | "permission_blocked" | "killed" | "schema_invalid" | "network_error" | "crashed" | "unknown"
  ```

### Classification priority order

1. **Structured events** — Claude Code emits explicit events before exit for budget limits and turn limits. If `invocation.budget_exceeded` or `invocation.turn_limit_reached` events were observed during the stream, classify as `budget_exceeded` or `turn_limit`.
2. **Subprocess exit code** — Map known exit codes: 0 → `normal`, 137/SIGKILL → `killed`, 124/timeout → `timeout`.
3. **Pattern matching on stderr tail** — Scan the last 4KB of stderr for known phrases:
   - `"Waiting for permission"` → `permission_blocked`
   - `"ENOTFOUND"` / `"ECONNREFUSED"` / `"socket hang up"` → `network_error`
   - `"schema"` + `"invalid"` / `"validation"` → `schema_invalid`
   - Stack traces / segfaults → `crashed`
4. **Fallback** — If none match, set to `"unknown"`. The raw tails are still stored so a human can investigate.

## Permission-Blocked Detection

### CLI adapter — active hang detection

- Monitor the stderr stream for the `"Waiting for permission"` pattern.
- If the pattern appears and no stream-json events have arrived for 10 seconds, the process is hung — not working.
- Kill the subprocess immediately. Do not wait for budget or turn limits to trip.
- Classify as `exit_reason: "permission_blocked"`.
- Record `permission_blocked_on: string` with the tool name that was being requested (parsed from the permission prompt output).

## Event Updates

### `shared/events.ts` — update `InvocationCompleted`

- Add fields:
  - `exit_reason: "normal" | "timeout" | "budget_exceeded" | "turn_limit" | "permission_blocked" | "killed" | "schema_invalid" | "network_error" | "crashed" | "unknown"`
  - `stdout_tail_hash: string | null`
  - `stderr_tail_hash: string | null`
  - `permission_blocked_on: string | null` (only populated when `exit_reason === "permission_blocked"`)

### `shared/events.ts` — update `PhaseCompleted`

- Mirror the same fields onto `phase.completed`:
  - `exit_reason`
  - `stdout_tail_hash`
  - `stderr_tail_hash`
  - `permission_blocked_on`
- The phase runner reads these from the `invocation.completed` event and copies them into `phase.completed`.

### `shared/projections.ts` — add `last_failure_reason` to attempt projection

- Add `last_failure_reason: string | null` to the attempt projection row.
- Populated from the most recent `phase.completed` event where `exit_reason !== "normal"`.
- The cockpit can surface this at a glance without the user drilling into the timeline.

## Retry Policy — Exit-Reason-Aware

### `shared/events.ts` — extend retry policy config

- Add an `on_exit_reason` map to the retry policy configuration:
  ```typescript
  on_exit_reason?: Partial<Record<ExitReason, "retry_same" | "retry_different" | "escalate_to_human">>;
  ```

### Default mappings

| Exit Reason | Default Strategy | Rationale |
|---|---|---|
| `permission_blocked` | `escalate_to_human` | Config problem — the user needs to grant permissions |
| `budget_exceeded` | `escalate_to_human` | Cost problem — the user needs to adjust budget |
| `timeout` | `retry_same` | Transient — may succeed on retry |
| `network_error` | `retry_same` | Transient — may succeed on retry |
| `schema_invalid` | `retry_same` (max 2x) | Model output issue — may self-correct |
| `turn_limit` | `escalate_to_human` | Task may be too complex for current config |
| `killed` | `escalate_to_human` | User or system intervention — don't auto-retry |
| `crashed` | `escalate_to_human` | Unknown failure — needs investigation |
| `unknown` | `escalate_to_human` | Unknown failure — needs investigation |

### Retry policy evaluation order

- `on_exit_reason` is checked **before** the existing verdict-based retry logic.
- If the exit reason maps to `escalate_to_human`, the attempt completes immediately without retry regardless of other retry settings.
- If it maps to `retry_same`, the existing retry counter and limits still apply.

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/adapters/claudeCode.ts` | Capture stdout/stderr tails, classify exit reason, detect permission hang with 10s timeout |
| `shared/events.ts` | Update `InvocationCompleted` and `PhaseCompleted` with exit_reason, tail hashes, permission_blocked_on |
| `server/phaseRunner.ts` | Copy exit_reason fields from invocation.completed to phase.completed |
| `shared/projections.ts` | Add `last_failure_reason` to attempt projection, populate from phase.completed |
| `shared/events.ts` | Add `on_exit_reason` map to retry policy config type |
| `server/phaseRunner.ts` | Evaluate `on_exit_reason` before verdict-based retry logic |
| `server/adapters/claudeCode.test.ts` | Permission-prompt-hang fixture: adapter detects and kills within 10s |
| `server/adapters/claudeCode.test.ts` | Budget-exceeded fixture: classifies correctly from structured event |
| `server/adapters/claudeCode.test.ts` | Unknown-crash fixture: falls through to "unknown" with tails preserved |
| `server/phaseRunner.test.ts` | Test exit_reason fields are mirrored onto phase.completed |
| `server/phaseRunner.test.ts` | Test on_exit_reason retry policy evaluation |
