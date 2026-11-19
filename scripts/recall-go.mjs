// Measures what atlas misses on a Go repository: every call the Go type checker resolves to a
// function or method declared in that repository, and every name of another package of the
// repository, is looked up in atlas's graph. `go list` fetches the sources of the modules the
// repository needs; nothing is built or run.
//
//   pnpm build && node scripts/recall-go.mjs <repository> [--misses <n> [reason prefix]]
//
// Needs Go on the PATH. A repository of several modules is measured one module folder at a time.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasGraph, big, report } from "./recall-report.mjs";

const [repoArg, , missArg, only] = process.argv.slice(2);
if (!repoArg) throw new Error("usage: node scripts/recall-go.mjs <repository> [--misses <n> [reason prefix]]");
const repo = resolve(repoArg);
const atlas = atlasGraph(repo, ".go");
const rows = execFileSync("go", ["run", join(dirname(fileURLToPath(import.meta.url)), "RecallGo.go"), repo], big).split("\n");
const [, unresolved, external, values] = (rows.find((row) => row.startsWith("U\t")) ?? "U\t0\t0\t0").split("\t");

report({
  repo,
  language: "Go",
  atlas,
  rows,
  uses: "uses of another package",
  notCounted: `${unresolved} calls the type checker could not resolve, ${external} calls into the standard library and other modules, ${values} calls of a function held in a variable, a field or a parameter`,
  notSymbol: { "interface method": "a method of an interface: the call is decided at run time", "method of an unnamed type": "method of an unnamed type" },
  missArg,
  only,
});
