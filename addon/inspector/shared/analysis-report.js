const h = React.createElement;

// Split an AI analysis into "SECTION NAME" + body blocks so each section can
// be colour-coded. Tolerates numbering/markdown emphasis around the heading.
// Returns [] when nothing heading-like is found.
function parseAnalysisSections(text) {
  const src = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  const out = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const t = line.trim()
      .replace(/^[#*\s]+/, "")
      .replace(/[*#\s:]+$/, "");
    const isHeading = /^[A-Z][A-Z0-9 &/()-]{1,48}$/.test(t) && /[A-Z]{2}/.test(t);
    if (isHeading) {
      if (cur) out.push(cur);
      cur = {heading: t, body: []};
    } else if (cur) {
      cur.body.push(line);
    } else {
      cur = {heading: "", body: [line]};
    }
  }
  if (cur) out.push(cur);
  return out
    .map(s => ({heading: s.heading, body: s.body.join("\n").trim()}))
    .filter(s => s.heading || s.body);
}

// Map a section heading to its colour family.
function analysisSectionKind(heading) {
  const h = String(heading || "").toUpperCase();
  if (h.includes("ERROR") || h.includes("ISSUE") || h.includes("FAIL")) return "err";
  if (h.includes("NEXT") || h.includes("ACTION")) return "next";
  if (h.includes("DEBUG") || h.includes("HIGHLIGHT") || h.includes("DETAIL")) return "debug";
  if (h.includes("HAPPEN") || h.includes("SUMMARY") || h.includes("OVERVIEW")) return "info";
  return "plain";
}

// Colour-coded card for the AI Quick Analysis response. Errors render red
// (green "None." when there are none), NEXT STEP teal, DEBUG HIGHLIGHTS
// purple, WHAT HAPPENED blue; unknown sections get a neutral tint.
function AnalysisReport({text, copied, onCopy}) {
  const secs = parseAnalysisSections(text);
  const iconFor = {info: "📋", err: "⚠️", next: "🧭", debug: "🔍", plain: "📄"};
  return h("div", {className: "ai-report"},
    secs.length
      ? secs.map((s, i) => {
          const kind = analysisSectionKind(s.heading);
          const noneOk = kind === "err" && /^(none|no errors?|nil|n\/a)\.?$/i.test(s.body);
          const cls = noneOk ? "ok" : kind;
          return h("div", {key: i, className: `ai-sec ai-sec-${cls}`},
            s.heading && h("div", {className: "ai-sec-h"},
              `${noneOk ? "✅" : (iconFor[kind] || "📄")} ${s.heading}`),
            h("div", {className: "ai-sec-body"}, s.body || (noneOk ? "None." : "—"))
          );
        })
      : h("div", {className: "ai-sec ai-sec-plain"},
          h("div", {className: "ai-sec-body"}, text)),
    h("button", {
      className: copied ? "field-action-btn btn-ok" : "field-action-btn",
      style: {marginTop: "2px", alignSelf: "flex-start"},
      onClick: onCopy
    }, copied ? "Copied ✓" : "Copy")
  );
}

export {AnalysisReport};
