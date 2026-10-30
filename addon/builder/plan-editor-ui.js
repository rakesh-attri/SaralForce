// Object Builder → Plan: per-type field details and object settings
// (features, validation rules, list views, compact layout).
import {normalizeFieldType, FORMULA_RETURN_TYPES, SUMMARY_OPERATIONS, CALCULATED_TYPES} from "../core/object-builder-rules.js";

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

function CsvInput({label, value, onCommit, placeholder}) {
  return h("label", {className: "insp-field insp-field-grow"},
    h("span", null, label),
    h(LazyText, {value: (value || []).join(", "), placeholder, className: "plan-cell-mono", onCommit: t => onCommit(csv(t))}));
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

export function FieldDetails({field, fields, objectHistory, onChange}) {
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
      rows.push(h("label", {key: "f", className: "insp-field plan-detail-wide"},
        h("span", null, "Formula"),
        h("textarea", {className: "plan-cell-input plan-cell-mono plan-formula", rows: 3, spellCheck: false,
          value: field.formula || "", placeholder: "e.g. Quantity__c * Unit_Price__c", onChange: e => onChange({formula: e.target.value})})));
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
        h(Input, {label: "Error when (formula is true)", mono: true, grow: true, value: r.formula, placeholder: "Amount__c < 0", onChange: v => edit("validationRules", i, {formula: v})}),
        h(Input, {label: "Error message", grow: true, value: r.message, onChange: v => edit("validationRules", i, {message: v})}),
        del("validationRules", i, "rule"))
    }),
    h(ListEditor, {
      title: "List views", items: views, addLabel: "+ List view",
      onAdd: () => onPlan(d => { d.listViews = [...(d.listViews || []), {name: `View_${views.length + 1}`, label: `View ${views.length + 1}`, columns: ["NAME"]}]; }),
      render: (v, i) => h("div", {key: i, className: "plan-item"},
        h(Input, {label: "Label", value: v.label, onChange: x => edit("listViews", i, {label: x})}),
        h(Input, {label: "Name", mono: true, value: v.name, onChange: x => edit("listViews", i, {name: x})}),
        h(CsvInput, {label: "Columns (comma separated, NAME = record name)", value: v.columns,
          onCommit: cols => edit("listViews", i, {columns: cols})}),
        del("listViews", i, "list view"))
    }),
    h("div", {className: "plan-sub"},
      h("div", {className: "plan-sub-h"}, h("span", null, "Compact layout (record highlights)")),
      h(CsvInput, {label: "Fields (comma separated, up to 10; empty = none)", value: compact,
        placeholder: "Name, Status__c, Amount__c",
        onCommit: list => onPlan(d => { if (list.length) d.compactLayout = {...(d.compactLayout || {}), fields: list}; else delete d.compactLayout; })}))
  );
}
