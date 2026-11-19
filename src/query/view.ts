import type { Graph } from "../graph/graph.js";
import { EDGE_KINDS, type GraphNode } from "../graph/types.js";
import { PAGE_SCRIPT, PAGE_STYLE } from "./view-page.js";

export interface ViewOptions {
  /** Shown in the page header, usually the repository folder name. */
  title: string;
  /** The node the page opens on. Without it, the page opens on the most depended-on nodes. */
  focus?: GraphNode;
}

export interface ViewResult {
  html: string;
  nodes: number;
  edges: number;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON that is safe inside a `<script>` element: no `</script>`, no HTML comment opener, no line separators JavaScript rejects. */
function embed(value: unknown): string {
  const separators = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(separators, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
}

/**
 * The graph as one self-contained HTML page: the data, a stylesheet and a script, with no request
 * to anything else. It holds what the index holds (paths and names), so it is as private as the
 * index itself.
 */
export function view(graph: Graph, options: ViewOptions): ViewResult {
  const nodes = [...graph.nodes.values()];
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const edges: [number, number, number, number | null][] = [];
  for (const edge of graph.edges) {
    const src = position.get(edge.src);
    const dst = position.get(edge.dst);
    if (src !== undefined && dst !== undefined) edges.push([src, dst, EDGE_KINDS.indexOf(edge.kind), edge.line]);
  }
  const data = {
    nodes: nodes.map((node) => [node.id, node.kind, node.name, node.file, node.line, node.detail]),
    edges,
    edgeKinds: EDGE_KINDS,
    focus: options.focus?.id ?? null,
  };
  const count = (kind: string) => nodes.filter((node) => node.kind === kind).length;
  const title = escapeHtml(options.title);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · repo-atlas</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header><b>${title}</b><span>${count("file")} files · ${count("symbol")} symbols · ${count("table")} tables · ${count("env")} env keys · ${edges.length} relations</span></header>
<aside id="side">
  <input id="q" type="search" placeholder="Search files, functions, tables, env keys" aria-label="Search the graph" autofocus>
  <div id="kinds" class="chips" role="group" aria-label="Kind of node"></div>
  <div id="count" class="sub"></div>
  <ul id="results"></ul>
</aside>
<main>
  <div id="bar" hidden>
    <button id="home" type="button">← Overview</button>
    <b id="title"></b>
    <span class="gap"></span>
    <span id="depth"><button id="d1" type="button" aria-pressed="true">1 step</button> <button id="d2" type="button" aria-pressed="false">2 steps</button></span>
    <button id="near" type="button" aria-pressed="true">Neighbours</button>
    <button id="impact" type="button" aria-pressed="false">What breaks</button>
  </div>
  <div id="empty">
    <h1>Most depended-on</h1>
    <p class="hint">Pick one, or search on the left. In the drawing, what a node uses is on its right and what uses it is on its left; click a box to move there, drag to pan, scroll to zoom.</p>
    <ul id="hubs"></ul>
  </div>
  <svg id="canvas" role="img" aria-label="Graph around the selected node">
    <defs>
      <marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker>
      <marker id="tail" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10 0L0 5L10 10z" fill="var(--edge)"/></marker>
    </defs>
    <g id="scene"></g>
  </svg>
</main>
<aside id="detail"></aside>
<script>window.ATLAS = ${embed(data)};</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
  return { html, nodes: nodes.length, edges: edges.length };
}
