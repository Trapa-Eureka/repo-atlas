// Measures, on a fixed set of public repositories at fixed commits, how many of the calls and
// cross-file uses a compiler resolves are in atlas's graph, and writes the table to bench/results.md.
//
//   pnpm bench [--dir <folder>] [--only typescript|java|go]
//
// Each repository in bench/repos.json is fetched once into <folder> (default: .bench, which git
// ignores) at the commit written there; a folder that is already there is used if it is at that
// commit, and refused if it is not. Nothing in the repositories is built or run. The TypeScript
// compiler comes with this package; Java needs a JDK (17 or later) and Go needs `go`, and a
// language whose tool is missing is skipped and said to be.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const folder = resolve(option("--dir") ?? join(root, ".bench"));
const only = option("--only");

const MEASURES = {
  typescript: { title: "TypeScript / JavaScript", truth: "the TypeScript compiler", script: "recall.mjs", uses: "imports", tool: null },
  java: { title: "Java", truth: "javac", script: "recall-java.mjs", uses: "class uses", tool: ["java", "-version"] },
  go: { title: "Go", truth: "the Go type checker", script: "recall-go.mjs", uses: "package uses", tool: ["go", "version"] },
};

const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });

/** The first line a tool prints about its version, on either stream (`java -version` uses stderr), or null when it is not installed. */
function toolVersion(tool) {
  const result = spawnSync(tool[0], tool.slice(1), { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}\n${result.stderr}`.trim().split("\n")[0] ?? "";
}

/** The repository at its commit, fetched if it is not there yet. */
function checkout(repo) {
  const path = join(folder, repo.name);
  if (!existsSync(path)) {
    process.stderr.write(`fetching ${repo.name} at ${repo.commit.slice(0, 7)}\n`);
    mkdirSync(path, { recursive: true });
    run("git", ["-C", path, "init", "-q"]);
    run("git", ["-C", path, "fetch", "-q", "--depth", "1", repo.url, repo.commit]);
    run("git", ["-C", path, "checkout", "-q", "FETCH_HEAD"]);
  }
  const head = run("git", ["-C", path, "rev-parse", "HEAD"]).trim();
  if (head !== repo.commit) throw new Error(`${path} is at ${head.slice(0, 7)}, and bench/repos.json asks for ${repo.commit.slice(0, 7)}. Move it away, or check that commit out.`);
  return path;
}

const repos = JSON.parse(readFileSync(join(root, "bench/repos.json"), "utf8")).filter((repo) => !only || repo.measure === only);
const versions = {};
const rows = [];
const skipped = [];
mkdirSync(folder, { recursive: true });

for (const [measure, { tool, title }] of Object.entries(MEASURES)) {
  if (!repos.some((repo) => repo.measure === measure)) continue;
  versions[measure] = tool ? toolVersion(tool) : `typescript ${JSON.parse(readFileSync(join(root, "node_modules/typescript/package.json"), "utf8")).version}`;
  if (versions[measure] === null) skipped.push(`${title}: \`${tool[0]}\` is not on the PATH`);
}

for (const repo of repos) {
  if (versions[repo.measure] === null) continue;
  const path = checkout(repo);
  process.stderr.write(`measuring ${repo.name}\n`);
  run("node", [join(root, "dist/cli/main.js"), "-C", path, "index"]);
  const out = run("node", [join(here, MEASURES[repo.measure].script), path]);
  const line = out.split("\n").find((text) => text.startsWith("JSON "));
  if (!line) throw new Error(`${MEASURES[repo.measure].script} printed no result for ${repo.name}`);
  const result = JSON.parse(line.slice(5));
  rows.push({ ...repo, files: result.files ?? result.scriptFiles, uses: result.imports, calls: result.calls });
}

const percent = (found, total) => (total === 0 ? "n/a" : `${((100 * found) / total).toFixed(1)}%`);
const cell = (found, total) => `${found.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} (${percent(found, total)})`;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const lines = [
  "# Missed edges, measured",
  "",
  `repo-atlas ${version}. Written by \`pnpm bench\`; do not edit by hand.`,
  "",
  "For each repository, at the commit in [`repos.json`](repos.json), every call and every cross-file use that a compiler resolves to a declaration inside the repository is looked up in the graph. A call counts as found when the graph has a `calls` edge from the calling file to that function, method or class. \"Calls to symbols\" leaves out the targets the graph never makes a symbol of by design (a function inside a function, a method of an object literal, an interface method in Go). Nothing in the repositories is installed, built or run, so a call the compiler cannot resolve without the dependencies is not in the count.",
  "",
];
for (const [measure, { title, truth, uses }] of Object.entries(MEASURES)) {
  const mine = rows.filter((row) => row.measure === measure);
  if (mine.length === 0) continue;
  const sum = (pick) => mine.reduce((total, row) => total + pick(row), 0);
  lines.push(`## ${title}`, "", `Against ${truth} (${versions[measure]}).`, "", `| Repository | Commit | Files | ${uses[0].toUpperCase()}${uses.slice(1)} | Calls | Calls to symbols |`, "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const row of mine) {
    lines.push(`| [${row.name}](${row.url.replace(/\.git$/, "")}) | \`${row.commit.slice(0, 7)}\` | ${row.files.toLocaleString("en-US")} | ${cell(row.uses.found, row.uses.truth)} | ${cell(row.calls.found, row.calls.truth)} | ${cell(row.calls.foundWithNode, row.calls.withNode)} |`);
  }
  lines.push(`| **All** | | ${sum((row) => row.files).toLocaleString("en-US")} | ${cell(sum((row) => row.uses.found), sum((row) => row.uses.truth))} | **${cell(sum((row) => row.calls.found), sum((row) => row.calls.truth))}** | ${cell(sum((row) => row.calls.foundWithNode), sum((row) => row.calls.withNode))} |`, "");
}
if (skipped.length > 0) lines.push("Not measured in this run:", "", ...skipped.map((text) => `- ${text}`), "");
lines.push("Rust, Ruby and Python have no such measurement: a compiler's answer for them needs the dependencies built or a type checker installed. The README gives hand-read samples for Rust and Ruby.", "");

const text = lines.join("\n");
if (!only) writeFileSync(join(root, "bench/results.md"), text);
process.stdout.write(text);
if (only) process.stderr.write("(--only: bench/results.md was left as it is)\n");
