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

export {sadTypeGlyph, sadInfoCell, FFBadge};
