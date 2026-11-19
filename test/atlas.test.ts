import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Atlas } from "../src/app/atlas.js";
import { run } from "../src/cli/program.js";
import { serveMcp } from "../src/mcp/server.js";
import { TargetError } from "../src/query/resolve.js";

const FIXTURE = new URL("../fixtures/shop/", import.meta.url).pathname;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-test-"));
  cpSync(FIXTURE, root, { recursive: true, filter: (source) => !source.includes(".atlas") });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const names = (nodes: { id: string }[] | undefined) => (nodes ?? []).map((node) => node.id);
const relation = (result: ReturnType<Atlas["context"]>, name: string) => names(result.relations.find((item) => item.relation === name)?.nodes);

describe("Atlas on the sample repository", () => {
  it("indexes every supported file and nothing else", async () => {
    const atlas = await Atlas.open(root);
    expect(atlas.summary).toMatchObject({ files: 13, parsed: 13, unchanged: 0, failed: [], unresolvedImports: 0, relinked: true });
    expect(atlas.stats().nodes).toEqual({ file: 13, symbol: 15, table: 2, env: 3, module: 2 });
    atlas.close();
  });

  it("briefs on a file: symbols, importers, callers, tables and docs", async () => {
    const atlas = await Atlas.open(root);
    const result = atlas.context("src/users/repo.ts");
    expect(relation(result, "defines")).toEqual(["sym:src/users/repo.ts#createUser", "sym:src/users/repo.ts#findUser"]);
    expect(relation(result, "imported by")).toEqual(["file:src/api/handler.ts", "file:src/index.ts", "file:src/orders/service.ts", "file:web/OrderList.tsx"]);
    expect(relation(result, "called by")).toEqual(["sym:src/api/handler.ts#handleOrder", "sym:src/orders/service.ts#OrderService.place", "sym:web/OrderList.tsx#OrderList"]);
    expect(relation(result, "reads table")).toEqual(["table:users"]);
    expect(relation(result, "writes table")).toEqual(["table:users"]);
    expect(relation(result, "documented in")).toEqual(["file:docs/architecture.md"]);
    atlas.close();
  });

  it("resolves calls through a barrel file, a tsconfig alias, a default import and a namespace import", async () => {
    const atlas = await Atlas.open(root);
    expect(relation(atlas.context("handleOrder"), "calls")).toEqual([
      "sym:src/orders/service.ts#OrderService",
      "sym:src/orders/service.ts#recentOrders",
      "sym:src/users/repo.ts#createUser",
      "sym:src/users/repo.ts#findUser",
    ]);
    expect(relation(atlas.context("web/OrderList.tsx"), "imports")).toEqual(["file:src/users/repo.ts"]);
    atlas.close();
  });

  it("does not mistake prose or SQL functions for tables", async () => {
    const atlas = await Atlas.open(root);
    expect(names(atlas.search("", { kind: "table" })).sort()).toEqual(["table:orders", "table:users"]);
    expect(names(atlas.export().nodes.filter((node) => node.kind === "table"))).toEqual(["table:orders", "table:users"]);
    atlas.close();
  });

  it("traces the impact of a table change across languages and into docs", async () => {
    const atlas = await Atlas.open(root);
    const result = atlas.impact("users");
    const direct = result.affected.filter((entry) => entry.distance === 1).map((entry) => entry.node.id);
    expect(direct.sort()).toEqual(["file:docs/architecture.md", "file:scripts/report.py", "file:src/db/schema.sql", "file:src/orders/service.ts", "file:src/users/repo.ts"]);
    expect(result.affected.map((entry) => entry.node.id)).toContain("file:web/App.tsx");
    expect(atlas.impact("users", 1).truncatedAtDepth).toBe(1);
    atlas.close();
  });

  it("explains how two nodes are connected", async () => {
    const atlas = await Atlas.open(root);
    expect(atlas.path("web/App.tsx", "users").steps.map((step) => `${step.kind}>${step.dst}`)).toEqual(["imports>file:web/OrderList.tsx", "imports>file:src/users/repo.ts", "reads_table>table:users"]);
    expect(atlas.path("users", "web/App.tsx").direction).toBe("reverse");
    expect(atlas.path("jobs/utils.py", "web/App.tsx").direction).toBeNull();
    atlas.close();
  });

  it("draws a stable Mermaid overview", async () => {
    const atlas = await Atlas.open(root);
    expect(atlas.mermaid().text).toMatchSnapshot();
    const focused = atlas.mermaid({ focus: "findUser", maxNodes: 3 });
    expect(focused).toMatchObject({ nodes: 3, omitted: 4 });
    expect(focused.text).toContain("more nodes left out");
    atlas.close();
  });

  it("rejects ambiguous and unknown targets with candidates", async () => {
    const atlas = await Atlas.open(root);
    expect(() => atlas.target("query")).not.toThrow();
    expect(() => atlas.target("nope-nothing")).toThrow(TargetError);
    try {
      atlas.target("repo");
    } catch (error) {
      expect((error as TargetError).candidates.map((node) => node.id)).toContain("file:src/users/repo.ts");
    }
    atlas.close();
  });

  it("re-parses only what changed, and notices deletions", async () => {
    const first = await Atlas.open(root);
    first.close();

    const unchanged = await Atlas.open(root);
    expect(unchanged.summary).toMatchObject({ parsed: 0, unchanged: 13, relinked: false, nodes: 35 });
    unchanged.close();

    const file = join(root, "src/users/repo.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nexport function removeUser() { return query("DELETE FROM users WHERE id = 1"); }\n`);
    const touched = join(root, "src/db/client.ts");
    utimesSync(touched, new Date(), new Date(Date.now() + 5000));
    rmSync(join(root, "web/App.tsx"));

    const changed = await Atlas.open(root);
    expect(changed.summary).toMatchObject({ files: 12, parsed: 1, unchanged: 11, removed: 1, relinked: true });
    expect(names(changed.search("removeUser"))).toEqual(["sym:src/users/repo.ts#removeUser"]);
    expect(changed.search("App.tsx")).toEqual([]);
    changed.close();

    const stale = await Atlas.open(root, { noRefresh: true });
    expect(stale.summary.parsed).toBe(1);
    stale.close();
  });
});

describe("CLI", () => {
  async function atlas(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => ((err += String(chunk)), true));
    try {
      return { code: await run(["node", "atlas", "--root", root, ...args]), out, err };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  it("prints text for people and JSON for agents", async () => {
    const text = await atlas("impact", "findUser");
    expect(text.code).toBe(0);
    expect(text.out).toContain("sym:src/api/handler.ts#handleOrder  [calls sym:src/users/repo.ts#findUser]");

    const json = await atlas("--json", "search", "order", "--kind", "table");
    expect(JSON.parse(json.out)).toEqual([{ id: "table:orders", kind: "table", name: "orders", file: "src/db/schema.sql", line: 7, detail: null }]);
  });

  it("exits 2 and lists candidates when the target is not unique", async () => {
    const result = await atlas("context", "repo");
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("file:src/users/repo.ts");
  });

  it("registers the MCP server without dropping existing entries", async () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect((await atlas("init")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { command: "x" }, "repo-atlas": { command: "atlas", args: ["mcp"] } },
    });
  });
});

describe("MCP server", () => {
  it("answers tool calls from the live working tree", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serveMcp(root, serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["atlas_context", "atlas_impact", "atlas_mermaid", "atlas_path", "atlas_search", "atlas_stats"]);

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]?.text ?? "", isError: result.isError === true };
    };

    const impact = await call("atlas_impact", { target: "orders", depth: 1 });
    expect(JSON.parse(impact.text).affected.map((entry: { node: { id: string } }) => entry.node.id)).toContain("file:scripts/report.py");

    writeFileSync(join(root, "src/new.ts"), `export function freshlyAdded() {}\n`);
    const search = await call("atlas_search", { query: "freshlyAdded" });
    expect(JSON.parse(search.text)[0].id).toBe("sym:src/new.ts#freshlyAdded");

    const unknown = await call("atlas_context", { target: "no-such-thing-anywhere" });
    expect(unknown.isError).toBe(true);
    await client.close();
  });
});
