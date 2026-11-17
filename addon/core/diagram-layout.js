// Box-and-arrow diagrams without a library (MV3 blocks remote scripts and we
// ship none): a small layered layout. Nodes go in layers by longest path,
// layers are ordered to cut crossings (barycenter sweeps), boxes are placed
// near their neighbours, and arrows are routed as right-angled elbows.
// Long edges bend through invisible waypoints; edges that point backwards
// (loops) run around the side. Pure, so it is unit-tested.
//
// graph: {nodes: [{id, label, sub?, kind?, shape?}], edges: [{from, to, label?, kind?}]}
// → {width, height, dir, nodes: [{...node, x, y, w, h, lines, subLines}], edges: [{...edge, points, labelAt, back}]}

const CHAR_W = 6.4;   // average width of a 12px sans-serif character
const LINE_H = 15;
const PAD_X = 12;
const PAD_Y = 9;

// Word-wrap to at most `maxLines` lines of `width` px; the last line ends in "…" when cut.
export function wrapText(text, width, maxLines = 3) {
  const per = Math.max(4, Math.floor(width / CHAR_W));
  const words = String(text == null ? "" : text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (let w of words) {
    while (w.length > per) { // a word longer than the line: break it
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(w.slice(0, per));
      w = w.slice(per);
    }
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= per) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = (last.length >= per ? last.slice(0, per - 1) : last) + "…";
    return kept;
  }
  return lines.length ? lines : [""];
}

function sizeOf(n, boxW) {
  const shape = n.shape || "rect";
  const textW = shape === "diamond" ? boxW * 0.62 : boxW - PAD_X * 2;
  const lines = wrapText(n.label, textW, shape === "diamond" ? 3 : 3);
  const subLines = n.sub ? wrapText(n.sub, textW, 2) : [];
  let h = PAD_Y * 2 + lines.length * LINE_H + (subLines.length ? subLines.length * 13 + 2 : 0);
  if (shape === "diamond") h = Math.max(h * 1.7, 70);
  if (shape === "pill") h = Math.max(h, 34);
  return {w: boxW, h: Math.round(h), lines, subLines};
}

export function layoutGraph(graph, {dir = "TB", boxW = 190, gapX = 36, gapY = 58, margin = 16} = {}) {
  const nodes = (graph.nodes || []).filter((n, i, a) => n && n.id != null && a.findIndex(x => x.id === n.id) === i);
  const ids = new Set(nodes.map(n => n.id));
  const edges = (graph.edges || []).filter(e => e && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (!nodes.length) return {width: 0, height: 0, dir, nodes: [], edges: []};

  // Boxes with no arrows would all land in the first layer as one long
  // column: lay out the connected part, then put the rest in a grid below.
  const linked = new Set(edges.flatMap(e => [e.from, e.to]));
  const loose = nodes.filter(n => !linked.has(n.id));
  if (loose.length > 1) {
    const main = loose.length < nodes.length
      ? layoutGraph({nodes: nodes.filter(n => linked.has(n.id)), edges}, {dir, boxW, gapX, gapY, margin})
      : {width: 0, height: 0, nodes: [], edges: []};
    const cellW = boxW + 24;
    const cols = Math.max(2, Math.min(6, Math.floor(Math.max(main.width, 4 * cellW) / cellW)));
    const sized = loose.map(n => ({n, s: sizeOf(n, boxW)}));
    const rowH = [];
    sized.forEach((x, i) => { const r = Math.floor(i / cols); rowH[r] = Math.max(rowH[r] || 0, x.s.h); });
    let y = main.height ? main.height + 10 : margin;
    const rowY = rowH.map(hh => { const at = y; y += hh + 18; return at; });
    const grid = sized.map((x, i) => ({...x.n, x: margin + (i % cols) * cellW, y: rowY[Math.floor(i / cols)],
      w: x.s.w, h: x.s.h, lines: x.s.lines, subLines: x.s.subLines}));
    return {width: Math.max(main.width, margin * 2 + cols * cellW), height: Math.round(y - 18 + margin), dir,
      nodes: [...main.nodes, ...grid], edges: main.edges};
  }

  // 1. Back edges (cycles) by DFS in input order; they are laid out reversed.
  const out = new Map(nodes.map(n => [n.id, []]));
  edges.forEach((e, i) => out.get(e.from).push(i));
  const state = new Map();
  const back = new Set();
  const visit = id => {
    state.set(id, 1);
    for (const i of out.get(id)) {
      const t = edges[i].to;
      if (state.get(t) === 1) back.add(i);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
  };
  const hasIn = new Set(edges.map(e => e.to));
  for (const n of nodes) if (!hasIn.has(n.id) && !state.get(n.id)) visit(n.id);
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);
  const fwd = edges.map((e, i) => (back.has(i) ? {from: e.to, to: e.from} : {from: e.from, to: e.to}));

  // 2. Layers: longest path from the sources.
  const layer = new Map(nodes.map(n => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of fwd) {
      if (layer.get(e.to) < layer.get(e.from) + 1) { layer.set(e.to, layer.get(e.from) + 1); changed = true; }
    }
    if (!changed) break;
  }

  // 3. Waypoints for edges that skip layers.
  const vnodes = nodes.map(n => ({id: n.id, real: true}));
  const vlayer = new Map(layer);
  const segs = []; // [fromId, toId] between adjacent layers
  const chains = edges.map(() => []);
  fwd.forEach((e, i) => {
    let prev = e.from;
    const chain = [e.from];
    for (let l = layer.get(e.from) + 1; l < layer.get(e.to); l++) {
      const d = `~${i}~${l}`;
      vnodes.push({id: d, real: false});
      vlayer.set(d, l);
      segs.push([prev, d]);
      chain.push(d);
      prev = d;
    }
    segs.push([prev, e.to]);
    chain.push(e.to);
    chains[i] = chain;
  });

  // 4. Order within layers: input order, then barycenter sweeps.
  const maxL = Math.max(...vlayer.values());
  const layers = Array.from({length: maxL + 1}, () => []);
  for (const v of vnodes) layers[vlayer.get(v.id)].push(v.id);
  const pos = new Map();
  const reindex = () => layers.forEach(L => L.forEach((id, i) => pos.set(id, i)));
  reindex();
  const ups = new Map(); const downs = new Map();
  for (const [a, b] of segs) {
    (downs.get(a) || downs.set(a, []).get(a)).push(b);
    (ups.get(b) || ups.set(b, []).get(b)).push(a);
  }
  const bary = (id, nb) => {
    const list = nb.get(id) || [];
    return list.length ? list.reduce((s, x) => s + pos.get(x), 0) / list.length : pos.get(id);
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    if (sweep % 2 === 0) for (let l = 1; l <= maxL; l++) layers[l].sort((a, b) => bary(a, ups) - bary(b, ups) || pos.get(a) - pos.get(b));
    else for (let l = maxL - 1; l >= 0; l--) layers[l].sort((a, b) => bary(a, downs) - bary(b, downs) || pos.get(a) - pos.get(b));
    reindex();
  }

  // 5. Sizes and coordinates. "Across" = x for TB (y for LR), "along" = the layer axis.
  const size = new Map();
  for (const n of nodes) size.set(n.id, sizeOf(n, boxW));
  const across = id => (size.has(id) ? (dir === "TB" ? size.get(id).w : size.get(id).h) : 8);
  const alongSize = id => (size.has(id) ? (dir === "TB" ? size.get(id).h : size.get(id).w) : 0);
  const gapAcross = dir === "TB" ? gapX : 22;
  const gapAlong = dir === "TB" ? gapY : 70;
  const c = new Map(); // centre on the across axis
  for (const L of layers) {
    let x = 0;
    for (const id of L) { c.set(id, x + across(id) / 2); x += across(id) + gapAcross; }
  }
  // Pull boxes toward their neighbours' average, keep order and spacing.
  const settle = (L, nb) => {
    const want = L.map(id => {
      const list = nb.get(id) || [];
      return list.length ? list.reduce((s, x) => s + c.get(x), 0) / list.length : c.get(id);
    });
    for (let i = 0; i < L.length; i++) c.set(L[i], want[i]);
    for (let i = 1; i < L.length; i++) {
      const min = c.get(L[i - 1]) + across(L[i - 1]) / 2 + gapAcross + across(L[i]) / 2;
      if (c.get(L[i]) < min) c.set(L[i], min);
    }
    for (let i = L.length - 2; i >= 0; i--) {
      const max = c.get(L[i + 1]) - across(L[i + 1]) / 2 - gapAcross - across(L[i]) / 2;
      if (c.get(L[i]) > max) c.set(L[i], max);
    }
    for (let i = 1; i < L.length; i++) { // the backward pass may squeeze; re-space
      const min = c.get(L[i - 1]) + across(L[i - 1]) / 2 + gapAcross + across(L[i]) / 2;
      if (c.get(L[i]) < min) c.set(L[i], min);
    }
  };
  for (let it = 0; it < 3; it++) {
    for (let l = 1; l <= maxL; l++) settle(layers[l], ups);
    for (let l = maxL - 1; l >= 0; l--) settle(layers[l], downs);
  }
  let minC = Infinity;
  for (const L of layers) for (const id of L) minC = Math.min(minC, c.get(id) - across(id) / 2);
  const shift = margin - minC;
  // Layer positions on the along axis.
  const layerStart = [];
  let a = margin;
  for (const L of layers) {
    layerStart.push(a);
    a += Math.max(0, ...L.map(alongSize)) + gapAlong;
  }
  const layerDepth = layers.map(L => Math.max(0, ...L.map(alongSize)));
  const backLanes = [...back].length;
  const laneGap = 14;

  const placed = new Map();
  for (const n of nodes) {
    const s = size.get(n.id);
    const l = vlayer.get(n.id);
    const cc = c.get(n.id) + shift;
    const along0 = layerStart[l] + (layerDepth[l] - alongSize(n.id)) / 2;
    const box = dir === "TB"
      ? {x: Math.round(cc - s.w / 2), y: Math.round(along0)}
      : {x: Math.round(along0), y: Math.round(cc - s.h / 2)};
    placed.set(n.id, {...n, ...box, w: s.w, h: s.h, lines: s.lines, subLines: s.subLines});
  }
  let maxX = 0; let maxY = 0;
  for (const p of placed.values()) { maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); }

  // 6. Edges as elbows through their waypoints.
  const point = id => {
    if (placed.has(id)) return null;
    const l = vlayer.get(id);
    const cc = c.get(id) + shift;
    const mid = layerStart[l] + layerDepth[l] / 2;
    return dir === "TB" ? [Math.round(cc), Math.round(mid)] : [Math.round(mid), Math.round(cc)];
  };
  const exitOf = p => (dir === "TB" ? [p.x + p.w / 2, p.y + p.h] : [p.x + p.w, p.y + p.h / 2]);
  const entryOf = p => (dir === "TB" ? [p.x + p.w / 2, p.y] : [p.x, p.y + p.h / 2]);
  let lane = 0;
  const outEdges = edges.map((e, i) => {
    const s = placed.get(e.from);
    const t = placed.get(e.to);
    if (back.has(i)) {
      // Around the far side: out of the source's side, along a lane, into the target's side.
      lane++;
      if (dir === "TB") {
        const x = maxX + 18 + lane * laneGap;
        const pts = [[s.x + s.w, s.y + s.h / 2], [x, s.y + s.h / 2], [x, t.y + t.h / 2], [t.x + t.w, t.y + t.h / 2]];
        return {...e, back: true, points: pts.map(r => r.map(Math.round)), labelAt: [x + 4, (s.y + t.y + t.h) / 2]};
      }
      const y = maxY + 18 + lane * laneGap;
      const pts = [[s.x + s.w / 2, s.y + s.h], [s.x + s.w / 2, y], [t.x + t.w / 2, y], [t.x + t.w / 2, t.y + t.h]];
      return {...e, back: true, points: pts.map(r => r.map(Math.round)), labelAt: [(s.x + t.x + t.w) / 2, y - 4]};
    }
    const via = chains[i].slice(1, -1).map(point);
    const pts = [exitOf(s)];
    const target = entryOf(t);
    const stops = [...via, target];
    let cur = pts[0];
    for (const p of stops) {
      if (dir === "TB") {
        const midY = p === target && !via.length ? (cur[1] + p[1]) / 2 : p === target ? p[1] - gapAlong / 2 : p[1];
        if (cur[0] !== p[0]) { pts.push([cur[0], midY]); pts.push([p[0], midY]); }
        pts.push(p);
      } else {
        const midX = p === target && !via.length ? (cur[0] + p[0]) / 2 : p === target ? p[0] - gapAlong / 2 : p[0];
        if (cur[1] !== p[1]) { pts.push([midX, cur[1]]); pts.push([midX, p[1]]); }
        pts.push(p);
      }
      cur = p;
    }
    const clean = pts.map(r => r.map(Math.round)).filter((p, k, arr) => !k || p[0] !== arr[k - 1][0] || p[1] !== arr[k - 1][1]);
    // Label near the start of the edge, on its first long segment.
    const a0 = clean[0];
    const a1 = clean[Math.min(1, clean.length - 1)];
    const labelAt = dir === "TB" ? [a0[0] + 6, Math.round((a0[1] + a1[1]) / 2) + 4] : [Math.round((a0[0] + a1[0]) / 2), a0[1] - 6];
    return {...e, back: false, points: clean, labelAt};
  });
  const width = Math.round(maxX + margin + (dir === "TB" && backLanes ? 18 + (backLanes + 1) * laneGap : 0) + 60);
  const height = Math.round(maxY + margin + (dir === "LR" && backLanes ? 18 + (backLanes + 1) * laneGap : 0));
  return {width, height, dir, nodes: [...placed.values()], edges: outEdges};
}

// True when no two boxes overlap (used by tests and as a sanity check).
export function noOverlap(layout) {
  const n = layout.nodes;
  for (let i = 0; i < n.length; i++) {
    for (let j = i + 1; j < n.length; j++) {
      const a = n[i]; const b = n[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
    }
  }
  return true;
}
