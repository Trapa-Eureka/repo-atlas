import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyFacts } from "../extract/facts.js";
import { EXTRACTOR_VERSION, extractFile, languageOf, type FileFacts } from "../extract/index.js";
import type { FileState, Store } from "../store/store.js";
import { loadAliases } from "./aliases.js";
import { link, type UnresolvedImport } from "./link.js";
import { walk } from "./walk.js";

export interface IndexSummary {
  files: number;
  parsed: number;
  unchanged: number;
  removed: number;
  failed: string[];
  skippedLarge: number;
  nodes: number;
  edges: number;
  unresolvedImports: number;
  relinked: boolean;
  milliseconds: number;
}

export interface IndexOptions {
  /** Re-parse every file even when it looks unchanged. */
  full?: boolean;
}

const META_VERSION = "extractor_version";
const META_ALIASES = "aliases";
const META_SUMMARY = "summary";
const META_UNRESOLVED = "unresolved";

/** Whether the stored index was built by this version. One that was not lacks what newer queries read, and has to be rebuilt before it is answered from. */
export function isCurrent(store: Store): boolean {
  return store.getMeta(META_VERSION) === String(EXTRACTOR_VERSION);
}

export function lastSummary(store: Store): IndexSummary | null {
  const raw = store.getMeta(META_SUMMARY);
  return raw ? (JSON.parse(raw) as IndexSummary) : null;
}

export function unresolvedImports(store: Store): UnresolvedImport[] {
  const raw = store.getMeta(META_UNRESOLVED);
  return raw ? (JSON.parse(raw) as UnresolvedImport[]) : [];
}

/**
 * Brings the index up to date with the working tree. A file is re-parsed only when its size or
 * modification time changed and its content hash differs; the graph is re-linked only when some
 * file's facts or the import aliases changed.
 */
export async function indexRepository(root: string, store: Store, options: IndexOptions = {}): Promise<IndexSummary> {
  const started = performance.now();
  const walked = walk(root);
  const known = store.fileStates();
  const full = options.full === true || store.getMeta(META_VERSION) !== String(EXTRACTOR_VERSION);

  const aliases = loadAliases(root, walked.configs);
  const aliasesJson = JSON.stringify(aliases);
  let changed = full || store.getMeta(META_ALIASES) !== aliasesJson || store.getMeta(META_SUMMARY) === null;

  const summary: IndexSummary = {
    files: walked.files.length,
    parsed: 0,
    unchanged: 0,
    removed: 0,
    failed: [],
    skippedLarge: walked.skippedLarge,
    nodes: 0,
    edges: 0,
    unresolvedImports: 0,
    relinked: false,
    milliseconds: 0,
  };

  const pending: { path: string; source: string; state: FileState }[] = [];
  const touched: { path: string; state: FileState }[] = [];
  const seen = new Set<string>();

  for (const file of walked.files) {
    seen.add(file.path);
    const before = known.get(file.path);
    if (!full && before && before.size === file.size && before.mtimeMs === file.mtimeMs) {
      summary.unchanged++;
      continue;
    }
    let source: string;
    try {
      source = readFileSync(join(root, file.path), "utf8");
    } catch {
      seen.delete(file.path);
      continue;
    }
    const state: FileState = { hash: createHash("sha1").update(source).digest("hex"), size: file.size, mtimeMs: file.mtimeMs };
    if (!full && before?.hash === state.hash) {
      touched.push({ path: file.path, state });
      summary.unchanged++;
    } else {
      pending.push({ path: file.path, source, state });
    }
  }

  const parsed: { facts: FileFacts; state: FileState }[] = [];
  for (const file of pending) {
    try {
      parsed.push({ facts: await extractFile(file.path, file.source), state: file.state });
    } catch {
      summary.failed.push(file.path);
      const language = languageOf(file.path);
      if (language) parsed.push({ facts: emptyFacts(file.path, language), state: file.state });
    }
  }
  summary.parsed = parsed.length;
  const removed = [...known.keys()].filter((path) => !seen.has(path));
  summary.removed = removed.length;
  changed ||= parsed.length > 0 || removed.length > 0;

  store.transaction(() => {
    for (const { facts, state } of parsed) store.putFile(facts, state);
    for (const { path, state } of touched) store.touchFile(path, state);
    for (const path of removed) store.removeFile(path);

    if (changed) {
      const linked = link(store.allFacts(), { aliases });
      store.replaceGraph(linked.nodes, linked.edges);
      store.replaceUnbound(linked.unbound);
      store.setMeta(META_UNRESOLVED, JSON.stringify(linked.unresolved));
      store.setMeta(META_ALIASES, aliasesJson);
      store.setMeta(META_VERSION, String(EXTRACTOR_VERSION));
      summary.nodes = linked.nodes.length;
      summary.edges = linked.edges.length;
      summary.unresolvedImports = linked.unresolved.length;
      summary.relinked = true;
    } else {
      const previous = lastSummary(store);
      summary.nodes = previous?.nodes ?? 0;
      summary.edges = previous?.edges ?? 0;
      summary.unresolvedImports = previous?.unresolvedImports ?? 0;
    }
    summary.milliseconds = Math.round(performance.now() - started);
    store.setMeta(META_SUMMARY, JSON.stringify(summary));
  });

  return summary;
}
