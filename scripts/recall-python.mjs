// Measures what atlas misses on a Python repository: every call and every imported name that the
// pyright type checker resolves to a function, class or file of that repository is looked up in
// atlas's graph. The repository's dependencies are not installed, so a call that cannot be resolved
// without them (a method of a value of a library type) is left out of the count. Nothing of the
// repository is run: Python's own parser lists the calls, and pyright is asked where each one leads.
//
//   pnpm build && node scripts/recall-python.mjs <repository> [--misses <n> [reason prefix]]
//
// Needs `python3` (3.8 or later) on the PATH, or named in PYTHON. pyright comes with this package.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atlasGraph, big, report } from "./recall-report.mjs";

const [repoArg, , missArg, only] = process.argv.slice(2);
if (!repoArg) throw new Error("usage: node scripts/recall-python.mjs <repository> [--misses <n> [reason prefix]]");
const repo = realpathSync(resolve(repoArg));
const here = dirname(fileURLToPath(import.meta.url));
const atlas = atlasGraph(repo, ".py");

/** The first Python that starts. A `python3` built for another processor is on some PATHs ahead of one that runs. */
function python() {
  for (const candidate of [process.env.PYTHON, "python3", "/usr/bin/python3", "python"]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("No Python that runs was found. Put python3 (3.8 or later) on the PATH, or name one in the PYTHON environment variable.");
}

const answers = execFileSync(python(), [join(here, "recall_python.py"), repo], { ...big, input: `${atlas.files.join("\n")}\n`, stdio: ["pipe", "pipe", "ignore"] })
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const pythonVersion = answers.find((answer) => answer.python)?.python ?? "?";
// A file this Python cannot parse (syntax of a newer version) is left out, and said to be.
const unparsed = answers.filter((answer) => answer.failed).map((answer) => answer.file);
const listed = answers.filter((answer) => answer.file && !answer.failed);
const defsAt = new Map();
for (const file of listed) for (const def of file.defs) defsAt.set(`${file.file}:${def.line}:${def.col}`, def);

// ---------- pyright, over the language server protocol ----------
// pyright looks for a `python` on the PATH and reads the packages installed for it. The measurement is of what
// can be told from the repository alone, on any machine, so the server is started where it finds none.
const server = spawn(process.execPath, [join(here, "../node_modules/pyright/langserver.index.js"), "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PATH: dirname(process.execPath), VIRTUAL_ENV: "", CONDA_PREFIX: "" } });
let finished = false;
server.on("exit", (code) => {
  if (finished) return;
  process.stderr.write(`The pyright language server stopped early (exit ${code}). Is the pyright package installed (pnpm install)?\n`);
  process.exit(1);
});
let buffer = Buffer.alloc(0);
let nextId = 1;
const waiting = new Map();
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1] ?? 0);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.id !== undefined && message.method === undefined) {
      waiting.get(message.id)?.(message.result ?? null);
      waiting.delete(message.id);
    } else if (message.id !== undefined) {
      // The server asks for its settings, or to register something: an empty answer is enough.
      send({ jsonrpc: "2.0", id: message.id, result: message.method === "workspace/configuration" ? message.params.items.map(() => ({})) : null });
    }
  }
});
function send(message) {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const request = (method, params) => new Promise((done) => {
  const id = nextId++;
  waiting.set(id, done);
  send({ jsonrpc: "2.0", id, method, params });
});
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const rootUri = pathToFileURL(repo).href;
await request("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "repo" }], capabilities: { textDocument: { definition: { linkSupport: false } }, workspace: { configuration: true, workspaceFolders: true } } });
notify("initialized", {});

/** Where the name at a position is defined, as paths inside the repository with the line and column of each. */
async function definitions(uri, line, col) {
  const result = await request("textDocument/definition", { textDocument: { uri }, position: { line: line - 1, character: col } });
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.map((item) => {
    const target = item.targetUri ?? item.uri;
    const range = item.targetSelectionRange ?? item.range;
    const path = target.startsWith("file:") ? relative(repo, realpathSync.native ? safeReal(fileURLToPath(target)) : fileURLToPath(target)) : "..";
    return { path: path.split("\\").join("/"), line: range.start.line + 1, col: range.start.character };
  });
}
function safeReal(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const indexed = new Set(atlas.files);
const rows = [];
let unresolved = 0;
let external = 0;
let values = 0;
for (const file of listed) {
  const uri = pathToFileURL(join(repo, file.file)).href;
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text: readFileSync(join(repo, file.file), "utf8") } });
  const found = await Promise.all([...file.calls.map((call) => definitions(uri, call.line, call.col)), ...file.names.map((name) => definitions(uri, name.line, name.col))]);
  file.calls.forEach((call, index) => {
    const leads = found[index];
    if (leads.length === 0) return void unresolved++;
    const inside = leads.filter((item) => indexed.has(item.path));
    if (inside.length === 0) return void external++;
    const defs = inside.map((item) => ({ item, def: defsAt.get(`${item.path}:${item.line}:${item.col}`) })).filter((entry) => entry.def);
    if (defs.length === 0) return void values++;
    const { item, def } = defs[0];
    // `Base.__init__(self)` and `super().__init__()` lead to the method, which the graph names when the class writes one.
    // Where it does not, the call is one of the class.
    const constructor = def.shape === "method" && (def.plain === "__init__" || def.plain === "__new__") && !atlas.symbols.has(`sym:${item.path}#${def.name}`);
    const name = constructor ? def.name.slice(0, def.name.lastIndexOf(".")) : def.name;
    rows.push(["C", file.file, item.path, name, constructor ? "class" : def.shape, call.form, call.line, call.around ?? ""].join("\t"));
  });
  file.names.forEach((name, index) => {
    // An imported name that is a function or a class leads to where that is defined, which is not the file the
    // statement names: only a module counts. The checker points at the top of a module's file, and so that a
    // variable on a first line is not taken for one, the file has to be called what the name says.
    for (const item of found[file.calls.length + index]) {
      const isModule = name.module || (item.line === 1 && item.col === 0 && (item.path.endsWith(`/${name.last}.py`) || item.path === `${name.last}.py` || item.path.endsWith(`${name.last}/__init__.py`)));
      if (indexed.has(item.path) && item.path !== file.file && isModule) rows.push(["I", file.file, item.path].join("\t"));
    }
  });
  notify("textDocument/didClose", { textDocument: { uri } });
}
finished = true;
server.kill();

report({
  repo,
  language: "Python",
  atlas,
  rows,
  uses: "imports of another file",
  notCounted: `${unparsed.length > 0 ? `${unparsed.length} files Python ${pythonVersion} could not parse (${unparsed.slice(0, 3).join(", ")}), ` : ""}${unresolved} calls pyright could not resolve without the dependencies, ${external} calls into the standard library and other packages, ${values} calls of something that is not a function or class (a variable, a parameter, an attribute)`,
  notSymbol: { "defined inside a function": "a function or class defined inside a function", "nested class or its method": "a class inside a class, or a method of one" },
  missArg,
  only,
  lister: `Python ${pythonVersion}`,
});
