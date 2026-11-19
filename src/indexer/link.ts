import { posix } from "node:path";
import type { FileFacts, ImportFact, LocalFact, SymbolFact } from "../extract/index.js";
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
  /** Set for a Go module path: it names a folder (a package), and only Go files import through it. */
  language?: "go";
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
const MAX_INHERITANCE_DEPTH = 5;

/** A Go type by package folder and name. `from` is the file that wrote the name when it is in that package itself. */
interface GoType {
  folder: string;
  name: string;
  from: FileFacts | null;
}

interface Binding {
  file: string;
  imported: string;
}

function isScript(facts: FileFacts): boolean {
  return facts.language === "typescript" || facts.language === "tsx" || facts.language === "javascript";
}

/** Normalizes a repository-relative path. `""` is the repository root, `null` is outside it. */
function inside(path: string): string | null {
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === "./") return "";
  return normalized.startsWith("..") ? null : normalized.replace(/\/$/, "");
}

function scriptCandidates(base: string): string[] {
  // The repository root can only be a folder import: `require("../..")` from examples/x/index.js.
  if (base === "") return SCRIPT_EXTENSIONS.map((added) => `index${added}`);
  const candidates = [base];
  const extension = posix.extname(base);
  for (const source of COMPILED_TO_SOURCE[extension] ?? []) candidates.push(base.slice(0, -extension.length) + source);
  for (const added of SCRIPT_EXTENSIONS) candidates.push(base + added);
  for (const added of SCRIPT_EXTENSIONS) candidates.push(`${base}/index${added}`);
  return candidates;
}

const folderOf = (path: string): string => (posix.dirname(path) === "." ? "" : posix.dirname(path));

/** A Go import outside the repository: the standard library by its path, a hosted module by host/owner/name. */
function goModuleName(specifier: string): string {
  const parts = specifier.split("/");
  return (parts[0] ?? "").includes(".") ? parts.slice(0, 3).join("/") : specifier;
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
  private readonly bindingCache = new Map<string, Map<string, Binding>>();
  /** Class symbol id → where it is declared, to follow `extends`. */
  private readonly classes = new Map<string, { facts: FileFacts; symbol: SymbolFact }>();
  /** Go: folder → its files, non-test files first. A folder is a package. */
  private readonly goFolders = new Map<string, FileFacts[]>();
  /** Go: file → the folder each import alias stands for. */
  private readonly goPackages = new Map<string, Map<string, string>>();
  private readonly aliases: PathAlias[];

  private readonly files: FileFacts[];

  constructor(files: FileFacts[], options: LinkOptions) {
    this.files = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.aliases = [...(options.aliases ?? [])].sort((a, b) => b.scope.length - a.scope.length || b.prefix.length - a.prefix.length);
    for (const facts of this.files) {
      this.byPath.set(facts.path, facts);
      this.symbols.set(facts.path, new Map(facts.symbols.map((symbol) => [symbol.name, symbol])));
      for (const symbol of facts.symbols) if (symbol.kind === "class") this.classes.set(symbolId(facts.path, symbol.name), { facts, symbol });
      if (facts.language === "go") {
        const folder = folderOf(facts.path);
        const files = this.goFolders.get(folder) ?? [];
        this.goFolders.set(folder, files);
        files.push(facts);
      }
    }
    const isTest = (facts: FileFacts) => (facts.path.endsWith("_test.go") ? 1 : 0);
    for (const files of this.goFolders.values()) files.sort((a, b) => isTest(a) - isTest(b) || (a.path < b.path ? -1 : 1));
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
      return { file: base === null ? null : this.firstIndexed(scriptCandidates(base)), local: true };
    }
    for (const alias of this.aliases) {
      if (alias.language || (alias.scope && !from.startsWith(`${alias.scope}/`))) continue;
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

  // ---------- Go ----------

  /** The folder a Go import path names, when a go.mod of this repository covers it. */
  private resolveGo(specifier: string): { folder: string | null; local: boolean } {
    for (const alias of this.aliases) {
      if (alias.language !== "go") continue;
      if (alias.exact ? specifier !== alias.prefix : !specifier.startsWith(alias.prefix)) continue;
      const folder = ((alias.targets[0] ?? "") + (alias.exact ? "" : specifier.slice(alias.prefix.length))).replace(/\/$/, "");
      return { folder: this.goFolders.has(folder) ? folder : null, local: true };
    }
    return { folder: null, local: false };
  }

  /** The files a Go import of `folder` reaches: its non-test files, which all share one package name. */
  private goPackageFiles(folder: string): FileFacts[] {
    return (this.goFolders.get(folder) ?? []).filter((file) => !file.path.endsWith("_test.go") && !file.package?.endsWith("_test"));
  }

  private goDeclares(file: FileFacts, name: string): boolean {
    return this.symbols.get(file.path)?.has(name) === true || file.exports.some((declared) => declared.exported === name);
  }

  /**
   * A Go file depends on the files of a package that declare what it uses. A type it uses also
   * brings the files that hold its methods. When a used name cannot be placed, or nothing is used
   * by name (a blank or dot import), it depends on all of the package's files.
   */
  private addGoImports(facts: FileFacts): void {
    const from = fileId(facts.path);
    const packages = new Map<string, string>();
    this.goPackages.set(facts.path, packages);
    for (const fact of facts.imports) {
      const { folder, local } = this.resolveGo(fact.specifier);
      if (folder === null) {
        if (local) this.unresolved.push({ file: facts.path, specifier: fact.specifier, line: fact.line });
        else {
          const name = goModuleName(fact.specifier);
          this.edge(from, this.node({ id: moduleId(name), kind: "module", name, file: null, line: null, detail: "go" }), "imports", fact.line);
        }
        continue;
      }
      const files = this.goPackageFiles(folder);
      for (const name of fact.names) packages.set(name.local, folder);
      // Without an alias the package is used under its own name, which need not be the folder's.
      const declared = files[0]?.package;
      if (declared && !packages.has(declared) && fact.names.length > 0) packages.set(declared, folder);

      const members = fact.members ?? [];
      const placed = members.every((member) => files.some((file) => this.goDeclares(file, member)));
      const used = files.filter((file) => {
        const own = this.symbols.get(file.path);
        return members.some((member) => this.goDeclares(file, member) || [...(own?.keys() ?? [])].some((name) => name.startsWith(`${member}.`)));
      });
      for (const file of placed && used.length > 0 ? used : files) this.edge(from, fileId(file.path), "imports", fact.line);
    }
  }

  /**
   * A name of a package: in `from` itself first, then in the other files of the same package.
   * Seen from another package (`from` is null), only its non-test files count.
   */
  private goSymbol(folder: string, name: string, from: FileFacts | null): string | null {
    if (from && this.symbols.get(from.path)?.has(name)) return symbolId(from.path, name);
    const files = from ? (this.goFolders.get(folder) ?? []).filter((file) => file.package === from.package) : this.goPackageFiles(folder);
    for (const file of files) if (this.symbols.get(file.path)?.has(name)) return symbolId(file.path, name);
    return null;
  }

  /** Where a type name written in `facts` lives: `T` in its own package, `pkg.T` in an imported one. */
  private goType(facts: FileFacts, written: string): GoType | null {
    const [first, second] = written.split(".");
    if (second === undefined) return first ? { folder: folderOf(facts.path), name: first, from: facts } : null;
    const folder = first ? this.goPackages.get(facts.path)?.get(first) : undefined;
    return folder === undefined ? null : { folder, name: second, from: null };
  }

  private goDeclaration(type: GoType): { facts: FileFacts; symbol: SymbolFact } | null {
    const id = this.goSymbol(type.folder, type.name, type.from);
    const declared = id ? this.classes.get(id) : undefined;
    return declared ?? null;
  }

  /** A method of a Go type: declared in any file of its package, or promoted from a type it embeds. */
  private goMethod(type: GoType | null, method: string, depth = 0): string | null {
    if (!type) return null;
    const own = this.goSymbol(type.folder, `${type.name}.${method}`, type.from);
    if (own || depth >= MAX_INHERITANCE_DEPTH) return own;
    const declared = this.goDeclaration(type);
    if (!declared) return null;
    for (const embedded of declared.symbol.embeds ?? []) {
      const promoted = this.goMethod(this.goType(declared.facts, embedded), method, depth + 1);
      if (promoted) return promoted;
    }
    return null;
  }

  private goCall(facts: FileFacts, call: FileFacts["calls"][number]): string | null {
    const [receiver, field] = call.receiver?.split(".") ?? [];
    // `ID(x)` and `pkg.ID(x)` on a type are conversions, not calls.
    const callable = (id: string | null) => (id && this.nodes.get(id)?.detail !== "class" ? id : null);
    if (!receiver) return this.local(facts, call.callee, call.line, call.column) ? null : callable(this.goSymbol(folderOf(facts.path), call.callee, facts));
    const local = this.local(facts, receiver, call.line, call.column);
    if (!local) {
      // `pkg.Func()`: only exported names are visible from another package.
      const folder = field === undefined ? this.goPackages.get(facts.path)?.get(receiver) : undefined;
      return folder !== undefined && /^[A-Z]/.test(call.callee) ? callable(this.goSymbol(folder, call.callee, null)) : null;
    }
    const type = local.kind === "instance" && local.type ? this.goType(facts, local.type) : null;
    if (field === undefined) return this.goMethod(type, call.callee);
    // `s.store.Load()`: the type of the field is written in the struct, in the terms of the file that declares it.
    const declared = type ? this.goDeclaration(type) : null;
    const fieldType = declared?.symbol.fields?.[field];
    return declared && fieldType ? this.goMethod(this.goType(declared.facts, fieldType), call.callee) : null;
  }

  private addImports(facts: FileFacts): void {
    if (facts.language === "go") return this.addGoImports(facts);
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
    const cached = this.bindingCache.get(facts.path);
    if (cached) return cached;
    const bindings = new Map<string, Binding>();
    this.bindingCache.set(facts.path, bindings);
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
    // `export { a as b }`, `export default a`, `module.exports = a`: the name stands for a local one.
    const alias = facts?.exports.find((candidate) => candidate.exported === name);
    const aliased = facts && alias ? this.resolveName(facts, alias.local, hops + 1) : null;
    if (aliased) return aliased;
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

  /** A top-level name as written in this file: one of its symbols, or what it imported under that name. */
  private resolveName(facts: FileFacts, name: string, hops = 0): string | null {
    if (this.symbols.get(facts.path)?.has(name)) return symbolId(facts.path, name);
    const binding = this.bindings(facts).get(name);
    if (!binding || binding.imported === "*") return null;
    return this.findExport(binding.file, binding.imported === "=" ? "default" : binding.imported, hops);
  }

  /** What `name` is at `line`, when the file says so itself: the latest declaration still in scope. */
  private local(facts: FileFacts, name: string, line: number, column?: number): LocalFact | null {
    let best: LocalFact | null = null;
    for (const local of facts.locals) {
      if (local.name !== name || line < local.line || line > local.endLine) continue;
      // On the line where the scope opens, only what comes after its start is inside it.
      if (line === local.line && column !== undefined && local.column !== undefined && column < local.column) continue;
      if (!best || local.line > best.line || (local.line === best.line && local.endLine < best.endLine)) best = local;
    }
    return best;
  }

  /** A method of a class, looked up through the classes it extends. */
  private memberOf(classId: string, name: string, depth = 0): string | null {
    const member = `${classId}.${name}`;
    if (this.nodes.has(member)) return member;
    const declared = this.classes.get(classId);
    if (!declared?.symbol.extends || depth >= MAX_INHERITANCE_DEPTH) return null;
    const parent = this.resolveName(declared.facts, declared.symbol.extends);
    return parent && parent !== classId ? this.memberOf(parent, name, depth + 1) : null;
  }

  private instanceMember(facts: FileFacts, local: LocalFact, name: string): string | null {
    const owner = local.type ? this.resolveName(facts, local.type) : null;
    return owner ? this.memberOf(owner, name) : null;
  }

  /** `object.property`, where `object` is a name in this file: a typed local, a symbol, or an import. */
  private resolveMember(facts: FileFacts, object: string, property: string, line: number, column?: number): string | null {
    const local = this.local(facts, object, line, column);
    if (local?.kind === "instance") return this.instanceMember(facts, local, property);
    if (local) return null;
    if (this.symbols.get(facts.path)?.has(object)) return this.memberOf(symbolId(facts.path, object), property);
    const binding = this.bindings(facts).get(object);
    if (!binding) return null;
    if (binding.imported === "*") return this.findExport(binding.file, property);
    // What `require()` returned: its named exports, or the members of the one value it exports.
    const named = binding.imported === "=" ? this.findExport(binding.file, property) : null;
    if (named) return named;
    const exported = binding.imported === "=" ? "default" : binding.imported;
    const owner = this.findExport(binding.file, exported);
    return (owner ? this.memberOf(owner, property) : null) ?? (exported === "default" ? this.findExport(binding.file, `default.${property}`) : null);
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
    for (const call of facts.calls) {
      const caller = this.enclosing(facts, call.line);
      let target: string | null = null;

      const classId = caller?.name.includes(".") ? symbolId(facts.path, caller.name.split(".")[0] ?? "") : null;
      if (facts.language === "go") {
        target = this.goCall(facts, call);
      } else if (call.receiver === null) {
        // `const { parse } = db; parse()` is a call of `db.parse`.
        // A local of that name hides any function of the file: when it cannot be followed, nothing is linked.
        const local = this.local(facts, call.callee, call.line, call.column);
        if (!local) target = this.resolveName(facts, call.callee);
        else if (local.kind === "member" && local.object && local.property) target = this.resolveMember(facts, local.object, local.property, local.line, local.column);
      } else if (call.receiver === "this" || call.receiver === "self" || call.receiver === "cls") {
        if (classId) target = this.memberOf(classId, call.callee);
      } else if (call.receiver === "super") {
        const declared = classId ? this.classes.get(classId) : undefined;
        const parent = declared?.symbol.extends ? this.resolveName(declared.facts, declared.symbol.extends) : null;
        if (parent) target = this.memberOf(parent, call.callee);
      } else if (call.receiver.startsWith("this.")) {
        const field = this.local(facts, call.receiver, call.line, call.column);
        if (field?.kind === "instance") target = this.instanceMember(facts, field, call.callee);
      } else {
        target = this.resolveMember(facts, call.receiver, call.callee, call.line, call.column);
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
