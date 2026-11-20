import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileFacts } from "../extract/index.js";
import { Graph } from "../graph/graph.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";

export const DATA_FOLDER = ".atlas";
const DATABASE_FILE = "graph.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, facts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT, line INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER, PRIMARY KEY (src, dst, kind)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS unbound (name TEXT NOT NULL, src TEXT NOT NULL, line INTEGER NOT NULL, PRIMARY KEY (name, src)) WITHOUT ROWID;
`;

export interface FileState {
  hash: string;
  size: number;
  mtimeMs: number;
}

export function hasIndex(root: string): boolean {
  return existsSync(join(root, DATA_FOLDER, DATABASE_FILE));
}

/** The only module that talks to SQLite. Everything else works on facts and on the in-memory `Graph`. */
export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(root: string): Store {
    const folder = join(root, DATA_FOLDER);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, ".gitignore"), "*\n");
    }
    const db = new DatabaseSync(join(folder, DATABASE_FILE));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    // An index made before edges could be marked as inferred has no column for it. It is added empty; the next index fills it.
    const columns = db.prepare("PRAGMA table_info(edges)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "inferred")) db.exec("ALTER TABLE edges ADD COLUMN inferred INTEGER NOT NULL DEFAULT 0");
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  fileStates(): Map<string, FileState> {
    const rows = this.db.prepare("SELECT path, hash, size, mtime_ms FROM files").all() as { path: string; hash: string; size: number; mtime_ms: number }[];
    return new Map(rows.map((row) => [row.path, { hash: row.hash, size: row.size, mtimeMs: row.mtime_ms }]));
  }

  putFile(facts: FileFacts, state: FileState): void {
    this.db
      .prepare(
        "INSERT INTO files (path, hash, size, mtime_ms, facts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms, facts = excluded.facts",
      )
      .run(facts.path, state.hash, state.size, state.mtimeMs, JSON.stringify(facts));
  }

  touchFile(path: string, state: FileState): void {
    this.db.prepare("UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?").run(state.size, state.mtimeMs, path);
  }

  removeFile(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  allFacts(): FileFacts[] {
    const rows = this.db.prepare("SELECT facts FROM files ORDER BY path").all() as { facts: string }[];
    return rows.map((row) => JSON.parse(row.facts) as FileFacts);
  }

  /** The stored facts of one file, or null when the index does not hold it. */
  factsOf(path: string): FileFacts | null {
    const row = this.db.prepare("SELECT facts FROM files WHERE path = ?").get(path) as { facts: string } | undefined;
    return row ? (JSON.parse(row.facts) as FileFacts) : null;
  }

  replaceGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.db.exec("DELETE FROM edges; DELETE FROM nodes;");
    const insertNode = this.db.prepare("INSERT INTO nodes (id, kind, name, file, line, detail) VALUES (?, ?, ?, ?, ?, ?)");
    for (const node of nodes) insertNode.run(node.id, node.kind, node.name, node.file, node.line, node.detail);
    const insertEdge = this.db.prepare("INSERT INTO edges (src, dst, kind, line, inferred) VALUES (?, ?, ?, ?, ?)");
    for (const edge of edges) insertEdge.run(edge.src, edge.dst, edge.kind, edge.line, edge.inferred ? 1 : 0);
  }

  /** Replaces the calls that could not be bound, kept by the method name they use. */
  replaceUnbound(calls: { name: string; src: string; line: number }[]): void {
    this.db.exec("DELETE FROM unbound;");
    const insert = this.db.prepare("INSERT OR IGNORE INTO unbound (name, src, line) VALUES (?, ?, ?)");
    for (const call of calls) insert.run(call.name, call.src, call.line);
  }

  unboundCalls(name: string): { name: string; src: string; line: number }[] {
    return this.db.prepare("SELECT name, src, line FROM unbound WHERE name = ? ORDER BY src").all(name) as { name: string; src: string; line: number }[];
  }

  loadGraph(): Graph {
    const nodes = this.db.prepare("SELECT id, kind, name, file, line, detail FROM nodes ORDER BY id").all() as unknown as GraphNode[];
    const edges = this.db.prepare("SELECT src, dst, kind, line, inferred FROM edges ORDER BY src, dst, kind").all() as unknown as (Omit<GraphEdge, "inferred"> & { inferred: number })[];
    return new Graph(
      nodes.map((node) => ({ ...node })),
      edges.map(({ inferred, ...edge }) => (inferred ? { ...edge, inferred: true as const } : { ...edge })),
    );
  }
}
