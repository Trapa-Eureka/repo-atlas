export type Language = "typescript" | "tsx" | "javascript" | "python" | "sql" | "markdown" | "env";

export interface SymbolFact {
  /** Qualified inside the file: `name` for top-level, `Class.method` for members. */
  name: string;
  kind: "function" | "class" | "method";
  line: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
}

export interface ImportedName {
  local: string;
  /** The exported name on the other side, `default`, or `*` for a whole-module binding. */
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
  /** `obj` in `obj.callee()`, or `this` / `self`. */
  receiver: string | null;
  line: number;
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
  tables: TableFact[];
  envs: EnvFact[];
  docRefs: DocRefFact[];
}

export function emptyFacts(path: string, language: Language): FileFacts {
  return { path, language, symbols: [], imports: [], calls: [], tables: [], envs: [], docRefs: [] };
}
