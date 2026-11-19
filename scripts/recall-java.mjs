// Measures what atlas misses on a Java repository: every call and every class name that javac can
// resolve to a declaration in that repository is looked up in atlas's graph. The repository is not
// built and its dependencies are not fetched, so whatever javac cannot resolve without them (a call
// on a value of a library type, an argument of a library method) is left out of the count.
//
//   pnpm build && node scripts/recall-java.mjs <repository> [--misses <n> [reason prefix]]
//
// Needs a JDK (17 or later) on the PATH.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasGraph, big, report } from "./recall-report.mjs";

const [repoArg, , missArg, only] = process.argv.slice(2);
if (!repoArg) throw new Error("usage: node scripts/recall-java.mjs <repository> [--misses <n> [reason prefix]]");
const repo = resolve(repoArg);
const atlas = atlasGraph(repo, ".java");

const work = mkdtempSync(join(tmpdir(), "atlas-recall-"));
let rows;
try {
  writeFileSync(join(work, "files.txt"), `${atlas.files.join("\n")}\n`);
  rows = execFileSync("java", [join(dirname(fileURLToPath(import.meta.url)), "RecallJava.java"), repo, join(work, "files.txt")], big).split("\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
const [, unresolved, external] = (rows.find((row) => row.startsWith("U\t")) ?? "U\t0\t0").split("\t");

report({
  repo,
  language: "Java",
  atlas,
  rows,
  uses: "class uses",
  notCounted: `${unresolved} calls javac could not resolve without the dependencies, ${external} calls into the JDK`,
  notSymbol: { "anonymous or local class": "anonymous or local class", "implicit member": "a member the compiler adds: enum values(), record accessor" },
  missArg,
  only,
});
