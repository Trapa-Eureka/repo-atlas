import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    expect(atlas.summary).toMatchObject({ files: 27, parsed: 27, unchanged: 0, failed: [], unresolvedImports: 0, relinked: true });
    expect(atlas.stats().nodes).toEqual({ file: 27, symbol: 51, table: 6, env: 6, module: 4 });
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
      "sym:src/orders/service.ts#OrderService.place",
      "sym:src/orders/service.ts#recentOrders",
      "sym:src/users/repo.ts#createUser",
      "sym:src/users/repo.ts#findUser",
    ]);
    expect(relation(atlas.context("web/OrderList.tsx"), "imports")).toEqual(["file:src/users/repo.ts"]);
    atlas.close();
  });

  it("finds a Ruby class by the last part of its name, and links its calls across files", async () => {
    const atlas = await Atlas.open(root);
    expect(atlas.target("Policy").id).toBe("sym:returns/lib/returns/policy.rb#Returns::Policy");
    expect(names(atlas.search("store", { kind: "symbol" })).slice(0, 2)).toContain("sym:returns/lib/returns/store.rb#Returns::Store");
    expect(relation(atlas.context("Returns.process"), "calls")).toEqual([
      "sym:returns/lib/returns/policy.rb#Returns::Policy.allowed?",
      "sym:returns/lib/returns/store.rb#Returns::Store",
      "sym:returns/lib/returns/store.rb#Returns::Store.find_order",
      "sym:returns/lib/returns/store.rb#Returns::Store.record",
    ]);
    atlas.close();
  });

  it("does not mistake prose or SQL functions for tables", async () => {
    const atlas = await Atlas.open(root);
    expect(names(atlas.search("", { kind: "table" })).sort()).toEqual(["table:invoices", "table:notifications", "table:orders", "table:returns", "table:shipments", "table:users"]);
    expect(names(atlas.export().nodes.filter((node) => node.kind === "table"))).toEqual(["table:invoices", "table:notifications", "table:orders", "table:returns", "table:shipments", "table:users"]);
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

  it("writes the graph as one self-contained page", async () => {
    const atlas = await Atlas.open(root);
    const page = atlas.view({ focus: "users" });
    atlas.close();
    expect(page).toMatchObject({ nodes: 94, edges: 154 });
    expect(page.html).not.toMatch(/(?:src|href)=["']?https?:/);
    const embedded = /window\.ATLAS = (.*);<\/script>/.exec(page.html)?.[1] ?? "";
    const data = JSON.parse(embedded) as { nodes: unknown[][]; edges: number[][]; edgeKinds: string[]; focus: string };
    expect(data.focus).toBe("table:users");
    expect(data.nodes).toHaveLength(94);
    expect(data.edges.every(([src, dst, kind]) => data.nodes[src ?? -1] !== undefined && data.nodes[dst ?? -1] !== undefined && data.edgeKinds[kind ?? -1] !== undefined)).toBe(true);
  });

  it("re-parses only what changed, and notices deletions", async () => {
    const first = await Atlas.open(root);
    first.close();

    const unchanged = await Atlas.open(root);
    expect(unchanged.summary).toMatchObject({ parsed: 0, unchanged: 27, relinked: false, nodes: 94 });
    unchanged.close();

    const file = join(root, "src/users/repo.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nexport function removeUser() { return query("DELETE FROM users WHERE id = 1"); }\n`);
    const touched = join(root, "src/db/client.ts");
    utimesSync(touched, new Date(), new Date(Date.now() + 5000));
    rmSync(join(root, "web/App.tsx"));

    const changed = await Atlas.open(root);
    expect(changed.summary).toMatchObject({ files: 26, parsed: 1, unchanged: 25, removed: 1, relinked: true });
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

  it("writes the viewer next to the index and prints only its path", async () => {
    const result = await atlas("view", "--focus", "findUser");
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${join(root, ".atlas", "view.html")}\n`);
    expect(result.err).toContain("94 nodes and 154 relations");
    expect(readFileSync(join(root, ".atlas", "view.html"), "utf8")).toContain('"focus":"sym:src/users/repo.ts#findUser"');

    const elsewhere = join(root, "graph.html");
    const json = await atlas("--json", "view", "--out", elsewhere);
    expect(JSON.parse(json.out)).toEqual({ file: elsewhere, nodes: 94, edges: 154 });
    expect(readFileSync(elsewhere, "utf8").startsWith("<!doctype html>")).toBe(true);
  });

  it("exits 2 and lists candidates when the target is not unique", async () => {
    const result = await atlas("context", "repo");
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("file:src/users/repo.ts");
  });

  it("registers the MCP server without dropping existing entries", async () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const result = await atlas("init");
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Added the "repo-atlas" server to ${join(root, ".mcp.json")}\n`);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { command: "x" }, "repo-atlas": { type: "stdio", command: "atlas", args: ["mcp"] } },
    });
  });

  it("registers with other agents where each one keeps its servers", async () => {
    const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as { mcpServers: Record<string, unknown> };
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor/mcp.json"), JSON.stringify({ inputs: [1], mcpServers: { other: { command: "x" }, "repo-atlas": { command: "old" } } }));
    expect((await atlas("init", "--client", "cursor")).code).toBe(0);
    expect(read(".cursor/mcp.json")).toEqual({ inputs: [1], mcpServers: { other: { command: "x" }, "repo-atlas": { type: "stdio", command: "atlas", args: ["mcp"] } } });

    expect((await atlas("init", "--client", "devin")).err).toContain("Devin Desktop");
    expect(read(".devin/mcp_config.json").mcpServers["repo-atlas"]).toEqual({ command: "atlas", args: ["mcp"] });
    rmSync(join(root, ".devin"), { recursive: true });
    expect((await atlas("init", "--client", "windsurf")).code).toBe(0);
    expect(read(".devin/mcp_config.json").mcpServers["repo-atlas"]).toEqual({ command: "atlas", args: ["mcp"] });

    const vscode = await atlas("init", "--client", "vscode");
    expect(vscode.err).toContain("chat.mcp.workspaceRootConfig.enabled");
    expect(read(".mcp.json").mcpServers["repo-atlas"]).toEqual({ type: "stdio", command: "atlas", args: ["mcp"] });

    const asJson = await atlas("--json", "init", "--client", "cursor");
    expect(JSON.parse(asJson.out)).toMatchObject({ client: "cursor", file: join(root, ".cursor/mcp.json") });
    expect(asJson.err).toBe("");
  });

  it("prints the entry for JetBrains, which keeps no file in the repository", async () => {
    const before = readdirSync(root, { recursive: true }).length;
    const pasted = await atlas("init", "--client", "jetbrains");
    expect(JSON.parse(pasted.out)).toEqual({ mcpServers: { "repo-atlas": { command: "atlas", args: ["mcp"] } } });
    expect(pasted.err).toContain("Model Context Protocol");
    expect(readdirSync(root, { recursive: true }).length).toBe(before);
  });

  it("refuses a config file it cannot add to, and leaves it as it was", async () => {
    for (const content of ["[1, 2]", '{"mcpServers": [1]}', '{"mcpServers": "abc"}', "null", "{ // comment\n}", ""]) {
      writeFileSync(join(root, ".mcp.json"), content);
      const result = await atlas("init");
      expect(result.code, content).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toContain(join(root, ".mcp.json"));
      expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe(content);
    }
    writeFileSync(join(root, ".mcp.json"), '\uFEFF{"mcpServers": null}');
    expect((await atlas("init")).code).toBe(0);
  });

  it("does not create the folder it was pointed at", async () => {
    const missing = join(root, "no", "such");
    const result = await run(["node", "atlas", "--root", missing, "init", "--client", "cursor"]).catch(() => 1);
    expect(result).toBe(1);
    expect(existsSync(missing)).toBe(false);
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
