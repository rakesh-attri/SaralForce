// SVG for a layoutGraph() result. One renderer for the panel and for the
// HTML download, so both look the same. All text is escaped: labels come
// from org metadata. Boxes carry data-node so the panel can make them
// clickable by event delegation.

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Colours per kind of box: [fill, stroke, text].
export const DIAGRAM_KINDS = {
  object: {label: "Object", light: ["#e8f1fb", "#2f6fbf", "#123a66"], dark: ["#1b2c44", "#5d9be0", "#d6e6fb"]},
  trigger: {label: "Trigger", light: ["#fdeee7", "#d4622a", "#6b2a0b"], dark: ["#3a2419", "#f08a55", "#fbdccb"]},
  flow: {label: "Flow", light: ["#e9f7ef", "#2e9a5c", "#11482a"], dark: ["#173226", "#5fcf8f", "#d2f3e0"]},
  class: {label: "Apex class", light: ["#f1ecfb", "#7a52c7", "#3a1f72"], dark: ["#2a2142", "#a98af0", "#e6dcfb"]},
  lwc: {label: "LWC", light: ["#e6f7f8", "#1f9aa6", "#0d4a50"], dark: ["#14343a", "#4fcbd6", "#cdf1f4"]},
  aura: {label: "Aura", light: ["#fbf3e1", "#c08a12", "#5c4106"], dark: ["#382d14", "#e5b440", "#f6e6c0"]},
  rule: {label: "Validation rule", light: ["#fdecef", "#c8374f", "#5f1120"], dark: ["#3b1b22", "#ef6f85", "#f8d3da"]},
  page: {label: "Page / app", light: ["#eef0f4", "#6b7385", "#2a2f3a"], dark: ["#262a33", "#9aa3b5", "#e3e6ec"]},
  start: {label: "Start / end", light: ["#e9f7ef", "#2e9a5c", "#11482a"], dark: ["#173226", "#5fcf8f", "#d2f3e0"]},
  step: {label: "Step", light: ["#ffffff", "#7b8597", "#1f2532"], dark: ["#1f232c", "#8a94a8", "#e3e7ee"]},
  decision: {label: "Decision", light: ["#fff7e0", "#c9971a", "#5c4106"], dark: ["#3a3016", "#e5b440", "#f6e6c0"]},
  data: {label: "Record step", light: ["#e8f1fb", "#2f6fbf", "#123a66"], dark: ["#1b2c44", "#5d9be0", "#d6e6fb"]},
  call: {label: "Subflow / Apex / action", light: ["#f1ecfb", "#7a52c7", "#3a1f72"], dark: ["#2a2142", "#a98af0", "#e6dcfb"]},
  error: {label: "Error", light: ["#fdecef", "#c8374f", "#5f1120"], dark: ["#3b1b22", "#ef6f85", "#f8d3da"]},
};

const EDGE = {light: {line: "#7b8597", text: "#4b5466", fault: "#c8374f", bg: "#ffffff"}, dark: {line: "#8a94a8", text: "#c3cad6", fault: "#ef6f85", bg: "#171a21"}};

function shapePath(n) {
  const {x, y, w, h} = n;
  switch (n.shape) {
    case "diamond":
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"`;
    case "data": {
      const k = 12;
      return `<polygon points="${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}"`;
    }
    case "pill":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"`;
    case "cylinder":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"`;
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${n.shape === "round" ? 10 : 5}"`;
  }
}

function arrowPath(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
}

// layout: from layoutGraph. opts: {theme: "light"|"dark", title, clickable: Set|fn(id)}.
export function diagramSvg(layout, {theme = "light", title = "", clickable = null} = {}) {
  const t = theme === "dark" ? "dark" : "light";
  const ec = EDGE[t];
  const uid = "d" + Math.abs([...(title || "") + layout.width + layout.height].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)).toString(36);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="og-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${esc(title || "Diagram")}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`);
  parts.push(`<defs><marker id="${uid}a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${ec.line}"/></marker>` +
    `<marker id="${uid}f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${ec.fault}"/></marker></defs>`);
  if (title) parts.push(`<title>${esc(title)}</title>`);
  // Edges first so boxes sit on top.
  for (const e of layout.edges) {
    const fault = e.kind === "fault";
    const color = fault ? ec.fault : ec.line;
    const dash = fault || e.back || e.kind === "dashed" ? ` stroke-dasharray="${fault ? "5 4" : "4 4"}"` : "";
    parts.push(`<path d="${arrowPath(e.points)}" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#${uid}${fault ? "f" : "a"})"/>`);
  }
  for (const e of layout.edges) {
    if (!e.label) continue;
    const text = String(e.label).length > 46 ? String(e.label).slice(0, 45) + "…" : String(e.label);
    const w = Math.round(text.length * 5.9 + 8);
    const [lx, ly] = e.labelAt;
    const anchorX = layout.dir === "LR" ? lx - w / 2 : lx;
    parts.push(`<g class="og-elabel"><rect x="${Math.round(anchorX - 2)}" y="${ly - 11}" width="${w}" height="15" rx="3" fill="${ec.bg}" opacity="0.92"/>` +
      `<text x="${Math.round(anchorX + 2)}" y="${ly}" font-size="10.5" fill="${e.kind === "fault" ? ec.fault : ec.text}">${esc(text)}</text></g>`);
  }
  for (const n of layout.nodes) {
    const kind = DIAGRAM_KINDS[n.kind] || DIAGRAM_KINDS.step;
    const [fill, stroke, color] = kind[t];
    const canClick = clickable && (typeof clickable === "function" ? clickable(n.id) : clickable.has(n.id));
    const attrs = canClick ? ` data-node="${esc(n.id)}" style="cursor:pointer" tabindex="0" role="button"` : "";
    parts.push(`<g class="og-node"${attrs}><title>${esc([n.label, n.sub].filter(Boolean).join(" — "))}</title>`);
    parts.push(`${shapePath(n)} fill="${fill}" stroke="${stroke}" stroke-width="${n.emphasis ? 2.6 : 1.5}"/>`);
    if (n.double) {
      parts.push(`<rect x="${n.x + 4}" y="${n.y + 4}" width="${n.w - 8}" height="${n.h - 8}" rx="3" fill="none" stroke="${stroke}" stroke-width="1"/>`);
    }
    const total = n.lines.length * 15 + (n.subLines.length ? n.subLines.length * 13 + 2 : 0);
    let y = n.y + (n.h - total) / 2 + 12;
    for (const line of n.lines) {
      parts.push(`<text x="${n.x + n.w / 2}" y="${Math.round(y)}" text-anchor="middle" font-size="12" font-weight="600" fill="${color}">${esc(line)}</text>`);
      y += 15;
    }
    if (n.subLines.length) y += 2;
    for (const line of n.subLines) {
      parts.push(`<text x="${n.x + n.w / 2}" y="${Math.round(y - 1)}" text-anchor="middle" font-size="10.5" fill="${color}" opacity="0.8">${esc(line)}</text>`);
      y += 13;
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("");
}

// Kinds used in a layout, for the legend under a diagram.
export function legendKinds(layout) {
  const seen = [];
  for (const n of layout.nodes) if (DIAGRAM_KINDS[n.kind] && !seen.includes(n.kind)) seen.push(n.kind);
  return seen.map(k => ({kind: k, label: DIAGRAM_KINDS[k].label, colors: DIAGRAM_KINDS[k]}));
}
