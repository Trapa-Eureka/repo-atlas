// Re-captures the README screenshots in assets/: runs the built CLI on fixtures/shop and renders each
// capture as a terminal window. Run with `pnpm screenshots` (builds first).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, repo } from "./chrome.mjs";

const shop = join(repo, "fixtures/shop");
const cli = join(repo, "dist/cli/main.js");
if (!existsSync(cli)) throw new Error("dist/cli/main.js is missing. Run `pnpm build` first.");

const atlas = (...args) => {
  const r = spawnSync("node", [cli, ...args], { cwd: shop, encoding: "utf8" });
  return (r.stdout + r.stderr).replaceAll(shop, "~/shop").trimEnd();
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colour(line) {
  let h = esc(line);
  if (/^\$ /.test(line)) return `<span class="p">$</span> <span class="c">${esc(line.slice(2))}</span>`;
  if (/^# /.test(line)) return `<span class="d">${h}</span>`;
  if (/^[a-z0-9 ,-]+ \(\d+\)$/i.test(line) || /^(nodes|edges|files by language|most depended-on files)$/.test(line)) return `<span class="h">${h}</span>`;
  h = h.replace(/\[([a-z_]+) ([^\]]+)\]/g, '<span class="d">[</span><span class="k">$1</span> <span class="d">$2]</span>');
  h = h.replace(/\b(sym|file|table|env|mod):/g, '<span class="t">$1:</span>');
  h = h.replace(/\b(error)\b/g, '<span class="e">$1</span>').replace(/(no-restricted-imports|no-console)$/, '<span class="d">$1</span>');
  h = h.replace(/  (line \d+)$/, '  <span class="d">$1</span>');
  return h;
}

const CSS = `
*{box-sizing:border-box;margin:0}
body{background:#eef1f5;font-family:ui-monospace,"SF Mono",Menlo,monospace;padding:28px}
.win{background:#0f1419;border-radius:12px;box-shadow:0 12px 34px rgba(15,20,25,.28);overflow:hidden}
.bar{height:38px;background:#1a212b;display:flex;align-items:center;padding:0 14px;gap:8px}
.bar i{width:12px;height:12px;border-radius:50%;display:block}
.bar span{color:#7d8896;font-size:12.5px;margin-left:10px;font-family:-apple-system,"Helvetica Neue",sans-serif}
pre{color:#d6dde6;font-size:13.5px;line-height:21px;padding:16px 20px 20px;white-space:pre}
.p{color:#5ccfa0}.c{color:#fff;font-weight:600}.h{color:#f2c46d;font-weight:600}.t{color:#6cb6ff}.k{color:#c9a5f7}.d{color:#77828f}.e{color:#ff7b72;font-weight:600}
`;

function shot(name, title, text, width = 980) {
  const lines = text.split("\n");
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${esc(title)}</span></div><pre>${lines.map(colour).join("\n")}</pre></div>`;
  render(name, html, { width, height: 56 + 38 + 36 + lines.length * 21, scale: 2 });
}

// Phase 1-2: index + stats
shot("index", "atlas index · atlas stats", ["$ atlas index --full", atlas("index", "--full"), "", "$ atlas index", atlas("index"), "", "$ atlas stats", atlas("stats")].join("\n"), 900);

// Phase 3: context, impact, path
shot("context", "atlas context", ["$ atlas context src/users/repo.ts", atlas("context", "src/users/repo.ts")].join("\n"), 1130);
shot("impact", "atlas impact · atlas path", ["$ atlas impact users", atlas("impact", "users"), "", "$ atlas path web/App.tsx users", atlas("path", "web/App.tsx", "users")].join("\n"), 900);

// Phase 0: the lint hook rejecting a layer violation
const probe = join(repo, "src/query/shortcut.ts");
writeFileSync(probe, 'import { DatabaseSync } from "node:sqlite";\nimport { Store } from "../store/store.js";\n\nexport const peek = (store: Store) => console.log(store, DatabaseSync);\n');
let hook;
try {
  hook = spawnSync("node", [join(repo, ".claude/hooks/lint-edited.mjs")], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: probe } }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
} finally {
  rmSync(probe, { force: true });
}
const hookText = hook.stderr.replaceAll(`${repo}/`, "").replace(/ {3,}/g, "  ").replace(/^(\s+\d+:\d+\s+error\s+)(.*?)(\s+)(no-[a-z-]+)$/gm, (_, a, msg, __, rule) => `${a}${rule}\n${msg.match(/.{1,96}(?:\s|$)/g).map((l) => `           ${l.trimEnd()}`).join("\n")}`).trimEnd();
shot("hook", "PostToolUse hook: an edit that breaks the layer rules is sent back to the agent", ["# the agent wrote src/query/shortcut.ts, which reaches into SQLite from the query layer", "$ node .claude/hooks/lint-edited.mjs   # run by Claude Code after every edit", hookText, "", `# exit code ${hook.status}: Claude Code hands this message back to the agent`].join("\n"), 1000);

// Phase 4: MCP over stdio
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "atlas_path", arguments: { from: "web/App.tsx", to: "users" } } },
];
const mcp = spawnSync("sh", ["-c", `(printf '%s\\n' ${requests.map((r) => `'${JSON.stringify(r)}'`).join(" ")}; sleep 2) | node ${cli} mcp`], { cwd: shop, encoding: "utf8" });
const replies = mcp.stdout.trim().split("\n").map((l) => JSON.parse(l));
const tools = replies.find((r) => r.id === 2).result.tools.map((t) => `  ${t.name.padEnd(15)} ${t.description.split(/[:.,(]/)[0].trim()}`);
const path = JSON.parse(replies.find((r) => r.id === 3).result.content[0].text);
shot("mcp", "atlas mcp: the same graph for a coding agent, over the Model Context Protocol", [
  "$ atlas init",
  atlas("init").replace(/\n.*/s, ""),
  "",
  "# what an agent sees after connecting (JSON-RPC over stdin/stdout, shortened)",
  `--> tools/list`,
  `<-- ${replies.find((r) => r.id === 1).result.serverInfo.name} ${replies.find((r) => r.id === 1).result.serverInfo.version}, ${tools.length} tools`,
  ...tools,
  "",
  `--> tools/call atlas_path ${JSON.stringify(requests[3].params.arguments)}`,
  `<-- direction: ${path.direction}`,
  ...path.steps.map((s) => `  ${s.src}  -[${s.kind}]->  ${s.dst}  (line ${s.line})`),
].join("\n"), 1080);
rmSync(join(shop, ".mcp.json"), { force: true });
