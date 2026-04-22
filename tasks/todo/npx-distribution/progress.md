# npx-distribution Progress

## Status: In Progress

## Completed Requirements
- **Priority 1 — Backend — CLI Entry Point**: Created `server/cli.ts` with `parseArgs()` and `main()`. Parses `--port` (default 4321), `--help`, and `--version`. Dynamically imports the server bootstrap on run. Added `server/cli.test.ts` with 9 passing tests. Also fixed a missing `path` import in `server/merge.ts` that was breaking typecheck.

- **Priority 2 — Backend — Path Resolution**: Created `server/paths.ts` as a centralized path module with all paths resolving from `process.cwd()`. Refactored `db.ts`, `blobStore.ts`, `credentials.ts`, `worktree.ts`, `fsWatcher.ts`, `gates/registry.ts`, `phaseRunner.ts`, `routes/repo.ts`, and `routes/settings.ts` to import from `paths.ts` instead of using `import.meta.dirname`. Added `server/paths.test.ts` with 7 passing tests.

- **Priority 3 — Backend — Git Validation**: Added `isInsideGitRepo()` to `server/cli.ts` that walks up from `process.cwd()` checking for `.git`. Called in `main()` before server bootstrap — exits with code 1 and the required error message if no git repo is found. Added 3 tests to `server/cli.test.ts` (12 total now passing).

- **Priority 4 — Backend — Scaffolding**: Created `server/scaffold.ts` with `scaffold()`, `isAlreadyScaffolded()`, `ensureGitignoreEntry()`, and `printScaffoldSummary()`. On first run, creates `.orchestrator/` with `blobs/`, `worktrees/`, `config.yaml` (from `templates/config.yaml`), and `.env.local` (from `templates/.env.local`). Auto-appends `.orchestrator/` to `.gitignore`. Idempotent — skips if already scaffolded. Integrated into `cli.ts main()` after git validation. Created `templates/` directory with default config and env files. Added `server/scaffold.test.ts` with 15 passing tests.

- **Priority 5 — Backend — Prompt Seeding**: Created `server/seedPrompts.ts` with unified `seedPrompts(db)` that dynamically discovers all `prompts/*.md` files matching the `{phase}-v{N}.md` convention. Checks if any `prompt_version.created` events exist — if empty, reads each file, stores template content in blob store via `putBlob`, and emits `prompt_version.created` events via `appendAndProject`. Replaces individual `seedIngestPromptVersion` / `seedAuditorPromptVersion` calls in `app.ts` with a single `seedPrompts(db)` call. Added `server/seedPrompts.test.ts` with 11 passing tests.

- **Priority 6 — Backend — Static File Serving**: Created `server/staticFiles.ts` with `getStaticRoot()` and `addStaticMiddleware()`. Uses `@hono/node-server/serve-static` to serve pre-built frontend from `dist/web/`. Added after all API routes in `app.ts` so `/api/*` takes precedence. Includes SPA fallback that serves `index.html` for non-API, non-file routes (client-side routing). Added `server/staticFiles.test.ts` with 9 passing tests.

- **Priority 7 — Build — TypeScript Compilation**: Created `tsconfig.build.json` extending the base config with `module: "NodeNext"` targeting `server/` and `shared/` (excluding tests). Added `tsc-alias` to resolve `@shared/*` path aliases in compiled output. Updated `build` script to run `tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json && vite build`. Added `build:server` convenience script. Output: `dist/server/` and `dist/shared/` with valid ES modules, declarations, and source maps.

## In Progress
_None yet_

## Notes
_Add implementation notes here as work progresses_
