// Structured detail views for the Metadata tab: an Overview built from the
// source (code-outline.js) plus a numbered source view, a bundle file tree for
// LWC / Aura, and an editable, readable card for validation rules.
import {sfConn, apiVersion} from "../../inspector.js";
import {hasValidConfig} from "../../llm/llm-service.js";
import {escapeSoqlString} from "../../core/soql.js";
import {
  apexOutline, triggerOutline, pageOutline, lwcOutline, auraOutline,
  formulaFields, formulaFunctions, formulaHighlight
} from "../../core/code-outline.js";
import {queryAll} from "../shared/query.js";
import {ffDescribeObject} from "../shared/describe.js";
import {apexHighlight} from "../shared/highlight.js";
import {validationRuleFromText} from "../shared/ai.js";
import {FFBadge} from "../shared/ui.js";
import {fileIcon, fileLabel, treeFileLabel} from "./metadata-new.js";

const h = React.createElement;
const tooling = {tooling: true};
const byId = (what, id) => `SELECT ${what} WHERE Id = '${escapeSoqlString(id)}'`;

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(text, lang) {
  return lang === "apex" || lang === "js" ? apexHighlight(text) : escHtml(text);
}

// Source with line numbers; `focusLine` scrolls a line into view.
function CodeView({text, lang, focusLine, maxHeight}) {
  const ref = React.useRef(null);
  const lines = String(text || "").split("\n");
  React.useEffect(() => {
    if (!focusLine || !ref.current) return;
    const el = ref.current.querySelector(`[data-ln="${focusLine}"]`);
    if (el) {
      ref.current.scrollTop = Math.max(0, el.offsetTop - 40);
      el.classList.add("mdv-ln-hit");
      setTimeout(() => el.classList.remove("mdv-ln-hit"), 1600);
    }
  }, [focusLine, text]);
  return h("div", {className: "soql-editor-box mdv-code", ref, style: maxHeight ? {maxHeight} : undefined},
    h("table", {className: "mdv-code-t"},
      h("tbody", null, lines.map((ln, i) => h("tr", {key: i, "data-ln": i + 1},
        h("td", {className: "mdv-ln"}, i + 1),
        h("td", {className: "mdv-src", dangerouslySetInnerHTML: {__html: highlight(ln, lang) || " "}}))))));
}

function Section({title, icon, children, right}) {
  return h("div", {className: "mdv-section"},
    h("div", {className: "mdv-section-h"},
      icon && h("span", {className: "mdv-section-ico", "aria-hidden": "true"}, icon),
      h("span", null, title),
      right && h("span", {className: "mdv-section-r"}, right)),
    children);
}

function Stats({items}) {
  return h("div", {className: "mdv-stats"}, items.filter(Boolean).map(([label, value, tone]) =>
    h("div", {key: label, className: "mdv-stat" + (tone ? " " + tone : "")},
      h("div", {className: "mdv-stat-v"}, value),
      h("div", {className: "mdv-stat-l"}, label))));
}

function Chips({items, tone, empty}) {
  if (!items || !items.length) return h("div", {className: "insp-meta"}, empty || "None");
  return h("div", {className: "mdv-chips"}, items.map((c, i) => {
    const label = typeof c === "string" ? c : c.label;
    return h("span", {key: i, className: "mdv-chip" + (tone ? " " + tone : "") + (c.tone ? " " + c.tone : ""), title: c.title || label}, label,
      c.count > 1 && h("span", {className: "mdv-chip-n"}, "×" + c.count));
  }));
}

function ViewTabs({tabs, value, onChange}) {
  return h("div", {className: "sq3-pills md-views", role: "tablist"}, tabs.map(([id, label]) => h("button", {
    key: id, role: "tab", "aria-selected": value === id,
    className: "sq3-pill" + (value === id ? " active" : ""), onClick: () => onChange(id)
  }, label)));
}

function useLoad(loader, deps) {
  const [state, setState] = React.useState({loading: true});
  React.useEffect(() => {
    let stale = false;
    setState({loading: true});
    loader().then(data => { if (!stale) setState({data}); }).catch(e => { if (!stale) setState({error: e.message}); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function LoadState({state}) {
  if (state.error) return h("div", {className: "insp-error"}, "Could not read it: " + state.error);
  return h("div", {className: "insp-meta"}, "Loading…");
}

// ─── Apex class ──────────────────────────────────────────────────────
function ApexView({row, onSource}) {
  const st = useLoad(async () => ((await queryAll(byId("Body FROM ApexClass", row.Id), tooling))[0] || {}).Body || "", [row.Id]);
  const [tab, setTab] = React.useState("overview");
  const [line, setLine] = React.useState(null);
  React.useEffect(() => { if (st.data != null) onSource(st.data); }, [st.data, onSource]);
  if (st.data == null) return h(LoadState, {state: st});
  if (!st.data) return h("div", {className: "insp-meta"}, "No source available (managed or empty).");
  const o = apexOutline(st.data);
  const sharingTone = o.sharing === "with sharing" || o.sharing === "inherited sharing" ? "ok" : o.isTest ? "" : "warn";
  const go = ln => { setLine(ln); setTab("source"); };
  return h("div", null,
    h(ViewTabs, {tabs: [["overview", "Overview"], ["source", `Source · ${o.stats.lines} lines`]], value: tab, onChange: setTab}),
    tab === "overview" && h("div", {className: "mdv-grid"},
      h(Section, {title: "Declaration", icon: "🏷️"},
        h(Chips, {items: [
          o.access && {label: o.access},
          {label: o.sharing || "no sharing keyword", tone: sharingTone, title: sharingTone === "warn" ? "Runs without the user's record access unless set by the caller" : ""},
          o.modifier && {label: o.modifier},
          o.isTest && {label: "test class", tone: "info"},
          ...o.annotations.map(a => ({label: a, tone: "info"})),
          o.extends && {label: "extends " + o.extends},
          ...o.implements.map(i => ({label: "implements " + i})),
        ].filter(Boolean)})),
      h(Section, {title: "At a glance", icon: "📊"},
        h(Stats, {items: [
          ["Methods", o.methods.length], ["Fields", o.fields.length],
          ["SOQL", o.stats.soql, o.stats.soql > 5 ? "warn" : ""], ["DML", o.stats.dml, o.stats.dml > 5 ? "warn" : ""],
          o.stats.callouts && ["Callouts", o.stats.callouts], o.stats.auraEnabled && ["@AuraEnabled", o.stats.auraEnabled],
          o.stats.invocable && ["Invocable", o.stats.invocable], o.isTest && ["Test methods", o.stats.tests],
        ]})),
      h("div", {className: "mdv-wide"},
        h(Section, {title: `Methods (${o.methods.length})`, icon: "ƒ", right: "click a method to open it in the source"},
          o.methods.length ? h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table mdv-table"},
              h("thead", null, h("tr", null, h("th", null, "Method"), h("th", null, "Returns"), h("th", null, "Access"), h("th", null, ""))),
              h("tbody", null, o.methods.map((m, i) => h("tr", {key: i, className: "insp-row-click", onClick: () => go(m.line), title: `Line ${m.line}`},
                h("td", {className: "ff-mono"}, h("b", null, m.name), `(${m.params})`),
                h("td", {className: "ff-mono"}, m.constructor ? "constructor" : m.returns),
                h("td", null, m.access + (m.isStatic ? " · static" : "")),
                h("td", null, m.annotations.map((a, j) => h("span", {key: j, className: "mdv-chip info sm"}, a.replace(/\(.*/, "")))))))))
            : h("div", {className: "insp-meta"}, "No methods."))),
      o.fields.length > 0 && h("div", {className: "mdv-wide"},
        h(Section, {title: `Fields & properties (${o.fields.length})`, icon: "▤"},
          h(Chips, {items: o.fields.map(f => ({label: `${f.type} ${f.name}${f.property ? " { get; set; }" : ""}`, tone: f.isStatic ? "info" : ""}))}))),
      o.innerClasses.length > 0 && h(Section, {title: "Inner classes", icon: "◫"}, h(Chips, {items: o.innerClasses}))),
    tab === "source" && h(CodeView, {text: st.data, lang: "apex", focusLine: line}));
}

// ─── Trigger ─────────────────────────────────────────────────────────
const ALL_EVENTS = ["before insert", "before update", "before delete", "after insert", "after update", "after delete", "after undelete"];

function TriggerView({row, onSource}) {
  const st = useLoad(async () => ((await queryAll(byId("Body FROM ApexTrigger", row.Id), tooling))[0] || {}).Body || "", [row.Id]);
  const [tab, setTab] = React.useState("overview");
  React.useEffect(() => { if (st.data != null) onSource(st.data); }, [st.data, onSource]);
  if (st.data == null) return h(LoadState, {state: st});
  const o = triggerOutline(st.data);
  return h("div", null,
    h(ViewTabs, {tabs: [["overview", "Overview"], ["source", `Source · ${o.stats.lines} lines`]], value: tab, onChange: setTab}),
    tab === "overview" && h("div", {className: "mdv-grid"},
      h(Section, {title: "Runs on", icon: "🎯"},
        h("div", {className: "mdv-big"}, o.object || row.TableEnumOrId),
        h("div", {className: "mdv-events"}, ALL_EVENTS.map(e => h("span", {
          key: e, className: "mdv-event" + (o.events.includes(e) ? " on" : "")
        }, e)))),
      h(Section, {title: "At a glance", icon: "📊"},
        h(Stats, {items: [["Lines", o.stats.lines], ["SOQL", o.stats.soql, o.stats.soql ? "warn" : ""],
          ["DML", o.stats.dml, o.stats.dml ? "warn" : ""], ["Handlers", o.calls.length]]}),
        (o.stats.soql > 0 || o.stats.dml > 0) && h("div", {className: "mdv-note warn"},
          "Logic lives in the trigger itself; moving it to a handler class keeps it testable and bulk-safe.")),
      h(Section, {title: "Hands work to", icon: "➜"}, h(Chips, {items: o.calls, empty: "No handler classes called."})),
      h(Section, {title: "Uses trigger context", icon: "⚙"}, h(Chips, {items: o.usesContext, tone: "info", empty: "None"}))),
    tab === "source" && h(CodeView, {text: st.data, lang: "apex"}));
}

// ─── Visualforce ─────────────────────────────────────────────────────
function PageView({row, onSource}) {
  const st = useLoad(async () => ((await queryAll(byId("Markup FROM ApexPage", row.Id), tooling))[0] || {}).Markup || "", [row.Id]);
  const [tab, setTab] = React.useState("overview");
  React.useEffect(() => { if (st.data != null) onSource(st.data); }, [st.data, onSource]);
  if (st.data == null) return h(LoadState, {state: st});
  const o = pageOutline(st.data);
  return h("div", null,
    h(ViewTabs, {tabs: [["overview", "Overview"], ["source", `Markup · ${o.lines} lines`]], value: tab, onChange: setTab}),
    tab === "overview" && h("div", {className: "mdv-grid"},
      h(Section, {title: "Page setup", icon: "📄"},
        h(Chips, {items: [
          o.standardController && {label: "standard controller: " + o.standardController, tone: "info"},
          o.controller && {label: "controller: " + o.controller, tone: "info"},
          ...o.extensions.map(e => ({label: "extension: " + e})),
          o.renderAs && {label: "renders as " + o.renderAs},
          o.lightningStylesheets && {label: "Lightning styles", tone: "ok"},
        ].filter(Boolean), empty: "Plain page (no controller)."})),
      h(Section, {title: "At a glance", icon: "📊"},
        h(Stats, {items: [["Lines", o.lines], ["Components", o.components.reduce((n, c) => n + c.count, 0)], ["Merge fields", o.mergeFields.length]]})),
      h(Section, {title: "Components used", icon: "🧩"}, h(Chips, {items: o.components.map(c => ({label: c.name, count: c.count}))})),
      h(Section, {title: "Data shown", icon: "{ }"}, h(Chips, {items: o.mergeFields, tone: "info", empty: "No merge fields."}))),
    tab === "source" && h(CodeView, {text: st.data, lang: "markup"}));
}

// ─── LWC / Aura bundles ──────────────────────────────────────────────
const AURA_ORDER = ["COMPONENT", "APPLICATION", "CONTROLLER", "HELPER", "RENDERER", "STYLE", "DOCUMENTATION", "DESIGN", "SVG", "EVENT", "INTERFACE", "TOKENS"];
const AURA_EXT = {COMPONENT: ".cmp", APPLICATION: ".app", CONTROLLER: "Controller.js", HELPER: "Helper.js", RENDERER: "Renderer.js",
  STYLE: ".css", DOCUMENTATION: ".auradoc", DESIGN: ".design", SVG: ".svg", EVENT: ".evt", INTERFACE: ".intf", TOKENS: ".tokens"};

function langOf(path) {
  if (/\.js$/.test(path)) return "js";
  return "markup";
}

function FileBrowser({folder, files, active, onPick}) {
  const file = files[active] || files[0];
  return h("div", {className: "mdn-editor-body mdv-bundle"},
    h("div", {className: "mdn-tree", role: "tablist", "aria-label": "Files"},
      h("div", {className: "mdn-tree-folder", title: folder}, "▾ " + folder),
      files.map((f, i) => h("button", {
        key: f.path, role: "tab", "aria-selected": f === file,
        className: "mdn-tree-file" + (f === file ? " active" : ""), onClick: () => onPick(i), title: f.path
      }, fileIcon(f.path), treeFileLabel(f.path),
        h("span", {className: "mdv-file-lines"}, String(f.source || "").split("\n").length)))),
    h("div", {className: "mdn-code-wrap"},
      file ? h(CodeView, {text: file.source || "", lang: langOf(file.path), maxHeight: 460}) : h("div", {className: "insp-meta"}, "No files.")));
}

function LwcView({row, onSource}) {
  const st = useLoad(async () => {
    const [res, metaRow] = await Promise.all([
      queryAll(`SELECT FilePath, Format, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${escapeSoqlString(row.Id)}'`, tooling),
      queryAll(byId("Metadata FROM LightningComponentBundle", row.Id), tooling).catch(() => []),
    ]);
    const order = p => ([".html", ".js", ".css", ".svg", ".js-meta.xml"].findIndex(e => p.endsWith(e)) + 1) || 9;
    const files = res.map(r => ({path: r.FilePath, source: r.Source || ""})).sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
    return {files, meta: (metaRow[0] || {}).Metadata || null};
  }, [row.Id]);
  const [tab, setTab] = React.useState("overview");
  const [active, setActive] = React.useState(0);
  React.useEffect(() => {
    if (st.data) onSource(st.data.files.map(f => `// ── ${f.path} ──\n${f.source}`).join("\n\n"));
  }, [st.data, onSource]);
  if (!st.data) return h(LoadState, {state: st});
  const o = lwcOutline(st.data.files, st.data.meta || {});
  const name = row.DeveloperName;
  return h("div", null,
    h(ViewTabs, {tabs: [["overview", "Overview"], ["files", `Bundle · ${st.data.files.length} files`]], value: tab, onChange: setTab}),
    tab === "overview" && h("div", {className: "mdv-grid"},
      h(Section, {title: "Where it can be used", icon: "📍"},
        h("div", {className: "mdv-row"}, h(FFBadge, {kind: o.exposed ? "ok" : "off"}, o.exposed ? "Exposed in builders" : "Not exposed"),
          o.apiVersion && h("span", {className: "md-chip-mini"}, "API " + o.apiVersion)),
        h(Chips, {items: o.targets.map(t => t.replace(/^lightning(Community|Snapin|Static)?__/, "")), tone: "info",
          empty: o.exposed ? "No targets set." : "Only usable inside other components."}),
        o.description && h("div", {className: "insp-meta mdv-desc"}, o.description)),
      h(Section, {title: "Bundle", icon: "📦"},
        h("div", {className: "mdv-files"}, st.data.files.map((f, i) => h("button", {
          key: f.path, className: "mdv-file", onClick: () => { setActive(i); setTab("files"); }
        }, fileIcon(f.path), fileLabel(f.path, 34))))),
      h(Section, {title: `Public properties (${o.apis.length})`, icon: "@"},
        h(Chips, {items: o.apis.map(a => "@api " + a), tone: "info", empty: "No @api properties."})),
      h(Section, {title: "Data", icon: "⛁"},
        h(Chips, {items: [...o.apex.map(a => ({label: "Apex " + a.method, tone: "warn"})), ...o.wires.map(w => ({label: "@wire " + w, tone: "info"}))],
          empty: "No Apex or wire calls."})),
      h(Section, {title: "Uses components", icon: "🧩"}, h(Chips, {items: o.children.map(c => ({label: `<${c.name}>`, count: c.count}))})),
      h(Section, {title: "Behaviour", icon: "⚡"},
        h(Chips, {items: [...o.events.map(e => ({label: "fires " + e})), o.navigation && {label: "navigates"}, o.toast && {label: "shows toasts"},
          ...o.imports.map(i => ({label: i.replace(/^lightning\//, "lightning/"), tone: "info"}))].filter(Boolean), empty: "Nothing special."}))),
    tab === "files" && h(FileBrowser, {folder: `lwc/${name}`, files: st.data.files, active, onPick: setActive}));
}

function AuraView({row, onSource}) {
  const st = useLoad(async () => {
    const defs = await queryAll(`SELECT DefType, Format, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${escapeSoqlString(row.Id)}'`, tooling);
    return defs.map(d => ({defType: d.DefType, path: `aura/${row.DeveloperName}/${row.DeveloperName}${AURA_EXT[d.DefType] || "." + d.DefType.toLowerCase()}`,
      source: d.Source || ""})).sort((a, b) => AURA_ORDER.indexOf(a.defType) - AURA_ORDER.indexOf(b.defType));
  }, [row.Id]);
  const [tab, setTab] = React.useState("overview");
  const [active, setActive] = React.useState(0);
  React.useEffect(() => {
    if (st.data) onSource(st.data.map(f => `// ── ${f.defType} ──\n${f.source}`).join("\n\n"));
  }, [st.data, onSource]);
  if (!st.data) return h(LoadState, {state: st});
  const o = auraOutline(st.data);
  return h("div", null,
    h(ViewTabs, {tabs: [["overview", "Overview"], ["files", `Bundle · ${st.data.length} files`]], value: tab, onChange: setTab}),
    tab === "overview" && h("div", {className: "mdv-grid"},
      h(Section, {title: "Implements", icon: "📍"},
        h(Chips, {items: o.implements, tone: "info", empty: "No interfaces (only usable inside other components)."}),
        o.controller && h("div", {className: "mdv-row"}, h("span", {className: "insp-meta"}, "Apex controller"), h("span", {className: "mdv-chip warn"}, o.controller))),
      h(Section, {title: "Bundle", icon: "📦"},
        h("div", {className: "mdv-files"}, st.data.map((f, i) => h("button", {
          key: f.path, className: "mdv-file", onClick: () => { setActive(i); setTab("files"); }
        }, fileIcon(f.path), fileLabel(f.path, 34))))),
      h("div", {className: "mdv-wide"},
        h(Section, {title: `Attributes (${o.attributes.length})`, icon: "▤"},
          o.attributes.length ? h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table mdv-table"},
              h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Type"), h("th", null, "Default"))),
              h("tbody", null, o.attributes.map((a, i) => h("tr", {key: i},
                h("td", {className: "ff-mono"}, a.name), h("td", null, a.type), h("td", {className: "ff-mono"}, a.default || "")))))) : h("div", {className: "insp-meta"}, "No attributes."))),
      h(Section, {title: "Handlers & events", icon: "⚡"},
        h(Chips, {items: [...o.handlers.map(x => ({label: `on ${x.name} → ${x.action || ""}`, tone: "info"})), ...o.events.map(e => ({label: `fires ${e.name}`}))],
          empty: "None."})),
      h(Section, {title: "Controller actions", icon: "ƒ"}, h(Chips, {items: o.actions, empty: "No controller."})),
      h(Section, {title: "Uses components", icon: "🧩"}, h(Chips, {items: o.children.map(c => ({label: `<${c.name}>`, count: c.count}))}))),
    tab === "files" && h(FileBrowser, {folder: `aura/${row.DeveloperName}`, files: st.data, active, onPick: setActive}));
}

// ─── Validation rule ─────────────────────────────────────────────────
const RULE_KEYS = ["active", "description", "errorConditionFormula", "errorDisplayField", "errorMessage"];

async function saveRule(id, meta) {
  const body = {};
  for (const k of RULE_KEYS) if (meta[k] != null && meta[k] !== "") body[k] = meta[k];
  body.active = !!meta.active;
  await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/ValidationRule/${encodeURIComponent(id)}`,
    {method: "PATCH", useCache: false, body: {Metadata: body}});
}

function RuleAiBox({object, current, onResult}) {
  const [ask, setAsk] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const run = async () => {
    if (!hasValidConfig()) { setError("AI needs a provider + API key (Settings)."); return; }
    setBusy(true);
    setError(null);
    try { onResult(await validationRuleFromText(object, ask, {current})); }
    catch (e) { setError(e.message === "NO_LLM_CONFIG" ? "AI needs a provider + API key (Settings)." : e.message); }
    finally { setBusy(false); }
  };
  return h("div", {className: "mdv-ai"},
    h("div", {className: "mdv-ai-h"}, "✨ Use AI"),
    h("div", {className: "soql-save-row"},
      h("input", {className: "soql-save-input", value: ask, "aria-label": "Describe the rule",
        placeholder: current ? "Describe the change, e.g. also allow System Administrators to skip it" : "e.g. Close date can't be in the past when stage is Closed Won",
        onChange: e => setAsk(e.target.value), onKeyDown: e => { if (e.key === "Enter" && ask.trim() && !busy) run(); }}),
      h("button", {className: "btn btn-primary btn-sm", disabled: !ask.trim() || busy || !object, onClick: run}, busy ? "Writing…" : "✨ Write rule")),
    !object && h("div", {className: "insp-meta"}, "Pick the object first."),
    error && h("div", {className: "insp-error"}, error));
}

function RuleView({row, onSource, onChanged}) {
  const object = (row.EntityDefinition && row.EntityDefinition.QualifiedApiName) || "";
  const [reload, setReload] = React.useState(0);
  const st = useLoad(async () => {
    const [meta, d] = await Promise.all([
      queryAll(byId("Metadata FROM ValidationRule", row.Id), tooling).then(r => (r[0] || {}).Metadata || {}),
      ffDescribeObject(object).catch(() => null),
    ]);
    return {meta, fields: d ? d.fields || [] : []};
  }, [row.Id, reload]);
  const [edit, setEdit] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [aiNote, setAiNote] = React.useState(null);
  const managed = !!row.NamespacePrefix;

  React.useEffect(() => {
    if (!st.data) return;
    const m = st.data.meta;
    onSource([`Object: ${object}`, `Active: ${m.active ? "yes" : "no"}`, `Formula (TRUE blocks the save): ${m.errorConditionFormula}`,
      `Error message: ${m.errorMessage}`, `Shown on: ${m.errorDisplayField || "top of page"}`, m.description ? `Description: ${m.description}` : ""].filter(Boolean).join("\n"));
  }, [st.data, object, onSource]);
  React.useEffect(() => { setEdit(null); setMsg(null); setErr(null); setAiNote(null); }, [row.Id]);

  if (!st.data) return h(LoadState, {state: st});
  const {meta, fields} = st.data;
  const labelOf = api => {
    const f = fields.find(x => x.name.toLowerCase() === String(api).toLowerCase());
    return f ? f.label : null;
  };
  const save = async (next, note) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveRule(row.Id, next);
      setMsg(note);
      setEdit(null);
      setAiNote(null);
      setReload(n => n + 1);
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const view = edit || meta;
  const used = formulaFields(view.errorConditionFormula);
  const fns = formulaFunctions(view.errorConditionFormula);
  const showOn = view.errorDisplayField ? `${labelOf(view.errorDisplayField) || view.errorDisplayField}` : "Top of the page";

  return h("div", {className: "mdv-rule"},
    h("div", {className: "mdv-rule-bar"},
      h("label", {className: "sq3-toggle", title: managed ? "Managed package rules can't be changed" : "Turn the rule on or off"},
        h("span", {className: "sq3-toggle-lbl"}, "Active"),
        h("span", {className: "sq3-switch"},
          h("input", {type: "checkbox", checked: !!meta.active, disabled: managed || busy || !!edit,
            onChange: e => save({...meta, active: e.target.checked}, e.target.checked ? "Rule activated." : "Rule deactivated.")}),
          h("span", {className: "sq3-slider"}))),
      h("span", {className: "md-chip-mini"}, object),
      managed && h("span", {className: "md-chip-mini", title: "Part of a managed package"}, "🔒 managed · " + row.NamespacePrefix),
      !edit && !managed && h("button", {className: "btn btn-secondary btn-sm mdv-push", onClick: () => { setEdit({...meta}); setMsg(null); }}, "✎ Edit rule")),
    msg && h("div", {className: "insp-status-ok"}, msg),
    err && h("div", {className: "insp-error"}, err),
    edit && h(RuleAiBox, {object, current: edit.errorConditionFormula, onResult: r => {
      setEdit(x => ({...x, errorConditionFormula: r.formula, errorMessage: r.errorMessage || x.errorMessage,
        errorDisplayField: r.errorDisplayField || x.errorDisplayField, description: r.description || x.description}));
      setAiNote(r.explanation);
    }}),
    aiNote && h("div", {className: "insp-fix-why mdv-ai-note"}, "✨ " + aiNote),
    h("div", {className: "mdv-grid"},
      h("div", {className: "mdv-wide"},
        h(Section, {title: "Blocks the save when this is TRUE", icon: "⛔"},
          edit
            ? h("textarea", {className: "mdn-input mdn-code mdv-formula-in", rows: 5, value: edit.errorConditionFormula || "", spellCheck: false,
                "aria-label": "Error condition formula", onChange: e => setEdit({...edit, errorConditionFormula: e.target.value})})
            : h("pre", {className: "mdv-formula", dangerouslySetInnerHTML: {__html: formulaHighlight(view.errorConditionFormula || "")}}),
          h("div", {className: "mdv-row mdv-gap"},
            h("span", {className: "insp-meta"}, "Fields"),
            h(Chips, {items: used.map(u => ({label: labelOf(u) && labelOf(u) !== u ? `${labelOf(u)} · ${u}` : u, tone: labelOf(u) || /\./.test(u) ? "info" : "warn",
              title: labelOf(u) ? u : `${u} is not a field on ${object} (a relationship, variable or typo)`})), empty: "—"})),
          fns.length > 0 && h("div", {className: "mdv-row mdv-gap"}, h("span", {className: "insp-meta"}, "Functions"), h(Chips, {items: fns})))),
      h(Section, {title: "What the user sees", icon: "👁️"},
        edit
          ? h("div", {className: "mdv-edit-col"},
              h("input", {className: "mdn-input", value: edit.errorMessage || "", "aria-label": "Error message", placeholder: "Error message",
                onChange: e => setEdit({...edit, errorMessage: e.target.value})}),
              h("select", {className: "mdn-input", value: edit.errorDisplayField || "", "aria-label": "Show error on",
                onChange: e => setEdit({...edit, errorDisplayField: e.target.value})},
                h("option", {value: ""}, "Top of the page"),
                fields.filter(f => f.updateable || f.createable).map(f => h("option", {key: f.name, value: f.name}, `${f.label} (${f.name})`))))
          : h("div", {className: "mdv-snag"},
              h("div", {className: "mdv-snag-h"}, "⚠ We hit a snag."),
              h("div", {className: "mdv-snag-m"}, view.errorMessage || "(no message)"),
              h("div", {className: "mdv-snag-f"}, "Shown on: ", h("b", null, showOn)))),
      h(Section, {title: "About", icon: "ℹ️"},
        edit
          ? h("textarea", {className: "mdn-input", rows: 3, value: edit.description || "", placeholder: "Description", "aria-label": "Description",
              onChange: e => setEdit({...edit, description: e.target.value})})
          : h("div", {className: "mdv-about"},
              h("div", null, view.description || h("span", {className: "insp-meta"}, "No description.")),
              h("div", {className: "insp-meta"}, `Status: ${meta.active ? "active" : "inactive"} · rule ${row.ValidationName}`)))),
    edit && h("div", {className: "mdn-foot"},
      h("span", {className: "insp-meta"}, "Saved straight to the org (Tooling API)."),
      h("div", {className: "mdn-foot-btns"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => { setEdit(null); setAiNote(null); }}, "Cancel"),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !String(edit.errorConditionFormula || "").trim() || !String(edit.errorMessage || "").trim(),
          onClick: () => save(edit, "Rule saved.")}, busy ? "Saving…" : "✓ Save rule"))));
}

export const DETAIL_VIEWS = {apex: ApexView, triggers: TriggerView, pages: PageView, lwc: LwcView, aura: AuraView, rules: RuleView};
export {CodeView, RuleAiBox};
