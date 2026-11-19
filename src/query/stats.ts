import type { Graph } from "../graph/graph.js";
import { EDGE_KINDS, NODE_KINDS, type EdgeKind, type NodeKind } from "../graph/types.js";
import { DEPENDENCY_KINDS } from "./impact.js";

export interface StatsResult {
  nodes: Record<NodeKind, number>;
  edges: Record<EdgeKind, number>;
  languages: Record<string, number>;
  /** Files most other files depend on: the riskiest ones to change. */
  hubs: { id: string; name: string; dependents: number }[];
}

export function stats(graph: Graph, hubCount = 10): StatsResult {
  const nodes = Object.fromEntries(NODE_KINDS.map((kind) => [kind, 0])) as Record<NodeKind, number>;
  const edges = Object.fromEntries(EDGE_KINDS.map((kind) => [kind, 0])) as Record<EdgeKind, number>;
  const languages: Record<string, number> = {};
  const hubs: StatsResult["hubs"] = [];

  for (const node of graph.nodes.values()) {
    nodes[node.kind]++;
    if (node.kind !== "file") continue;
    const language = node.detail ?? "unknown";
    languages[language] = (languages[language] ?? 0) + 1;
    const dependents = new Set(graph.in(node.id, DEPENDENCY_KINDS).map((edge) => edge.src)).size;
    if (dependents > 0) hubs.push({ id: node.id, name: node.name, dependents });
  }
  for (const edge of graph.edges) edges[edge.kind]++;
  hubs.sort((a, b) => b.dependents - a.dependents || (a.id < b.id ? -1 : 1));

  return { nodes, edges, languages, hubs: hubs.slice(0, hubCount) };
}
