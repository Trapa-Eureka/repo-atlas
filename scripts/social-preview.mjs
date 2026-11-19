// Draws assets/social-preview.png (1280x640), the image for GitHub's Settings > Social preview.
import { render } from "./chrome.mjs";

const C = { file: "#6cb6ff", sym: "#5ccfa0", table: "#f2c46d", env: "#c9a5f7", doc: "#8b98a8" };
const CH = 9.65, H = 40;
const N = {
  app: ["file", "App.tsx", 628, 150],
  handler: ["file", "handler.ts", 628, 300],
  report: ["file", "report.py", 628, 462],
  list: ["sym", "OrderList()", 818, 112],
  find: ["sym", "findUser()", 818, 250],
  place: ["sym", "place()", 818, 372],
  doc: ["doc", "architecture.md", 1040, 96],
  users: ["table", "users", 1076, 250],
  orders: ["table", "orders", 1076, 400],
  env: ["env", "DATABASE_URL", 1040, 520],
};
const width = (id) => Math.round(N[id][1].length * CH + 52);
const E = [
  ["app", "list", 1, "calls"], ["list", "find", 1, "calls"], ["find", "users", 1, "reads"],
  ["handler", "find", 0], ["handler", "place", 0], ["place", "find", 0], ["place", "orders", 0],
  ["report", "users", 0], ["report", "orders", 0], ["report", "env", 0], ["doc", "users", 2],
];
const HOT = new Set(["app", "list", "find", "users"]);

function edge([a, b, kind, label]) {
  const [, , ax, ay] = N[a], [, , bx, by] = N[b];
  let x1 = ax + width(a), y1 = ay + H / 2, x2 = bx, y2 = by + H / 2, d;
  if (Math.abs(ax - bx) < 80) {
    // same column: leave from the bottom/top centre
    x1 = ax + width(a) / 2; x2 = bx + width(b) / 2;
    y1 = ay < by ? ay + H : ay; y2 = ay < by ? by : by + H;
    d = `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  } else {
    const m = (x1 + x2) / 2;
    d = `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
  }
  if (kind === 1) {
    const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2;
    const tag = `<g transform="translate(${lx} ${ly})"><rect x="-27" y="-11" width="54" height="22" rx="11" fill="#0b1016" stroke="#2f5a4a"/><text y="4.5" text-anchor="middle" font-size="12.5" fill="#7fe0b8">${label}</text></g>`;
    return [`<path d="${d}" stroke="url(#hot)" stroke-width="7" opacity=".28" filter="url(#blur)"/><path d="${d}" stroke="url(#hot)" stroke-width="2.6"/><circle cx="${x2}" cy="${y2}" r="4" fill="#f2c46d"/>`, tag];
  }
  return [`<path d="${d}" stroke="#34404f" stroke-width="1.6" ${kind === 2 ? 'stroke-dasharray="5 6"' : ""}/><circle cx="${x2}" cy="${y2}" r="3" fill="#465364"/>`, ""];
}

function icon(kind, c) {
  if (kind === "table") return `<g fill="none" stroke="${c}" stroke-width="1.8"><ellipse cx="20" cy="14.5" rx="7" ry="3"/><path d="M13 14.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11M13 20c0 1.7 3.1 3 7 3s7-1.3 7-3"/></g>`;
  if (kind === "sym") return `<text x="20" y="26" text-anchor="middle" font-size="15" font-style="italic" font-weight="700" fill="${c}">ƒ</text>`;
  if (kind === "env") return `<g fill="none" stroke="${c}" stroke-width="1.8"><circle cx="17" cy="20" r="4"/><path d="M21 20h8M26 20v4"/></g>`;
  return `<path d="M15 12h7l4 4v12H15z M22 12v4h4" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>`;
}

function node(id) {
  const [kind, label, x, y] = N[id], c = C[kind], w = width(id), hot = HOT.has(id), target = id === "users";
  return `<g transform="translate(${x} ${y})">
    ${target ? `<rect x="-14" y="-14" width="${w + 28}" height="${H + 28}" rx="24" fill="none" stroke="${c}" opacity=".16"/><rect x="-7" y="-7" width="${w + 14}" height="${H + 14}" rx="18" fill="${c}" opacity=".10"/><rect x="-7" y="-7" width="${w + 14}" height="${H + 14}" rx="18" fill="none" stroke="${c}" opacity=".38"/>` : ""}
    <rect width="${w}" height="${H}" rx="11" fill="${hot ? "#141d27" : "#111820"}" stroke="${c}" stroke-opacity="${hot ? 0.95 : 0.34}" stroke-width="${hot ? 1.8 : 1.3}"/>
    <g opacity="${hot ? 1 : 0.7}">${icon(kind, c)}</g>
    <text x="38" y="25.5" font-size="16" fill="${hot ? "#f3f6fa" : "#9aa7b6"}" font-weight="${hot ? 600 : 500}">${label}</text>
  </g>`;
}

const drawn = E.map(edge);
const svg = `<svg width="1280" height="640" viewBox="0 0 1280 640" style="position:absolute;inset:0" font-family="ui-monospace,'SF Mono',Menlo,monospace" fill="none">
  <defs>
    <linearGradient id="hot" gradientUnits="userSpaceOnUse" x1="628" y1="0" x2="1076" y2="0"><stop offset="0" stop-color="#6cb6ff"/><stop offset=".5" stop-color="#5ccfa0"/><stop offset="1" stop-color="#f2c46d"/></linearGradient>
    <filter id="blur" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.2" r="1.2" fill="#2a3644"/></pattern>
    <radialGradient id="fade" cx="72%" cy="50%" r="52%"><stop offset="0" stop-color="#fff"/><stop offset=".75" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <mask id="m"><rect width="1280" height="640" fill="url(#fade)"/></mask>
  </defs>
  <rect width="1280" height="640" fill="url(#dots)" mask="url(#m)"/>
  ${drawn.map((d) => d[0]).join("\n")}
  ${Object.keys(N).map(node).join("\n")}
  ${drawn.map((d) => d[1]).join("\n")}
</svg>`;

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1280px;height:640px;position:relative;overflow:hidden;color:#fff;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;
  background:radial-gradient(620px 420px at 78% 40%,rgba(92,207,160,.13),transparent 70%),radial-gradient(520px 380px at 96% 4%,rgba(108,182,255,.14),transparent 70%),radial-gradient(480px 360px at 70% 104%,rgba(242,196,109,.09),transparent 70%),#0b1016}
.copy{position:absolute;left:76px;top:92px;width:500px}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:600 15px ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.14em;color:#7fe0b8;text-transform:uppercase}
.eyebrow i{width:8px;height:8px;border-radius:50%;background:#5ccfa0;box-shadow:0 0 0 5px rgba(92,207,160,.18)}
h1{font-size:96px;letter-spacing:-4px;font-weight:800;line-height:1;margin-top:22px}
h1 b{background:linear-gradient(100deg,#5ccfa0,#6cb6ff);-webkit-background-clip:text;color:transparent}
p{font-size:28px;line-height:1.36;color:#aab6c4;margin-top:24px;letter-spacing:-.2px}
.cmd{position:absolute;left:76px;bottom:70px;font:600 21px ui-monospace,"SF Mono",Menlo,monospace;background:rgba(21,28,37,.86);border:1px solid #283341;border-radius:12px;padding:15px 22px;box-shadow:0 14px 34px rgba(0,0,0,.35)}
.cmd span{color:#5ccfa0}.cmd em{color:#6b7887;font-style:normal;font-weight:500}
.pills{position:absolute;left:76px;bottom:150px;display:flex;gap:10px}
.pills b{font:600 15px ui-monospace,"SF Mono",Menlo,monospace;color:#c3ccd7;border:1px solid #2b3644;background:rgba(21,28,37,.7);border-radius:999px;padding:7px 14px}
</style>${svg}
<div class="copy"><div class="eyebrow"><i></i>codebase knowledge graph</div><h1>Repo <b>Atlas</b></h1><p>Know what a change touches before you, or your coding agent, make it.</p></div>
<div class="pills"><b>CLI</b><b>MCP server</b><b>local-only</b></div>
<div class="cmd"><span>$</span> atlas impact users <em># what breaks?</em></div>`;
render("social-preview", html, { width: 1280, height: 640 });
