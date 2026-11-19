import type { Graph } from "../graph/graph.js";
import type { EdgeKind, GraphEdge, GraphNode } from "../graph/types.js";

export interface MermaidOptions {
  /** Draw the neighbourhood of this node. Without it, the file-level overview is drawn. */
  focus?: GraphNode;
  depth?: number;
  maxNodes?: number;
}

export interface MermaidResult {
  text: string;
  nodes: number;
  edges: number;
  /** Nodes left out because of `maxNodes`. */
  omitted: number;
}

const OVERVIEW_KINDS: ReadonlySet<EdgeKind> = new Set(["imports", "defines_table", "reads_table", "writes_table"]);

function shape(node: GraphNode, label: string): string {
  switch (node.kind) {
    case "file":
      return `["${label}"]`;
    case "symbol":
      return `("${label}")`;
    case "table":
      return `[("${label}")]`;
    case "env":
      return `{{"${label}"}}`;
    case "module":
      return `(["${label}"])`;
  }
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[<>]/g, (char) => (char === "<" ? "#lt;" : "#gt;"));
}

function neighbourhood(graph: Graph, focus: GraphNode, depth: number): { ids: Set<string>; edges: GraphEdge[] } {
  const ids = new Set([focus.id]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [focus.id];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of [...graph.out(id), ...graph.in(id)]) {
        edges.set(`${edge.src}|${edge.dst}|${edge.kind}`, edge);
        const other = edge.src === id ? edge.dst : edge.src;
        if (!ids.has(other)) {
          ids.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return { ids, edges: [...edges.values()] };
}

function overview(graph: Graph): { ids: Set<string>; edges: GraphEdge[] } {
  const edges = graph.edges.filter((edge) => OVERVIEW_KINDS.has(edge.kind) && graph.node(edge.dst)?.kind !== "module");
  const ids = new Set<string>();
  for (const edge of edges) ids.add(edge.src).add(edge.dst);
  return { ids, edges };
}

/** A Mermaid flowchart of part of the graph. Deterministic for a given graph and options. */
export function mermaid(graph: Graph, options: MermaidOptions = {}): MermaidResult {
  const maxNodes = options.maxNodes ?? 40;
  const picked = options.focus ? neighbourhood(graph, options.focus, options.depth ?? 1) : overview(graph);

  const ranked = [...picked.ids].sort((a, b) => {
    if (a === options.focus?.id) return -1;
    if (b === options.focus?.id) return 1;
    return graph.degree(b) - graph.degree(a) || (a < b ? -1 : 1);
  });
  const kept = new Set(ranked.slice(0, maxNodes));
  const edges = picked.edges
    .filter((edge) => kept.has(edge.src) && kept.has(edge.dst))
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : a.kind < b.kind ? -1 : 1));

  const names = new Map<string, string>();
  [...kept].sort().forEach((id, index) => names.set(id, `n${index}`));

  const lines = ["flowchart LR"];
  for (const [id, name] of names) {
    const node = graph.node(id);
    if (node) lines.push(`  ${name}${shape(node, escapeLabel(node.name))}`);
  }
  for (const edge of edges) lines.push(`  ${names.get(edge.src)} -->|${edge.kind}| ${names.get(edge.dst)}`);
  if (options.focus) lines.push(`  style ${names.get(options.focus.id)} stroke-width:3px`);
  const omitted = picked.ids.size - kept.size;
  if (omitted > 0) lines.push(`  %% ${omitted} more nodes left out; raise --max or lower --depth to change what is drawn`);

  return { text: `${lines.join("\n")}\n`, nodes: kept.size, edges: edges.length, omitted };
}
