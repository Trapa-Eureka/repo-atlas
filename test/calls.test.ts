import { describe, expect, it } from "vitest";
import { extractFile } from "../src/extract/index.js";
import { link } from "../src/indexer/link.js";

/** Call edges of a small repository given as `{ path: source }`, from source text all the way through linking. */
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
