// Re-captures the README screenshots in assets/: runs the built CLI on fixtures/shop and renders each
// capture as a terminal window. Run with `pnpm screenshots` (builds first).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Phase 3: the output of `atlas mermaid --focus`, drawn. GitHub renders a mermaid block itself but the
// npm page shows it as code, so the README carries this picture and keeps the block folded below it.
// The layout is ours (what points at the focus on the left, what it points at on the right), not Mermaid's.
{
  const KIND = { "[": ["file", "#6cb6ff"], "(": ["function", "#5ccfa0"], "[(": ["table", "#f2c46d"], "{{": ["env", "#c9a5f7"], "([": ["package", "#8b98a8"] };
  const text = atlas("mermaid", "--focus", "findUser");
  const nodes = new Map([...text.matchAll(/^\s*(n\d+)(\[\(|\(\[|\{\{|\[|\()"([^"]*)"/gm)].map(([, id, open, label]) => [id, { label, kind: KIND[open][0], colour: KIND[open][1] }]));
  const edges = [...text.matchAll(/^\s*(n\d+) -->\|([^|]+)\| (n\d+)/gm)].map(([, src, kind, dst]) => ({ src, kind, dst }));
  const focus = /style (n\d+) stroke-width/.exec(text)?.[1];
  if (!focus || nodes.size === 0) throw new Error("screenshots: could not read the output of `atlas mermaid --focus findUser`");

  const W = 844, CARD = 38, GAP = 20, PAD = 26, CHAR = 8.45;
  const width = (id) => Math.round(nodes.get(id).label.length * CHAR + 30);
  const left = edges.filter((edge) => edge.dst === focus);
  const right = edges.filter((edge) => edge.src === focus);
  const height = PAD * 2 + Math.max(left.length, right.length, 1) * (CARD + GAP) - GAP;
  const rowY = (index, count) => height / 2 - (count * (CARD + GAP) - GAP) / 2 + index * (CARD + GAP);
  // Labels sit in a column of their own beside the cards, on the straight part of each line, so that
  // the lines can converge on the focus without running through them.
  const LABEL = 78;
  const labelLeft = PAD + Math.max(0, ...left.map((edge) => width(edge.src))) + 22 + LABEL / 2;
  const labelRight = W - PAD - Math.max(0, ...right.map((edge) => width(edge.dst))) - 22 - LABEL / 2;
  const focusX = (labelLeft + labelRight) / 2 - width(focus) / 2, focusY = height / 2 - CARD / 2;

  const card = (id, x, y, hot) => {
    const { label, colour } = nodes.get(id);
    return `<rect x="${x}" y="${y}" width="${width(id)}" height="${CARD}" rx="10" fill="${hot ? "#16202b" : "#111820"}" stroke="${colour}" stroke-width="${hot ? 2.4 : 1.3}" stroke-opacity="${hot ? 1 : 0.6}"/><text x="${x + 15}" y="${y + 24.5}" font-size="14" fill="${hot ? "#fff" : "#c3ccd7"}" font-weight="${hot ? 600 : 500}">${esc(label)}</text>`;
  };
  const tag = (x, y, label) => `<g transform="translate(${x} ${y})"><rect x="${-LABEL / 2}" y="-10" width="${LABEL}" height="20" rx="10" fill="#0f1419" stroke="#2a3644"/><text y="4" text-anchor="middle" font-size="11.5" fill="#8b98a8">${esc(label)}</text></g>`;
  const curve = (x1, y1, x2, y2) => `C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
  const line = (d) => `<path d="${d}" stroke="#4a5869" stroke-width="1.5" marker-end="url(#tip)"/>`;

  const drawn = [];
  left.forEach((edge, index) => {
    const y = rowY(index, left.length);
    const bend = labelLeft + LABEL / 2 + 8, middle = y + CARD / 2;
    drawn.push(line(`M${PAD + width(edge.src)} ${middle} H${bend} ${curve(bend, middle, focusX - 7, focusY + CARD / 2)}`), tag(labelLeft, middle, edge.kind), card(edge.src, PAD, y, false));
  });
  right.forEach((edge, index) => {
    const y = rowY(index, right.length), x = W - PAD - width(edge.dst);
    const bend = labelRight - LABEL / 2 - 8, middle = y + CARD / 2;
    drawn.push(line(`M${focusX + width(focus)} ${focusY + CARD / 2} ${curve(focusX + width(focus), focusY + CARD / 2, bend, middle)} H${x - 7}`), tag(labelRight, middle, edge.kind), card(edge.dst, x, y, false));
  });
  drawn.push(card(focus, focusX, focusY, true));
  const used = [...new Set([...nodes.values()].map((node) => `${node.kind}|${node.colour}`))];
  const legend = used.map((entry) => entry.split("|")).map(([kind, colour]) => `<span><i style="border-color:${colour}"></i>${kind}</span>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}
.legend{display:flex;gap:18px;padding:0 20px 18px;color:#77828f;font-size:12.5px}.legend span{display:flex;align-items:center;gap:7px}.legend i{width:12px;height:12px;border-radius:4px;border:1.5px solid;display:block}
svg{display:block}</style><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>atlas mermaid: the neighbourhood of one function, drawn</span></div>
<pre style="padding-bottom:0">${colour("$ atlas mermaid --focus findUser")}\n${colour("# a Mermaid flowchart; drawn here from that output")}</pre>
<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" fill="none" font-family="ui-monospace,'SF Mono',Menlo,monospace"><defs><marker id="tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#4a5869"/></marker></defs>${drawn.join("")}</svg>
<div class="legend">${legend}</div></div>`;
  render("mermaid", html, { width: 900, height: 56 + 38 + 16 + 42 + height + 36, scale: 2 });
}

// Phase 5: the page `atlas view` writes, opened on what breaks when the users table changes.
{
  const page = join(shop, ".atlas", "view.html");
  atlas("view");
  render("view", readFileSync(page, "utf8"), { width: 1280, height: 720, scale: 2, wait: 3000, hash: `#${encodeURIComponent("table:users")};impact;1` });
}

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
