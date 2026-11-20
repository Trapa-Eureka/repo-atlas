import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Graph } from "../graph/graph.js";
import { fileId, symbolId, type GraphNode, type NodeKind } from "../graph/types.js";
import { indexRepository, lastSummary, unresolvedImports, type IndexOptions, type IndexSummary } from "../indexer/indexer.js";
import type { UnresolvedImport } from "../indexer/link.js";
import { changes, withoutQuietLines, type ChangesResult } from "../query/changes.js";
import { context, type ContextResult } from "../query/context.js";
import { impact, type ImpactResult } from "../query/impact.js";
import { mermaid, type MermaidResult } from "../query/mermaid.js";
import { path, type PathResult } from "../query/path.js";
import { resolveTarget, search } from "../query/resolve.js";
import { stats, type StatsResult } from "../query/stats.js";
import { view, type ViewResult } from "../query/view.js";
import { DATA_FOLDER, Store } from "../store/store.js";
import { compare } from "./git.js";

/** The repository a command applies to: the nearest folder with an index, else the git root, else `start`. */
export function findRoot(start: string): string {
  const from = resolve(start);
  for (let folder = from; ; folder = dirname(folder)) {
    if (existsSync(join(folder, DATA_FOLDER))) return folder;
    if (dirname(folder) === folder) break;
  }
  try {
    return execFileSync("git", ["-C", from, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || from;
  } catch {
    return from;
  }
}

export interface OpenOptions extends IndexOptions {
  /** Skip the incremental re-index and answer from the stored graph. */
  noRefresh?: boolean;
  /** Folder that relative paths in queries are relative to. Defaults to the root. */
  cwd?: string;
}

/** One opened repository index. Every CLI command and MCP tool goes through this class. */
export class Atlas {
  private constructor(
    readonly root: string,
    private readonly store: Store,
    private readonly cwd: string,
    private loaded: Graph,
    public summary: IndexSummary,
  ) {}

  static async open(root: string, options: OpenOptions = {}): Promise<Atlas> {
    const store = Store.open(root);
    try {
      const stored = options.noRefresh ? lastSummary(store) : null;
      const summary = stored ?? (await indexRepository(root, store, options));
      return new Atlas(root, store, options.cwd ?? root, store.loadGraph(), summary);
    } catch (error) {
      store.close();
      throw error;
    }
  }

  get graph(): Graph {
    return this.loaded;
  }

  async refresh(options: IndexOptions = {}): Promise<IndexSummary> {
    this.summary = await indexRepository(this.root, this.store, options);
    if (this.summary.relinked) this.loaded = this.store.loadGraph();
    return this.summary;
  }

  close(): void {
    this.store.close();
  }

  /** A query as typed, plus the same path made relative to the repository root. */
  private spellings(query: string): string[] {
    const fromCwd = relative(this.root, resolve(this.cwd, query)).split(sep).join("/");
    return fromCwd && !fromCwd.startsWith("..") && fromCwd !== query ? [query, fromCwd] : [query];
  }

  target(query: string): GraphNode {
    return resolveTarget(this.graph, this.spellings(query));
  }

  search(query: string, options: { kind?: NodeKind; limit?: number } = {}): GraphNode[] {
    return search(this.graph, query, options);
  }

  context(query: string): ContextResult {
    return context(this.graph, this.target(query));
  }

  impact(query: string, depth?: number): ImpactResult {
    return impact(this.graph, this.target(query), depth);
  }

  /** What the changes since `base` (default: the last commit) touch and what depends on that. Reads the changed lines from git. */
  async diff(base?: string, depth?: number): Promise<ChangesResult> {
    // Line numbers come from the working tree, so the index has to be of the same tree: this always refreshes first.
    await this.refresh();
    const spans = (path: string) => (this.store.factsOf(path)?.symbols ?? []).map((symbol) => ({ id: symbolId(path, symbol.name), line: symbol.line, endLine: symbol.endLine }));
    const comparison = compare(this.root, base);
    for (const file of comparison.files) {
      const node = this.graph.node(fileId(file.path));
      if (!node || file.ranges.length === 0) continue;
      let source: string;
      try {
        source = readFileSync(join(this.root, file.path), "utf8");
      } catch {
        continue;
      }
      file.ranges = withoutQuietLines(file.ranges, source, node.detail);
      if (file.ranges.length === 0 && file.gaps.length === 0) file.quiet = true;
    }
    return changes(this.graph, comparison, spans, unresolvedImports(this.store), depth);
  }

  path(from: string, to: string): PathResult {
    return path(this.graph, this.target(from), this.target(to));
  }

  mermaid(options: { focus?: string; depth?: number; maxNodes?: number } = {}): MermaidResult {
    return mermaid(this.graph, {
      ...(options.focus ? { focus: this.target(options.focus) } : {}),
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    });
  }

  /** The whole graph as one HTML page to open in a browser. */
  view(options: { focus?: string } = {}): ViewResult {
    return view(this.graph, { title: basename(this.root), ...(options.focus ? { focus: this.target(options.focus) } : {}) });
  }

  /** Where `atlas view` writes its page unless told otherwise: next to the index, which git already ignores. */
  get viewFile(): string {
    return join(this.root, DATA_FOLDER, "view.html");
  }

  stats(): StatsResult & { unresolvedImports: UnresolvedImport[] } {
    return { ...stats(this.graph), unresolvedImports: unresolvedImports(this.store) };
  }

  export(): { nodes: GraphNode[]; edges: Graph["edges"] } {
    return { nodes: [...this.graph.nodes.values()], edges: this.graph.edges };
  }
}
