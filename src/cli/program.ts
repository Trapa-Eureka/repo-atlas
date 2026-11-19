import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
    .description("register the MCP server for this repository in .mcp.json, so coding agents can query the graph")
    .action(() => {
      const root = rootOf();
      const file = join(root, ".mcp.json");
      const config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }) : {};
      config.mcpServers = { ...config.mcpServers, "repo-atlas": { command: "atlas", args: ["mcp"] } };
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      print(`Added the "repo-atlas" server to ${file}\nRestart your agent (Claude Code asks once whether to trust the new server).`);
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
