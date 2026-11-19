import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { Atlas, findRoot } from "../app/atlas.js";
import { NODE_KINDS, type NodeKind } from "../graph/types.js";
import { serveMcp } from "../mcp/server.js";
import { TargetError } from "../query/resolve.js";
import { nodeLine, renderContext, renderImpact, renderPath, renderSearch, renderStats, renderSummary } from "./render.js";


interface GlobalOptions {
  root?: string;
  json?: boolean;
  refresh: boolean;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("Expected a whole number of 1 or more.");
  return parsed;
}

function nodeKind(value: string): NodeKind {
  if (!(NODE_KINDS as readonly string[]).includes(value)) throw new InvalidArgumentError(`Expected one of: ${NODE_KINDS.join(", ")}.`);
  return value as NodeKind;
}

/**
 * Where each agent reads the MCP servers of one repository, and what it needs to be told about a
 * local command. Taken from each product's own documentation; `file: null` means it keeps no file
 * in the repository and the entry is pasted into its settings.
 */
const CLIENTS = {
  claude: { file: ".mcp.json", key: "mcpServers", typed: true, next: "Restart Claude Code. It asks once whether to trust the new server." },
  vscode: {
    file: ".vscode/mcp.json",
    key: "servers",
    typed: true,
    next: 'Run "MCP: List Servers" from the Command Palette and start the server; VS Code asks once whether to trust it. Recent versions can also read .mcp.json (plain "atlas init") when the setting "chat.mcp.workspaceRootConfig.enabled" is on.',
  },
  cursor: { file: ".cursor/mcp.json", key: "mcpServers", typed: true, next: 'Turn the server on under Customize in Cursor\'s sidebar, or run "cursor-agent mcp enable repo-atlas".' },
  devin: { file: ".devin/mcp_config.json", key: "mcpServers", typed: false, next: "Open Customize > MCPs in Devin Desktop (where Windsurf's documentation now leads) and refresh the list." },
  jetbrains: { file: null, key: "mcpServers", typed: false, next: "Paste this under Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add, then Apply." },
} as const;

type Client = keyof typeof CLIENTS;

function client(value: string): Client {
  const name = value === "windsurf" ? "devin" : value;
  if (!Object.hasOwn(CLIENTS, name)) throw new InvalidArgumentError(`Expected one of: ${Object.keys(CLIENTS).join(", ")}.`);
  return name as Client;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The servers an agent's config file already lists, with the rest of the file. A file that cannot be added to is refused, never rewritten. */
function readServers(path: string, key: string): { config: Record<string, unknown>; servers: Record<string, unknown> } {
  if (!existsSync(path)) return { config: {}, servers: {} };
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it, or add the server by hand.`);
  }
  const servers = isRecord(config) ? (config[key] ?? {}) : null;
  if (!isRecord(config) || !isRecord(servers)) throw new Error(`${path} does not hold an object of "${key}". Add the server by hand.`);
  return { config, servers };
}

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Hands a file to the operating system's default browser, without waiting for it. */
function openInBrowser(file: string): void {
  const [command, ...args] = process.platform === "darwin" ? ["open", file] : process.platform === "win32" ? ["cmd", "/c", "start", "", file] : ["xdg-open", file];
  try {
    spawn(command ?? "open", args, { stdio: "ignore", detached: true }).on("error", () => note(`Could not open a browser. Open ${file} yourself.`)).unref();
  } catch {
    note(`Could not open a browser. Open ${file} yourself.`);
  }
}

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("atlas")
    .description("Local knowledge graph of a codebase: how files, functions, SQL tables, env keys and docs relate.")
    .version(packageVersion())
    .option("-C, --root <dir>", "repository to work on (default: nearest indexed folder, else the git root)")
    .option("--json", "print machine-readable JSON instead of text")
    .option("--no-refresh", "answer from the stored index without checking for changed files")
    .showHelpAfterError("(run with --help for usage)");

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const rootOf = (explicit?: string): string => (explicit ? resolve(explicit) : globals().root ? resolve(globals().root as string) : findRoot(process.cwd()));

  async function withAtlas<T>(work: (atlas: Atlas) => T | Promise<T>): Promise<T> {
    const root = rootOf();
    const atlas = await Atlas.open(root, { noRefresh: !globals().refresh, cwd: process.cwd() });
    try {
      if (atlas.summary.parsed > 0 && !globals().json) note(`(index refreshed: ${atlas.summary.parsed} files parsed in ${atlas.summary.milliseconds} ms)`);
      return await work(atlas);
    } finally {
      atlas.close();
    }
  }

  const output = (data: unknown, text: () => string): void => print(globals().json ? JSON.stringify(data, null, 2) : text());

  program
    .command("index [dir]")
    .description("build or update the index in <dir>/.atlas (only changed files are re-parsed)")
    .option("--full", "re-parse every file")
    .action(async (dir: string | undefined, options: { full?: boolean }) => {
      const root = rootOf(dir);
      if (!existsSync(root)) throw new Error(`Folder not found: ${root}`);
      const atlas = await Atlas.open(root, options.full ? { full: true } : {});
      try {
        output({ root, ...atlas.summary }, () => renderSummary(root, atlas.summary));
      } finally {
        atlas.close();
      }
    });

  program
    .command("search <query>")
    .description("find nodes by name: files, functions, classes, tables, env keys, packages")
    .option("-k, --kind <kind>", `only this kind (${NODE_KINDS.join(", ")})`, nodeKind)
    .option("-n, --limit <count>", "how many results", positiveInteger, 20)
    .action((query: string, options: { kind?: NodeKind; limit: number }) =>
      withAtlas((atlas) => {
        const nodes = atlas.search(query, options);
        output(nodes, () => renderSearch(nodes));
      }),
    );

  program
    .command("context <target>")
    .description("briefing before editing a file, function, table or env key: what it uses and what uses it")
    .action((target: string) =>
      withAtlas((atlas) => {
        const result = atlas.context(target);
        output(result, () => renderContext(result));
      }),
    );

  program
    .command("impact <target>")
    .description("everything that depends on the target, directly or through other code")
    .option("-d, --depth <steps>", "stop after this many steps", positiveInteger)
    .action((target: string, options: { depth?: number }) =>
      withAtlas((atlas) => {
        const result = atlas.impact(target, options.depth);
        output(result, () => renderImpact(result));
      }),
    );

  program
    .command("path <from> <to>")
    .description("shortest chain of relations that connects two nodes")
    .action((from: string, to: string) =>
      withAtlas((atlas) => {
        const result = atlas.path(from, to);
        output(result, () => renderPath(result));
      }),
    );

  program
    .command("mermaid")
    .description("draw the graph as a Mermaid flowchart (file overview, or the neighbourhood of --focus)")
    .option("-f, --focus <target>", "draw around this node")
    .option("-d, --depth <steps>", "how far from --focus to draw", positiveInteger, 1)
    .option("-m, --max <nodes>", "most nodes to draw", positiveInteger, 40)
    .option("-o, --out <file>", "write to a file instead of the terminal")
    .action((options: { focus?: string; depth: number; max: number; out?: string }) =>
      withAtlas((atlas) => {
        const result = atlas.mermaid({ ...(options.focus ? { focus: options.focus } : {}), depth: options.depth, maxNodes: options.max });
        if (options.out) {
          writeFileSync(resolve(options.out), result.text);
          note(`Wrote ${result.nodes} nodes and ${result.edges} edges to ${options.out}`);
        } else {
          output(result, () => result.text);
        }
      }),
    );

  program
    .command("view")
    .description("write the graph as one HTML page to explore in a browser (no server, nothing leaves this machine)")
    .option("-f, --focus <target>", "open the page on this node")
    .option("-o, --out <file>", "where to write the page (default: .atlas/view.html)")
    .option("--open", "open the page in the default browser")
    .action((options: { focus?: string; out?: string; open?: boolean }) =>
      withAtlas((atlas) => {
        const result = atlas.view(options.focus ? { focus: options.focus } : {});
        const file = options.out ? resolve(options.out) : atlas.viewFile;
        writeFileSync(file, result.html);
        if (options.open) openInBrowser(file);
        output({ file, nodes: result.nodes, edges: result.edges }, () => file);
        if (!globals().json) note(`Wrote ${result.nodes} nodes and ${result.edges} relations. Open the file in a browser${options.open ? " (opening it now)" : ", or pass --open"}.`);
      }),
    );

  program
    .command("stats")
    .description("size of the graph and the files most other files depend on")
    .option("--unresolved", "list local imports that could not be resolved")
    .action((options: { unresolved?: boolean }) =>
      withAtlas((atlas) => {
        const result = atlas.stats();
        output(result, () => renderStats(result, options.unresolved === true));
      }),
    );

  program
    .command("export")
    .description("dump every node and edge as JSON")
    .option("-o, --out <file>", "write to a file instead of the terminal")
    .action((options: { out?: string }) =>
      withAtlas((atlas) => {
        const json = JSON.stringify(atlas.export(), null, 2);
        if (options.out) {
          writeFileSync(resolve(options.out), `${json}\n`);
          note(`Wrote ${options.out}`);
        } else {
          print(json);
        }
      }),
    );

  program
    .command("init")
    .description("register the MCP server for this repository with a coding agent (default: .mcp.json, read by Claude Code)")
    .option("--client <name>", `agent to register with: ${Object.keys(CLIENTS).join(", ")} (windsurf means devin)`, client, "claude")
    .action((options: { client: Client }) => {
      const { file, key, typed, next } = CLIENTS[options.client];
      const server = { ...(typed ? { type: "stdio" } : {}), command: "atlas", args: ["mcp"] };
      // Each agent names its list of servers its own way: `mcpServers` for most, `servers` in VS Code's own file.
      const entry = { [key]: { "repo-atlas": server } };
      if (file === null) {
        output({ client: options.client, file: null, ...entry }, () => JSON.stringify(entry, null, 2));
        if (!globals().json) note(next);
        return;
      }
      const root = rootOf();
      if (!existsSync(root)) throw new Error(`Folder not found: ${root}`);
      const path = join(root, file);
      const { config, servers } = readServers(path, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...config, [key]: { ...servers, "repo-atlas": server } }, null, 2)}\n`);
      output({ client: options.client, file: path, ...entry }, () => `Added the "repo-atlas" server to ${path}`);
      if (!globals().json) note(next);
    });

  program
    .command("mcp")
    .description("run the MCP server on stdin/stdout (started by an agent, not by hand)")
    .action(async () => {
      await serveMcp(rootOf());
    });

  return program;
}

export async function run(argv: string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof TargetError) {
      note(`atlas: ${error.message}`);
      for (const candidate of error.candidates) note(`  ${nodeLine(candidate)}`);
      return 2;
    }
    note(`atlas: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
