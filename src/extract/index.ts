import { basename, extname } from "node:path";
import type { Node } from "web-tree-sitter";
import { extractGo, extractJava, extractPython, extractRuby, extractRust, extractScript } from "./code.js";
import { emptyFacts, type FileFacts, type Language, type TableFact } from "./facts.js";
import { parserFor, type Grammar } from "./parser.js";
import { cteNamesIn, tablesInSql } from "./sql.js";
import { envDeclarations, envUses, markdownRefs } from "./text.js";

export { rubyUnderscore } from "./code.js";
export type { CallFact, CallRef, DocRefFact, EnvFact, ExportFact, FileFacts, ImportFact, ImportedName, Language, LocalFact, SymbolFact, TableFact } from "./facts.js";

/** Bump when extraction output changes, so existing indexes re-parse every file. */
export const EXTRACTOR_VERSION = 11;

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
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".rb": "ruby",
  ".rake": "ruby",
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
    const key = `${table.op}:${table.name}:${table.inferred ? 1 : 0}`;
    if (!seen.has(key)) seen.set(key, table);
  }
  return [...seen.values()];
}

const TEXT_NODES = new Set(["comment", "string", "template_string", "string_fragment", "string_content", "regex", "interpreted_string_literal", "raw_string_literal", "string_literal", "line_comment", "block_comment", "heredoc_body"]);
const CODE_INSIDE_TEXT = new Set(["template_substitution", "interpolation"]);

/** Whether the source at `offset` is code, as opposed to the inside of a string or a comment. */
function isCode(root: Node, offset: number): boolean {
  for (let node: Node | null = root.descendantForIndex(offset); node; node = node.parent) {
    if (CODE_INSIDE_TEXT.has(node.type)) return true;
    if (TEXT_NODES.has(node.type)) return false;
  }
  return true;
}

async function extractCode(source: string, facts: FileFacts, grammar: Grammar): Promise<void> {
  const parser = await parserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) return;
  try {
    if (grammar === "go") extractGo(tree.rootNode, facts);
    else if (grammar === "java") extractJava(tree.rootNode, facts);
    else if (grammar === "rust") extractRust(tree.rootNode, facts);
    else if (grammar === "ruby") extractRuby(tree.rootNode, facts);
    else if (grammar === "python") extractPython(tree.rootNode, facts);
    else extractScript(tree.rootNode, facts);
    // `process.env.X` in a test title or a comment is a mention, not a use.
    facts.envs = envUses(source, facts.language, (offset) => isCode(tree.rootNode, offset));
  } finally {
    tree.delete();
  }
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
    case "go":
    case "java":
    case "rust":
    case "ruby":
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
