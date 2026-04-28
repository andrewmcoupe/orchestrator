# Guide Page — Application Documentation & Best Practices

## Overview

Add a comprehensive documentation page to Orchestrator that serves as both an onboarding overview for new users and a reference guide for experienced users. The page covers how the system works end-to-end, defines all key domain concepts, documents the task lifecycle, and provides actionable best practices for writing PRDs, configuring tasks, and reviewing code.

## Navigation & Routing

### Add help icon to TopBar

- Add a help/book icon (e.g., `BookOpen` from lucide-react) to the `TopBar` component.
- Clicking the icon navigates to `#/guide`.
- The guide page renders as a standard routed page with the rail and event stream strip still visible.
- Active state styling on the icon when on the guide route.

### Register route

- Add `guide` as a recognized section in the hash-based router.
- Render the `Guide` screen component when the section is `guide`.

## Page Layout

### Single scrollable page with sticky TOC sidebar

- Left column: sticky table of contents listing all section headings with anchor links for in-page navigation.
- Right column: scrollable content area containing all sections in order.
- TOC highlights the currently visible section as the user scrolls.
- Responsive: TOC collapses or hides on smaller viewports.

## Sections

### 1. How It Works

- High-level overview of the Orchestrator flow from PRD to merged code.
- Static CSS flow diagram (styled HTML boxes and arrows) showing the pipeline:
  `PRD -> Propositions -> Tasks -> Phases -> Review -> Merge`
- Brief text explanation beneath each step in the diagram describing what happens at that stage.
- No interactive components — keep it simple and visual.

### 2. Glossary

- Alphabetically ordered list of all key domain terms.
- Each entry: term name (bold) + short paragraph (definition + one or two sentences of context explaining why it matters or how it relates to other concepts).
- Terms to include:
  - **A/B Experiment**: Test different prompt versions against task execution metrics to compare cost, success rate, and quality.
  - **Attempt**: A single execution run of a task. Each task can have multiple attempts with retry logic. Tracks phase summaries, gate results, audit verdict, files changed, cost, and outcome.
  - **Context Policy**: Configuration controlling what code context is provided to the LLM during a phase — symbol graph depth, token budget, whether to include tests.
  - **Event**: An immutable fact recorded in the event store. All state changes in Orchestrator are captured as events, enabling full audit trails and reproducible projections.
  - **Event Store**: The append-only SQLite log of all events. The single source of truth from which all projections are derived.
  - **Gate**: A validation rule run before or after a phase. Can be built-in (from config.yaml) or library-based (custom definitions). Gates enforce quality and correctness checks.
  - **Phase**: A stage in the task execution pipeline. Default phases are test-author (generate tests), implementer (generate code), and auditor (review quality). Each phase has its own transport, model, and context policy.
  - **Preset**: A reusable task configuration template bundling phase configs, gate definitions, retry policies, and auto-merge settings.
  - **Projection**: A derived read-model computed by replaying events from the event store. Projections provide the current state views displayed in the UI (task lists, provider health, cost dashboards).
  - **Proposition**: An atomic requirement extracted from a PRD during ingestion. Each proposition has a confidence score and source location reference back to the original document.
  - **Provider**: An external LLM or code tool integration (Claude Code, Codex, OpenAI API, Gemini CLI). Providers are monitored for health and latency.
  - **PRD (Product Requirements Document)**: The input document describing desired code changes. Ingested by Orchestrator to extract propositions and generate tasks.
  - **Pushback**: An objection raised during PRD ingestion. Can be blocking (must resolve before proceeding), advisory (warning), or a question (needs clarification). Pushbacks must be resolved before tasks are created.
  - **Task**: An executable unit of work created from one or more propositions. Tasks flow through a defined lifecycle and are executed by AI agents through configured phases.
  - **Transport**: The specific CLI tool or API used to execute a phase (claude-code, codex, anthropic-api, aider, gemini-cli).

### 3. Best Practices: Writing PRDs

- Presented as Do/Don't lists.
- Do:
  - Use the grill-me skill (or similar structured interview process) before writing a PRD. Walking through the full design decision tree results in comprehensive, well-considered requirements.
  - Break requirements into small, atomic statements — each should describe one change.
  - Include acceptance criteria for each requirement.
  - Reference specific files or modules when the change location is known.
  - Specify what is out of scope to prevent over-engineering.
  - Include context about why a change is needed, not just what.
- Don't:
  - Write vague, high-level requirements that leave too much to interpretation.
  - Bundle unrelated changes into a single PRD.
  - Assume the LLM knows your project conventions — state them explicitly.
  - Skip edge cases or error handling requirements.
  - Write PRDs longer than necessary — conciseness improves extraction quality.

### 4. Best Practices: Task Configuration

- Presented as Do/Don't lists.
- Do:
  - Start with a preset that matches your use case and customise from there.
  - Enable the auditor phase for critical or complex changes.
  - Configure context policies to include only relevant code — smaller context windows improve output quality and reduce cost.
  - Set appropriate retry limits — 2-3 retries is usually sufficient.
  - Use gates to enforce project-specific quality checks (linting, type checking, test passes).
  - Review the dependency graph before running tasks to ensure correct execution order.
- Don't:
  - Enable all phases for trivial changes — the implementer phase alone is often enough.
  - Set token budgets too high — more context does not always mean better results.
  - Skip gate configuration — ungated tasks may produce code that doesn't meet project standards.
  - Use auto-merge without an auditor phase enabled.
  - Ignore cost projections — check the measurement dashboard to understand spend patterns.

### 5. Best Practices: Review & Merge

- Presented as Do/Don't lists.
- Do:
  - Review the full diff carefully, including test files.
  - Check that the implementation matches the original proposition intent.
  - Use reject to send the task back for a fresh attempt when the approach is fundamentally wrong.
  - Use revise when the implementation is close but needs specific adjustments.
  - Add clear feedback when rejecting or requesting revisions — this feeds back into the next attempt.
  - Verify gate results passed before approving.
- Don't:
  - Auto-approve without reviewing diffs.
  - Reject without providing actionable feedback.
  - Merge tasks with failing gates unless you have a specific reason.
  - Approve changes that introduce technical debt just to close the task.
  - Skip reviewing test coverage for new functionality.

### 6. Task Lifecycle Reference

#### Flow diagram

- Static CSS flow diagram showing all task statuses and transitions:
  ```
  draft -> queued -> running -> paused / revising
                                    |
                              awaiting_review
                              /            \
                        approved          rejected
                        /                     \
                  awaiting_merge          (back to queued)
                  /          \
              merged      escalated
                            |
                        archived / blocked
  ```

#### Status descriptions

- Text list beneath the diagram with each status defined:
  - **draft**: Task created but not yet queued for execution.
  - **queued**: Task is waiting to be picked up by the execution pipeline.
  - **running**: Task is actively being executed through its configured phases.
  - **paused**: Execution has been manually paused by the user.
  - **revising**: Task is being re-executed with revision feedback from a previous review.
  - **awaiting_review**: All phases complete — task is ready for human review.
  - **approved**: Reviewer has approved the changes.
  - **rejected**: Reviewer has rejected the changes — task returns to queue for a new attempt.
  - **awaiting_merge**: Approved changes are ready to be merged into the target branch.
  - **merged**: Changes have been successfully merged.
  - **escalated**: Task has exceeded retry limits or encountered unresolvable issues — requires manual intervention.
  - **archived**: Task has been archived and is no longer active.
  - **blocked**: Task cannot proceed due to unmet dependencies.

## Implementation Touchpoints

| File | Change |
|---|---|
| `web/src/components/TopBar.tsx` | Add help/book icon with navigation to `#/guide` |
| `web/src/hooks/useSection.ts` | Add `guide` to recognized sections |
| `web/src/App.tsx` | Add route case for `guide` section rendering `Guide` component |
| `web/src/screens/guide/Guide.tsx` | New — main guide page with TOC sidebar and all content sections |
| `web/src/screens/guide/TableOfContents.tsx` | New — sticky TOC component with scroll-aware active highlighting |
| `web/src/screens/guide/FlowDiagram.tsx` | New — reusable static CSS flow diagram component (used for How It Works and Task Lifecycle) |

## Out of Scope

- Keyboard shortcuts reference.
- Video tutorials or animated walkthroughs.
- In-app contextual tooltips or guided tours.
- Search functionality within the guide.
- Versioned documentation tied to application releases.
