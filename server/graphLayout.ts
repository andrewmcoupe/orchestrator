/**
 * Graph layout computation using ELK's layered algorithm.
 *
 * Accepts a task dependency graph (nodes + edges) and returns
 * positioned nodes and routed edges for the frontend to render.
 */

import ELK, { type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";

// ============================================================================
// Types
// ============================================================================

export interface GraphInputNode {
  id: string;
  width: number;
  height: number;
}

export interface GraphInputEdge {
  source: string;
  target: string;
}

export interface GraphInput {
  nodes: GraphInputNode[];
  edges: GraphInputEdge[];
}

export interface GraphOutputNode {
  id: string;
  x: number;
  y: number;
}

export interface EdgeSection {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
}

export interface GraphOutputEdge {
  source: string;
  target: string;
  sections?: EdgeSection[];
}

export interface GraphLayoutMeta {
  critical_path: string[];
}

export interface GraphLayoutResult {
  nodes: GraphOutputNode[];
  edges: GraphOutputEdge[];
  meta: GraphLayoutMeta;
}

// ============================================================================
// Critical path computation
// ============================================================================

/**
 * Compute the critical path (longest chain by node count) through a DAG.
 * Handles disconnected subgraphs — returns the longest path across all of them.
 */
export function computeCriticalPath(
  nodeIds: string[],
  edges: GraphInputEdge[],
): string[] {
  if (nodeIds.length === 0) return [];

  // Build adjacency list and in-degree map
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  // Topological sort (Kahn's algorithm) + longest path via DP
  const dist = new Map<string, number>(); // longest path length ending at node
  const prev = new Map<string, string | null>(); // predecessor on longest path
  const queue: string[] = [];

  for (const id of nodeIds) {
    dist.set(id, 1);
    prev.set(id, null);
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }

  let i = 0;
  while (i < queue.length) {
    const u = queue[i++];
    for (const v of adj.get(u) ?? []) {
      const newDist = (dist.get(u) ?? 1) + 1;
      if (newDist > (dist.get(v) ?? 1)) {
        dist.set(v, newDist);
        prev.set(v, u);
      }
      inDegree.set(v, (inDegree.get(v) ?? 1) - 1);
      if (inDegree.get(v) === 0) {
        queue.push(v);
      }
    }
  }

  // Find the node with the maximum distance
  let maxNode = nodeIds[0];
  let maxDist = 0;
  for (const id of nodeIds) {
    const d = dist.get(id) ?? 0;
    if (d > maxDist) {
      maxDist = d;
      maxNode = id;
    }
  }

  // Trace back the path
  const path: string[] = [];
  let cur: string | null = maxNode;
  while (cur !== null) {
    path.push(cur);
    cur = prev.get(cur) ?? null;
  }
  path.reverse();
  return path;
}

// ============================================================================
// Layout computation
// ============================================================================

const elk = new ELK();

/**
 * Compute graph layout using ELK layered algorithm with top-to-bottom direction.
 *
 * Accepts { nodes: {id, width, height}[], edges: {source, target}[] }
 * Returns { nodes: {id, x, y}[], edges: {source, target, sections}[] }
 */
export async function computeGraphLayout(
  input: GraphInput,
): Promise<GraphLayoutResult> {
  if (input.nodes.length === 0) {
    return { nodes: [], edges: [], meta: { critical_path: [] } };
  }

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.alignment": "CENTER",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
    },
    children: input.nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
    })),
    edges: input.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const result = await elk.layout(graph);

  const nodes: GraphOutputNode[] = (result.children ?? []).map((child) => ({
    id: child.id,
    x: child.x ?? 0,
    y: child.y ?? 0,
  }));

  const edges: GraphOutputEdge[] = (
    (result.edges ?? []) as ElkExtendedEdge[]
  ).map((edge) => ({
    source: edge.sources[0],
    target: edge.targets[0],
    sections: edge.sections?.map((s) => ({
      startPoint: s.startPoint,
      endPoint: s.endPoint,
      bendPoints: s.bendPoints,
    })),
  }));

  const critical_path = computeCriticalPath(
    input.nodes.map((n) => n.id),
    input.edges,
  );

  return { nodes, edges, meta: { critical_path } };
}
