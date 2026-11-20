// The page `atlas view` writes: its stylesheet and its script, as text. The script runs in a
// browser, reads `window.ATLAS` (the graph, embedded by view.ts) and never touches the network.
// It is written without template literals so that it can sit inside one here.

export const PAGE_STYLE = String.raw`
:root{--bg:#f6f8fa;--panel:#fff;--line:#d9dee5;--text:#1b2129;--dim:#667080;--hot:#0b6bcb;--edge:#b3bcc8;
  --file:#2f6fd0;--symbol:#1f9d6b;--table:#b7791f;--env:#7c4dcc;--module:#6b7684}
@media (prefers-color-scheme:dark){:root{--bg:#0b1016;--panel:#121922;--line:#263140;--text:#e6ebf1;--dim:#8b98a8;--hot:#6cb6ff;--edge:#3d4a5a;
  --file:#6cb6ff;--symbol:#5ccfa0;--table:#f2c46d;--env:#c9a5f7;--module:#8b98a8}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;display:grid;grid-template:auto 1fr/300px 1fr 340px;overflow:hidden}
header{grid-column:1/-1;display:flex;gap:14px;align-items:baseline;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
header b{font-size:15px}header span{color:var(--dim);font-size:13px}
aside{background:var(--panel);overflow:auto;padding:12px}
#side{border-right:1px solid var(--line)}#detail{border-left:1px solid var(--line)}
input[type=search]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
input[type=search]:focus{outline:2px solid var(--hot);outline-offset:-1px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px 10px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--hot);color:var(--hot)}
ul{list-style:none;margin:0;padding:0}
li.node{padding:5px 8px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere}
li.node:hover,li.node:focus{background:var(--bg);outline:none}
.dot{flex:none;width:9px;height:9px;border-radius:3px;display:inline-block;position:relative;top:1px}
.sub{color:var(--dim);font-size:12px}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:16px 0 6px}
h1{font-size:16px;margin:0 0 2px;overflow-wrap:anywhere}
main{position:relative;overflow:hidden;min-width:0}
#bar{position:absolute;left:12px;top:12px;right:12px;display:flex;gap:8px;align-items:center;z-index:1;flex-wrap:wrap}
#bar .gap{flex:1}
svg{width:100%;height:100%;display:block;cursor:grab;font:12.5px ui-monospace,"SF Mono",Menlo,Consolas,monospace}
svg:active{cursor:grabbing}
.box rect{fill:var(--panel);stroke-width:1.4}
.box{cursor:pointer}.box text{fill:var(--text)}
.box.focus rect{stroke-width:2.6}.box.focus text{font-weight:700}
.box.more rect{stroke-dasharray:4 4}.box.more text{fill:var(--dim)}
path.edge{fill:none;stroke:var(--edge);stroke-width:1.3}
path.edge.lit{stroke:var(--hot);stroke-width:2}
text.kind{fill:var(--dim);font-size:10.5px;pointer-events:none}
.dim{opacity:.25}
#empty{position:absolute;inset:60px 20px 20px;overflow:auto}
.hint{color:var(--dim);margin:6px 0 12px}
@media (max-width:900px){body{grid-template:auto auto 1fr auto/1fr;overflow:auto}aside{max-height:260px}#side{border-right:0;border-bottom:1px solid var(--line)}#detail{border-left:0;border-top:1px solid var(--line)}main{min-height:420px}}
`;

export const PAGE_SCRIPT = String.raw`
(function () {
  var data = window.ATLAS, N = data.nodes, E = data.edges, KINDS = data.edgeKinds;
  var DEPENDS = { imports: 1, calls: 1, references: 1, reads_table: 1, writes_table: 1, uses_env: 1, documents: 1 };
  var OWNS = { defines: 1, defines_table: 1, declares_env: 1 };
  var out = N.map(function () { return []; }), inc = N.map(function () { return []; }), index = {};
  N.forEach(function (n, i) { index[n[0]] = i; });
  E.forEach(function (e, i) { out[e[0]].push(i); inc[e[1]].push(i); });
  var state = { focus: null, depth: 1, mode: 'near', kind: '' };
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  var svgEl = function (tag, attrs, text) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  var kindOf = function (i) { return N[i][1]; };
  var label = function (i) {
    var name = N[i][2];
    return name.length > 44 ? name.slice(0, 18) + '…' + name.slice(-24) : name;
  };
  var where = function (i) {
    var n = N[i];
    if (n[1] === 'file') return n[5] || 'file';
    return (n[5] || n[1]) + (n[3] ? ' · ' + n[3] + (n[4] ? ':' + n[4] : '') : '');
  };
  var dependents = function (i) { return inc[i].filter(function (e) { return DEPENDS[KINDS[E[e][2]]]; }).length; };

  function row(i, extra) {
    var item = el('li', { class: 'node', tabindex: '0' });
    var dot = el('span', { class: 'dot' });
    dot.style.background = 'var(--' + kindOf(i) + ')';
    item.appendChild(dot);
    var text = el('span', {}, label(i));
    text.appendChild(el('div', { class: 'sub' }, extra || where(i)));
    item.appendChild(text);
    var go = function () { focus(i); };
    item.addEventListener('click', go);
    item.addEventListener('keydown', function (event) { if (event.key === 'Enter') go(); });
    return item;
  }

  // ---------- search ----------
  function search() {
    var query = $('q').value.trim().toLowerCase(), list = $('results'), found = [];
    list.textContent = '';
    for (var i = 0; i < N.length; i++) {
      if (state.kind && kindOf(i) !== state.kind) continue;
      var name = N[i][2].toLowerCase();
      var at = query ? name.indexOf(query) : 0;
      if (at === -1) continue;
      var short = name.slice(name.lastIndexOf('/') + 1);
      found.push([name === query || short === query ? 0 : short.indexOf(query) === 0 ? 1 : 2, -dependents(i), name, i]);
    }
    found.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1); });
    $('count').textContent = found.length + (query || state.kind ? ' found' : ' nodes, most depended-on first');
    found.slice(0, 80).forEach(function (hit) { list.appendChild(row(hit[3])); });
  }

  // ---------- what to draw ----------
  function near(focusIndex, depth) {
    var column = {}, order = [focusIndex];
    column[focusIndex] = 0;
    [[out, 1, 1], [inc, 0, -1]].forEach(function (side) {
      var frontier = [focusIndex];
      for (var d = 1; d <= depth; d++) {
        var next = [];
        frontier.forEach(function (i) {
          side[0][i].forEach(function (e) {
            var other = E[e][side[1]];
            if (column[other] !== undefined) return;
            column[other] = d * side[2];
            order.push(other);
            next.push(other);
          });
        });
        frontier = next;
      }
    });
    return { column: column, order: order };
  }

  function impact(focusIndex) {
    var distance = {}, order = [], frontier = [focusIndex];
    distance[focusIndex] = 0;
    out[focusIndex].forEach(function (e) {
      if (!OWNS[KINDS[E[e][2]]] || distance[E[e][1]] !== undefined) return;
      distance[E[e][1]] = 0;
      frontier.push(E[e][1]);
    });
    if (N[focusIndex][5] === 'class') {
      N.forEach(function (n, i) { if (n[0].indexOf(N[focusIndex][0] + '.') === 0 && distance[i] === undefined) { distance[i] = 0; frontier.push(i); } });
    }
    var seeds = frontier.slice(), named = {};
    for (var d = 1; frontier.length; d++) {
      var next = [];
      frontier.forEach(function (i) {
        inc[i].forEach(function (e) {
          var from = E[e][0];
          var kind = KINDS[E[e][2]];
          if (!DEPENDS[kind]) return;
          if (distance[from] !== undefined) {
            if (kind !== 'references' && named[from]) { named[from] = false; next.push(from); }
            return;
          }
          distance[from] = d;
          order.push(from);
          if (N[from][5] === 'markdown') return;
          if (kind === 'references') { named[from] = true; return; }
          next.push(from);
          if (kindOf(from) !== 'symbol') return;
          inc[from].forEach(function (owner) {
            var file = E[owner][0];
            if (KINDS[E[owner][2]] === 'defines' && distance[file] === undefined) { distance[file] = d; order.push(file); }
          });
        });
      });
      frontier = next;
    }
    return { distance: distance, order: order, seeds: seeds };
  }

  // ---------- drawing ----------
  var view = { x: 0, y: 0, k: 1 };
  function applyView() { $('scene').setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'); }

  function draw() {
    var scene = $('scene');
    scene.textContent = '';
    $('empty').hidden = state.focus !== null;
    $('bar').hidden = state.focus === null;
    if (state.focus === null) return;
    var column = {}, order;
    if (state.mode === 'impact') {
      var reach = impact(state.focus);
      order = [state.focus].concat(reach.order);
      order.forEach(function (i) { column[i] = -Math.min(reach.distance[i], 4); });
    } else {
      var around = near(state.focus, state.depth);
      column = around.column;
      order = around.order;
    }
    var columns = {}, hidden = {}, CAP = 16;
    order.forEach(function (i) {
      var list = columns[column[i]] = columns[column[i]] || [];
      if (list.length < CAP) list.push(i);
      else hidden[column[i]] = (hidden[column[i]] || 0) + 1;
    });
    var keys = Object.keys(columns).map(Number).sort(function (a, b) { return a - b; });
    var place = {}, x = 0, H = 30, GAP = 12, tallest = 0;
    keys.forEach(function (key) { tallest = Math.max(tallest, columns[key].length + (hidden[key] ? 1 : 0)); });
    var boxes = [];
    keys.forEach(function (key) {
      var list = columns[key], width = 0;
      list.forEach(function (i) { width = Math.max(width, label(i).length * 7.7 + 26); });
      var rows = list.length + (hidden[key] ? 1 : 0), top = (tallest - rows) * (H + GAP) / 2;
      list.forEach(function (i, rowIndex) {
        place[i] = { x: x, y: top + rowIndex * (H + GAP), w: label(i).length * 7.7 + 26 };
        boxes.push(i);
      });
      if (hidden[key]) boxes.push({ more: hidden[key], x: x, y: top + list.length * (H + GAP), key: key });
      x += width + 110;
    });
    var lines = [];
    E.forEach(function (e, edgeIndex) {
      var a = place[e[0]], b = place[e[1]];
      if (!a || !b || column[e[0]] === column[e[1]]) return;
      if (state.mode === 'impact' && !DEPENDS[KINDS[e[2]]] && !OWNS[KINDS[e[2]]]) return;
      var left = a.x < b.x ? a : b, right = a.x < b.x ? b : a;
      var x1 = left.x + left.w, y1 = left.y + H / 2, x2 = right.x, y2 = right.y + H / 2, mid = (x1 + x2) / 2;
      var path = svgEl('path', { class: 'edge', d: 'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ' ' + mid + ' ' + y2 + ' ' + x2 + ' ' + y2, 'marker-end': a.x < b.x ? 'url(#tip)' : '', 'marker-start': a.x < b.x ? '' : 'url(#tail)' });
      path.appendChild(svgEl('title', {}, N[e[0]][2] + ' — ' + KINDS[e[2]] + ' → ' + N[e[1]][2]));
      scene.appendChild(path);
      lines.push([e[0], e[1], path, edgeIndex, x1 + 16, y1, x2 - 16, y2, KINDS[e[2]], a.x < b.x]);
    });
    // With few lines there is room to say what they are: one label per box, naming the kinds of relation that leave it.
    if (lines.length <= 28) {
      var labels = {};
      lines.forEach(function (line) {
        var key = line[0] + (line[9] ? '>' : '<'), entry = labels[key] = labels[key] || { kinds: [], x: line[9] ? line[4] : line[6], y: line[9] ? line[5] : line[7], anchor: line[9] ? 'start' : 'end' };
        if (entry.kinds.indexOf(line[8]) === -1) entry.kinds.push(line[8]);
      });
      Object.keys(labels).forEach(function (key) {
        var entry = labels[key];
        var kinds = entry.kinds.sort(), words = kinds.join(' · ');
        // The gap between two columns fits about fifteen characters; hovering a line names its kind in full.
        if (words.length > 15) words = kinds[0] + ' +' + (kinds.length - 1);
        scene.appendChild(svgEl('text', { class: 'kind', x: entry.x, y: entry.y - 5, 'text-anchor': entry.anchor }, words.replace(/_/g, ' ')));
      });
    }
    boxes.forEach(function (i) {
      if (typeof i !== 'number') {
        var more = svgEl('g', { class: 'box more', transform: 'translate(' + i.x + ' ' + i.y + ')' });
        more.appendChild(svgEl('rect', { width: 110, height: H, rx: 8, stroke: 'var(--dim)' }));
        more.appendChild(svgEl('text', { x: 13, y: 19.5 }, '+ ' + i.more + ' more'));
        more.appendChild(svgEl('title', {}, 'All of them are listed in the panel on the right'));
        scene.appendChild(more);
        return;
      }
      var p = place[i], box = svgEl('g', { class: 'box' + (i === state.focus ? ' focus' : ''), transform: 'translate(' + p.x + ' ' + p.y + ')', tabindex: '0', role: 'button', 'aria-label': N[i][2] });
      box.appendChild(svgEl('rect', { width: p.w, height: H, rx: 8, stroke: 'var(--' + kindOf(i) + ')' }));
      box.appendChild(svgEl('text', { x: 13, y: 19.5 }, label(i)));
      box.appendChild(svgEl('title', {}, N[i][0]));
      box.addEventListener('click', function () { focus(i); });
      box.addEventListener('keydown', function (event) { if (event.key === 'Enter') focus(i); });
      var light = function (on) {
        lines.forEach(function (line) {
          var touches = line[0] === i || line[1] === i;
          line[2].classList.toggle('lit', on && touches);
          line[2].classList.toggle('dim', on && !touches);
        });
      };
      box.addEventListener('mouseenter', function () { light(true); });
      box.addEventListener('mouseleave', function () { light(false); });
      scene.appendChild(box);
    });
    var bounds = $('canvas').getBoundingClientRect(), wide = Math.max(x - 110, 1), tall = Math.max(tallest * (H + GAP) - GAP, 1);
    view.k = Math.min(1, (bounds.width - 60) / wide, (bounds.height - 110) / tall);
    view.k = Math.max(view.k, 0.25);
    view.x = (bounds.width - wide * view.k) / 2;
    view.y = Math.max(70, (bounds.height - tall * view.k) / 2 + 20);
    applyView();
  }

  // ---------- detail panel ----------
  function group(title, edges, side) {
    var panel = $('detail');
    if (!edges.length) return;
    var byKind = {};
    edges.forEach(function (e) { (byKind[KINDS[E[e][2]]] = byKind[KINDS[E[e][2]]] || []).push(e); });
    Object.keys(byKind).sort().forEach(function (kind) {
      panel.appendChild(el('h2', {}, title + ' · ' + kind.replace(/_/g, ' ') + ' (' + byKind[kind].length + ')'));
      var list = el('ul');
      byKind[kind].slice(0, 200).forEach(function (e) { list.appendChild(row(E[e][side], where(E[e][side]) + (E[e][3] ? ' · line ' + E[e][3] : ''))); });
      panel.appendChild(list);
    });
  }

  function detail() {
    var panel = $('detail'), i = state.focus;
    panel.textContent = '';
    if (i === null) { panel.appendChild(el('p', { class: 'hint' }, 'Pick a node to see what it uses and what uses it.')); return; }
    panel.appendChild(el('h1', {}, N[i][2]));
    panel.appendChild(el('div', { class: 'sub' }, N[i][1] + ' · ' + where(i)));
    if (state.mode === 'impact') {
      var reach = impact(i), byDistance = {};
      reach.order.forEach(function (n) { (byDistance[reach.distance[n]] = byDistance[reach.distance[n]] || []).push(n); });
      panel.appendChild(el('p', { class: 'hint' }, reach.order.length ? reach.order.length + ' nodes may need attention if this changes.' : 'Nothing in the graph depends on this.'));
      Object.keys(byDistance).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
        panel.appendChild(el('h2', {}, (d === 1 ? 'Directly' : d + ' steps away') + ' (' + byDistance[d].length + ')'));
        var list = el('ul');
        byDistance[d].slice(0, 200).forEach(function (n) { list.appendChild(row(n)); });
        panel.appendChild(list);
      });
      return;
    }
    group('Uses', out[i], 1);
    group('Used by', inc[i], 0);
    if (!out[i].length && !inc[i].length) panel.appendChild(el('p', { class: 'hint' }, 'No relations recorded for this node.'));
  }

  function focus(i) {
    state.focus = i;
    $('title').textContent = i === null ? '' : N[i][2];
    remember();
    draw();
    detail();
  }

  // The address keeps the node, the mode and the depth, so a view can be bookmarked or sent to someone with the same file.
  function remember() {
    var i = state.focus;
    if (history.replaceState) history.replaceState(null, '', i === null ? '#' : '#' + encodeURIComponent(N[i][0]) + ';' + state.mode + ';' + state.depth);
  }

  function setMode(mode) {
    state.mode = mode;
    pressed(['near', 'impact'], mode);
    $('depth').hidden = mode === 'impact';
  }

  function setDepth(depth) {
    state.depth = depth;
    pressed(['d1', 'd2'], 'd' + depth);
  }

  function pressed(ids, active) { ids.forEach(function (id) { $(id).setAttribute('aria-pressed', String(id === active)); }); }

  // ---------- wiring ----------
  $('q').addEventListener('input', search);
  ['', 'file', 'symbol', 'table', 'env', 'module'].forEach(function (kind) {
    var chip = el('button', { type: 'button', 'aria-pressed': String(kind === '') }, kind || 'all');
    chip.addEventListener('click', function () {
      state.kind = kind;
      Array.prototype.forEach.call($('kinds').children, function (other) { other.setAttribute('aria-pressed', String(other === chip)); });
      search();
    });
    $('kinds').appendChild(chip);
  });
  $('d1').addEventListener('click', function () { setDepth(1); remember(); draw(); });
  $('d2').addEventListener('click', function () { setDepth(2); remember(); draw(); });
  $('near').addEventListener('click', function () { setMode('near'); remember(); draw(); detail(); });
  $('impact').addEventListener('click', function () { setMode('impact'); remember(); draw(); detail(); });
  $('home').addEventListener('click', function () { focus(null); });

  var canvas = $('canvas'), drag = null;
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    var box = canvas.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
    var k = Math.min(3, Math.max(0.15, view.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }, { passive: false });
  canvas.addEventListener('pointerdown', function (event) { drag = { x: event.clientX - view.x, y: event.clientY - view.y }; });
  window.addEventListener('pointermove', function (event) { if (drag) { view.x = event.clientX - drag.x; view.y = event.clientY - drag.y; applyView(); } });
  window.addEventListener('pointerup', function () { drag = null; });
  window.addEventListener('resize', draw);

  var hubs = N.map(function (n, i) { return [dependents(i), i]; }).filter(function (hub) { return hub[0] > 0; });
  hubs.sort(function (a, b) { return b[0] - a[0] || (N[a[1]][0] < N[b[1]][0] ? -1 : 1); });
  hubs.slice(0, 40).forEach(function (hub) { $('hubs').appendChild(row(hub[1], hub[0] + (hub[0] === 1 ? ' dependent · ' : ' dependents · ') + where(hub[1]))); });

  search();
  var parts = location.hash.slice(1).split(';'), asked = decodeURIComponent(parts[0]) || data.focus;
  if (parts[1] === 'impact') setMode('impact');
  if (parts[2] === '2') setDepth(2);
  focus(asked && index[asked] !== undefined ? index[asked] : null);
})();
`;
