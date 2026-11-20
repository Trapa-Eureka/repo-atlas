import { posix } from "node:path";
import type { Graph } from "../graph/graph.js";
import { fileId, type EdgeKind, type GraphNode } from "../graph/types.js";
import { DEPENDENCY_KINDS, possibleCallers, spread, type ImpactEntry, type Possible, type UnboundCall } from "./impact.js";

/** First and last line, both counted, starting at 1. */
export type LineRange = [number, number];

export interface ChangedFile {
  /** Relative to the repository root, with `/` between folders. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** For a renamed file, the path it had. */
  from?: string;
  /** Lines the file has now that are new or different. */
  ranges: LineRange[];
  /** Where lines were only taken out: the line they used to follow (0 for the top of the file). */
  gaps: number[];
  /** Every changed line was blank or a comment, so `ranges` was emptied. */
  quiet?: boolean;
}

/** Where a symbol of a file starts and ends. The graph keeps only the first line, so the caller reads this from the stored facts. */
export interface Span {
  id: string;
  line: number;
  endLine: number;
}

/** A local import the index could not follow to a file. */
export interface UnresolvedImport {
  file: string;
  specifier: string;
  line: number;
}

export interface ChangedEntry {
  file: string;
  status: ChangedFile["status"];
  from?: string;
  /** The functions, classes, tables and env keys the changed lines are in. */
  nodes: GraphNode[];
  /** Changed lines outside all of them (imports, top-level code, something deleted): the file as a whole counts as changed. */
  fileLevel: boolean;
  /** Only blank lines and comments changed: nothing that depends on the file is affected. */
  quiet?: boolean;
}

export interface ChangesResult {
  base: string;
  commit: string;
  changed: ChangedEntry[];
  /** Changed files the graph has no node for: deleted ones, and kinds of file the index does not read. */
  outside: { file: string; status: ChangedFile["status"] }[];
  /** Imports that lead nowhere now and name a file this change deleted or renamed. */
  broken: { file: string; line: number; specifier: string; gone: string }[];
  affected: ImpactEntry[];
  /** Call sites that use the name of a changed method on a value of unknown type. Not counted in `affected`. */
  possible: Possible;
  /** Test files that are changed themselves or depend on something changed. */
  tests: GraphNode[];
  /** Changed code that no test file depends on, even indirectly. */
  untested: GraphNode[];
  /** Docs that mention something changed or affected, and were not changed themselves. */
  docs: GraphNode[];
  truncatedAtDepth: number | null;
}

const OWNED: ReadonlySet<EdgeKind> = new Set(["defines_table", "declares_env"]);
const DEFINES: ReadonlySet<EdgeKind> = new Set(["defines"]);
const NOT_CODE: ReadonlySet<string | null> = new Set(["markdown", "sql", "env"]);

const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const TEST_NAME = /(?:[._-](?:test|spec)\.[^.]+$)|(?:^test_[^/]*\.py$)|(?:(?:Test|Tests|TestCase|IT|Spec)\.(?:java|kt|scala|cs|swift)$)/;

/** Whether a path is a test by the conventions of the languages the index reads: its folder (`tests/`, `src/test/`) or its name (`a.test.ts`, `a_test.go`, `test_a.py`, `ATest.java`, `a_spec.rb`). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  return TEST_NAME.test(name) || segments.some((segment) => TEST_FOLDERS.has(segment));
}

const BLOCK_COMMENTS: ReadonlySet<string> = new Set(["typescript", "tsx", "javascript", "go", "java", "rust"]);
const HASH_COMMENTS: ReadonlySet<string> = new Set(["python", "ruby", "env"]);

/**
 * For each line of a file, whether it is blank or holds nothing but a comment. Errs towards code:
 * a block comment counts only when its line starts with it, so a slash and a star inside a string
 * never open one, and a line with anything after the end of a comment is code.
 */
function quietLines(source: string, language: string | null): boolean[] {
  const blocks = language !== null && BLOCK_COMMENTS.has(language);
  const line = language === "sql" ? "--" : language !== null && HASH_COMMENTS.has(language) ? "#" : blocks ? "//" : null;
  let inBlock = false;
  return source.split("\n").map((raw) => {
    const text = raw.trim();
    if (inBlock || (blocks && text.startsWith("/*"))) {
      const close = text.indexOf("*/", inBlock ? 0 : 2);
      inBlock = close === -1;
      return inBlock || text.slice(close + 2).trim() === "";
    }
    return text === "" || (line !== null && text.startsWith(line));
  });
}

/**
 * The changed lines that can matter to other code: `ranges` without the lines that are blank or
 * hold only a comment. A Python docstring is a string, not a comment, and still counts as code.
 */
export function withoutQuietLines(ranges: readonly LineRange[], source: string, language: string | null): LineRange[] {
  const quiet = quietLines(source, language);
  const kept: LineRange[] = [];
  for (const [start, end] of ranges) {
    let open: number | null = null;
    for (let line = start; line <= end; line++) {
      if (quiet[line - 1] !== true) open ??= line;
      else if (open !== null) {
        kept.push([open, line - 1]);
        open = null;
      }
    }
    if (open !== null) kept.push([open, end]);
  }
  return kept;
}

const touches = (ranges: readonly LineRange[], from: number, to: number): boolean => ranges.some(([start, end]) => start <= to && end >= from);

/** The innermost span around a line. */
function around(spans: readonly Span[], from: number, to: number): Span | null {
  let best: Span | null = null;
  for (const span of spans) {
    if (span.line > from || span.endLine < to) continue;
    if (!best || span.endLine - span.line <= best.endLine - best.line) best = span;
  }
  return best;
}

/** The nodes of one file that its changed lines are in, and whether any changed line is in none of them. */
function seedsOfFile(graph: Graph, file: ChangedFile, spans: readonly Span[]): { ids: Set<string>; fileLevel: boolean } {
  const ids = new Set<string>();
  const owned = graph
    .out(fileId(file.path), OWNED)
    .filter((edge) => edge.line !== null)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (file.status === "untracked") {
    for (const span of spans) ids.add(span.id);
    for (const edge of owned) ids.add(edge.dst);
    return { ids, fileLevel: true };
  }

  // In a file without symbols (a migration), a table definition runs to the next thing the file
  // defines. Everywhere else a table or an env key is the one line it is written on.
  const bare = spans.length === 0;
  const areas: Span[] = owned.map((edge, index) => {
    const line = edge.line ?? 0;
    const next = owned.slice(index + 1).find((other) => (other.line ?? 0) > line)?.line ?? Infinity;
    return { id: edge.dst, line, endLine: bare && edge.kind === "defines_table" ? next - 1 : line };
  });
  for (const area of areas) {
    if (touches(file.ranges, area.line, area.endLine) || file.gaps.some((gap) => gap >= area.line && gap < area.endLine)) ids.add(area.id);
  }

  const holders = bare ? areas : spans;
  let fileLevel = file.status === "renamed";
  for (const [start, end] of file.ranges) {
    for (let line = start; line <= end; line++) {
      const holder = around(holders, line, line);
      if (!holder) {
        fileLevel = true;
        continue;
      }
      ids.add(holder.id);
      // The lines up to the end of this holder are in it too, except where a smaller one starts inside it.
      const inner = holders.filter((other) => other.line > line && other.line <= holder.endLine).map((other) => other.line - 1);
      line = Math.min(end, holder.endLine, ...inner);
    }
  }
  for (const gap of file.gaps) {
    // Lines were taken out between `gap` and the line after it: inside a holder only when both are.
    const holder = gap > 0 ? around(holders, gap, gap + 1) : null;
    if (holder) ids.add(holder.id);
    else fileLevel = true;
  }
  return { ids, fileLevel };
}

const INDEX_NAMES = new Set(["index", "__init__", "mod", "lib", "main"]);

/** A path without its extensions, one at a time: `a/order.service.js` gives itself, `a/order.service` and `a/order`. */
function stems(path: string): string[] {
  const all = [path];
  for (let rest = path; /[^/]\.[^./]+$/.test(rest); ) all.push((rest = rest.replace(/\.[^./]+$/, "")));
  return all;
}

/**
 * Unresolved imports that name a file this change took away. The graph has no edge left to follow
 * for these. A relative path is worked out from the importing file and must lead to the file that
 * is gone; any other form (`jobs.utils`, `crate::outbox::Thing`) is matched by its last names.
 */
function brokenImports(files: readonly ChangedFile[], unresolved: readonly UnresolvedImport[]): ChangesResult["broken"] {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const file of files) {
    const path = file.status === "deleted" ? file.path : file.from;
    if (!path) continue;
    const stem = path.replace(/\.[^./]+$/, "");
    const name = stem.split("/").pop() ?? stem;
    const folder = stem.split("/").slice(0, -1);
    byPath.set(stem, path);
    // An `index` file is imported by its folder.
    if (INDEX_NAMES.has(name) && folder.length > 0) byPath.set(folder.join("/"), path);
    byName.set(INDEX_NAMES.has(name) ? (folder.at(-1) ?? name) : name, path);
  }
  if (byPath.size === 0) return [];
  const broken: ChangesResult["broken"] = [];
  for (const item of unresolved) {
    let gone: string | undefined;
    if (/^\.{1,2}\//.test(item.specifier)) {
      const target = posix.normalize(posix.join(posix.dirname(item.file), item.specifier));
      gone = stems(target).flatMap((stem) => byPath.get(stem) ?? [])[0];
    } else {
      const parts = item.specifier.split(/[/.:\\]+/).filter(Boolean);
      gone = [parts.at(-1), parts.at(-2)].flatMap((name) => (name ? (byName.get(name) ?? []) : []))[0];
    }
    if (gone) broken.push({ file: item.file, line: item.line, specifier: item.specifier, gone });
  }
  return broken.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** Everything a test file depends on, however indirectly: what it imports and calls, and what those import and call. */
function reachedByTests(graph: Graph): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string): void => {
    if (reached.has(id)) return;
    reached.add(id);
    queue.push(id);
  };
  for (const node of graph.nodes.values()) if (node.kind === "file" && isTestPath(node.name)) visit(node.id);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const node = graph.node(id);
    // Loading a file runs its top level and makes its symbols available, so all of them count.
    if (node?.kind === "file") for (const edge of graph.out(id, DEFINES)) visit(edge.dst);
    for (const edge of graph.out(id, DEPENDENCY_KINDS)) visit(edge.dst);
  }
  return reached;
}

/**
 * What a set of changed lines means for the rest of the repository: the nodes the lines are in,
 * everything that depends on those, which tests to run, and which changed code no test depends on.
 * Lines outside any symbol count against the file itself, so its importers are affected but the
 * callers of its untouched functions are not.
 */
export function changes(
  graph: Graph,
  comparison: { base: string; commit: string; files: readonly ChangedFile[] },
  spansOf: (path: string) => readonly Span[],
  unresolved: readonly UnresolvedImport[] = [],
  maxDepth = Infinity,
  unbound: (name: string) => readonly UnboundCall[] = () => [],
): ChangesResult {
  const changed: ChangedEntry[] = [];
  const outside: ChangesResult["outside"] = [];
  const seeds = new Set<string>();

  for (const file of comparison.files) {
    const node = file.status === "deleted" ? undefined : graph.node(fileId(file.path));
    if (!node) {
      outside.push({ file: file.path, status: file.status });
      continue;
    }
    const spans = spansOf(file.path).filter((span) => graph.node(span.id));
    const { ids, fileLevel } = seedsOfFile(graph, file, spans);
    const nodes = [...ids].flatMap((id) => graph.node(id) ?? []).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.id < b.id ? -1 : 1));
    // A file whose changed lines are in nothing the graph names still changed. One with no lines to speak of
    // (comments only, or just its permissions) did not, as far as anything depending on it goes.
    const hasLines = file.ranges.length > 0 || file.gaps.length > 0 || file.status !== "modified";
    const asFile = fileLevel || (nodes.length === 0 && hasLines);
    for (const id of ids) seeds.add(id);
    if (asFile) seeds.add(node.id);
    changed.push({ file: file.path, status: file.status, ...(file.from ? { from: file.from } : {}), nodes, fileLevel: asFile, ...(file.quiet ? { quiet: true } : {}) });
  }

  const { affected, truncated } = spread(graph, [...seeds], maxDepth);
  const byId = (a: GraphNode, b: GraphNode): number => (a.id < b.id ? -1 : 1);
  const changedFiles = changed.flatMap((entry) => graph.node(fileId(entry.file)) ?? []);
  const reached = affected.map((entry) => entry.node);
  const unique = (nodes: GraphNode[]): GraphNode[] => [...new Map(nodes.map((node) => [node.id, node])).values()].sort(byId);

  const tested = reachedByTests(graph);
  const untested = [...seeds]
    .flatMap((id) => graph.node(id) ?? [])
    .filter((node) => (node.kind === "symbol" || (node.kind === "file" && !NOT_CODE.has(node.detail))) && node.file !== null && !isTestPath(node.file))
    .filter((node) => !tested.has(node.id));

  return {
    base: comparison.base,
    commit: comparison.commit,
    changed,
    outside,
    broken: brokenImports(comparison.files, unresolved),
    affected,
    possible: possibleCallers(graph, [...seeds], affected, unbound),
    tests: unique([...changedFiles, ...reached].filter((node) => node.kind === "file" && isTestPath(node.name))),
    untested: untested.sort(byId),
    docs: unique(reached.filter((node) => node.detail === "markdown")),
    truncatedAtDepth: truncated ? maxDepth : null,
  };
}
