export type Language = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "ruby" | "sql" | "markdown" | "env";

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
  /** For a Go struct: the types it embeds, whose methods it gets. For a Java type: the interfaces it implements or extends. For a Rust type: the traits implemented for it in its own file. For a Ruby class or module: what it includes, extends or prepends. */
  embeds?: string[];
  /**
   * For a Rust function or method: the type it returns, `?T` when wrapped in `Result` or `Option`. Says whether `let x = T::new()` makes `x` a `T`.
   * For a Go function or method: the first type it returns, as written in its file (`Client`, `db.Repo`). Says what `x := New()` makes `x`.
   * For a Java method: the class it returns, as written in its file, or `?` when that is not one class (a type parameter, overloads that differ).
   */
  returns?: string;
  /** For a Java method: its parameter types as written, joined by commas. An inherited method with the same list is overridden, one with another list is an overload. */
  params?: string;
  /** For a Go struct: field name → the type written for it (`Store`, `db.Repo`). */
  fields?: Record<string, string>;
}

/**
 * A name a file exports that is not the name of one of its own symbols: `export { a as b }`,
 * `export default a`, `module.exports = a`. For Go: a package-level constant or variable, which is
 * not a symbol but still says which file of the package a user of that name depends on. For Rust:
 * an inline module, constant, static or macro, so that a path naming it is known to lead somewhere.
 * For Ruby: a constant that is not a class, under its full name (`Shop::LIMIT`).
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
  /** Go, Rust and Java: the call whose result the name holds (`x := NewClient()`, `let x = open()?`, `var x = open()`), when no type is written. The type is what that function returns, which another file may say. */
  from?: CallRef;
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

/** A call as written: enough to find what is called, and from there what it returns. */
export interface CallRef {
  callee: string;
  receiver: string | null;
  line: number;
  column?: number;
  /** Go, Rust and Java: the call this one is made on the result of, when `receiver` is `()`: `a.Open().Read()`. */
  via?: CallRef;
  /** Rust: the result was taken out of a `Result` or an `Option` before use (`?`, `.unwrap()`, `.expect(..)`). */
  tried?: boolean;
}

export interface CallFact {
  callee: string;
  /**
   * `obj` in `obj.callee()`, `this` / `self` / `super`, `this.field` in `this.field.callee()`, `new` for `new Callee()` in Java (`extends` for `super(...)`, which builds the parent `Callee`),
   * a Rust path ending in `::` for `a::b::callee()`, or in Ruby `@field`, a constant (`A::B`) or `A::B.new` for a call on a fresh instance.
   */
  receiver: string | null;
  line: number;
  /** Where on the line the call starts, to tell `run(x, (run) => 1)` apart from a call inside the inner function. */
  column?: number;
  /** Go, Rust and Java: the call this one is made on the result of, when `receiver` is `()`: `a.Open().Read()`. */
  via?: CallRef;
}

export type TableOp = "define" | "read" | "write";

export interface TableFact {
  name: string;
  op: TableOp;
  line: number;
  /** Ruby: the table an Active Record model has by its name alone. It counts only when the repository defines a table of that name. */
  inferred?: boolean;
  /** For an inferred table: the name to try when the first is not defined (`settings` after `web_settings` for `Web::Setting`). */
  otherwise?: string;
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
  /**
   * Java: the type names the file mentions, with the line of the first mention. A class of the same package is used without an import.
   * Ruby: the constants the file mentions, once per namespace. A class is used without naming its file anywhere.
   */
  uses?: { name: string; line: number; /** Ruby: the parent in `class A < B`, which is looked up from outside the class that starts on that line. */ outside?: boolean; /** Java: the name stands where a variable could stand too; it is a class only if no variable of that name is in view. */ maybe?: boolean }[];
  /** Ruby: the lines of each class and module body, with the full names of the namespaces around it, innermost first. A constant is looked up in each in turn. */
  namespaces?: { names: string[]; line: number; endLine: number }[];
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
