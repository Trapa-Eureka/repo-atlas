import type { Graph } from "../graph/graph.js";
import { fileId, type EdgeKind, type GraphNode } from "../graph/types.js";

/** Edges where the source depends on the destination, so a change to the destination can break the source. */
export const DEPENDENCY_KINDS: ReadonlySet<EdgeKind> = new Set(["imports", "calls", "references", "reads_table", "writes_table", "uses_env", "documents"]);
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

/** A call of a method name on a value whose type the graph could not tell. */
export interface UnboundCall {
  name: string;
  src: string;
  line: number;
}

/** A place that may call a changed method: it calls a method of that name, on a value of unknown type. */
export interface PossibleCaller {
  node: GraphNode;
  line: number;
  /** The method it may be calling. */
  of: string;
}

/** A method name used on values of unknown type in more places than are worth listing: `get`, `size`, `toString`. */
export interface CommonName {
  name: string;
  /** How many functions and files call something of that name on a value of unknown type. */
  callers: number;
  /** The method of that name among what changed. */
  of: string;
}

/** What the graph cannot rule in or out. */
export interface Possible {
  callers: PossibleCaller[];
  common: CommonName[];
}

/** Above this many call sites, a method name says too little about which method is meant. */
export const MAX_NAMED_CALLERS = 20;

export interface ImpactResult {
  target: GraphNode;
  /** The target plus what it owns (a file's symbols, the tables it defines, the env keys it declares). */
  seeds: string[];
  affected: ImpactEntry[];
  /** Not counted in `affected`: nothing says these call the target, and nothing says they do not. */
  possible: Possible;
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
 * reported but not followed: docs citing that doc are not affected. Nor is a file that names a
 * changed symbol without calling it (`references`): it is affected, its importers are not known to be.
 */
export function spread(graph: Graph, seeds: readonly string[], maxDepth = Infinity): { affected: ImpactEntry[]; truncated: boolean } {
  const visited = new Set(seeds);
  // Reached only by naming a changed symbol: reported, and followed only if something stronger reaches it too.
  const named = new Set<string>();
  const affected: ImpactEntry[] = [];
  let frontier = [...seeds];
  let distance = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (distance >= maxDepth) {
      truncated = frontier.some((id) => graph.in(id, DEPENDENCY_KINDS).some((edge) => !visited.has(edge.src) || (edge.kind !== "references" && named.has(edge.src))));
      break;
    }
    distance++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.in(id, DEPENDENCY_KINDS)) {
        if (visited.has(edge.src)) {
          // Listed for naming a symbol, and now an import or a call reaches it as well: follow it after all.
          if (edge.kind !== "references" && named.delete(edge.src)) next.push(edge.src);
          continue;
        }
        const node = graph.node(edge.src);
        if (!node) continue;
        visited.add(node.id);
        affected.push({ node, distance, via: edge.kind, through: id });
        if (node.detail === "markdown") continue;
        // A file that only names a changed symbol is affected itself; which of its own parts, and so who is next, is not known.
        if (edge.kind === "references") {
          named.add(node.id);
          continue;
        }
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

/** The language of the file a node is in, with TypeScript and JavaScript as one. */
function languageOf(graph: Graph, node: GraphNode | undefined): string | null {
  const detail = node?.file ? (graph.node(fileId(node.file))?.detail ?? null) : null;
  return detail === "tsx" || detail === "javascript" ? "typescript" : detail;
}

/**
 * The callers the graph cannot rule in or out for the methods among `seeds`: call sites that use a
 * method's name on a value of unknown type, and are not already known to be affected.
 */
export function possibleCallers(graph: Graph, seeds: readonly string[], affected: readonly ImpactEntry[], unbound: (name: string) => readonly UnboundCall[]): Possible {
  const known = new Set([...seeds, ...affected.map((entry) => entry.node.id)]);
  const callers = new Map<string, PossibleCaller>();
  const common = new Map<string, CommonName>();
  for (const id of seeds) {
    const seed = graph.node(id);
    if (seed?.kind !== "symbol" || seed.detail !== "method") continue;
    const name = seed.name.slice(seed.name.lastIndexOf(".") + 1);
    if (common.has(name)) continue;
    // A method is called from its own language: a Ruby `execute` says nothing about a Python one.
    const language = languageOf(graph, seed);
    const calls = unbound(name).filter((call) => languageOf(graph, graph.node(call.src)) === language);
    if (calls.length > MAX_NAMED_CALLERS) {
      common.set(name, { name, callers: calls.length, of: seed.id });
      continue;
    }
    for (const call of calls) {
      const node = graph.node(call.src);
      if (node && !known.has(node.id) && !callers.has(node.id)) callers.set(node.id, { node, line: call.line, of: seed.id });
    }
  }
  return {
    callers: [...callers.values()].sort((a, b) => (a.node.id < b.node.id ? -1 : 1)),
    common: [...common.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

/** Everything that may need attention when the target changes: the target, what it owns, and whatever depends on those. */
export function impact(graph: Graph, target: GraphNode, maxDepth = Infinity, unbound: (name: string) => readonly UnboundCall[] = () => []): ImpactResult {
  const seeds = seedsOf(graph, target);
  const { affected, truncated } = spread(graph, seeds, maxDepth);
  // A file is asked about as a whole: its methods are not what the question is about.
  const possible = target.kind === "symbol" ? possibleCallers(graph, seeds, affected, unbound) : { callers: [], common: [] };
  return { target, seeds, affected, possible, truncatedAtDepth: truncated ? maxDepth : null };
}
