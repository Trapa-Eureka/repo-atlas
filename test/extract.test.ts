import { describe, expect, it } from "vitest";
import { extractFile, languageOf } from "../src/extract/index.js";
import { looksLikeSql, tablesInSql } from "../src/extract/sql.js";
import { envDeclarations, markdownRefs } from "../src/extract/text.js";

const tables = (sql: string) => tablesInSql(sql).map((table) => `${table.op}:${table.name}`).sort();

describe("languageOf", () => {
  it("indexes code, SQL, docs and env templates, and nothing else", () => {
    expect(languageOf("src/a.tsx")).toBe("tsx");
    expect(languageOf("a/b.py")).toBe("python");
    expect(languageOf(".env.example")).toBe("env");
    expect(languageOf("README.md")).toBe("markdown");
  });

  it("never indexes real env files, type declarations or minified bundles", () => {
    for (const path of [".env", ".env.local", ".env.production", "types.d.ts", "vendor.min.js", "logo.png", "data.json"]) {
      expect(languageOf(path), path).toBeNull();
    }
  });
});

describe("tablesInSql", () => {
  it("separates definitions, writes and reads", () => {
    expect(tables('CREATE TABLE IF NOT EXISTS public."Users" (id int); INSERT INTO audit_log VALUES (1); UPDATE carts SET x = 1; DELETE FROM sessions WHERE 1 = 1')).toEqual([
      "define:users",
      "write:audit_log",
      "write:carts",
      "write:sessions",
    ]);
    expect(tables("SELECT * FROM orders o LEFT JOIN users u ON u.id = o.user_id")).toEqual(["read:orders", "read:users"]);
  });

  it("ignores CTE names, comments and FROM inside functions", () => {
    expect(tables("WITH recent AS (SELECT * FROM orders) SELECT EXTRACT(YEAR FROM created_at) FROM recent -- FROM ghosts\n/* JOIN phantoms */")).toEqual(["read:orders"]);
    expect(tables("SELECT a IS DISTINCT FROM b FROM pairs")).toEqual(["read:pairs"]);
  });

  it("ignores functions that return rows and names filled in at run time", () => {
    expect(tables("SELECT * FROM jsonb_array_elements(steps) step JOIN unnest (ids) i ON true JOIN users u ON true")).toEqual(["read:users"]);
    expect(tables('insert into "{table}" values (?); insert into "${name}" values (?); insert into "odd name" values (?)')).toEqual(["write:odd name"]);
    expect(tables('CREATE TABLE table_{i:03d} (id int); CREATE TABLE prefix_${n} (id int); CREATE TABLE "half ""quoted""" (id int)')).toEqual([]);
    expect(tables("SELECT * FROM v$session JOIN users$archive a ON true")).toEqual(["read:users$archive", "read:v$session"]);
    expect(tables("CREATE TABLE new_t SELECT * FROM old_t; CREATE TABLE typed OF employee_type")).toEqual(["define:new_t", "define:typed", "read:old_t"]);
    expect(tables("CREATE TABLE copies AS SELECT * FROM originals")).toEqual(["define:copies", "read:originals"]);
    expect(tables("CREATE TABLE child (id int REFERENCES parent(id))")).toEqual(["define:child", "read:parent"]);
  });

  it("reports the line of the statement", () => {
    expect(tablesInSql("SELECT 1;\n\nSELECT * FROM users", 10)).toEqual([{ name: "users", op: "read", line: 12 }]);
  });
});

describe("looksLikeSql", () => {
  it("accepts statements and rejects prose", () => {
    expect(looksLikeSql("SELECT id FROM users")).toBe(true);
    expect(looksLikeSql("  insert into logs values (1)")).toBe(true);
    expect(looksLikeSql("\n  -- accounts\n  CREATE TABLE users (id int);")).toBe(true);
    expect(looksLikeSql("Imported 3 rows; select more from the menu")).toBe(false);
    expect(looksLikeSql("Failed to update the profile")).toBe(false);
    expect(looksLikeSql("Create table from data")).toBe(false);
    expect(looksLikeSql("Create table in {database}")).toBe(false);
    for (const rest of ["(id int)", "AS SELECT 1", "LIKE old", "PARTITION OF parent", "USING columnar", "INHERITS (base)", "SELECT 1", "WITH (fillfactor=70)", "OF kind"]) {
      expect(looksLikeSql(`CREATE TABLE things ${rest}`), rest).toBe(true);
    }
    expect(looksLikeSql('CREATE TABLE "odd name" (id int)')).toBe(true);
    expect(looksLikeSql("\n  recent as (\n    select id from orders\n  )")).toBe(true);
  });
});

describe("text extractors", () => {
  it("reads env keys from a template without their values", () => {
    expect(envDeclarations("# comment\nexport API_URL=https://x\nTOKEN=secret\nnot a key")).toEqual([
      { name: "API_URL", op: "declare", line: 2 },
      { name: "TOKEN", op: "declare", line: 3 },
    ]);
  });

  it("collects markdown links and code spans, skipping fences and external links", () => {
    const refs = markdownRefs("See [repo](./src/a.ts#L3) and `run()`.\n[site](https://example.com) [top](#top)\n```\n`hidden`\n```\n");
    expect(refs).toEqual([
      { target: "./src/a.ts", kind: "link", line: 1 },
      { target: "run()", kind: "code", line: 1 },
    ]);
  });
});

describe("extractFile", () => {
  it("extracts TypeScript symbols, imports, calls, tables and env keys", async () => {
    const facts = await extractFile(
      "src/a.ts",
      `import def, { one, two as alias } from "./b.js";
import * as ns from "pkg";
export { passed } from "./c.js";
export * from "./d.js";
const lazy = await import("./e.js");
export default class Service {
  run() { this.stop(); one(); ns.help(); new Other(); }
  stop() { return db.query(\`UPDATE jobs SET done = true\`); }
}
export const arrow = () => supabase.from("profiles").select("*");
function hidden() { function inner() {} return process.env.API_KEY ?? process.env["OTHER_KEY"]; }
`,
    );
    expect(facts.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.exported}`)).toEqual([
      "class:Service:true",
      "method:Service.run:false",
      "method:Service.stop:false",
      "function:arrow:true",
      "function:hidden:false",
    ]);
    expect(facts.symbols[0]?.isDefault).toBe(true);
    expect(facts.imports.map((fact) => [fact.specifier, fact.reexport, fact.star, fact.names.map((name) => `${name.imported}>${name.local}`).join(",")])).toEqual([
      ["./b.js", false, false, "default>def,one>one,two>alias"],
      ["pkg", false, false, "*>ns"],
      ["./c.js", true, false, "passed>passed"],
      ["./d.js", true, true, ""],
      ["./e.js", false, false, "*>lazy"],
    ]);
    expect(facts.calls.map((call) => `${call.receiver ?? ""}.${call.callee}`)).toEqual(expect.arrayContaining(["this.stop", ".one", "ns.help", ".Other", "db.query"]));
    expect(facts.tables.map((table) => `${table.op}:${table.name}`).sort()).toEqual(["read:profiles", "write:jobs"]);
    expect(facts.envs.map((env) => env.name).sort()).toEqual(["API_KEY", "OTHER_KEY"]);
  });

  it("does not read a CTE that another string of the same file defines", async () => {
    const facts = await extractFile(
      "src/report.ts",
      "const recent = `\n  recent as (\n    select id from orders\n  )`;\nconst later = `\\nlater as (select 1 from carts)`;\nexport const query = `with ${recent}, ${later} select * from recent join later on true join users on true`;\n",
    );
    expect(facts.tables.map((table) => `${table.op}:${table.name}`).sort()).toEqual(["read:carts", "read:orders", "read:users"]);
  });

  it("takes a CTE name to be the CTE in every string of the file, even where a table shares the name", async () => {
    // A known cost of the rule above, kept visible here: the second query does read the real table.
    const facts = await extractFile(
      "src/orders.ts",
      "export const head = `WITH events AS (select * from raw_events)`;\nexport const tail = `select * from events e join users u on true`;\n",
    );
    expect(facts.tables.map((table) => `${table.op}:${table.name}`).sort()).toEqual(["read:raw_events", "read:users"]);
  });

  it("treats .from() as a query builder only on instances", async () => {
    const facts = await extractFile(
      "src/io.ts",
      'export const a = db.from("users");\nexport const b = stream.Readable.from("wow");\nexport const c = ReadableStream.from("chunk");\nexport const d = env.DB.from("carts");\nexport const e = SUPABASE_ADMIN.from("teams");\n',
    );
    expect(facts.tables.map((table) => `${table.name}@${table.line}`)).toEqual(["users@1", "carts@4", "teams@5"]);
  });

  it("reads Python env keys from os.environ, not from a WSGI environ", async () => {
    const wsgi = await extractFile("app/middleware.py", 'import os\n\ndef app(environ, start):\n    environ["SCRIPT_NAME"] = "/x"\n    return os.environ.get("REGION")\n');
    expect(wsgi.envs.map((env) => env.name)).toEqual(["REGION"]);
    const imported = await extractFile("app/settings.py", 'from os import environ, path\n\nSTAGE = environ["STAGE"]\n');
    expect(imported.envs.map((env) => env.name)).toEqual(["STAGE"]);
    const names = async (source: string) => (await extractFile("app/x.py", source)).envs.map((env) => env.name);
    expect(await names('from os import (\n    environ,\n    path,\n)\nA = environ["A"]\n')).toEqual(["A"]);
    expect(await names('import os as _os\nA = _os.environ["A"]\n')).toEqual(["A"]);
    expect(await names('import os\nenviron = os.environ\nA = environ.get("A")\n')).toEqual(["A"]);
    expect(await names('from os import path  # environ is not imported\ndef app(environ):\n    return environ["PATH_INFO"]\n')).toEqual([]);
    expect(await names('def view(request):\n    return request.environ["REMOTE_ADDR"]\n')).toEqual([]);
  });

  it("extracts JSX component use as a call", async () => {
    const facts = await extractFile("web/App.tsx", `import { Row } from "./Row";\nexport function App() { return <div><Row id={1} /></div>; }\n`);
    expect(facts.calls.map((call) => call.callee)).toEqual(["Row"]);
  });

  it("extracts Python symbols, imports, calls, tables and env keys", async () => {
    const facts = await extractFile(
      "jobs/run.py",
      `import os
import pkg.tools as tools
from . import helpers
from ..core.db import connect, Session as S

class Model(Base):
    __tablename__ = "accounts"

    @staticmethod
    def load(self):
        return self.save()

    def save(self):
        return tools.flush()

def _private():
    cursor.execute("DELETE FROM accounts WHERE id = 1")
    return os.getenv("REGION") or os.environ["STAGE"]
`,
    );
    expect(facts.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.exported}`)).toEqual([
      "class:Model:true",
      "method:Model.load:false",
      "method:Model.save:false",
      "function:_private:false",
    ]);
    expect(facts.imports.map((fact) => [fact.specifier, fact.names.map((name) => `${name.imported}>${name.local}`).join(",")])).toEqual([
      ["os", "*>os"],
      ["pkg.tools", "*>tools"],
      [".", "helpers>helpers"],
      ["..core.db", "connect>connect,Session>S"],
    ]);
    expect(facts.calls.map((call) => `${call.receiver ?? ""}.${call.callee}`)).toEqual(expect.arrayContaining(["self.save", "tools.flush", "cursor.execute", "os.getenv"]));
    expect(facts.tables.map((table) => `${table.op}:${table.name}`).sort()).toEqual(["define:accounts", "write:accounts"]);
    expect(facts.envs.map((env) => env.name).sort()).toEqual(["REGION", "STAGE"]);
  });
});
