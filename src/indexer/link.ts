import { posix } from "node:path";
import { rubyUnderscore, type CallRef, type FileFacts, type ImportFact, type LocalFact, type SymbolFact } from "../extract/index.js";
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
  /** Set for a Go module path or a Rust crate name: it names a folder, and only files of that language import through it. */
  language?: "go" | "rust";
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
const MAX_RUBY_OPENERS = 3;
// A Rails model includes dozens of modules before its parent is asked. Each is visited once per lookup, so this only bounds the cost.
const MAX_RUBY_ANCESTORS = 200;

interface Declared {
  facts: FileFacts;
  symbol: SymbolFact;
}

/** A Java import outside the repository, by the start of its package: `java.util`, `org.springframework.web`. */
function javaModuleName(specifier: string): string {
  const parts = specifier.split(".");
  const packageParts = parts.filter((part, index) => index === 0 || /^[a-z_]/.test(part));
  return packageParts.slice(0, /^(?:java|javax|jakarta|kotlin|scala|android)$/.test(parts[0] ?? "") ? 2 : 3).join(".");
}

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

/** How many leading folders two paths share: the larger, the nearer. */
function sharedSegments(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count++;
  return count;
}

/** Folders that are on the load path only for the tests inside them. */
const RUBY_TEST_ROOTS = new Set(["test", "spec"]);

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
  /** Java: fully qualified name → where the type is declared. A name can be declared in several source roots. */
  private readonly javaTypes = new Map<string, Declared[]>();
  private readonly javaPackages = new Set<string>();
  /** Ruby: full name → every place that opens the class or module. */
  private readonly rubyTypes = new Map<string, Declared[]>();
  /** Ruby: full name of a constant that is not a class → the files that assign it. */
  private readonly rubyConstants = new Map<string, FileFacts[]>();
  /** Ruby: file name without `.rb` → the files of that name, to find what a `require` names. */
  private readonly rubyByName = new Map<string, string[]>();
  /** Ruby: file → the files it requires, where its top-level methods may come from. */
  private readonly rubyRequired = new Map<string, string[]>();
  private readonly definedTables = new Set<string>();
  private readonly rustRoots = new Map<string, { dir: string; file: string }>();
  private readonly rustItems = new Map<string, { facts: FileFacts; name: string } | null>();
  private readonly aliases: PathAlias[];

  private readonly files: FileFacts[];

  constructor(files: FileFacts[], options: LinkOptions) {
    this.files = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.aliases = [...(options.aliases ?? [])].sort((a, b) => b.scope.length - a.scope.length || b.prefix.length - a.prefix.length);
    for (const facts of this.files) {
      this.byPath.set(facts.path, facts);
      this.symbols.set(facts.path, new Map(facts.symbols.map((symbol) => [symbol.name, symbol])));
      for (const symbol of facts.symbols) if (symbol.kind === "class") this.classes.set(symbolId(facts.path, symbol.name), { facts, symbol });
      if (facts.language === "java") {
        const prefix = facts.package ? `${facts.package}.` : "";
        this.javaPackages.add(facts.package ?? "");
        for (const symbol of facts.symbols) {
          if (symbol.kind !== "class") continue;
          const declared = this.javaTypes.get(prefix + symbol.name) ?? [];
          this.javaTypes.set(prefix + symbol.name, declared);
          declared.push({ facts, symbol });
        }
      }
      for (const table of facts.tables) if (table.op === "define") this.definedTables.add(table.name);
      if (facts.language === "ruby") {
        const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
          const list = map.get(key);
          if (list) list.push(value);
          else map.set(key, [value]);
        };
        for (const symbol of facts.symbols) if (symbol.kind === "class") add(this.rubyTypes, symbol.name, { facts, symbol });
        for (const constant of facts.exports) add(this.rubyConstants, constant.exported, facts);
        if (facts.path.endsWith(".rb")) add(this.rubyByName, posix.basename(facts.path, ".rb"), facts.path);
      }
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
      for (const key of new Set([symbol.name, symbol.name.split(/\.|::/).pop() ?? symbol.name])) {
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

  /** What a Go call returns, when the function it calls says so: the first result type, in the terms of the file that declares the function. */
  private goReturned(facts: FileFacts, call: CallRef, depth: number): GoType | null {
    const id = depth < MAX_INHERITANCE_DEPTH ? this.goCall(facts, call, depth + 1) : null;
    const path = id ? id.slice(4, id.indexOf("#")) : null;
    const declaring = path ? this.byPath.get(path) : undefined;
    const returns = id && path ? this.symbols.get(path)?.get(id.slice(id.indexOf("#") + 1))?.returns : undefined;
    return declaring && returns ? this.goType(declaring, returns) : null;
  }

  /** The type of a Go local: the one written for it, or the one returned by the call it was made from. */
  private goLocalType(facts: FileFacts, local: LocalFact, depth: number): GoType | null {
    if (local.kind !== "instance") return null;
    if (local.type) return this.goType(facts, local.type);
    return local.from ? this.goReturned(facts, local.from, depth) : null;
  }

  private goCall(facts: FileFacts, call: CallRef, depth = 0): string | null {
    // `ID(x)` and `pkg.ID(x)` on a type are conversions, not calls.
    const callable = (id: string | null) => (id && this.nodes.get(id)?.detail !== "class" ? id : null);
    // `a.Open().Read()`: a method of whatever the inner call returns.
    if (call.receiver === "()") return call.via ? this.goMethod(this.goReturned(facts, call.via, depth), call.callee) : null;
    const [receiver, field] = call.receiver?.split(".") ?? [];
    if (!receiver) return this.local(facts, call.callee, call.line, call.column) ? null : callable(this.goSymbol(folderOf(facts.path), call.callee, facts));
    const local = this.local(facts, receiver, call.line, call.column);
    if (!local) {
      // `pkg.Func()`: only exported names are visible from another package.
      const folder = field === undefined ? this.goPackages.get(facts.path)?.get(receiver) : undefined;
      return folder !== undefined && /^[A-Z]/.test(call.callee) ? callable(this.goSymbol(folder, call.callee, null)) : null;
    }
    const type = this.goLocalType(facts, local, depth);
    if (field === undefined) return this.goMethod(type, call.callee);
    // `s.store.Load()`: the type of the field is written in the struct, in the terms of the file that declares it.
    const declared = type ? this.goDeclaration(type) : null;
    const fieldType = declared?.symbol.fields?.[field];
    return declared && fieldType ? this.goMethod(this.goType(declared.facts, fieldType), call.callee) : null;
  }

  // ---------- Java ----------

  /** The declaration of a fully qualified name, the one nearest to `from` when several source roots declare it. */
  private javaDeclared(name: string, from: string): Declared | null {
    const declared = this.javaTypes.get(name);
    if (!declared || declared.length < 2) return declared?.[0] ?? null;
    const shared = (path: string) => sharedSegments(path, from);
    return declared.reduce((best, candidate) => (shared(candidate.facts.path) > shared(best.facts.path) ? candidate : best));
  }

  /**
   * The type a name stands for where it is written, in Java's own order: a type nested in the
   * classes around it (`within`), a top-level type of the file, a single-type import, the package,
   * a wildcard import, and last a fully qualified name.
   */
  private javaType(facts: FileFacts, written: string, within: string | null): Declared | null {
    const own = this.symbols.get(facts.path);
    for (let around = within; around; around = around.includes(".") ? around.slice(0, around.lastIndexOf(".")) : null) {
      const nested = own?.get(`${around}.${written}`);
      if (nested?.kind === "class") return { facts, symbol: nested };
    }
    const top = own?.get(written);
    if (top?.kind === "class") return { facts, symbol: top };
    const [first, ...rest] = written.split(".");
    const tail = rest.length > 0 ? `.${rest.join(".")}` : "";
    const imported = facts.imports.find((fact) => !fact.static && !fact.star && fact.names[0]?.local === first);
    const candidates = [
      ...(imported ? [imported.specifier + tail] : []),
      (facts.package ? `${facts.package}.` : "") + written,
      ...facts.imports.filter((fact) => fact.star && !fact.static).map((fact) => `${fact.specifier}.${written}`),
      written,
    ];
    for (const name of candidates) {
      const found = this.javaDeclared(name, facts.path);
      if (found) return found;
    }
    return null;
  }

  /**
   * A method of a Java type: its own or one it inherits. With `fromInside`, for a call written
   * inside the type with no receiver, also a method of the types around a nested one.
   */
  private javaMethod(type: Declared | null, method: string, fromInside = false, depth = 0): string | null {
    if (!type) return null;
    const name = type.symbol.name;
    const own = `${name}.${method}`;
    if (this.symbols.get(type.facts.path)?.has(own)) return symbolId(type.facts.path, own);
    if (depth >= MAX_INHERITANCE_DEPTH) return null;
    const parents = [...(type.symbol.extends ? [type.symbol.extends] : []), ...(type.symbol.embeds ?? [])].map((parent) => this.javaType(type.facts, parent, name));
    const outer = fromInside && name.includes(".") ? this.symbols.get(type.facts.path)?.get(name.slice(0, name.lastIndexOf("."))) : undefined;
    if (outer) parents.push({ facts: type.facts, symbol: outer });
    for (const parent of parents) {
      const found = parent && parent.symbol !== type.symbol ? this.javaMethod(parent, method, fromInside, depth + 1) : null;
      if (found) return found;
    }
    return null;
  }

  /** The innermost class of `facts` around `line`. */
  private javaOwner(facts: FileFacts, line: number): Declared | null {
    let best: SymbolFact | null = null;
    for (const symbol of facts.symbols) {
      if (symbol.kind !== "class" || line < symbol.line || line > symbol.endLine) continue;
      if (!best || symbol.endLine - symbol.line <= best.endLine - best.line) best = symbol;
    }
    return best ? { facts, symbol: best } : null;
  }

  private javaCall(facts: FileFacts, call: FileFacts["calls"][number]): string | null {
    const owner = this.javaOwner(facts, call.line);
    const within = owner?.symbol.name ?? null;
    if (call.receiver === "new") {
      const type = this.javaType(facts, call.callee, within);
      return type ? symbolId(type.facts.path, type.symbol.name) : null;
    }
    if (call.receiver === null || call.receiver === "this") {
      const own = this.javaMethod(owner, call.callee, call.receiver === null);
      if (own || call.receiver === "this") return own;
      // `import static a.Util.help` or `import static a.Util.*`
      for (const fact of facts.imports) {
        if (!fact.static || (!fact.star && fact.names[0]?.local !== call.callee)) continue;
        const found = this.javaMethod(this.javaDeclared(fact.specifier, facts.path), call.callee);
        if (found) return found;
      }
      return null;
    }
    if (call.receiver === "super") {
      const parents = owner ? [...(owner.symbol.extends ? [owner.symbol.extends] : []), ...(owner.symbol.embeds ?? [])] : [];
      for (const parent of parents) {
        const found = this.javaMethod(this.javaType(facts, parent, within), call.callee);
        if (found) return found;
      }
      return null;
    }
    const local = this.local(facts, call.receiver, call.line, call.column);
    if (local) return local.kind === "instance" && local.type ? this.javaMethod(this.javaType(facts, local.type, within), call.callee) : null;
    // `Labels.format()`: a static method of a class.
    return /^[A-Z]/.test(call.receiver) && !call.receiver.includes(".") ? this.javaMethod(this.javaType(facts, call.receiver, within), call.callee) : null;
  }

  /**
   * A Java file depends on the file of every class it names: the ones it imports, and the ones of
   * its own package or of a wildcard import, which it uses without naming their file anywhere.
   */
  private addJavaImports(facts: FileFacts): void {
    const from = fileId(facts.path);
    for (const fact of facts.imports) {
      const packageName = fact.star && !fact.static ? fact.specifier : fact.specifier.slice(0, Math.max(0, fact.specifier.lastIndexOf(".")));
      const declared = fact.star && !fact.static ? null : this.javaDeclared(fact.specifier, facts.path);
      if (declared) this.edge(from, fileId(declared.facts.path), "imports", fact.line);
      else if (this.javaPackages.has(packageName) || this.javaTypes.has(packageName)) {
        // A wildcard import of a package of this repository is settled by the names used, below.
        if (!fact.star || fact.static) this.unresolved.push({ file: facts.path, specifier: fact.specifier, line: fact.line });
      } else {
        const name = javaModuleName(fact.specifier);
        this.edge(from, this.node({ id: moduleId(name), kind: "module", name, file: null, line: null, detail: "java" }), "imports", fact.line);
      }
    }
    for (const use of facts.uses ?? []) {
      const declared = this.javaType(facts, use.name, this.javaOwner(facts, use.line)?.symbol.name ?? null);
      if (declared && declared.facts.path !== facts.path) this.edge(from, fileId(declared.facts.path), "imports", use.line);
    }
  }

  // ---------- Ruby ----------

  /** The namespaces around a line of a Ruby file, innermost first. */
  private rubyNesting(facts: FileFacts, line: number, outside = false): string[] {
    let best: NonNullable<FileFacts["namespaces"]>[number] | null = null;
    for (const space of facts.namespaces ?? []) {
      if (line < space.line || line > space.endLine) continue;
      if (!best || space.endLine - space.line <= best.endLine - best.line) best = space;
    }
    // The parent of a class is written on its first line, but outside it.
    return (outside ? best?.names.slice(1) : best?.names) ?? [];
  }

  /** The full names a constant written at `line` can stand for, in the order Ruby tries them: each namespace around it, then the top. */
  private rubyNames(facts: FileFacts, written: string, line: number, outside = false): string[] {
    if (written.startsWith("::")) return [written.slice(2)];
    return [...this.rubyNesting(facts, line, outside).map((space) => `${space}::${written}`), written];
  }

  private rubyType(facts: FileFacts, written: string, line: number, outside = false): { name: string; declared: Declared[] } | null {
    // A class cannot be its own parent: `class Admin::Users < Users` means the one further out.
    const itself = outside ? this.rubyNesting(facts, line)[0] : undefined;
    for (const name of this.rubyNames(facts, written, line, outside)) {
      const declared = name === itself ? undefined : this.rubyTypes.get(name);
      if (declared) return { name, declared };
    }
    return null;
  }

  /**
   * Of the files that open a class, the ones a user of its name depends on: the file named after it
   * (`Shop::Order` in `shop/order.rb`), nearest to `from` when several are. A class no file is named
   * after is one opened to add to it (a test helper adding to `Minitest::Test`): then every file
   * that does, up to a few.
   */
  private rubyHomes(type: { name: string; declared: Declared[] }, from: string): Declared[] {
    const conventional = `${type.name.split("::").map(rubyUnderscore).join("/")}.rb`;
    const named = type.declared.filter((declared) => declared.facts.path === conventional || declared.facts.path.endsWith(`/${conventional}`));
    if (named.length === 0 && type.declared.length <= MAX_RUBY_OPENERS) return type.declared;
    const among = named.length > 0 ? named : type.declared;
    return [among.reduce((best, candidate) => (sharedSegments(candidate.facts.path, from) > sharedSegments(best.facts.path, from) ? candidate : best))];
  }

  /** A method of a Ruby class or module: written in any file that opens it, or in what it inherits, includes or extends. */
  private rubyMethod(type: { name: string; declared: Declared[] } | null, method: string, seen = new Set<string>()): string | null {
    if (!type || seen.has(type.name) || seen.size > MAX_RUBY_ANCESTORS) return null;
    seen.add(type.name);
    const own = `${type.name}.${method}`;
    for (const declared of type.declared) if (this.symbols.get(declared.facts.path)?.has(own)) return symbolId(declared.facts.path, own);
    return this.rubyInherited(type, method, seen);
  }

  /** What a class or module gets methods and constants from, in the order Ruby asks: the modules it includes, last first, then its parent. */
  private rubyParents(type: { name: string; declared: Declared[] }): { name: string; declared: Declared[] }[] {
    const parents: { name: string; declared: Declared[] }[] = [];
    for (const { facts, symbol } of type.declared) {
      for (const mixin of [...(symbol.embeds ?? [])].reverse()) parents.push(...[this.rubyType(facts, mixin, symbol.line)].filter((found) => found !== null));
    }
    for (const { facts, symbol } of type.declared) {
      const parent = symbol.extends ? this.rubyType(facts, symbol.extends, symbol.line, true) : null;
      if (parent) parents.push(parent);
    }
    return parents.filter((parent) => parent.name !== type.name);
  }

  /** A method written outside any class: in the file itself, or in a file it requires. */
  private rubyFunction(facts: FileFacts, name: string): string | null {
    for (const path of [facts.path, ...(this.rubyRequired.get(facts.path) ?? [])]) {
      if (this.symbols.get(path)?.get(name)?.kind === "function") return symbolId(path, name);
    }
    return null;
  }

  private rubyCall(facts: FileFacts, call: FileFacts["calls"][number], caller: SymbolFact | null): string | null {
    const ownerName = caller?.kind === "method" ? caller.name.slice(0, caller.name.lastIndexOf(".")) : caller?.kind === "class" ? caller.name : null;
    const declared = ownerName ? this.rubyTypes.get(ownerName) : undefined;
    const owner = ownerName && declared ? { name: ownerName, declared } : null;
    const typeOf = (written: string) => this.rubyType(facts, written, call.line);
    if (call.receiver === null) {
      if (this.local(facts, call.callee, call.line, call.column)) return null;
      return this.rubyMethod(owner, call.callee) ?? this.rubyFunction(facts, call.callee);
    }
    if (call.receiver === "self") return this.rubyMethod(owner, call.callee);
    // `super`: the same method, as the parents have it.
    if (call.receiver === "super") return owner ? this.rubyInherited(owner, call.callee, new Set([owner.name])) : null;
    if (call.receiver.endsWith(".new")) return this.rubyMethod(typeOf(call.receiver.slice(0, -4)), call.callee);
    if (/^(?:::)?[A-Z]/.test(call.receiver)) {
      const type = typeOf(call.receiver);
      if (!type) return null;
      const found = this.rubyMethod(type, call.callee);
      if (found || call.callee !== "new") return found;
      // `Order.new` with no `self.new` of its own makes an instance: a use of the class.
      const [home] = this.rubyHomes(type, facts.path);
      return home ? symbolId(home.facts.path, type.name) : null;
    }
    const local = this.local(facts, call.receiver, call.line, call.column);
    return local?.kind === "instance" && local.type ? this.rubyMethod(typeOf(local.type), call.callee) : null;
  }

  /** A method as the parents of a class have it, not the class itself. */
  private rubyInherited(type: { name: string; declared: Declared[] }, method: string, seen: Set<string>): string | null {
    for (const parent of this.rubyParents(type)) {
      const found = this.rubyMethod(parent, method, seen);
      if (found) return found;
    }
    return null;
  }

  /**
   * The file a `require` names, by the folders Ruby programs conventionally start with on their
   * load path: a `lib/` folder anywhere (the nearest one to the requiring file), the repository
   * root, and the `test/` or `spec/` folder the requiring file is itself in.
   */
  private rubyRequire(from: string, specifier: string): string | null {
    const wanted = `${specifier.replace(/\.rb$/, "")}.rb`;
    let best: string | null = null;
    for (const path of this.rubyByName.get(posix.basename(wanted, ".rb")) ?? []) {
      if (path !== wanted && !path.endsWith(`/${wanted}`)) continue;
      const root = path.slice(0, Math.max(0, path.length - wanted.length - 1));
      const kind = posix.basename(root);
      if (root !== "" && kind !== "lib" && !(RUBY_TEST_ROOTS.has(kind) && from.startsWith(`${root}/`))) continue;
      if (best === null || sharedSegments(path, from) > sharedSegments(best, from)) best = path;
    }
    return best;
  }

  /**
   * A Ruby file depends on the files it requires, and on the file of every class, module and
   * constant it names: most Ruby code is loaded by name (Rails autoloading, one `require` at the
   * top of a gem), so the names are what say where it reaches.
   */
  private addRubyImports(facts: FileFacts): void {
    const from = fileId(facts.path);
    const required: string[] = [];
    this.rubyRequired.set(facts.path, required);
    for (const fact of facts.imports) {
      const relative = fact.specifier.startsWith(".");
      const base = relative ? inside(posix.join(posix.dirname(facts.path), fact.specifier)) : null;
      const file = relative ? (base ? this.firstIndexed([`${base.replace(/\.rb$/, "")}.rb`]) : null) : this.rubyRequire(facts.path, fact.specifier);
      if (file) {
        required.push(file);
        this.edge(from, fileId(file), "imports", fact.line);
      } else if (relative) {
        this.unresolved.push({ file: facts.path, specifier: fact.specifier, line: fact.line });
      } else {
        const name = fact.specifier.split("/")[0] ?? fact.specifier;
        this.edge(from, this.node({ id: moduleId(name), kind: "module", name, file: null, line: null, detail: "ruby" }), "imports", fact.line);
      }
    }
    const nearest = (files: FileFacts[]) => files.reduce<FileFacts | null>((best, candidate) => (!best || sharedSegments(candidate.path, facts.path) > sharedSegments(best.path, facts.path) ? candidate : best), null);
    for (const use of facts.uses ?? []) {
      const type = this.rubyType(facts, use.name, use.line, use.outside);
      let found = type ? this.rubyHomes(type, facts.path).map((home) => home.facts) : [];
      if (found.length === 0) {
        const holder = nearest(this.rubyNames(facts, use.name, use.line, use.outside).map((name) => this.rubyConstants.get(name)).find((files) => files !== undefined) ?? []);
        if (holder) found = [holder];
      }
      if (found.length === 0 && use.name.includes("::")) {
        // `Order::LIMIT`, where `Order` gets `LIMIT` from its parent or from a module it includes:
        // the file names `Order`, and reaches the file that holds the constant through it.
        const cut = use.name.lastIndexOf("::");
        const owner = this.rubyType(facts, use.name.slice(0, cut), use.line, use.outside);
        const holder = owner ? nearest(this.rubyInheritedConstant(owner, use.name.slice(cut + 2), new Set([owner.name]))) : null;
        if (owner && holder) found = [...this.rubyHomes(owner, facts.path).map((home) => home.facts), holder];
      }
      for (const file of found) this.edge(from, fileId(file.path), "imports", use.line);
    }
  }

  /** The files that assign a constant in what a class inherits, includes or extends. */
  private rubyInheritedConstant(type: { name: string; declared: Declared[] }, constant: string, seen: Set<string>): FileFacts[] {
    for (const parent of this.rubyParents(type)) {
      if (seen.has(parent.name) || seen.size > MAX_RUBY_ANCESTORS) continue;
      seen.add(parent.name);
      const holders = this.rubyConstants.get(`${parent.name}::${constant}`) ?? this.rubyInheritedConstant(parent, constant, seen);
      if (holders.length > 0) return holders;
    }
    return [];
  }

  // ---------- Rust ----------

  private has(path: string): boolean {
    return this.byPath.has(path);
  }

  /**
   * The crate a Rust file belongs to, as the folder and the file of its root. `lib.rs` and `main.rs`
   * are each a root; where both exist, a module belongs to the one that declares it with `mod`.
   * Files directly in `tests/`, `examples/`, `benches/` or `src/bin/` are crates of their own,
   * unless that folder is itself a module (`mod.rs`, or a file named after it).
   */
  private rustRoot(path: string): { dir: string; file: string } {
    const cached = this.rustRoots.get(path);
    if (cached) return cached;
    const own = folderOf(path);
    const name = posix.basename(path);
    let root = { dir: own, file: path };
    const entries = (dir: string) => ["lib.rs", "main.rs"].map((entry) => (dir ? `${dir}/${entry}` : entry)).filter((candidate) => this.has(candidate));
    const isModule = (dir: string) => entries(dir).length > 0 || this.has(`${dir}/mod.rs`) || this.has(`${dir}.rs`);
    const standalone = /^(?:tests|examples|benches|bin)$/.test(posix.basename(own)) && name !== "mod.rs" && !isModule(own);
    if (name !== "lib.rs" && name !== "main.rs" && !standalone) {
      for (let dir = own; ; dir = folderOf(dir)) {
        const found = entries(dir);
        if (found.length > 0) {
          // The first folder (or file) below the root says which module of the crate this file is part of.
          const top = path.slice(dir ? dir.length + 1 : 0).split("/")[0]?.replace(/\.rs$/, "");
          const declaring = found.find((entry) => this.byPath.get(entry)?.imports.some((fact) => fact.specifier === `self::${top}`));
          root = { dir, file: declaring ?? found[0] ?? path };
          break;
        }
        if (dir === "") break;
      }
    }
    this.rustRoots.set(path, root);
    return root;
  }

  /** The folder that holds the child modules of a Rust file: its own folder for `mod.rs` and a crate root, else a folder named after it. */
  private rustModuleDir(path: string): string {
    const name = posix.basename(path);
    if (name === "mod.rs" || path === this.rustRoot(path).file) return folderOf(path);
    const own = folderOf(path);
    return (own ? `${own}/` : "") + name.replace(/\.rs$/, "");
  }

  /** The file of the module whose children live in `dir`, in the crate with this root. */
  private rustModuleFile(dir: string, root: { dir: string; file: string }): string | null {
    if (dir === root.dir) return root.file;
    return [`${dir}.rs`, `${dir}/mod.rs`].find((candidate) => this.has(candidate)) ?? null;
  }

  /** Follows module path segments down from a module folder, as far as files go. What is left names items inside the file reached: `own` when no segment is a file. */
  private rustWalk(dir: string, segments: string[], own: string | null): { facts: FileFacts; rest: string[] } | null {
    const under = (parts: string[]) => [dir, ...parts].filter(Boolean).join("/");
    for (let count = segments.length; count > 0; count--) {
      const base = under(segments.slice(0, count));
      const file = [`${base}.rs`, `${base}/mod.rs`].find((candidate) => this.has(candidate));
      const facts = file ? this.byPath.get(file) : undefined;
      if (facts) return { facts, rest: segments.slice(count) };
    }
    const facts = own ? this.byPath.get(own) : undefined;
    return facts ? { facts, rest: segments } : null;
  }

  /**
   * Where a Rust path leads from `from`: a file of the repository plus the item path left over,
   * the name of an outside crate, or null for a path of this repository that leads nowhere.
   */
  private rustResolve(from: FileFacts, segments: string[], depth = 0, viaGlobs = true): { facts: FileFacts; rest: string[] } | { external: string } | null {
    const [first, ...rest] = segments;
    if (first === undefined || depth > MAX_REEXPORT_HOPS + 2) return null;
    const root = this.rustRoot(from.path);
    if (first === "crate") return this.rustWalk(root.dir, rest, root.file);
    if (first === "self") return this.rustWalk(this.rustModuleDir(from.path), rest, from.path);
    if (first === "super") {
      let dir = folderOf(this.rustModuleDir(from.path));
      let left = rest;
      while (left[0] === "super") {
        dir = folderOf(dir);
        left = left.slice(1);
      }
      return this.rustWalk(dir, left, this.rustModuleFile(dir, root));
    }
    // A name the file brought in with `use` or `mod`, written out in full and resolved again.
    // (`use anyhow::anyhow` binds a name that its own path starts with: that path is not rewritten by itself.)
    const binding = from.imports.find((fact) => !fact.star && fact.names[0]?.local === first && fact.specifier.split("::")[0] !== first);
    if (binding) return this.rustResolve(from, [...binding.specifier.split("::"), ...rest], depth + 1, viaGlobs);
    if (this.rustDeclares(from, first)) return { facts: from, rest: segments };
    const crate = this.aliases.find((alias) => alias.language === "rust" && alias.prefix === first);
    if (crate) {
      const lib = [crate.targets[0], crate.targets[1]].filter(Boolean).join("/");
      return this.rustWalk(folderOf(lib), rest, lib);
    }
    // A type that came in through a glob (`use super::*; use Kind::*;`). Crate names are lower case,
    // so a capitalised name that cannot be placed is an item, never an outside crate.
    const item = viaGlobs ? this.rustItem(from, first, true) : null;
    if (item) return { facts: item.facts, rest: [item.name, ...rest] };
    return /^[A-Z]/.test(first) ? { facts: from, rest: segments } : { external: first };
  }

  /** Whether a Rust file itself declares the name: a symbol, or an inline module, constant, static or macro. */
  private rustDeclares(facts: FileFacts, name: string): boolean {
    return this.symbols.get(facts.path)?.has(name) === true || facts.exports.some((declared) => declared.exported === name);
  }

  /** Whether `inner` is `outer` or a module below it: private items of a module are visible from there. */
  private rustInside(inner: FileFacts, outer: FileFacts): boolean {
    return inner === outer || inner.path.startsWith(`${this.rustModuleDir(outer.path)}/`);
  }

  /**
   * An item of a Rust file by name: one of its own, or one it passes on with `pub use` (any `use`,
   * when asked from inside the file). Each file is looked into once per question, so modules that
   * glob-import each other cost no more than their number.
   */
  private rustItem(facts: FileFacts, name: string, inside = false): { facts: FileFacts; name: string } | null {
    const key = `${facts.path}\u0000${name}\u0000${inside ? 1 : 0}`;
    const cached = this.rustItems.get(key);
    if (cached !== undefined) return cached;
    const found = this.rustSearch(facts, name, inside, facts, new Set());
    this.rustItems.set(key, found);
    return found;
  }

  private rustSearch(facts: FileFacts, name: string, inside: boolean, asker: FileFacts, seen: Set<string>): { facts: FileFacts; name: string } | null {
    const symbol = this.symbols.get(facts.path)?.get(name);
    if (symbol && (symbol.exported || this.rustInside(asker, facts))) return { facts, name };
    // An inline module, constant, static or macro: not a symbol, but it is where the name ends up.
    if (!symbol && facts.exports.some((declared) => declared.exported === name)) return { facts, name };
    const key = `${facts.path}\u0000${name}`;
    if (seen.has(key) || seen.size > 2000) return null;
    seen.add(key);
    // A plain `use` is private to its module, which includes every module below it.
    const visible = inside || this.rustInside(asker, facts);
    for (const fact of facts.imports) {
      if (!visible && !fact.reexport) continue;
      if (!fact.star && fact.names[0]?.local !== name) continue;
      const target = this.rustResolve(facts, fact.specifier.split("::"), 0, false);
      if (!target || "external" in target || target.rest.length > (fact.star ? 0 : 1)) continue;
      if (target.facts === facts && target.rest.length === 0) continue;
      const found = this.rustSearch(target.facts, fact.star ? name : (target.rest[0] ?? name), false, asker, seen);
      if (found) return found;
    }
    return null;
  }

  /** The type a name or path written in `from` stands for. */
  private rustType(from: FileFacts, written: string): { facts: FileFacts; name: string } | null {
    const segments = written.split("::").filter(Boolean);
    if (segments.length === 1) return this.rustItem(from, written, true);
    const target = this.rustResolve(from, segments);
    return target && !("external" in target) && target.rest.length === 1 ? this.rustItem(target.facts, target.rest[0] ?? "", target.facts === from) : null;
  }

  /** A method of a Rust type: from an `impl` in the file that declares it or in the calling file, or from a trait implemented for it. */
  private rustMethod(type: { facts: FileFacts; name: string } | null, method: string, from: FileFacts): string | null {
    if (!type) return null;
    const own = `${type.name}.${method}`;
    for (const facts of [type.facts, from]) if (this.symbols.get(facts.path)?.has(own)) return symbolId(facts.path, own);
    for (const trait of this.symbols.get(type.facts.path)?.get(type.name)?.embeds ?? []) {
      const declared = this.rustType(type.facts, trait);
      if (declared && this.symbols.get(declared.facts.path)?.has(`${declared.name}.${method}`)) return symbolId(declared.facts.path, `${declared.name}.${method}`);
    }
    return null;
  }

  /** Whether a local that got its type from `let x = T::name()` really holds a `T`: `name` must return one, in the way the `let` took it (`?` or not). */
  private rustConstructed(facts: FileFacts, local: LocalFact, type: { facts: FileFacts; name: string } | null): boolean {
    if (!local.via || !type) return true;
    const tried = local.via.startsWith("?");
    const constructor = this.symbols.get(type.facts.path)?.get(`${type.name}.${local.via.replace(/^\?/, "")}`) ?? this.symbols.get(facts.path)?.get(`${type.name}.${local.via.replace(/^\?/, "")}`);
    // A constructor we cannot see (a derived `default`, an `impl` elsewhere) is trusted only by its conventional name.
    if (!constructor?.returns) return /^\??(?:new|default)$/.test(local.via);
    return constructor.returns === (tried ? `?${type.name}` : type.name);
  }

  private rustCall(facts: FileFacts, call: FileFacts["calls"][number], caller: SymbolFact | null): string | null {
    const implType = caller?.name.includes(".") ? (caller.name.split(".")[0] ?? null) : null;
    const typeOf = (written: string) => (written === "Self" && implType ? (this.rustType(facts, implType) ?? { facts, name: implType }) : this.rustType(facts, written));
    const functionId = (item: { facts: FileFacts; name: string } | null) => {
      const id = item ? symbolId(item.facts.path, item.name) : null;
      // `Wrapper(x)` builds a tuple struct; it is not a call of a function.
      return id && this.nodes.get(id)?.detail === "function" ? id : null;
    };
    if (call.receiver === null) {
      return this.local(facts, call.callee, call.line, call.column) ? null : functionId(this.rustItem(facts, call.callee, true));
    }
    if (call.receiver.endsWith("::")) {
      const path = call.receiver.slice(0, -2).split("::").filter(Boolean);
      if (path[0] === "Self" && implType) path[0] = implType;
      const target = this.rustResolve(facts, [...path, call.callee]);
      if (!target || "external" in target) return null;
      if (target.rest.length === 1) return functionId(this.rustItem(target.facts, call.callee, target.facts === facts));
      // `Type::method()`, with the type possibly passed on by the module it was reached through.
      return target.rest.length === 2 ? this.rustMethod(this.rustItem(target.facts, target.rest[0] ?? "", target.facts === facts), call.callee, facts) : null;
    }
    const [receiver, field] = call.receiver.split(".");
    const local = receiver ? this.local(facts, receiver, call.line, call.column) : null;
    if (local?.kind !== "instance" || !local.type) return null;
    const type = typeOf(local.type);
    if (!this.rustConstructed(facts, local, type)) return null;
    if (field === undefined) return this.rustMethod(type, call.callee, facts);
    const fieldType = type ? this.symbols.get(type.facts.path)?.get(type.name)?.fields?.[field] : undefined;
    return type && fieldType ? this.rustMethod(this.rustType(type.facts, fieldType), call.callee, facts) : null;
  }

  /** A Rust file depends on the file each `use` and `mod` leads to: the one that declares the item when that can be told, else the module's file. */
  private addRustImports(facts: FileFacts): void {
    const from = fileId(facts.path);
    for (const fact of facts.imports) {
      const target = this.rustResolve(facts, fact.specifier.split("::"));
      if (target && "external" in target) {
        this.edge(from, this.node({ id: moduleId(target.external), kind: "module", name: target.external, file: null, line: null, detail: "rust" }), "imports", fact.line);
        continue;
      }
      const first = target?.rest[0];
      const item = target && first !== undefined && !fact.star ? this.rustItem(target.facts, first, target.facts === facts) : null;
      // A path of the crate that reaches no file and names nothing its starting module declares or passes on
      // leads nowhere: `mod gone;`, `use crate::gone::Thing`. Once a file is reached, an item we cannot see
      // in it may still come from a macro, so the file is depended on and nothing is reported.
      const path = fact.specifier.split("::");
      const start = path.findIndex((segment) => segment !== "crate" && segment !== "self" && segment !== "super");
      const reachedNoFile = target !== null && start > 0 && target.rest.length === path.length - start;
      const leadsNowhere = !target || (reachedNoFile && first !== undefined && !item && !this.rustDeclares(target.facts, first));
      if (leadsNowhere) this.unresolved.push({ file: facts.path, specifier: fact.specifier, line: fact.line });
      else if (target) this.edge(from, fileId((item ?? target).facts.path), "imports", fact.line);
    }
  }

  private addImports(facts: FileFacts): void {
    if (facts.language === "rust") return this.addRustImports(facts);
    if (facts.language === "ruby") return this.addRubyImports(facts);
    if (facts.language === "go") return this.addGoImports(facts);
    if (facts.language === "java") return this.addJavaImports(facts);
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

  /** What `name` is at `line`, when the file says so itself: the innermost declaration still in scope. */
  private local(facts: FileFacts, name: string, line: number, column?: number): LocalFact | null {
    let best: LocalFact | null = null;
    for (const local of facts.locals) {
      if (local.name !== name || line < local.line || line > local.endLine) continue;
      // On the line where the scope opens, only what comes after its start is inside it.
      if (line === local.line && column !== undefined && local.column !== undefined && column < local.column) continue;
      // The declaration with the smallest scope around the line wins: a parameter over a field, an inner block over an outer one.
      const span = local.endLine - local.line;
      const bestSpan = best ? best.endLine - best.line : Infinity;
      // Between two of the same size (a field and a parameter on one line), the one written later is the inner one.
      const later = best !== null && (local.line > best.line || (local.line === best.line && (local.column ?? 0) >= (best.column ?? 0)));
      if (span < bestSpan || (span === bestSpan && later)) best = local;
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
      } else if (facts.language === "java") {
        target = this.javaCall(facts, call);
      } else if (facts.language === "rust") {
        target = this.rustCall(facts, call, caller);
      } else if (facts.language === "ruby") {
        target = this.rubyCall(facts, call, caller);
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
      const name = !table.inferred || this.definedTables.has(table.name) ? table.name : table.otherwise && this.definedTables.has(table.otherwise) ? table.otherwise : null;
      if (name === null) continue;
      const id = this.node({ id: tableId(name), kind: "table", name, file: null, line: null, detail: null });
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
