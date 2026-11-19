import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emptyFacts, type FileFacts } from "../src/extract/facts.js";
import { Graph } from "../src/graph/graph.js";
import { link } from "../src/indexer/link.js";
import { impact } from "../src/query/impact.js";
import { mermaid } from "../src/query/mermaid.js";

function script(path: string, part: Partial<FileFacts> = {}): FileFacts {
  return { ...emptyFacts(path, "typescript"), ...part };
}

const imports = (specifier: string, names: [string, string][] = [], extra: Partial<FileFacts["imports"][number]> = {}) => ({
  specifier,
  names: names.map(([imported, local]) => ({ imported, local })),
  reexport: false,
  star: false,
  line: 1,
  ...extra,
});

const fn = (name: string, line = 1, endLine = line + 5) => ({ name, kind: "function" as const, line, endLine, exported: true, isDefault: false });
const edgeList = (files: FileFacts[], options = {}) => link(files, options).edges.map((edge) => `${edge.src} -${edge.kind}-> ${edge.dst}`);

describe("link", () => {
  it("resolves relative imports, compiled extensions and index files", () => {
    const edges = edgeList([
      script("src/a.ts", { imports: [imports("./b.js"), imports("./lib"), imports("react"), imports("@scope/pkg/deep"), imports("./missing")] }),
      script("src/b.ts"),
      script("src/lib/index.tsx"),
    ]);
    expect(edges).toEqual([
      "file:src/a.ts -imports-> file:src/b.ts",
      "file:src/a.ts -imports-> file:src/lib/index.tsx",
      "file:src/a.ts -imports-> mod:@scope/pkg",
      "file:src/a.ts -imports-> mod:react",
    ]);
  });

  it("resolves an import of the repository root folder", () => {
    const edges = edgeList([
      script("examples/auth/index.js", { imports: [imports("../.."), imports("../../")] }),
      script("test/app.js", { imports: [imports(".."), imports("../")] }),
      script("index.js"),
    ]);
    expect(edges).toEqual(["file:examples/auth/index.js -imports-> file:index.js", "file:test/app.js -imports-> file:index.js"]);
    expect(link([script("test/app.js", { imports: [imports("../..")] }), script("index.js")]).unresolved).toHaveLength(1);
  });

  it("reports unresolved local imports instead of inventing packages", () => {
    const result = link([script("src/a.ts", { imports: [imports("./missing"), imports("./style.css"), imports("../../outside")] })]);
    expect(result.unresolved.map((item) => item.specifier)).toEqual(["./missing", "../../outside"]);
    expect(result.nodes.filter((node) => node.kind === "module")).toEqual([]);
  });

  it("resolves tsconfig aliases inside their folder only", () => {
    const aliases = [{ scope: "web", prefix: "@/", exact: false, targets: ["web/src/"] }];
    const edges = edgeList(
      [script("web/src/page.ts", { imports: [imports("@/ui/button")] }), script("web/src/ui/button.ts"), script("api/main.ts", { imports: [imports("@/ui/button")] })],
      { aliases },
    );
    expect(edges).toEqual(["file:api/main.ts -imports-> mod:@/ui", "file:web/src/page.ts -imports-> file:web/src/ui/button.ts"]);
  });

  it("follows calls through named imports, namespaces, barrels and default exports", () => {
    const edges = edgeList([
      script("src/impl.ts", { symbols: [fn("work"), { ...fn("main", 10), isDefault: true }] }),
      script("src/index.ts", { imports: [imports("./impl.js", [], { reexport: true, star: true })] }),
      script("src/use.ts", {
        symbols: [fn("caller", 5, 20)],
        imports: [imports("./index.js", [["work", "renamed"]]), imports("./impl.js", [["*", "ns"], ["default", "entry"]])],
        calls: [
          { callee: "renamed", receiver: null, line: 6 },
          { callee: "work", receiver: "ns", line: 7 },
          { callee: "entry", receiver: null, line: 30 },
          { callee: "unknown", receiver: null, line: 8 },
        ],
      }),
    ]).filter((edge) => edge.includes("-calls->"));
    expect(edges).toEqual(["file:src/use.ts -calls-> sym:src/impl.ts#main", "sym:src/use.ts#caller -calls-> sym:src/impl.ts#work"]);
  });

  it("resolves this/self calls to methods of the same class", () => {
    const method = (name: string, line: number) => ({ name, kind: "method" as const, line, endLine: line + 2, exported: false, isDefault: false });
    const edges = edgeList([
      script("src/a.ts", {
        symbols: [{ ...fn("Box", 1, 20), kind: "class" }, method("Box.open", 2), method("Box.close", 6)],
        calls: [{ callee: "close", receiver: "this", line: 3 }],
      }),
    ]).filter((edge) => edge.includes("-calls->"));
    expect(edges).toEqual(["sym:src/a.ts#Box.open -calls-> sym:src/a.ts#Box.close"]);
  });

  it("resolves Python packages, submodules and relative imports", () => {
    const python = (path: string, part: Partial<FileFacts> = {}): FileFacts => ({ ...emptyFacts(path, "python"), ...part });
    const edges = edgeList([
      python("app/jobs/run.py", { imports: [imports("..core", [["db", "db"]]), imports("app.core.db", [["connect", "connect"]]), imports("requests", [["*", "requests"]])] }),
      python("app/core/__init__.py"),
      python("app/core/db.py"),
    ]);
    expect(edges).toEqual([
      "file:app/jobs/run.py -imports-> file:app/core/__init__.py",
      "file:app/jobs/run.py -imports-> file:app/core/db.py",
      "file:app/jobs/run.py -imports-> mod:requests",
    ]);
  });

  it("links docs to files, unique symbols, tables and env keys", () => {
    const edges = edgeList([
      script("src/pay.ts", { symbols: [fn("charge")], tables: [{ name: "invoices", op: "read", line: 3 }], envs: [{ name: "PAY_KEY", op: "use", line: 4 }] }),
      script("src/other.ts", { symbols: [fn("dup")] }),
      script("src/more.ts", { symbols: [fn("dup")] }),
      {
        ...emptyFacts("docs/pay.md", "markdown"),
        docRefs: ["../src/pay.ts", "pay.ts", "charge()", "invoices", "PAY_KEY", "dup", "nothing"].map((target, index) => ({ target, kind: index === 0 ? ("link" as const) : ("code" as const), line: index + 1 })),
      },
    ]).filter((edge) => edge.includes("-documents->"));
    expect(edges).toEqual([
      "file:docs/pay.md -documents-> env:PAY_KEY",
      "file:docs/pay.md -documents-> file:src/pay.ts",
      "file:docs/pay.md -documents-> sym:src/pay.ts#charge",
      "file:docs/pay.md -documents-> table:invoices",
    ]);
  });
});

// Any set of facts, however odd, must produce a well-formed graph. These hold for every input, so they
// are checked with generated inputs instead of hand-picked examples.
const NAMES = ["a", "b", "c", "d", "util", "index"];
const arbitraryFile = fc.record({
  folder: fc.constantFrom("", "src/", "src/lib/", "pkg/"),
  name: fc.constantFrom(...NAMES),
  language: fc.constantFrom("typescript" as const, "python" as const, "markdown" as const, "sql" as const),
  symbols: fc.uniqueArray(fc.constantFrom("run", "stop", "Box", "Box.open", "load"), { maxLength: 4 }),
  imports: fc.array(fc.record({ specifier: fc.constantFrom("./a", "./b.js", "../c", "./lib", ".", "..d", "src.a", "react", "@x/y", "./nope", "../../.."), name: fc.constantFrom("run", "stop", "Box", "default", "*", "="), reexport: fc.boolean(), star: fc.boolean() }), { maxLength: 4 }),
  calls: fc.array(fc.record({ callee: fc.constantFrom("run", "stop", "open", "load", "Box"), receiver: fc.constantFrom(null, "this", "self", "super", "this.box", "Box", "run", "box"), line: fc.integer({ min: 1, max: 40 }) }), { maxLength: 5 }),
  exports: fc.array(fc.record({ exported: fc.constantFrom("run", "default", "default.open", "Box"), local: fc.constantFrom("run", "stop", "Box", "load") }), { maxLength: 3 }),
  locals: fc.array(
    fc.record({
      name: fc.constantFrom("box", "run", "this.box", "load"),
      kind: fc.constantFrom("member" as const, "instance" as const, "other" as const),
      line: fc.integer({ min: 1, max: 30 }),
      length: fc.integer({ min: 0, max: 30 }),
    }),
    { maxLength: 4 },
  ),
  parent: fc.constantFrom(undefined, "Box", "run", "stop"),
  tables: fc.array(fc.record({ name: fc.constantFrom("users", "orders"), op: fc.constantFrom("define" as const, "read" as const, "write" as const) }), { maxLength: 3 }),
  docRefs: fc.array(fc.constantFrom("a.ts", "./b.py", "run()", "users", "Box.open", "../src/a.ts", "/"), { maxLength: 4 }),
});

const arbitraryFacts = fc.uniqueArray(arbitraryFile, { maxLength: 8, selector: (file) => `${file.folder}${file.name}.${file.language}` }).map((files) =>
  files.map((file): FileFacts => {
    const extension = { typescript: "ts", python: "py", markdown: "md", sql: "sql" }[file.language];
    return {
      ...emptyFacts(`${file.folder}${file.name}.${extension}`, file.language),
      symbols: file.symbols.map((name, index) => ({
        name,
        kind: name.includes(".") ? "method" : name === "Box" ? "class" : "function",
        line: index * 10 + 1,
        endLine: index * 10 + 9,
        exported: true,
        isDefault: index === 0,
        ...(name === "Box" && file.parent ? { extends: file.parent } : {}),
      })),
      exports: file.exports,
      locals: file.locals.map((local) => ({ name: local.name, kind: local.kind, object: "run", property: "open", type: "Box", line: local.line, endLine: local.line + local.length })),
      imports: file.imports.map((item, index) => ({ specifier: item.specifier, names: [{ imported: item.name, local: item.name === "*" || item.name === "default" || item.name === "=" ? "run" : item.name }], reexport: item.reexport, star: item.star, line: index + 1 })),
      calls: file.calls,
      tables: file.tables.map((table, index) => ({ ...table, line: index + 1 })),
      docRefs: file.docRefs.map((target, index) => ({ target, kind: "code", line: index + 1 })),
    };
  }),
);

describe("impact", () => {
  it("reports a doc that mentions an affected node but does not follow docs citing that doc", () => {
    const doc = (path: string, target: string): FileFacts => ({ ...emptyFacts(path, "markdown"), docRefs: [{ target, kind: "link", line: 1 }] });
    const result = link([script("src/a.ts"), doc("docs/a.md", "../src/a.ts"), doc("README.md", "docs/a.md")]);
    const graph = new Graph(result.nodes, result.edges);
    const target = graph.node("file:src/a.ts");
    expect(target && impact(graph, target).affected.map((entry) => entry.node.id)).toEqual(["file:docs/a.md"]);
  });
});

describe("link invariants", () => {
  it("never produces dangling edges, duplicates or self loops, and is deterministic", () => {
    fc.assert(
      fc.property(arbitraryFacts, (files) => {
        const result = link(files);
        const ids = new Set(result.nodes.map((node) => node.id));
        expect(ids.size).toBe(result.nodes.length);
        const keys = new Set<string>();
        for (const edge of result.edges) {
          expect(ids.has(edge.src) && ids.has(edge.dst)).toBe(true);
          expect(edge.src).not.toBe(edge.dst);
          keys.add(`${edge.src}|${edge.dst}|${edge.kind}`);
        }
        expect(keys.size).toBe(result.edges.length);
        expect(link([...files].reverse())).toEqual({ ...result, unresolved: expect.anything() });
        for (const file of files) expect(ids.has(`file:${file.path}`)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("impact never includes the target, never repeats a node, and grows with depth", () => {
    fc.assert(
      fc.property(arbitraryFacts, fc.integer({ min: 1, max: 4 }), (files, depth) => {
        const result = link(files);
        const graph = new Graph(result.nodes, result.edges);
        for (const target of result.nodes.slice(0, 6)) {
          const all = impact(graph, target);
          const limited = impact(graph, target, depth);
          const ids = all.affected.map((entry) => entry.node.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids).not.toContain(target.id);
          expect(limited.affected.every((entry) => entry.distance <= depth && ids.includes(entry.node.id))).toBe(true);
          expect(limited.affected.length < all.affected.length ? limited.truncatedAtDepth : null).toBe(limited.affected.length < all.affected.length ? depth : null);
          expect(mermaid(graph, { focus: target, depth }).text.startsWith("flowchart LR\n")).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
