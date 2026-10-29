// Metadata tab → New: a form per kind, a draft editor for the generated
// files, and deploy. Drafts stay in this browser until deployed or discarded.
import {
  APEX_TEMPLATES, TRIGGER_EVENTS, LWC_TARGETS, AURA_INTERFACES, FLOW_KINDS, validateForm, buildDraft,
  LWC_TEMPLATES, AURA_TEMPLATES, TEMPLATES_NEEDING_OBJECT, LWC_TEMPLATE_TARGETS
} from "../../core/metadata-templates.js";
import {RuleAiBox} from "./metadata-views.js";
import {ffDescribeObject} from "../shared/describe.js";
import {apexHighlight} from "../shared/highlight.js";
import {CMDT_FIELD_TYPES, toApiName} from "../../core/cmdt.js";

const h = React.createElement;

const NAME = (label, placeholder) => ({key: "name", label, type: "text", required: true, placeholder});
const VERSION = {key: "apiVersion", label: "API Version", type: "version", required: true};
const DESCRIPTION = {key: "description", label: "Description", type: "textarea", wide: true};

export const NEW_FORMS = {
  apex: {title: "New Apex Class", defaults: {template: "empty"}, fields: [
    NAME("Class Name", "PascalCase, e.g. InvoiceService"),
    {key: "template", label: "Template", type: "select", options: APEX_TEMPLATES},
    VERSION]},
  triggers: {title: "New Apex Trigger", defaults: {events: ["before insert", "before update"], handler: true}, fields: [
    NAME("Trigger Name", "e.g. AccountTrigger"),
    {key: "object", label: "Object", type: "object", required: true, placeholder: "e.g. Account"},
    {key: "events", label: "Events", type: "multi", options: TRIGGER_EVENTS.map(e => [e, e]), placeholder: "Select events"},
    VERSION,
    {key: "checks", type: "checks", wide: true, items: [["handler", "Also create a handler class (recommended)"]]}]},
  pages: {title: "New Visualforce Page", defaults: {}, fields: [
    NAME("Page Name", "e.g. InvoicePdf"),
    {key: "label", label: "Label", type: "text", placeholder: "Shown in Setup"},
    {key: "controller", label: "Standard controller", type: "object", placeholder: "Optional, e.g. Account"},
    VERSION]},
  lwc: {title: "New Lightning Web Component", defaults: {template: "card", exposed: true, targets: LWC_TEMPLATE_TARGETS.card, css: false, svg: false, fields: "Name"}, fields: [
    NAME("Component Name", "camelCase, e.g. accountCard"),
    {key: "label", label: "Master Label", type: "text", placeholder: "Shown in builders"},
    {key: "template", label: "Start from", type: "select", options: LWC_TEMPLATES, wide: true},
    {key: "object", label: "Object", type: "object", required: true, placeholder: "e.g. Account", showIf: f => TEMPLATES_NEEDING_OBJECT.has(f.template)},
    {key: "fields", label: "Fields", type: "text", placeholder: "API names, e.g. Name, Industry, Phone", showIf: f => TEMPLATES_NEEDING_OBJECT.has(f.template)},
    {key: "checks", type: "checks", wide: true, items: [["exposed", "isExposed"], ["css", "include CSS File?"], ["svg", "include SVG File?"]]},
    {key: "targets", label: "Targets", type: "multi", options: LWC_TARGETS.map(t => [t, t]), placeholder: "Select targets", search: true},
    VERSION,
    DESCRIPTION]},
  aura: {title: "New Aura Component", defaults: {template: "card", interfaces: ["flexipage:availableForAllPageTypes"], fields: "Name"}, fields: [
    NAME("Component Name", "e.g. accountSummary"),
    {key: "label", label: "Label", type: "text", placeholder: "Shown in builders"},
    {key: "template", label: "Start from", type: "select", options: AURA_TEMPLATES, wide: true},
    {key: "object", label: "Object", type: "object", required: true, placeholder: "e.g. Account", showIf: f => TEMPLATES_NEEDING_OBJECT.has(f.template)},
    {key: "fields", label: "Fields", type: "text", placeholder: "API names, e.g. Name, Industry, Phone", showIf: f => TEMPLATES_NEEDING_OBJECT.has(f.template)},
    {key: "interfaces", label: "Implements", type: "multi", options: AURA_INTERFACES.map(t => [t, t]), placeholder: "Select interfaces", search: true},
    VERSION,
    {key: "checks", type: "checks", wide: true, items: [["style", "include Style (CSS)?"]]},
    DESCRIPTION]},
  flows: {title: "New Flow", defaults: {flowKind: "autolaunched", when: "CreateAndUpdate", timing: "RecordAfterSave"}, fields: [
    NAME("API Name", "e.g. Case_Escalation"),
    {key: "label", label: "Flow Label", type: "text", required: true, placeholder: "Shown in Setup"},
    {key: "flowKind", label: "Type", type: "select", options: FLOW_KINDS},
    VERSION,
    {key: "object", label: "Object", type: "object", required: true, placeholder: "e.g. Case", showIf: f => f.flowKind === "record"},
    {key: "when", label: "Run when a record is", type: "select", showIf: f => f.flowKind === "record",
      options: [["Create", "Created"], ["Update", "Updated"], ["CreateAndUpdate", "Created or updated"], ["Delete", "Deleted"]]},
    {key: "timing", label: "Optimize for", type: "select", showIf: f => f.flowKind === "record" && f.when !== "Delete",
      options: [["RecordBeforeSave", "Fast field updates (before save)"], ["RecordAfterSave", "Actions and related records (after save)"]]},
    DESCRIPTION]},
  cmdt: {title: "New Custom Metadata Type", defaults: {visibility: "Public", fields: [{label: "", name: "", type: "Text"}]}, fields: [
    {key: "label", label: "Label", type: "text", required: true, placeholder: "e.g. Feature Flag", autoName: true},
    NAME("Object Name", "e.g. Feature_Flag (saved as Feature_Flag__mdt)"),
    {key: "pluralLabel", label: "Plural Label", type: "text", placeholder: "e.g. Feature Flags"},
    {key: "visibility", label: "Visibility", type: "select",
      options: [["Public", "All Apex code and APIs can use it"], ["Protected", "Only Apex in the same namespace"], ["PackageProtected", "Only this managed package"]]},
    {key: "fields", label: "Fields", type: "fieldrows", wide: true},
    DESCRIPTION]},
  rules: {title: "New Validation Rule", defaults: {active: true}, fields: [
    {key: "object", label: "Object", type: "object", required: true, placeholder: "e.g. Account"},
    NAME("Rule Name", "e.g. Revenue_Not_Negative"),
    {key: "ai", type: "airule", wide: true},
    {key: "formula", label: "Error condition formula (true = block the save)", type: "textarea", required: true, wide: true, code: true,
      placeholder: "e.g. AnnualRevenue < 0"},
    {key: "message", label: "Error message", type: "text", required: true, wide: true, placeholder: "Shown to the user"},
    {key: "field", label: "Show error on field", type: "object", placeholder: "Optional field API name", list: "mdn-fields"},
    {key: "checks", type: "checks", items: [["active", "Active"]]},
    DESCRIPTION]},
};

// Dropdown multi-select with optional search (LWC targets, events …).
function MultiSelect({value, options, onChange, placeholder, search, id}) {
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState("");
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const sel = value || [];
  const t = term.trim().toLowerCase();
  const shown = options.filter(([v, l]) => !t || v.toLowerCase().includes(t) || l.toLowerCase().includes(t));
  const toggle = v => onChange(sel.includes(v) ? sel.filter(x => x !== v) : [...sel, v]);
  return h("div", {className: "mdn-multi", ref},
    h("button", {
      type: "button", id, className: "mdn-input mdn-multi-btn", "aria-haspopup": "listbox", "aria-expanded": open,
      onClick: () => setOpen(o => !o)
    },
      h("span", {className: sel.length ? "" : "mdn-placeholder"},
        sel.length ? sel[0] + (sel.length > 1 ? ` +${sel.length - 1} more` : "") : placeholder),
      h("span", {className: "mdn-caret", "aria-hidden": "true"}, "▾")),
    open && h("div", {className: "mdn-multi-pop", role: "listbox", "aria-multiselectable": true},
      search && h("input", {className: "mdn-input mdn-multi-search", value: term, placeholder: "Search", autoFocus: true,
        "aria-label": "Search options", onChange: e => setTerm(e.target.value)}),
      h("div", {className: "mdn-multi-list"},
        shown.map(([v, l]) => h("label", {key: v, className: "mdn-multi-opt", role: "option", "aria-selected": sel.includes(v)},
          h("input", {type: "checkbox", checked: sel.includes(v), onChange: () => toggle(v)}),
          h("span", null, l))),
        !shown.length && h("div", {className: "insp-meta"}, "No matches."))));
}

function NewDialog({kind, versions, objects, onClose, onCreate, onDeploy, busy, error}) {
  const spec = NEW_FORMS[kind];
  const [form, setForm] = React.useState(() => ({...spec.defaults, apiVersion: versions[0]}));
  const [touched, setTouched] = React.useState(false);
  // The org's version list arrives after the dialog opens: follow the
  // newest version until the user picks one.
  const versionPicked = React.useRef(false);
  React.useEffect(() => {
    if (versions[0] && !versionPicked.current) setForm(f => ({...f, apiVersion: versions[0]}));
  }, [versions]);
  React.useEffect(() => {
    const onKey = e => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const [aiNote, setAiNote] = React.useState(null);
  const [objFields, setObjFields] = React.useState([]);
  // Field suggestions for the chosen object (rule display field, LWC fields).
  React.useEffect(() => {
    let stale = false;
    if (!/^[A-Za-z]\w*$/.test(form.object || "")) { setObjFields([]); return undefined; }
    ffDescribeObject(form.object).then(d => { if (!stale) setObjFields(d.fields || []); }).catch(() => { if (!stale) setObjFields([]); });
    return () => { stale = true; };
  }, [form.object]);
  const targetsPicked = React.useRef(false);
  const errors = validateForm(kind, form);
  const valid = !Object.keys(errors).length;
  const set = (k, v) => setForm(f => ({...f, [k]: v}));
  const go = which => {
    setTouched(true);
    if (!valid) return;
    (which === "deploy" ? onDeploy : onCreate)(buildDraft(kind, form));
  };

  const field = fd => {
    if (fd.showIf && !fd.showIf(form)) return null;
    const id = `mdn-${kind}-${fd.key}`;
    const err = touched && errors[fd.key];
    let control;
    if (fd.type === "checks") {
      control = h("div", {className: "mdn-checks"}, fd.items.map(([k, l]) => h("label", {key: k, className: "sq3-check"},
        h("input", {type: "checkbox", checked: !!form[k], onChange: e => set(k, e.target.checked)}), h("span", null, l))));
      return h("div", {key: fd.key, className: "mdn-field mdn-wide"}, control);
    }
    if (fd.type === "airule") {
      return h("div", {key: fd.key, className: "mdn-field mdn-wide"},
        h(RuleAiBox, {object: form.object, onResult: r => {
          setForm(f => ({...f, formula: r.formula, message: r.errorMessage || f.message, field: r.errorDisplayField || f.field,
            description: r.description || f.description, name: f.name || r.ruleName}));
          setAiNote(r.explanation);
        }}),
        aiNote && h("div", {className: "insp-fix-why mdv-ai-note"}, "✨ " + aiNote));
    }
    if (fd.type === "fieldrows") {
      const rows = form.fields || [];
      const setRow = (i, patch) => set("fields", rows.map((r, j) => (j === i ? {...r, ...patch} : r)));
      return h("div", {key: fd.key, className: "mdn-field mdn-wide"},
        h("span", {className: "mdn-label"}, fd.label),
        h("div", {className: "mdn-rows"},
          rows.map((r, i) => h("div", {key: i, className: "mdn-row"},
            h("input", {className: "mdn-input", value: r.label, placeholder: "Field label, e.g. Enabled", "aria-label": `Field ${i + 1} label`,
              onChange: e => setRow(i, {label: e.target.value, name: toApiName(e.target.value)})}),
            h("select", {className: "mdn-input", value: r.type, "aria-label": `Field ${i + 1} type`, onChange: e => setRow(i, {type: e.target.value})},
              CMDT_FIELD_TYPES.map(([v, l]) => h("option", {key: v, value: v}, l))),
            h("label", {className: "sq3-check", title: "Required"},
              h("input", {type: "checkbox", checked: !!r.required, disabled: r.type === "Checkbox", onChange: e => setRow(i, {required: e.target.checked})}),
              h("span", null, "Req.")),
            h("button", {className: "mdn-x", type: "button", title: "Remove field", "aria-label": "Remove field",
              onClick: () => set("fields", rows.filter((_, j) => j !== i))}, "✕"),
            r.name && h("span", {className: "mdn-row-api"}, r.name + "__c")))),
        h("button", {className: "btn btn-secondary btn-sm mdn-add", type: "button",
          onClick: () => set("fields", [...rows, {label: "", name: "", type: "Text"}])}, "＋ Add field"),
        touched && errors.fields && h("div", {className: "mdn-err"}, errors.fields));
    }
    if (fd.type === "select") {
      control = h("select", {id, className: "mdn-input", value: form[fd.key] || "", onChange: e => {
        const v = e.target.value;
        // A new LWC template suggests its targets until targets are picked by hand.
        if (kind === "lwc" && fd.key === "template" && !targetsPicked.current) setForm(f => ({...f, template: v, targets: LWC_TEMPLATE_TARGETS[v] || f.targets}));
        else set(fd.key, v);
      }},
        fd.options.map(([v, l]) => h("option", {key: v, value: v}, l)));
    } else if (fd.type === "version") {
      control = h("select", {id, className: "mdn-input", value: form.apiVersion || "", onChange: e => { versionPicked.current = true; set("apiVersion", e.target.value); }},
        versions.map((v, i) => h("option", {key: v, value: v}, i === 0 ? `${v} (Latest Release)` : v)));
    } else if (fd.type === "multi") {
      control = h(MultiSelect, {id, value: form[fd.key], options: fd.options, placeholder: fd.placeholder, search: fd.search,
        onChange: v => { if (fd.key === "targets") targetsPicked.current = true; set(fd.key, v); }});
    } else if (fd.type === "textarea") {
      control = h("textarea", {id, className: "mdn-input" + (fd.code ? " mdn-code" : ""), rows: fd.code ? 4 : 3, value: form[fd.key] || "",
        placeholder: fd.placeholder, spellCheck: !fd.code, onChange: e => set(fd.key, e.target.value)});
    } else {
      control = h("input", {id, className: "mdn-input", value: form[fd.key] || "", placeholder: fd.placeholder,
        list: fd.list || (fd.type === "object" ? "mdn-objects" : undefined), autoFocus: fd.key === spec.fields[0].key,
        onChange: e => {
          const v = fd.type === "object" ? e.target.value.trim() : e.target.value;
          // Label → API name while the name still follows the label.
          if (fd.autoName) {
            setForm(f => ({...f, [fd.key]: v,
              ...(!f.name || f.name === toApiName(f[fd.key] || "") ? {name: toApiName(v)} : {}),
              ...(!f.pluralLabel || f.pluralLabel === (f[fd.key] || "") + "s" ? {pluralLabel: v ? v + "s" : ""} : {})}));
          } else set(fd.key, v);
        },
        onKeyDown: e => { if (e.key === "Enter") go("create"); }});
    }
    return h("div", {key: fd.key, className: "mdn-field" + (fd.wide ? " mdn-wide" : "")},
      h("label", {htmlFor: id, className: "mdn-label"}, fd.label, fd.required && h("span", {className: "mdn-req"}, " *")),
      control,
      err && h("div", {className: "mdn-err"}, err));
  };

  return h("div", {className: "usr-modal-veil", onMouseDown: e => { if (e.target === e.currentTarget && !busy) onClose(); }},
    h("div", {className: "usr-modal sq3-card mdn-modal", role: "dialog", "aria-modal": true, "aria-label": spec.title},
      h("div", {className: "usr-modal-h"},
        h("div", {className: "usr-modal-t"}, h("div", {className: "mdn-title"}, spec.title)),
        h("button", {className: "mdn-x", title: "Close", "aria-label": "Close", disabled: busy, onClick: onClose}, "✕")),
      h("datalist", {id: "mdn-fields"}, objFields.map(f => h("option", {key: f.name, value: f.name}, f.label))),
      h("datalist", {id: "mdn-objects"}, objects.slice(0, 2000).map(o => h("option", {key: o.name, value: o.name}, o.label))),
      h("div", {className: "mdn-grid"}, spec.fields.map(field)),
      touched && errors.targets && h("div", {className: "mdn-err"}, errors.targets),
      error && h("div", {className: "insp-error"}, error),
      h("div", {className: "mdn-foot"},
        h("span", {className: "insp-meta"}, "Create opens it in the editor without deploying."),
        h("div", {className: "mdn-foot-btns"},
          h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onClose}, "Cancel"),
          h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => go("create")}, "Create"),
          h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: () => go("deploy")}, busy ? "Deploying…" : "✓ Deploy")))));
}

const EXT_ICON = {
  cls: ["</>", "apex"], trigger: ["⚡", "apex"], page: ["<>", "html"], html: ["<>", "html"], js: ["JS", "js"], css: ["#", "css"],
  svg: ["◇", "svg"], xml: ["</>", "xml"], json: ["{ }", "json"], cmp: ["<>", "html"], flow: ["⇢", "json"],
};

function fileIcon(path) {
  const name = path.split("/").pop();
  const ext = name.endsWith(".js-meta.xml") ? "xml" : name.endsWith(".flow-meta.json") ? "json" : name.split(".").pop();
  const [glyph, tone] = EXT_ICON[ext] || ["·", "txt"];
  return h("span", {className: "mdn-file-ico t-" + tone, "aria-hidden": "true"}, glyph);
}

// Long bundle file names: keep the start and the distinguishing end with
// the extension ("nxtPay_Touch…PageHelper.js"); the full name is the title.
export function midTrim(name, max = 26) {
  const s = String(name || "");
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.55);
  return s.slice(0, max - 1 - tail) + "…" + s.slice(-tail);
}

export function fileLabel(path, max) {
  const name = String(path || "").split("/").pop();
  return h("span", {className: "md-fname", title: name}, midTrim(name, max));
}

// File tree label: the whole name, wrapping if needed, with the bundle's
// shared prefix faded so the part that differs (".html", "Helper.js") stands out.
export function treeFileLabel(path) {
  const parts = String(path || "").split("/");
  const name = parts.pop();
  const bundle = parts.pop() || "";
  const shared = bundle && bundle.length > 8 && name.startsWith(bundle) && name.length > bundle.length;
  return h("span", {className: "md-fname md-fname-wrap", title: name},
    shared ? [h("span", {key: "b", className: "md-fname-base"}, bundle), h("b", {key: "s"}, name.slice(bundle.length))] : name);
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Edit generated files before deploying. Highlighted mirror under a
// transparent textarea, the same technique as the SOQL editor.
function DraftEditor({draft, onChange, onDeploy, onDiscard, busy, error}) {
  const [active, setActive] = React.useState(0);
  const hlRef = React.useRef(null);
  const file = draft.files[Math.min(active, draft.files.length - 1)];
  const changed = draft.files.filter(f => f.original != null && f.content !== f.original).length;
  const update = text => onChange({...draft, files: draft.files.map((f, i) => (f === file ? {...f, content: text} : f))});
  const html = file.lang === "apex" || file.lang === "js" ? apexHighlight(file.content) : escHtml(file.content);
  const folder = draft.files[0].path.split("/").slice(0, -1).join("/");
  return h("div", {className: "sq3-card mdn-editor"},
    h("div", {className: "sq3-card-h"},
      h("span", {className: "sq3-card-t"}, draft.title),
      h(FFBadgeNew, null),
      h("span", {className: "insp-meta mdn-editor-kind"}, NEW_FORMS[draft.kind].title.replace(/^New /, ""))),
    h("div", {className: "mdn-editor-body"},
      h("div", {className: "mdn-tree", role: "tablist", "aria-label": "Files"},
        h("div", {className: "mdn-tree-folder", title: folder || draft.name}, "▾ " + (folder || draft.name)),
        draft.files.map((f, i) => h("button", {
          key: f.path, role: "tab", "aria-selected": f === file,
          className: "mdn-tree-file" + (f === file ? " active" : ""),
          onClick: () => setActive(i), title: f.path
        }, fileIcon(f.path), treeFileLabel(f.path),
          f.original != null && f.content !== f.original && h("span", {className: "mdn-dot", title: "Changed"}, "●")))),
      h("div", {className: "mdn-code-wrap"},
        file.readOnly && h("div", {className: "insp-hint-strip mdn-ro"},
          "Generated from the form (isExposed, targets, label, API version) and set by Salesforce on deploy."),
        h("div", {className: "soql-editor-box mdn-code-box"},
          h("div", {className: "soql-term mdn-term"},
            h("div", {className: "soql-pane"},
              h("pre", {className: "soql-hl", ref: hlRef, "aria-hidden": "true"},
                h("code", {dangerouslySetInnerHTML: {__html: html + "\n"}})),
              h("textarea", {
                className: "insp-soql",
                value: file.content,
                readOnly: !!file.readOnly,
                spellCheck: false,
                wrap: "off",
                "aria-label": `Edit ${file.path}`,
                onChange: e => update(e.target.value),
                onScroll: e => {
                  if (hlRef.current) { hlRef.current.scrollTop = e.target.scrollTop; hlRef.current.scrollLeft = e.target.scrollLeft; }
                },
                onKeyDown: e => {
                  if (e.key === "Tab" && !file.readOnly) {
                    e.preventDefault();
                    const ta = e.target;
                    const s = ta.selectionStart;
                    update(ta.value.slice(0, s) + "    " + ta.value.slice(ta.selectionEnd));
                    requestAnimationFrame(() => { try { ta.setSelectionRange(s + 4, s + 4); } catch (x) { /* ignore */ } });
                  }
                }
            })))))),
    error && h("div", {className: "insp-error"}, error),
    h("div", {className: "mdn-foot"},
      h("span", {className: "insp-meta"}, `${changed} changed · Draft saved locally`),
      h("div", {className: "mdn-foot-btns"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onDiscard}, "Discard"),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: onDeploy}, busy ? "Deploying…" : "✓ Deploy"))));
}

function FFBadgeNew() {
  return h("span", {className: "mdn-new"}, "NEW");
}

// Remember the generated text so the editor can count changes.
function withOriginals(draft) {
  return {...draft, id: draft.id || `d${Date.now().toString(36)}`, files: draft.files.map(f => ({...f, original: f.original ?? f.content}))};
}

export {NewDialog, DraftEditor, withOriginals, fileIcon};
