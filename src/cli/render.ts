import type { GraphNode } from "../graph/types.js";
import type { IndexSummary } from "../indexer/indexer.js";
import type { UnresolvedImport } from "../indexer/link.js";
import type { ChangesResult } from "../query/changes.js";
import type { ContextResult } from "../query/context.js";
import type { ImpactResult, Possible } from "../query/impact.js";
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
  const { direct, transitive, files, docs, possible, commonNames } = result.impact;
  const maybe = `${possible > 0 ? `, and possibly ${possible} more call ${possible === 1 ? "site" : "sites"}` : ""}${commonNames > 0 ? `; ${commonNames === 1 ? "its name is" : `${commonNames} of its method names are`} too common to tell who else calls it` : ""}`;
  lines.push(`Changing this affects ${direct} nodes directly, ${transitive} in total (${files} code files, ${docs} docs)${maybe}. Details: atlas impact ${result.target.id}`);
  return lines.join("\n");
}

const MAX_POSSIBLE_SHOWN = 15;

/** Call sites that may reach a changed method, kept apart from what is known to. */
function possibleLines(possible: Possible): string[] {
  const lines: string[] = [];
  if (possible.callers.length > 0) {
    lines.push("", `possibly affected (${possible.callers.length}): these call a method of the same name on a value whose type the graph cannot tell`);
    for (const item of possible.callers.slice(0, MAX_POSSIBLE_SHOWN)) lines.push(`  ${item.node.id}  [line ${item.line}, maybe ${item.of}]`);
    if (possible.callers.length > MAX_POSSIBLE_SHOWN) lines.push(`  and ${possible.callers.length - MAX_POSSIBLE_SHOWN} more (all of them with --json)`);
  }
  if (possible.common.length > 0) {
    lines.push("", "not listed: these names are called on values of unknown type in too many places to tell which method is meant");
    for (const item of possible.common) lines.push(`  ${item.name}  ${item.callers} places  (${item.of})`);
  }
  return lines;
}

/** The affected nodes grouped by how many steps they are from what changed, each group after an empty line. */
function affectedLines(result: Pick<ImpactResult, "affected" | "truncatedAtDepth">): string[] {
  const lines: string[] = [];
  const byDistance = new Map<number, typeof result.affected>();
  for (const entry of result.affected) byDistance.set(entry.distance, [...(byDistance.get(entry.distance) ?? []), entry]);
  for (const [distance, entries] of [...byDistance].sort((a, b) => a[0] - b[0])) {
    lines.push("", distance === 1 ? `direct (${entries.length})` : `${distance} steps away (${entries.length})`);
    for (const entry of entries.sort((a, b) => (a.node.id < b.node.id ? -1 : 1))) {
      lines.push(`  ${entry.node.id}  [${entry.via} ${entry.through}]`);
    }
  }
  if (result.truncatedAtDepth !== null) lines.push("", `Stopped at depth ${result.truncatedAtDepth}; more nodes are affected further out.`);
  return lines;
}

export function renderImpact(result: ImpactResult): string {
  const title = `Impact of changing ${result.target.id}`;
  if (result.affected.length === 0) return [title, result.possible.callers.length + result.possible.common.length === 0 ? "  Nothing in the index depends on it." : "  Nothing in the index is known to depend on it.", ...possibleLines(result.possible)].join("\n");
  return [title, ...affectedLines(result), ...possibleLines(result.possible)].join("\n");
}

export function renderChanges(result: ChangesResult): string {
  const since = result.base === "HEAD" ? "the last commit" : `${result.base} (${result.commit.slice(0, 7)})`;
  const count = result.changed.length + result.outside.length;
  if (count === 0) return `Nothing changed since ${since}.`;
  const lines = [`Changes since ${since}: ${count} ${count === 1 ? "file" : "files"}`];

  if (result.changed.length > 0) lines.push("", `changed (${result.changed.length})`);
  for (const entry of result.changed) {
    lines.push(`  ${entry.file}  (${entry.status}${entry.from ? ` from ${entry.from}` : ""}${entry.quiet ? ", comments and blank lines only" : ""})`);
    for (const node of entry.nodes) lines.push(`    ${node.id}${node.kind === "symbol" && node.line ? `  line ${node.line}` : ""}`);
    if (entry.fileLevel && entry.nodes.length > 0 && entry.status === "modified") lines.push("    and lines outside any of these: the file as a whole counts as changed");
  }
  if (result.outside.length > 0) {
    lines.push("", `not in the index (${result.outside.length})`);
    for (const item of result.outside) lines.push(`  ${item.file}  (${item.status})`);
  }

  if (result.broken.length > 0) {
    lines.push("", `imports that lead nowhere now (${result.broken.length})`);
    for (const item of result.broken) lines.push(`  ${item.file}:${item.line}  ${item.specifier}  (was ${item.gone})`);
  }

  const unsure = result.possible.callers.length + result.possible.common.length > 0;
  if (result.affected.length === 0) lines.push("", unsure ? "Nothing else in the index is known to depend on what changed." : "Nothing else in the index depends on what changed.");
  else lines.push("", `affected (${result.affected.length})`, ...affectedLines(result).slice(1).map((line) => (line ? `  ${line}` : line)));

  lines.push(...possibleLines(result.possible));

  const list = (title: string, nodes: GraphNode[]): void => {
    if (nodes.length === 0) return;
    lines.push("", `${title} (${nodes.length})`);
    for (const node of nodes) lines.push(`  ${node.id}`);
  };
  list("tests to run", result.tests);
  list("changed code no test depends on", result.untested);
  list("docs to check", result.docs);
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
