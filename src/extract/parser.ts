import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

export type Grammar = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "ruby";

const require = createRequire(import.meta.url);
const parsers = new Map<Grammar, Promise<Parser>>();
let runtime: Promise<void> | undefined;

async function load(grammar: Grammar): Promise<Parser> {
  runtime ??= Parser.init();
  await runtime;
  const wasm = require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  return parser;
}

export function parserFor(grammar: Grammar): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = load(grammar);
    parsers.set(grammar, parser);
  }
  return parser;
}
