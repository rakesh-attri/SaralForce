// Metadata tab → Custom Metadata: a type's fields and records, and a form to
// add a record (Metadata API createMetadata; custom metadata cannot be
// inserted through REST or the Tooling API).
import {sfConn} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {cmdtRecordXml, toApiName, mergedRecord} from "../../core/cmdt.js";
import {confirmDialog} from "../../ui/confirm.js";
import {cmdtFields, cmdtRecords, soapCreate, soapUpsert, soapDelete} from "../shared/cmdt-data.js";
import {toCsv, downloadText} from "../shared/csv.js";

const h = React.createElement;

// Input for one custom metadata value; `compact` is the in-grid variant.
function valueInput(f, value, onChange, compact) {
  const t = String(f.type || "").toLowerCase();
  const common = {className: "mdn-input" + (compact ? " md-cell-in" : ""), "aria-label": f.label};
  const text = value == null ? "" : value;
  if (t === "boolean") {
    const box = h("input", {type: "checkbox", checked: value === true || value === "true", "aria-label": f.label, onChange: e => onChange(e.target.checked)});
    return compact ? box : h("label", {className: "sq3-check"}, box, h("span", null, f.label));
  }
  if (t === "picklist" && f.picklistValues && f.picklistValues.length) {
    return h("select", {...common, value: text, onChange: e => onChange(e.target.value)},
      h("option", {value: ""}, "—"),
      f.picklistValues.filter(v => v.active !== false).map(v => h("option", {key: v.value, value: v.value}, v.label || v.value)));
  }
  if (t === "textarea" && !compact) return h("textarea", {...common, rows: 2, value: text, onChange: e => onChange(e.target.value)});
  const type = ["double", "percent", "int", "currency"].includes(t) ? "number" : t === "date" ? "date"
    : t === "datetime" && !compact ? "datetime-local" : "text";
  return h("input", {...common, type, value: text, onChange: e => onChange(e.target.value)});
}

function NewRecordForm({typeName, fields, onDone, onCancel}) {
  const [label, setLabel] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [isProtected, setProtected] = React.useState(false);
  const [values, setValues] = React.useState(() => Object.fromEntries(
    fields.map(f => [f.name, String(f.type).toLowerCase() === "boolean" ? false : ""])));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const apiName = nameTouched ? name : toApiName(label);
  const save = async () => {
    setError(null);
    if (!label.trim() || !/^[A-Za-z][A-Za-z0-9_]*$/.test(apiName) || /__/.test(apiName)) {
      setError("Enter a label and a valid record name (letters, digits, single underscores).");
      return;
    }
    setBusy(true);
    try {
      const types = Object.fromEntries(fields.map(f => [f.name, f.type]));
      const vals = {};
      for (const f of fields) {
        let v = values[f.name];
        if (String(f.type).toLowerCase() === "datetime" && v) v = new Date(v).toISOString();
        vals[f.name] = v;
      }
      await soapCreate(cmdtRecordXml(typeName, {label: label.trim(), name: apiName, protected: isProtected, values: vals}, types));
      onDone(`${label.trim()} (${apiName})`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return h("div", {className: "md-cmdt-form"},
    h("div", {className: "mdn-grid"},
      h("div", {className: "mdn-field"},
        h("label", {className: "mdn-label", htmlFor: "cmdt-rec-label"}, "Label", h("span", {className: "mdn-req"}, " *")),
        h("input", {id: "cmdt-rec-label", className: "mdn-input", value: label, autoFocus: true, placeholder: "e.g. Checkout v2",
          onChange: e => setLabel(e.target.value)})),
      h("div", {className: "mdn-field"},
        h("label", {className: "mdn-label", htmlFor: "cmdt-rec-name"}, "Record Name", h("span", {className: "mdn-req"}, " *")),
        h("input", {id: "cmdt-rec-name", className: "mdn-input", value: apiName, placeholder: "e.g. Checkout_v2",
          onChange: e => { setNameTouched(true); setName(e.target.value); }})),
      fields.map(f => h("div", {key: f.name, className: "mdn-field" + (String(f.type).toLowerCase() === "textarea" ? " mdn-wide" : "")},
        String(f.type).toLowerCase() !== "boolean" &&
          h("span", {className: "mdn-label"}, f.label, f.nillable === false ? h("span", {className: "mdn-req"}, " *") : null),
        valueInput(f, values[f.name], v => setValues(x => ({...x, [f.name]: v}))))),
      h("div", {className: "mdn-field mdn-wide"},
        h("label", {className: "sq3-check"},
          h("input", {type: "checkbox", checked: isProtected, onChange: e => setProtected(e.target.checked)}),
          h("span", null, "Protected (only visible to code in the same namespace)")))),
    error && h("div", {className: "insp-error"}, error),
    h("div", {className: "mdn-foot"},
      h("span", {className: "insp-meta"}, "Saved through the Metadata API; it can take a few seconds to appear."),
      h("div", {className: "mdn-foot-btns"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onCancel}, "Cancel"),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: save}, busy ? "Saving…" : "✓ Save record"))));
}

// Records grid like Setup → Manage Records, editable in place: change any
// label or value, then save every changed record in one go (upsert).
function RecordsGrid({typeName, data, pkg, onTogglePkg, recMember, fmt, onSaved}) {
  const [editing, setEditing] = React.useState(false);
  const [edits, setEdits] = React.useState({}); // {recordId: {field: value}}
  const [filter, setFilter] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const types = Object.fromEntries(data.fields.map(f => [f.name, f.type]));
  const changed = Object.keys(edits).filter(id => Object.keys(edits[id]).length);
  const setCell = (r, field, value) => setEdits(prev => {
    const cur = {...(prev[r.Id] || {})};
    const orig = field === "MasterLabel" ? r.MasterLabel : r[field];
    const same = (orig == null ? "" : String(orig)) === (value == null ? "" : String(value));
    if (same) delete cur[field]; else cur[field] = value;
    return {...prev, [r.Id]: cur};
  });
  const valueOf = (r, field) => (edits[r.Id] && Object.prototype.hasOwnProperty.call(edits[r.Id], field) ? edits[r.Id][field] : (field === "MasterLabel" ? r.MasterLabel : r[field]));
  const isChanged = (r, field) => !!(edits[r.Id] && Object.prototype.hasOwnProperty.call(edits[r.Id], field));

  const save = async () => {
    setBusy(true);
    setError(null);
    const failures = [];
    let ok = 0;
    for (const id of changed) {
      const r = data.records.find(x => x.Id === id);
      try {
        const rec = mergedRecord(r, edits[id], data.fields);
        for (const f of data.fields) {
          if (String(f.type).toLowerCase() === "datetime" && rec.values[f.name] && !/Z$|[+-]\d\d:?\d\d$/.test(rec.values[f.name])) {
            rec.values[f.name] = new Date(rec.values[f.name]).toISOString();
          }
        }
        await soapUpsert(cmdtRecordXml(typeName, rec, types));
        ok++;
      } catch (e) {
        failures.push(`${r.DeveloperName}: ${e.message}`);
      }
    }
    setBusy(false);
    if (failures.length) setError(failures.join(" · "));
    if (ok) {
      setEdits(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => failures.some(f => f.startsWith(data.records.find(x => x.Id === id).DeveloperName + ":")))));
      if (!failures.length) setEditing(false);
      onSaved(`Saved ${ok} record${ok === 1 ? "" : "s"}.`);
    }
  };

  const remove = async r => {
    const ok = await confirmDialog({
      title: "Delete this record?",
      message: `${r.MasterLabel} (${typeName.replace(/__mdt$/, "")}.${r.DeveloperName}) will be deleted from the org.`,
      confirmLabel: "Delete", danger: true
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await soapDelete("CustomMetadata", `${typeName.replace(/__mdt$/, "")}.${r.DeveloperName}`);
      onSaved(`Deleted ${r.MasterLabel}.`);
    } catch (e) {
      setError(`Could not delete ${r.DeveloperName}: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const t = filter.trim().toLowerCase();
  const rows = data.records.filter(r => !t || [r.MasterLabel, r.DeveloperName, ...data.fields.map(f => r[f.name])]
    .some(v => String(v == null ? "" : v).toLowerCase().includes(t)));
  if (!data.records.length) return h("div", {className: "insp-meta"}, "No records yet. Use “＋ New record” to add one.");

  return h("div", {className: "md-cmdt-grid"},
    h("div", {className: "md-cmdt-toolbar"},
      h("input", {className: "md-filter acc-filter", value: filter, placeholder: "Search records…", "aria-label": "Search records",
        onChange: e => setFilter(e.target.value)}),
      editing
        ? h("span", {className: "insp-meta"}, changed.length ? `${changed.length} record(s) changed` : "Click a cell to change it")
        : h("button", {className: "btn btn-secondary btn-sm", onClick: () => setEditing(true)}, "✎ Edit records"),
      editing && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => { setEdits({}); setEditing(false); setError(null); }}, "Cancel"),
      editing && h("button", {className: "btn btn-primary btn-sm", disabled: busy || !changed.length, onClick: save},
        busy ? "Saving…" : `✓ Save ${changed.length || ""}`.trim())),
    error && h("div", {className: "insp-error"}, error),
    h("div", {className: "insp-table-wrap"},
      h("table", {className: "insp-table md-cmdt-table" + (editing ? " editing" : "")},
        h("thead", null, h("tr", null,
          h("th", null, "Label"), h("th", null, "Name"),
          data.fields.map(f => h("th", {key: f.name, title: `${f.name} · ${f.type}`}, f.label)), h("th", null, ""))),
        h("tbody", null, rows.map(r => {
          const locked = !!r.NamespacePrefix;
          const cell = (field, f) => {
            const v = valueOf(r, field);
            const cls = isChanged(r, field) ? "md-cell-changed" : "";
            if (!editing || locked) return h("td", {key: field, className: cls}, field === "MasterLabel" ? v : fmt(v));
            return h("td", {key: field, className: "md-cell-edit " + cls},
              f ? valueInput(f, v, nv => setCell(r, field, nv), true)
                : h("input", {className: "mdn-input md-cell-in", value: v || "", "aria-label": "Label", onChange: e => setCell(r, field, e.target.value)}));
          };
          return h("tr", {key: r.Id, className: changed.includes(r.Id) ? "md-row-changed" : ""},
            cell("MasterLabel"),
            h("td", {className: "ff-mono"}, r.DeveloperName, locked && h("span", {className: "md-chip-mini", title: "Managed package record"}, "🔒")),
            data.fields.map(f => cell(f.name, f)),
            h("td", {className: "md-row-actions"},
              h("button", {
                className: "field-action-btn", title: "Add this record to package.xml",
                onClick: () => onTogglePkg("CustomMetadata", recMember(r))
              }, (pkg.CustomMetadata || []).includes(recMember(r)) ? "✓ 📦" : "＋ 📦"),
              !locked && h("button", {className: "field-action-btn", title: "Delete record", disabled: busy, onClick: () => remove(r)}, "🗑")));
        })))),
    t && !rows.length && h("div", {className: "insp-meta"}, "No matching records."));
}

function CmdtDetail({row, pkg, onTogglePkg}) {
  const typeName = row.name;
  const [data, setData] = React.useState(null); // {describe, fields, records}
  const [error, setError] = React.useState(null);
  const [adding, setAdding] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [view, setView] = React.useState("records");

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const {describe, fields} = await cmdtFields(typeName);
      setData({describe, fields, records: await cmdtRecords(typeName, fields)});
    } catch (e) {
      setError(e.message);
    }
  }, [typeName]);

  React.useEffect(() => {
    setData(null);
    setAdding(false);
    setNotice(null);
    setView("records");
    load();
  }, [load]);

  const inPkg = (pkg.CustomObject || []).includes(typeName);
  const recMember = r => `${typeName.replace(/__mdt$/, "")}.${r.NamespacePrefix ? r.NamespacePrefix + "__" : ""}${r.DeveloperName}`;
  const cols = data ? ["MasterLabel", "DeveloperName", ...data.fields.map(f => f.name)] : [];
  const soql = data ? `SELECT ${["DeveloperName", "MasterLabel", ...data.fields.map(f => f.name)].join(", ")} FROM ${typeName}` : "";
  const setup = "https://" + sfConn.instanceHostname + "/lightning/setup/CustomMetadata/home";
  const fmt = v => (v === true ? "✓" : v === false ? "" : v == null ? "" : String(v));

  return h("div", {className: "sq3-card md-detail"},
    h("div", {className: "md-detail-head"},
      h("span", {className: "md-kind-tile t-cmdt", "aria-hidden": "true"}, "⚙"),
      h("div", {className: "md-detail-tx"},
        h("div", {className: "md-detail-name"}, typeName,
          data && h("span", {className: "md-chip-mini"}, `${data.fields.length} fields`),
          data && h("span", {className: "md-chip-mini"}, `${data.records.length} records`)),
        h("div", {className: "sq3-card-sub"}, row.label))),
    h("div", {className: "md-actions"},
      h("button", {className: "btn btn-primary btn-sm", disabled: !data || adding, onClick: () => { setAdding(true); setNotice(null); }}, "＋ New record"),
      h("a", {className: "btn btn-secondary btn-sm", href: setup, target: "_blank", rel: "noreferrer"}, "Open in Setup ↗"),
      h("button", {className: "btn btn-secondary btn-sm", onClick: () => onTogglePkg("CustomObject", typeName)},
        inPkg ? "✓ In package.xml" : "＋ package.xml"),
      data && h("button", {className: "btn btn-secondary btn-sm", onClick: () => safeCopyText(soql)}, "Copy SOQL"),
      data && data.records.length > 0 && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: () => downloadText(`${typeName}.csv`, toCsv(cols, data.records))
      }, "Download CSV")),
    notice && h("div", {className: "insp-status-ok"}, notice),
    error && h("div", {className: "insp-error"}, error),
    !data && !error && h("div", {className: "insp-meta"}, "Loading…"),
    adding && data && h(NewRecordForm, {
      typeName, fields: data.fields,
      onCancel: () => setAdding(false),
      onDone: msg => { setAdding(false); setNotice(`Created ${msg}.`); setTimeout(load, 1500); }
    }),
    data && h("div", {className: "sq3-pills md-views", role: "tablist"},
      [["records", `Records (${data.records.length})`], ["fields", `Fields (${data.fields.length})`]].map(([id, label]) => h("button", {
        key: id, role: "tab", "aria-selected": view === id,
        className: "sq3-pill" + (view === id ? " active" : ""), onClick: () => setView(id)
      }, label))),
    data && view === "fields" && (data.fields.length
      ? h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Label"), h("th", null, "Type"), h("th", null, "Required"))),
            h("tbody", null, data.fields.map(f => h("tr", {key: f.name},
              h("td", {className: "ff-mono"}, f.name), h("td", null, f.label), h("td", null, f.type),
              h("td", null, f.nillable === false && f.type !== "boolean" ? "✓" : ""))))))
      : h("div", {className: "insp-meta"}, "No custom fields yet. Add them in Setup.")),
    data && view === "records" && h(RecordsGrid, {
      typeName, data, pkg, onTogglePkg, recMember, fmt,
      onSaved: msg => { setNotice(msg); setTimeout(load, 1200); }
    }),
    data && h("div", {className: "insp-meta md-cmdt-hint"}, "Custom metadata is deployable configuration: records move with change sets and packages."));
}

export {CmdtDetail};
