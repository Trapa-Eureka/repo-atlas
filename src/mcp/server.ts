import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { Atlas } from "../app/atlas.js";
import { NODE_KINDS } from "../graph/types.js";
import { TargetError } from "../query/resolve.js";

const TARGET = "A node id from another tool, a file path, `file#symbol`, or the name of a function, class, table, env key or package.";

function version(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function reply(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function failure(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const text =
    error instanceof TargetError
      ? `${error.message}\n${error.candidates.map((node) => `  ${node.id}`).join("\n")}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

/** Builds the server. Each tool call first re-indexes changed files, so answers match the working tree. */
export function createMcpServer(root: string): { server: McpServer; close: () => void } {
  const server = new McpServer({ name: "repo-atlas", version: version() });
  let opened: Atlas | undefined;

  async function atlas(): Promise<Atlas> {
    if (opened) await opened.refresh();
    else opened = await Atlas.open(root);
    return opened;
  }

  async function answer(work: (atlas: Atlas) => unknown) {
    try {
      return reply(await work(await atlas()));
    } catch (error) {
      return failure(error);
    }
  }

  server.registerTool(
    "atlas_search",
    {
      description: "Find nodes of the codebase graph by name: files, functions, classes, SQL tables, env keys, packages.",
      inputSchema: { query: z.string(), kind: z.enum(NODE_KINDS).optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    ({ query, kind, limit }) => answer((a) => a.search(query, { ...(kind ? { kind } : {}), ...(limit ? { limit } : {}) })),
  );

  server.registerTool(
    "atlas_context",
    {
      description:
        "Briefing to read before editing a file, function, table or env key: what it defines, imports and calls, who imports and calls it, which tables and env keys it touches, which docs mention it, and how much depends on it.",
      inputSchema: { target: z.string().describe(TARGET) },
    },
    ({ target }) => answer((a) => a.context(target)),
  );

  server.registerTool(
    "atlas_impact",
    {
      description: "Everything that depends on the target, directly or through other code, grouped by distance. Use it to find what a change can break and which docs to update. For a method, `possible` lists the callers that use its name on a value of unknown type: they may call it, and are worth reading.",
      inputSchema: { target: z.string().describe(TARGET), depth: z.number().int().min(1).optional() },
    },
    ({ target, depth }) => answer((a) => a.impact(target, depth)),
  );

  server.registerTool(
    "atlas_diff",
    {
      description:
        "What the uncommitted changes touch (or everything since `base`, such as `main`): the functions, classes, tables and env keys the changed lines are in, everything that depends on them, which test files to run, which changed code no test depends on, and which docs to check. Use it after editing and before committing.",
      inputSchema: { base: z.string().describe("A branch, tag or commit to compare with. Default: the last commit.").optional(), depth: z.number().int().min(1).optional() },
    },
    ({ base, depth }) => answer((a) => a.diff(base, depth)),
  );

  server.registerTool(
    "atlas_path",
    {
      description: "Shortest chain of relations (imports, calls, table reads and writes, env use) that connects two nodes.",
      inputSchema: { from: z.string().describe(TARGET), to: z.string().describe(TARGET) },
    },
    ({ from, to }) => answer((a) => a.path(from, to)),
  );

  server.registerTool(
    "atlas_mermaid",
    {
      description: "Mermaid flowchart of the graph: the file-level overview, or the neighbourhood of `focus`.",
      inputSchema: { focus: z.string().describe(TARGET).optional(), depth: z.number().int().min(1).max(5).optional(), maxNodes: z.number().int().min(1).max(200).optional() },
    },
    ({ focus, depth, maxNodes }) =>
      answer((a) => a.mermaid({ ...(focus ? { focus } : {}), ...(depth ? { depth } : {}), ...(maxNodes ? { maxNodes } : {}) })),
  );

  server.registerTool(
    "atlas_stats",
    { description: "Size of the graph, files by language, the most depended-on files, and local imports that could not be resolved.", inputSchema: {} },
    () => answer((a) => a.stats()),
  );

  return { server, close: () => opened?.close() };
}

export async function serveMcp(root: string, transport: Transport = new StdioServerTransport()): Promise<void> {
  const { server, close } = createMcpServer(root);
  transport.onclose = close;
  await server.connect(transport);
}
