export type Language = "typescript" | "tsx" | "javascript" | "python" | "sql" | "markdown" | "env";

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
}

/** A name a file exports that is not the name of one of its own symbols: `export { a as b }`, `export default a`, `module.exports = a`. */
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
}

export interface CallFact {
  callee: string;
  /** `obj` in `obj.callee()`, `this` / `self` / `super`, or `this.field` in `this.field.callee()`. */
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
