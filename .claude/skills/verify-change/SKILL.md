---
name: verify-change
description: How to prove a repo-atlas change works by running the real CLI and showing its output. Use before reporting any change to extraction, linking, queries, CLI output or the MCP server as done.
---

# Verify a change with evidence

Passing tests show the code agrees with the tests. The reviewer reads the output, not the diff, so produce output.

1. `pnpm check` must pass. Paste the last lines (test counts) into the report.
2. Build and run the commands the change affects against the sample repository:

   ```bash
   pnpm build
   node dist/cli/main.js -C fixtures/shop index --full
   node dist/cli/main.js -C fixtures/shop context src/users/repo.ts
   node dist/cli/main.js -C fixtures/shop impact users
   ```

   Include the relevant output verbatim, and say which line shows the new behaviour.
3. For anything that changes edges, also index a larger real repository (clone one into the scratchpad; never index into someone else's working copy) and report: file count, time, `atlas stats --unresolved`, and three spot checks of `atlas context` compared against the source by hand. Name any false edge you find.
4. For Mermaid changes, review the snapshot diff from `pnpm test -- -u` line by line before keeping it.
5. For MCP changes, the in-memory client test in `test/atlas.test.ts` is the evidence; extend it rather than testing by hand.

Say plainly what was not verified.
