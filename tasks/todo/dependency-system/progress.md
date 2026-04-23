# Dependency System Progress

## 2026-04-23 — Testing & Shared Types (PRD items: "Testing — Shared Types", "Shared Types — Events")

- Created `shared/eventSchemas.test.ts` with 10 tests covering `prd.ingested` (nullable path, required content), `task.dependency.set`, and `task.unblocked` schemas.
- Updated `PrdIngested` type: `path` is now `string | null`, added required `content: string`.
- Added `TaskDependencySet` and `TaskUnblocked` interfaces to `shared/events.ts`.
- Added corresponding Zod schemas to `shared/eventSchemas.ts` and registered them in the schema registry.
- Registered new event types in `PROJECTION_SUBSCRIPTIONS` (empty subscriptions for now).
- Fixed downstream type errors in `server/ingest.ts` and `server/projectionRunner.test.ts`.
- All tests pass, typecheck clean.
