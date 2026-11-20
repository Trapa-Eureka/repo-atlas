export const NODE_KINDS = ["file", "symbol", "table", "env", "module"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "imports",
  "defines",
  "calls",
  "references",
  "defines_table",
  "reads_table",
  "writes_table",
  "uses_env",
  "declares_env",
  "documents",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  file: string | null;
  line: number | null;
  detail: string | null;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  line: number | null;
}

export const fileId = (path: string): string => `file:${path}`;
export const symbolId = (path: string, qualifiedName: string): string => `sym:${path}#${qualifiedName}`;
export const tableId = (name: string): string => `table:${name.toLowerCase()}`;
export const envId = (name: string): string => `env:${name}`;
export const moduleId = (name: string): string => `mod:${name}`;
