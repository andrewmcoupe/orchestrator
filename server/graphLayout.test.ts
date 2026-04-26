import { describe, it, expect } from "vitest";
import {
  computeGraphLayout,
  computeCriticalPath,
  type GraphInput,
  type GraphInputEdge,
} from "./graphLayout.js";

describe("computeGraphLayout", () => {
  it("returns empty layout for empty input", async () => {
    const result = await computeGraphLayout({ nodes: [], edges: [] });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("returns positions for a single node", async () => {
    const input: GraphInput = {
      nodes: [{ id: "a", width: 200, height: 72 }],
      edges: [],
    };
    const result = await computeGraphLayout(input);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("a");
    expect(typeof result.nodes[0].x).toBe("number");
    expect(typeof result.nodes[0].y).toBe("number");
  });

  it("lays out a linear chain top-to-bottom", async () => {
    const input: GraphInput = {
      nodes: [
        { id: "a", width: 200, height: 72 },
        { id: "b", width: 200, height: 72 },
        { id: "c", width: 200, height: 72 },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    };
    const result = await computeGraphLayout(input);
    const posMap = Object.fromEntries(result.nodes.map((n) => [n.id, n]));

    // In top-to-bottom layout, a.y < b.y < c.y
    expect(posMap.a.y).toBeLessThan(posMap.b.y);
    expect(posMap.b.y).toBeLessThan(posMap.c.y);
  });

  it("lays out a diamond pattern without overlapping nodes", async () => {
    const input: GraphInput = {
      nodes: [
        { id: "a", width: 200, height: 72 },
        { id: "b", width: 200, height: 72 },
        { id: "c", width: 200, height: 72 },
        { id: "d", width: 200, height: 72 },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
        { source: "c", target: "d" },
      ],
    };
    const result = await computeGraphLayout(input);
    const posMap = Object.fromEntries(result.nodes.map((n) => [n.id, n]));

    // a is above b and c, which are above d
    expect(posMap.a.y).toBeLessThan(posMap.b.y);
    expect(posMap.a.y).toBeLessThan(posMap.c.y);
    expect(posMap.b.y).toBeLessThan(posMap.d.y);
    expect(posMap.c.y).toBeLessThan(posMap.d.y);

    // b and c should not overlap (same layer, different x)
    const bRect = { x: posMap.b.x, y: posMap.b.y, w: 200, h: 72 };
    const cRect = { x: posMap.c.x, y: posMap.c.y, w: 200, h: 72 };
    const overlapsX = bRect.x < cRect.x + cRect.w && bRect.x + bRect.w > cRect.x;
    const overlapsY = bRect.y < cRect.y + cRect.h && bRect.y + bRect.h > cRect.y;
    expect(overlapsX && overlapsY).toBe(false);
  });

  it("returns edge sections from ELK", async () => {
    const input: GraphInput = {
      nodes: [
        { id: "a", width: 200, height: 72 },
        { id: "b", width: 200, height: 72 },
      ],
      edges: [{ source: "a", target: "b" }],
    };
    const result = await computeGraphLayout(input);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe("a");
    expect(result.edges[0].target).toBe("b");
    expect(result.edges[0].sections).toBeDefined();
    expect(result.edges[0].sections!.length).toBeGreaterThan(0);
  });

  it("handles disconnected subgraphs", async () => {
    const input: GraphInput = {
      nodes: [
        { id: "a", width: 200, height: 72 },
        { id: "b", width: 200, height: 72 },
        { id: "x", width: 200, height: 72 },
        { id: "y", width: 200, height: 72 },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "x", target: "y" },
      ],
    };
    const result = await computeGraphLayout(input);
    expect(result.nodes).toHaveLength(4);

    // No overlaps between any nodes
    for (let i = 0; i < result.nodes.length; i++) {
      for (let j = i + 1; j < result.nodes.length; j++) {
        const a = result.nodes[i];
        const b = result.nodes[j];
        const overlapsX = a.x < b.x + 200 && a.x + 200 > b.x;
        const overlapsY = a.y < b.y + 72 && a.y + 72 > b.y;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it("uses default node dimensions (200x72)", async () => {
    const input: GraphInput = {
      nodes: [{ id: "a", width: 200, height: 72 }],
      edges: [],
    };
    const result = await computeGraphLayout(input);
    // Verify the function accepted 200x72 without error
    expect(result.nodes).toHaveLength(1);
  });

  it("includes critical path in layout result", async () => {
    const input: GraphInput = {
      nodes: [
        { id: "a", width: 200, height: 72 },
        { id: "b", width: 200, height: 72 },
        { id: "c", width: 200, height: 72 },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    };
    const result = await computeGraphLayout(input);
    expect(result.meta.critical_path).toEqual(["a", "b", "c"]);
  });
});

describe("computeCriticalPath", () => {
  it("returns empty array for no nodes", () => {
    expect(computeCriticalPath([], [])).toEqual([]);
  });

  it("returns single node when there are no edges", () => {
    const result = computeCriticalPath(["a"], []);
    expect(result).toEqual(["a"]);
  });

  it("returns the full chain for a linear graph", () => {
    const edges: GraphInputEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    expect(computeCriticalPath(["a", "b", "c"], edges)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("picks the longest branch in a diamond", () => {
    // a -> b -> d -> e
    // a -> c -> d -> e
    // longest is 4 nodes: a -> b -> d -> e (or a -> c -> d -> e)
    const edges: GraphInputEdge[] = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
      { source: "d", target: "e" },
    ];
    const result = computeCriticalPath(["a", "b", "c", "d", "e"], edges);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("a");
    expect(result[result.length - 1]).toBe("e");
    // Middle should be either b or c, then d
    expect(result[2]).toBe("d");
  });

  it("handles disconnected subgraphs — picks longest across all", () => {
    // Subgraph 1: a -> b (length 2)
    // Subgraph 2: x -> y -> z (length 3)
    const edges: GraphInputEdge[] = [
      { source: "a", target: "b" },
      { source: "x", target: "y" },
      { source: "y", target: "z" },
    ];
    const result = computeCriticalPath(
      ["a", "b", "x", "y", "z"],
      edges,
    );
    expect(result).toEqual(["x", "y", "z"]);
  });

  it("handles a wide graph with many short branches", () => {
    // a -> b, a -> c, a -> d, b -> e
    // Longest: a -> b -> e (length 3)
    const edges: GraphInputEdge[] = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "a", target: "d" },
      { source: "b", target: "e" },
    ];
    const result = computeCriticalPath(
      ["a", "b", "c", "d", "e"],
      edges,
    );
    expect(result).toEqual(["a", "b", "e"]);
  });
});
