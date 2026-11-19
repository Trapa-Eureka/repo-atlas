import type { Graph } from "../graph/graph.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";

export interface PathResult {
  from: GraphNode;
  to: GraphNode;
  /** `forward`: from depends on to. `reverse`: only a path from `to` to `from` exists. `null`: not connected. */
  direction: "forward" | "reverse" | null;
  steps: GraphEdge[];
}

function shortest(graph: Graph, from: string, to: string): GraphEdge[] | null {
  const cameBy = new Map<string, GraphEdge | null>([[from, null]]);
  let frontier = [from];
  while (frontier.length > 0 && !cameBy.has(to)) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.out(id)) {
        if (cameBy.has(edge.dst)) continue;
        cameBy.set(edge.dst, edge);
        next.push(edge.dst);
      }
    }
    frontier = next;
  }
  if (!cameBy.has(to)) return null;
  const steps: GraphEdge[] = [];
  for (let edge = cameBy.get(to); edge; edge = cameBy.get(edge.src)) steps.unshift(edge);
  return steps;
}

/** Shortest chain of edges that explains how two nodes are connected. */
export function path(graph: Graph, from: GraphNode, to: GraphNode): PathResult {
  const forward = shortest(graph, from.id, to.id);
  if (forward) return { from, to, direction: "forward", steps: forward };
  const reverse = shortest(graph, to.id, from.id);
  if (reverse) return { from, to, direction: "reverse", steps: reverse };
  return { from, to, direction: null, steps: [] };
}
