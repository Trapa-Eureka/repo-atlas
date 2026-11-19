import type { Graph } from "../graph/graph.js";
import type { GraphNode, NodeKind } from "../graph/types.js";

export class TargetError extends Error {
  constructor(
    message: string,
    readonly candidates: GraphNode[],
  ) {
    super(message);
    this.name = "TargetError";
  }
}

export interface SearchOptions {
  kind?: NodeKind;
  limit?: number;
}

function score(node: GraphNode, query: string, lower: string): number {
  const name = node.name.toLowerCase();
  const short = name.split(/[/.#]/).pop() ?? name;
  if (node.id === query || node.name === query) return 100;
  if (name === lower) return 95;
  if (node.kind === "file" && name.endsWith(`/${lower}`)) return 90;
  if (short === lower) return 85;
  if (node.kind === "file" && (name.split("/").pop() ?? "").startsWith(lower)) return 70;
  if (short.startsWith(lower)) return 60;
  if (name.includes(lower) || node.id.toLowerCase().includes(lower)) return 40;
  return 0;
}

/** Ranked name search over every node. */
export function search(graph: Graph, query: string, options: SearchOptions = {}): GraphNode[] {
  const lower = query.toLowerCase();
  const scored: { node: GraphNode; score: number }[] = [];
  for (const node of graph.nodes.values()) {
    if (options.kind && node.kind !== options.kind) continue;
    const value = score(node, query, lower);
    if (value > 0) scored.push({ node, score: value });
  }
  scored.sort((a, b) => b.score - a.score || graph.degree(b.node.id) - graph.degree(a.node.id) || (a.node.id < b.node.id ? -1 : 1));
  return scored.slice(0, options.limit ?? 20).map((entry) => entry.node);
}

function exactMatches(graph: Graph, query: string): GraphNode[] {
  const byId = graph.node(query);
  if (byId) return [byId];
  const [filePart, symbolPart] = query.includes("#") ? query.split("#", 2) : [null, null];
  const matches: GraphNode[] = [];
  for (const node of graph.nodes.values()) {
    if (filePart !== null && symbolPart !== null) {
      if (node.kind === "symbol" && node.name === symbolPart && (node.file === filePart || node.file?.endsWith(`/${filePart}`))) matches.push(node);
    } else if (node.kind === "file") {
      if (node.name === query || node.name.endsWith(`/${query}`)) matches.push(node);
    } else if (node.name === query || (node.kind === "symbol" && node.name.split(".").pop() === query) || (node.kind === "table" && node.name === query.toLowerCase())) {
      matches.push(node);
    }
  }
  const wholeFile = matches.filter((node) => node.kind === "file" && node.name === query);
  return wholeFile.length === 1 ? wholeFile : matches;
}

/**
 * Finds the one node a user means. Accepts a node id, a file path (or its tail), `file#symbol`,
 * a symbol, table, env or package name. Throws a `TargetError` listing candidates otherwise.
 */
export function resolveTarget(graph: Graph, queries: string[]): GraphNode {
  for (const query of queries) {
    const matches = exactMatches(graph, query);
    const [only] = matches;
    if (matches.length === 1 && only) return only;
    if (matches.length > 1) {
      throw new TargetError(`"${query}" matches ${matches.length} nodes. Use one of the ids below, or file#symbol.`, matches.slice(0, 20));
    }
  }
  const query = queries[0] ?? "";
  const suggestions = search(graph, query, { limit: 8 });
  throw new TargetError(
    suggestions.length > 0 ? `Nothing is named exactly "${query}". Closest matches are below.` : `Nothing in the index matches "${query}". Run \`atlas search\` with part of the name.`,
    suggestions,
  );
}
