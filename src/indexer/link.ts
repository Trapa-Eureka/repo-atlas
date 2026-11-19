import { posix } from "node:path";
import type { FileFacts, ImportFact, SymbolFact } from "../extract/index.js";
import { envId, fileId, moduleId, symbolId, tableId, type EdgeKind, type GraphEdge, type GraphNode } from "../graph/types.js";

/** One `paths` entry of a tsconfig, or a workspace package, both reduced to "prefix → folders to try". */
export interface PathAlias {
  /** Folder the alias applies to (`""` for the whole repository). */
  scope: string;
  /** Import text before the `*`, e.g. `@/`. For an exact alias, the whole specifier. */
  prefix: string;
  exact: boolean;
  /** Repository-relative path prefixes the rest of the specifier is appended to. */
  targets: string[];
}

export interface LinkOptions {
  aliases?: PathAlias[];
}

export interface UnresolvedImport {
  file: string;
  specifier: string;
  line: number;
}

export interface LinkResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedImport[];
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const COMPILED_TO_SOURCE: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const MAX_REEXPORT_HOPS = 4;

interface Binding {
  file: string;
  imported: string;
}

function isScript(facts: FileFacts): boolean {
  return facts.language === "typescript" || facts.language === "tsx" || facts.language === "javascript";
}

function inside(path: string): string | null {
  const normalized = posix.normalize(path);
  return normalized.startsWith("..") || normalized === "." ? null : normalized.replace(/\/$/, "");
}

function scriptCandidates(base: string): string[] {
  const candidates = [base];
  const extension = posix.extname(base);
  for (const source of COMPILED_TO_SOURCE[extension] ?? []) candidates.push(base.slice(0, -extension.length) + source);
  for (const added of SCRIPT_EXTENSIONS) candidates.push(base + added);
  for (const added of SCRIPT_EXTENSIONS) candidates.push(`${base}/index${added}`);
  return candidates;
}

function externalPackage(specifier: string, python: boolean): string {
  if (python) return specifier.split(".")[0] ?? specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

class Linker {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly unresolved: UnresolvedImport[] = [];
  private readonly byPath = new Map<string, FileFacts>();
  private readonly symbols = new Map<string, Map<string, SymbolFact>>();
  private readonly symbolsByShortName = new Map<string, string[]>();
  private readonly resolvedImports = new Map<string, Map<ImportFact, string>>();
  private readonly pythonSuffixCache = new Map<string, string | null>();
  private readonly submodules = new Map<string, Map<string, string>>();
  private readonly aliases: PathAlias[];

  private readonly files: FileFacts[];

  constructor(files: FileFacts[], options: LinkOptions) {
    this.files = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.aliases = [...(options.aliases ?? [])].sort((a, b) => b.scope.length - a.scope.length || b.prefix.length - a.prefix.length);
    for (const facts of this.files) {
      this.byPath.set(facts.path, facts);
      this.symbols.set(facts.path, new Map(facts.symbols.map((symbol) => [symbol.name, symbol])));
    }
  }

  run(): LinkResult {
    for (const facts of this.files) this.addFileAndSymbols(facts);
    for (const facts of this.files) this.addImports(facts);
    for (const facts of this.files) {
      this.addCalls(facts);
      this.addTablesAndEnvs(facts);
    }
    for (const facts of this.files) this.addDocRefs(facts);

    const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      nodes: [...this.nodes.values()].sort((a, b) => byId(a.id, b.id)),
      edges: [...this.edges.values()].sort((a, b) => byId(a.src, b.src) || byId(a.dst, b.dst) || byId(a.kind, b.kind)),
      unresolved: this.unresolved,
    };
  }

  private node(node: GraphNode): string {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
    return node.id;
  }

  private edge(src: string, dst: string, kind: EdgeKind, line: number | null): void {
    if (src === dst) return;
    const key = `${src}\u0000${dst}\u0000${kind}`;
    if (!this.edges.has(key)) this.edges.set(key, { src, dst, kind, line });
  }

  private addFileAndSymbols(facts: FileFacts): void {
    const file = this.node({ id: fileId(facts.path), kind: "file", name: facts.path, file: facts.path, line: null, detail: facts.language });
    for (const symbol of facts.symbols) {
      const id = this.node({ id: symbolId(facts.path, symbol.name), kind: "symbol", name: symbol.name, file: facts.path, line: symbol.line, detail: symbol.kind });
      this.edge(file, id, "defines", symbol.line);
      for (const key of new Set([symbol.name, symbol.name.split(".").pop() ?? symbol.name])) {
        const list = this.symbolsByShortName.get(key);
        if (list) list.push(id);
        else this.symbolsByShortName.set(key, [id]);
      }
    }
  }

  // ---------- imports ----------

  private firstIndexed(candidates: string[]): string | null {
    return candidates.find((candidate) => this.byPath.has(candidate)) ?? null;
  }

  private resolveScript(from: string, specifier: string): { file: string | null; local: boolean } {
    if (specifier.startsWith(".")) {
      const base = inside(posix.join(posix.dirname(from), specifier));
      return { file: base ? this.firstIndexed(scriptCandidates(base)) : null, local: true };
    }
    for (const alias of this.aliases) {
      if (alias.scope && !from.startsWith(`${alias.scope}/`)) continue;
      const matches = alias.exact ? specifier === alias.prefix : specifier.startsWith(alias.prefix);
      if (!matches) continue;
      const rest = alias.exact ? "" : specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const base = inside(target + rest);
        const file = base ? this.firstIndexed(scriptCandidates(base)) : null;
        if (file) return { file, local: true };
      }
      if (alias.prefix !== "") return { file: null, local: true };
    }
    return { file: null, local: false };
  }

  private pythonModule(base: string): string | null {
    return this.firstIndexed([`${base}.py`, `${base}/__init__.py`]);
  }

  private resolvePython(from: string, specifier: string): { file: string | null; local: boolean } {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
    if (dots > 0) {
      let folder = posix.dirname(from);
      for (let i = 1; i < dots; i++) folder = posix.dirname(folder);
      const base = inside(posix.join(folder, rest));
      const file = base ? this.pythonModule(base) : rest === "" ? this.firstIndexed([posix.join(folder, "__init__.py")]) : null;
      return { file, local: true };
    }
    const direct = this.pythonModule(rest);
    if (direct) return { file: direct, local: true };
    if (!this.pythonSuffixCache.has(rest)) {
      const matches = [...this.byPath.keys()].filter((path) => path.endsWith(`/${rest}.py`) || path.endsWith(`/${rest}/__init__.py`));
      this.pythonSuffixCache.set(rest, matches.length === 1 ? (matches[0] ?? null) : null);
    }
    const file = this.pythonSuffixCache.get(rest) ?? null;
    return { file, local: file !== null };
  }

  private addImports(facts: FileFacts): void {
    const python = facts.language === "python";
    if (!python && !isScript(facts)) return;
    const from = fileId(facts.path);
    const resolved = new Map<ImportFact, string>();
    this.resolvedImports.set(facts.path, resolved);

    const submodules = new Map<string, string>();
    this.submodules.set(facts.path, submodules);

    for (const fact of facts.imports) {
      const { file, local } = python ? this.resolvePython(facts.path, fact.specifier) : this.resolveScript(facts.path, fact.specifier);
      let foundSubmodule = false;
      for (const name of python ? fact.names : []) {
        if (name.imported === "*") continue;
        const separator = fact.specifier.endsWith(".") ? "" : ".";
        const submodule = this.resolvePython(facts.path, `${fact.specifier}${separator}${name.imported}`).file;
        if (!submodule) continue;
        foundSubmodule = true;
        submodules.set(name.local, submodule);
        this.edge(from, fileId(submodule), "imports", fact.line);
      }
      if (foundSubmodule && !file) continue;
      if (file) {
        resolved.set(fact, file);
        this.edge(from, fileId(file), "imports", fact.line);
        continue;
      }
      if (local) {
        const extension = posix.extname(fact.specifier);
        if (python || extension === "" || SCRIPT_EXTENSIONS.includes(extension)) {
          this.unresolved.push({ file: facts.path, specifier: fact.specifier, line: fact.line });
        }
        continue;
      }
      const name = externalPackage(fact.specifier, python);
      this.edge(from, this.node({ id: moduleId(name), kind: "module", name, file: null, line: null, detail: python ? "python" : "npm" }), "imports", fact.line);
    }
  }

  // ---------- calls ----------

  private bindings(facts: FileFacts): Map<string, Binding> {
    const bindings = new Map<string, Binding>();
    const resolved = this.resolvedImports.get(facts.path);
    for (const fact of facts.imports) {
      if (fact.reexport) continue;
      const file = resolved?.get(fact);
      if (!file) continue;
      for (const name of fact.names) bindings.set(name.local, { file, imported: name.imported });
    }
    for (const [local, file] of this.submodules.get(facts.path) ?? []) bindings.set(local, { file, imported: "*" });
    return bindings;
  }

  private findExport(path: string, name: string, hops = 0): string | null {
    const own = this.symbols.get(path);
    const symbol = name === "default" ? [...(own?.values() ?? [])].find((candidate) => candidate.isDefault) : own?.get(name);
    if (symbol) return symbolId(path, symbol.name);
    if (hops >= MAX_REEXPORT_HOPS) return null;
    const facts = this.byPath.get(path);
    const resolved = this.resolvedImports.get(path);
    for (const fact of facts?.imports ?? []) {
      if (!fact.reexport) continue;
      const target = resolved?.get(fact);
      if (!target) continue;
      const passed = fact.star ? name : fact.names.find((candidate) => candidate.local === name)?.imported;
      const found = passed ? this.findExport(target, passed, hops + 1) : null;
      if (found) return found;
    }
    return null;
  }

  private enclosing(facts: FileFacts, line: number): SymbolFact | null {
    let best: SymbolFact | null = null;
    for (const symbol of facts.symbols) {
      if (line < symbol.line || line > symbol.endLine) continue;
      if (!best || symbol.endLine - symbol.line <= best.endLine - best.line) best = symbol;
    }
    return best;
  }

  private addCalls(facts: FileFacts): void {
    if (facts.calls.length === 0) return;
    const own = this.symbols.get(facts.path) ?? new Map<string, SymbolFact>();
    const bindings = this.bindings(facts);

    for (const call of facts.calls) {
      const caller = this.enclosing(facts, call.line);
      let target: string | null = null;

      if (call.receiver === null) {
        const binding = bindings.get(call.callee);
        if (own.has(call.callee)) target = symbolId(facts.path, call.callee);
        else if (binding && binding.imported !== "*") target = this.findExport(binding.file, binding.imported);
      } else if (call.receiver === "this" || call.receiver === "self" || call.receiver === "cls") {
        const className = caller?.name.includes(".") ? caller.name.split(".")[0] : null;
        if (className && own.has(`${className}.${call.callee}`)) target = symbolId(facts.path, `${className}.${call.callee}`);
      } else {
        const binding = bindings.get(call.receiver);
        if (own.has(`${call.receiver}.${call.callee}`)) target = symbolId(facts.path, `${call.receiver}.${call.callee}`);
        else if (binding?.imported === "*") target = this.findExport(binding.file, call.callee);
        else if (binding) {
          const owner = this.findExport(binding.file, binding.imported);
          const member = owner ? `${owner}.${call.callee}` : null;
          if (member && this.nodes.has(member)) target = member;
        }
      }

      if (!target) continue;
      const src = caller ? symbolId(facts.path, caller.name) : fileId(facts.path);
      this.edge(src, target, "calls", call.line);
    }
  }

  // ---------- tables, env, docs ----------

  private addTablesAndEnvs(facts: FileFacts): void {
    const from = fileId(facts.path);
    for (const table of facts.tables) {
      const id = this.node({ id: tableId(table.name), kind: "table", name: table.name, file: null, line: null, detail: null });
      const kind = table.op === "define" ? "defines_table" : table.op === "write" ? "writes_table" : "reads_table";
      this.edge(from, id, kind, table.line);
      const node = this.nodes.get(id);
      if (table.op === "define" && node && !node.file) {
        node.file = facts.path;
        node.line = table.line;
      }
    }
    for (const env of facts.envs) {
      const id = this.node({ id: envId(env.name), kind: "env", name: env.name, file: null, line: null, detail: null });
      this.edge(from, id, env.op === "declare" ? "declares_env" : "uses_env", env.line);
    }
  }

  private fileForDocTarget(doc: string, target: string): string | null {
    const cleaned = target.replace(/^\.\//, "");
    const relative = inside(posix.join(posix.dirname(doc), target));
    if (relative && this.byPath.has(relative)) return relative;
    const fromRoot = inside(cleaned.replace(/^\//, ""));
    if (fromRoot && this.byPath.has(fromRoot)) return fromRoot;
    if (!cleaned.includes("/") && !cleaned.includes(".")) return null;
    const matches = [...this.byPath.keys()].filter((path) => path.endsWith(`/${cleaned}`));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private addDocRefs(facts: FileFacts): void {
    if (facts.docRefs.length === 0) return;
    const from = fileId(facts.path);
    for (const ref of facts.docRefs) {
      const path = /^[\w@./-]+$/.test(ref.target) ? this.fileForDocTarget(facts.path, ref.target) : null;
      if (path) {
        this.edge(from, fileId(path), "documents", ref.line);
        continue;
      }
      if (ref.kind !== "code") continue;
      const token = ref.target.replace(/\(\)$/, "");
      if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(token) || token.length < 3) continue;
      const symbols = this.symbolsByShortName.get(token) ?? [];
      const [only] = symbols;
      if (symbols.length === 1 && only) this.edge(from, only, "documents", ref.line);
      else if (this.nodes.has(tableId(token)) && token === token.toLowerCase()) this.edge(from, tableId(token), "documents", ref.line);
      else if (this.nodes.has(envId(token))) this.edge(from, envId(token), "documents", ref.line);
    }
  }
}

/** Turns per-file facts into one graph. Pure: the same facts always give the same nodes and edges. */
export function link(files: FileFacts[], options: LinkOptions = {}): LinkResult {
  return new Linker(files, options).run();
}
