import { basename, extname } from "node:path";
import { extractPython, extractScript } from "./code.js";
import { emptyFacts, type FileFacts, type Language, type TableFact } from "./facts.js";
import { parserFor, type Grammar } from "./parser.js";
import { cteNamesIn, tablesInSql } from "./sql.js";
import { envDeclarations, envUses, markdownRefs } from "./text.js";

export type { CallFact, DocRefFact, EnvFact, FileFacts, ImportFact, ImportedName, Language, SymbolFact, TableFact } from "./facts.js";

/** Bump when extraction output changes, so existing indexes re-parse every file. */
export const EXTRACTOR_VERSION = 2;

const BY_EXTENSION: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".sql": "sql",
  ".md": "markdown",
  ".mdx": "markdown",
};

const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$|^(?:example|sample)\.env$/;

/** The language a path is indexed as, or `null` when the file is not indexed at all. */
export function languageOf(path: string): Language | null {
  const name = basename(path);
  if (ENV_TEMPLATE.test(name)) return "env";
  if (name.endsWith(".d.ts") || name.endsWith(".min.js")) return null;
  return BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}

function dedupeTables(tables: TableFact[]): TableFact[] {
  const seen = new Map<string, TableFact>();
  for (const table of tables) {
    const key = `${table.op}:${table.name}`;
    if (!seen.has(key)) seen.set(key, table);
  }
  return [...seen.values()];
}

async function extractCode(source: string, facts: FileFacts, grammar: Grammar): Promise<void> {
  const parser = await parserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) return;
  try {
    if (grammar === "python") extractPython(tree.rootNode, facts);
    else extractScript(tree.rootNode, facts);
  } finally {
    tree.delete();
  }
  facts.envs = envUses(source, facts.language);
  facts.tables = dedupeTables(facts.tables);
}

export async function extractFile(path: string, source: string): Promise<FileFacts> {
  const language = languageOf(path);
  if (!language) throw new Error(`${path} is not a file type repo-atlas indexes`);
  const facts = emptyFacts(path, language);
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "python":
      await extractCode(source, facts, language);
      if (facts.tables.some((table) => table.op === "read")) {
        const ctes = cteNamesIn(source);
        facts.tables = facts.tables.filter((table) => table.op !== "read" || !ctes.has(table.name));
      }
      break;
    case "sql":
      facts.tables = tablesInSql(source);
      break;
    case "markdown":
      facts.docRefs = markdownRefs(source);
      break;
    case "env":
      facts.envs = envDeclarations(source);
      break;
  }
  return facts;
}
