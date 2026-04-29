# Warn End-Users When No AI Providers Are Available

## Overview

When a user has no AI providers configured (no API key in `.orchestrator/.env.local` and no CLI tool authenticated), the orchestrator currently lets them attempt task creation, which fails opaquely at execution time. This PRD adds login-status detection for CLI providers, surfaces actionable setup instructions on the `/providers` page, and shows a persistent global banner when zero providers are available so the user knows what to fix and where.

## Detect CLI login status during provider probing

Today, CLI providers (`claude-code`, `codex`, `gemini-cli`) only report whether their binary is installed; the projection's `auth_present` flag is always `false` for them. This task makes `auth_present` meaningful for CLI providers so the rest of the system can use a single uniform availability signal.

Requirements:

- Extend the CLI probe in `server/providers/probe.ts` to perform a second step after the existing `<binary> --version` check, when the binary is present.
- For `claude-code`: run `claude auth status --text` with a 3s timeout. Set `auth_present = true` iff exit code is 0.
- For `codex`: run `codex login status` with a 3s timeout. Set `auth_present = true` iff exit code is 0 AND stdout contains the literal substring `"Logged in"`.
- For `gemini-cli`: skip the login check (no programmatic command exists). Always set `auth_present = false`. The provider is still usable when `status === "healthy"`; downstream code must treat `gemini-cli` as "available" on healthy status alone.
- The login check must NOT change the `status` field. Status remains driven by `--version` (`healthy` / `degraded` / `down`). `auth_present` is independent.
- If the binary is missing (`status === "down"`), skip the login check entirely and set `auth_present = false`.
- Emit `auth_present` as part of the existing `provider.probed` event payload (extend the event payload schema in `shared/events/` if needed). The `provider_health` projection must persist this updated `auth_present` on each probe — currently `auth_present` is only derived at `provider.configured` time, so the projection's `read` handler for `provider.probed` events must be extended to update it.
- Update `deriveAuthPresent` in `server/projections/providerHealth.ts` so the `cli_login` branch no longer hardcodes `false` at configuration time — instead, leave the existing value untouched (i.e., on `provider.configured` events for CLI providers, default to current DB value or `false` if the row is new).
- Add unit tests covering: claude-code logged in, claude-code not logged in (non-zero exit), codex logged in, codex not logged in, codex stdout missing "Logged in" substring (treat as not logged in), gemini-cli always returns `auth_present: false`, binary missing → `auth_present: false`.

## Surface per-provider setup instructions on the providers page

Each provider on `/providers` must show a concrete, copyable instruction telling the user how to set it up. Currently the page shows status but no actionable next step.

Requirements:

- Add a `setup_hint` field to the static provider config in `server/providers/registry.ts`. Each entry contains a short imperative instruction string. Values:
  - `claude-code`: `"Run `claude login` in your terminal"`
  - `codex`: `"Run `codex login` in your terminal"`
  - `gemini-cli`: `"Run `gemini` in your terminal and follow the login prompt"`
  - `anthropic-api`: ``"Add `ANTHROPIC_API_KEY=...` to `.orchestrator/.env.local`"``
  - `openai-api`: ``"Add `OPENAI_API_KEY=...` to `.orchestrator/.env.local`"``
- Expose `setup_hint` via the existing `GET /api/providers` endpoint (or wherever the Providers page already fetches its list) so the UI does not hardcode the hints.
- In `web/src/screens/providers/Providers.tsx`, render `setup_hint` on every provider card, regardless of `auth_present` value, so users can self-serve at any time.
- When `auth_present === false` AND (for CLI providers) `status !== "healthy"`, render the hint with warning styling (use existing `bg-status-danger`/`border-status-danger` classes consistent with other warning treatments in the file).
- When the provider IS available, render the hint in muted/info styling (e.g., `text-fg-muted`).
- Render any backticked code spans (`` ` ``…`` ` ``) in the hint as monospace using the existing tailwind `font-mono` class so the commands are visually distinct.
- The setup instruction is a presentational string only; do not auto-execute commands or write to `.env.local` from the UI.
- Update `web/src/screens/providers/Providers.test.tsx` to assert each provider card renders its hint text.

## Add global "no providers available" banner

When zero providers are available across the whole system, show a persistent, non-dismissible banner across all routes that links to the providers page.

Requirements:

- Create a new component `web/src/components/NoProvidersBanner.tsx`.
- Compute the banner's visibility from `useProviderHealth()` in `web/src/store/eventStore.ts`. The banner is visible iff: **for every provider, `auth_present === false` AND `status !== "healthy"`**. Equivalently, hide the banner if any provider has `auth_present === true` OR `status === "healthy"`.
- While the event store is still hydrating (no provider rows yet), do NOT render the banner. Read the existing hydration flag in the store; if absent, treat an empty `providerHealth` map as "still loading" and render nothing.
- Banner copy: **"No AI providers available."** followed by **"Add an API key to `.orchestrator/.env.local` or sign in via a CLI tool (e.g. `claude login`) to start running tasks."**
- Banner includes a primary CTA button labelled **"Open provider settings"** that navigates to `/providers` using the existing TanStack Router `<Link>` / `useNavigate` API (see existing usage in `__root.tsx`).
- Banner is non-dismissible (no close button). It auto-disappears the moment any provider becomes available.
- Visual style: full-width, sits directly between `<TopBar>` and the main `<div className="flex flex-1 min-h-0">` row in `web/src/routes/__root.tsx`. Use warning/danger styling consistent with existing alerts in the codebase (`bg-status-danger`, `border-status-danger/20`, padded with `px-4 py-2`). Use a Lucide warning icon (`AlertTriangle`) on the left.
- The banner must NOT shift main content layout when toggling — it pushes content down naturally because it lives in the existing flex column.
- Add `web/src/components/NoProvidersBanner.test.tsx` covering: shows when all providers have `auth_present: false` and `status: "down"` or `"degraded"`; hides when one provider has `auth_present: true`; hides when one CLI provider has `status: "healthy"` even with `auth_present: false`; renders nothing during initial hydration (empty providerHealth map).

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/providers/probe.ts` | Add post-version login probe for `claude-code` (`claude auth status --text`) and `codex` (`codex login status`). Return `auth_present` in the probe result. |
| `server/providers/registry.ts` | Add `setup_hint` field to each provider config. |
| `server/projections/providerHealth.ts` | Persist `auth_present` from `provider.probed` events; stop overriding `auth_present` to `false` for CLI providers in `deriveAuthPresent`. |
| `shared/events/` (provider event types) | Extend `provider.probed` payload schema to include `auth_present: boolean`. |
| `server/routes/providers.ts` | Include `setup_hint` in the providers list response. |
| `web/src/screens/providers/Providers.tsx` | Render `setup_hint` on each provider card with conditional styling. |
| `web/src/screens/providers/Providers.test.tsx` | Assert hints render for every provider. |
| `web/src/components/NoProvidersBanner.tsx` | New component — global banner with CTA. |
| `web/src/components/NoProvidersBanner.test.tsx` | New test file for the banner visibility logic. |
| `web/src/routes/__root.tsx` | Mount `<NoProvidersBanner />` between `<TopBar>` and the main flex row. |
| `server/providers/probe.test.ts` (or equivalent) | Unit tests for the new login probe logic. |

## Out of Scope

- **Detecting `gemini-cli` login state.** The Gemini CLI provides no programmatic auth-status command; login is handled inside the interactive UI. We accept that a user with `gemini` installed but not logged in will still see the binary marked `healthy` and will only learn of the auth failure at task-run time.
- **Blocking task creation when no providers are available.** The banner warns; it does not prevent the user from creating tasks. Run-time failures continue to surface through the existing event/error system.
- **Editing `.env.local` from the UI.** The UI shows the env-var name to add; the user edits the file themselves. API keys remain read-only at boot.
- **Dismissibility / per-session hide.** The banner is intentionally persistent until resolved.
- **Health-failure warnings** (e.g., a configured provider that just started failing probes). This PRD only covers the zero-providers-available onboarding case.
- **Documentation links.** No external docs links are added to setup hints in v1; the inline command is sufficient.
- **Re-running probes on demand from the banner.** Probes continue on the existing 60s scheduler; no manual refresh button is added.
