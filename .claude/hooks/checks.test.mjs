import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { shouldLint } from "./lint-edited.mjs";
import { touchesCode } from "./verify-before-stop.mjs";

const run = (script, input) =>
  spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: fileURLToPath(new URL("../..", import.meta.url)) } });

test("lints project TypeScript only", () => {
  assert.equal(shouldLint("/proj/src/query/impact.ts", "/proj"), true);
  assert.equal(shouldLint("test/link.test.ts", "/proj"), true);
  assert.equal(shouldLint("/proj/eslint.config.js", "/proj"), true);
  for (const path of ["/proj/fixtures/shop/src/index.ts", "/proj/docs/notes.md", "/proj/README.md", "/elsewhere/src/a.ts", "/proj/dist/cli/main.js"]) {
    assert.equal(shouldLint(path, "/proj"), false, path);
  }
});

test("lint hook passes clean files and files it does not cover", () => {
  assert.equal(run("./lint-edited.mjs", { tool_name: "Edit", tool_input: { file_path: fileURLToPath(new URL("../../src/graph/types.ts", import.meta.url)) } }).status, 0);
  assert.equal(run("./lint-edited.mjs", { tool_name: "Write", tool_input: { file_path: "/tmp/elsewhere.ts" } }).status, 0);
});

test("stop hook runs checks only when code changed", () => {
  assert.equal(touchesCode(" M src/cli/program.ts\n"), true);
  assert.equal(touchesCode("?? test/new.test.ts\n"), true);
  assert.equal(touchesCode(" M package.json\n"), true);
  assert.equal(touchesCode(" M README.md\n?? docs/plan.md\n"), false);
  assert.equal(touchesCode(""), false);
});

test("stop hook never loops", () => {
  assert.equal(run("./verify-before-stop.mjs", { stop_hook_active: true }).status, 0);
});
