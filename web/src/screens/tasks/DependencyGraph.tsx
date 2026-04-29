import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  MarkerType,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGraphLayoutQuery } from "../../hooks/useQueries.js";
import type { GraphLayoutResponse } from "@shared/projections.js";
import type { TaskStatus } from "@shared/events.js";
import { TaskNode } from "./TaskNode.js";
import { TaskDetailCard, type TaskDetailCardData } from "./TaskDetailCard.js";

const nodeTypes = { task: TaskNode };

const DONE_STATUSES: Set<TaskStatus> = new Set([
  "merged",
  "approved",
  "awaiting_merge",
  "archived",
]);

/** Convert server layout blob into React Flow nodes and edges. */
function toReactFlowElements(layout: GraphLayoutResponse) {
  const criticalEdgeSet = new Set<string>();
  const criticalNodeSet = new Set(layout.meta.critical_path);
  const cp = layout.meta.critical_path;
  for (let i = 0; i < cp.length - 1; i++) {
    criticalEdgeSet.add(`${cp[i]}->${cp[i + 1]}`);
  }

  const nodes: Node[] = Object.entries(layout.nodes).map(([id, info]) => ({
    id,
    position: { x: info.x, y: info.y },
    data: {
      label: info.title,
      status: info.status,
      attempt_count: info.attempt_count,
      max_total_attempts: info.max_total_attempts,
      isCritical: criticalNodeSet.has(id),
    },
    style: { width: info.width, height: info.height },
    type: "task",
  }));

  const edges: Edge[] = layout.edges.map((e, i) => {
    const targetStatus = layout.nodes[e.target]?.status;
    const isDone = targetStatus != null && DONE_STATUSES.has(targetStatus);
    const _isCritical = criticalEdgeSet.has(`${e.source}->${e.target}`);

    return {
      id: `e-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: isDone ? "#666" : "#888",
      },
      style: {
        opacity: isDone ? 0.2 : 1,
        strokeDasharray: isDone ? "5 3" : undefined,
        stroke: isDone ? "#666" : "#888",
        strokeWidth: 1.5,
      },
    };
  });

  return { nodes, edges };
}

type DependencyGraphProps = {
  onViewDetails?: (taskId: string) => void;
  prdId?: string;
};

function GraphInner({ onViewDetails, prdId }: DependencyGraphProps) {
  const { data: layout, isLoading, error } = useGraphLayoutQuery(prdId);
  const { fitView } = useReactFlow();
  const [selectedCard, setSelectedCard] = useState<TaskDetailCardData | null>(
    null,
  );

  const elements = useMemo(
    () => (layout ? toReactFlowElements(layout) : { nodes: [], edges: [] }),
    [layout],
  );

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.15 }), 50);
  }, [fitView]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (event, node) => {
      const nodeInfo = layout?.nodes[node.id];
      if (!nodeInfo) return;

      // Position the card near the click, offset slightly so it doesn't cover the node
      const target = event.currentTarget as HTMLElement;
      const container = target.closest(
        '[data-testid="dependency-graph"]',
      ) as HTMLElement | null;
      const containerRect = container?.getBoundingClientRect() ?? {
        left: 0,
        top: 0,
      };

      setSelectedCard({
        taskId: node.id,
        title: nodeInfo.title,
        status: nodeInfo.status,
        attempt_count: nodeInfo.attempt_count,
        max_total_attempts: nodeInfo.max_total_attempts,
        screenX: (event as unknown as MouseEvent).clientX - containerRect.left + 8,
        screenY: (event as unknown as MouseEvent).clientY - containerRect.top + 8,
      });
    },
    [layout],
  );

  const handleDismiss = useCallback(() => setSelectedCard(null), []);

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
    <>
      <ReactFlow
        nodes={elements.nodes}
        edges={elements.edges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        onNodeClick={onNodeClick}
        onPaneClick={handleDismiss}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-bg-primary"
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
      {selectedCard && (
        <TaskDetailCard
          data={selectedCard}
          onDismiss={handleDismiss}
          onViewDetails={onViewDetails}
        />
      )}
    </>
  );
}

export function DependencyGraph({ onViewDetails, prdId }: DependencyGraphProps) {
  return (
    <div className="flex-1 h-full relative" data-testid="dependency-graph">
      <ReactFlowProvider>
        <GraphInner onViewDetails={onViewDetails} prdId={prdId} />
      </ReactFlowProvider>
    </div>
  );
}
