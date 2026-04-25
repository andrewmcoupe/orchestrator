# Dependency Graph — Progress

## Phase 1: Server-side layout engine
- [x] Install elkjs
- [x] Layout computation module
- [x] Critical path computation
- [x] proj_graph_layout table
- [x] eventBus debounced hook
- [x] API endpoint

## Phase 2: React Flow graph view
- [x] Install @xyflow/react
- [x] DependencyGraph component
- [x] Custom TaskNode component
- [x] Edge styling (done dimming, critical path highlighting on edges)

## Phase 3: Interaction layer
- [x] Critical path highlighting (amber outline + glow on critical-path nodes, edges already styled)
- [x] Floating detail card (TaskDetailCard component with status pill, actions, view details link)
- [x] List/graph toggle overlay (status bar with toggle, status counts; graph replaces sidebar+detail; "View details" switches back to list)
- [ ] PRD filter dropdown
- [ ] Visual QA
