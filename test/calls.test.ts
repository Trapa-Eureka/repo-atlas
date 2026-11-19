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

  it("does not take a method call in a macro, a constructor of another type or a private item for a call it can follow", async () => {
    expect(
      await edgesOf("calls", {
        "src/lib.rs":
          "mod a;\nmod b;\n\nuse a::*;\nuse b::*;\n\npub struct Aa;\n\nimpl Aa {\n    pub fn go(&self) {}\n}\n\npub struct Bb;\n\nimpl Bb {\n    pub fn new() -> Aa {\n        Aa\n    }\n\n    pub fn open<'a>() -> io::Result<'a, Self> {\n        Ok(Bb)\n    }\n\n    pub fn go(&self) {}\n}\n\nfn total() -> u8 {\n    1\n}\n\nfn len() -> u8 {\n    1\n}\n\npub fn run(x: Vec<u8>) {\n    println!(\"{}\", x.len());\n    println!(\"{}\", other::total());\n    assert!(total() > 0);\n    let made = Bb::new();\n    made.go();\n    let unwrapped = Bb::open();\n    unwrapped.go();\n    hidden();\n}\n\npub fn tried() -> Result<(), ()> {\n    let opened = Bb::open()?;\n    opened.go();\n    Ok(())\n}\n",
        "src/a.rs": "fn hidden() {}\n",
        "src/b.rs": "pub fn hidden() {}\n",
      }),
    ).toEqual(["src/lib.rs#run -> src/b.rs#hidden", "src/lib.rs#run -> src/lib.rs#Bb.new", "src/lib.rs#run -> src/lib.rs#Bb.open", "src/lib.rs#run -> src/lib.rs#total", "src/lib.rs#tried -> src/lib.rs#Bb.go", "src/lib.rs#tried -> src/lib.rs#Bb.open"]);
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
});
