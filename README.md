# @andycoupe/orchestrator

An event-sourced task orchestrator for AI-assisted software development. Breaks PRDs into tasks, runs them through configurable phases (test-author, implementer, auditor), manages git worktrees, and merges the results — all from a local web UI.

## Quick start

```bash
npx @andycoupe/orchestrator
```

Run this from the root of any git repository. On first run it will:

1. Scaffold a `.orchestrator/` directory (auto-added to `.gitignore`)
2. Seed a default config and prompt library
3. Create a few demo tasks so you can explore the UI
4. Open your browser to `http://localhost:4321`

### CLI options

```
--port <number>  Port to listen on (default: 4321)
--no-open        Don't open browser on start
--verbose        Verbose logging output
--quiet          Minimal logging output (default)
--init           Scaffold .orchestrator/ without starting server
--help           Show help
--version        Show version
```

## Prerequisites

- Node.js 20+
- Git
- One of the following:
  - Logged into [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
  - Logged into [Codex CLI](https://github.com/openai/codex)
  - API keys set in `.orchestrator/.env.local`

## Configuration

After scaffolding, edit `.orchestrator/config.yaml` to configure:

- **Gates** — quality checks (typecheck, test, lint) that run before a task can be approved
- **Presets** — reusable task configurations (phases, models, retry policies)
- **Merge strategy** — squash, merge, or fast-forward only
- **Ingest settings** — model and transport for PRD ingestion

```yaml
gates:
  - name: typecheck
    command: pnpm typecheck
  - name: test
    command: pnpm test
  - name: lint
    command: pnpm lint
```

If using API keys directly instead of the CLI tools, set them in `.orchestrator/.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## Development

```bash
git clone https://github.com/andycoupe/orchestrator.git
cd orchestrator
pnpm install
pnpm dev
```

This starts:
- The Hono backend on `:3001`
- The Vite dev server on `:3000` (proxies API calls to the backend)

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start backend + frontend in dev mode |
| `pnpm build` | Build server (tsc) + frontend (vite) |
| `pnpm test` | Run all tests |
| `pnpm lint` | Lint with oxlint |
| `pnpm typecheck` | TypeScript type checking |

### Project structure

```
server/          Backend (Hono, SQLite, event store)
web/             Frontend (React, TanStack Router, Tailwind)
shared/          Types and projections shared between server and client
templates/       Default config files copied on first scaffold
prompts/         Bundled prompt templates for each phase
```

### Release flow

1. **Add a changeset** when your PR includes user-facing changes:

   ```bash
   pnpm changeset
   ```

   This prompts you to pick a semver bump (patch/minor/major) and write a summary. It creates a markdown file in `.changeset/` — commit it with your PR.

2. **Merge to main.** The release workflow runs automatically and creates a "Version Packages" PR that:
   - Bumps the version in `package.json`
   - Updates `CHANGELOG.md`
   - Consumes the changeset files

3. **Merge the Version Packages PR.** The workflow runs again and publishes to npm.

### CI

Every PR and push to `main` runs three parallel checks:

- **Lint** — `pnpm lint`
- **Test** — `pnpm test`
- **Build** — `pnpm build`

## License

MIT
