#!/usr/bin/env node
// Stop hook: Claude may not finish a turn that left source changes with failing types or tests.
// Exit 2 + stderr sends the failure back to Claude, which then keeps working.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHECKS = [
  ["pnpm", ["--silent", "typecheck"]],
  ["pnpm", ["--silent", "test"]],
];

/** True when the working tree has changes that the checks cover. */
export function touchesCode(porcelain) {
  return porcelain.split("\n").some((line) => /^.{2} "?(?:src|test|fixtures)\/|^.{2} "?(?:package\.json|tsconfig.*\.json|eslint\.config\.js)/.test(line));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  // Already continuing because of this hook: let the turn end instead of looping forever.
  if (input.stop_hook_active) process.exit(0);

  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (status.status !== 0 || !touchesCode(status.stdout)) process.exit(0);

  for (const [command, args] of CHECKS) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    if (result.status === 0 || result.status === null) continue;
    const output = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-60).join("\n");
    process.stderr.write(`[verify-before-stop] \`${command} ${args.join(" ")}\` failed. Fix it before finishing, or say plainly why it cannot be fixed.\n${output}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
