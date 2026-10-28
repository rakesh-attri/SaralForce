const h = React.createElement;

// ─── Shared stroke icons (SOQL M3 redesign) ─────────────────────────────
// Path-only SVGs: no text nodes, so card innerText stays clean.
function ffIcon(paths, s) {
  return h("svg", {width: s || 15, height: s || 15, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: 1.9,
    strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
    ...paths);
}
const FF_I_DB = [h("path", {d: "M12 3c4.4 0 8 1.1 8 2.5S16.4 8 12 8 4 6.9 4 5.5 7.6 3 12 3z"}),
  h("path", {d: "M4 5.5V18.5C4 19.9 7.6 21 12 21s8-1.1 8-2.5V5.5"}),
  h("path", {d: "M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"})];
const FF_I_CLOCK = [h("circle", {cx: 12, cy: 12, r: 8.5}),
  h("path", {d: "M12 7.5V12l3 2"})];
const FF_I_BOOKMARK = [h("path", {d: "M7 4h10v16l-5-4-5 4z"})];
const FF_I_SLIDERS = [h("path", {d: "M4 7h16"}), h("circle", {cx: 9, cy: 7, r: 2}),
  h("path", {d: "M4 12h16"}), h("circle", {cx: 15, cy: 12, r: 2}),
  h("path", {d: "M4 17h16"}), h("circle", {cx: 8, cy: 17, r: 2})];
const FF_I_DOWNLOAD = [h("path", {d: "M12 4v11"}), h("path", {d: "M7 11l5 5 5-5"}),
  h("path", {d: "M5 20h14"})];
const FF_I_DOC = [h("path", {d: "M7 3h7l4 4v14H7z"}), h("path", {d: "M14 3v4h4"})];
const FF_I_ZAP = [h("path", {d: "M13 2L4 14h6l-1 8 9-12h-6z"})];

export {ffIcon, FF_I_DB, FF_I_CLOCK, FF_I_BOOKMARK, FF_I_SLIDERS, FF_I_DOWNLOAD, FF_I_DOC, FF_I_ZAP};
