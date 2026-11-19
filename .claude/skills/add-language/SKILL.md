---
name: add-language
description: Steps for teaching repo-atlas a new language or file type (for example Go, Ruby, YAML config). Use when adding or extending an extractor in src/extract.
---

# Add a language or file type

An extractor turns one file into `FileFacts` (`src/extract/facts.ts`). It sees one file and nothing else.

1. **Sample first.** Add two or three small files in the new language to `fixtures/shop` that import each other, call across files, and touch a table or an env key. Decide what the graph should contain before writing code.
2. **Grammar.** `@vscode/tree-sitter-wasm` already ships grammars for Go, Rust, Java, C#, C++, Ruby, PHP, CSS and Bash. Add the name to `Grammar` in `src/extract/parser.ts`. Print the tree for a sample (`parser.parse(src).rootNode.toString()`) instead of guessing node names.
3. **Extractor.** Add `extract<Language>` next to `extractScript` / `extractPython` in `src/extract/code.ts`, filling `symbols`, `imports`, `calls`. Pass string literals to `sniffSql`. Add the env-reading idioms of the language to `src/extract/text.ts`.
4. **Wire it.** Map the file extensions in `BY_EXTENSION` and the `switch` in `src/extract/index.ts`. Bump `EXTRACTOR_VERSION`.
5. **Resolution.** If imports are not relative paths, add a `resolve<Language>` to `src/indexer/link.ts` next to `resolvePython`, and extend the arbitrary inputs of the property tests in `test/link.test.ts` with the new specifier shapes.
6. **Tests.** One `extractFile` test in `test/extract.test.ts` asserting the exact facts, and update the counts in `test/atlas.test.ts`.
7. **Evidence.** Follow the `verify-change` skill and show the CLI output for the new files.
8. Add the language to the table in the README.
