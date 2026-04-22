# npx-distribution Progress

## Status: In Progress

## Completed Requirements
- **Priority 1 — Backend — CLI Entry Point**: Created `server/cli.ts` with `parseArgs()` and `main()`. Parses `--port` (default 4321), `--help`, and `--version`. Dynamically imports the server bootstrap on run. Added `server/cli.test.ts` with 9 passing tests. Also fixed a missing `path` import in `server/merge.ts` that was breaking typecheck.

- **Priority 2 — Backend — Path Resolution**: Created `server/paths.ts` as a centralized path module with all paths resolving from `process.cwd()`. Refactored `db.ts`, `blobStore.ts`, `credentials.ts`, `worktree.ts`, `fsWatcher.ts`, `gates/registry.ts`, `phaseRunner.ts`, `routes/repo.ts`, and `routes/settings.ts` to import from `paths.ts` instead of using `import.meta.dirname`. Added `server/paths.test.ts` with 7 passing tests.

- **Priority 3 — Backend — Git Validation**: Added `isInsideGitRepo()` to `server/cli.ts` that walks up from `process.cwd()` checking for `.git`. Called in `main()` before server bootstrap — exits with code 1 and the required error message if no git repo is found. Added 3 tests to `server/cli.test.ts` (12 total now passing).

## In Progress
_None yet_

## Notes
_Add implementation notes here as work progresses_
