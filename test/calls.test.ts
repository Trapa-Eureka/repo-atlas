import { describe, expect, it } from "vitest";
import { extractFile } from "../src/extract/index.js";
import { link, type LinkOptions } from "../src/indexer/link.js";

const short = (id: string) => id.replace(/^(?:file|sym):/, "");

/** Edges of one kind in a small repository given as `{ path: source }`, from source text all the way through linking. */
async function edgesOf(kind: string, files: Record<string, string>, options: LinkOptions = {}): Promise<string[]> {
  const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
  const edges = link(facts, options).edges.filter((edge) => edge.kind === kind);
  return edges.map((edge) => `${short(edge.src)} -> ${short(edge.dst)}`).sort();
}

async function calls(files: Record<string, string>): Promise<string[]> {
  const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
  const edges = link(facts).edges.filter((edge) => edge.kind === "calls");
  return edges.map((edge) => `${edge.src.replace(/^(?:file|sym):/, "")} -> ${edge.dst.replace(/^sym:/, "")}`).sort();
}

describe("calls under another name", () => {
  it("follows a name a barrel imports and exports again", async () => {
    expect(
      await calls({
        "src/hono.ts": "export class Hono {}\nexport function raw() {}\n",
        "src/index.ts": 'import { Hono, raw as rawHtml } from "./hono";\nexport { Hono, rawHtml as raw };\n',
        "test/a.ts": 'import { Hono, raw } from "../src/index";\nnew Hono();\nraw();\n',
      }),
    ).toEqual(["test/a.ts -> src/hono.ts#Hono", "test/a.ts -> src/hono.ts#raw"]);
  });

  it("follows `export default name`", async () => {
    expect(
      await calls({
        "web/repos.jsx": "const Repos = () => null;\nexport default Repos;\n",
        "web/page.jsx": 'import List from "./repos";\nexport const Page = () => <List />;\n',
      }),
    ).toEqual(["web/page.jsx#Page -> web/repos.jsx#Repos"]);
  });

  it("follows the members of a default-exported object, called directly or taken out first", async () => {
    const db = "function parse() {}\nfunction raw() {}\nexport default { parse, rawQuery: raw };\n";
    expect(
      await calls({
        "lib/db.ts": db,
        "lib/other.ts": "function parse() {}\nexport default { parse };\n",
        "src/a.ts": 'import db from "../lib/db";\nimport other from "../lib/other";\nexport function one() {\n  const { parse, rawQuery } = db;\n  parse();\n  rawQuery();\n}\nexport function two() {\n  const { parse } = other;\n  parse();\n  db.parse();\n}\n',
      }),
    ).toEqual(["src/a.ts#one -> lib/db.ts#parse", "src/a.ts#one -> lib/db.ts#raw", "src/a.ts#two -> lib/db.ts#parse", "src/a.ts#two -> lib/other.ts#parse"]);
  });

  it("does not fall back to a function of the file when a local of that name hides it", async () => {
    expect(
      await calls({
        "src/a.ts": "function parse() {}\nexport function run(input: any) {\n  const { parse } = input;\n  parse();\n}\nexport function other() {\n  parse();\n}\n",
      }),
    ).toEqual(["src/a.ts#other -> src/a.ts#parse"]);
  });

  it("keeps a typed function constant callable", async () => {
    expect(await calls({ "src/a.ts": "type Getter = () => string;\nexport const get: Getter = () => 'x';\nexport function use() {\n  return get();\n}\n" })).toEqual([
      "src/a.ts#use -> src/a.ts#get",
    ]);
  });
});

describe("CommonJS", () => {
  it("links require() to module.exports, exports.name and a module passed on whole", async () => {
    expect(
      await calls({
        "index.js": 'module.exports = require("./lib/express");\n',
        "lib/express.js": 'var utils = require("./utils");\nexports = module.exports = createApplication;\nfunction createApplication() {\n  utils.compile();\n}\nexports.json = function () {};\n',
        "lib/utils.js": "exports.compile = function compile() {};\nfunction hidden() {}\nmodule.exports.flatten = hidden;\n",
        "test/app.js": 'var express = require("..");\nvar { flatten, compile: build } = require("../lib/utils");\nexpress();\nexpress.json();\nflatten();\nbuild();\n',
      }),
    ).toEqual([
      "lib/express.js#createApplication -> lib/utils.js#compile",
      "test/app.js -> lib/express.js#createApplication",
      "test/app.js -> lib/express.js#json",
      "test/app.js -> lib/utils.js#compile",
      "test/app.js -> lib/utils.js#hidden",
    ]);
  });

  it("links the named members of module.exports = { ... }, also when they are imports passed on", async () => {
    expect(
      await calls({
        "lib/get.js": "module.exports = function get() {};\n",
        "lib/api.js": 'const get = require("./get");\nfunction send() {}\nexports.get = get;\nmodule.exports = { get, post: send, put() {} };\n',
        "app.js": 'const api = require("./lib/api");\nconst { get, post } = await import("./lib/api");\napi.get();\napi.put();\nget();\npost();\n',
      }),
    ).toEqual(["app.js -> lib/api.js#send", "app.js -> lib/get.js#get"]);
  });

  it("does not turn functions written inside an exported object into symbols", async () => {
    expect(
      await calls({
        "lib/api.js": "export function save() {}\n",
        "lib/store.js": 'import { save } from "./api";\nexport default {\n  save() {\n    return save();\n  },\n};\n',
        "app.js": 'import { save } from "./lib/store";\nsave();\n',
      }),
    ).toEqual(["lib/store.js -> lib/api.js#save"]);
  });

  it("keeps a require() inside a function to that function", async () => {
    expect(
      await calls({
        "a.js": "exports.x = function () {};\n",
        "b.js": "exports.x = function () {};\n",
        "top.js": 'const util = require("./a");\nfunction one() {\n  util.x();\n}\nfunction two() {\n  const util = require("./b");\n  util.x();\n}\n',
      }),
    ).toEqual(["top.js#one -> a.js#x"]);
  });
});

describe("methods", () => {
  const service = "export class Base {\n  stop() {}\n}\nexport class Service extends Base {\n  run() {}\n  start = () => {\n    this.run();\n  };\n}\n";

  it("follows a variable made with new, a typed variable and a typed parameter", async () => {
    expect(
      await calls({
        "src/service.ts": service,
        "src/a.ts":
          'import { Service } from "./service";\nexport function made() {\n  const s = new Service();\n  s.run();\n}\nexport function typed(s: Service, other: Unknown) {\n  s.start();\n  other.run();\n}\nexport function annotated() {\n  const s: Service = create();\n  s.stop();\n}\nexport function untyped(s) {\n  s.run();\n}\n',
      }),
    ).toEqual([
      "src/a.ts#annotated -> src/service.ts#Base.stop",
      "src/a.ts#made -> src/service.ts#Service",
      "src/a.ts#made -> src/service.ts#Service.run",
      "src/a.ts#typed -> src/service.ts#Service.start",
      "src/service.ts#Service.start -> src/service.ts#Service.run",
    ]);
  });

  it("follows this.field, inherited methods and super", async () => {
    expect(
      await calls({
        "src/service.ts": service,
        "src/app.ts":
          'import { Service, Base } from "./service";\nexport class App extends Service {\n  private helper: Base;\n  constructor(private readonly main: Service) {\n    super();\n  }\n  go() {\n    this.helper.stop();\n    this.main.run();\n    this.stop();\n    super.run();\n    this.missing.run();\n  }\n}\n',
      }),
    ).toEqual([
      "src/app.ts#App.go -> src/service.ts#Base.stop",
      "src/app.ts#App.go -> src/service.ts#Service.run",
      "src/service.ts#Service.start -> src/service.ts#Service.run",
    ]);
  });

  it("lets an untyped declaration of the same name hide a typed one", async () => {
    expect(
      await calls({
        "lib/db.js": "export default { parse };\nfunction parse() {}\n",
        "src/a.ts":
          'import db from "../lib/db";\nclass App {\n  listen() {}\n}\nconst app = new App();\nconst { parse } = db;\napp.listen();\nexport function param(app) {\n  app.listen();\n}\nexport function arrow(list) {\n  list.forEach((app) => app.listen());\n  list.forEach(app => app.listen());\n}\nexport function inner() {\n  const app = make();\n  app.listen();\n}\nexport function loop(apps) {\n  for (const app of apps) {\n    app.listen();\n  }\n}\nexport function shadowed(parse) {\n  parse();\n}\nexport function generic<T extends App>(app: T) {\n  app.listen();\n}\nexport function used() {\n  parse();\n  app.listen();\n}\n',
      }),
    ).toEqual(["src/a.ts -> src/a.ts#App", "src/a.ts -> src/a.ts#App.listen", "src/a.ts#used -> lib/db.js#parse", "src/a.ts#used -> src/a.ts#App.listen"]);
  });

  it("tells a call apart from a parameter of the same name later on the line", async () => {
    expect(
      await calls({
        "lib/s.ts": "export function stream(c: unknown, run: (s: unknown) => void) {}\n",
        "src/a.ts": 'import { stream } from "../lib/s";\nexport function handler(c) {\n  return stream(c, (stream) => stream(1));\n}\n',
      }),
    ).toEqual(["src/a.ts#handler -> lib/s.ts#stream"]);
  });

  it("does not give a nested class's fields to the class around it", async () => {
    expect(
      await calls({
        "src/a.ts": "class Db {\n  q() {}\n}\nclass Other {}\nexport class Outer {\n  private db: Db;\n  make() {\n    return class {\n      constructor(private db: Other) {}\n    };\n  }\n  run() {\n    this.db.q();\n  }\n}\n",
      }),
    ).toEqual(["src/a.ts#Outer.run -> src/a.ts#Db.q"]);
  });

  it("keeps a name to the scope that declares it", async () => {
    expect(
      await calls({
        "src/a.ts": "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\nexport function one() {\n  const x = new A();\n  x.run();\n}\nexport function two() {\n  const x = new B();\n  x.run();\n}\n",
      }),
    ).toEqual(["src/a.ts#one -> src/a.ts#A", "src/a.ts#one -> src/a.ts#A.run", "src/a.ts#two -> src/a.ts#B", "src/a.ts#two -> src/a.ts#B.run"]);
  });
});

describe("env keys in code only", () => {
  it("ignores a key named in a string, a comment or a docstring", async () => {
    const script = await extractFile(
      "src/a.ts",
      "// process.env.IN_COMMENT\ntest('reads process.env.IN_TITLE by default', () => {});\nexport const a = process.env.REAL;\nexport const b = `${process.env.IN_TEMPLATE}/x`;\nexport const c = process.env['QUOTED'];\n",
    );
    expect(script.envs.map((env) => env.name).sort()).toEqual(["IN_TEMPLATE", "QUOTED", "REAL"]);
    const python = await extractFile("app/a.py", 'import os\n\ndef load():\n    """Call os.environ["IN_DOCSTRING"] first."""\n    # os.getenv("IN_COMMENT")\n    return os.environ["REAL"], os.getenv("ALSO_REAL")\n');
    expect(python.envs.map((env) => env.name).sort()).toEqual(["ALSO_REAL", "REAL"]);
  });
});

describe("Go", () => {
  const module: LinkOptions = {
    aliases: [
      { scope: "", prefix: "example.com/shop", exact: true, targets: [""], language: "go" },
      { scope: "", prefix: "example.com/shop/", exact: false, targets: [""], language: "go" },
    ],
  };
  const files = {
    "cmd/main.go":
      'package main\n\nimport (\n\t"fmt"\n\t"os"\n\n\tbill "example.com/shop/billing"\n\t"example.com/shop/missing"\n\t"github.com/acme/tool/v2/sub"\n)\n\nfunc main() {\n\tstore := bill.NewStore(os.Getenv("REGION"))\n\tservice := &bill.Service{Store: store}\n\tfmt.Println(service.Total(), bill.hidden(), sub.Run(), missing.X)\n\tvar audited bill.Audited\n\taudited.Load()\n\tother := bill.NewStore("x")\n\tother.Load()\n}\n',
    "billing/service.go":
      "package billing\n\ntype Service struct {\n\tStore *Store\n\tnames []string\n}\n\ntype Audited struct {\n\t*Store\n}\n\nfunc (s *Service) Total() int {\n\trows := s.Store.Load()\n\treturn sum(rows) + s.count()\n}\n\nfunc (s Service) count() int {\n\tsum := func(xs []int) int { return 0 }\n\treturn sum(nil)\n}\n",
    "billing/store.go":
      'package billing\n\ntype Store struct{}\n\nfunc NewStore(region string) *Store {\n\treturn &Store{}\n}\n\nfunc (st *Store) Load() []int {\n\tquery := `SELECT amount FROM invoices`\n\treturn run(query)\n}\n\nfunc run(q string) []int { return nil }\n\nfunc sum(xs []int) int { return 0 }\n\nfunc hidden() int { return 0 }\n',
    "billing/store_test.go": 'package billing\n\nimport "testing"\n\nfunc TestLoad(t *testing.T) {\n\ts := NewStore("eu")\n\ts.Load()\n\tvar st Store\n\tst.Load()\n}\n',
    "billing/unused.go": "package billing\n\nfunc Unused() {}\n",
  };

  it("resolves a module path to a package folder and depends on the files it uses", async () => {
    expect(await edgesOf("imports", files, module)).toEqual([
      "billing/store_test.go -> mod:testing",
      "cmd/main.go -> billing/service.go",
      "cmd/main.go -> billing/store.go",
      "cmd/main.go -> mod:fmt",
      "cmd/main.go -> mod:github.com/acme/tool",
      "cmd/main.go -> mod:os",
    ]);
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link(facts, module).unresolved).toEqual([{ file: "cmd/main.go", specifier: "example.com/shop/missing", line: 8 }]);
    expect(link(facts).unresolved).toEqual([]);
  });

  it("links package functions, methods on typed values and fields, and promoted methods", async () => {
    expect(await edgesOf("calls", files, module)).toEqual([
      "billing/service.go#Service.Total -> billing/service.go#Service.count",
      "billing/service.go#Service.Total -> billing/store.go#Store.Load",
      "billing/service.go#Service.Total -> billing/store.go#sum",
      "billing/store.go#Store.Load -> billing/store.go#run",
      "billing/store_test.go#TestLoad -> billing/store.go#NewStore",
      "billing/store_test.go#TestLoad -> billing/store.go#Store.Load",
      "cmd/main.go#main -> billing/service.go#Service.Total",
      "cmd/main.go#main -> billing/store.go#NewStore",
      "cmd/main.go#main -> billing/store.go#Store.Load",
    ]);
  });

  it("keeps to the calling file and to its own package when a folder declares a name twice", async () => {
    const script = (name: string) => `//go:build ignore\n\npackage main\n\nfunc helper() {}\n\nfunc main() {\n\thelper()\n}\n// ${name}\n`;
    expect(await edgesOf("calls", { "scripts/a.go": script("a"), "scripts/b.go": script("b") })).toEqual(["scripts/a.go#main -> scripts/a.go#helper", "scripts/b.go#main -> scripts/b.go#helper"]);
    expect(
      await edgesOf("calls", {
        "billing/store.go": "package billing\n\ntype Store struct{}\n\nfunc (s *Store) Load() {}\n\nfunc run() {}\n",
        "billing/x_test.go": "package billing_test\n\ntype Store struct{}\n\nfunc (s *Store) Load() {}\n\nfunc run() {}\n\nfunc TestX() {\n\trun()\n\ts := &Store{}\n\ts.Load()\n}\n",
        "billing/y_test.go": "package billing_test\n\nfunc TestY() {\n\trun()\n\tmissing()\n}\n",
      }),
    ).toEqual(["billing/x_test.go#TestX -> billing/x_test.go#Store.Load", "billing/x_test.go#TestX -> billing/x_test.go#run", "billing/y_test.go#TestY -> billing/x_test.go#run"]);
  });

  it("places a file on the constants, variables and methods of a package it uses, or on all of it", async () => {
    const billing = {
      "billing/store.go": "package billing\n\ntype Store struct{}\n\nfunc NewStore() *Store { return nil }\n",
      "billing/methods.go": "package billing\n\nfunc (s *Store) Load() {}\n",
      "billing/config.go": 'package billing\n\nconst DefaultRegion = "eu"\n\nvar (\n\tDefault = Store{}\n\tretries int\n)\n',
      "billing/other.go": "package billing\n\nfunc Other() {}\n",
    };
    const main = (body: string) => `package main\n\nimport "example.com/shop/billing"\n\nfunc main() {\n${body}}\n`;
    expect(await edgesOf("imports", { ...billing, "a/main.go": main("\t_ = billing.DefaultRegion\n") }, module)).toEqual(["a/main.go -> billing/config.go"]);
    expect(await edgesOf("imports", { ...billing, "a/main.go": main("\tvar s billing.Store\n\ts.Load()\n") }, module)).toEqual(["a/main.go -> billing/methods.go", "a/main.go -> billing/store.go"]);
    expect(await edgesOf("imports", { ...billing, "a/main.go": main("\tbilling.Other()\n\tbilling.Generated()\n") }, module)).toHaveLength(4);
    expect(await edgesOf("imports", { ...billing, "a/main.go": 'package main\n\nimport _ "example.com/shop/billing"\n' }, module)).toHaveLength(4);
  });

  it("does not take a conversion, a shadowed name or a type parameter for a call", async () => {
    expect(
      await edgesOf("calls", {
        "a/a.go":
          "package a\n\ntype ID string\n\ntype T struct{}\n\nfunc (t T) Load() {}\n\nfunc run() {}\n\nfunc convert(s string) ID {\n\treturn ID(s)\n}\n\nfunc named() (run int) {\n\trun()\n\treturn\n}\n\nfunc loop(fs []func()) {\n\tfor _, run := range fs {\n\t\trun()\n\t}\n\tif run := 1; run > 0 {\n\t}\n\trun()\n}\n\nfunc Generic[T interface{ Load() }](x T) {\n\tx.Load()\n}\n",
      }),
    ).toEqual(["a/a.go#loop -> a/a.go#run"]);
  });

  it("follows generic receivers, every embedded type, and a package named differently from its folder", async () => {
    expect(
      await edgesOf(
        "calls",
        {
          "go-utils/stack.go": "package utils\n\ntype Stack[T any] struct{}\n\nfunc (s *Stack[T]) Push(v T) {}\n\ntype Left struct{}\n\ntype Mid struct{}\n\nfunc (m Mid) Met() {}\n\ntype Tree struct {\n\tLeft\n\tMid\n\t*Tree\n}\n\nfunc Help() {}\n",
          "cmd/main.go": 'package main\n\nimport "example.com/shop/go-utils"\n\nfunc main() {\n\tstack := &utils.Stack[int]{}\n\tstack.Push(1)\n\tvar s utils.Tree\n\ts.Met()\n\ts.Nope()\n\tutils.Help()\n}\n',
        },
        module,
      ),
    ).toEqual(["cmd/main.go#main -> go-utils/stack.go#Help", "cmd/main.go#main -> go-utils/stack.go#Mid.Met", "cmd/main.go#main -> go-utils/stack.go#Stack.Push"]);
  });

  it("gives the same graph whatever order the files come in", async () => {
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link([...facts].reverse(), module)).toEqual(link(facts, module));
  });

  it("reads tables and env keys", async () => {
    expect(await edgesOf("reads_table", files, module)).toEqual(["billing/store.go -> table:invoices"]);
    expect(await edgesOf("uses_env", files, module)).toEqual(["cmd/main.go -> env:REGION"]);
  });

  it("follows a method on what a call returns: a variable made by a call, and a call made on a call", async () => {
    const store =
      "package store\n\ntype Store struct{}\n\ntype Row struct{}\n\ntype Reader interface {\n\tRead()\n}\n\nfunc Open(path string) (*Store, error) {\n\treturn &Store{}, nil\n}\n\nfunc Anything() interface{} {\n\treturn nil\n}\n\nfunc Rows() []*Row {\n\treturn nil\n}\n\nfunc (s *Store) First() *Row {\n\treturn &Row{}\n}\n\nfunc (s *Store) Last() *Row {\n\treturn &Row{}\n}\n\nfunc (s *Store) Close() {}\n\nfunc (r *Row) Name() string {\n\treturn \"\"\n}\n\nfunc (r *Row) Size() int {\n\treturn 0\n}\n";
    const main = (body: string) => `package main\n\nimport "example.com/shop/store"\n\ntype Store struct{}\n\nfunc (s *Store) First() {}\n\nfunc other() *int {\n\treturn nil\n}\n\nfunc main() {\n${body}}\n`;
    const from = async (body: string) => (await edgesOf("calls", { "store/store.go": store, "cmd/main.go": main(body) }, module)).map((edge) => edge.replace("cmd/main.go#main -> ", ""));

    // A variable made by a call, also the first of two; the type is the one of the file that declares the function, not the caller's `Store`.
    expect(await from('\tdb, err := store.Open("x")\n\t_ = err\n\tdb.Close()\n')).toEqual(["store/store.go#Open", "store/store.go#Store.Close"]);
    expect(await from('\tvar db, _ = store.Open("x")\n\trow := db.Last()\n\trow.Size()\n')).toEqual(["store/store.go#Open", "store/store.go#Row.Size", "store/store.go#Store.Last"]);
    // A call made on a call.
    expect(await from('\tdb, _ := store.Open("x")\n\tdb.First().Name()\n')).toEqual(["store/store.go#Open", "store/store.go#Row.Name", "store/store.go#Store.First"]);
    // Nothing when what is returned is not one type of the repository, or when a nearer declaration hides the name.
    expect(await from("\tunknown := store.Anything()\n\tunknown.Close()\n\trows := store.Rows()\n\trows.Name()\n")).toEqual(["store/store.go#Anything", "store/store.go#Rows"]);
    expect(await from('\tdb, _ := store.Open("x")\n\tif db := other(); db != nil {\n\t\tdb.Close()\n\t}\n')).toEqual(["cmd/main.go#other", "store/store.go#Open"]);
    expect(await from('\tdb, _ := store.Open("x")\n\tswitch db := v.(type) {\n\tcase int:\n\t\tdb.Close()\n\t}\n\tselect {\n\tcase db := <-ch:\n\t\tdb.Close()\n\t}\n')).toEqual(["store/store.go#Open"]);
  });

  it("does not take a type parameter for a type of the package", async () => {
    expect(
      await edgesOf("calls", {
        "lib/lib.go":
          "package lib\n\ntype Key struct{}\n\ntype Node struct{}\n\nfunc (k *Key) Hash() {}\n\nfunc (n *Node) Walk() {}\n\ntype Cache[Key comparable] struct{}\n\nfunc (c *Cache[Key]) Lookup() Key {\n\tvar k Key\n\treturn k\n}\n\nfunc NewCache() *Cache[string] {\n\treturn nil\n}\n\nfunc First[Node any](xs []Node) Node {\n\treturn xs[0]\n}\n\nfunc use(xs []int) {\n\tc := NewCache()\n\tk := c.Lookup()\n\tk.Hash()\n\tn := First(xs)\n\tn.Walk()\n}\n",
      }),
    ).toEqual(["lib/lib.go#use -> lib/lib.go#Cache.Lookup", "lib/lib.go#use -> lib/lib.go#First", "lib/lib.go#use -> lib/lib.go#NewCache"]);
  });

  it("reads the right side of a declaration before the name it declares", async () => {
    expect(
      await edgesOf(
        "calls",
        {
          "view/view.go": "package view\n\ntype View struct{}\n\nfunc New() *View {\n\treturn &View{}\n}\n\nfunc (v *View) Render() {}\n",
          "ui/page.go": 'package ui\n\nimport "example.com/shop/view"\n\nfunc show() {\n\tview := view.New()\n\tview.Render()\n}\n',
        },
        module,
      ),
    ).toEqual(["ui/page.go#show -> view/view.go#New", "ui/page.go#show -> view/view.go#View.Render"]);
  });
});

describe("Java", () => {
  const java = (pkg: string, body: string) => `package ${pkg};\n\n${body}`;
  const files = {
    "app/src/main/java/com/acme/app/Main.java": java(
      "com.acme.app",
      'import com.acme.store.Repo;\nimport com.acme.util.*;\nimport static com.acme.util.Text.shout;\nimport java.util.List;\nimport com.acme.store.Missing;\n\npublic class Main extends Base {\n    private final Repo repo = new Repo();\n    private Helper helper;\n\n    void run(Service service, List<String> names) {\n        repo.save("a");\n        this.repo.save("b");\n        service.start();\n        helper.help();\n        shout("x");\n        Text.shout("y");\n        setup();\n        super.setup();\n        var other = new Repo();\n        other.find();\n        names.size();\n        String env = System.getenv("APP_ZONE");\n        for (Repo each : List.of(repo)) {\n            each.find();\n        }\n        Runnable later = () -> missing();\n    }\n\n    void shadow(String repo) {\n        repo.save();\n    }\n\n    static class Inner {\n        void go(Main main) {\n            main.run(null, null);\n            outerHelp();\n        }\n    }\n\n    static void outerHelp() {\n    }\n}\n',
    ),
    "app/src/main/java/com/acme/app/Base.java": java("com.acme.app", "class Base {\n    void setup() {\n    }\n}\n"),
    "app/src/main/java/com/acme/app/Service.java": java("com.acme.app", "interface Service extends Startable {\n}\n"),
    "app/src/main/java/com/acme/app/Startable.java": java("com.acme.app", "interface Startable {\n    void start();\n}\n"),
    "lib/src/main/java/com/acme/util/Helper.java": java("com.acme.util", "public class Helper {\n    public void help() {\n    }\n}\n"),
    "lib/src/main/java/com/acme/util/Text.java": java("com.acme.util", "public final class Text {\n    public static String shout(String s) {\n        return s;\n    }\n}\n"),
    "lib/src/main/java/com/acme/util/Unused.java": java("com.acme.util", "public class Unused {\n}\n"),
    "lib/src/main/java/com/acme/store/Repo.java": java(
      "com.acme.store",
      'import jakarta.persistence.Table;\n\n@Table(name = "Orders")\npublic class Repo {\n    public void save(String id) {\n        run("INSERT INTO audit (id) VALUES (?)");\n    }\n\n    public Object find() {\n        return null;\n    }\n\n    @Query("select o from OrderEntity o")\n    void jpql() {\n    }\n\n    @Query(value = "select * from shipments", nativeQuery = true)\n    void sql() {\n    }\n\n    private void run(String sql) {\n    }\n}\n',
    ),
  };
  const at = (path: string) => path.replace(/^.*\/java\//, "");
  const edges = async (kind: string) => (await edgesOf(kind, files)).map((edge) => edge.split(" -> ").map(at).join(" -> "));

  it("depends on the files of the classes it names, imported or not", async () => {
    expect(await edges("imports")).toEqual([
      "com/acme/app/Main.java -> com/acme/app/Base.java",
      "com/acme/app/Main.java -> com/acme/app/Service.java",
      "com/acme/app/Main.java -> com/acme/store/Repo.java",
      "com/acme/app/Main.java -> com/acme/util/Helper.java",
      "com/acme/app/Main.java -> com/acme/util/Text.java",
      "com/acme/app/Main.java -> mod:java.util",
      "com/acme/app/Service.java -> com/acme/app/Startable.java",
      "com/acme/store/Repo.java -> mod:jakarta.persistence",
    ]);
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link(facts).unresolved.map((item) => item.specifier)).toEqual(["com.acme.store.Missing"]);
  });

  it("links methods through fields, parameters, interfaces, inheritance, static imports and nested classes", async () => {
    expect(await edges("calls")).toEqual([
      "com/acme/app/Main.java#Main -> com/acme/store/Repo.java#Repo",
      "com/acme/app/Main.java#Main.Inner.go -> com/acme/app/Main.java#Main.outerHelp",
      "com/acme/app/Main.java#Main.Inner.go -> com/acme/app/Main.java#Main.run",
      "com/acme/app/Main.java#Main.run -> com/acme/app/Base.java#Base.setup",
      "com/acme/app/Main.java#Main.run -> com/acme/app/Startable.java#Startable.start",
      "com/acme/app/Main.java#Main.run -> com/acme/store/Repo.java#Repo",
      "com/acme/app/Main.java#Main.run -> com/acme/store/Repo.java#Repo.find",
      "com/acme/app/Main.java#Main.run -> com/acme/store/Repo.java#Repo.save",
      "com/acme/app/Main.java#Main.run -> com/acme/util/Helper.java#Helper.help",
      "com/acme/app/Main.java#Main.run -> com/acme/util/Text.java#Text.shout",
      "com/acme/store/Repo.java#Repo.save -> com/acme/store/Repo.java#Repo.run",
    ]);
  });

  it("reads tables from SQL and @Table, not from JPQL, and env keys from System.getenv", async () => {
    expect([...(await edges("defines_table")), ...(await edges("reads_table")), ...(await edges("writes_table"))]).toEqual([
      "com/acme/store/Repo.java -> table:orders",
      "com/acme/store/Repo.java -> table:shipments",
      "com/acme/store/Repo.java -> table:audit",
    ]);
    expect(await edges("uses_env")).toEqual(["com/acme/app/Main.java -> env:APP_ZONE"]);
  });

  it("gives the same graph whatever order the files come in", async () => {
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link([...facts].reverse())).toEqual(link(facts));
  });

  it("looks a type name up where it is written: nested types of the classes around it first, never of an unrelated class", async () => {
    expect(
      await edgesOf("calls", {
        "a/Repo.java": java("a", "class Repo {\n    void save() {\n    }\n}\n"),
        "a/M.java": java(
          "a",
          "class M {\n    void f(Repo r) {\n        r.save();\n    }\n\n    static class In {\n        static class Repo {\n            void save() {\n            }\n        }\n\n        void g(Repo r) {\n            r.save();\n        }\n    }\n}\n\nclass Other {\n    static class Repo {\n        void save() {\n        }\n    }\n}\n",
        ),
      }),
    ).toEqual(["a/M.java#M.In.g -> a/M.java#M.In.Repo.save", "a/M.java#M.f -> a/Repo.java#Repo.save"]);
  });

  it("keeps an anonymous class apart from the class it is written in", async () => {
    const result = await edgesOf("calls", {
      "a/Repo.java": java("a", "class Repo {\n    void save() {\n    }\n}\n"),
      "a/Svc.java": java("a", "class Svc {\n    void save() {\n    }\n}\n"),
      "a/M.java": java(
        "a",
        "class M {\n    Repo repo;\n\n    void f() {\n        Runnable r = new Runnable() {\n            Svc repo = new Svc();\n\n            public void run() {\n                repo.save();\n                helper();\n            }\n        };\n    }\n\n    void g() {\n        repo.save();\n    }\n\n    void helper() {\n    }\n}\n",
      ),
    });
    expect(result).toEqual(["a/M.java#M.f -> a/Svc.java#Svc", "a/M.java#M.f -> a/Svc.java#Svc.save", "a/M.java#M.g -> a/Repo.java#Repo.save"]);
  });

  it("does not take a type parameter for a class, or an outer method for one of a value", async () => {
    expect(
      await edgesOf("calls", {
        "a/T.java": java("a", "class T {\n    void save() {\n    }\n}\n"),
        "a/M.java": java(
          "a",
          "class M<T> {\n    void f(T t) {\n        t.save();\n    }\n\n    void close() {\n    }\n\n    static abstract class In extends java.io.InputStream {\n        void own() {\n            close();\n        }\n    }\n\n    void g(In in) {\n        in.close();\n    }\n}\n",
        ),
      }),
    ).toEqual(["a/M.java#M.In.own -> a/M.java#M.close"]);
  });

  it("prefers the declaration in the nearest source root, and a parameter over a field on one line", async () => {
    const repo = (mark: string) => java("a", `class Repo {\n    void save${mark}() {\n    }\n}\n`);
    expect(
      await edgesOf("calls", {
        "x/src/main/java/a/Repo.java": repo("X"),
        "y/src/main/java/a/Repo.java": repo("Y"),
        "y/src/main/java/a/U.java": java("a", "class U {\n    void f(Repo r) {\n        r.saveY();\n        r.saveX();\n    }\n}\n"),
        "y/src/main/java/a/Svc.java": java("a", "class Svc {\n    void go() {\n    }\n}\n"),
        "y/src/main/java/a/One.java": java("a", "class One { Repo repo; void f(Svc repo) { repo.go(); } }\n"),
      }),
    ).toEqual(["y/src/main/java/a/One.java#One.f -> y/src/main/java/a/Svc.java#Svc.go", "y/src/main/java/a/U.java#U.f -> y/src/main/java/a/Repo.java#Repo.saveY"]);
  });
  it("follows a method on what a call gives: new, a chain, and a var made by a call", async () => {
    const lib = {
      "src/com/acme/Builder.java":
        "package com.acme;\n\npublic class Builder<Item> {\n    public Builder name(String n) {\n        return this;\n    }\n\n    public Report build() {\n        return new Report();\n    }\n\n    public Item first() {\n        return null;\n    }\n\n    public <Elem> Elem map() {\n        return null;\n    }\n\n    public <Elem> void local() {\n        class Loc {\n            Elem get() {\n                return null;\n            }\n        }\n        new Loc().get().print();\n    }\n\n    public java.util.List<Report> all() {\n        return null;\n    }\n\n    public Report pick(int i) {\n        return null;\n    }\n\n    public String pick(String s) {\n        return s;\n    }\n\n    public static Builder<String> start() {\n        return new Builder<>();\n    }\n}\n",
      "src/com/acme/Report.java": "package com.acme;\n\npublic class Report {\n    public void print() {}\n\n    public Report copy() {\n        return this;\n    }\n}\n",
      "src/com/acme/Item.java": "package com.acme;\n\npublic class Item {\n    public void print() {}\n}\n",
      "src/com/acme/Elem.java": "package com.acme;\n\npublic class Elem {\n    public void print() {}\n}\n",
    };
    const from = async (body: string) =>
      (await edgesOf("calls", { ...lib, "src/com/acme/App.java": `package com.acme;\n\npublic class App {\n    void run() {\n${body}    }\n}\n` }))
        .filter((edge) => edge.startsWith("src/com/acme/App.java"))
        .map((edge) => edge.replace("src/com/acme/App.java#App.run -> src/com/acme/", ""));

    // A class declared inside a generic method sees the method's type parameter, not the class of that name.
    expect((await edgesOf("calls", lib)).filter((edge) => edge.includes("Elem"))).toEqual([]);
    // `new T()` and a static factory start a chain; each method is looked up on what the one before returns.
    expect(await from('        new Builder<String>().name("a").build().print();\n')).toEqual(["Builder.java#Builder", "Builder.java#Builder.build", "Builder.java#Builder.name", "Report.java#Report.print"]);
    expect(await from("        Builder.start().build().copy();\n")).toEqual(["Builder.java#Builder.build", "Builder.java#Builder.start", "Report.java#Report.copy"]);
    // `var` takes its class from the call.
    expect(await from("        var report = Builder.start().build();\n        report.print();\n")).toEqual(["Builder.java#Builder.build", "Builder.java#Builder.start", "Report.java#Report.print"]);
    // Nothing for a type parameter of the class or of the method, a collection, or overloads that return different things.
    expect(await from("        Builder.start().first().print();\n        Builder.start().map().print();\n        Builder.start().all().print();\n        Builder.start().pick(1).print();\n")).toEqual([
      "Builder.java#Builder.all",
      "Builder.java#Builder.first",
      "Builder.java#Builder.map",
      "Builder.java#Builder.pick",
      "Builder.java#Builder.start",
    ]);
  });
  it("resolves what a method returns where the method is declared, and stops at an overload it cannot tell apart", async () => {
    const files = {
      "a/Report.java": "package a;\n\npublic class Report {\n    public void print() {}\n}\n",
      "a/Other.java": "package a;\n\npublic class Other {\n    public void print() {}\n}\n",
      "a/Base.java": "package a;\n\npublic class Base {\n    public Report pick(int i) {\n        return null;\n    }\n\n    public Base self() {\n        return this;\n    }\n\n    public Report made() {\n        return null;\n    }\n}\n",
      "a/Sub.java": "package a;\n\npublic class Sub extends Base {\n    public Other pick(String s) {\n        return null;\n    }\n\n    @Override\n    public Sub self() {\n        return this;\n    }\n\n    public void only() {}\n\n    public static Sub sub() {\n        return null;\n    }\n}\n",
      "b/Report.java": "package b;\n\npublic class Report {\n    public void print() {}\n}\n",
      "b/App.java":
        "package b;\n\nimport a.Sub;\n\npublic class App {\n    Report mine() {\n        return null;\n    }\n\n    void run() {\n        Sub.sub().made().print();\n        Sub.sub().pick(1).print();\n        Sub.sub().self().only();\n        for (var each : Sub.sub().self()) {\n            each.only();\n        }\n        new Runnable() {\n            public void run() {\n                mine().print();\n            }\n        };\n    }\n}\n",
    };
    expect((await edgesOf("calls", files)).filter((edge) => edge.startsWith("b/App.java"))).toEqual([
      // `made()` is declared in package a: its `Report` is a.Report, not the caller's own b.Report.
      "b/App.java#App.run -> a/Base.java#Base.made",
      "b/App.java#App.run -> a/Report.java#Report.print",
      // `pick` is overloaded across Sub and Base with different results: nothing after it. `self` is overridden, so its result holds.
      "b/App.java#App.run -> a/Sub.java#Sub.only",
      "b/App.java#App.run -> a/Sub.java#Sub.pick",
      "b/App.java#App.run -> a/Sub.java#Sub.self",
      "b/App.java#App.run -> a/Sub.java#Sub.sub",
    ]);
  });
});

describe("a name declared inside a case clause", () => {
  it("hides the one around it, in TypeScript and in Go", async () => {
    expect(
      await calls({
        "src/a.ts":
          "class A {\n  m() {}\n}\nclass B {\n  m() {}\n}\nexport function f(k: number, xs: A[]) {\n  for (const x of xs)\n    switch (k) {\n      case 1:\n        const x = new B();\n        x.m();\n    }\n  const later = 1;\n  const more = 2;\n  return later + more;\n}\n",
      }),
    ).toEqual(["src/a.ts#f -> src/a.ts#B", "src/a.ts#f -> src/a.ts#B.m"]);
    expect(
      await edgesOf("calls", {
        "a/a.go":
          "package a\n\ntype Aa struct{}\n\ntype Bb struct{}\n\nfunc (b Bb) N() {}\n\nfunc f(k int) {\n\tswitch x := (Aa{}); k {\n\tcase 1:\n\t\tvar x Bb\n\t\tx.N()\n\t}\n\tone := 1\n\ttwo := 2\n\tthree := 3\n\t_ = one + two + three\n}\n",
      }),
    ).toEqual(["a/a.go#f -> a/a.go#Bb.N"]);
  });
});

describe("Rust", () => {
  const crates: LinkOptions = { aliases: [{ scope: "", prefix: "shop_core", exact: true, targets: ["core", "src/lib.rs"], language: "rust" }] };
  const files = {
    "app/src/main.rs":
      'mod mailer;\nmod store;\nmod util;\n\nuse anyhow::anyhow;\nuse mailer::{Mailer, Sender as Out};\nuse shop_core::audit::record;\nuse shop_core::Clock;\nuse store::*;\nuse util::helper as help;\n\nfn main() {\n    let mailer = Mailer::new(std::env::var("SMTP_HOST").unwrap());\n    mailer.send("hi");\n    mailer.flush();\n    let store = Store { repo: Repo::default() };\n    store.load();\n    help();\n    util::helper();\n    crate::util::deep::dive();\n    record("start");\n    let clock = Clock::new();\n    clock.now();\n    let unknown = make();\n    unknown.send("x");\n    notify(&mailer);\n    assert_eq!(total(1), 1);\n    anyhow!("x");\n}\n\nfn notify(out: &dyn Out) {\n    out.send("later");\n}\n\nfn total(n: u8) -> u8 {\n    n\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        super::total(2);\n        total(3);\n    }\n}\n',
    "app/src/mailer.rs":
      "pub trait Sender {\n    fn send(&self, body: &str);\n\n    fn flush(&self) {\n        self.send(\"\");\n    }\n}\n\npub struct Mailer {\n    host: String,\n}\n\nimpl Mailer {\n    pub fn new(host: String) -> Self {\n        Self::check(&host);\n        Mailer { host }\n    }\n\n    fn check(host: &str) {}\n}\n\nimpl Sender for Mailer {\n    fn send(&self, body: &str) {}\n}\n",
    "app/src/store.rs":
      'pub struct Repo;\n\nimpl Default for Repo {\n    fn default() -> Self {\n        Repo\n    }\n}\n\nimpl Repo {\n    pub fn find(&self) -> u8 {\n        let sql = "SELECT id FROM notifications";\n        1\n    }\n}\n\npub struct Store {\n    pub repo: Repo,\n}\n\nimpl Store {\n    pub fn load(&self) -> u8 {\n        self.repo.find()\n    }\n}\n',
    "app/src/util/mod.rs": "pub mod deep;\n\npub fn helper() {}\n",
    "app/src/util/deep.rs": "pub fn dive() {\n    super::helper();\n}\n",
    "core/src/lib.rs": "pub mod audit;\nmod clock;\n\npub use clock::Clock;\n",
    "core/src/audit.rs": "pub fn record(event: &str) {}\n",
    "core/src/clock.rs": "pub struct Clock;\n\nimpl Clock {\n    pub fn new() -> Self {\n        Clock\n    }\n\n    pub fn now(&self) -> u64 {\n        0\n    }\n}\n",
  };

  it("follows mod, use, globs, another crate of the repository and a name passed on with pub use", async () => {
    expect(await edgesOf("imports", files, crates)).toEqual([
      "app/src/main.rs -> app/src/mailer.rs",
      "app/src/main.rs -> app/src/store.rs",
      "app/src/main.rs -> app/src/util/mod.rs",
      "app/src/main.rs -> core/src/audit.rs",
      "app/src/main.rs -> core/src/clock.rs",
      "app/src/main.rs -> mod:anyhow",
      "app/src/util/mod.rs -> app/src/util/deep.rs",
      "core/src/lib.rs -> core/src/audit.rs",
      "core/src/lib.rs -> core/src/clock.rs",
    ]);
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link(facts, crates).unresolved).toEqual([]);
  });

  it("links functions by path, methods on values whose type is written, trait methods and calls inside macros", async () => {
    expect(await edgesOf("calls", files, crates)).toEqual([
      "app/src/mailer.rs#Mailer.new -> app/src/mailer.rs#Mailer.check",
      "app/src/mailer.rs#Sender.flush -> app/src/mailer.rs#Sender.send",
      "app/src/main.rs#adds -> app/src/main.rs#total",
      "app/src/main.rs#main -> app/src/mailer.rs#Mailer.new",
      "app/src/main.rs#main -> app/src/mailer.rs#Mailer.send",
      "app/src/main.rs#main -> app/src/mailer.rs#Sender.flush",
      "app/src/main.rs#main -> app/src/main.rs#notify",
      "app/src/main.rs#main -> app/src/main.rs#total",
      "app/src/main.rs#main -> app/src/store.rs#Repo.default",
      "app/src/main.rs#main -> app/src/store.rs#Store.load",
      "app/src/main.rs#main -> app/src/util/deep.rs#dive",
      "app/src/main.rs#main -> app/src/util/mod.rs#helper",
      "app/src/main.rs#main -> core/src/audit.rs#record",
      "app/src/main.rs#main -> core/src/clock.rs#Clock.new",
      "app/src/main.rs#main -> core/src/clock.rs#Clock.now",
      "app/src/main.rs#notify -> app/src/mailer.rs#Sender.send",
      "app/src/store.rs#Store.load -> app/src/store.rs#Repo.find",
      "app/src/util/deep.rs#dive -> app/src/util/mod.rs#helper",
    ]);
  });

  it("reads tables and env keys, and gives the same graph whatever order the files come in", async () => {
    expect(await edgesOf("reads_table", files, crates)).toEqual(["app/src/store.rs -> table:notifications"]);
    expect(await edgesOf("uses_env", files, crates)).toEqual(["app/src/main.rs -> env:SMTP_HOST"]);
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link([...facts].reverse(), crates)).toEqual(link(facts, crates));
  });

  it("treats lib.rs and main.rs as two crates, and a module folder named tests as a module", async () => {
    const both = {
      "src/lib.rs": "pub mod shared;\n\npub fn helper() {}\n",
      "src/shared.rs": "pub fn common() {\n    crate::helper();\n}\n",
      "src/main.rs": "mod mailer;\n\nuse mailer::Mailer;\n\nfn helper() {}\n\nfn main() {\n    Mailer::new();\n    mailer::go();\n    crate::helper();\n}\n",
      "src/mailer.rs": "pub struct Mailer;\n\nimpl Mailer {\n    pub fn new() -> Self {\n        Mailer\n    }\n}\n\npub fn go() {\n    crate::helper();\n}\n",
      "src/tests/mod.rs": "mod foo;\n",
      "src/tests/foo.rs": "use crate::shared::common;\n\nfn check() {\n    common();\n    super::super::shared::common();\n}\n",
      "examples/demo.rs": "fn local() {}\n\nfn main() {\n    crate::local();\n}\n",
    };
    expect(await edgesOf("calls", both)).toEqual([
      "examples/demo.rs#main -> examples/demo.rs#local",
      "src/mailer.rs#go -> src/main.rs#helper",
      "src/main.rs#main -> src/mailer.rs#Mailer.new",
      "src/main.rs#main -> src/mailer.rs#go",
      "src/main.rs#main -> src/main.rs#helper",
      "src/shared.rs#common -> src/lib.rs#helper",
      "src/tests/foo.rs#check -> src/shared.rs#common",
    ]);
    expect(await edgesOf("imports", both)).toEqual(["src/lib.rs -> src/shared.rs", "src/main.rs -> src/mailer.rs", "src/tests/foo.rs -> src/shared.rs", "src/tests/mod.rs -> src/tests/foo.rs"]);
  });

  it("does not take a method call in a macro or a private item for a call it can follow, and takes a constructor for what it returns", async () => {
    expect(
      await edgesOf("calls", {
        "src/lib.rs":
          "mod a;\nmod b;\n\nuse a::*;\nuse b::*;\n\npub struct Aa;\n\nimpl Aa {\n    pub fn go(&self) {}\n}\n\npub struct Bb;\n\nimpl Bb {\n    pub fn new() -> Aa {\n        Aa\n    }\n\n    pub fn open<'a>() -> io::Result<'a, Self> {\n        Ok(Bb)\n    }\n\n    pub fn go(&self) {}\n}\n\nfn total() -> u8 {\n    1\n}\n\nfn len() -> u8 {\n    1\n}\n\npub fn run(x: Vec<u8>) {\n    println!(\"{}\", x.len());\n    println!(\"{}\", other::total());\n    assert!(total() > 0);\n    let made = Bb::new();\n    made.go();\n    let unwrapped = Bb::open();\n    unwrapped.go();\n    hidden();\n}\n\npub fn tried() -> Result<(), ()> {\n    let opened = Bb::open()?;\n    opened.go();\n    Ok(())\n}\n",
        "src/a.rs": "fn hidden() {}\n",
        "src/b.rs": "pub fn hidden() {}\n",
      }),
    // `Bb::new()` returns an `Aa`: the value is followed as what the function says it returns, not as a `Bb`.
    ).toEqual(["src/lib.rs#run -> src/b.rs#hidden", "src/lib.rs#run -> src/lib.rs#Aa.go", "src/lib.rs#run -> src/lib.rs#Bb.new", "src/lib.rs#run -> src/lib.rs#Bb.open", "src/lib.rs#run -> src/lib.rs#total", "src/lib.rs#tried -> src/lib.rs#Bb.go", "src/lib.rs#tried -> src/lib.rs#Bb.open"]);
  });

  it("reports a path of the crate that leads nowhere, but not one to a constant, a macro or an inline module", async () => {
    const facts = await Promise.all(
      Object.entries({
        "src/lib.rs": "mod gone;\nmod real;\n\nuse crate::missing::Thing;\nuse crate::real::{LIMIT, inner::deep, shout, Nope};\nuse serde::Serialize;\n",
        "src/real.rs": "pub const LIMIT: u8 = 1;\n\nmacro_rules! shout {\n    () => {};\n}\n\npub mod inner {\n    pub fn deep() {}\n}\n",
      }).map(([path, source]) => extractFile(path, source)),
    );
    // `crate::real::Nope` reaches a file, where a macro could still define it: the file is depended on and nothing is reported.
    expect(link(facts).unresolved.map((item) => item.specifier)).toEqual(["self::gone", "crate::missing::Thing"]);
    expect(link(facts).edges.filter((edge) => edge.kind === "imports").map((edge) => `${edge.src} -> ${edge.dst}`)).toEqual(["file:src/lib.rs -> file:src/real.rs", "file:src/lib.rs -> mod:serde"]);
  });

  it("stays fast when many modules glob-import each other", async () => {
    const names = Array.from({ length: 24 }, (_, index) => `m${index}`);
    const files: Record<string, string> = { "src/lib.rs": names.map((name) => `pub mod ${name};\n`).join("") };
    for (const name of names) {
      files[`src/${name}.rs`] = `${names.filter((other) => other !== name).map((other) => `pub use crate::${other}::*;\n`).join("")}\npub fn f_${name}() {\n    nowhere();\n    f_m0();\n}\n`;
    }
    const started = performance.now();
    expect(await edgesOf("calls", files)).toHaveLength(23);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("survives modules that glob-import each other", async () => {
    expect(
      await edgesOf("calls", {
        "src/lib.rs": "mod a;\nmod b;\n",
        "src/a.rs": "pub use crate::b::*;\n\npub fn one() {\n    two();\n    Missing::thing();\n}\n",
        "src/b.rs": "pub use crate::a::*;\n\npub fn two() {\n    one();\n    nowhere();\n}\n",
      }),
    ).toEqual(["src/a.rs#one -> src/b.rs#two", "src/b.rs#two -> src/a.rs#one"]);
  });
  it("follows a method on what a call returns: builder chains, and a variable made by a call", async () => {
    const lib =
      "pub struct Test;\n\npub struct Output;\n\npub struct Other;\n\nimpl Test {\n    pub fn new() -> Self {\n        Test\n    }\n\n    pub fn open() -> Result<Test, String> {\n        Ok(Test)\n    }\n\n    pub fn arg(self, a: &str) -> Self {\n        self\n    }\n\n    pub fn env(&mut self) -> &mut Test {\n        self\n    }\n\n    pub fn run(self) -> Output {\n        Output\n    }\n\n    pub fn try_run(self) -> Option<Output> {\n        None\n    }\n\n    pub fn raw(self) -> Vec<Output> {\n        vec![]\n    }\n}\n\nimpl Output {\n    pub fn code(&self) -> i32 {\n        0\n    }\n\n    pub fn text(&self) -> i32 {\n        0\n    }\n}\n\nimpl Other {\n    pub fn code(&self) -> i32 {\n        1\n    }\n}\n\npub fn make() -> Test {\n    Test\n}\n";
    const from = async (body: string) =>
      (await edgesOf("calls", { "src/lib.rs": lib, "src/main.rs": `mod lib;\n\nuse lib::{make, Test};\n\nfn main() {\n${body}}\n` })).filter((edge) => edge.startsWith("src/main.rs")).map((edge) => edge.replace("src/main.rs#main -> src/lib.rs#", ""));

    // A chain: each method is looked up on what the one before it returns, through `&mut` and `Self`.
    expect(await from('    Test::new().arg("a").env().run().code();\n')).toEqual(["Output.code", "Test.arg", "Test.env", "Test.new", "Test.run"]);
    // A variable made by a function, a method, and a call that was awaited and tried.
    expect(await from("    let t = make();\n    let out = t.run();\n    out.text();\n")).toEqual(["Output.text", "Test.run", "make"]);
    expect(await from("    let t = Test::open().await?;\n    t.run();\n")).toEqual(["Test.open", "Test.run"]);
    // `Result` and `Option` give their value only where it is taken out, and a plain value has nothing to take out.
    expect(await from("    Test::open().run();\n    Test::new().try_run().code();\n    make().unwrap().run();\n")).toEqual(["Test.new", "Test.open", "Test.try_run", "make"]);
    expect(await from('    Test::open().unwrap().run();\n    Test::new().try_run().expect("x").code();\n    let o = Test::new().try_run()?;\n    o.text();\n')).toEqual(["Output.code", "Output.text", "Test.new", "Test.open", "Test.run", "Test.try_run"]);
    // Nothing when what is returned is not one type, or when the name is declared again.
    expect(await from("    Test::new().raw().code();\n    let t = make();\n    let t = unknown();\n    t.run();\n")).toEqual(["Test.new", "Test.raw", "make"]);
  });
  it("does not take a type parameter, an associated type or a trait's Self for a type of the crate", async () => {
    const lib =
      "pub struct Key;\n\npub struct Item;\n\npub struct Test;\n\npub struct Map<K>(K);\n\npub trait Shape {\n    fn area(&self) {}\n\n    fn twice(self) -> Self {\n        self\n    }\n}\n\npub trait Runner {\n    fn go(&self);\n}\n\nimpl Key {\n    pub fn hit(&self) {}\n}\n\nimpl Item {\n    pub fn hit(&self) {}\n}\n\nimpl<Key> Map<Key> {\n    pub fn first(self) -> Key {\n        self.0\n    }\n}\n\nimpl Test {\n    pub fn new() -> Self {\n        Test\n    }\n\n    pub fn area(&self) {}\n\n    pub fn generic<Key>(&self) -> Key {\n        todo!()\n    }\n\n    pub fn boxed(&self) -> Box<dyn Runner> {\n        todo!()\n    }\n}\n\nimpl Shape for Test {}\n\nimpl Iterator for Test {\n    type Item = Key;\n\n    fn next(&mut self) -> Option<Self::Item> {\n        None\n    }\n}\n\npub fn get<Key>() -> Key {\n    todo!()\n}\n\npub fn map() -> Map<u8> {\n    todo!()\n}\n";
    const from = async (body: string) =>
      (await edgesOf("calls", { "src/lib.rs": lib, "src/main.rs": `mod lib;\n\nuse lib::*;\n\nfn main() {\n${body}}\n` })).filter((edge) => edge.startsWith("src/main.rs")).map((edge) => edge.replace("src/main.rs#main -> src/lib.rs#", ""));
    expect(await from("    get::<u8>().hit();\n    map().first().hit();\n    Test::new().generic::<u8>().hit();\n")).toEqual(["Map.first", "Test.generic", "Test.new", "get", "map"]);
    expect(await from("    Test::new().next().unwrap().hit();\n    Test::new().twice().area();\n")).toEqual(["Shape.twice", "Test.new", "Test.next"]);
    // A trait object is followed to the trait's method.
    expect(await from("    Test::new().boxed().go();\n")).toEqual(["Runner.go", "Test.boxed", "Test.new"]);
  });

  it("resolves a returned type where the function is declared, and a name declared again from its old value", async () => {
    expect(
      await edgesOf("calls", {
        "src/main.rs": "mod a;\nmod b;\n\nfn main() {\n    b::load().hit();\n    let c = b::load();\n    let c = c.next();\n    c.hit();\n}\n",
        "src/a.rs": "pub struct Config;\n\nimpl Config {\n    pub fn hit(&self) {}\n\n    pub fn next(self) -> Config {\n        self\n    }\n}\n",
        "src/b.rs": "pub struct Config;\n\nimpl Config {\n    pub fn hit(&self) {}\n}\n\npub fn load() -> crate::a::Config {\n    crate::a::Config\n}\n",
      }),
    ).toEqual(["src/main.rs#main -> src/a.rs#Config.hit", "src/main.rs#main -> src/a.rs#Config.next", "src/main.rs#main -> src/b.rs#load"]);
  });
});

describe("Ruby", () => {
  const files = {
    "lib/shop.rb": 'require "json"\nrequire "shop/order"\nrequire_relative "shop/helpers"\n\nmodule Shop\n  autoload :Ledger, "shop/ledger"\n\n  def self.run(id)\n    order = Order.new(id)\n    order.total\n    order = lookup(id)\n    order.save\n    Billing::Invoice.new(order).send_now\n    Ledger.record(id)\n    log("done")\n  end\nend\n',
    "lib/shop/order.rb":
      'module Shop\n  class Order < Record\n    include Priced\n    attr_reader :repo\n    LIMIT = 5\n\n    def initialize(id)\n      @repo = Repo.new\n      @other = id\n    end\n\n    def total\n      repo.load\n      @repo.load\n      @other.load\n      price + tax\n      save\n      self.class.table\n      helper = 1\n      helper\n    end\n\n    def save\n      super\n      total(1)\n    end\n\n    def helper; end\n\n    def self.table\n      "orders"\n    end\n  end\nend\n',
    "lib/shop/record.rb": "module Shop\n  class Record\n    def save; end\n  end\n\n  class Repo\n    def load; end\n  end\n\n  module Priced\n    def price; end\n\n    def tax; end\n  end\nend\n",
    "lib/shop/ledger.rb": "module Shop\n  module Ledger\n    def self.record(id)\n      Order::LIMIT\n    end\n  end\nend\n",
    "lib/shop/helpers.rb": "def log(message)\n  puts message\nend\n",
    "lib/billing/invoice.rb": "module Billing\n  class Invoice\n    def initialize(order); end\n\n    def send_now\n      Shop::Order.table\n      ::Shop.run(1)\n    end\n  end\nend\n",
    "spec/order_spec.rb": 'require "spec_helper"\nrequire_relative "missing"\n\nRSpec.describe Shop::Order do\n  it "adds" do\n    described_class.new(1).total\n  end\nend\n',
    "spec/spec_helper.rb": 'require "shop"\n',
  };

  it("follows require, require_relative and autoload, and the classes a file names without requiring them", async () => {
    expect(await edgesOf("imports", files)).toEqual([
      "lib/billing/invoice.rb -> lib/shop.rb",
      "lib/billing/invoice.rb -> lib/shop/order.rb",
      "lib/shop.rb -> lib/billing/invoice.rb",
      "lib/shop.rb -> lib/shop/helpers.rb",
      "lib/shop.rb -> lib/shop/ledger.rb",
      "lib/shop.rb -> lib/shop/order.rb",
      "lib/shop.rb -> mod:json",
      "lib/shop/ledger.rb -> lib/shop/order.rb",
      "lib/shop/order.rb -> lib/shop/record.rb",
      "spec/order_spec.rb -> lib/shop/order.rb",
      "spec/order_spec.rb -> spec/spec_helper.rb",
      "spec/spec_helper.rb -> lib/shop.rb",
    ]);
    const facts = await Promise.all(Object.entries(files).map(([path, source]) => extractFile(path, source)));
    expect(link(facts).unresolved.map((item) => `${item.file}: ${item.specifier}`)).toEqual(["spec/order_spec.rb: ./missing"]);
  });

  it("links methods of the class itself, of what it inherits and includes, and of values made with new", async () => {
    // Not linked: `order.save` after `order = lookup(id)`, `@other.load`, `helper` once it is a variable, `described_class.new(1).total`.
    expect(await edgesOf("calls", files)).toEqual([
      "lib/billing/invoice.rb#Billing::Invoice.send_now -> lib/shop.rb#Shop.run",
      "lib/billing/invoice.rb#Billing::Invoice.send_now -> lib/shop/order.rb#Shop::Order.table",
      "lib/shop.rb#Shop.run -> lib/billing/invoice.rb#Billing::Invoice",
      "lib/shop.rb#Shop.run -> lib/billing/invoice.rb#Billing::Invoice.send_now",
      "lib/shop.rb#Shop.run -> lib/shop/helpers.rb#log",
      "lib/shop.rb#Shop.run -> lib/shop/ledger.rb#Shop::Ledger.record",
      "lib/shop.rb#Shop.run -> lib/shop/order.rb#Shop::Order",
      "lib/shop.rb#Shop.run -> lib/shop/order.rb#Shop::Order.total",
      "lib/shop/order.rb#Shop::Order.initialize -> lib/shop/record.rb#Shop::Repo",
      "lib/shop/order.rb#Shop::Order.save -> lib/shop/order.rb#Shop::Order.total",
      "lib/shop/order.rb#Shop::Order.save -> lib/shop/record.rb#Shop::Record.save",
      "lib/shop/order.rb#Shop::Order.total -> lib/shop/order.rb#Shop::Order.save",
      "lib/shop/order.rb#Shop::Order.total -> lib/shop/order.rb#Shop::Order.table",
      "lib/shop/order.rb#Shop::Order.total -> lib/shop/record.rb#Shop::Priced.price",
      "lib/shop/order.rb#Shop::Order.total -> lib/shop/record.rb#Shop::Priced.tax",
      "lib/shop/order.rb#Shop::Order.total -> lib/shop/record.rb#Shop::Repo.load",
    ]);
  });

  it("looks a constant up in each namespace around it, innermost first, and in every file that opens the class", async () => {
    expect(
      await edgesOf("calls", {
        "app/a.rb": "class Cache\n  def self.get; end\nend\n\nmodule Api\n  class Cache\n    def self.get; end\n  end\n\n  class Client\n    def call\n      Cache.get\n      ::Cache.get\n      Cache.put\n    end\n  end\nend\n\nclass Api::Other\n  def call\n    Cache.get\n  end\nend\n",
        "app/b.rb": "module Api\n  class Cache\n    class << self\n      def put; end\n    end\n  end\nend\n",
      }),
    ).toEqual(["app/a.rb#Api::Client.call -> app/a.rb#Api::Cache.get", "app/a.rb#Api::Client.call -> app/a.rb#Cache.get", "app/a.rb#Api::Client.call -> app/b.rb#Api::Cache.put", "app/a.rb#Api::Other.call -> app/a.rb#Cache.get"]);
  });

  it("does not take a variable, a parameter or a name bound by a pattern for a call", async () => {
    expect(
      await edgesOf("calls", {
        "a.rb":
          "class Job\n  def size; end\n\n  def name; end\n\n  def count; end\n\n  def run(size, items)\n    size\n    items.each { |name| name }\n    case items\n    in {count:}\n      count\n    end\n    total = Point.new\n    total.norm\n    name\n  end\nend\n\nPoint = Struct.new(:x) do\n  def norm; end\nend\n",
      }),
    ).toEqual(["a.rb#Job.run -> a.rb#Job.name", "a.rb#Job.run -> a.rb#Point", "a.rb#Job.run -> a.rb#Point.norm"]);
  });

  it("gives an Active Record model the table of its name, when the repository defines that table", async () => {
    const rails = {
      "db/schema.rb": 'ActiveRecord::Schema.define do\n  create_table "order_items", force: :cascade do |t|\n  end\n  create_table :people do |t|\n  end\nend\n',
      "app/models/order_item.rb": "class OrderItem < ApplicationRecord\nend\n",
      "app/models/person.rb": "class Person < ActiveRecord::Base\nend\n",
      "app/models/visit.rb": "class Visit < ApplicationRecord\nend\n",
      "app/models/legacy.rb": 'class Legacy < ApplicationRecord\n  self.table_name = "old_things"\nend\n',
      // A model in a module has the module's prefix when that table exists, and the plain name when not.
      "db/more.rb": 'create_table "web_settings"\ncreate_table "settings"\ncreate_table "users"\n',
      "app/models/web/setting.rb": "class Web::Setting < ApplicationRecord\nend\n",
      "app/models/admin/user.rb": "module Admin\n  class User < ApplicationRecord\n  end\nend\n",
    };
    expect(await edgesOf("reads_table", rails)).toEqual([
      "app/models/admin/user.rb -> table:users",
      "app/models/legacy.rb -> table:old_things",
      "app/models/order_item.rb -> table:order_items",
      "app/models/person.rb -> table:people",
      "app/models/web/setting.rb -> table:web_settings",
    ]);
    expect((await edgesOf("defines_table", rails)).filter((edge) => !edge.startsWith("db/more.rb"))).toEqual(["db/schema.rb -> table:order_items", "db/schema.rb -> table:people"]);
    // A table name a model states is not a definition, so it does not confirm the guess for another model.
    expect(await edgesOf("reads_table", { "a.rb": 'class Legacy < ApplicationRecord\n  self.table_name = "users"\nend\n\nclass User < ApplicationRecord\nend\n\nclass Base < ApplicationRecord\n  self.abstract_class = true\nend\n' })).toEqual(["a.rb -> table:users"]);
    const twice = await extractFile("b.rb", 'class User < ApplicationRecord\n  SQL = "SELECT id FROM users"\nend\n');
    expect(twice.tables.map((table) => `${table.name}:${table.inferred ?? false}`)).toEqual(["users:true", "users:false"]);
  });

  it("reads SQL in a heredoc, leaving out what is interpolated and what a WITH clause names", async () => {
    const source = 'def fix(source)\n  execute <<~SQL\n    ALTER TABLE #{source}\n    ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES accounts (id)\n  SQL\n  count_by_sql(<<~SQL)\n    WITH RECURSIVE ancestors(id, depth) AS (\n      SELECT s.id, 0 FROM statuses s\n      UNION ALL\n      SELECT s.id, 1 FROM ancestors JOIN statuses s ON true\n    )\n    SELECT id FROM ancestors\n  SQL\nend\n';
    const facts = await extractFile("lib/fix.rb", source);
    expect(facts.tables.map((table) => `${table.op}:${table.name}`).sort()).toEqual(["read:accounts", "read:statuses"]);
  });

  it("places a constant read through a class in the file that assigns it, and a class of a gem nowhere", async () => {
    expect(
      await edgesOf("imports", {
        "config/initializers/devise.rb": "module Devise\n  def self.custom; end\nend\n",
        "app/controllers/confirmations_controller.rb": "class ConfirmationsController < Devise::ConfirmationsController\n  include Limits\n  LIMIT ||= 3\nend\n",
        "app/controllers/concerns/limits.rb": "module Limits\n  WINDOW = 5\n\n  def within?; end\nend\n",
        "app/jobs/sweep.rb": "class Sweep\n  def run\n    ConfirmationsController::LIMIT\n  end\nend\n",
        "app/jobs/prune.rb": "class Prune\n  def run\n    ConfirmationsController::WINDOW + ConfirmationsController::NOWHERE\n  end\nend\n",
      }),
    ).toEqual([
      "app/controllers/confirmations_controller.rb -> app/controllers/concerns/limits.rb",
      "app/jobs/prune.rb -> app/controllers/concerns/limits.rb",
      "app/jobs/prune.rb -> app/controllers/confirmations_controller.rb",
      "app/jobs/sweep.rb -> app/controllers/confirmations_controller.rb",
    ]);
  });

  it("forgets what a name held where Ruby does: in a def or a class, and after any other binding of it", async () => {
    const store = "class Store\n  def find; end\nend\n";
    expect(
      await edgesOf("calls", {
        "bin/run.rb": `${store}store = Store.new\nstore.find\n\ndef run(store)\n  store.find\nend\n\ndef other\n  store = lookup\n  store.find\nend\n\nclass Job\n  def go(store)\n    store.find\n  end\nend\n`,
      }),
    ).toEqual(["bin/run.rb -> bin/run.rb#Store", "bin/run.rb -> bin/run.rb#Store.find"]);
    const after = (binding: string) => edgesOf("calls", { "a.rb": `${store}def run(list)\n  a = Store.new\n${binding}\n  a.find\nend\n` });
    for (const binding of ["  a, b = list", "  for a in list; end", "  begin; rescue => a; end", "  case list\n  in {a:}\n  end", "  list.each { a = it }"]) {
      expect(await after(binding), binding).toEqual(["a.rb#run -> a.rb#Store"]);
    }
    expect(await after("  list.each { |a| a.find }\n  b = 1")).toEqual(["a.rb#run -> a.rb#Store", "a.rb#run -> a.rb#Store.find"]);
    expect(await edgesOf("calls", { "a.rb": `${store}def run(list)\n  a = Store.new\n  list.each { |a| a.find }\nend\n` })).toEqual(["a.rb#run -> a.rb#Store"]);
  });

  it("keeps the instance variables of a class to that class, and follows a reader of one", async () => {
    expect(
      await edgesOf("calls", {
        "a.rb":
          "class Repo\n  def load; end\nend\n\nclass Outer\n  attr_reader :repo, :pair\n\n  def initialize\n    @repo = Repo.new\n    @pair = Repo.new\n    @pair, @other = 1, 2\n  end\n\n  def read\n    repo.load\n  end\n\n  def both\n    @pair.load\n  end\n\n  class Inner\n    def initialize(repo)\n      @repo = repo\n    end\n\n    def run\n      @repo.load\n    end\n  end\n\n  class Bare\n    def run\n      @repo.load\n    end\n  end\nend\n",
      }),
    ).toEqual(["a.rb#Outer.initialize -> a.rb#Repo", "a.rb#Outer.read -> a.rb#Repo.load"]);
  });

  it("asks an included module before the parent, and looks the parent up from outside the class", async () => {
    expect(
      await edgesOf("calls", {
        "a.rb": "class Record\n  def price; end\nend\n\nmodule Priced\n  def price; end\nend\n\nclass Order < Record\n  include Priced\n\n  def total\n    price\n  end\nend\n",
        "app/users_controller.rb": "class UsersController\n  def index; end\nend\n",
        "app/admin/users_controller.rb": "module Admin\n  class UsersController < UsersController\n    def index\n      super\n    end\n  end\nend\n",
      }),
    ).toEqual(["a.rb#Order.total -> a.rb#Priced.price", "app/admin/users_controller.rb#Admin::UsersController.index -> app/users_controller.rb#UsersController.index"]);
    expect(
      await edgesOf("imports", {
        "app/users_controller.rb": "class UsersController\nend\n",
        "app/admin/users_controller.rb": "module Admin\n  class UsersController < UsersController\n  end\nend\n",
      }),
    ).toEqual(["app/admin/users_controller.rb -> app/users_controller.rb"]);
  });

  it("reaches the parent of a class that includes many modules", async () => {
    const mixins = Array.from({ length: 40 }, (_, n) => `module M${n}\n  def m${n}; end\nend\n`).join("");
    const includes = Array.from({ length: 40 }, (_, n) => `  include M${n}\n`).join("");
    expect(await edgesOf("calls", { "a.rb": `${mixins}class Base\n  def self.index; end\nend\n\nclass Model < Base\n${includes}  index\nend\n` })).toEqual(["a.rb#Model -> a.rb#Base.index"]);
  });

  it("matches a require against lib folders and the requiring file's own test folder only", async () => {
    expect(
      await edgesOf("imports", {
        "gems/a/lib/a.rb": 'require "set"\nrequire "a/core"\nrequire "helper"\n',
        "gems/a/lib/a/core.rb": "",
        "gems/b/lib/a/core.rb": "",
        "gems/b/test/set.rb": "",
        "gems/b/test/helper.rb": "",
        "gems/b/test/b_test.rb": 'require "helper"\nrequire "a/core"\n',
      }),
    ).toEqual(["gems/a/lib/a.rb -> gems/a/lib/a/core.rb", "gems/a/lib/a.rb -> mod:helper", "gems/a/lib/a.rb -> mod:set", "gems/b/test/b_test.rb -> gems/b/lib/a/core.rb", "gems/b/test/b_test.rb -> gems/b/test/helper.rb"]);
  });

  it("places a class opened in several files in the file named after it, else in the few files that add to it", async () => {
    const use = "class Job\n  def run\n    Shop::Order\n    Minitest::Test\n    Wide\n  end\nend\n";
    const wide = Object.fromEntries([1, 2, 3, 4].map((n) => [`ext/wide${n}.rb`, `class Wide\n  def m${n}; end\nend\n`]));
    expect(
      await edgesOf("imports", {
        "app/job.rb": use,
        "lib/shop/order.rb": "module Shop\n  class Order\n  end\nend\n",
        "lib/shop/order_extras.rb": "module Shop\n  class Order\n    def extra; end\n  end\nend\n",
        "test/helper.rb": "class Minitest::Test\n  def app; end\nend\n",
        "test/contest.rb": "class Minitest::Test\n  def self.test; end\nend\n",
        ...wide,
      }),
    ).toEqual(["app/job.rb -> ext/wide1.rb", "app/job.rb -> lib/shop/order.rb", "app/job.rb -> test/contest.rb", "app/job.rb -> test/helper.rb"]);
  });

  it("counts class << self, a def in a block of a class body and ENV.fetch without brackets, but not a def in a block of a script", async () => {
    const facts = await extractFile(
      "a.rb",
      'module Concern\n  class_methods do\n    def scoped; end\n  end\n\n  class << self\n    def build; end\n  end\n\n  class << other\n    def lost; end\n  end\nend\n\ndescribe "x" do\n  def helper; end\nend\n\nENV.fetch "REGION"\ntext = <<~TEXT\n  ENV["IN_TEXT"]\nTEXT\n',
    );
    expect(facts.symbols.map((symbol) => symbol.name)).toEqual(["Concern", "Concern.scoped", "Concern.build"]);
    expect(facts.envs.map((env) => env.name)).toEqual(["REGION"]);
  });

  it("links a doc that names a Ruby class by the last part of its name", async () => {
    expect(await edgesOf("documents", { "docs/notes.md": "See `Policy`.\n", "lib/returns/policy.rb": "module Returns\n  class Policy\n  end\nend\n" })).toEqual(["docs/notes.md -> lib/returns/policy.rb#Returns::Policy"]);
  });
});
