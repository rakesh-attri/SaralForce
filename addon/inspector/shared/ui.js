import {friendlyError} from "../../core/friendly-error.js";
import {emptyArtSvg} from "./empty-art.js";

const h = React.createElement;

// "Show all data" field-type glyph: a plain text marker, never an emoji.
function sadTypeGlyph(t) {
  const s = String(t || "").toLowerCase();
  if (["int", "double", "currency", "percent", "number"].includes(s)) return "#";
  if (["date", "datetime", "time"].includes(s)) return "◷";
  if (s === "boolean") return "✓";
  if (s === "picklist" || s === "multipicklist") return "☰";
  if (s === "address" || s === "location") return "◎";
  if (["base64", "anytype", "json", "complexvalue"].includes(s)) return "❖";
  return "Aa";
}

function sadInfoCell(label, value) {
  return h("div", {className: "sad-info-cell"},
    h("div", {className: "sad-info-l"}, label),
    h("div", {className: "sad-info-v"}, value));
}

function FFBadge({kind, children}) {
  return h("span", {className: "ff-badge ff-badge-" + (kind || "info")}, children);
}

// A Salesforce error in plain words: title, what to do, raw text folded away.
function FriendlyError({error, className = ""}) {
  if (!error) return null;
  const e = friendlyError(error);
  return h("div", {className: "insp-error fe-box " + className, role: "alert"},
    h("div", {className: "fe-title"}, "⚠️ " + e.title),
    e.hint && h("div", {className: "fe-hint"}, e.hint),
    e.detail && (e.hint ? h("details", {className: "fe-details"},
      h("summary", null, "Details from Salesforce"),
      h("code", null, e.detail)) : h("div", {className: "fe-hint"}, e.detail)));
}

// A blank pane with a small illustration, a title and what to do next.
// The SVG is a fixed string from empty-art.js, never user text.
function EmptyState({art = "table", title, text, children, compact = false, className = ""}) {
  return h("div", {className: "empty-state" + (compact ? " compact" : "") + (className ? " " + className : "")},
    h("svg", {className: "empty-art", viewBox: "0 0 160 120", width: compact ? 112 : 150, height: compact ? 84 : 112,
      role: "img", "aria-hidden": "true", focusable: "false", dangerouslySetInnerHTML: {__html: emptyArtSvg(art)}}),
    title && h("div", {className: "empty-title"}, title),
    text && h("div", {className: "empty-text"}, text),
    children);
}

export {sadTypeGlyph, sadInfoCell, FFBadge, FriendlyError, EmptyState};
