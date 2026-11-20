import type { Graph } from "../graph/graph.js";
import type { EdgeKind, GraphNode } from "../graph/types.js";

/** Edges where the source depends on the destination, so a change to the destination can break the source. */
export const DEPENDENCY_KINDS: ReadonlySet<EdgeKind> = new Set(["imports", "calls", "reads_table", "writes_table", "uses_env", "documents"]);
const OWNED_KINDS: ReadonlySet<EdgeKind> = new Set(["defines", "defines_table", "declares_env"]);
const DEFINES: ReadonlySet<EdgeKind> = new Set(["defines"]);

export interface ImpactEntry {
  node: GraphNode;
  /** 1 = depends on the target directly. */
  distance: number;
  /** The edge that pulled this node in: `node -[via]-> through`. `contains` marks the file that holds an affected symbol. */
  via: EdgeKind | "contains";
  through: string;
}

export interface ImpactResult {
  target: GraphNode;
  /** The target plus what it owns (a file's symbols, the tables it defines, the env keys it declares). */
  seeds: string[];
  affected: ImpactEntry[];
  truncatedAtDepth: number | null;
}

/** What the target owns: changing the target changes these too. */
export function seedsOf(graph: Graph, target: GraphNode): string[] {
  const seeds = new Set([target.id]);
  if (target.kind === "file") for (const edge of graph.out(target.id, OWNED_KINDS)) seeds.add(edge.dst);
  if (target.kind === "symbol" && target.detail === "class") {
    for (const node of graph.nodes.values()) if (node.id.startsWith(`${target.id}.`)) seeds.add(node.id);
  }
  return [...seeds];
}

/**
 * Reverse reachability over dependency edges from a set of changed nodes. Symbol-level paths stay
 * precise (callers of callers). A file reached through an import is followed to its own importers,
 * because which of its symbols are affected is unknown. A doc that mentions an affected node is
 * reported but not followed: docs citing that doc are not affected.
 */
export function spread(graph: Graph, seeds: readonly string[], maxDepth = Infinity): { affected: ImpactEntry[]; truncated: boolean } {
  const visited = new Set(seeds);
  const affected: ImpactEntry[] = [];
  let frontier = [...seeds];
  let distance = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (distance >= maxDepth) {
      truncated = frontier.some((id) => graph.in(id, DEPENDENCY_KINDS).some((edge) => !visited.has(edge.src)));
      break;
    }
    distance++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.in(id, DEPENDENCY_KINDS)) {
        if (visited.has(edge.src)) continue;
        const node = graph.node(edge.src);
        if (!node) continue;
        visited.add(node.id);
        affected.push({ node, distance, via: edge.kind, through: id });
        if (node.detail === "markdown") continue;
        next.push(node.id);
        if (node.kind !== "symbol") continue;
        const owner = graph.in(node.id, DEFINES)[0]?.src;
        const file = owner ? graph.node(owner) : undefined;
        if (file && !visited.has(file.id)) {
          visited.add(file.id);
          affected.push({ node: file, distance, via: "contains", through: node.id });
        }
      }
    }
    frontier = next;
  }
  return { affected, truncated };
}

/** Everything that may need attention when the target changes: the target, what it owns, and whatever depends on those. */
export function impact(graph: Graph, target: GraphNode, maxDepth = Infinity): ImpactResult {
  const seeds = seedsOf(graph, target);
  const { affected, truncated } = spread(graph, seeds, maxDepth);
  return { target, seeds, affected, truncatedAtDepth: truncated ? maxDepth : null };
}
