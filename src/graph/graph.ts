import type { EdgeKind, GraphEdge, GraphNode } from "./types.js";

const NO_EDGES: readonly GraphEdge[] = [];

export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  constructor(nodes: Iterable<GraphNode>, edges: Iterable<GraphEdge>) {
    for (const node of nodes) this.nodes.set(node.id, node);
    for (const edge of edges) {
      if (!this.nodes.has(edge.src) || !this.nodes.has(edge.dst)) {
        throw new Error(`Edge ${edge.src} -[${edge.kind}]-> ${edge.dst} points at a node that is not in the graph`);
      }
      this.edges.push(edge);
      push(this.outgoing, edge.src, edge);
      push(this.incoming, edge.dst, edge);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  out(id: string, kinds?: ReadonlySet<EdgeKind>): readonly GraphEdge[] {
    return filterKinds(this.outgoing.get(id) ?? NO_EDGES, kinds);
  }

  in(id: string, kinds?: ReadonlySet<EdgeKind>): readonly GraphEdge[] {
    return filterKinds(this.incoming.get(id) ?? NO_EDGES, kinds);
  }

  degree(id: string): number {
    return (this.outgoing.get(id)?.length ?? 0) + (this.incoming.get(id)?.length ?? 0);
  }
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function filterKinds(edges: readonly GraphEdge[], kinds?: ReadonlySet<EdgeKind>): readonly GraphEdge[] {
  return kinds ? edges.filter((edge) => kinds.has(edge.kind)) : edges;
}
