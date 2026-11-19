#!/usr/bin/env node
// PostToolUse hook: lints the file Claude just edited and hands any violation straight back.
// Exit 2 + stderr is what makes Claude Code show the message to Claude; any other failure is ignored by it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Only project TypeScript is linted; fixtures are sample input and docs/ is private notes. */
export function shouldLint(filePath, projectDir) {
  const path = relative(projectDir, resolve(projectDir, filePath)).split("\\").join("/");
  return /^(?:src|test)\/.+\.ts$/.test(path) || path === "eslint.config.js";
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const filePath = input?.tool_input?.file_path;
  const eslint = resolve(projectDir, "node_modules/.bin/eslint");
  if (typeof filePath !== "string" || !shouldLint(filePath, projectDir) || !existsSync(eslint) || !existsSync(filePath)) process.exit(0);

  const result = spawnSync(eslint, ["--no-warn-ignored", filePath], { cwd: projectDir, encoding: "utf8" });
  if (result.status === 0 || result.status === null) process.exit(0);
  process.stderr.write(`[lint-edited] ${filePath} breaks a project rule. Fix the cause; do not disable the rule.\n${result.stdout}${result.stderr}`);
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
