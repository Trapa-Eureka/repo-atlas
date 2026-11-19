# repo-atlas

A local CLI (`atlas`) and MCP server that index a repository into a graph of files, functions, SQL tables, env keys and docs, and answer "what does this touch, and what breaks if I change it".
Product background: item #3 of the GitHub_Trending_Tech_Project_TOP100 PDF in the parent folder.

## Commands
- `pnpm check` runs everything a change must pass: typecheck, lint, tests, hook tests.
- `pnpm build`, then `node dist/cli/main.js <command>` to run the CLI. `fixtures/shop` is the sample repository the tests index.
- `pnpm test -- -u` rewrites the Mermaid snapshot. Read the diff before keeping it.

## Things the code does not tell you
- Rules live in `eslint.config.js` (layer boundaries, who may import SQLite / tree-sitter / commander / the MCP SDK) and in tests, with messages that say what to do instead. When a correction comes up twice, add a lint rule or a test for it rather than a line here.
- Extraction is per file and must stay independent of other files, because unchanged files are not re-parsed. Anything that needs two files belongs in `src/indexer/link.ts`.
- Changing what an extractor returns requires bumping `EXTRACTOR_VERSION` in `src/extract/index.ts`. Without it, existing `.atlas/graph.db` files keep the old facts and nothing fails.
- stdout carries only command results (and the MCP protocol when `atlas mcp` runs). Progress notes and errors go to stderr.
- The indexer never opens real env files, only templates such as `.env.example`, and reads key names, not values. `languageOf` has a test for this.
- `docs/` is not tracked by git. It holds private planning notes, including the paid plans, which are not built. The README may say paid plans are planned and nothing more.
- Publishing to npm is done by a human. The hook and the deny rule block it on purpose.
- All tracked files are written in English. The one exception is `README.ko.md`, a requested Korean translation: `README.md` stays the source of truth, so change both together.
- The pictures in `assets/` are captures of real CLI output on `fixtures/shop`. When that output changes, re-capture them instead of editing the README text around them.
