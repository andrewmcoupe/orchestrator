import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { TaskStatus } from "@shared/events.js";

type TaskNodeData = {
  label: string;
  status: TaskStatus;
  attempt_count: number;
  max_total_attempts: number;
  isCritical: boolean;
};

type TaskNodeType = Node<TaskNodeData, "task">;

const DONE_STATUSES: Set<TaskStatus> = new Set(["merged", "archived"]);

/** Actionable-centric status → left border colour */
function borderColor(status: TaskStatus): string {
  switch (status) {
    case "draft":
    case "queued":
      return "#16a34a"; // green — ready
    case "running":
    case "revising":
    case "paused":
      return "#ca8a04"; // yellow — in-flight
    case "rejected":
      return "#dc2626"; // red — failed
    case "merged":
    case "approved":
    case "awaiting_review":
    case "awaiting_merge":
      return "#3b82f6"; // blue — done
    case "blocked":
    case "archived":
      return "#a8a29e"; // grey
    default:
      return "#a8a29e";
  }
}

export const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskNodeType>) {
  const isDone = DONE_STATUSES.has(data.status);

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div
        className="bg-bg-secondary rounded text-xs px-2.5 py-2 w-[200px]"
        style={{
          borderLeft: `3px solid ${borderColor(data.status)}`,
          opacity: isDone ? 0.3 : 1,
          boxShadow: data.isCritical && !isDone ? "0 0 8px 1px rgba(245, 158, 11, 0.5)" : undefined,
          outline: data.isCritical && !isDone ? "1.5px solid #f59e0b" : undefined,
        }}
      >
        <div className="line-clamp-2 text-text-primary leading-tight font-medium">
          {data.label}
        </div>
        <div className="flex items-center justify-between mt-1.5 text-text-tertiary text-[10px]">
          <span className="capitalize">{data.status.replace(/_/g, " ")}</span>
          <span className="bg-bg-tertiary rounded px-1 py-0.5 font-mono tabular-nums">
            {data.attempt_count}/{data.max_total_attempts}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
    </>
  );
});
