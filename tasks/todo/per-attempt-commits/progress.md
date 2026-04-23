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

## 2026-04-23: base_sha on task.worktree_created + worktree resolution

Added `base_sha` to `task.worktree_created` event and resolved it at worktree creation time.

- `TaskWorktreeCreated` interface in `shared/events.ts` now includes `base_sha: string`
- Zod schema in `shared/eventSchemas.ts` requires `base_sha`
- TDD tests added: valid payload, base_ref preserved, base_sha required, missing fields rejected
- `createWorktree` in `server/worktree.ts` runs `git rev-parse <base_ref>` before worktree creation and emits the resolved 40-char SHA as `base_sha`
- Updated `taskDetail.test.ts` fixture to include `base_sha`

PRD items 3 and 4 completed.

## 2026-04-23: Per-attempt commit + attempt.committed emission

Replaced inline commit logic in `server/phaseRunner.ts` with injectable `committer` dep and structured per-attempt commits.

- Added `committer` to `PhaseRunnerDeps` — `(worktree_path, message) => { sha, empty }`
- Default committer: stages, checks porcelain, uses `--allow-empty` when no changes, captures SHA from output
- Commit message format: `Attempt <N> of <task_id> — <outcome>` with config hash, cost, duration in body
- Emits `attempt.committed` event with `{ attempt_id, commit_sha, empty }` after successful commit
- 4 TDD tests: correct SHA, empty flag, message format, single commit after all phases
- Updated happy-path event sequence to include `attempt.committed`
- Added `noopCommitter` to `makeTestDeps` to eliminate stderr noise from fake worktree paths

PRD items 5, 6, and 14 completed.

## 2026-04-23: Anchored diff capture + phase.diff_snapshotted emission

Anchored per-phase diff capture to `base_sha` and added `phase.diff_snapshotted` event emission.

- `diffCapturer` signature changed to `(worktree_path, base_sha) => string` — diffs against a specific base instead of HEAD
- Diff base resolution: attempt 1 uses `base_sha` from `task.worktree_created`, attempt 2+ uses previous attempt's `commit_sha` from `attempt.committed` event
- `base_sha` added to `TaskDetailRow` and `proj_task_detail` table, populated by `reduceTaskDetail` on `task.worktree_created`
- `phase.diff_snapshotted` event emitted after each non-empty diff capture with `{ attempt_id, phase_name, diff_hash, base_sha }`
- `diff_hash` on `phase.completed` preserved unchanged — matches the snapshotted hash
- 3 TDD tests: attempt 1 uses base_sha, attempt 2 uses previous commit SHA, phase.diff_snapshotted emitted with correct payload

PRD items 7, 8, and 15 completed.
