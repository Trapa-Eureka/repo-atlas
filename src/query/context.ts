import type { Graph } from "../graph/graph.js";
import type { EdgeKind, GraphEdge, GraphNode } from "../graph/types.js";
import { impact, seedsOf, type UnboundCall } from "./impact.js";

export interface Relation {
  /** How the target relates to the other node, read as "target <relation> node". */
  relation: string;
  nodes: { id: string; kind: string; name: string; file: string | null; line: number | null; at: number | null }[];
}

export interface ContextResult {
  target: GraphNode;
  relations: Relation[];
  /** `possible`: call sites that use the name of one of the target's methods on a value of unknown type. `commonNames`: its method names used that way too widely to list. */
  impact: { direct: number; transitive: number; files: number; docs: number; possible: number; commonNames: number };
}

const OUTGOING: [EdgeKind, string][] = [
  ["defines", "defines"],
  ["imports", "imports"],
  ["calls", "calls"],
  ["defines_table", "defines table"],
  ["reads_table", "reads table"],
  ["writes_table", "writes table"],
  ["uses_env", "uses env"],
  ["declares_env", "declares env"],
  ["documents", "documents"],
];

const INCOMING: [EdgeKind, string][] = [
  ["defines", "defined in"],
  ["imports", "imported by"],
  ["calls", "called by"],
  ["defines_table", "defined in"],
  ["reads_table", "read by"],
  ["writes_table", "written by"],
  ["uses_env", "used by"],
  ["declares_env", "declared in"],
  ["documents", "documented in"],
];

function collect(graph: Graph, edges: readonly GraphEdge[], pick: (edge: GraphEdge) => string, inside: ReadonlySet<string>): Relation["nodes"] {
  const seen = new Map<string, Relation["nodes"][number]>();
  for (const edge of edges) {
    const node = graph.node(pick(edge));
    if (!node || inside.has(node.id) || seen.has(node.id)) continue;
    seen.set(node.id, { id: node.id, kind: node.kind, name: node.name, file: node.file, line: node.line, at: edge.line });
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The briefing to read before editing a target: what it defines and depends on, who depends on it,
 * which tables and env keys it touches, and which docs mention it. For a file, the relations of its
 * symbols are folded in, so "called by" lists callers of any function in the file.
 */
export function context(graph: Graph, target: GraphNode, unbound: (name: string) => readonly UnboundCall[] = () => []): ContextResult {
  const members = seedsOf(graph, target).filter((id) => graph.node(id)?.kind === "symbol" || id === target.id);
  const inside = new Set(members);
  const relations: Relation[] = [];

  for (const [kind, relation] of OUTGOING) {
    const kinds = new Set([kind]);
    const edges = kind === "defines" ? graph.out(target.id, kinds) : members.flatMap((id) => graph.out(id, kinds));
    const nodes = collect(graph, edges, (edge) => edge.dst, kind === "defines" ? new Set() : inside);
    if (nodes.length > 0) relations.push({ relation, nodes });
  }
  for (const [kind, relation] of INCOMING) {
    const kinds = new Set([kind]);
    const edges = kind === "defines" ? graph.in(target.id, kinds) : members.flatMap((id) => graph.in(id, kinds));
    const nodes = collect(graph, edges, (edge) => edge.src, inside);
    if (nodes.length > 0) relations.push({ relation, nodes });
  }

  const reach = impact(graph, target, Infinity, unbound);
  return {
    target,
    relations,
    impact: {
      direct: reach.affected.filter((entry) => entry.distance === 1 && entry.via !== "contains").length,
      transitive: reach.affected.filter((entry) => entry.via !== "contains").length,
      files: reach.affected.filter((entry) => entry.node.kind === "file" && entry.node.detail !== "markdown").length,
      docs: reach.affected.filter((entry) => entry.node.detail === "markdown").length,
      possible: reach.possible.callers.length,
      commonNames: reach.possible.common.length,
    },
  };
}
