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
