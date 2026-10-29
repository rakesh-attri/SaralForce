import {sfConn, apiVersion} from "../../inspector.js";
import {hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {escapeSoqlString} from "../../core/soql.js";
import {
  buildPackageXml, packageCount, togglePackageMember, erLayout,
  relationshipsFromDescribe, summarizeFlow, flowSteps
} from "../../core/metadata.js";
import {permSetDisplayName} from "../../core/access.js";
import {queryAll} from "../shared/query.js";
import {ffGetObjects, ffDescribeObject} from "../shared/describe.js";
import {apexHighlight} from "../shared/highlight.js";
import {downloadText} from "../shared/csv.js";
import {explainMetadata} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {fmtDateTime} from "../shared/format.js";
import {FFBadge} from "../shared/ui.js";
import {ffIcon, FF_I_DB} from "../shared/icons.js";
import {useFfSession, ffLoadJson, ffSaveJson} from "../shared/session-state.js";
import {deployDraft, orgApiVersions} from "../shared/metadata-deploy.js";
import {loadEditDraft, saveEditDraft} from "../shared/metadata-save.js";
import {EDITABLE_KINDS, SANDBOX_ONLY_NOTE, changedFiles} from "../../core/edit-draft.js";
import {confirmDialog} from "../../ui/confirm.js";
import {NewDialog, DraftEditor, withOriginals, fileIcon} from "./metadata-new.js";
import {CmdtDetail} from "./metadata-cmdt.js";
import {DETAIL_VIEWS} from "./metadata-views.js";
import {openMetadataInTab, metadataTargetFromUrl, isInspectorTab} from "../shared/inspector-tab.js";

// True when this page is the inspector opened in its own browser tab.
const inTab = isInspectorTab();
import {listCmdtTypes} from "../shared/cmdt-data.js";

const h = React.createElement;

const ns = r => (r.NamespacePrefix ? r.NamespacePrefix + "__" : "");
const byId = (obj, id) => `SELECT ${obj} WHERE Id = '${escapeSoqlString(id)}'`;

// One entry per metadata kind: Tooling API list query, display, how to read
// the source, the package.xml type/member and the Setup page.
const KINDS = [
  {
    id: "apex", icon: "</>", tone: "apex", label: "Apex", type: "ApexClass", lang: "apex",
    list: "SELECT Id, Name, ApiVersion, Status, NamespacePrefix, LengthWithoutComments, LastModifiedDate, LastModifiedBy.Name FROM ApexClass ORDER BY Name",
    name: r => ns(r) + r.Name,
    sub: r => `v${r.ApiVersion} · ${r.Status}${r.LengthWithoutComments ? ` · ${r.LengthWithoutComments} chars` : ""}`,
    source: async r => ((await queryAll(byId("Body FROM ApexClass", r.Id), {tooling: true}))[0] || {}).Body,
    setup: r => `/lightning/setup/ApexClasses/page?address=%2F${r.Id}`,
  },
  {
    id: "triggers", icon: "⚡", tone: "trigger", label: "Triggers", type: "ApexTrigger", lang: "apex",
    list: "SELECT Id, Name, ApiVersion, Status, TableEnumOrId, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ApexTrigger ORDER BY Name",
    name: r => ns(r) + r.Name,
    sub: r => `${r.TableEnumOrId || ""} · ${r.Status}`,
    source: async r => ((await queryAll(byId("Body FROM ApexTrigger", r.Id), {tooling: true}))[0] || {}).Body,
    setup: r => `/lightning/setup/ApexTriggers/page?address=%2F${r.Id}`,
  },
  {
    id: "pages", icon: "<>", tone: "page", label: "Visualforce", type: "ApexPage", lang: "markup",
    list: "SELECT Id, Name, MasterLabel, ApiVersion, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ApexPage ORDER BY Name",
    name: r => ns(r) + r.Name,
    sub: r => `${r.MasterLabel || ""} · v${r.ApiVersion}`,
    source: async r => ((await queryAll(byId("Markup FROM ApexPage", r.Id), {tooling: true}))[0] || {}).Markup,
    setup: r => `/lightning/setup/ApexPages/page?address=%2F${r.Id}`,
  },
  {
    id: "lwc", icon: "⚛", tone: "lwc", label: "LWC", type: "LightningComponentBundle", lang: "markup",
    list: "SELECT Id, DeveloperName, MasterLabel, ApiVersion, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle ORDER BY DeveloperName",
    name: r => ns(r) + r.DeveloperName,
    sub: r => `${r.MasterLabel || ""} · v${r.ApiVersion}`,
    source: async r => (await queryAll(
      `SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${escapeSoqlString(r.Id)}'`, {tooling: true}))
      .map(f => `// ── ${f.FilePath} ──\n${f.Source || ""}`).join("\n\n"),
    setup: () => "/lightning/setup/LightningComponentBundles/home",
  },
  {
    id: "aura", icon: "✦", tone: "aura", label: "Aura", type: "AuraDefinitionBundle", lang: "markup",
    list: "SELECT Id, DeveloperName, MasterLabel, ApiVersion, NamespacePrefix, LastModifiedDate FROM AuraDefinitionBundle ORDER BY DeveloperName",
    name: r => ns(r) + r.DeveloperName,
    sub: r => `${r.MasterLabel || ""} · v${r.ApiVersion}`,
    source: async r => (await queryAll(
      `SELECT DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${escapeSoqlString(r.Id)}'`, {tooling: true}))
      .map(f => `// ── ${f.DefType} ──\n${f.Source || ""}`).join("\n\n"),
    setup: () => "/lightning/setup/LightningComponents/home",
  },
  {
    id: "flows", icon: "⇢", tone: "flow", label: "Flows", type: "Flow", lang: "text",
    list: "SELECT Id, DeveloperName, MasterLabel, ActiveVersionId, LatestVersionId, ActiveVersion.VersionNumber, LatestVersion.VersionNumber, NamespacePrefix, LastModifiedDate FROM FlowDefinition ORDER BY DeveloperName",
    name: r => ns(r) + r.DeveloperName,
    sub: r => {
      const active = r.ActiveVersion && r.ActiveVersion.VersionNumber;
      const latest = r.LatestVersion && r.LatestVersion.VersionNumber;
      return active ? `Active v${active}${latest && latest !== active ? ` · latest v${latest}` : ""}` : `Inactive${latest ? ` · latest v${latest}` : ""}`;
    },
    versions: r => queryAll(`SELECT Id, VersionNumber, Status, ProcessType, LastModifiedDate FROM Flow WHERE DefinitionId = '${escapeSoqlString(r.Id)}' ORDER BY VersionNumber DESC`, {tooling: true}),
    // Full Flow metadata of a version (active one by default).
    meta: async (r, versionId) => {
      const vid = versionId || r.ActiveVersionId || r.LatestVersionId;
      if (!vid) return null;
      return ((await queryAll(byId("Metadata FROM Flow", vid), {tooling: true}))[0] || {}).Metadata || null;
    },
    source: async () => "",
    setup: r => `/builder_platform_interaction/flowBuilder.app?flowId=${r.ActiveVersionId || r.LatestVersionId || ""}`,
  },
  {
    id: "rules", icon: "✓", tone: "rule", label: "Validation Rules", type: "ValidationRule", lang: "text",
    list: "SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName, ErrorMessage, NamespacePrefix, LastModifiedDate FROM ValidationRule",
    name: r => `${(r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || "?"}.${ns(r)}${r.ValidationName}`,
    sub: r => `${r.Active ? "Active" : "Inactive"} · ${r.ErrorMessage || ""}`,
    source: async r => {
      const meta = ((await queryAll(byId("Metadata FROM ValidationRule", r.Id), {tooling: true}))[0] || {}).Metadata || {};
      return [`Formula (true = error):\n${meta.errorConditionFormula || "?"}`,
        `Error message: ${meta.errorMessage || r.ErrorMessage || ""}`,
        meta.errorDisplayField ? `Shown on field: ${meta.errorDisplayField}` : "",
        meta.description ? `Description: ${meta.description}` : ""].filter(Boolean).join("\n\n");
    },
    setup: r => `/lightning/setup/ObjectManager/${(r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || ""}/ValidationRules/${r.Id}/view`,
  },
  {
    id: "cmdt", icon: "⚙", tone: "cmdt", label: "Custom Metadata", type: "CustomObject", lang: "text",
    load: () => listCmdtTypes(),
    name: r => r.name,
    sub: r => r.label,
    source: async () => "",
    setup: () => "/lightning/setup/CustomMetadata/home",
  },
];

function setupUrl(path) {
  return "https://" + sfConn.instanceHostname + path;
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function SourceView({text, lang}) {
  const html = lang === "apex" ? apexHighlight(text) : escHtml(text);
  return h("div", {className: "soql-editor-box md-src-box"},
    h("pre", {className: "md-src"}, h("code", {dangerouslySetInnerHTML: {__html: html}})));
}

function useAiExplain() {
  const [state, setState] = React.useState(null); // {busy} | {text} | {error}
  const [copied, setCopied] = React.useState(false);
  const run = async (kind, name, source) => {
    if (!hasValidConfig()) { setState({error: "NO_LLM_CONFIG"}); return; }
    setState({busy: true});
    try { setState({text: await explainMetadata(kind, name, source)}); }
    catch (e) { setState({error: e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message}); }
  };
  const view = state && (state.busy
    ? h("div", {className: "insp-status-info"}, "Asking the AI…")
    : state.error === "NO_LLM_CONFIG"
    ? h("div", {className: "insp-warn"}, "AI explain needs a provider + API key. ",
        h("button", {className: "field-action-btn", onClick: () => {
          try { chrome.runtime.sendMessage({message: "openOptions", host: ""}); } catch (e) { /* ignore */ }
        }}, "Open Settings"))
    : state.error
    ? h("div", {className: "insp-error"}, "AI request failed: " + state.error)
    : h(AnalysisReport, {text: state.text, copied, onCopy: () => {
        try { safeCopyText(state.text); } catch (e) { /* ignore */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}));
  return {run, reset: () => setState(null), busy: !!(state && state.busy), view};
}

// ─── Flow: start card, then numbered steps with branches ────────────
function FlowStepsView({steps}) {
  const step = (s, i, muted) => h("li", {key: s.name, className: "md-flow-step" + (muted ? " muted" : "")},
    h("div", {className: "md-flow-node t-" + s.type},
      h("span", {className: "md-flow-ico", "aria-hidden": "true"}, s.icon),
      h("div", {className: "md-flow-tx"},
        h("div", {className: "md-flow-h"},
          !muted && h("span", {className: "md-flow-num"}, i + 1),
          h("span", {className: "md-flow-label"}, s.label),
          h("span", {className: "md-flow-type"}, s.typeLabel)),
        s.details.map((d, j) => h("div", {key: j, className: "md-flow-detail"}, d)),
        s.next.length > 1 || (s.next[0] && s.next[0].label)
          ? h("ul", {className: "md-flow-branches"}, s.next.map((n, j) => h("li", {key: j},
              h("span", {className: "md-flow-branch"}, n.label || "Then"), " → ", h("b", null, n.targetLabel))))
          : s.next[0] && h("div", {className: "md-flow-detail md-flow-then"}, "Then → ", h("b", null, s.next[0].targetLabel)))));
  return h("div", {className: "md-flow"},
    h("div", {className: "md-flow-start"},
      h("span", {className: "md-flow-ico", "aria-hidden": "true"}, "▶"),
      h("div", {className: "md-flow-tx"},
        h("div", {className: "md-flow-h"}, h("span", {className: "md-flow-label"}, "Start"),
          h("span", {className: "md-flow-type"}, steps.processType === "Flow" ? "Screen flow" : steps.processType)),
        steps.start.details.map((d, j) => h("div", {key: j, className: "md-flow-detail"}, d)),
        h("div", {className: "md-flow-detail md-flow-then"}, "Then → ", h("b", null, steps.start.next)))),
    steps.steps.length
      ? h("ol", {className: "md-flow-list"}, steps.steps.map((s, i) => step(s, i)))
      : h("div", {className: "insp-meta"}, "This flow has no elements yet."),
    steps.unreachable.length > 0 && h("details", {className: "acc-section"},
      h("summary", null, `Not connected (${steps.unreachable.length})`),
      h("ol", {className: "md-flow-list"}, steps.unreachable.map((s, i) => step(s, i, true)))),
    h("div", {className: "md-flow-end"}, "■ End"));
}

function flowAiText(steps, summary) {
  const lines = [summary, "", "Path:"];
  steps.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.typeLabel}: ${s.label}${s.details.length ? " — " + s.details.join("; ") : ""}`);
    for (const n of s.next) if (n.label) lines.push(`   ${n.label} → ${n.targetLabel}`);
  });
  return lines.join("\n");
}

// ─── Component detail (header, overview/source, versions, explain) ───
function ComponentDetail({kind, row, pkg, onTogglePkg, onChanged, onEdit}) {
  const View = DETAIL_VIEWS[kind.id];
  const [source, setSource] = React.useState(null);

  const [meta, setMeta] = React.useState(null);
  const [versions, setVersions] = React.useState(null);
  const [versionId, setVersionId] = React.useState(null);
  const [view, setView] = React.useState(kind.meta ? "steps" : "source");
  const [error, setError] = React.useState(null);
  const ai = useAiExplain();
  const name = kind.name(row);
  const inPkg = (pkg[kind.type] || []).includes(name);

  React.useEffect(() => {
    setVersionId(null);
    setView(kind.meta ? "steps" : "source");
    setVersions(null);
    ai.reset();
    if (kind.versions) kind.versions(row).then(setVersions).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind.id, row.Id]);

  React.useEffect(() => {
    let stale = false;
    setSource(null);
    setMeta(null);
    setError(null);
    if (View) return undefined;
    const load = kind.meta
      ? kind.meta(row, versionId).then(m => {
        if (stale) return;
        setMeta(m);
        setSource(m ? flowAiText(flowSteps(m), summarizeFlow(m)) : "");
      })
      : kind.source(row).then(s => { if (!stale) setSource(s || ""); });
    load.catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind.id, row.Id, versionId]);

  const steps = meta ? flowSteps(meta) : null;
  const status = row.Status || (row.Active === true ? "Active" : row.Active === false ? "Inactive" : null) ||
    (kind.id === "flows" ? (row.ActiveVersionId ? "Active" : "Inactive") : null);
  const views = kind.meta
    ? [["steps", "Steps"], ["source", "Outline"], ["json", "Metadata JSON"]]
    : [["source", "Source"]];

  return h("div", {className: "sq3-card md-detail"},
    h("div", {className: "md-detail-head"},
      h("span", {className: "md-kind-tile t-" + kind.tone, "aria-hidden": "true"}, kind.icon),
      h("div", {className: "md-detail-tx"},
        h("div", {className: "md-detail-name"}, name,
          status && h(FFBadge, {kind: /^(Active)$/.test(status) ? "ok" : "off"}, status),
          row.ApiVersion && h("span", {className: "md-chip-mini"}, "API " + row.ApiVersion)),
        h("div", {className: "sq3-card-sub"}, kind.sub(row),
          row.LastModifiedDate ? ` · modified ${fmtDateTime(row.LastModifiedDate)}` : "",
          row.LastModifiedBy && row.LastModifiedBy.Name ? ` by ${row.LastModifiedBy.Name}` : ""))),
    h("div", {className: "md-actions"},
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: !source || ai.busy,
        onClick: () => ai.run(kind.label, name, source)
      }, ai.busy ? "Explaining…" : "✨ Explain"),
      onEdit && EDITABLE_KINDS.includes(kind.id) && !row.NamespacePrefix && h("button", {
        className: "btn btn-primary btn-sm",
        title: kind.id === "apex" || kind.id === "triggers"
          ? "Open the code in the editor, change it yourself or with AI, then save it back. " + SANDBOX_ONLY_NOTE
          : "Open the files in the editor, change them yourself or with AI, then save them back to the org.",
        onClick: () => onEdit(row)
      }, "✏️ Edit"),
      h("a", {className: "btn btn-secondary btn-sm", href: setupUrl(kind.setup(row)), target: "_blank", rel: "noreferrer"},
        kind.id === "flows" ? "Open in Flow Builder ↗" : "Open in Setup ↗"),
      h("button", {className: "btn btn-secondary btn-sm", onClick: () => onTogglePkg(kind.type, name)},
        inPkg ? "✓ In package.xml" : "＋ package.xml"),
      source && !kind.meta && h("button", {className: "btn btn-secondary btn-sm", onClick: () => safeCopyText(source)}, "Copy source"),
      !inTab && h("button", {
        className: "btn btn-secondary btn-sm",
        title: "Open the inspector in a new browser tab on this item",
        onClick: () => openMetadataInTab(kind.id, row.Id)
      }, "⛶ Full screen ↗")),
    ai.view,
    versions && versions.length > 0 && h("div", {className: "md-versions"},
      h("span", {className: "insp-meta"}, "Version"),
      versions.map(v => {
        const on = versionId ? versionId === v.Id : v.Id === (row.ActiveVersionId || row.LatestVersionId);
        return h("button", {
          key: v.Id,
          className: "sq3-pill" + (on ? " active" : ""),
          title: `${v.Status} · ${v.ProcessType || ""} · ${fmtDateTime(v.LastModifiedDate)}`,
          onClick: () => setVersionId(v.Id)
        }, `v${v.VersionNumber}`, v.Status === "Active" ? " ●" : "");
      })),
    views.length > 1 && h("div", {className: "sq3-pills md-views", role: "tablist"},
      views.map(([id, label]) => h("button", {
        key: id, role: "tab", "aria-selected": view === id,
        className: "sq3-pill" + (view === id ? " active" : ""), onClick: () => setView(id)
      }, label))),
    View && h(View, {key: row.Id, row, kind, onSource: setSource, onChanged}),
    !View && error && h("div", {className: "insp-error"}, "Could not read it: " + error),
    !View && source == null && !error && h("div", {className: "insp-meta"}, "Loading…"),
    !View && source != null && !error && (
      view === "steps" && steps ? h(FlowStepsView, {steps})
      : view === "json" && meta ? h(SourceView, {text: JSON.stringify(meta, null, 2), lang: "text"})
      : source ? h(SourceView, {text: kind.meta && meta ? summarizeFlow(meta) : source, lang: kind.lang})
      : h("div", {className: "insp-meta"}, "No source available (managed or empty).")));
}
// ─── Object schema: fields, field access, where used, ER diagram ────
function ErDiagram({describe, onOpen}) {
  const {parents, children} = relationshipsFromDescribe(describe);
  const l = erLayout(describe.name, parents, children);
  return h("div", {className: "md-er-wrap"},
    h("svg", {className: "md-er", viewBox: `0 0 ${l.width} ${l.height}`, width: l.width, height: l.height, role: "img",
      "aria-label": `Relationships of ${describe.name}`},
      l.edges.map((e, i) => h("g", {key: "e" + i, className: "md-er-edge"},
        h("line", {x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2}),
        h("text", {x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 - 4, textAnchor: "middle"}, e.label))),
      l.boxes.map((b, i) => h("g", {
        key: "b" + i,
        className: "md-er-box md-er-" + b.role,
        role: b.role === "center" ? undefined : "button",
        tabIndex: b.role === "center" ? undefined : 0,
        onClick: b.role === "center" ? undefined : () => onOpen(b.name),
        onKeyDown: b.role === "center" ? undefined : e => { if (e.key === "Enter") onOpen(b.name); }
      },
        h("title", null, b.role === "parent" ? `${describe.name}.${b.via} → ${b.name}` : b.role === "child" ? `${b.name} via ${b.via}` : b.name),
        h("rect", {x: b.x, y: b.y, width: b.w, height: b.h, rx: 6}),
        h("text", {x: b.x + b.w / 2, y: b.y + b.h / 2 + 4, textAnchor: "middle"},
          b.name.length > 24 ? b.name.slice(0, 23) + "…" : b.name)))),
    h("div", {className: "insp-meta"},
      `Lookups on the left (${parents.length}), child relationships on the right (${children.length}). Click an object to open it.` +
      (l.hiddenParents || l.hiddenChildren ? ` ${l.hiddenParents + l.hiddenChildren} more not drawn.` : "")));
}

function fieldDetails(f) {
  const bits = [];
  if (["string", "textarea", "email", "phone", "url", "encryptedstring"].includes(f.type) && f.length) bits.push(`length ${f.length}`);
  if (["double", "currency", "percent"].includes(f.type)) bits.push(`${f.precision || 0},${f.scale || 0}`);
  if (f.nillable === false && f.createable) bits.push("required");
  if (f.unique) bits.push("unique");
  if (f.externalId) bits.push("external id");
  if (f.referenceTo && f.referenceTo.length) bits.push("→ " + f.referenceTo.join(", "));
  if (f.calculatedFormula) bits.push("formula: " + f.calculatedFormula.replace(/\s+/g, " ").slice(0, 80));
  if (f.picklistValues && f.picklistValues.length) {
    const vals = f.picklistValues.filter(v => v.active !== false).map(v => v.value);
    bits.push(vals.slice(0, 5).join(" | ") + (vals.length > 5 ? ` … (${vals.length})` : ""));
  }
  return bits.join(" · ");
}

async function fieldAccessRows(obj, field) {
  return queryAll("SELECT Parent.Label, Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, Parent.Type, " +
    "PermissionsRead, PermissionsEdit FROM FieldPermissions " +
    `WHERE SobjectType = '${escapeSoqlString(obj)}' AND Field = '${escapeSoqlString(obj + "." + field)}'`);
}

async function whereUsed(obj, field) {
  // ns__Field__c / Field__c → DeveloperName "Field".
  const dev = field.replace(/__c$/, "").split("__").pop();
  const ent = await queryAll(`SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${escapeSoqlString(obj)}'`, {tooling: true});
  const tables = [obj, ...ent.map(e => e.DurableId)].map(t => `'${escapeSoqlString(t)}'`).join(",");
  const cf = await queryAll(`SELECT Id FROM CustomField WHERE TableEnumOrId IN (${tables}) AND DeveloperName = '${escapeSoqlString(dev)}'`, {tooling: true});
  if (!cf.length) throw new Error("Field not found in the Tooling API.");
  return queryAll("SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency " +
    `WHERE RefMetadataComponentId = '${escapeSoqlString(cf[0].Id)}'`, {tooling: true});
}

function SchemaView({pkg, onTogglePkg}) {
  const [objects, setObjects] = React.useState([]);
  const [objName, setObjName] = useFfSession("metadata", "schemaObj", "Account");
  const [input, setInput] = React.useState(objName);
  const [describe, setDescribe] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [view, setView] = React.useState("fields");
  const [filter, setFilter] = React.useState("");
  const [picked, setPicked] = React.useState(null); // {field, access, used, …}

  React.useEffect(() => { ffGetObjects().then(setObjects).catch(() => {}); }, []);
  React.useEffect(() => {
    let stale = false;
    setDescribe(null);
    setError(null);
    setPicked(null);
    if (!objName) return undefined;
    ffDescribeObject(objName).then(d => { if (!stale) setDescribe(d); }).catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [objName]);

  const open = name => { setInput(name); setObjName(name); setView("fields"); };
  const inspectField = async (f, what) => {
    setPicked({field: f.name, what, loading: true});
    try {
      if (what === "access") {
        const rows = await fieldAccessRows(objName, f.name);
        setPicked({field: f.name, what, rows: rows.map(r => ({
          name: permSetDisplayName(r.Parent), read: r.PermissionsRead, edit: r.PermissionsEdit
        })).sort((a, b) => a.name.localeCompare(b.name))});
      } else {
        const rows = await whereUsed(objName, f.name);
        setPicked({field: f.name, what, rows});
      }
    } catch (e) {
      setPicked({field: f.name, what, error: e.message});
    }
  };
  const downloadSchema = () => {
    const out = {
      name: describe.name, label: describe.label, labelPlural: describe.labelPlural, custom: describe.custom, keyPrefix: describe.keyPrefix,
      fields: describe.fields.map(f => ({
        name: f.name, label: f.label, type: f.type, length: f.length || undefined, precision: f.precision || undefined,
        scale: f.scale || undefined, required: f.nillable === false && f.createable, unique: f.unique || undefined,
        externalId: f.externalId || undefined, referenceTo: f.referenceTo && f.referenceTo.length ? f.referenceTo : undefined,
        relationshipName: f.relationshipName || undefined, formula: f.calculatedFormula || undefined,
        picklistValues: f.picklistValues && f.picklistValues.length ? f.picklistValues.map(v => v.value) : undefined,
        inlineHelpText: f.inlineHelpText || undefined,
      })),
      childRelationships: (describe.childRelationships || []).filter(r => r.relationshipName)
        .map(r => ({relationshipName: r.relationshipName, childSObject: r.childSObject, field: r.field})),
    };
    downloadText(`${describe.name}.schema.json`, JSON.stringify(out, null, 2));
  };
  const t = filter.trim().toLowerCase();
  const fields = describe ? describe.fields.filter(f => !t || f.name.toLowerCase().includes(t) ||
    String(f.label || "").toLowerCase().includes(t) || f.type.includes(t)) : [];
  const inPkg = describe && (pkg.CustomObject || []).includes(describe.name);

  return h("div", {className: "sq3-card"},
    h("div", {className: "sq3-card-h"},
      h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DB)),
      h("span", {className: "sq3-card-t"}, "Object Schema")),
    h("div", {className: "soql-save-row acc-pick-row"},
      h("input", {
        className: "soql-save-input",
        value: input,
        list: "md-schema-objects",
        placeholder: "Object API name, e.g. Account",
        "aria-label": "Object API name",
        onChange: e => setInput(e.target.value),
        onKeyDown: e => { if (e.key === "Enter" && input.trim()) open(input.trim()); }
      }),
      h("datalist", {id: "md-schema-objects"}, objects.slice(0, 2000).map(o => h("option", {key: o.name, value: o.name}, o.label))),
      h("button", {className: "btn btn-primary btn-sm", disabled: !input.trim(), onClick: () => open(input.trim())}, "Open")),
    error && h("div", {className: "insp-error"}, error),
    !describe && !error && h("div", {className: "insp-meta"}, "Loading…"),
    describe && h("div", null,
      h("div", {className: "sq3-card-sub"},
        `${describe.label} · ${describe.name}${describe.keyPrefix ? ` · prefix ${describe.keyPrefix}` : ""} · ` +
        `${describe.fields.length} fields${describe.custom ? " · custom" : ""}`),
      h("div", {className: "user-actions"},
        h("a", {className: "btn btn-secondary btn-sm", href: setupUrl(`/lightning/setup/ObjectManager/${describe.name}/Details/view`),
          target: "_blank", rel: "noreferrer"}, "Open in Object Manager"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => onTogglePkg("CustomObject", describe.name)},
          inPkg ? "✓ In package.xml" : "Add to package.xml"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: downloadSchema}, "Download schema JSON"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          title: "Copy a SELECT with every field",
          onClick: () => safeCopyText(`SELECT ${describe.fields.map(f => f.name).join(", ")} FROM ${describe.name} LIMIT 200`)
        }, "Copy SOQL")),
      h("div", {className: "sq3-pills", role: "group", "aria-label": "Schema view"},
        [["fields", "Fields"], ["er", "Relationships"]].map(([id, label]) => h("button", {
          key: id, className: "sq3-pill" + (view === id ? " active" : ""), onClick: () => setView(id)
        }, label))),
      view === "er" && h(ErDiagram, {describe, onOpen: open}),
      view === "fields" && h("div", null,
        h("input", {
          className: "soql-save-input md-filter",
          value: filter,
          placeholder: "filter fields…",
          "aria-label": "Filter fields",
          onChange: e => setFilter(e.target.value)
        }),
        h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null, h("tr", null,
              h("th", null, "Field"), h("th", null, "Label"), h("th", null, "Type"), h("th", null, "Details"), h("th", null, ""))),
            h("tbody", null, fields.map(f => h("tr", {key: f.name, className: picked && picked.field === f.name ? "acc-diff" : ""},
              h("td", {className: "ff-mono"}, f.name),
              h("td", null, f.label),
              h("td", null, f.type),
              h("td", {title: f.calculatedFormula || f.inlineHelpText || ""}, fieldDetails(f)),
              h("td", {className: "md-row-actions"},
                h("button", {className: "field-action-btn", onClick: () => inspectField(f, "access")}, "Access"),
                f.custom && h("button", {className: "field-action-btn", onClick: () => inspectField(f, "used")}, "Where used"))))))),
        picked && h("div", {className: "md-picked"},
          h("div", {className: "sq3-card-sub"},
            `${picked.what === "access" ? "Field access" : "Where used"} · ${describe.name}.${picked.field}`),
          picked.loading && h("div", {className: "insp-meta"}, "Loading…"),
          picked.error && h("div", {className: "insp-error"}, picked.error),
          picked.rows && !picked.rows.length && h("div", {className: "insp-meta"}, picked.what === "access"
            ? "No profile or permission set grants explicit access (required fields are always visible)."
            : "Nothing references this field."),
          picked.rows && picked.rows.length > 0 && h("div", {className: "usr-kv"},
            picked.what === "access"
              ? picked.rows.map((r, i) => h("div", {key: i, className: "usr-kv-row"},
                  h("span", {className: "usr-kv-v"}, r.name),
                  h("span", {className: "usr-kv-k"}, r.edit ? "Read & edit" : r.read ? "Read only" : "No access")))
              : picked.rows.map((r, i) => h("div", {key: i, className: "usr-kv-row"},
                  h("span", {className: "usr-kv-v"}, r.MetadataComponentName),
                  h("span", {className: "usr-kv-k"}, r.MetadataComponentType))))))));
}

// ─── Metadata tab ────────────────────────────────────────────────────
const DRAFTS_KEY = "ff_md_drafts";

function MetadataTab() {
  const [kindId, setKindId] = useFfSession("metadata", "kind", "apex");
  const [lists, setLists] = React.useState({});
  const [errors, setErrors] = React.useState({});
  const [filter, setFilter] = React.useState("");
  const [selId, setSelId] = React.useState(null);
  const [pkg, setPkg] = useFfSession("metadata", "pkg", {});
  const [drafts, setDraftsState] = React.useState(() => ffLoadJson(DRAFTS_KEY, []));
  const [draftId, setDraftId] = React.useState(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [versions, setVersions] = React.useState([apiVersion]);
  const [objects, setObjects] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [deployErr, setDeployErr] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const kind = KINDS.find(k => k.id === kindId);

  // Opened via "Full screen": select the kind and item named in the URL once.
  React.useEffect(() => {
    const t = metadataTargetFromUrl();
    if (!t || (!KINDS.some(k => k.id === t.kind) && t.kind !== "schema")) return;
    setKindId(t.kind);
    if (!t.id) return;
    if (drafts.some(d => d.id === t.id)) setDraftId(t.id);
    else setSelId(t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDrafts = next => { setDraftsState(next); ffSaveJson(DRAFTS_KEY, next); };

  React.useEffect(() => {
    if (!kind || lists[kind.id] || errors[kind.id]) return;
    (kind.load ? kind.load() : queryAll(kind.list, {tooling: true}))
      .then(rows => {
        const sorted = rows.slice().sort((a, b) => kind.name(a).localeCompare(kind.name(b)));
        setLists(l => ({...l, [kind.id]: sorted}));
      })
      .catch(e => setErrors(x => ({...x, [kind.id]: e.message})));
  }, [kind, lists, errors]);

  // Re-read one kind's list in place (after a change), keeping the selection.
  const refreshKind = id => {
    const k = KINDS.find(x => x.id === id);
    if (!k) return;
    (k.load ? k.load() : queryAll(k.list, {tooling: true}))
      .then(rows => setLists(l => ({...l, [id]: rows.slice().sort((a, b) => k.name(a).localeCompare(k.name(b)))})))
      .catch(() => {});
  };

  const openNew = () => {
    setDeployErr(null);
    setNotice(null);
    setNewOpen(true);
    orgApiVersions().then(setVersions).catch(() => {});
    if (!objects.length) ffGetObjects().then(setObjects).catch(() => {});
  };

  // Edit an existing component: load it into an edit draft (or reopen the
  // one already in progress for it).
  const [editErr, setEditErr] = React.useState(null);
  const [progress, setProgress] = React.useState(null);
  const startEdit = async row => {
    setEditErr(null);
    setNotice(null);
    setDeployErr(null);
    const open = drafts.find(d => d.mode === "edit" && d.existing && d.existing.id === row.Id);
    if (open) { setDraftId(open.id); return; }
    setBusy(true);
    try {
      const d = await loadEditDraft(kind.id, row);
      setDrafts([d, ...drafts]);
      setDraftId(d.id);
    } catch (e) {
      setEditErr(`Could not open ${kind.name(row)} for editing: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Save an edit draft back to the org (or compile-check it).
  const saveEdit = async (d, {checkOnly = false, force = false} = {}) => {
    const files = changedFiles(d);
    if (!checkOnly && !force) {
      const ok = await confirmDialog({
        title: `Save ${d.name} to the org?`,
        message: `${files.length} file(s) will be updated: ${files.map(f => f.path.split("/").pop()).join(", ")}.` +
          (d.kind === "apex" || d.kind === "triggers" ? "\n" + SANDBOX_ONLY_NOTE : ""),
        confirmLabel: "Save to org"
      });
      if (!ok) return;
    }
    setBusy(true);
    setDeployErr(null);
    setNotice(null);
    setProgress(checkOnly ? "Compiling…" : "Saving…");
    try {
      await saveEditDraft(d, {checkOnly, force, onProgress: setProgress});
      if (checkOnly) {
        setNotice(`${d.name} compiles cleanly. Nothing was saved.`);
      } else {
        setDrafts(drafts.filter(x => x.id !== d.id));
        setDraftId(null);
        setNotice(`Saved ${d.name} to the org (${files.length} file(s)).`);
        refreshKind(d.kind);
        setSelId(d.existing.id);
      }
    } catch (e) {
      if (e.code === "CONFLICT") {
        setBusy(false);
        setProgress(null);
        const ok = await confirmDialog({title: "Overwrite newer changes?", message: e.message, confirmLabel: "Overwrite", danger: true});
        if (ok) await saveEdit(d, {force: true});
        return;
      }
      setDeployErr(e.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // Deploy a draft (from the dialog or the editor), then show it in the list.
  const deploy = async (draft, fromDialog) => {
    setBusy(true);
    setDeployErr(null);
    setNotice(null);
    try {
      const res = await deployDraft(draft);
      setDrafts(drafts.filter(d => d.id !== draft.id));
      setNewOpen(false);
      setDraftId(null);
      setNotice(`Deployed ${res.name}.` + (draft.kind === "flows" ? " It is saved as a draft version; activate it in Flow Builder." : ""));
      setLists(l => ({...l, [draft.kind]: undefined}));
      setErrors(x => ({...x, [draft.kind]: undefined}));
      setKindId(draft.kind);
      setSelId(res.id);
    } catch (e) {
      setDeployErr(e.message);
      // A failed deploy from the dialog keeps the work as a draft.
      if (fromDialog) {
        const d = withOriginals(draft);
        setDrafts([d, ...drafts]);
        setNewOpen(false);
        setDraftId(d.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const rows = kind ? (lists[kind.id] || []) : [];
  const t = filter.trim().toLowerCase();
  const shown = rows.filter(r => !t || kind.name(r).toLowerCase().includes(t) || kind.sub(r).toLowerCase().includes(t));
  const kindDrafts = drafts.filter(d => d.kind === kindId);
  const draft = drafts.find(d => d.id === draftId);
  const sel = kind && !draft && rows.find(r => r.Id === selId);
  const count = packageCount(pkg);
  const onTogglePkg = (type, name) => setPkg(p => togglePackageMember(p, type, name));
  const pick = id => { setKindId(id); setSelId(null); setDraftId(null); setFilter(""); setDeployErr(null); };

  return h("div", {className: "insp-panel"},
    h("div", {className: "md-top"},
      h("div", {className: "md-kinds", role: "tablist", "aria-label": "Metadata type"},
        [...KINDS, {id: "schema", label: "Schema", icon: "▦", tone: "schema"}].map(k => h("button", {
          key: k.id,
          role: "tab",
          "aria-selected": kindId === k.id,
          className: "md-kind" + (kindId === k.id ? " active" : ""),
          onClick: () => pick(k.id)
        },
          h("span", {className: "md-kind-ico t-" + k.tone, "aria-hidden": "true"}, k.icon),
          h("span", null, k.label),
          lists[k.id] && h("span", {className: "md-kind-count"}, lists[k.id].length)))),
      kind && h("button", {className: "btn btn-primary btn-sm md-new-btn", onClick: openNew, "data-tour": "metadata-new"},
        "＋ New " + (NEW_LABEL[kind.id] || kind.label))),
    h("div", {className: "md-pkg-bar"},
      h("span", {className: "md-pkg-ico", "aria-hidden": "true"}, "📦"),
      h("span", {className: "insp-meta"}, count ? `package.xml · ${count} item(s)` : "package.xml · add items with “＋ package.xml”"),
      count > 0 && h("button", {
        className: "btn btn-primary btn-sm",
        onClick: () => downloadText("package.xml", buildPackageXml(pkg, apiVersion))
      }, "Download package.xml"),
      count > 0 && h("button", {className: "btn btn-secondary btn-sm", onClick: () => setPkg({})}, "Clear")),
    notice && h("div", {className: "insp-status-ok"}, notice),
    editErr && h("div", {className: "insp-error"}, editErr),
    kindId === "schema"
      ? h(SchemaView, {pkg, onTogglePkg})
      : h("div", {className: "usr-layout"},
          h("div", {className: "usr-side"},
            h("div", {className: "sq3-card md-side"},
              h("input", {
                className: "soql-save-input md-filter",
                value: filter,
                placeholder: `Search ${kind.label.toLowerCase()}…`,
                "aria-label": `Search ${kind.label}`,
                onChange: e => setFilter(e.target.value)
              }),
              kindDrafts.length > 0 && h("div", {className: "md-group-h"}, "Drafts"),
              kindDrafts.map(d => h("div", {
                key: d.id,
                className: "sq3-saved-row md-row" + (d.id === draftId ? " selected" : ""),
                role: "button", tabIndex: 0,
                title: d.mode === "edit" ? "Your unsaved changes to this component — open to continue" : "Unsaved draft — open to edit and deploy",
                onClick: () => { setDraftId(d.id); setDeployErr(null); },
                onKeyDown: e => { if (e.key === "Enter") setDraftId(d.id); }
              },
                fileIcon(d.files[0].path),
                h("span", {className: "sq3-saved-tx"},
                  h("span", {className: "sq3-saved-label"}, d.title),
                  h("span", {className: "sq3-saved-q"}, d.mode === "edit"
                    ? `${changedFiles(d).length} change(s) · not saved`
                    : `${d.files.length} file(s) · not deployed`)),
                d.mode === "edit"
                  ? h("span", {className: "mdn-new mdn-edit"}, "EDIT")
                  : h("span", {className: "mdn-new"}, "NEW"))),
              kindDrafts.length > 0 && h("div", {className: "md-group-h"}, "In org"),
              errors[kind.id] && h("div", {className: "insp-error"}, errors[kind.id]),
              !lists[kind.id] && !errors[kind.id] && h("div", {className: "insp-meta"}, "Loading…"),
              lists[kind.id] && !shown.length && h("div", {className: "insp-meta md-empty"},
                t ? "No matches." : `None in this org yet. Use “＋ New” to create one.`),
              h("div", {className: "sq3-saved-list md-list"},
                shown.slice(0, 300).map(r => h("div", {
                  key: r.Id,
                  className: "sq3-saved-row md-row" + (r.Id === selId && !draft ? " selected" : ""),
                  role: "button",
                  tabIndex: 0,
                  title: kind.name(r),
                  onClick: () => { setSelId(r.Id); setDraftId(null); },
                  onKeyDown: e => { if (e.key === "Enter") { setSelId(r.Id); setDraftId(null); } }
                },
                  h("span", {className: "md-kind-tile sm t-" + kind.tone, "aria-hidden": "true"}, kind.icon),
                  h("span", {className: "sq3-saved-tx"},
                    h("span", {className: "sq3-saved-label"}, kind.name(r)),
                    h("span", {className: "sq3-saved-q"}, kind.sub(r))),
                  (pkg[kind.type] || []).includes(kind.name(r)) && h("span", {className: "md-in-pkg", title: "In package.xml"}, "📦"),
                  h("span", {className: "sq3-saved-chev", "aria-hidden": "true"}, "›")))),
              shown.length > 300 && h("div", {className: "insp-meta"}, `Showing 300 of ${shown.length}; search to narrow.`))),
          h("div", {className: "usr-main"},
            draft
              ? h(DraftEditor, {
                  draft, busy, error: deployErr, progress,
                  onChange: d => setDrafts(drafts.map(x => (x.id === d.id ? d : x))),
                  onDeploy: () => (draft.mode === "edit" ? saveEdit(draft) : deploy(draft, false)),
                  onCheck: draft.mode === "edit" && ["apex", "triggers", "pages"].includes(draft.kind)
                    ? () => saveEdit(draft, {checkOnly: true}) : null,
                  onDiscard: () => { setDrafts(drafts.filter(x => x.id !== draft.id)); setDraftId(null); setDeployErr(null); }
                })
              : sel
              ? (kind.id === "cmdt" ? h(CmdtDetail, {row: sel, pkg, onTogglePkg}) : h(ComponentDetail, {kind, row: sel, pkg, onTogglePkg,
                  onChanged: () => refreshKind(kind.id), onEdit: busy ? null : startEdit}))
              : h("div", {className: "sq3-card md-placeholder"},
                  h("span", {className: "md-kind-tile lg t-" + kind.tone, "aria-hidden": "true"}, kind.icon),
                  h("div", {className: "md-placeholder-t"}, kind.label),
                  h("div", {className: "insp-meta"}, KIND_HINT[kind.id]),
                  h("button", {className: "btn btn-secondary btn-sm", onClick: openNew}, "＋ New " + (NEW_LABEL[kind.id] || kind.label))))),
    newOpen && kind && h(NewDialog, {
      kind: kind.id, versions, objects, busy, error: deployErr,
      onClose: () => { setNewOpen(false); setDeployErr(null); },
      onCreate: d => {
        const nd = withOriginals(d);
        setDrafts([nd, ...drafts]);
        setNewOpen(false);
        setDraftId(nd.id);
        setDeployErr(null);
      },
      onDeploy: d => deploy(d, true)
    }));
}

const NEW_LABEL = {apex: "Apex Class", triggers: "Trigger", pages: "Page", lwc: "LWC", aura: "Aura", flows: "Flow", rules: "Rule", cmdt: "Metadata Type"};
const KIND_HINT = {
  apex: "Pick a class to read its source, or ask AI to explain it.",
  triggers: "Pick a trigger to see which object and events it runs on.",
  pages: "Pick a Visualforce page to read its markup.",
  lwc: "Pick a component to read all of its files.",
  aura: "Pick a component to read its definitions.",
  flows: "Pick a flow to see what starts it and each step it runs, in order.",
  rules: "Pick a rule to read its formula and error message.",
  cmdt: "Pick a custom metadata type to see its fields and records, or add a record.",
};

export {MetadataTab};
