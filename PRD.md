# Migrate UI to TanStack Router with File-Based Routing

## Overview

Replace the custom hash-based routing system with TanStack Router using the Vite plugin for file-based route generation. This migrates all navigation from `window.location.hash` assignments to TanStack Router primitives (`<Link>`, `useNavigate`, `useParams`), converts full-screen overlays (ingest, config, review) to route-based dialogs, and removes the legacy routing hooks.

## Install TanStack Router and configure Vite plugin

- Install `@tanstack/react-router` and `@tanstack/router-plugin` as dependencies in `web/`.
- Update `web/vite.config.ts` to add the `tanstackRouter` plugin before `@vitejs/plugin-react` with `target: "react"` and `autoCodeSplitting: true`.
- Configure `routesDirectory` to `./src/routes` and `generatedRouteTree` to `./src/routeTree.gen.ts`.
- Add `routeTree.gen.ts` to `.gitignore`, `.prettierignore`, and ESLint ignore patterns.
- Add VSCode settings to mark `routeTree.gen.ts` as readonly and exclude it from search and file watcher.

## Create root layout route

- Create `web/src/routes/__root.tsx` as the root layout route.
- Render the shared shell: `TopBar`, `Rail`, `EventStreamStrip`, and an `<Outlet />` for child content.
- Move the `QueryClientProvider`, `ThemeProvider`, and any other top-level providers from `App.tsx` into the root layout or the router context.
- The root layout must always render the rail, topbar, and event stream strip — overlays are now dialogs on top, not layout replacements.

## Create the router instance and update App.tsx

- Create a `web/src/router.tsx` file that instantiates the TanStack Router with the generated route tree.
- Update `web/src/App.tsx` to render `<RouterProvider router={router} />` instead of the current section-based conditional rendering.
- Remove all overlay state management (`isIngest`, `configTaskId`, `reviewRoute`) and their associated `useState`/`useEffect` hooks from `App.tsx`.
- Remove the `hashchange` event listener logic.

## Create file-based route files for each section

- Create `web/src/routes/index.tsx` that redirects to `/tasks` using TanStack Router's `redirect` or `Navigate` component.
- Create `web/src/routes/tasks.tsx` as a layout route for the tasks section, rendering the `TaskListSidebar` and an `<Outlet />` for the detail pane.
- Create `web/src/routes/tasks/index.tsx` for `/tasks` with no task selected (empty detail pane or placeholder).
- Create `web/src/routes/tasks/$taskId.tsx` for `/tasks/:taskId` that reads `taskId` from `useParams` and renders `TaskDetailPane`.
- Create `web/src/routes/tasks/$taskId/config.tsx` for `/tasks/:taskId/config` that renders the `TaskConfig` component inside a large viewport-filling dialog. Closing the dialog navigates back to `/tasks/:taskId`.
- Create `web/src/routes/tasks/$taskId/review/$attemptId.tsx` for `/tasks/:taskId/review/:attemptId` that renders the `Review` component inside a large viewport-filling dialog. Closing the dialog navigates back to `/tasks/:taskId`.
- Create `web/src/routes/ingest.tsx` for `/ingest` that renders the `Ingest` component inside a large viewport-filling dialog. Closing the dialog navigates to `/tasks`.
- Create `web/src/routes/prompts.tsx` for `/prompts` rendering the `Prompts` screen.
- Create `web/src/routes/providers.tsx` for `/providers` rendering the `Providers` screen. Accept an optional `focus` search param for provider focus (e.g., `/providers?focus=claude-code`).
- Create `web/src/routes/measurement.tsx` for `/measurement` rendering the `Measurement` screen.
- Create `web/src/routes/settings.tsx` for `/settings` rendering the `Settings` screen.
- Create `web/src/routes/guide.tsx` for `/guide` rendering the `Guide` screen.

## Convert overlays to route-based dialogs

- Replace the full-screen overlay pattern for ingest, config, and review with large viewport-filling dialog modals.
- Each dialog route renders the existing screen component inside a `Dialog` component that covers a large proportion of the viewport.
- The dialog backdrop shows the parent route content beneath (rail, topbar, strip remain visible).
- Closing the dialog (escape key, backdrop click, or close/back button) uses TanStack Router's `useNavigate` to navigate to the parent route.
- The ingest dialog navigates back to `/tasks` on close.
- The config dialog navigates back to `/tasks/$taskId` on close.
- The review dialog navigates back to `/tasks/$taskId` on close.

## Replace all navigation with TanStack Router primitives

- Replace all `window.location.hash = "#/..."` assignments throughout the codebase with `<Link>` components or `useNavigate()` calls.
- Prefer `<Link>` for clickable navigation elements (buttons, list items, icons).
- Use `useNavigate()` only for programmatic navigation (e.g., after an action completes).
- Remove navigation callback props (`onIngest`, `onEditConfig`, `onReview`, `onBack`, `onMergeIconClick`) from all components. Each component navigates directly using TanStack Router hooks.
- Update `web/src/components/Rail.tsx` to use `<Link>` for each section with TanStack Router's active link styling instead of manual `section === "tasks"` comparisons.
- Update `web/src/components/TopBar.tsx` to use `<Link to="/guide">` for the help icon and `<Link to="/providers" search={{ focus: providerId }}>` for provider pill clicks.
- Update `web/src/screens/tasks/TaskListSidebar.tsx` to use `<Link to="/tasks/$taskId" params={{ taskId }}>` for task selection and `<Link to="/ingest">` for the ingest button.
- Update `web/src/screens/tasks/TaskDetailPane.tsx` to use `<Link>` for the config and review navigation buttons.

## Convert provider focus to a search param

- The `Providers` screen currently receives `focusedProvider` as React state passed from `App.tsx`.
- Define a `focus` search param on the `/providers` route using TanStack Router's search param validation.
- Read the focused provider from `useSearch()` instead of props.
- Provider pill clicks in `TopBar` navigate to `/providers?focus=<providerId>`.
- Remove the `focusedProvider` state and `setFocusedProvider` from `App.tsx`.

## Update keyboard shortcuts

- The current `useHotkeys` for `⌘1` through `⌘5` calls `navigate(section)` from `useSection`.
- Update the hotkey handlers to use TanStack Router's `useNavigate()` with the corresponding paths: `/tasks`, `/prompts`, `/providers`, `/measurement`, `/settings`.
- Move the hotkey registration into the root layout route or keep it in a shared hook that uses `useNavigate`.

## Delete legacy routing code

- Delete `web/src/hooks/useSection.ts`.
- Delete `web/src/hooks/useSelectedTaskId.ts`.
- Remove the `Section` type and `SCREENS` map from `App.tsx`.
- Remove the `parseConfigTaskId`, `parseReviewRoute`, and related regex parsing functions from `App.tsx`.
- Remove the `navigateFromIngest`, `navigateFromConfig`, `navigateFromReview` callback functions from `App.tsx`.
- Remove all `onBack` props from `Ingest`, `TaskConfig`, and `Review` screen components — they navigate directly now.

## Update SSE event stream filtering

- The `EventStreamStrip` currently receives a `correlationId` derived from the selected task ID (via `useSelectedTaskId`).
- Update it to read the task ID from TanStack Router's route params using `useParams` or `useMatch` for the tasks routes.
- If the current route is not a task route, pass no correlation filter.

## Implementation Touchpoints

| File | Change |
|---|---|
| `web/package.json` | Add `@tanstack/react-router` and `@tanstack/router-plugin` |
| `web/vite.config.ts` | Add `tanstackRouter` plugin before React plugin |
| `web/src/routes/__root.tsx` | New — root layout with TopBar, Rail, EventStreamStrip, Outlet |
| `web/src/routes/index.tsx` | New — redirect to `/tasks` |
| `web/src/routes/tasks.tsx` | New — tasks layout with TaskListSidebar and Outlet |
| `web/src/routes/tasks/index.tsx` | New — empty task selection state |
| `web/src/routes/tasks/$taskId.tsx` | New — task detail pane via useParams |
| `web/src/routes/tasks/$taskId/config.tsx` | New — TaskConfig in viewport-filling dialog |
| `web/src/routes/tasks/$taskId/review/$attemptId.tsx` | New — Review in viewport-filling dialog |
| `web/src/routes/ingest.tsx` | New — Ingest in viewport-filling dialog |
| `web/src/routes/prompts.tsx` | New — Prompts screen |
| `web/src/routes/providers.tsx` | New — Providers screen with `focus` search param |
| `web/src/routes/measurement.tsx` | New — Measurement screen |
| `web/src/routes/settings.tsx` | New — Settings screen |
| `web/src/routes/guide.tsx` | New — Guide screen |
| `web/src/router.tsx` | New — router instance creation |
| `web/src/App.tsx` | Replace conditional rendering with RouterProvider, remove overlay state and legacy routing |
| `web/src/components/Rail.tsx` | Replace `navigate(section)` with `<Link>` components, use active link styling |
| `web/src/components/TopBar.tsx` | Replace hash navigation with `<Link>`, provider pills use search params |
| `web/src/screens/tasks/Tasks.tsx` | Remove navigation callback props |
| `web/src/screens/tasks/TaskListSidebar.tsx` | Replace hash navigation with `<Link>` components |
| `web/src/screens/tasks/TaskDetailPane.tsx` | Replace callback props with `<Link>` for config/review |
| `web/src/screens/ingest/Ingest.tsx` | Remove `onBack` prop, use `useNavigate` for close, wrap in dialog |
| `web/src/screens/config/TaskConfig.tsx` | Remove `onBack` prop, use `useNavigate` for close, wrap in dialog |
| `web/src/screens/review/Review.tsx` | Remove `onBack` prop, use `useNavigate` for close, wrap in dialog |
| `web/src/components/EventStreamStrip.tsx` | Read correlation ID from router params instead of props |
| `web/src/hooks/useSection.ts` | Delete |
| `web/src/hooks/useSelectedTaskId.ts` | Delete |

## Out of Scope

- Server-side rendering or SSR integration.
- Loader-based data fetching — keep existing TanStack Query hooks for data fetching.
- Route-level error boundaries beyond the default TanStack Router behaviour.
- Animated route transitions.
- Nested layouts beyond the tasks section.
- Migrating from TanStack Query to TanStack Router loaders.
