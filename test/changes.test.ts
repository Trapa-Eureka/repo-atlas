import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Atlas } from "../src/app/atlas.js";
import { parsePatch } from "../src/app/git.js";
import { Graph } from "../src/graph/graph.js";
import type { GraphEdge, GraphNode } from "../src/graph/types.js";
import { changes, isTestPath, withoutQuietLines, type ChangedFile, type Span } from "../src/query/changes.js";

const FIXTURE = new URL("../fixtures/shop/", import.meta.url).pathname;
const ids = (nodes: { id: string }[]) => nodes.map((node) => node.id);

describe("isTestPath", () => {
  it("knows a test by its folder or its name, in each language", () => {
    const tests = ["test/a.ts", "src/a.test.ts", "src/__tests__/a.js", "web/a.spec.tsx", "pkg/store_test.go", "tests/test_a.py", "jobs/test_report.py", "jobs/report_test.py", "src/test/java/com/acme/ATest.java", "app/OrderServiceTests.java", "spec/policy_spec.rb", "crates/a/tests/it.rs", "e2e/login.ts"];
    const code = ["src/a.ts", "src/latest.ts", "src/contest/entry.py", "pkg/store.go", "jobs/testimony.py", "src/main/java/com/acme/Attest.java", "lib/inspect.rb", "src/protest.rs", "src/testing/fakes.ts", "pkg/testdata/sample.go"];
    expect(tests.filter((path) => !isTestPath(path))).toEqual([]);
    expect(code.filter(isTestPath)).toEqual([]);
  });
});

describe("parsePatch", () => {
  it("reads the lines each file has now, and where lines were only taken out", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3,2 @@ export function a() {",
      "-old",
      "+new",
      "+++ b/not-a-header",
      "@@ -10,2 +10,0 @@",
      "-gone",
      "-gone too",
      "@@ -20,0 +19 @@",
      "+added",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      'diff --git "a/with \\"quote\\".ts" "b/with \\"quote\\".ts"',
      '--- "a/with \\"quote\\".ts"',
      '+++ "b/with \\"quote\\".ts"',
      "@@ -0,0 +1 @@",
      "+z",
      "diff --git a/has space.ts b/has space.ts",
      "--- a/has space.ts\t",
      "+++ b/has space.ts\t",
      "@@ -1 +1 @@",
      "-p",
      "+q",
    ].join("\n");
    expect(Object.fromEntries(parsePatch(patch))).toEqual({
      "src/a.ts": { ranges: [[3, 4], [19, 19]], gaps: [10] },
      'with "quote".ts': { ranges: [[1, 1]], gaps: [] },
      "has space.ts": { ranges: [[1, 1]], gaps: [] },
    });
  });
});

describe("withoutQuietLines", () => {
  it("drops blank lines and lines that hold only a comment, by the language of the file", () => {
    const script = ["// note", "const a = 1; // kept", "", "/**", " * doc", " */", "export function b() {}", "#!not a comment here"].join("\n");
    expect(withoutQuietLines([[1, 8]], script, "typescript")).toEqual([[2, 2], [7, 8]]);
    expect(withoutQuietLines([[1, 1], [3, 6]], script, "typescript")).toEqual([]);
    const python = ["# note", "import os", "", "x = 1  # kept"].join("\n");
    expect(withoutQuietLines([[1, 4]], python, "python")).toEqual([[2, 2], [4, 4]]);
    expect(withoutQuietLines([[1, 2]], "-- note\nCREATE TABLE a (id INT);", "sql")).toEqual([[2, 2]]);
    // A star or a slash-star at the start of a line is a comment only where a block comment is open.
    const tricky = ["/* open", "  still", "* inside */", "*n = *n + 1", "  * h;", "*items() {", "/* note */ return a;", "/* whole */", 'const glob = "src/*";', "* 2", "x /* tail", "  code after a comment opened mid-line", "*/"].join("\n");
    expect(withoutQuietLines([[1, 13]], tricky, "go")).toEqual([[4, 7], [9, 13]]);
    // In Markdown a line that starts with # is a heading, and every line counts.
    expect(withoutQuietLines([[1, 3]], "# Title\n\ntext", "markdown")).toEqual([[1, 1], [3, 3]]);
  });
});

describe("changes", () => {
  const file = (path: string, detail = "typescript"): GraphNode => ({ id: `file:${path}`, kind: "file", name: path, file: path, line: null, detail });
  const symbol = (path: string, name: string, line: number, detail = "function"): GraphNode => ({ id: `sym:${path}#${name}`, kind: "symbol", name, file: path, line, detail });
  const edge = (src: string, kind: GraphEdge["kind"], dst: string, line: number | null = null): GraphEdge => ({ src, dst, kind, line });

  // a.ts: Box (1-20) with Box.open (3-6) and Box.close (8-11), then free() (30-34). b.ts calls Box.open; a.test.ts calls free.
  const nodes = [file("a.ts"), symbol("a.ts", "Box", 1, "class"), symbol("a.ts", "Box.open", 3, "method"), symbol("a.ts", "Box.close", 8, "method"), symbol("a.ts", "free", 30), file("b.ts"), symbol("b.ts", "use", 2), file("a.test.ts"), file("c.ts"), file("schema.sql", "sql"), { id: "table:users", kind: "table", name: "users", file: "schema.sql", line: 2, detail: null } as GraphNode, { id: "table:orders", kind: "table", name: "orders", file: "schema.sql", line: 8, detail: null } as GraphNode, file("docs.md", "markdown")];
  const edges = [
    ...["Box", "Box.open", "Box.close", "free"].map((name) => edge("file:a.ts", "defines", `sym:a.ts#${name}`)),
    edge("file:b.ts", "defines", "sym:b.ts#use"),
    edge("file:b.ts", "imports", "file:a.ts"),
    edge("sym:b.ts#use", "calls", "sym:a.ts#Box.open"),
    edge("file:a.test.ts", "calls", "sym:a.ts#free"),
    edge("file:c.ts", "imports", "file:b.ts"),
    edge("file:schema.sql", "defines_table", "table:users", 2),
    edge("file:schema.sql", "defines_table", "table:orders", 8),
    edge("sym:b.ts#use", "reads_table", "table:orders"),
    edge("file:docs.md", "documents", "sym:a.ts#Box.open"),
  ];
  const graph = new Graph(nodes, edges);
  const spans: Record<string, Span[]> = {
    "a.ts": [
      { id: "sym:a.ts#Box", line: 1, endLine: 20 },
      { id: "sym:a.ts#Box.open", line: 3, endLine: 6 },
      { id: "sym:a.ts#Box.close", line: 8, endLine: 11 },
      { id: "sym:a.ts#free", line: 30, endLine: 34 },
    ],
  };
  const run = (...files: Partial<ChangedFile>[]) =>
    changes(graph, { base: "HEAD", commit: "abc", files: files.map((item) => ({ path: "a.ts", status: "modified", ranges: [], gaps: [], ...item })) }, (path) => spans[path] ?? []);

  it("puts a changed line in the innermost symbol around it, and follows only that symbol", () => {
    const result = run({ ranges: [[4, 4]] });
    expect(result.changed).toEqual([{ file: "a.ts", status: "modified", nodes: [graph.node("sym:a.ts#Box.open")], fileLevel: false }]);
    // c.ts imports b.ts but calls nothing in it that changed: a caller's file is named, its importers are not.
    expect(ids(result.affected.map((entry) => entry.node))).toEqual(["sym:b.ts#use", "file:b.ts", "file:docs.md"]);
    expect(ids(result.docs)).toEqual(["file:docs.md"]);
    expect(result.tests).toEqual([]);
    // Nothing a test file depends on reaches Box.open.
    expect(ids(result.untested)).toEqual(["sym:a.ts#Box.open"]);
  });

  it("splits a range that runs over several symbols and the lines between them", () => {
    expect(ids(run({ ranges: [[5, 9]] }).changed[0]?.nodes ?? [])).toEqual(["sym:a.ts#Box", "sym:a.ts#Box.open", "sym:a.ts#Box.close"]);
    const between = run({ ranges: [[25, 31]] });
    expect(ids(between.changed[0]?.nodes ?? [])).toEqual(["sym:a.ts#free"]);
    expect(between.changed[0]?.fileLevel).toBe(true);
    // The file counts as changed, so its importers are affected; a test calls free(), so it is to be run and nothing is untested.
    expect(ids(between.affected.map((entry) => entry.node))).toEqual(["file:a.test.ts", "file:b.ts", "file:c.ts"]);
    expect(ids(between.tests)).toEqual(["file:a.test.ts"]);
    expect(ids(between.untested)).toEqual(["file:a.ts"]);
  });

  it("puts lines that were only taken out where they used to be", () => {
    expect(ids(run({ gaps: [4] }).changed[0]?.nodes ?? [])).toEqual(["sym:a.ts#Box.open"]);
    // After the last line of open(): the lines went missing from the class body, not from open().
    expect(ids(run({ gaps: [6] }).changed[0]?.nodes ?? [])).toEqual(["sym:a.ts#Box"]);
    expect(run({ gaps: [0] }).changed[0]).toMatchObject({ nodes: [], fileLevel: true });
    expect(run({ gaps: [34] }).changed[0]).toMatchObject({ nodes: [], fileLevel: true });
  });

  it("reads a migration by table, each definition running to the next", () => {
    const users = run({ path: "schema.sql", ranges: [[5, 5]] });
    expect(users.changed[0]).toMatchObject({ nodes: [{ id: "table:users" }], fileLevel: false });
    expect(users.affected).toEqual([]);
    const orders = run({ path: "schema.sql", gaps: [9] });
    expect(ids(orders.changed[0]?.nodes ?? [])).toEqual(["table:orders"]);
    expect(ids(orders.affected.map((entry) => entry.node))).toEqual(["sym:b.ts#use", "file:b.ts"]);
    expect(run({ path: "schema.sql", ranges: [[1, 1]] }).changed[0]).toMatchObject({ nodes: [], fileLevel: true });
  });

  it("leaves a file alone when only its comments, blank lines or permissions changed", () => {
    const result = run({ quiet: true }, { path: "b.ts" });
    expect(result.changed).toEqual([{ file: "a.ts", status: "modified", nodes: [], fileLevel: false, quiet: true }, { file: "b.ts", status: "modified", nodes: [], fileLevel: false }]);
    expect(result.affected).toEqual([]);
    expect(result.untested).toEqual([]);
  });

  it("takes a new file whole, a renamed one as a file, and leaves what the graph does not hold aside", () => {
    const result = run({ status: "untracked" }, { path: "b.ts", status: "renamed", from: "old.ts" }, { path: "gone.ts", status: "deleted" }, { path: "notes.txt", status: "added", ranges: [[1, 3]] });
    expect(result.changed.map((entry) => [entry.file, entry.nodes.length, entry.fileLevel])).toEqual([["a.ts", 4, true], ["b.ts", 0, true]]);
    expect(result.outside).toEqual([{ file: "gone.ts", status: "deleted" }, { file: "notes.txt", status: "added" }]);
  });

  it("names the imports a deleted or renamed file leaves behind", () => {
    const unresolved = [
      { file: "b.ts", specifier: "./gone.js", line: 1 },
      { file: "src/uses.ts", specifier: "./orders/order.service.js", line: 4 },
      // Was broken before and only shares a name with a deleted file somewhere else.
      { file: "src/typo.ts", specifier: "./gone.js", line: 1 },
      { file: "jobs/run.py", specifier: "jobs.report", line: 2 },
      { file: "b.ts", specifier: "./lib", line: 2 },
      { file: "c.ts", specifier: "./typo", line: 1 },
      { file: "m.rs", specifier: "crate::outbox::Thing", line: 3 },
    ];
    const files: ChangedFile[] = [
      { path: "gone.ts", status: "deleted", ranges: [], gaps: [] },
      { path: "lib/index.ts", status: "deleted", ranges: [], gaps: [] },
      { path: "src/orders/order.service.ts", status: "deleted", ranges: [], gaps: [] },
      { path: "jobs/report.py", status: "deleted", ranges: [], gaps: [] },
      { path: "src/queue.rs", from: "src/outbox.rs", status: "renamed", ranges: [], gaps: [] },
    ];
    expect(changes(graph, { base: "HEAD", commit: "abc", files }, () => [], unresolved).broken).toEqual([
      { file: "b.ts", line: 1, specifier: "./gone.js", gone: "gone.ts" },
      { file: "b.ts", line: 2, specifier: "./lib", gone: "lib/index.ts" },
      { file: "jobs/run.py", line: 2, specifier: "jobs.report", gone: "jobs/report.py" },
      { file: "m.rs", line: 3, specifier: "crate::outbox::Thing", gone: "src/outbox.rs" },
      { file: "src/uses.ts", line: 4, specifier: "./orders/order.service.js", gone: "src/orders/order.service.ts" },
    ]);
  });

  it("stops at the depth asked for and says so", () => {
    const result = changes(graph, { base: "HEAD", commit: "abc", files: [{ path: "a.ts", status: "modified", ranges: [[25, 25]], gaps: [] }] }, (path) => spans[path] ?? [], [], 1);
    expect(ids(result.affected.map((entry) => entry.node))).toEqual(["file:b.ts"]);
    expect(result.truncatedAtDepth).toBe(1);
  });
});

describe("Atlas.diff on a git repository", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const edit = (path: string, change: (source: string) => string) => writeFileSync(join(root, path), change(readFileSync(join(root, path), "utf8")));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atlas-diff-"));
    cpSync(FIXTURE, root, { recursive: true, filter: (source) => !source.includes(".atlas") });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports nothing when nothing changed", async () => {
    const atlas = await Atlas.open(root);
    expect(await atlas.diff()).toMatchObject({ base: "HEAD", changed: [], outside: [], affected: [], tests: [], untested: [], docs: [] });
    atlas.close();
  });

  it("maps uncommitted edits, new files and deletions onto the graph", async () => {
    edit("src/users/repo.ts", (source) => source.replace("return result.rows[0];", "return result.rows[0] ?? null;"));
    edit("src/db/schema.sql", (source) => source.replace("  email TEXT NOT NULL\n", "  email TEXT NOT NULL,\n  name TEXT\n"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/repo.test.ts"), 'import { findUser } from "../src/users/repo.js";\nfindUser(1);\n');
    writeFileSync(join(root, "notes.txt"), "not something the index reads\n");
    renameSync(join(root, "src/db/client.ts"), join(root, "src/db/conn.ts"));
    git("add", "-A", "src/db");

    const atlas = await Atlas.open(root);
    const result = await atlas.diff();
    expect(result.changed.map((entry) => [entry.file, entry.status, ids(entry.nodes), entry.fileLevel])).toEqual([
      ["src/db/conn.ts", "renamed", [], true],
      ["src/db/schema.sql", "modified", ["table:users"], false],
      ["src/users/repo.ts", "modified", ["sym:src/users/repo.ts#findUser"], false],
      ["test/repo.test.ts", "untracked", [], true],
    ]);
    expect(result.changed[0]?.from).toBe("src/db/client.ts");
    expect(result.outside).toEqual([{ file: "notes.txt", status: "untracked" }]);
    expect(result.broken.map((item) => `${item.file}:${item.line} ${item.specifier}`)).toEqual(["src/orders/service.ts:1 ../db/client.js", "src/users/repo.ts:1 ../db/client.js"]);
    const affected = ids(result.affected.map((entry) => entry.node));
    expect(affected).toContain("sym:src/api/handler.ts#handleOrder");
    expect(affected).toContain("file:scripts/report.py");
    expect(ids(result.tests)).toEqual(["file:test/repo.test.ts"]);
    expect(ids(result.docs)).toEqual(["file:docs/architecture.md"]);
    // Nothing imports the renamed file under its new name yet, so no test reaches it either.
    expect(ids(result.untested)).toEqual(["file:src/db/conn.ts"]);
    atlas.close();
  });

  it("does not count a comment as a change to the code around it", async () => {
    edit("src/users/repo.ts", (source) => source.replace("export async function findUser", "// Looks a user up by id.\n\nexport async function findUser").replace("  return result.rows[0];", "  // the first row, if any\n  return result.rows[0];"));
    const atlas = await Atlas.open(root);
    const result = await atlas.diff();
    expect(result.changed).toEqual([{ file: "src/users/repo.ts", status: "modified", nodes: [], fileLevel: false, quiet: true }]);
    expect(result.affected).toEqual([]);
    atlas.close();
  });

  it("compares with where the branch left another one, not with that branch as it is now", async () => {
    git("checkout", "-q", "-b", "feature");
    edit("src/users/repo.ts", (source) => source.replace("return result.rows[0];", "return result.rows[0] ?? null;"));
    git("commit", "-q", "-am", "on the branch");
    git("checkout", "-q", "main");
    edit("web/App.tsx", (source) => `${source}\n// changed on main after the branch left\n`);
    git("commit", "-q", "-am", "on main");
    git("checkout", "-q", "feature");

    const atlas = await Atlas.open(root);
    expect((await atlas.diff()).changed).toEqual([]);
    const result = await atlas.diff("main");
    expect(result.changed.map((entry) => entry.file)).toEqual(["src/users/repo.ts"]);
    expect(ids(result.untested)).toEqual(["sym:src/users/repo.ts#findUser"]);
    await expect(atlas.diff("no-such-branch")).rejects.toThrow(/Cannot compare with no-such-branch: fatal/);
    await expect(atlas.diff("--output=x")).rejects.toThrow(/Not a revision/);
    atlas.close();
  });

  it("reads the same lines whatever prefixes git is set to print, and re-reads the files first", async () => {
    const stale = await Atlas.open(root);
    stale.close();
    git("config", "diff.mnemonicPrefix", "true");
    edit("src/users/repo.ts", (source) => `export function added() {}\n\n${source}`.replace("return result.rows[0];", "return result.rows[0] ?? null;"));
    const atlas = await Atlas.open(root, { noRefresh: true });
    expect(ids((await atlas.diff()).changed[0]?.nodes ?? [])).toEqual(["sym:src/users/repo.ts#added", "sym:src/users/repo.ts#findUser"]);
    git("config", "diff.mnemonicPrefix", "false");
    git("config", "diff.noprefix", "true");
    expect(ids((await atlas.diff()).changed[0]?.nodes ?? [])).toEqual(["sym:src/users/repo.ts#added", "sym:src/users/repo.ts#findUser"]);
    atlas.close();
  });

  it("explains a repository with no commit and a branch with no shared history", async () => {
    git("checkout", "-q", "--orphan", "apart");
    git("commit", "-q", "-m", "unrelated");
    const atlas = await Atlas.open(root);
    await expect(atlas.diff("main")).rejects.toThrow(/shares no commit with HEAD/);
    atlas.close();

    const empty = mkdtempSync(join(tmpdir(), "atlas-empty-"));
    writeFileSync(join(empty, "a.ts"), "export function a() {}\n");
    execFileSync("git", ["-C", empty, "init", "-q"]);
    const fresh = await Atlas.open(empty);
    try {
      await expect(fresh.diff()).rejects.toThrow(/has no commit yet/);
    } finally {
      fresh.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("says so outside a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "atlas-plain-"));
    writeFileSync(join(plain, "a.ts"), "export function a() {}\n");
    const atlas = await Atlas.open(plain);
    try {
      await expect(atlas.diff()).rejects.toThrow(/not inside a git repository/);
    } finally {
      atlas.close();
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
