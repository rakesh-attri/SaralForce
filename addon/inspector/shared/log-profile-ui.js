// Logs → a log → Profile: where the time went, queries and DML in loops,
// limits, and an AI suggestion based on the summary (never the raw log).
import {parseProfile, profileForPrompt} from "../../core/log-profile.js";
import {explainLogProfile} from "./ai.js";
import {FFBadge} from "./ui.js";

const h = React.createElement;

function Tile({label, value, tone}) {
  return h("div", {className: "lp-tile" + (tone ? " lp-" + tone : "")},
    h("div", {className: "lp-tile-v"}, value),
    h("div", {className: "lp-tile-l"}, label));
}

function fmtMs(n) {
  if (n >= 1000) return (n / 1000).toFixed(2) + " s";
  return (Math.round(n * 10) / 10) + " ms";
}

const KIND = {unit: "Code unit", method: "Method", soql: "SOQL", dml: "DML", callout: "Callout", flow: "Flow"};

export function LogProfileView({text}) {
  const p = React.useMemo(() => parseProfile(text), [text]);
  const [sortBy, setSortBy] = React.useState("self");
  const [ai, setAi] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const cpu = p.limits.find(l => /CPU time/i.test(l.name));
  const soqlLimit = p.limits.find(l => /SOQL queries/i.test(l.name));
  const methods = sortBy === "self" ? p.topSelf : p.topTotal;

  const ask = async () => {
    setBusy(true); setErr("");
    try { setAi(await explainLogProfile(profileForPrompt(p))); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  if (!p.timeline.length && !p.counts.soql && !p.counts.dml) {
    return h("div", {className: "insp-hint-strip"},
      "This log has no timing events to profile. Set Apex Code to FINE (or Apex Profiling to INFO) on the trace flag and run it again.");
  }
  return h("div", {className: "lp"},
    h("div", {className: "lp-tiles"},
      h(Tile, {label: "Total time", value: fmtMs(p.totalMs)}),
      h(Tile, {label: "CPU", value: cpu ? `${cpu.used} / ${cpu.max} ms` : "—", tone: cpu && cpu.pct >= 70 ? "bad" : ""}),
      h(Tile, {label: "SOQL", value: soqlLimit ? `${soqlLimit.used} / ${soqlLimit.max}` : p.counts.soql, tone: soqlLimit && soqlLimit.pct >= 70 ? "bad" : ""}),
      h(Tile, {label: "DML", value: p.counts.dml}),
      h(Tile, {label: "Callouts", value: p.counts.callouts}),
      h(Tile, {label: "Method calls", value: p.counts.methods})),
    h("div", {className: "lp-section"},
      h("div", {className: "lp-h"}, "Hot spots",
        h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: ask, title: "Sends the summary below to AI, not the log"},
          busy ? "Thinking…" : "✨ How to speed this up")),
      p.insights.length
        ? h("ul", {className: "rel-checks"}, p.insights.map((i, k) => h("li", {key: k, className: "rel-check rel-check-" + i.level},
          (i.level === "err" ? "⛔ " : i.level === "warn" ? "⚠ " : "ℹ ") + i.text,
          i.query && h("code", {className: "lp-q"}, i.query))))
        : h("div", {className: "insp-meta"}, "No hot spots: no repeated queries or DML, and limits are fine."),
      err && h("div", {className: err === "NO_LLM_CONFIG" ? "insp-warn" : "insp-error"}, err === "NO_LLM_CONFIG" ? "Add an AI provider key in Settings to use this." : "AI request failed: " + err),
      ai && h("div", {className: "rel-ai"}, h("div", {className: "rel-ai-h"}, h("span", null, "✨ Suggestions")), h("div", {className: "rel-ai-body"}, ai))),
    h("div", {className: "lp-section"},
      h("div", {className: "lp-h"}, "Timeline"),
      h("div", {className: "lp-timeline"}, p.timeline.map((r, k) => h("div", {key: k, className: "lp-row", title: `${KIND[r.kind] || r.kind} · ${r.name}${r.line ? ` · line ${r.line}` : ""} · ${fmtMs(r.ms)}`},
        h("div", {className: "lp-label", style: {paddingLeft: Math.min(r.depth, 8) * 10 + "px"}},
          h("span", {className: "lp-kind lp-k-" + r.kind}, KIND[r.kind] || r.kind), " ", r.name),
        h("div", {className: "lp-track"},
          h("div", {className: "lp-bar lp-k-" + r.kind, style: {left: r.left + "%", width: Math.min(r.width, 100 - r.left) + "%"}})),
        h("div", {className: "lp-ms"}, fmtMs(r.ms)))))),
    h("div", {className: "lp-grid"},
      h("div", {className: "lp-section"},
        h("div", {className: "lp-h"}, "Slowest methods",
          h("div", {className: "lp-seg"},
            ["self", "total"].map(k => h("button", {key: k, className: "insp-chip rel-chip" + (sortBy === k ? " on" : ""), onClick: () => setSortBy(k)},
              k === "self" ? "Own time" : "Total time")))),
        h("div", {className: "insp-table-wrap"}, h("table", {className: "insp-table"},
          h("thead", null, h("tr", null, h("th", null, "Method"), h("th", null, "Calls"), h("th", null, "Own"), h("th", null, "Total"))),
          h("tbody", null, methods.map(m => h("tr", {key: m.name},
            h("td", {className: "rel-name", title: m.name}, m.name), h("td", null, m.calls), h("td", null, fmtMs(m.self)), h("td", null, fmtMs(m.total)))))))),
      h("div", {className: "lp-section"},
        h("div", {className: "lp-h"}, `Queries (${p.counts.soql})`),
        p.soql.length ? h("div", {className: "insp-table-wrap"}, h("table", {className: "insp-table"},
          h("thead", null, h("tr", null, h("th", null, "Query"), h("th", null, "Line"), h("th", null, "Times"), h("th", null, "Rows"), h("th", null, "Time"))),
          h("tbody", null, p.soql.slice(0, 50).map((q, k) => h("tr", {key: k, className: q.times >= 3 ? "lp-hot" : ""},
            h("td", {className: "rel-name", title: q.query}, q.query), h("td", null, q.line || ""),
            h("td", null, q.times >= 3 ? h(FFBadge, {kind: "warn"}, q.times + "×") : q.times), h("td", null, q.rows), h("td", null, fmtMs(q.ms)))))))
          : h("div", {className: "insp-meta"}, "No queries."))),
    (p.dml.length > 0 || p.callouts.length > 0) && h("div", {className: "lp-grid"},
      p.dml.length > 0 && h("div", {className: "lp-section"},
        h("div", {className: "lp-h"}, `DML (${p.counts.dml})`),
        h("div", {className: "insp-table-wrap"}, h("table", {className: "insp-table"},
          h("thead", null, h("tr", null, h("th", null, "Operation"), h("th", null, "Line"), h("th", null, "Times"), h("th", null, "Rows"), h("th", null, "Time"))),
          h("tbody", null, p.dml.slice(0, 50).map((d, k) => h("tr", {key: k, className: d.times >= 3 ? "lp-hot" : ""},
            h("td", null, `${d.op} ${d.type}`), h("td", null, d.line || ""),
            h("td", null, d.times >= 3 ? h(FFBadge, {kind: "warn"}, d.times + "×") : d.times), h("td", null, d.rows), h("td", null, fmtMs(d.ms)))))))),
      p.callouts.length > 0 && h("div", {className: "lp-section"},
        h("div", {className: "lp-h"}, `Callouts (${p.counts.callouts})`),
        h("div", {className: "insp-table-wrap"}, h("table", {className: "insp-table"},
          h("thead", null, h("tr", null, h("th", null, "Endpoint"), h("th", null, "Status"), h("th", null, "Time"))),
          h("tbody", null, p.callouts.slice(0, 50).map((c, k) => h("tr", {key: k},
            h("td", {className: "rel-name", title: c.endpoint}, c.endpoint), h("td", null, c.status), h("td", null, fmtMs(c.ms))))))))),
    p.limits.length > 0 && h("div", {className: "lp-section"},
      h("div", {className: "lp-h"}, "Limits"),
      h("div", {className: "lp-limits"}, p.limits.filter(l => l.used > 0).map(l => h("div", {key: l.name, className: "lp-limit"},
        h("div", {className: "lp-limit-h"}, h("span", null, l.name), h("span", {className: "insp-meta"}, `${l.used} / ${l.max}`)),
        h("div", {className: "limit-bar"}, h("div", {className: "limit-fill" + (l.pct >= 80 ? " crit" : l.pct >= 50 ? " warn" : ""), style: {width: Math.min(100, l.pct) + "%"}})))))));
}
