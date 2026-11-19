import type { TableFact, TableOp } from "./facts.js";

// "create table" must go on to a column list or a source, so that prose such as "Create table in {db}" is not SQL.
const SQL_SHAPE =
  /\bselect\b[\s\S]+?\bfrom\b|\binsert\s+into\b|\bupdate\s+[\w."`]+\s+set\b|\bdelete\s+from\b|\bcreate\s+(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"[^"]+"|`[^`]+`|\S+)\s*(?:\(|(?:as|like|partition|using|inherits|select|with|of)\b)|\balter\s+table\b/i;

const NAME = "((?:[A-Za-z_][\\w$]*|\"[^\"]+\"|`[^`]+`)(?:\\.(?:[A-Za-z_][\\w$]*|\"[^\"]+\"|`[^`]+`))?)";

const PATTERNS: { op: TableOp; re: RegExp; source?: boolean }[] = [
  { op: "define", re: new RegExp(`\\bcreate\\s+(?:temp(?:orary)?\\s+|unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}`, "gi") },
  { op: "write", re: new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${NAME}`, "gi") },
  { op: "write", re: new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+${NAME}`, "gi") },
  { op: "write", re: new RegExp(`\\bupdate\\s+(?:only\\s+)?${NAME}\\s+set\\b`, "gi") },
  { op: "write", re: new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?${NAME}`, "gi") },
  { op: "read", source: true, re: new RegExp(`\\b(?:from|join)\\s+(?:only\\s+)?${NAME}`, "gi") },
  { op: "read", re: new RegExp(`\\breferences\\s+${NAME}`, "gi") },
];

const NOT_A_TABLE = new Set([
  "select", "lateral", "unnest", "values", "set", "where", "dual", "table", "only", "if", "not", "exists",
  "generate_series", "json_each", "jsonb_each", "information_schema", "pg_catalog",
  "the", "a", "an", "this", "that", "these", "those", "your", "my", "our", "its", "it", "all", "any", "each", "one",
]);

const FROM_INSIDE_FUNCTION = /\b(?:extract|substring|trim|overlay|position)\s*\([^()]*$/i;
const FROM_AFTER_KEYWORD = /\b(?:delete|distinct)\s+$/i;

// A CTE may list its columns before AS: "ancestors(id, depth) AS (".
const CTE_BODY = "\\s*(?:\\([^()]*\\))?\\s+as\\s+(?:materialized\\s+)?\\(\\s*(?:select|with|values)\\b";
// A statement, or a piece of one that code glues into a WITH clause: "recent as (select ...)".
const SQL_START = new RegExp(`^(?:\\s|\\\\[nrt])*\\(?\\s*(?:(?:select|insert|update|delete|create|alter|with)\\b|[A-Za-z_]\\w*${CTE_BODY})`, "i");
const CTE_ANYWHERE = new RegExp(`(?:^|\\bwith\\s+(?:recursive\\s+)?|[\`'",]|\\\\[nrt])\\s*([A-Za-z_]\\w*)${CTE_BODY}`, "gim");

/**
 * Names a source file defines as common table expressions, in any of its strings. Code builds one
 * query from several strings ("WITH recent AS (" here, "FROM recent" there), so a read of such a
 * name anywhere in the file is taken to be the CTE. The price: a real table that shares its name
 * with a CTE of the same file loses its reads from that file.
 */
export function cteNamesIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(CTE_ANYWHERE)) names.add((match[1] ?? "").toLowerCase());
  return names;
}

/** Whether a string literal in code is a SQL statement, as opposed to prose that happens to say "select ... from". */
export function looksLikeSql(text: string): boolean {
  const sql = stripComments(text);
  return SQL_START.test(sql) && SQL_SHAPE.test(sql);
}

function stripComments(sql: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return sql.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
}

function tableName(raw: string): string {
  const last = raw.split(".").pop() ?? raw;
  return last.replace(/["`]/g, "").toLowerCase();
}

function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Tables named in a piece of SQL. `firstLine` is the 1-based line where `sql` starts in its file. */
export function tablesInSql(sql: string, firstLine = 1): TableFact[] {
  const text = stripComments(sql);
  const cteNames = new Set<string>();
  for (const match of text.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+as\s+(?:materialized\s+)?\(/gi)) {
    cteNames.add((match[1] ?? "").toLowerCase());
  }

  const found = new Map<string, TableFact>();
  for (const { op, re, source } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const name = tableName(match[1] ?? "");
      // A name with a placeholder in or right after it ("{table}", table_{i}, prefix_${n}, prefix_#{n}) is filled in at
      // run time, and one followed by a quote is the first half of an escaped quoted name.
      if (!name || NOT_A_TABLE.has(name) || cteNames.has(name) || /[{}]/.test(name)) continue;
      if (/^(?:[$#]?\{|["`])/.test(text.slice(match.index + match[0].length))) continue;
      if (source) {
        // FROM unnest(...), JOIN jsonb_array_elements(...): a function that returns rows, not a table.
        if (/^\s*\(/.test(text.slice(match.index + match[0].length))) continue;
        const before = text.slice(Math.max(0, match.index - 80), match.index);
        if (FROM_INSIDE_FUNCTION.test(before) || FROM_AFTER_KEYWORD.test(before)) continue;
      }
      const key = `${op}:${name}`;
      if (!found.has(key)) found.set(key, { name, op, line: firstLine + lineAt(text, match.index) });
    }
  }
  return [...found.values()];
}
