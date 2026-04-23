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

## 2026-04-23: no_changes outcome → awaiting_review

Changed `no_changes` outcome status from `draft` to `awaiting_review` so empty attempts don't silently regress.

- `server/phaseRunner.ts`: `newStatus` for `no_changes` outcome changed from `"draft"` to `"awaiting_review"`
- `server/phaseRunner.test.ts`: Updated no_changes test assertion to expect `awaiting_review`

PRD items 9 and 14 completed.

## 2026-04-23: effective_diff_attempt_id on attempt projection

Added `effective_diff_attempt_id` to `AttemptRow` for empty-attempt diff fallback.

- Field added to `AttemptRow` interface, `RawAttemptRow`, SQL schema, `rowFromRaw`, and `write` method
- Reducer sets `effective_diff_attempt_id = attempt_id` for non-empty commits on `attempt.committed`
- Write-time walkback: empty attempts walk `previous_attempt_id` chain in DB to find the most recent non-empty attempt
- 3 TDD tests: non-empty self-reference, empty walkback to prior non-empty, null when no prior non-empty exists
- `commit_sha` and `empty` columns also added to SQL schema and persistence (were previously only in-memory on the reducer)

PRD items 10 and 16 completed.

## 2026-04-23: Retry prompt includes previous attempt's diff

Added `git diff HEAD~1 HEAD` output to the implementer prompt for retry attempts, completing delta-only diff semantics.

- Added `gitDiffPrevAttempt` injectable dep to `TrivialPackerDeps` (defaults to `git diff HEAD~1 HEAD`)
- Added `isRetryAttempt` helper that checks `attempt.started` event for `previous_attempt_id`
- Implementer prompt now includes "## Previous Attempt Changes" diff block on retry attempts
- 2 TDD tests: retry attempt includes previous diff, first attempt does not

PRD item 11 completed.

## 2026-04-23: Empty-attempt banner in Review UI

Added empty-attempt fallback display to `web/src/screens/review/Review.tsx` with diff fetched from the effective attempt.

- Fixed API parser in `server/routes/projections.ts` to include `commit_sha`, `empty`, and `effective_diff_attempt_id` on the attempt response (fields were stored in DB but stripped during parsing)
- Review UI reads `effective_diff_attempt_id` — when it differs from the current attempt, fetches the effective attempt's diff and shows a warning banner
- When `effective_diff_attempt_id` is null, renders "No attempts have produced changes yet."
- Non-empty attempts display normally with no banner
- 4 TDD tests: fallback banner text, no-changes-yet banner, no banner for non-empty, effective attempt diff fetch

PRD item 12 completed.

## 2026-04-23: Crash recovery — discard uncommitted worktree changes on startup

Added `server/crashRecovery.ts` module and wired it into `server/app.ts` startup.

- `recoverWorktrees(db)` queries `proj_task_detail` for rows with `worktree_path`, runs `git reset --hard HEAD` + `git clean -fd` on each existing path
- Skips worktree paths that no longer exist on disk
- Called in `app.ts` after `initProjections(db)` but before routes are mounted
- 5 TDD tests: modified files discarded, untracked files removed, committed state preserved, missing paths skipped, multiple worktrees handled

PRD item 13 completed.
