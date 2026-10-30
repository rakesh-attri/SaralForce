// Object Builder → Plan: per-type field details and object settings
// (features, validation rules, list views, compact layout).
import {normalizeFieldType, FORMULA_RETURN_TYPES, SUMMARY_OPERATIONS, CALCULATED_TYPES, STANDARD_OBJECT_FIELDS} from "../core/object-builder-rules.js";

const h = React.createElement;

const num = v => (v === "" || v === null || v === undefined ? undefined : Number(v));
const csv = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

function Input({label, value, onChange, type = "text", placeholder, mono, grow, title}) {
  return h("label", {className: "insp-field" + (grow ? " insp-field-grow" : ""), title},
    h("span", null, label),
    h("input", {
      type, value: value === undefined || value === null ? "" : value, placeholder,
      spellCheck: mono ? false : undefined,
      className: mono ? "plan-cell-mono" : undefined,
      onChange: e => onChange(type === "number" ? num(e.target.value) : e.target.value)
    }));
}

// Text that is parsed on blur (lists), so commas and new lines can be typed.
function LazyText({value, onCommit, multiline, className, placeholder}) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  return h(multiline ? "textarea" : "input", {
    className, placeholder, rows: multiline ? 4 : undefined, spellCheck: false, value: text,
    onChange: e => setText(e.target.value),
    onBlur: () => { if (text !== value) onCommit(text); }
  });
}

// Fields a formula / rule / list view of this plan can use, for suggestions.
export function planFieldOptions(proposal) {
  const seen = new Set();
  const out = [];
  const add = (name, label, note) => {
    const k = String(name || "").toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({name, label: label || name, note});
  };
  for (const f of (proposal && proposal.fields) || []) if (f) add(f.name, f.label, f.existing ? "in org" : "new");
  for (const f of (proposal && proposal.orgFields) || []) add(f.name, f.label, "in org");
  for (const n of STANDARD_OBJECT_FIELDS) add(n, n, "standard");
  return out;
}

// Text box that suggests field API names while you type.
//   mode "formula": completes the word at the cursor
//   mode "list":    comma-separated names, saved when you leave the box
//   mode "single":  one field name
function FieldSuggest({label, value, onChange, fields, mode = "formula", placeholder, multiline, grow, extra = []}) {
  const [text, setText] = React.useState(value || "");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [caret, setCaret] = React.useState(0);
  const ref = React.useRef(null);
  React.useEffect(() => { if (document.activeElement !== ref.current) setText(value || ""); }, [value]);

  const before = text.slice(0, caret);
  const listPart = before.split(",").pop();
  const token = mode === "formula" ? (/[A-Za-z0-9_]*$/.exec(before) || [""])[0]
    : mode === "list" ? listPart.trim() : text.trim();
  const tokenStart = mode === "formula" ? caret - token.length
    : mode === "list" ? caret - listPart.replace(/^\s+/, "").length : 0;
  const q = token.toLowerCase();
  const all = [...extra.map(n => ({name: n, label: n, note: ""})), ...(fields || [])];
  const matches = (mode === "formula" && !q) ? [] : all
    .filter(f => !q || f.name.toLowerCase().includes(q) || String(f.label).toLowerCase().includes(q))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
    .slice(0, 8);
  const show = open && matches.length > 0 && !(matches.length === 1 && matches[0].name === token);

  const pick = f => {
    const end = mode === "single" ? text.length : caret;
    const tail = mode === "list" && !/^\s*,/.test(text.slice(end)) ? ", " : "";
    const next = text.slice(0, tokenStart) + f.name + tail + text.slice(end);
    const pos = tokenStart + f.name.length + tail.length;
    setText(next);
    if (mode !== "list") onChange(next);
    setOpen(mode === "list");
    setActive(0);
    setCaret(pos);
    requestAnimationFrame(() => {
      if (ref.current) { ref.current.focus(); ref.current.selectionStart = ref.current.selectionEnd = pos; }
    });
  };
  const onKey = e => {
    if (!show) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };
  const sync = e => setCaret(e.target.selectionStart || 0);
  return h("label", {className: "insp-field plan-suggest" + (grow ? " insp-field-grow" : "")},
    h("span", null, label),
    h(multiline ? "textarea" : "input", {
      ref, value: text, placeholder, spellCheck: false, rows: multiline ? 3 : undefined, autoComplete: "off",
      className: "plan-cell-mono" + (multiline ? " plan-cell-input plan-formula" : ""),
      onChange: e => {
        setText(e.target.value);
        setCaret(e.target.selectionStart || 0);
        setOpen(true);
        setActive(0);
        if (mode !== "list") onChange(e.target.value);
      },
      onKeyDown: onKey,
      onKeyUp: e => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) sync(e); },
      onClick: e => { sync(e); setOpen(true); },
      onFocus: e => { sync(e); setOpen(true); },
      onBlur: () => { setTimeout(() => setOpen(false), 120); if (mode === "list" && text !== value) onChange(text); }
    }),
    show && h("div", {className: "plan-suggest-list", role: "listbox"},
      matches.map((f, i) => h("div", {
        key: f.name, role: "option", "aria-selected": i === active,
        className: "plan-suggest-opt" + (i === active ? " active" : ""),
        onMouseDown: e => { e.preventDefault(); pick(f); }
      },
        h("span", {className: "plan-suggest-n"}, f.name),
        f.label !== f.name && h("span", {className: "plan-suggest-l"}, f.label),
        f.note && h("span", {className: "plan-suggest-k"}, f.note)))));
}

function Select({label, value, options, onChange}) {
  return h("label", {className: "insp-field"},
    h("span", null, label),
    h("select", {value: value || "", onChange: e => onChange(e.target.value)},
      options.map(o => typeof o === "string"
        ? h("option", {key: o, value: o}, o)
        : h("option", {key: o.value, value: o.value}, o.label))));
}

function Check({label, checked, onChange, title}) {
  return h("label", {className: "plan-check", title},
    h("input", {type: "checkbox", checked: !!checked, onChange: e => onChange(e.target.checked)}),
    " ", label);
}

// Dependent picklist: which of this field's values show for each value of
// the controlling field.
function Dependencies({field, controller, onChange}) {
  const ctrlType = normalizeFieldType(controller.type);
  const ctrlValues = ctrlType === "Checkbox" ? ["checked", "unchecked"] : (controller.values || []);
  const deps = field.dependencies || {};
  const own = field.values || [];
  const toggle = (cv, v) => {
    const cur = deps[cv] || [];
    const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
    onChange({dependencies: {...deps, [cv]: next}});
  };
  if (!ctrlValues.length) return h("div", {className: "app-section-hint"}, "Add values to the controlling field first.");
  return h("div", {className: "plan-deps"},
    h("table", {className: "fields-table plan-deps-table"},
      h("thead", null, h("tr", null, h("th", null, field.label || field.name), ctrlValues.map(cv => h("th", {key: cv}, cv)))),
      h("tbody", null, own.map(v => h("tr", {key: v},
        h("td", null, v),
        ctrlValues.map(cv => h("td", {key: cv, className: "req-cell"},
          h("input", {type: "checkbox", className: "field-checkbox", checked: (deps[cv] || []).includes(v), onChange: () => toggle(cv, v)}))))))));
}

export function FieldDetails({field, fields, objectHistory, onChange, suggest}) {
  const type = normalizeFieldType(field.type);
  const set = (k) => (v) => onChange({[k]: v});
  const rows = [];
  switch (type) {
    case "Text":
      rows.push(h(Input, {key: "len", label: "Length (1-255)", type: "number", value: field.length, onChange: set("length")}));
      rows.push(h(Check, {key: "ext", label: "External ID", checked: field.externalId, onChange: set("externalId")}));
      rows.push(h(Check, {key: "uniq", label: "Unique", checked: field.unique, onChange: set("unique")}));
      break;
    case "EncryptedText":
      rows.push(h(Input, {key: "len", label: "Length (1-175)", type: "number", value: field.length, onChange: set("length")}));
      rows.push(h(Select, {key: "mask", label: "Mask type", value: field.maskType || "all", onChange: set("maskType"),
        options: ["all", "lastFour", "creditCard", "nino", "ssn", "sin"]}));
      rows.push(h(Select, {key: "mc", label: "Mask character", value: field.maskChar || "asterisk", onChange: set("maskChar"), options: ["asterisk", "X"]}));
      break;
    case "LongTextArea":
    case "Html":
      rows.push(h(Input, {key: "len", label: "Length", type: "number", value: field.length, onChange: set("length")}));
      rows.push(h(Input, {key: "vl", label: "Visible lines", type: "number", value: field.visibleLines, onChange: set("visibleLines")}));
      break;
    case "Number":
    case "Currency":
    case "Percent":
      rows.push(h(Input, {key: "p", label: "Precision (total digits)", type: "number", value: field.precision, onChange: set("precision")}));
      rows.push(h(Input, {key: "s", label: "Decimal places", type: "number", value: field.scale, onChange: set("scale")}));
      break;
    case "Checkbox":
      rows.push(h(Select, {key: "dv", label: "Default", value: String(field.defaultValue === true || field.defaultValue === "true"),
        options: [{value: "false", label: "Unchecked"}, {value: "true", label: "Checked"}], onChange: v => onChange({defaultValue: v === "true"})}));
      break;
    case "Picklist":
    case "MultiselectPicklist": {
      const controllers = fields.filter(f => f !== field && f.name !== field.name &&
        ["Picklist", "Checkbox"].includes(normalizeFieldType(f.type)));
      const controller = fields.find(f => f.name === field.controllingField);
      rows.push(h(Input, {key: "gvs", label: "Global value set (optional)", mono: true, value: field.globalValueSet,
        placeholder: "e.g. Countries", onChange: v => onChange({globalValueSet: v || undefined})}));
      if (!field.globalValueSet) {
        rows.push(h("label", {key: "vals", className: "insp-field insp-field-grow"},
          h("span", null, "Values (one per line)"),
          h(LazyText, {
            multiline: true, className: "plan-cell-input plan-values",
            value: (field.values || []).join("\n"),
            onCommit: t => onChange({values: t.split("\n").map(x => x.trim()).filter(Boolean)})
          })));
        const vals = (field.values || []).filter(Boolean);
        if (vals.length) {
          rows.push(h(Select, {key: "def", label: "Default value", value: vals.includes(field.defaultValue) ? field.defaultValue : vals[0],
            options: vals, onChange: v => onChange({defaultValue: v})}));
        }
        rows.push(h(Select, {key: "ctrl", label: "Controlling field", value: field.controllingField || "",
          options: [{value: "", label: "(none)"}, ...controllers.map(f => ({value: f.name, label: f.label || f.name}))],
          onChange: v => onChange({controllingField: v || undefined, dependencies: v ? field.dependencies : undefined})}));
      }
      if (type === "MultiselectPicklist") {
        rows.push(h(Input, {key: "vl", label: "Visible lines", type: "number", value: field.visibleLines, onChange: set("visibleLines")}));
      }
      if (controller && !field.globalValueSet) {
        rows.push(h("div", {key: "deps", className: "plan-detail-wide"},
          h(Dependencies, {field: {...field, values: (field.values || []).filter(Boolean)}, controller, onChange})));
      }
      break;
    }
    case "Lookup":
    case "MasterDetail":
      rows.push(h(Input, {key: "rel", label: "Related to (object API name)", mono: true, value: field.relatedTo, onChange: set("relatedTo")}));
      if (type === "Lookup") {
        rows.push(h(Select, {key: "del", label: "If parent is deleted", value: field.deleteConstraint || "SetNull", onChange: set("deleteConstraint"),
          options: [{value: "SetNull", label: "Clear this field"}, {value: "Restrict", label: "Block the delete"}]}));
      }
      break;
    case "Formula": {
      const rt = field.returnType || "Text";
      rows.push(h(Select, {key: "rt", label: "Return type", value: rt, options: FORMULA_RETURN_TYPES, onChange: set("returnType")}));
      if (["Number", "Currency", "Percent"].includes(rt)) {
        rows.push(h(Input, {key: "p", label: "Precision", type: "number", value: field.precision, onChange: set("precision")}));
        rows.push(h(Input, {key: "s", label: "Decimal places", type: "number", value: field.scale, onChange: set("scale")}));
      }
      rows.push(h(Select, {key: "blank", label: "Blank fields", value: field.treatBlanksAs || "BlankAsZero", onChange: set("treatBlanksAs"),
        options: [{value: "BlankAsZero", label: "Treat as zero"}, {value: "BlankAsBlank", label: "Treat as blank"}]}));
      rows.push(h("div", {key: "f", className: "plan-detail-wide"},
        h(FieldSuggest, {label: "Formula (type a field name for suggestions)", multiline: true, value: field.formula || "",
          fields: (suggest || []).filter(x => x.name !== field.name),
          placeholder: "e.g. Quantity__c * Unit_Price__c", onChange: v => onChange({formula: v})})));
      break;
    }
    case "Summary":
      rows.push(h(Select, {key: "op", label: "Operation", value: field.summaryOperation || "count", options: SUMMARY_OPERATIONS, onChange: set("summaryOperation")}));
      rows.push(h(Input, {key: "fk", label: "Child relationship (Child__c.Master_Field__c)", mono: true, grow: true,
        value: field.summaryForeignKey, onChange: set("summaryForeignKey")}));
      if ((field.summaryOperation || "count") !== "count") {
        rows.push(h(Input, {key: "sf", label: "Field to roll up (Child__c.Field__c)", mono: true, grow: true,
          value: field.summarizedField, onChange: set("summarizedField")}));
      }
      break;
    case "AutoNumber":
      rows.push(h(Input, {key: "df", label: "Display format", mono: true, value: field.displayFormat, placeholder: "INV-{0000}", onChange: set("displayFormat")}));
      rows.push(h(Input, {key: "sn", label: "Starting number", type: "number", value: field.startingNumber, onChange: set("startingNumber")}));
      break;
    case "Location":
      rows.push(h(Input, {key: "s", label: "Decimal places", type: "number", value: field.scale, onChange: set("scale")}));
      break;
    default:
      break;
  }
  rows.push(h(Input, {key: "help", label: "Help text (hover tip)", grow: true, value: field.inlineHelpText, onChange: set("inlineHelpText")}));
  if (!CALCULATED_TYPES.has(type)) {
    rows.push(h(Check, {key: "th", label: "Track history", checked: field.trackHistory, onChange: set("trackHistory"),
      title: objectHistory ? undefined : "Turn on \"Track field history\" in Object settings too"}));
  }
  return h("div", {className: "plan-details"}, rows);
}

const FEATURES = [
  ["enableHistory", "Track field history"],
  ["enableReports", "Allow reports"],
  ["enableActivities", "Allow activities"],
  ["enableSearch", "Allow search"],
  ["enableFeeds", "Chatter feed tracking"]
];

function ListEditor({title, items, render, onAdd, addLabel}) {
  return h("div", {className: "plan-sub"},
    h("div", {className: "plan-sub-h"},
      h("span", null, `${title} (${items.length})`),
      h("button", {className: "field-action-btn", onClick: onAdd}, addLabel)),
    items.map(render));
}

export function ObjectSettings({proposal, existing, onObject, onPlan}) {
  const obj = proposal.object || {};
  const rules = proposal.validationRules || [];
  const views = proposal.listViews || [];
  const compact = proposal.compactLayout && proposal.compactLayout.fields ? proposal.compactLayout.fields : [];
  const edit = (key, i, patch) => onPlan(d => { d[key][i] = {...d[key][i], ...patch}; });
  const remove = (key, i) => onPlan(d => { d[key].splice(i, 1); if (!d[key].length) delete d[key]; });
  const fieldOpts = planFieldOptions(proposal);
  const del = (key, i, label) => h("button", {className: "plan-del-btn", title: `Remove ${label}`, onClick: () => remove(key, i)}, "✕");
  return h("div", {className: "fields-section plan-settings"},
    h("div", {className: "fields-header"}, h("h4", null, "Object settings")),
    existing
      ? h("p", {className: "app-section-hint"}, "Object features of an existing object are changed in Setup; add rules, list views and fields here.")
      : h("div", {className: "plan-features"},
      FEATURES.map(([k, label]) => h(Check, {key: k, label, checked: obj[k] === true, onChange: v => onObject({[k]: v})}))),
    h(ListEditor, {
      title: "Validation rules", items: rules, addLabel: "+ Rule",
      onAdd: () => onPlan(d => { d.validationRules = [...(d.validationRules || []), {name: `Rule_${rules.length + 1}`, formula: "", message: ""}]; }),
      render: (r, i) => h("div", {key: i, className: "plan-item"},
        h(Input, {label: "Name", mono: true, value: r.name, onChange: v => edit("validationRules", i, {name: v})}),
        h(FieldSuggest, {label: "Error when (formula is true)", grow: true, value: r.formula, fields: fieldOpts,
          placeholder: "e.g. Amount__c < 0 — type a field name for suggestions", onChange: v => edit("validationRules", i, {formula: v})}),
        h(Input, {label: "Error message", grow: true, value: r.message, onChange: v => edit("validationRules", i, {message: v})}),
        h(FieldSuggest, {label: "Show error on field (optional)", mode: "single", value: r.field || "", fields: fieldOpts,
          placeholder: "top of page", onChange: v => edit("validationRules", i, {field: v.trim() || undefined})}),
        del("validationRules", i, "rule"))
    }),
    h(ListEditor, {
      title: "List views", items: views, addLabel: "+ List view",
      onAdd: () => onPlan(d => { d.listViews = [...(d.listViews || []), {name: `View_${views.length + 1}`, label: `View ${views.length + 1}`, columns: ["NAME"]}]; }),
      render: (v, i) => h("div", {key: i, className: "plan-item"},
        h(Input, {label: "Label", value: v.label, onChange: x => edit("listViews", i, {label: x})}),
        h(Input, {label: "Name", mono: true, value: v.name, onChange: x => edit("listViews", i, {name: x})}),
        h(FieldSuggest, {label: "Columns (comma separated, NAME = record name)", mode: "list", grow: true, extra: ["NAME"],
          value: (v.columns || []).join(", "), fields: fieldOpts,
          onChange: t => edit("listViews", i, {columns: csv(t)})}),
        del("listViews", i, "list view"))
    }),
    h("div", {className: "plan-sub"},
      h("div", {className: "plan-sub-h"}, h("span", null, "Compact layout (record highlights)")),
      h(FieldSuggest, {label: "Fields (comma separated, up to 10; empty = none)", mode: "list", grow: true,
        value: compact.join(", "), fields: fieldOpts, placeholder: "Name, Status__c, Amount__c",
        onChange: t => { const list = csv(t); onPlan(d => { if (list.length) d.compactLayout = {...(d.compactLayout || {}), fields: list}; else delete d.compactLayout; }); }}))
  );
}
