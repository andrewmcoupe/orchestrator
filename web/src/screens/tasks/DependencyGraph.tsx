import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraphLayoutQuery } from "../../hooks/useQueries.js";
import type { GraphLayoutResponse } from "@shared/projections.js";
import type { TaskStatus } from "@shared/events.js";
import { TaskNode } from "./TaskNode.js";

const nodeTypes = { task: TaskNode };

const DONE_STATUSES: Set<TaskStatus> = new Set([
  "merged",
  "approved",
  "awaiting_merge",
  "archived",
]);

/** Convert server layout blob into React Flow nodes and edges. */
function toReactFlowElements(layout: GraphLayoutResponse) {
  const criticalSet = new Set<string>();
  const cp = layout.meta.critical_path;
  for (let i = 0; i < cp.length - 1; i++) {
    criticalSet.add(`${cp[i]}->${cp[i + 1]}`);
  }

  const nodes: Node[] = Object.entries(layout.nodes).map(([id, info]) => ({
    id,
    position: { x: info.x, y: info.y },
    data: {
      label: info.title,
      status: info.status,
      attempt_count: info.attempt_count,
      max_total_attempts: info.max_total_attempts,
    },
    style: { width: info.width, height: info.height },
    type: "task",
  }));

  const edges: Edge[] = layout.edges.map((e, i) => {
    const targetStatus = layout.nodes[e.target]?.status;
    const isDone = targetStatus != null && DONE_STATUSES.has(targetStatus);
    const isCritical = criticalSet.has(`${e.source}->${e.target}`);

    return {
      id: `e-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      style: {
        opacity: isDone ? 0.3 : 1,
        strokeDasharray: isDone ? "5 3" : undefined,
        stroke: isCritical ? "#f59e0b" : undefined,
        strokeWidth: isCritical ? 2.5 : 1,
      },
    };
  });

  return { nodes, edges };
}

function GraphInner() {
  const { data: layout, isLoading, error } = useGraphLayoutQuery();
  const { fitView } = useReactFlow();

  const elements = useMemo(
    () => (layout ? toReactFlowElements(layout) : { nodes: [], edges: [] }),
    [layout],
  );

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.15 }), 50);
  }, [fitView]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        Loading graph...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-status-danger text-sm">
        Failed to load graph layout.
      </div>
    );
  }

  if (Object.keys(layout?.nodes ?? {}).length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No tasks to display.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={elements.nodes}
      edges={elements.edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      className="bg-bg-primary"
    >
      <Controls />
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
    </ReactFlow>
  );
}

export function DependencyGraph() {
  return (
    <div className="flex-1 h-full" data-testid="dependency-graph">
      <ReactFlowProvider>
        <GraphInner />
      </ReactFlowProvider>
    </div>
  );
}
