# Dependency System Progress

## 2026-04-23 — Testing & Shared Types (PRD items: "Testing — Shared Types", "Shared Types — Events")

- Created `shared/eventSchemas.test.ts` with 10 tests covering `prd.ingested` (nullable path, required content), `task.dependency.set`, and `task.unblocked` schemas.
- Updated `PrdIngested` type: `path` is now `string | null`, added required `content: string`.
- Added `TaskDependencySet` and `TaskUnblocked` interfaces to `shared/events.ts`.
- Added corresponding Zod schemas to `shared/eventSchemas.ts` and registered them in the schema registry.
- Registered new event types in `PROJECTION_SUBSCRIPTIONS` (empty subscriptions for now).
- Fixed downstream type errors in `server/ingest.ts` and `server/projectionRunner.test.ts`.
- All tests pass, typecheck clean.

## 2026-04-23 — Ingest Pipeline: content mode (PRD items: "Testing — Ingest Pipeline", "Backend — Ingest Pipeline")

- Changed `ingestPrd()` signature from `(db, path, fetcher)` to `(db, input: { path: string } | { content: string }, fetcher)`.
- Content mode skips `readFileSync`, sets `path: null` in the `prd.ingested` event payload.
- Both modes compute `size_bytes`, `lines`, `content_hash`, and `content` from resolved text.
- Added 4 new tests in `server/ingest.test.ts` covering content mode behavior; updated existing tests to use new signature.
- Updated route handler in `server/routes/commands.ts` to pass `parsed.data` directly.
- All tests pass (15/15 in ingest suite), typecheck clean.

## 2026-04-23 — API Route: discriminated union schema (PRD items: "Testing — API Route", "Backend — API Route")

- Updated `prdIngestBody` Zod schema from `z.object({ path })` to a `z.union` of `{ path }` and `{ content }`, rejecting payloads with both or neither.
- Added 4 new tests in `server/routes/commands.test.ts` covering path-only, content-only, both-rejected, and neither-rejected cases.
- All tests pass, typecheck clean.

## 2026-04-23 — Dependency System: tests and core logic (PRD item: "Testing — Dependency System")

- Created `shared/dependency.ts` with three pure functions: `topoSort` (Kahn's algorithm with DFS cycle-edge stripping), `canAddDependency` (status gate), `resolveBlockedStatus` (dependency status resolution with warnings for terminal failures).
- Created `shared/dependency.test.ts` with 19 tests covering all 6 PRD verification steps: topo sort cycle detection, blocked projection state, unblocking on merge, partial unblocking, status validation, and cancelled/failed dependency warnings.
- Added `depends_on?: string[]` and `blocked?: boolean` fields to `TaskListRow` in `shared/projections.ts`.
- Added `task.dependency.set` and `task.unblocked` cases to `reduceTaskList`.
- All tests pass (19/19 in dependency suite, 86/86 across related files), typecheck clean.

## 2026-04-23 — Extraction Prompt: DT-* IDs and depends_on (PRD item: "Backend — Extraction Prompt")

- Updated `prompts/ingest-v1.md` to instruct the LLM to assign DT-001, DT-002, etc. IDs to draft tasks and output `depends_on` arrays referencing DT-* IDs.
- Added `id` (DT-* string) and `depends_on` (DT-* string array) fields to the extraction schema (both Zod and JSON Schema) in `server/ingest.ts`.
- Server builds a `taskIdMap` (DT-* → T-{ULID}) and remaps `depends_on` references in the same pass as proposition ID remapping.
- Emits `task.dependency.set` events for draft tasks with non-empty `depends_on`.
- Added `depends_on` to `TaskDraftSummary` interface.
- Added 3 new tests in `server/ingest.test.ts`: DT-* → ULID remapping, dependency event emission, no event for empty depends_on.
- All tests pass (18/18 in ingest suite), typecheck clean.
