export type Language = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "sql" | "markdown" | "env";

export interface SymbolFact {
  /** Qualified inside the file: `name` for top-level, `Class.method` for members. */
  name: string;
  kind: "function" | "class" | "method";
  line: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
  /** For a class: the name it extends, as written in this file. */
  extends?: string;
  /** For a Go struct: the types it embeds, whose methods it gets. For a Java type: the interfaces it implements or extends. For a Rust type: the traits implemented for it in its own file. */
  embeds?: string[];
  /** For a Rust method: the type it returns, `?T` when wrapped in `Result` or `Option`. Says whether `let x = T::new()` makes `x` a `T`. */
  returns?: string;
  /** For a Go struct: field name → the type written for it (`Store`, `db.Repo`). */
  fields?: Record<string, string>;
}

/**
 * A name a file exports that is not the name of one of its own symbols: `export { a as b }`,
 * `export default a`, `module.exports = a`. For Go: a package-level constant or variable, which is
 * not a symbol but still says which file of the package a user of that name depends on. For Rust:
 * an inline module, constant, static or macro, so that a path naming it is known to lead somewhere.
 */
export interface ExportFact {
  /** The name seen from outside: `b`, `default`, or `default.b` for a member of a default-exported object. */
  exported: string;
  /** The local name it stands for: a symbol of this file or one of its imports. */
  local: string;
}

/**
 * What a local name is, within the lines where it is in scope. Enough to follow
 * `const { parse } = db; parse()` and `const s = new Service(); s.run()` without a type checker.
 */
export interface LocalFact {
  /** The local name, or `this.field` for a class field. */
  name: string;
  /**
   * `member`: `name` is `object.property`. `instance`: `name` holds an instance of the class `type`.
   * `other`: `name` is declared here as something that cannot be followed (an untyped parameter, the
   * result of a call). It still matters: it hides any outer meaning of the name.
   */
  kind: "member" | "instance" | "other";
  object?: string;
  property?: string;
  type?: string;
  /** Rust: the constructor the type was read from (`new` in `let x = T::new()`, `?new` in `let x = T::new()?`), to be checked against what it returns. */
  via?: string;
  line: number;
  endLine: number;
  /** Where on its first line the scope starts. A call earlier on that line is outside it. */
  column?: number;
}

export interface ImportedName {
  local: string;
  /** The exported name on the other side, `default`, `*` for a whole-module binding, or `=` for what `require()` returns. */
  imported: string;
}

export interface ImportFact {
  specifier: string;
  names: ImportedName[];
  /** `export ... from "x"`: the names are passed through, not used here. */
  reexport: boolean;
  /** `export * from "x"` or `from x import *`. */
  star: boolean;
  line: number;
  /** Java: `import static`, which names members of a class instead of a class or a package. */
  static?: boolean;
  /** Go: the names of the package this file uses (`pkg.Name`), to tell which of the package's files it depends on. */
  members?: string[];
}

export interface CallFact {
  callee: string;
  /** `obj` in `obj.callee()`, `this` / `self` / `super`, `this.field` in `this.field.callee()`, `new` for `new Callee()` in Java, or a Rust path ending in `::` for `a::b::callee()`. */
  receiver: string | null;
  line: number;
  /** Where on the line the call starts, to tell `run(x, (run) => 1)` apart from a call inside the inner function. */
  column?: number;
}

export type TableOp = "define" | "read" | "write";

export interface TableFact {
  name: string;
  op: TableOp;
  line: number;
}

export interface EnvFact {
  name: string;
  op: "use" | "declare";
  line: number;
}

export interface DocRefFact {
  target: string;
  kind: "link" | "code";
  line: number;
}

export interface FileFacts {
  path: string;
  language: Language;
  /** Go: the name in the `package` clause. Files of one folder can belong to two packages (`x` and `x_test`). Java: the declared package. */
  package?: string;
  /** Java: the type names the file mentions, with the line of the first mention. A class of the same package is used without an import. */
  uses?: { name: string; line: number }[];
  symbols: SymbolFact[];
  imports: ImportFact[];
  calls: CallFact[];
  exports: ExportFact[];
  locals: LocalFact[];
  tables: TableFact[];
  envs: EnvFact[];
  docRefs: DocRefFact[];
}

export function emptyFacts(path: string, language: Language): FileFacts {
  return { path, language, symbols: [], imports: [], calls: [], exports: [], locals: [], tables: [], envs: [], docRefs: [] };
}
