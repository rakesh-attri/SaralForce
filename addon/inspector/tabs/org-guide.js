// Metadata → Org Guide: onboarding notes for this org, with diagrams.
// Pick a business area (an object) or the whole org; SaralForce reads the
// org's automation and code, draws how it fits together and, with AI on,
// adds an ELI5 note per component and a business summary.
import {hasValidConfig, getSavedConfig, LLM_PROVIDERS} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {buildGuide, eli5Batches, businessPrompt, guideToMarkdown, guideToHtml, GUIDE_TYPES, buildGuideGraph, areaRanking, flowDiagram} from "../../core/org-guide.js";
import {buildHandbook, handbookPrompt, FLOW_KIND_LABEL} from "../../core/handbook.js";
import {flowStory, simpleFlowDiagram, storyText} from "../../core/flow-story.js";
import {layoutGraph} from "../../core/diagram-layout.js";
import {diagramSvg, legendKinds} from "../../core/diagram-svg.js";
import {loadGuideData, loadHandbookExtras} from "../shared/org-guide-data.js";
import {orgGuideBusiness, orgGuideEli5} from "../shared/ai.js";
import {ffGetObjects} from "../shared/describe.js";
import {downloadText} from "../shared/csv.js";
import {EmptyState} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {confirmDialog} from "../../ui/confirm.js";
import {sfConn} from "../../inspector.js";

const h = React.createElement;

const isDark = () => {
  const el = document.documentElement;
  return el.classList.contains("dark") || el.getAttribute("data-theme") === "dark";
};

// ─── A diagram: zoom, fit, drag to pan, click a box to jump ──────────
function Diagram({graph, title, onNodeClick, linkable, maxHeight = 520}) {
  const wrapRef = React.useRef(null);
  const [zoom, setZoom] = React.useState(null); // null = fit on first paint
  const [dark, setDark] = React.useState(isDark());
  React.useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, {attributes: true, attributeFilter: ["class", "data-theme"]});
    return () => mo.disconnect();
  }, []);
  const layout = React.useMemo(() => layoutGraph(graph, {dir: graph.dir || "TB"}), [graph]);
  const svg = React.useMemo(() => {
    const clickable = id => !!linkable && linkable(id, layout.nodes.find(n => n.id === id));
    return diagramSvg(layout, {theme: dark ? "dark" : "light", title, clickable})
      .replace(`width="${layout.width}" height="${layout.height}"`, "width=\"100%\" height=\"100%\"");
  }, [layout, dark, title]);
  React.useEffect(() => {
    if (zoom != null || !wrapRef.current || !layout.width) return;
    const avail = wrapRef.current.clientWidth - 4;
    setZoom(Math.max(0.35, Math.min(1, avail / layout.width)));
  }, [layout, zoom]);
  const z = zoom || 1;
  // Drag the background to pan.
  const drag = React.useRef(null);
  const onDown = e => {
    if (e.button !== 0 || (e.target.closest && e.target.closest("[data-node]"))) return;
    const el = wrapRef.current;
    drag.current = {x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop};
    el.classList.add("og-grabbing");
  };
  React.useEffect(() => {
    const move = e => {
      if (!drag.current || !wrapRef.current) return;
      wrapRef.current.scrollLeft = drag.current.sl - (e.clientX - drag.current.x);
      wrapRef.current.scrollTop = drag.current.st - (e.clientY - drag.current.y);
    };
    const up = () => { drag.current = null; if (wrapRef.current) wrapRef.current.classList.remove("og-grabbing"); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);
  const pick = e => {
    const g = e.target.closest && e.target.closest("[data-node]");
    if (g && onNodeClick) onNodeClick(g.getAttribute("data-node"));
  };
  if (!layout.nodes.length) return h("div", {className: "insp-meta"}, "Nothing to draw.");
  return h("div", {className: "og-diagram"},
    h("div", {className: "og-dg-tools"},
      h("button", {className: "og-dg-btn", title: "Zoom out", "aria-label": "Zoom out", onClick: () => setZoom(Math.max(0.3, +(z - 0.15).toFixed(2)))}, "−"),
      h("span", {className: "og-dg-zoom"}, Math.round(z * 100) + "%"),
      h("button", {className: "og-dg-btn", title: "Zoom in", "aria-label": "Zoom in", onClick: () => setZoom(Math.min(2.5, +(z + 0.15).toFixed(2)))}, "+"),
      h("button", {className: "og-dg-btn", title: "Fit to width", onClick: () => setZoom(null)}, "Fit"),
      h("span", {className: "og-dg-legend"}, legendKinds(layout).map(k => {
        const [fill, stroke] = k.colors[dark ? "dark" : "light"];
        return h("span", {key: k.kind, className: "og-lg"}, h("i", {style: {background: fill, borderColor: stroke}}), k.label);
      }))),
    h("div", {
      ref: wrapRef, className: "og-dg-wrap", style: {maxHeight}, onMouseDown: onDown, onClick: pick,
      onKeyDown: e => { if (e.key === "Enter") pick(e); }
    },
      h("div", {className: "og-dg-canvas", style: {width: Math.round(layout.width * z), height: Math.round(layout.height * z)},
        dangerouslySetInnerHTML: {__html: svg}})));
}

// ─── AI business summary: one card per section, real bullets, **bold** ──
const BIZ_ICON = [[/WHAT|BUSINESS/, "🏢"], [/AREA/, "🗂️"], [/MOVE|FLOW|PROCESS|LIFE/, "🔄"], [/START|FIRST|BEGIN/, "🚀"]];
function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((p, i) => (/^\*\*[^*]+\*\*$/.test(p) ? h("b", {key: i}, p.slice(2, -2)) : p));
}
const BULLET = /^[-*•]\s+/;
function splitSections(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim().replace(/^[#*\s]+/, "").replace(/[*#:\s]+$/, "");
    if (/^[A-Z][A-Z0-9 &/()'-]{2,48}$/.test(t) && /[A-Z]{3}/.test(t)) { cur = {heading: t, lines: []}; out.push(cur); continue; }
    if (!raw.trim()) continue;
    if (!cur) { cur = {heading: "", lines: []}; out.push(cur); }
    cur.lines.push(raw.trim());
  }
  return out;
}
function BusinessSummary({text, copied, onCopy}) {
  const secs = splitSections(text);
  return h("div", {className: "og-biz"},
    h("div", {className: "og-biz-grid"}, secs.map((sec, i) => {
      const icon = (BIZ_ICON.find(([re]) => re.test(sec.heading)) || [null, "📄"])[1];
      const bullets = sec.lines.filter(l => BULLET.test(l));
      const paras = sec.lines.filter(l => !BULLET.test(l));
      return h("div", {key: i, className: "og-biz-card"},
        sec.heading && h("div", {className: "og-biz-h"}, h("span", {"aria-hidden": "true"}, icon), " ",
          sec.heading.charAt(0) + sec.heading.slice(1).toLowerCase()),
        paras.map((p, j) => h("p", {key: "p" + j, className: "og-p"}, inline(p))),
        bullets.length > 0 && h("ul", {className: "og-list"}, bullets.map((b, j) => h("li", {key: j}, inline(b.replace(BULLET, ""))))));
    })),
    h("button", {className: "field-action-btn", onClick: onCopy}, copied ? "Copied ✓" : "Copy"));
}

// ─── The view ────────────────────────────────────────────────────────
const TYPE_TONE = {trigger: "trigger", flow: "flow", class: "apex", lwc: "lwc", aura: "aura", rule: "rule", object: "schema"};

// The technical map: one business area (or the whole org) as components and
// how they connect. Uses the org data the Handbook already read.
function TechnicalGuide({request, getItems}) {
  const [scopeKind, setScopeKind] = useFfSession("metadata", "guideScope", "area");
  const [object, setObject] = useFfSession("metadata", "guideObject", "");
  const [guide, setGuide] = useFfSession("metadata", "guide", null);
  const [objects, setObjects] = React.useState([]);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState(null);
  const [useAi, setUseAi] = React.useState(() => hasValidConfig());
  const [copied, setCopied] = React.useState(null);
  const abortRef = React.useRef(null);
  const focusRef = React.useRef(null);
  React.useEffect(() => { ffGetObjects().then(setObjects).catch(() => setObjects([])); }, []);
  // Opened from the Handbook / Processes: build that object's map and jump to the component.
  React.useEffect(() => {
    if (!request || !request.object) return;
    setScopeKind("area");
    setObject(request.object);
    focusRef.current = request.focus || null;
    build("area", request.object);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request && request.nonce]);
  React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const busy = !!status;
  const jump = id => {
    const el = document.getElementById("og-" + id.replace(/[^a-z0-9]+/gi, "-"));
    if (el) { el.scrollIntoView({behavior: "smooth", block: "start"}); el.classList.add("og-flash"); setTimeout(() => el.classList.remove("og-flash"), 1200); }
  };
  const inGuide = id => !!guide && guide.sections.some(s => s.id === id);

  const build = async (kindArg, objArg) => {
    const scope = (kindArg || scopeKind) === "org" ? {kind: "org"} : {kind: "area", object: objArg || object};
    if (scope.kind === "area" && !scope.object) { setError("Pick the object the business area is about."); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      setStatus("Reading the org…");
      const {items, notes} = await getItems({onStatus: setStatus, signal: ctrl.signal});
      setStatus("Drawing the diagrams…");
      const g = buildGuide(items, scope, {orgName: sfConn.instanceHostname || ""});
      g.notes.push(...notes);
      setGuide(g);
      if (focusRef.current) { const id = focusRef.current; focusRef.current = null; setTimeout(() => jump(id), 300); }
      if (useAi && hasValidConfig() && (g.sections.length || g.areas.length)) {
        const batches = eli5Batches(g.sections);
        const calls = batches.length + 1;
        const cfg = getSavedConfig() || {};
        const ok = await confirmDialog({
          title: "Add the AI notes?",
          message: `${calls} request${calls === 1 ? "" : "s"} to ${(LLM_PROVIDERS[cfg.provider] || {}).name || "your AI provider"} for the business summary and an ELI5 note per component. ` +
            "Only names, outlines and step summaries are sent: no record data and no full code.",
          confirmLabel: "Add AI notes", cancelLabel: "Skip"
        });
        if (ok && !ctrl.signal.aborted) {
          let cur = g;
          setStatus("Writing the business summary…");
          const business = await orgGuideBusiness(businessPrompt(cur), {signal: ctrl.signal}).catch(e => (ctrl.signal.aborted ? null : `(The AI summary failed: ${e.message})`));
          cur = {...cur, business};
          setGuide(cur);
          for (let i = 0; i < batches.length; i++) {
            if (ctrl.signal.aborted) break;
            setStatus(`Writing the ELI5 notes… ${i + 1} of ${batches.length}`);
            try {
              const got = await orgGuideEli5(batches[i].text, batches[i].ids, {signal: ctrl.signal});
              cur = {...cur, sections: cur.sections.map(s => (got[s.id] ? {...s, eli5: got[s.id].eli5, aiPlain: got[s.id].plain} : s))};
              setGuide(cur);
            } catch (e) {
              if (ctrl.signal.aborted) break;
              cur = {...cur, notes: [...cur.notes, `Some ELI5 notes are missing: ${e.message}`]};
              setGuide(cur);
            }
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e.message);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setStatus("");
    }
  };
  const cancel = () => { if (abortRef.current) abortRef.current.abort(); setStatus(""); };
  const fileBase = guide ? "org-guide-" + String(guide.title).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() : "org-guide";
  const copyMd = (key, text) => { try { safeCopyText(text); } catch (e) { /* ignore */ } setCopied(key); setTimeout(() => setCopied(null), 1200); };

  const objectOptions = objects.map(o => ({value: o.name, label: o.label, sub: o.name, tag: o.custom ? "Custom" : "", tagTone: "info"}));
  const phases = guide ? [...new Set(guide.sections.map(s => s.phaseLabel))] : [];

  return h("div", {className: "og"},
    h("div", {className: "sq3-card og-head"},
      h("div", {className: "og-title"}, h("span", {"aria-hidden": "true"}, "🛠"), " Technical map"),
      h("div", {className: "sq3-card-sub"},
        "For developers: one business area as components (flows, triggers, Apex, LWC, Aura, rules), in the order a save runs them, and how they call each other."),
      h("div", {className: "og-scope"},
        h("div", {className: "acc-kinds", role: "group", "aria-label": "Guide scope"},
          [["area", "One business area"], ["org", "Whole org overview"]].map(([id, label]) => h("button", {
            key: id, type: "button", "aria-pressed": scopeKind === id, disabled: busy,
            className: "insp-chip rel-chip" + (scopeKind === id ? " on" : ""), onClick: () => setScopeKind(id)}, label))),
        scopeKind === "area" && h(SearchSelect, {value: object, options: objectOptions, onChange: v => setObject(v || ""),
          placeholder: objects.length ? "Pick an object (Case, Opportunity, Invoice__c…)" : "Loading objects…",
          disabled: busy || !objects.length, ariaLabel: "Business area object", className: "og-object"}),
        h("label", {className: "sq3-check", title: hasValidConfig() ? "Adds a business summary and an ELI5 note per component" : "Set up an AI provider in Settings first"},
          h("input", {type: "checkbox", checked: useAi && hasValidConfig(), disabled: busy || !hasValidConfig(), onChange: e => setUseAi(e.target.checked)}),
          h("span", null, "✨ AI notes (ELI5)")),
        busy
          ? h("button", {className: "btn btn-secondary btn-sm", onClick: cancel}, "Cancel")
          : h("button", {className: "btn btn-primary btn-sm", disabled: scopeKind === "area" && !object, onClick: () => build()},
            guide ? "Build again" : "Build the guide")),
      busy && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      error && h("div", {className: "insp-error"}, error)),

    !guide && !busy && h(EmptyState, {art: "apps", title: "Get to know this org",
      text: "Pick a business area, like Case or Opportunity, and SaralForce maps everything that runs on it: flows, triggers, Apex classes, Lightning components and validation rules. Read-only."}),

    guide && h("div", {className: "og-doc"},
      h("div", {className: "og-doc-head"},
        h("div", null,
          h("h2", {className: "og-h1"}, "Technical map: ", guide.title),
          h("div", {className: "insp-meta"}, `Built ${new Date(guide.builtAt).toLocaleString()}`)),
        h("div", {className: "og-exports"},
          h("button", {className: "btn btn-secondary btn-sm", onClick: () => downloadText(fileBase + ".html", guideToHtml(guide), "text/html")}, "Download HTML"),
          h("button", {className: "btn btn-secondary btn-sm", onClick: () => downloadText(fileBase + ".md", guideToMarkdown(guide), "text/markdown")}, "Download Markdown"),
          h("button", {className: "btn btn-secondary btn-sm", onClick: () => copyMd("all", guideToMarkdown(guide))}, copied === "all" ? "Copied ✓" : "Copy"))),
      h("div", {className: "og-stats"}, ["flow", "trigger", "class", "lwc", "aura", "rule", "object"].filter(k => guide.counts[k]).map(k =>
        h("div", {key: k, className: "og-stat"},
          h("span", {className: "md-kind-ico t-" + TYPE_TONE[k], "aria-hidden": "true"}, GUIDE_TYPES[k].icon),
          h("span", {className: "og-stat-n"}, guide.counts[k]),
          h("span", {className: "og-stat-l"}, GUIDE_TYPES[k].plural)))),
      guide.notes.map((n, i) => h("div", {key: i, className: "insp-meta og-note"}, n)),
      h("div", {className: "og-body" + (guide.sections.length ? "" : " og-body-full")},
        guide.sections.length > 0 && h("nav", {className: "og-toc", "aria-label": "Guide contents"},
          h("div", {className: "og-toc-h"}, "Contents"),
          h("button", {className: "og-toc-link", onClick: () => jump("big-picture")}, "The big picture"),
          phases.map(p => h("div", {key: p},
            h("div", {className: "og-toc-phase"}, p),
            guide.sections.filter(s => s.phaseLabel === p).map(s => h("button", {key: s.id, className: "og-toc-link", onClick: () => jump(s.id), title: s.name},
              h("span", {className: "md-kind-ico t-" + TYPE_TONE[s.type], "aria-hidden": "true"}, GUIDE_TYPES[s.type].icon), " ", s.label))))),
        h("div", {className: "og-main"},
          (guide.business || (guide.maps && guide.maps.business && guide.maps.business.nodes.length > 1)) && h("section", {className: "sq3-card og-sec"},
            h("h3", {className: "og-h2"}, "How the business works"),
            guide.business && h(BusinessSummary, {text: guide.business, copied: copied === "biz", onCopy: () => copyMd("biz", guide.business)}),
            guide.maps && guide.maps.business && guide.maps.business.nodes.length > 1 && h("div", null,
              h("div", {className: "og-tag"}, "Business map: the main objects and how they link"),
              h(Diagram, {graph: guide.maps.business, title: "Business map"}))),
          guide.areas.length > 0 && h("section", {className: "sq3-card og-sec"},
            h("h3", {className: "og-h2"}, "Main business areas"),
            h("div", {className: "sq3-card-sub"}, "Objects with the most automation. Open one for its full guide."),
            h("div", {className: "insp-table-wrap"}, h("table", {className: "insp-table"},
              h("thead", null, h("tr", null, h("th", null, "Object"), h("th", null, "Triggers"), h("th", null, "Flows"), h("th", null, "Validation rules"), h("th", null, ""))),
              h("tbody", null, guide.areas.map(a => h("tr", {key: a.id},
                h("td", null, a.label, a.label !== a.name && h("span", {className: "insp-meta"}, " ", a.name)),
                h("td", null, a.triggers), h("td", null, a.flows), h("td", null, a.rules),
                h("td", null, h("button", {className: "field-action-btn", disabled: busy,
                  onClick: () => { setScopeKind("area"); setObject(a.name); build("area", a.name); }}, "Open guide →")))))))),
          guide.maps && guide.maps.system && h("section", {className: "sq3-card og-sec", id: "og-big-picture"},
            h("h3", {className: "og-h2"}, "The big picture"),
            h("div", {className: "sq3-card-sub"}, "What happens when a record of this object is saved, and what that code and automation touch. Click a box to read about it."),
            h(Diagram, {graph: guide.maps.system, title: "System map", onNodeClick: jump, linkable: inGuide, maxHeight: 620})),
          phases.map(p => h("div", {key: p},
            h("div", {className: "og-phase"}, p),
            guide.sections.filter(s => s.phaseLabel === p).map(s => h(SectionCard, {key: s.id, s, jump, inGuide, copied, copyMd})))),
          guide.glossary && guide.glossary.length > 0 && h("section", {className: "sq3-card og-sec"},
            h("h3", {className: "og-h2"}, "Glossary"),
            h("div", {className: "og-gloss"}, guide.glossary.map(g => h("div", {key: g.name, className: "og-gloss-row"},
              h("b", null, g.label), h("code", null, g.name)))))))));
}

function SectionCard({s, jump, inGuide, copied, copyMd}) {
  const text = [`${GUIDE_TYPES[s.type].label}: ${s.label}`, "", s.aiPlain || s.plain.join(" "),
    s.eli5 ? `\nELI5: ${s.eli5}` : "", s.related.length ? "\nRelated: " + s.related.map(r => `${r.label} (${r.reason})`).join("; ") : "",
    s.risks.length ? "\nGood to know: " + s.risks.join(" ") : ""].join("\n");
  return h("section", {className: "sq3-card og-sec og-comp", id: "og-" + s.id.replace(/[^a-z0-9]+/gi, "-")},
    h("div", {className: "og-comp-head"},
      h("span", {className: "md-kind-ico t-" + TYPE_TONE[s.type], "aria-hidden": "true"}, GUIDE_TYPES[s.type].icon),
      h("h3", {className: "og-h2"}, s.label),
      h("span", {className: "og-type"}, GUIDE_TYPES[s.type].label),
      s.label !== s.name && h("code", {className: "og-api"}, s.name),
      h("button", {className: "field-action-btn og-copy", onClick: () => copyMd(s.id, text)}, copied === s.id ? "Copied ✓" : "Copy")),
    h("div", {className: "og-tag"}, s.type === "flow" ? "Flow: step by step" : "Flow: how it connects"),
    h(Diagram, {
      graph: s.diagram, title: s.label,
      // Flowchart steps that run a subflow / Apex in the guide, or neighbours in the guide.
      linkable: (id, n) => (s.type === "flow" ? !!(n && n.link) : id !== s.id && inGuide(id)),
      onNodeClick: id => {
        if (s.type === "flow") { const n = s.diagram.nodes.find(x => x.id === id); if (n && n.link) jump(n.link); }
        else jump(id);
      }
    }),
    s.diagram.more > 0 && h("div", {className: "insp-meta"}, `${s.diagram.more} more step(s) not drawn.`),
    s.context && s.context.nodes.length > 1 && h("details", {className: "og-context"},
      h("summary", null, "Where this flow fits"),
      h(Diagram, {graph: s.context, title: s.label + " context", onNodeClick: jump, linkable: id => id !== s.id && inGuide(id)})),
    h("div", {className: "og-grid"},
      h("div", null,
        h("div", {className: "og-tag"}, "What this shows"),
        s.aiPlain && h("p", {className: "og-p"}, s.aiPlain),
        h("ul", {className: "og-list"}, s.plain.map((p, i) => h("li", {key: i}, p)))),
      h("div", null,
        h("div", {className: "og-tag"}, "Related flows and components"),
        s.related.length
          ? h("ul", {className: "og-list og-related"}, s.related.map((r, i) => h("li", {key: i},
            inGuide(r.id) ? h("button", {className: "og-rel-link", onClick: () => jump(r.id)}, r.label) : h("b", null, r.label),
            h("span", {className: "og-type"}, GUIDE_TYPES[r.type] ? GUIDE_TYPES[r.type].label : r.type), " ", r.reason)))
          : h("div", {className: "insp-meta"}, "Nothing else connects to it."))),
    h("div", {className: "og-eli5" + (s.eli5 ? "" : " empty")},
      h("div", {className: "og-tag"}, "🧸 ELI5 (explained like you're 5)"),
      s.eli5 || "Turn on ✨ AI notes and build again for a simple explanation of this component."),
    s.risks.length > 0 && h("div", {className: "og-risks"},
      h("div", {className: "og-tag"}, "⚠ Good to know"),
      h("ul", {className: "og-list"}, s.risks.map((r, i) => h("li", {key: i}, r)))));
}

// ═══ Org Handbook: the onboarding view ═══════════════════════════════
// The org is read once per page session and shared by every tab here.
let SHARED = null;   // {host, items, notes}
let HB_CACHE = null; // {host, hb}
const ELI5_CACHE = new Map();
const hostNow = () => sfConn.instanceHostname || "";

async function sharedItems({onStatus = () => {}, signal, force = false} = {}) {
  if (!force && SHARED && SHARED.host === hostNow()) return SHARED;
  const r = await loadGuideData({kind: "org"}, {onStatus, signal});
  SHARED = {host: hostNow(), ...r};
  return SHARED;
}

const flowAnchor = id => "ogf-" + String(id).replace(/[^a-z0-9]+/gi, "-");
const scrollToId = (domId, smooth = true) => setTimeout(() => {
  const el = document.getElementById(domId);
  if (el) { el.scrollIntoView({behavior: smooth ? "smooth" : "auto", block: "start"}); el.classList.add("og-flash"); setTimeout(() => el.classList.remove("og-flash"), 1200); }
}, 60);

const TAB_DEFS = [["home", "🏠", "Handbook"], ["flows", "⇢", "Flows"], ["processes", "🔄", "Business processes"], ["technical", "🛠", "Technical map"]];

function OrgGuideView() {
  const cached = HB_CACHE && HB_CACHE.host === hostNow() ? HB_CACHE.hb : null;
  const [tab, setTab] = useFfSession("metadata", "guideTab", "home");
  const [hb, setHbState] = React.useState(cached);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState(null);
  const [useAi, setUseAi] = React.useState(() => hasValidConfig());
  const [copied, setCopied] = React.useState(null);
  const [flowSel, setFlowSel] = React.useState(null);
  const [procSel, setProcSel] = React.useState(null);
  const [techReq, setTechReq] = React.useState(null);
  const abortRef = React.useRef(null);
  React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  const setHb = v => { setHbState(v); HB_CACHE = v ? {host: hostNow(), hb: v} : null; };
  const busy = !!status;
  const copyMd = (key, text) => { try { safeCopyText(text); } catch (e) { /* ignore */ } setCopied(key); setTimeout(() => setCopied(null), 1200); };

  const writeSummary = async (base, ctrl) => {
    setStatus("Writing the business summary…");
    const business = await orgGuideBusiness(handbookPrompt(base), {signal: ctrl && ctrl.signal})
      .catch(e => (ctrl && ctrl.signal.aborted ? null : `(The AI summary failed: ${e.message})`));
    setHb({...base, business});
  };

  const build = async (force = false) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      setStatus("Reading the org…");
      const {items, notes} = await sharedItems({onStatus: setStatus, signal: ctrl.signal, force});
      const top = areaRanking(buildGuideGraph(items)).slice(0, 10).map(r => r.name);
      const extras = await loadHandbookExtras(top, {onStatus: setStatus, signal: ctrl.signal});
      setStatus("Writing the handbook…");
      const book = buildHandbook(items, extras, {orgName: hostNow()});
      book.notes = [...notes, ...extras.notes];
      setHb(book);
      if (useAi && hasValidConfig()) {
        const cfg = getSavedConfig() || {};
        const ok = await confirmDialog({
          title: "Add an AI business summary?",
          message: `1 request to ${(LLM_PROVIDERS[cfg.provider] || {}).name || "your AI provider"}: it reads the app, object, stage and flow names and summaries ` +
            "(no record data, no code) and explains what the business does.",
          confirmLabel: "Write the summary", cancelLabel: "Skip"
        });
        if (ok && !ctrl.signal.aborted) await writeSummary(book, ctrl);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e.message);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setStatus("");
    }
  };
  const cancel = () => { if (abortRef.current) abortRef.current.abort(); setStatus(""); };

  // Move between the tabs: {tab, ref, object}.
  const go = target => {
    if (!target) return;
    if (target.tab === "flows") { setTab("flows"); setFlowSel(target.ref); scrollToId(flowAnchor(target.ref)); }
    else if (target.tab === "processes") { setTab("processes"); if (target.ref) setProcSel(target.ref); }
    else if (target.tab === "technical") {
      const object = target.object || procSel || (hb && hb.processes[0] && hb.processes[0].object) || "";
      setTab("technical");
      setTechReq({object, focus: target.ref, nonce: Date.now()});
    } else setTab(target.tab);
  };

  return h("div", {className: "og"},
    h("div", {className: "sq3-card og-head"},
      h("div", {className: "og-title"}, h("span", {"aria-hidden": "true"}, "📘"), " Org Handbook"),
      h("div", {className: "sq3-card-sub"},
        "Everything a new team member needs: what the business does, how records move through their stages, and every flow explained step by step with a simple diagram. Read-only."),
      h("div", {className: "og-scope"},
        h("label", {className: "sq3-check", title: hasValidConfig() ? "Adds a short AI summary of the business" : "Set up an AI provider in Settings first"},
          h("input", {type: "checkbox", checked: useAi && hasValidConfig(), disabled: busy || !hasValidConfig(), onChange: e => setUseAi(e.target.checked)}),
          h("span", null, "✨ AI business summary")),
        busy
          ? h("button", {className: "btn btn-secondary btn-sm", onClick: cancel}, "Cancel")
          : h("button", {className: "btn btn-primary btn-sm", onClick: () => build(!!hb)}, hb ? "↻ Refresh from the org" : "Build the handbook"),
        hb && h("span", {className: "insp-meta"}, `Built ${new Date(hb.builtAt).toLocaleString()}`)),
      busy && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      error && h("div", {className: "insp-error"}, error),
      h("div", {className: "og-tabs", role: "tablist", "aria-label": "Handbook sections"},
        TAB_DEFS.map(([id, icon, label]) => h("button", {
          key: id, role: "tab", "aria-selected": tab === id, className: "og-tab" + (tab === id ? " on" : ""), onClick: () => setTab(id),
          disabled: !hb && id !== "home" && id !== "technical"
        }, h("span", {"aria-hidden": "true"}, icon), " ", label,
        id === "flows" && hb ? h("span", {className: "og-tab-n"}, hb.flows.length) : null,
        id === "processes" && hb ? h("span", {className: "og-tab-n"}, hb.processes.length) : null)))),

    tab === "technical"
      ? h(TechnicalGuide, {request: techReq, getItems: sharedItems})
      : !hb
        ? (!busy && h(EmptyState, {art: "apps", title: "Get to know this org",
          text: "Build the handbook once: SaralForce reads the org's apps, objects, flows, triggers, Apex and rules (read-only) and explains them in plain words, with a diagram for every flow."},
          h("button", {className: "btn btn-primary btn-sm", onClick: () => build(false)}, "Build the handbook")))
        : tab === "flows"
          ? h(FlowLibrary, {hb, sel: flowSel, setSel: setFlowSel, go, copied, copyMd})
          : tab === "processes"
            ? h(Processes, {hb, sel: procSel || (hb.processes[0] && hb.processes[0].object), setSel: setProcSel, go})
            : h(HandbookHome, {hb, go, copied, copyMd, canAi: hasValidConfig(), busy,
              onSummary: () => writeSummary(hb, null).finally(() => setStatus(""))}));
}

const KIND_ICON = {record: "💾", screen: "🖐", scheduled: "⏰", event: "📣", called: "↳"};

function StatTiles({counts}) {
  return h("div", {className: "og-stats"}, ["flow", "trigger", "class", "lwc", "aura", "rule", "object"].filter(k => counts[k]).map(k =>
    h("div", {key: k, className: "og-stat"},
      h("span", {className: "md-kind-ico t-" + TYPE_TONE[k], "aria-hidden": "true"}, GUIDE_TYPES[k].icon),
      h("span", {className: "og-stat-n"}, counts[k]),
      h("span", {className: "og-stat-l"}, GUIDE_TYPES[k].plural))));
}

const stageChain = p => p.columns.filter(c => !c.id.startsWith("@")).map(c => c.label);

function StageChain({p, big}) {
  const list = stageChain(p);
  if (!list.length) return null;
  return h("div", {className: "og-stages" + (big ? " big" : "")}, list.map((s, i) => h(React.Fragment, {key: i},
    i > 0 && h("span", {className: "og-arrow", "aria-hidden": "true"}, "→"), h("span", {className: "og-stage"}, s))));
}

function HandbookHome({hb, go, copied, copyMd, canAi, busy, onSummary}) {
  return h("div", {className: "og-home"},
    h(StatTiles, {counts: hb.counts}),
    hb.notes.map((n, i) => h("div", {key: i, className: "insp-meta og-note"}, n)),
    h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, "How the business works"),
      hb.business
        ? h(BusinessSummary, {text: hb.business, copied: copied === "biz", onCopy: () => copyMd("biz", hb.business)})
        : h("div", {className: "og-ai-hint"},
          h("span", {className: "insp-meta"}, canAi ? "A short AI summary of what this business does, from its apps, objects, stages and flows."
            : "Set up an AI provider in Settings for a short summary of what this business does. Everything else here works without AI."),
          canAi && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onSummary}, "✨ Write the summary"))),
    hb.startHere.length > 0 && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, "🚀 Start here"),
      h("div", {className: "sq3-card-sub"}, "A reading order for your first day."),
      h("ol", {className: "og-start"}, hb.startHere.map((s, i) => h("li", {key: i},
        h("button", {className: "og-start-link", onClick: () => go(s.go)}, s.text))))),
    hb.departments.length > 0 && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, "🏢 Departments (apps)"),
      h("div", {className: "sq3-card-sub"}, "Each app is a team's workspace; these are the records they work with. Highlighted ones have automation: click to see their life."),
      h("div", {className: "og-cards"}, hb.departments.map(d => h("div", {key: d.name, className: "og-card"},
        h("div", {className: "og-card-h"}, d.label),
        d.description && h("div", {className: "insp-meta"}, d.description),
        h("div", {className: "og-chips"}, d.objects.slice(0, 14).map((o, i) => {
          const proc = hb.processes.find(p => p.object === o.name);
          return h("button", {key: i, className: "og-chip" + (proc ? " live" : ""), disabled: !proc,
            title: proc ? `See how a ${proc.label} moves through its life` : "No automation on this object",
            onClick: () => proc && go({tab: "processes", ref: proc.object})}, o.label, o.automations ? h("span", {className: "og-chip-n"}, o.automations) : null);
        })))))),
    hb.processes.length > 0 && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, "🔄 Business processes"),
      h("div", {className: "sq3-card-sub"}, "The records with the most automation, and the stages they go through."),
      h("div", {className: "og-cards"}, hb.processes.map(p => h("button", {key: p.object, className: "og-card og-card-btn", onClick: () => go({tab: "processes", ref: p.object})},
        h("div", {className: "og-card-h"}, p.label, p.label !== p.object && h("span", {className: "insp-meta"}, " ", p.object)),
        h(StageChain, {p}),
        h("div", {className: "insp-meta"}, `${p.counts.flows} flows · ${p.counts.triggers} triggers · ${p.counts.rules} rules`))))),
    hb.glossary.length > 0 && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, "📖 Glossary"),
      h("div", {className: "sq3-card-sub"}, "The main records, their stages and options, in the org's own words."),
      h("div", {className: "og-gloss2"}, hb.glossary.map(g => h("div", {key: g.name, className: "og-gloss-item"},
        h("div", null, h("b", null, g.label), " ", h("code", null, g.name)),
        g.recordTypes.length > 0 && h("div", {className: "og-gloss-line"}, h("span", {className: "og-tag-inline"}, "Kinds"), g.recordTypes.join(", ")),
        g.picklists.map(p => h("div", {key: p.name, className: "og-gloss-line"}, h("span", {className: "og-tag-inline"}, p.label),
          p.values.slice(0, 12).join(" · "), p.values.length > 12 ? " · …" : "")))))));
}

// ─── Flow library ────────────────────────────────────────────────────
function FlowLibrary({hb, sel, setSel, go, copied, copyMd}) {
  const [term, setTerm] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const t = term.trim().toLowerCase();
  const kinds = Object.keys(FLOW_KIND_LABEL).filter(k => hb.flows.some(f => f.kind === k));
  const shown = hb.flows.filter(f => (kind === "all" || f.kind === kind) &&
    (!t || `${f.label} ${f.name} ${f.object} ${f.summary}`.toLowerCase().includes(t)));
  // Group by the object they run on; flows without one by their kind.
  const groups = new Map();
  for (const f of shown) {
    const g = f.object ? `Runs on ${f.object}` : FLOW_KIND_LABEL[f.kind];
    (groups.get(g) || groups.set(g, []).get(g)).push(f);
  }
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return h("div", {className: "og-lib"},
    h("div", {className: "sq3-card og-lib-bar"},
      h("input", {className: "soql-save-input og-search", value: term, placeholder: `Search ${hb.flows.length} flows: name, object or what it does (e.g. "email", "approval")`,
        "aria-label": "Search flows", onChange: e => setTerm(e.target.value)}),
      h("div", {className: "acc-kinds"},
        [["all", "All"], ...kinds.map(k => [k, FLOW_KIND_LABEL[k]])].map(([id, label]) => h("button", {
          key: id, type: "button", "aria-pressed": kind === id, className: "insp-chip rel-chip" + (kind === id ? " on" : ""), onClick: () => setKind(id)},
        id !== "all" ? KIND_ICON[id] + " " : "", label,
        h("span", {className: "og-chip-n"}, id === "all" ? hb.flows.length : hb.flows.filter(f => f.kind === id).length))))),
    !shown.length && h("div", {className: "insp-meta"}, "No flow matches."),
    ordered.map(([group, list]) => h("section", {key: group, className: "og-lib-group"},
      h("div", {className: "og-phase"}, group, h("span", {className: "og-chip-n"}, list.length)),
      list.map(f => h("div", {key: f.id, id: flowAnchor(f.id), className: "sq3-card og-flow" + (sel === f.id ? " open" : "")},
        h("button", {className: "og-flow-row", "aria-expanded": sel === f.id, onClick: () => setSel(sel === f.id ? null : f.id)},
          h("span", {className: "og-flow-ico", "aria-hidden": "true"}, KIND_ICON[f.kind]),
          h("span", {className: "og-flow-main"},
            h("span", {className: "og-flow-name"}, f.label),
            h("span", {className: "og-flow-sum"}, f.summary)),
          h("span", {className: "og-flow-meta"},
            f.timing && h("span", {className: "og-type"}, f.timing),
            h("span", {className: "og-type"}, `${f.steps} step${f.steps === 1 ? "" : "s"}`),
            f.calledBy.length > 0 && h("span", {className: "og-type"}, `used by ${f.calledBy.length}`)),
          h("span", {className: "og-caret", "aria-hidden": "true"}, sel === f.id ? "▾" : "▸")),
        sel === f.id && h(FlowDetail, {f, hb, go, copied, copyMd}))))));
}

function FlowDetail({f, hb, go, copied, copyMd}) {
  const [view, setView] = React.useState("simple");
  const [eli5, setEli5] = React.useState(() => ELI5_CACHE.get(f.id) || null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState(null);
  const item = SHARED && SHARED.items.flows.find(x => `flow:${x.name.toLowerCase()}` === f.id);
  const meta = item && item.meta;
  const story = React.useMemo(() => (meta ? flowStory(meta) : null), [meta]);
  const graph = React.useMemo(() => {
    if (!meta) return null;
    const inLib = id => hb.flows.some(x => x.id === id);
    const linkFor = (type, name) => {
      const id = `${type}:${String(name).toLowerCase()}`;
      return type === "flow" ? (inLib(id) ? id : null) : id;
    };
    return view === "simple" ? simpleFlowDiagram(meta, {linkFor}) : flowDiagram(meta, {linkFor});
  }, [meta, view, hb]);
  if (!meta) return h("div", {className: "insp-meta"}, "Refresh the handbook to see this flow's steps.");
  const label = id => ((hb.flows.find(x => x.id === id) || {}).label || id.split(":")[1]);
  const openRef = ref => (ref.startsWith("flow:") ? go({tab: "flows", ref}) : go({tab: "technical", ref, object: f.object}));
  const askAi = async () => {
    setAiBusy(true); setAiErr(null);
    try {
      const text = [`ID: ${f.id}`, "Type: Flow", `Name: ${f.label}`, storyText(story)].join("\n").slice(0, 6000);
      const got = await orgGuideEli5(text, [f.id]);
      if (got[f.id]) { ELI5_CACHE.set(f.id, got[f.id]); setEli5(got[f.id]); }
      else setAiErr("The AI gave no answer for this flow.");
    } catch (e) {
      setAiErr(e.message === "NO_LLM_CONFIG" ? "Set up an AI provider in Settings first." : e.message);
    } finally {
      setAiBusy(false);
    }
  };
  return h("div", {className: "og-flow-detail"},
    h("div", {className: "og-flow-when"}, h("span", {"aria-hidden": "true"}, "▶ "), story.when),
    h("div", {className: "og-view-tabs"},
      [["simple", "Simple diagram"], ["detailed", "Detailed"]].map(([id, lab]) => h("button", {key: id, type: "button",
        className: "og-view-tab" + (view === id ? " on" : ""), "aria-pressed": view === id, onClick: () => setView(id)}, lab)),
      item.versionId && h("a", {className: "field-action-btn og-open-fb", target: "_blank", rel: "noopener noreferrer",
        href: `https://${sfConn.instanceHostname}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(item.versionId)}`}, "Open in Flow Builder ↗"),
      h("button", {className: "field-action-btn", onClick: () => copyMd(f.id, `${f.label}\n${storyText(story)}`)}, copied === f.id ? "Copied ✓" : "Copy the story")),
    h(Diagram, {graph, title: f.label, maxHeight: 640,
      linkable: (id, n) => !!(n && n.link),
      onNodeClick: id => { const n = graph.nodes.find(x => x.id === id); if (n && n.link) openRef(n.link); }}),
    graph.more > 0 && h("div", {className: "insp-meta"}, `${graph.more} more step(s) not drawn: see the story below.`),
    h("div", {className: "og-grid"},
      h("div", null,
        h("div", {className: "og-tag"}, "The story, step by step"),
        h("ol", {className: "og-story"}, story.steps.map(s => h("li", {key: s.n, value: s.n, className: s.person ? "person" : ""},
          h("span", {className: "og-story-ico", "aria-hidden": "true"}, s.icon), " ", s.text,
          s.person && h("span", {className: "og-type"}, "a person does this"),
          (s.branches.length > 0 || s.then || s.fault) && h("ul", {className: "og-branches"},
            s.branches.map((b, i) => h("li", {key: i}, h("b", null, b.label), b.when ? ` (${b.when})` : "", " → ", b.to)),
            s.then && h("li", null, "then → ", s.then === "the end" ? "done" : s.then),
            s.fault && h("li", {className: "fault"}, "if it fails → ", s.fault))))),
        !story.steps.length && h("div", {className: "insp-meta"}, "This flow has no steps yet."),
        story.unreachable > 0 && h("div", {className: "insp-meta"}, `${story.unreachable} step(s) are never reached.`)),
      h("div", null,
        h("div", {className: "og-tag"}, "Connected"),
        f.calledBy.length > 0 && h("div", {className: "og-conn"}, h("span", {className: "og-tag-inline"}, "Used by"),
          f.calledBy.map(id => h("button", {key: id, className: "og-chip live", onClick: () => openRef(id)}, label(id)))),
        f.calls.length > 0 && h("div", {className: "og-conn"}, h("span", {className: "og-tag-inline"}, "Uses"),
          f.calls.map(id => h("button", {key: id, className: "og-chip live", onClick: () => openRef(id)}, id.startsWith("class:") ? "⚙ " + id.split(":")[1] : label(id)))),
        f.object && hb.processes.some(p => p.object === f.object) && h("div", {className: "og-conn"}, h("span", {className: "og-tag-inline"}, "Record"),
          h("button", {className: "og-chip live", onClick: () => go({tab: "processes", ref: f.object})}, `Life of a ${f.object}`)),
        !f.calledBy.length && !f.calls.length && !f.object && h("div", {className: "insp-meta"}, "Not connected to other flows or Apex."),
        h("div", {className: "og-eli5" + (eli5 ? "" : " empty")},
          h("div", {className: "og-tag"}, "🧸 ELI5 (explained like you're 5)"),
          eli5 ? h("div", null, eli5.eli5) : h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy || !hasValidConfig(), onClick: askAi,
            title: hasValidConfig() ? "1 AI request with this flow's story (no data, no code)" : "Set up an AI provider in Settings first"}, aiBusy ? "Asking…" : "✨ Explain it simply"),
          aiErr && h("div", {className: "insp-error"}, aiErr)))));
}

// ─── Business processes: the life of a record ───────────────────────
function Processes({hb, sel, setSel, go}) {
  const p = hb.processes.find(x => x.object === sel) || hb.processes[0];
  if (!p) return h(EmptyState, {art: "apps", title: "No business processes found", text: "No object here has flows, triggers or validation rules on it."});
  const flowsHere = hb.flows.filter(f => f.object === p.object);
  const g = hb.glossary.find(x => x.name === p.object);
  const open = chip => (chip.type === "flow" ? go({tab: "flows", ref: chip.ref}) : go({tab: "technical", ref: chip.ref, object: p.object}));
  const chipIcon = {flow: "⇢", trigger: "⚡", rule: "✓"};
  return h("div", {className: "og-proc"},
    h("div", {className: "acc-kinds og-proc-pick"}, hb.processes.map(x => h("button", {key: x.object, type: "button", "aria-pressed": x.object === p.object,
      className: "insp-chip rel-chip" + (x.object === p.object ? " on" : ""), onClick: () => setSel(x.object)}, x.label, h("span", {className: "og-chip-n"}, x.total)))),
    h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, `The life of a ${p.label}`),
      h("div", {className: "sq3-card-sub"}, p.stageField
        ? `Across: the ${p.stageField.label} values a ${p.label} goes through. Down: when the automation runs. Click any box to read it.`
        : "This object has no stage or status picklist, so automation is shown for \"Created\" and \"Any change\". Click any box to read it."),
      h(StageChain, {p, big: true}),
      p.lanes.length
        ? h("div", {className: "og-lanes-wrap"}, h("table", {className: "og-lanes"},
          h("thead", null, h("tr", null, h("th", {className: "og-lane-h"}, ""),
            p.columns.map(c => h("th", {key: c.id, className: c.id.startsWith("@") ? "meta" : ""},
              c.label,
              p.moves.filter(m => m.to === c.id).map((m, i) => h("div", {key: i, className: "og-move", title: `${m.by.label} sets ${p.stageField.label} to ${c.label}`},
                "↘ set by ", h("button", {className: "og-rel-link", onClick: () => open(m.by)}, m.by.label))))))),
          h("tbody", null, p.lanes.map(l => h("tr", {key: l.id},
            h("th", {className: "og-lane-h"}, h("div", null, l.label), h("div", {className: "og-lane-hint"}, l.hint)),
            p.columns.map(c => h("td", {key: c.id}, (l.cells[c.id] || []).map((chip, i) => h("button", {key: i, className: "og-lchip t-" + TYPE_TONE[chip.type],
              title: `${GUIDE_TYPES[chip.type].label}: ${chip.label}`, onClick: () => open(chip)},
            chipIcon[chip.type] + " ", chip.label)))))))))
        : h("div", {className: "insp-meta"}, `Nothing runs automatically on ${p.label}.`)),
    flowsHere.length > 0 && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, `Flows on ${p.label}`),
      h("ul", {className: "og-list og-proc-flows"}, flowsHere.map(f => h("li", {key: f.id},
        h("button", {className: "og-rel-link", onClick: () => go({tab: "flows", ref: f.id})}, f.label), " ", h("span", {className: "insp-meta"}, f.summary))))),
    g && (g.picklists.length > 0 || g.recordTypes.length > 0) && h("section", {className: "sq3-card og-sec"},
      h("h3", {className: "og-h2"}, `${p.label}: words you'll see`),
      g.recordTypes.length > 0 && h("div", {className: "og-gloss-line"}, h("span", {className: "og-tag-inline"}, "Kinds"), g.recordTypes.join(", ")),
      g.picklists.map(x => h("div", {key: x.name, className: "og-gloss-line"}, h("span", {className: "og-tag-inline"}, x.label), x.values.join(" · ")))),
    h("button", {className: "field-action-btn og-tech-link", onClick: () => go({tab: "technical", object: p.object, ref: null})}, `🛠 Technical map of ${p.label} →`));
}

export {OrgGuideView, Diagram};
