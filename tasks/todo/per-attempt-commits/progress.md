## 2026-04-23: attempt.committed event type

Added `attempt.committed` event with TDD tests.

- `AttemptCommitted` interface in `shared/events.ts` with `{ attempt_id, commit_sha, empty }` payload
- Zod schema in `shared/eventSchemas.ts` with 5 test cases (valid payload, empty flag, missing fields)
- Added to `EventMap` and `PROJECTION_SUBSCRIPTIONS` (subscribed by `attempt` projection)
- `reduceAttempt` handles the event, storing `commit_sha` and `empty` on `AttemptRow`

PRD item 1 completed.

## 2026-04-23: phase.diff_snapshotted event type

Added `phase.diff_snapshotted` event with TDD tests.

- `PhaseDiffSnapshotted` interface in `shared/events.ts` with `{ attempt_id, phase_name, diff_hash, base_sha }` payload
- Zod schema in `shared/eventSchemas.ts` with 6 test cases (valid payload, phase names, missing fields)
- Added to `EventMap` and `PROJECTION_SUBSCRIPTIONS` (subscribed by `attempt` projection)
- `reduceAttempt` handles the event, storing `diff_hash` on the phase's `PhaseRunSummary`

PRD item 2 completed.
