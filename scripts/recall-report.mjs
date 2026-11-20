// The comparison shared by the recall scripts: what a compiler says a repository's calls and
// cross-file names refer to (rows printed by RecallJava.java or RecallGo.go) against atlas's graph.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const big = { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };

/** atlas's graph of a repository, reduced to what the comparison needs. */
export function atlasGraph(repo, extension) {
  const graph = JSON.parse(execFileSync("node", [join(here, "../dist/cli/main.js"), "-C", repo, "export"], big));
  const fileOf = (id) => id.replace(/^(?:file|sym):/, "").replace(/#.*/, "");
  const files = graph.nodes.filter((node) => node.kind === "file" && node.file.endsWith(extension)).map((node) => node.file);
  return {
    files,
    symbols: new Set(graph.nodes.filter((node) => node.kind === "symbol").map((node) => node.id)),
    calls: new Set(graph.edges.filter((edge) => edge.kind === "calls").map((edge) => `${fileOf(edge.src)}|${edge.dst}`)),
    imports: new Set(graph.edges.filter((edge) => edge.kind === "imports" && edge.dst.startsWith("file:")).map((edge) => `${fileOf(edge.src)}|${fileOf(edge.dst)}`)),
  };
}

/**
 * Prints what atlas found and missed. `rows` are tab-separated: `I from to` for a name of another
 * file, `C from to name shape form line around` for a call. `notSymbol` names the shapes atlas
 * never makes a symbol of; `uses` is what the `I` rows are called in the output.
 */
export function report({ repo, language, atlas, rows, notCounted, notSymbol, uses, missArg, only, lister }) {
  const indexed = new Set(atlas.files);
  const calls = new Map();
  const imports = new Set();
  let itself = 0;
  for (const row of rows) {
    const [kind, from, to, name, shape, form, line, around] = row.split("\t");
    if (!indexed.has(from) || !indexed.has(to)) continue;
    if (kind === "I") imports.add(`${from}|${to}`);
    if (kind !== "C") continue;
    // A symbol that calls itself, or another of its name (overloads are one symbol), has no edge to draw.
    if (from === to && around === name) itself++;
    else if (!calls.has(`${from}|sym:${to}#${name}`)) calls.set(`${from}|sym:${to}#${name}`, { key: `${from}|sym:${to}#${name}`, id: `sym:${to}#${name}`, from, shape, form, line });
  }
  const reasonOf = (call) => (notSymbol[call.shape] ? `target is not a symbol (${notSymbol[call.shape]})` : !atlas.symbols.has(call.id) ? "target is not a symbol (other)" : call.form);
  const percent = (found, total) => (total === 0 ? "n/a" : `${((100 * found) / total).toFixed(1)}%`);
  const importsFound = [...imports].filter((key) => atlas.imports.has(key)).length;
  const all = [...calls.values()];
  const found = all.filter((call) => atlas.calls.has(call.key));
  const missed = all.filter((call) => !atlas.calls.has(call.key));
  const nameable = all.filter((call) => atlas.symbols.has(call.id));
  const nameableFound = nameable.filter((call) => atlas.calls.has(call.key)).length;

  console.log(`${repo}: ${atlas.files.length} ${language} files`);
  console.log(`${uses} (file -> file): ${importsFound} of ${imports.size} found (${percent(importsFound, imports.size)})`);
  console.log(`calls (file -> symbol): ${found.length} of ${all.length} found (${percent(found.length, all.length)})`);
  console.log(`  leaving out targets that are not symbols: ${nameableFound} of ${nameable.length} (${percent(nameableFound, nameable.length)})`);
  console.log(`not counted: ${notCounted}, ${itself} calls of a symbol by itself (recursion, or one overload calling another)`);

  const count = (list, by) => {
    const counts = new Map();
    for (const item of list) counts.set(by(item), (counts.get(by(item)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  console.log("\nmissed calls, by the form of the call:");
  for (const [reason, n] of count(missed, reasonOf)) console.log(`  ${String(n).padStart(6)}  ${reason}`);
  console.log("\nfound calls, by form:");
  for (const [form, n] of count(found, (call) => call.form)) console.log(`  ${String(n).padStart(6)}  ${form}`);

  // One line for scripts/bench.mjs to read.
  process.stdout.write(`JSON ${JSON.stringify({ repo, lister, files: atlas.files.length, imports: { truth: imports.size, found: importsFound }, calls: { truth: all.length, found: found.length, withNode: nameable.length, foundWithNode: nameableFound } })}\n`);
  if (!missArg) return;
  const sample = missed.filter((call) => !only || reasonOf(call).startsWith(only));
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const picked = sample.map((call) => [random(), call]).sort((a, b) => a[0] - b[0]).slice(0, Number(missArg)).map((entry) => entry[1]);
  console.log(`\n${picked.length} missed calls${only ? ` (${only})` : ""}:`);
  for (const call of picked) {
    const text = (readFileSync(join(repo, call.from), "utf8").split("\n")[Number(call.line) - 1] ?? "").trim().slice(0, 140);
    console.log(`  ${call.from}:${call.line} -> ${call.id.replace(/^sym:/, "")}  [${reasonOf(call)}]\n      | ${text}`);
  }
  const lost = [...imports].filter((key) => !atlas.imports.has(key)).slice(0, Number(missArg));
  console.log(`\n${lost.length} missed ${uses}:`);
  for (const key of lost) console.log(`  ${key.replace("|", " -> ")}`);
}
