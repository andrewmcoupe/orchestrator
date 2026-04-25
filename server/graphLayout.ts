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

export interface GraphLayoutResult {
  nodes: GraphOutputNode[];
  edges: GraphOutputEdge[];
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
    return { nodes: [], edges: [] };
  }

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
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

  return { nodes, edges };
}
