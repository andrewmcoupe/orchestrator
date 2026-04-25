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
import { TaskNode } from "./TaskNode.js";

const nodeTypes = { task: TaskNode };

/** Convert server layout blob into React Flow nodes and edges. */
function toReactFlowElements(layout: GraphLayoutResponse) {
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

  const edges: Edge[] = layout.edges.map((e, i) => ({
    id: `e-${e.source}-${e.target}-${i}`,
    source: e.source,
    target: e.target,
  }));

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
