# Dependency Graph Visualization — Phases

## Phase 1: Server-side layout engine
PRD items: priority 1–5

Install elkjs. Build the layout computation module (ELK layered, top-to-bottom).
Compute critical path. Store as single-row JSON blob in proj_graph_layout.
Wire up eventBus post-transaction hook with 200ms debounce.
Expose GET /api/projections/graph_layout endpoint.

**Done when:** endpoint returns valid layout JSON with node positions and critical path for a set of tasks with dependencies.

## Phase 2: React Flow graph view
PRD items: priority 6–9

Install @xyflow/react. Build DependencyGraph component consuming server layout.
Custom TaskNode component: fixed-width, truncated title, status colour border, attempt badge.
Edge styling: solid for active, faint dashed for done. Done nodes at 30% opacity.

**Done when:** graph renders correctly from server data with proper colour-coding and dimming.

## Phase 3: Interaction layer
PRD items: priority 10–14

Critical path highlighting from server blob.
Condensed floating detail card on node click with action buttons.
List/graph toggle as full-width overlay with minimal status bar.
PRD filter dropdown.
Manual visual QA.

**Done when:** full interactive graph with toggle, filtering, selection, and critical path highlighting.
