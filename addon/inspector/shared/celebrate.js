import {getCelebrateVariant} from "../../llm/llm-service.js";

const h = React.createElement;

// ─── Shared code-editor pieces (SOQL + Apex tabs) ─────────────────────
// Success celebration: a paper plane (default) arcs across the editor after
// a run succeeds. Purely visual — pointer-events:none, aria-hidden, keyed so
// it plays exactly once per success and unmounts on animationend. The variant
// (plane | confetti) is read fresh from Settings → Preferences in options.html.
const CONFETTI_COLORS = ["#22a7f0", "#f59e0b", "#a855f7", "#22c555", "#eab308", "#ec4899"];

function Celebrate({seq, onDone}) {
  if (!seq) return null;
  const variant = getCelebrateVariant();
  return h("div", {
    key: seq,
    className: "code-celebrate",
    "aria-hidden": "true",
    onAnimationEnd: e => { if (e.target === e.currentTarget) onDone(); }
  },
    variant === "confetti"
      ? Array.from({length: 16}, (_, i) =>
          h("span", {
            key: i,
            className: "cc-chip",
            style: {"--i": i, background: CONFETTI_COLORS[i % CONFETTI_COLORS.length]}
          }))
      : variant === "thor"
      ? [h("div", {key: "flash", className: "cc-flash"}),
          h("svg", {key: "hammer", className: "cc-hammer", width: 54, height: 84,
            viewBox: "0 0 60 92", "aria-hidden": "true"},
            h("rect", {x: 26, y: 30, width: 8, height: 52, rx: 3, fill: "#92400e"}),
            h("rect", {x: 22, y: 78, width: 16, height: 7, rx: 3, fill: "#57534e"}),
            h("rect", {x: 8, y: 6, width: 44, height: 26, rx: 4, fill: "#94a3b8"}),
            h("rect", {x: 8, y: 6, width: 44, height: 8, rx: 4, fill: "#cbd5e1"}),
            h("rect", {x: 24, y: 6, width: 12, height: 26, fill: "#64748b"})),
          h("div", {key: "shake", className: "cc-shake"},
            ...[0, 1, 2].map(i =>
              h("span", {key: "w" + i, className: "cc-shock", style: {"--i": i}})),
            ...Array.from({length: 12}, (_, i) =>
              h("span", {key: "p" + i, className: "cc-spark",
                style: {"--i": i, background: ["#f8fafc", "#67e8f9", "#fbbf24"][i % 3]}}))),
          h("div", {key: "boom", className: "cc-boom"})]
      : variant === "spidey"
      ? [...[0, 1, 2].map(i =>
            h("span", {key: "r" + i, className: "cc-ring", style: {"--i": i}})),
          ...Array.from({length: 8}, (_, i) =>
            h("span", {key: "s" + i, className: "cc-strand", style: {"--i": i}})),
          ...Array.from({length: 8}, (_, i) =>
            h("span", {
              key: "d" + i,
              className: "cc-chip",
              style: {"--i": i, background: i % 2 ? "#2563eb" : "#ef4444"}
            }))]
      : h("span", {className: "cc-plane"},
          h("svg", {width: 26, height: 26, viewBox: "0 0 24 24", "aria-hidden": "true"},
            h("path", {
              d: "M2.5 11.8 L21.5 3.5 L13.6 20.8 L11 13.2 Z",
              style: {fill: "var(--tok-t, #56d4f1)", stroke: "var(--code-fg, #1e2a3d)"}
            }),
            h("path", {
              d: "M21.5 3.5 L11 13.2",
              style: {stroke: "var(--code-fg, #1e2a3d)", opacity: 0.55}
            })))
  );
}

export {Celebrate};
