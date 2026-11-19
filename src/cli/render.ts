import type { GraphNode } from "../graph/types.js";
import type { IndexSummary } from "../indexer/indexer.js";
import type { UnresolvedImport } from "../indexer/link.js";
import type { ContextResult } from "../query/context.js";
import type { ImpactResult } from "../query/impact.js";
import type { PathResult } from "../query/path.js";
import type { StatsResult } from "../query/stats.js";

function where(node: { file: string | null; line: number | null; kind: string }): string {
  if (node.kind === "file" || !node.file) return "";
  return `  ${node.file}${node.line ? `:${node.line}` : ""}`;
}

export function nodeLine(node: GraphNode): string {
  return `${node.id}${node.detail && node.kind !== "module" ? `  (${node.detail})` : ""}${where(node)}`;
}

export function renderSummary(root: string, summary: IndexSummary): string {
  const lines = [
    `Indexed ${root}`,
    `  ${summary.files} files: ${summary.parsed} parsed, ${summary.unchanged} unchanged, ${summary.removed} removed (${summary.milliseconds} ms)`,
    `  graph: ${summary.nodes} nodes, ${summary.edges} edges${summary.relinked ? "" : " (not changed)"}`,
  ];
  if (summary.unresolvedImports > 0) lines.push(`  ${summary.unresolvedImports} local imports could not be resolved; list them with: atlas stats --unresolved`);
  if (summary.skippedLarge > 0) lines.push(`  ${summary.skippedLarge} files over 1 MiB were skipped`);
  if (summary.failed.length > 0) lines.push(`  ${summary.failed.length} files could not be parsed: ${summary.failed.slice(0, 5).join(", ")}`);
  return lines.join("\n");
}

export function renderSearch(nodes: GraphNode[]): string {
  return nodes.length > 0 ? nodes.map(nodeLine).join("\n") : "No matches.";
}

export function renderContext(result: ContextResult): string {
  const lines = [nodeLine(result.target), ""];
  for (const relation of result.relations) {
    lines.push(`${relation.relation} (${relation.nodes.length})`);
    for (const node of relation.nodes) lines.push(`  ${node.id}${node.at ? `  line ${node.at}` : ""}`);
    lines.push("");
  }
  if (result.relations.length === 0) lines.push("No relations recorded for this node.", "");
  const { direct, transitive, files, docs } = result.impact;
  lines.push(`Changing this affects ${direct} nodes directly, ${transitive} in total (${files} code files, ${docs} docs). Details: atlas impact ${result.target.id}`);
  return lines.join("\n");
}

export function renderImpact(result: ImpactResult): string {
  const lines = [`Impact of changing ${result.target.id}`];
  if (result.affected.length === 0) return `${lines[0]}\n  Nothing in the index depends on it.`;
  const byDistance = new Map<number, typeof result.affected>();
  for (const entry of result.affected) byDistance.set(entry.distance, [...(byDistance.get(entry.distance) ?? []), entry]);
  for (const [distance, entries] of [...byDistance].sort((a, b) => a[0] - b[0])) {
    lines.push("", distance === 1 ? `direct (${entries.length})` : `${distance} steps away (${entries.length})`);
    for (const entry of entries.sort((a, b) => (a.node.id < b.node.id ? -1 : 1))) {
      lines.push(`  ${entry.node.id}  [${entry.via} ${entry.through}]`);
    }
  }
  if (result.truncatedAtDepth !== null) lines.push("", `Stopped at depth ${result.truncatedAtDepth}; more nodes are affected further out.`);
  return lines.join("\n");
}

export function renderPath(result: PathResult): string {
  if (result.direction === null) return `No path between ${result.from.id} and ${result.to.id}.`;
  const first = result.steps[0]?.src ?? result.from.id;
  const lines = [result.direction === "forward" ? first : `(reverse direction: ${result.to.id} leads to ${result.from.id})\n${first}`];
  for (const step of result.steps) lines.push(`  -[${step.kind}]-> ${step.dst}`);
  return lines.join("\n");
}

export function renderStats(result: StatsResult & { unresolvedImports: UnresolvedImport[] }, showUnresolved: boolean): string {
  const table = (record: Record<string, number>) =>
    Object.entries(record)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `  ${name.padEnd(14)} ${count}`);
  const lines = ["nodes", ...table(result.nodes), "", "edges", ...table(result.edges), "", "files by language", ...table(result.languages)];
  if (result.hubs.length > 0) {
    lines.push("", "most depended-on files");
    for (const hub of result.hubs) lines.push(`  ${String(hub.dependents).padStart(4)}  ${hub.name}`);
  }
  if (showUnresolved) {
    lines.push("", `unresolved local imports (${result.unresolvedImports.length})`);
    for (const item of result.unresolvedImports) lines.push(`  ${item.file}:${item.line}  ${item.specifier}`);
  } else if (result.unresolvedImports.length > 0) {
    lines.push("", `${result.unresolvedImports.length} unresolved local imports (atlas stats --unresolved)`);
  }
  return lines.join("\n");
}
