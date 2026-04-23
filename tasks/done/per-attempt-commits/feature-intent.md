# Per-Attempt Commits & Branch-Aware Diff Lifecycle

## Overview

The current phase runner commits worktree changes immediately after the phase loop, before the attempt outcome is determined. This causes problems on retry: the implementor finds nothing to do (changes already committed), the diff capturer sees no uncommitted changes, and the task regresses to `draft`. This PRD restructures the commit and diff lifecycle around per-attempt commits, branch-aware diffs, and proper retry semantics.

## Base SHA Resolution

### `server/worktree.ts` — resolve at creation time

- At worktree creation time, resolve `base_ref` to a concrete commit SHA via `git rev-parse <base_ref>`.
- Update the `task.worktree_created` event payload to include `base_sha: string` (the resolved commit SHA) alongside the existing `base_ref: string` (the symbolic reference it came from).
- Store both — the symbolic ref is useful context ("this task branched from main"), the SHA is the immutable anchor.

### `shared/events.ts` — update event type

- Add `base_sha: string` to the `task.worktree_created` event payload.

### Diff anchor rules

- All subsequent diff-capture logic uses `base_sha` as the anchor for attempt 1.
- For attempts 2+, the anchor is the previous attempt's commit SHA (from `attempt.committed`).

## Per-Attempt Commits

### `server/phaseRunner.ts` — commit after attempt completion

- Move the current commit step (step 3b) to fire **after** all phases, gates, and auditor have completed — but still within `runAttempt`.
- Commit message format:
  ```
  Attempt <N> of <task_id> — <outcome>

  config: <config_snapshot_hash>
  cost: $<cost_usd>
  duration: <duration_ms>ms
  ```
- Phase-level details (which prompts, which variants, per-phase costs) stay in the event log, not the commit message. The commit is the artifact; the events are the record.
- Use `git commit --allow-empty` when the attempt produced no file changes, so every attempt is represented in git history.
- Emit a new event `attempt.committed` with payload `{ attempt_id, commit_sha, empty: boolean }`.

### `server/phaseRunner.ts` — remove per-phase commit

- Remove the existing commit logic that fires at the end of the phase loop. The only commit point is per-attempt, after all work is done.

## Per-Phase Diff Capture

### `server/phaseRunner.ts` — anchored diff base

- At each phase's completion, run `git diff <base> -- . :!node_modules` where `<base>` is the prior attempt's commit SHA (or `base_sha` from `task.worktree_created` for attempt 1).
- Store the patch in the blob store.
- Emit a new event `phase.diff_snapshotted` with payload `{ attempt_id, phase_name, diff_hash, base_sha }`.

### Migration strategy — do not remove `diff_hash` from `phase.completed`

- `diff_hash` on `phase.completed` is load-bearing — the review UI reads it to display diffs.
- Add the new `phase.diff_snapshotted` event and its reducer, projected into the attempt's phases map as a `diff_hash` field.
- Update the diff capture logic to emit `phase.diff_snapshotted` at phase-completion time with the real captured diff.
- Leave `phase.completed`'s existing `diff_hash` field in place, now populated from the snapshotted blob instead of the placeholder.
- The review UI continues reading the same field and works unchanged.
- Removing `diff_hash` from `phase.completed` for cleanliness is a separate future task — do not bundle a breaking schema change into a behavioural fix.

## Merge-Time Squash

### `server/merge.ts` — squash attempt commits

- The merge workflow squash-merges all attempt commits on the worktree branch into a single commit on the target branch.
- Commit message: task title + the approved attempt's summary.
- Intermediate attempt commits stay on the worktree branch (preserved or pruned per `on_merge.preserve_branch` config) but never land on the target branch.
- No changes needed to the actual `git merge --squash` mechanics — this already squashes. The difference is that there are now multiple commits to squash rather than one.

## Retry Semantics

### `server/phaseRunner.ts` — retry starts from prior attempt's commit

- Attempt 2's implementer runs in a worktree where `HEAD` is attempt 1's commit.
- The retry prompt should reference `git diff HEAD~1 HEAD` as "the changes made by the previous attempt" and include the auditor's concerns.
- After attempt 2's work, `git diff HEAD` shows only attempt 2's delta — not cumulative.

## Empty-Attempt Semantics

### `server/phaseRunner.ts` — empty commit + event

- When an attempt makes no file changes, the commit is empty (`--allow-empty`), the diff blob is empty, and the event log shows `attempt.committed { empty: true }`.

### `server/phaseRunner.ts` — status transition

- Change `no_changes` outcome from `newStatus = "draft"` to `newStatus = "awaiting_review"`. The user decides what to do — the task should not silently regress.

### Attempt projection — `effective_diff_attempt_id`

- The attempt projection should compute and store an `effective_diff_attempt_id` field:
  - For a non-empty attempt, it equals the attempt's own id.
  - For an empty attempt, it equals the most recent prior non-empty attempt's id (walking back through `previous_attempt_id`).
  - If there's no prior non-empty attempt at all, the field is `null`.
- This walk-back logic lives in the projection reducer — server-side, deterministic, testable — not in the UI.

### Review UI — empty attempt display

- `web/src/screens/review/Review.tsx`: Read `effective_diff_attempt_id` to fetch the diff blob.
- When the current attempt's id differs from the effective one, render a banner: "This attempt made no changes. Showing diff from attempt \<M\>."
- When `effective_diff_attempt_id` is `null`, render: "No attempts have produced changes yet."

## Crash Recovery

### `server/index.ts` or startup hook

- On server restart, any uncommitted changes in a worktree belong to an interrupted in-flight attempt and should be discarded via `git reset --hard HEAD`.
- Committed state is the canonical record of completed attempts.

## New Events

### `shared/events.ts`

- Add `attempt.committed` event type:
  - `aggregate_type: "attempt"`
  - Payload: `{ attempt_id: string; commit_sha: string; empty: boolean }`

- Add `phase.diff_snapshotted` event type:
  - `aggregate_type: "attempt"`
  - Payload: `{ attempt_id: string; phase_name: string; diff_hash: string; base_sha: string }`

- Update `task.worktree_created` event payload to include `base_sha: string`.

- Update `PROJECTION_SUBSCRIPTIONS` to include the new event types where needed.
- Add Zod schemas for all new/updated event payloads.

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/worktree.ts` | Resolve `base_ref` to `base_sha` at creation time, include in event payload |
| `server/phaseRunner.ts` | Move commit to per-attempt, anchor diff base, emit new events, change no_changes → awaiting_review |
| `server/phaseRunner.test.ts` | Update tests: expect awaiting_review for no_changes, test per-attempt commit, test empty commits |
| `server/merge.ts` | No structural changes — squash already works, but verify with multiple attempt commits |
| `shared/events.ts` | Add `attempt.committed`, `phase.diff_snapshotted`, update `task.worktree_created` + Zod schemas |
| `shared/projections.ts` | Add `effective_diff_attempt_id` to attempt projection, subscribe to new events |
| `web/src/screens/review/Review.tsx` | Use `effective_diff_attempt_id` for diff display, add empty-attempt banner |
| `server/index.ts` | Add crash recovery: reset uncommitted worktree changes on startup |
