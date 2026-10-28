import {sfConn, apiVersion} from "../../inspector.js";
import {queryHostRecord} from "../../core/messaging.js";
import {parseSfInstant, formatSfDate, formatSfInstantForInput, parseSfWallInputToIso} from "../../sf-time.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {ffIsSfId, openRecordInSf} from "../shared/record-links.js";
import {kickSfTzFetch, useSfTimeZoneTick, ffFmtRelative, fmtSfCell} from "../shared/format.js";
import {sadTypeGlyph, sadInfoCell} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {ffApiPath, ffAutoApi, ffApiModeOf, ffDescribeObject} from "../shared/describe.js";

const h = React.createElement;

// ─── Id → object resolution (setup / classic record pages) ───────────────
// Setup and classic pages can hand us a bare record Id with no object name.
// Both global describes carry keyPrefix, so the Id prefix identifies the
// object; static entries only bridge the rare case where neither list loads.
const FF_STATIC_PREFIX_MAP = {
  "005": "User", "00e": "Profile", "00G": "Group", "00k": "Role",
  "0PS": "PermissionSet", "00N": "CustomField", "01z": "Layout",
  "01p": "ApexClass", "01I": "CustomObject", "02u": "CustomTab",
  "00O": "Report"
};

const _ffPrefixCache = {};   // "std" | "tooling" -> {keyPrefix: [objNames]}

async function ffPrefixMap(mode) {
  if (_ffPrefixCache[mode]) return _ffPrefixCache[mode];
  const res = await sfConn.rest(ffApiPath(mode, "sobjects/"), {useCache: false});
  const map = {};
  for (const o of (res.sobjects || [])) {
    if (o && o.keyPrefix && o.name) {
      (map[o.keyPrefix] = map[o.keyPrefix] || []).push(o.name);
    }
  }
  _ffPrefixCache[mode] = map;
  return map;
}

const _ffIdObjCache = {};   // 15-char record Id -> object API name

// Resolves a bare record Id to its object API name, or null when no listed
// object owns the prefix (the caller then falls back to the empty state).
async function ffResolveObjectById(id) {
  const raw = String(id || "");
  const short = /^[a-zA-Z0-9]{18}$/.test(raw) ? raw.slice(0, 15) : raw;
  if (!/^[a-zA-Z0-9]{15}$/.test(short)) return null;
  if (_ffIdObjCache[short]) return _ffIdObjCache[short];
  const prefix = short.slice(0, 3);
  const candidates = [];
  for (const mode of ["std", "tooling"]) {
    try {
      const map = await ffPrefixMap(mode);
      for (const name of (map[prefix] || [])) {
        if (!candidates.includes(name)) candidates.push(name);
      }
    } catch (e) { /* this endpoint's list is unavailable — still try the other */ }
  }
  if (!candidates.length && FF_STATIC_PREFIX_MAP[prefix]) {
    candidates.push(FF_STATIC_PREFIX_MAP[prefix]);
  }
  if (!candidates.length) return null;
  let obj = candidates[0];
  if (candidates.length > 1) {
    // One prefix can belong to several entities: the first candidate whose
    // record actually loads wins.
    for (const cand of candidates) {
      try {
        await fetchFullRecord(cand, short);
        obj = cand;
        break;
      } catch (e) { /* wrong candidate — keep probing */ }
    }
  }
  _ffIdObjCache[short] = obj;
  return obj;
}

// ─── Shared: "Show all data" record detail ────────────────────────────────
// Full-record fetch (REST retrieve returns every field) shaped into sorted
// {api, label, type, value} rows, plus the detail panel both Records and
// SOQL tabs render. Labels/types come from describe metadata; unknown
// fields fall back to inferred types.
function buildDetailRows(rec, metaFields) {
  const meta = {};
  for (const f of metaFields || []) meta[f.name] = f;
  const detailRows = [];
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    const m = meta[k] || {};
    let type = m.type || "";
    if (!type) {
      type = v == null ? "" : typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : "string";
    }
    let value = v;
    if (value && typeof value === "object") {
      value = Array.isArray(value) ? JSON.stringify(value) : (value.Name || value.name || JSON.stringify(value));
    }
    detailRows.push({
      api: k,
      label: m.label || (k === "Id" ? "Record ID" : ""),
      type,
      value: value == null || value === "" ? null : String(value),
      editable: k !== "Id" && m.updateable === true &&
        !["address", "location", "base64", "anyType"].includes(m.type),
      options: normalizePicklistValues(m.picklistValues)
    });
  }
  detailRows.sort((a, b) => a.api.localeCompare(b.api));
  return detailRows;
}

// Accepts raw describe picklistValues ([{active, value}]) or the already
// flattened active-value arrays kept by tab state.
function normalizePicklistValues(picklistValues) {
  const picks = [];
  for (const p of picklistValues || []) {
    if (p && typeof p === "object") {
      if (p.active !== false && p.value != null) picks.push(String(p.value));
    } else if (p != null) {
      picks.push(String(p));
    }
  }
  return picks;
}

async function fetchFullRecord(obj, id) {
  // Standard REST first, Tooling API when this object is only served there
  // (the resolved mode is remembered for the modal/export/save round trips).
  return ffAutoApi(obj,
    (mode) => ffApiPath(mode, `sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`),
    {useCache: true});
}

// Render an instant as SF-zone wall time for `datetime-local` inputs.
// Single conversion via the Salesforce user time zone — never browser-local,
// never a manual offset.
function toLocalInput(s) {
  kickSfTzFetch();
  try {
    return formatSfInstantForInput(s);
  } catch (e) {
    const d = parseSfInstant(s);
    if (!d) return String(s).slice(0, 16);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

function detailDraftSeed(row) {
  if (row.value == null) return row.type === "boolean" ? "false" : "";
  const s = String(row.value);
  if (row.type === "boolean") return s.toLowerCase() === "true" ? "true" : "false";
  if (row.type === "date") return s.slice(0, 10);
  if (row.type === "datetime") return toLocalInput(s);
  return s;
}

function draftDiffers(row, draftVal) {
  const orig = row.value == null ? "" : String(row.value);
  if (row.type === "boolean") return (String(draftVal) === "true") !== (orig.toLowerCase() === "true");
  if (row.type === "date") return String(draftVal) !== orig.slice(0, 10);
  if (row.type === "datetime") return String(draftVal) !== toLocalInput(orig);
  return String(draftVal) !== orig;
}

function coerceDetailValue(row, draftVal) {
  if (draftVal === "" || draftVal == null) return null;
  if (row.type === "boolean") return draftVal === "true";
  if (row.type === "datetime") {
    // Interpret the `datetime-local` wall time as SF-zone wall time so the
    // display->edit->save round trip is identity (no double conversion).
    try {
      return parseSfWallInputToIso(String(draftVal));
    } catch (e) {
      throw new Error(`${row.api}: "${draftVal}" is not a valid date/time.`);
    }
  }
  if (["int", "double", "currency", "percent"].includes(row.type)) {
    const n = Number(draftVal);
    if (!Number.isFinite(n)) throw new Error(`${row.api}: "${draftVal}" is not a number.`);
    return n;
  }
  return String(draftVal);
}

function RecordDetailPanel({detail, loading, onBack, onSave}) {
  useSfTimeZoneTick();
  const [editingApi, setEditingApi] = React.useState(null);
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);
  const [saveErr, setSaveErr] = React.useState(null);
  const [rowFilter, setRowFilter] = React.useState("");
  const recordKey = detail ? `${detail.obj}/${detail.id}` : "";
  React.useEffect(() => {
    setEditingApi(null);
    setDrafts({});
    setSaveMsg(null);
    setSaveErr(null);
    setRowFilter("");
  }, [recordKey]);
  // Esc closes the modal (editor Esc is handled inside the input and
  // stops propagation, so it only cancels the cell edit).
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  const canEdit = !loading && !saving && !!onSave;
  const changed = detail
    ? detail.rows.filter(r => r.editable && drafts[r.api] !== undefined && draftDiffers(r, drafts[r.api]))
    : [];
  const rf = rowFilter.trim().toLowerCase();
  const shownRows = !detail ? []
    : !rf ? detail.rows
    : detail.rows.filter(r => {
        const val = drafts[r.api] !== undefined
          ? String(drafts[r.api])
          : (r.value == null ? "" : String(r.value));
        return [r.api, r.label, r.type, val].join(" ").toLowerCase().includes(rf);
      });
  const startEdit = (row) => {
    if (!row.editable || !canEdit) return;
    setSaveMsg(null);
    setSaveErr(null);
    setDrafts(prev => (prev[row.api] !== undefined
      ? prev
      : {...prev, [row.api]: detailDraftSeed(row)}));
    setEditingApi(row.api);
  };
  const closeEditor = (discard) => {
    if (discard && editingApi) {
      const api = editingApi;
      setDrafts(prev => {
        const next = {...prev};
        delete next[api];
        return next;
      });
    }
    setEditingApi(null);
  };
  const cancelAll = () => {
    setDrafts({});
    setEditingApi(null);
    setSaveMsg(null);
    setSaveErr(null);
  };
  const doSave = async () => {
    if (!detail || !changed.length || saving) return;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const payload = {};
      for (const r of changed) payload[r.api] = coerceDetailValue(r, drafts[r.api]);
      await onSave(detail.obj, detail.id, payload);
      setDrafts({});
      setEditingApi(null);
      setSaveMsg(`Saved ${changed.length} field${changed.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  const renderEditor = (row) => {
    const val = drafts[row.api] !== undefined ? drafts[row.api] : detailDraftSeed(row);
    const set = (v) => setDrafts(prev => ({...prev, [row.api]: v}));
    const common = {
      className: "insp-edit-input",
      disabled: saving,
      onKeyDown: (e) => {
        if (e.key === "Escape") { e.stopPropagation(); closeEditor(true); }
        if (e.key === "Enter" && row.type !== "textarea" && !/longtext/i.test(String(row.type))) {
          e.preventDefault();
          setEditingApi(null);
        }
      },
      onClick: (e) => e.stopPropagation()
    };
    if (row.type === "boolean") {
      return h("input", {...common,
        type: "checkbox",
        checked: val === "true",
        onChange: (e) => set(e.target.checked ? "true" : "false")});
    }
    if (row.type === "picklist" && row.options && row.options.length) {
      const opts = (val === "" || row.options.includes(val)) ? row.options : [...row.options, val];
      return h("select", {...common, value: val, onChange: (e) => set(e.target.value)},
        h("option", {key: "", value: ""}, "(Blank)"),
        opts.map(o => h("option", {key: o, value: o}, o)));
    }
    if (row.type === "textarea" || /longtext/i.test(String(row.type))) {
      return h("textarea", {...common, rows: 2, value: val, onChange: (e) => set(e.target.value)});
    }
    if (row.type === "date") {
      return h("input", {...common, type: "date", value: String(val).slice(0, 10),
        onChange: (e) => set(e.target.value)});
    }
    if (row.type === "datetime") {
      return h("input", {...common, type: "datetime-local", value: String(val).slice(0, 16),
        onChange: (e) => set(e.target.value)});
    }
    if (["int", "double", "currency", "percent"].includes(row.type)) {
      return h("input", {...common, type: "number", value: val, onChange: (e) => set(e.target.value)});
    }
    return h("input", {...common, type: "text", value: val, onChange: (e) => set(e.target.value)});
  };
  const renderValue = (row) => {
    if (editingApi === row.api) return renderEditor(row);
    const hasDraft = drafts[row.api] !== undefined && draftDiffers(row, drafts[row.api]);
    let shown;
    if (hasDraft) {
      shown = String(drafts[row.api]);
    } else if (row.value == null) {
      shown = "(Blank)";
    } else if (row.type === "datetime") {
      shown = fmtSfCell(row.value, "datetime");
    } else if (row.type === "date") {
      shown = formatSfDate(row.value);
    } else {
      shown = row.value;
    }
    return h("span", {title: row.value == null ? "" : String(row.value)},
      shown,
      hasDraft && h("span", {className: "insp-dirty-dot", title: "Unsaved change"}, " *"));
  };
  return h("div", {
      className: "ff-modal-overlay",
      onMouseDown: (e) => { if (e.target === e.currentTarget) onBack(); }
    },
    h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
      h("div", {className: "ff-modal-head sad-head"},
        h("div", {className: "sad-title"},
          h("svg", {className: "sad-cloud", width: 30, height: 30, viewBox: "0 0 24 24",
            fill: "none", stroke: "currentColor", strokeWidth: 1.8,
            strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
            h("path", {d: "M7 18a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18.3 12H18a3 3 0 0 1 0 6H7z"})),
          h("span", {className: "sad-title-tx"}, "Show all data",
            detail && h("span", {className: "sad-title-sub"}, `  -  ${detail.obj} / ${detail.id}`),
            detail && h("span", {className: "sad-pill"},
              rf ? `${shownRows.length} of ${detail.rows.length} fields`
                 : `${detail.rows.length} fields`))),
        h("button", {className: "ff-modal-x sad-x", title: "Close (Esc)", onClick: onBack}, "\u00d7")
      ),
      h("div", {className: "sad-sub"},
      detail && ffIsSfId(detail.id) && h("button", {
        className: "btn btn-secondary btn-sm",
        title: "Open this record in Salesforce",
        onClick: (e) => openRecordInSf(detail.id, e)
        }, "Open in Salesforce ↗"),
      detail && h("span", {className: "insp-meta"},
        "Click an editable value to change it - Esc cancels the current edit"),
      h("div", {className: "soql-search"},
        h("svg", {
          className: "soql-search-ico",
          width: 14, height: 14, viewBox: "0 0 24 24",
          fill: "currentColor", "aria-hidden": "true"
        }, h("path", {
          d: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
        })),
        h("input", {
          className: "soql-search-input",
          value: rowFilter,
          placeholder: "Search fields...",
          onChange: e => setRowFilter(e.target.value)
        })
      )
    ),
    loading && h("div", {className: "insp-meta"}, "Loading full record…"),
    detail && h("div", {className: "sad-info"},
      h("div", {className: "sad-info-id"},
        h("div", {className: "sad-info-tile", "aria-hidden": "true"},
          h("svg", {width: 26, height: 26, viewBox: "0 0 24 24",
            fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": "true"},
            h("ellipse", {cx: 12, cy: 5.5, rx: 7.5, ry: 2.8}),
            h("path", {d: "M4.5 5.5v13c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-13"}),
            h("path", {d: "M4.5 12c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8"}))),
        h("div", null,
          h("div", {className: "sad-info-name"},
            (detail.meta && detail.meta.label) || detail.obj,
            h("span", {className: "rec-chip rec-chip-obj"}, "Object"),
            (detail.meta && detail.meta.viaTooling) && h("span",
              {className: "rec-chip rec-chip-api",
               title: "This record is served through the Tooling API"}, "Tooling API")),
          h("div", {className: "sad-info-api"}, "API Name: ",
            h("span", {className: "sad-info-apiv"}, detail.obj)))),
      h("div", {className: "sad-info-cells"},
        sadInfoCell("Fields", String(detail.rows.length)),
        sadInfoCell("Records",
          detail.meta && typeof detail.meta.total === "number"
            ? detail.meta.total.toLocaleString("en-US") : "—"),
        sadInfoCell("Last Updated",
          detail.meta && detail.meta.updated ? ffFmtRelative(detail.meta.updated) : "—"))
    ),
    detail && h("div", {className: "ff-modal-body"},
      h("div", {className: "insp-table-wrap"},
      h("table", {className: "insp-table sad-table"},
        h("thead", null,
          h("tr", null,
            h("th", null, "Field API Name"),
            h("th", null, "Label"),
            h("th", null, "Type"),
            h("th", null, "Value"),
            h("th", {className: "sad-act-h", "aria-hidden": "true"})
          )
        ),
        h("tbody", null,
          shownRows.map(r => {
            const isEditing = editingApi === r.api;
            const hasDraft = drafts[r.api] !== undefined && draftDiffers(r, drafts[r.api]);
            const canStart = r.editable && canEdit;
            return h("tr", {key: r.api},
              h("td", null, r.api),
              h("td", null, r.label),
              h("td", {className: "sad-type"},
                h("span", {className: "sad-type-ico", "aria-hidden": "true"},
                  sadTypeGlyph(r.type)),
                h("span", null, r.type)),
              h("td", {
                className: [
                  (!hasDraft && r.value == null) ? "insp-blank" : "",
                  canStart ? "insp-cell-editable" : "",
                  hasDraft ? "insp-cell-dirty" : ""
                ].join(" "),
                title: canStart ? (isEditing ? "" : "Click to edit") : (r.value == null ? "" : r.value),
                onClick: canStart && !isEditing ? () => startEdit(r) : undefined
              }, renderValue(r)),
              h("td", {className: "sad-act"},
                canStart && !isEditing
                  ? h("button", {
                      className: "sad-edit-btn",
                      title: `Edit ${r.api}`,
                      onClick: (e) => { e.stopPropagation(); startEdit(r); }
                    },
                    h("svg", {width: 13, height: 13, viewBox: "0 0 24 24",
                      fill: "none", stroke: "currentColor", strokeWidth: 2,
                      strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
                      h("path", {d: "M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"})))
                  : null)
            );
          })
        )
      )
    ),
    ),
    detail && rf && shownRows.length === 0 &&
      h("div", {className: "insp-empty"}, "No matching fields."),
    (changed.length > 0 || saveMsg || saveErr) && h("div", {className: "insp-edit-bar"},
      changed.length > 0 && h("span", {className: "insp-meta"},
        `${changed.length} field${changed.length === 1 ? "" : "s"} changed`),
      saveMsg && h("span", {className: "insp-save-ok"}, saveMsg),
      saveErr && h("span", {className: "insp-error"}, saveErr),
      h("span", {className: "insp-edit-actions"},
        changed.length > 0 && h("button", {
          className: "btn btn-danger btn-sm",
          disabled: saving,
          onClick: cancelAll
        }, "Cancel"),
        changed.length > 0 && h("button", {
          className: "btn btn-primary btn-sm",
          disabled: saving,
          onClick: doSave
        }, saving ? "Saving..." : "Save")
      ),
    ),
    ),
  );
}

// ─── Records: screenshot-driven summary UI ────────────────────────────────
// Exactly three views, nothing else:
//   VIEW R — open Salesforce record page: record header (name/meta/chips),
//     Quick Overview + Quick Actions, empty panel. Show All Data opens the
//     full-field modal (VIEW M) for THAT record.
//   VIEW O — object / list page: object header, Quick overview, empty
//     panel. Show All Data is record-only, so it is not offered here.
//   VIEW M — the shared RecordDetailPanel modal (see Shared section).
//   No context — the "No object selected" empty state with guidance and
//     a manual object-name loader.
// Context comes from the open page: button.js answers sfoc-query-open-record
// with {obj, id} (id null on list pages). There is no object picker, no
// field list, no rows table and no row-click detail.
function RecordsTab() {
  useSfTimeZoneTick();
  const [objInput, setObjInput] = useFfSession("records", "objInput", "");
  const [error, setError] = React.useState(null);
  const [detail, setDetail] = useFfSession("records", "detail", null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [objMeta, setObjMeta] = useFfSession("records", "objMeta", null);
  const [recordCount, setRecordCount] = useFfSession("records", "recordCount", null);
  const [lastRefresh, setLastRefresh] = useFfSession("records", "lastRefresh", null);
  const [descFields, setDescFields] = React.useState([]);
  const [pageRec, setPageRec] = React.useState(null);
  const [recDetail, setRecDetail] = React.useState(null);
  const [ctxLoading, setCtxLoading] = React.useState(false);
  // True while a bare record Id (setup/classic page) is being looked up.
  const [resolvingId, setResolvingId] = React.useState(false);

  const fmtCount = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");
  const countRecords = async (obj) => {
    try {
      const res = await ffAutoApi(obj,
        (mode) => ffApiPath(mode, "query/?q=" +
          encodeURIComponent(`SELECT COUNT() FROM ${obj}`)), {useCache: false});
      return typeof res.totalSize === "number" ? res.totalSize : null;
    } catch (e) {
      return null;   // best-effort — some tooling entities can't COUNT()
    }
  };
  const describe = async (objName) => {
    const obj = String(objName || "").trim();
    if (!obj) return null;
    // Auto mode: standard describe, Tooling API for setup-only objects.
    const d = await ffDescribeObject(obj);
    const total = await countRecords(obj);
    setObjInput(obj);
    setObjMeta({label: d.label || obj, custom: !!d.custom,
      fieldCount: (d.fields || []).length});
    setDescFields(d.fields || []);
    setRecordCount(total);
    setLastRefresh(Date.now());
    return d;
  };

  // Record context from the inspector-tab URL (openRecObj/openRecId, put
  // there by background.js): the new tab has no content-script parent, so
  // the opener page's context travels in the URL instead.
  const urlPageRec = () => {
    try {
      const q = new URLSearchParams(window.location.search);
      const id = (q.get("openRecId") || "").trim() || null;
      const obj = (q.get("openRecObj") || "").trim();
      if (obj && !/^[A-Za-z0-9_]+$/.test(obj)) return null;
      // Id-only contexts (setup/classic pages) arrive without an object
      // name — boot() resolves the object from the Id prefix.
      if (!obj && !id) return null;
      return {obj: obj || null, id};
    } catch (e) {
      return null;
    }
  };

  // Ask the host page which record/list is open (button.js replies
  // {obj, id}; id is null on list pages). Times out off-record.
  const queryPageRec = () => queryHostRecord();

  const loadRecordContext = async (rec) => {
    await describe(rec.obj); // warms the describe cache used below
    const full = await fetchFullRecord(rec.obj, rec.id);
    // Setup entities often have no Name column — Username (User), FullName
    // (CustomField/Layout/…), MasterLabel (custom metadata) fill that slot.
    const nameKeys = ["Name", "Username", "Subject", "Title", "CaseNumber",
      "FullName", "ApiName", "MasterLabel", "DeveloperName",
      "QualifiedApiName", "OrderNumber"];
    let name = null;
    if (full) {
      for (const k of nameKeys) {
        if (full[k] != null && String(full[k]).trim() !== "") { name = String(full[k]); break; }
      }
    }
    let updated = null;
    if (full && full.LastModifiedDate) {
      const t = Date.parse(full.LastModifiedDate);
      if (!isNaN(t)) updated = t;
    }
    // Record type chip (e.g. Business Account): resolved from the record's
    // RecordTypeId. Status chip: IsActive first, then a Status text field.
    // Both are best-effort — the chips are simply omitted when unknown.
    let recordType = null;
    if (full && full.RecordTypeId) {
      try {
        const rt = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM RecordType WHERE Id = '${full.RecordTypeId}'`),
          {useCache: false});
        const row = rt.records && rt.records[0];
        if (row && row.Name) recordType = String(row.Name);
      } catch (e) { /* omit chip */ }
    }
    let status = null;
    if (full && full.IsActive === true) {
      status = "Active";
    } else if (full && typeof full.Status === "string" && full.Status.trim() !== "") {
      status = full.Status.trim();
    }
    setPageRec({obj: rec.obj, id: rec.id});
    // viaTooling: drives the "Tooling API" badge — set only when this
    // record's data was actually served through the Tooling API.
    setRecDetail({name: name || (String(rec.id).slice(0, 6) + "…"), updated, recordType, status,
      viaTooling: ffApiModeOf(rec.obj) === "tooling"});
  };

  const loadObjectContext = async (obj) => {
    await describe(obj);
    setPageRec(prev => (prev && !prev.id && prev.obj === obj) ? prev : {obj, id: null});
    setRecDetail(null);
  };

  React.useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      setCtxLoading(true);
      setError(null);
      try {
        // New-tab inspector boots (VIEW R/O) carry the opener page's record
        // in the URL — that tab has no content-script parent to ask.
        let rec = urlPageRec();
        if (!rec) rec = await queryPageRec();
        if (cancelled) return;
        if (rec && rec.obj && rec.id) { await loadRecordContext(rec); return; }
        if (rec && rec.id) {
          // Setup / classic pages hand over a bare record Id — look the
          // object up from its Id prefix before loading the record.
          if (!cancelled) setResolvingId(true);
          const obj = await ffResolveObjectById(rec.id);
          if (cancelled) return;
          if (obj) { await loadRecordContext({obj, id: rec.id}); return; }
          if (!cancelled) {
            setError(`Could not resolve record Id ${rec.id} to an object: ` +
              `no object in this org lists its Id prefix.`);
          }
        } else if (rec && rec.obj) {
          await loadObjectContext(rec.obj);
          return;
        }
        // No record/list context on this page: drop any object left over
        // from an earlier page in this tab (SPA navigation keeps the panel
        // alive) and show the empty state instead of silently re-opening
        // a stale object.
        setObjInput("");
        setObjMeta(null);
        setRecordCount(null);
        setLastRefresh(null);
        setRecDetail(null);
        setDetail(null);
        setPageRec(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) {
          setCtxLoading(false);
          setResolvingId(false);
        }
      }
    };
    boot();
    return () => { cancelled = true; };
  }, []);

  const refreshContext = async () => {
    setCtxLoading(true);
    setError(null);
    try {
      if (pageRec && pageRec.obj && pageRec.id) {
        await loadRecordContext(pageRec);
      } else {
        const obj = (pageRec && pageRec.obj) || objInput.trim();
        if (obj) await loadObjectContext(obj);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setCtxLoading(false);
    }
  };

  // Manual object load from the empty state (explicit user action).
  const loadManualObject = async () => {
    const obj = objInput.trim();
    if (!obj || ctxLoading) return;
    setCtxLoading(true);
    setError(null);
    try {
      await loadObjectContext(obj);
    } catch (e) {
      setError(e.message);
    } finally {
      setCtxLoading(false);
    }
  };

  // VIEW M trigger: the full-field modal for the open page record.
  const openRecordModal = async () => {
    if (!pageRec || !pageRec.obj || !pageRec.id) return;
    setDetailLoading(true);
    setError(null);
    try {
      const d = await ffDescribeObject(pageRec.obj);
      const full = await fetchFullRecord(pageRec.obj, pageRec.id);
      setDescFields(d.fields || []);
      setDetail({id: pageRec.id, obj: pageRec.obj,
        rows: buildDetailRows(full, d.fields || []),
        meta: {label: d.label || pageRec.obj, custom: !!d.custom,
          viaTooling: ffApiModeOf(pageRec.obj) === "tooling",
          total: recordCount, updated: (recDetail && recDetail.updated) || lastRefresh || null}});
    } catch (e) {
      setError(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  // Export Records: CSV of the open record's fields (VIEW R only).
  const exportRecord = async () => {
    if (!pageRec || !pageRec.obj || !pageRec.id) return;
    setError(null);
    try {
      let rows = (detail && detail.id === pageRec.id) ? detail.rows : null;
      if (!rows) {
        const full = await fetchFullRecord(pageRec.obj, pageRec.id);
        rows = buildDetailRows(full, descFields);
      }
      const cols = ["Field API Name", "Label", "Type", "Value"];
      const csv = toCsv(cols, rows.map(r => ({
        "Field API Name": r.api, Label: r.label || "", Type: r.type || "",
        Value: r.value == null ? "" : String(r.value)
      })));
      downloadText(`${pageRec.obj}_${pageRec.id}.csv`, csv);
    } catch (e) {
      setError(e.message);
    }
  };

  // PATCH changed fields, then paint them immediately: the server accepted
  // the payload, so there is no need to wait for another round trip (and no
  // stale-value flash while a re-fetch is in flight).
  const saveDetailChanges = async (obj, id, changes) => {
    // Same endpoint order as the read path: Tooling PATCH for objects the
    // standard sobjects route does not serve.
    await ffAutoApi(obj,
      (mode) => ffApiPath(mode, `sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`),
      {method: "PATCH", body: changes});
    setDetail(prev => {
      if (!prev || prev.id !== id) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => Object.prototype.hasOwnProperty.call(changes, r.api)
          ? {...r, value: changes[r.api] == null ? null : String(changes[r.api])}
          : r)
      };
    });
  };

  const sumLabel = (objMeta && objMeta.label) || objInput.trim();
  const sumCustom = !!((objMeta && objMeta.custom));
  const sumTotal = recordCount;
  const sumUpdated = (recDetail && recDetail.updated) || lastRefresh;
  const sumFields = (objMeta && typeof objMeta.fieldCount === "number") ? objMeta.fieldCount : null;
  const isRecord = !!(pageRec && pageRec.obj && pageRec.id);
  const showObject = !isRecord && !!objInput.trim() && !!objMeta;
  const svgW = (paths, s) => h("svg", {width: s || 15, height: s || 15, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
    strokeLinejoin: "round", "aria-hidden": "true"}, ...paths);
  const gridSvg = () => h("svg", {
      width: 15, height: 15, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 2.2,
      "aria-hidden": "true"
    },
      h("rect", {x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5}),
      h("rect", {x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5}),
      h("rect", {x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5}),
      h("rect", {x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.5}));
  const dbSvg = (s) => h("svg", {width: s, height: s, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": "true"},
      h("ellipse", {cx: 12, cy: 5.5, rx: 7.5, ry: 2.8}),
      h("path", {d: "M4.5 5.5v13c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-13"}),
      h("path", {d: "M4.5 12c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8"}));
  const bldgSvg = (s) => h("svg", {width: s, height: s, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 1.7,
      strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
      h("path", {d: "M4 21h16"}),
      h("path", {d: "M6 21V4h8v17"}),
      h("path", {d: "M14 21V9h4v12"}),
      h("path", {d: "M8.5 7h2M8.5 10h2M8.5 13h2"}));
  const crownSvg = (s) => h("svg", {className: "rec-tile-crown", width: s, height: s,
      viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
      strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
      h("path", {d: "M3 8l3.5 3L12 5l5.5 6L21 8l-1.6 9H4.6z"}),
      h("path", {d: "M4 20h16"}));
  // Empty-state art: a browser/data window (CloudFlow style).
  const noselSvg = () => h("svg", {width: 104, height: 78, viewBox: "0 0 104 78",
      fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
      strokeLinejoin: "round", "aria-hidden": "true"},
      h("rect", {x: 8, y: 6, width: 88, height: 66, rx: 7}),
      h("path", {d: "M8 21h88"}),
      h("circle", {cx: 18, cy: 13.5, r: 1.7, fill: "currentColor", stroke: "none"}),
      h("circle", {cx: 25.5, cy: 13.5, r: 1.7, fill: "currentColor", stroke: "none"}),
      h("path", {d: "M22 60l14-16 10 12 7-8 17 12"}),
      h("circle", {cx: 68, cy: 35, r: 4.5}));
  // Mini (13px) glyphs for the summary meta rows and chips.
  const P_DOC = [h("path", {d: "M7 3h7l4 4v14H7z"}), h("path", {d: "M14 3v4h4"})];
  const P_SLIDERS = [h("path", {d: "M4 7h16"}), h("circle", {cx: 9, cy: 7, r: 2}),
    h("path", {d: "M4 12h16"}), h("circle", {cx: 15, cy: 12, r: 2}),
    h("path", {d: "M4 17h16"}), h("circle", {cx: 8, cy: 17, r: 2})];
  const P_REFRESH = [h("path", {d: "M20 12a8 8 0 1 1-2.34-5.66"}), h("path", {d: "M20 4v5h-5"})];
  const P_CODE = [h("path", {d: "M9 8l-5 4 5 4"}), h("path", {d: "M15 8l5 4-5 4"})];
  const P_CASE = [h("path", {d: "M4 8h16v11H4z"}), h("path", {d: "M9 8V6h6v2"})];
  const P_CLOCK = [h("circle", {cx: 12, cy: 12, r: 8}), h("path", {d: "M12 8v4l3 2"})];
  const miniSvg = (paths) => svgW(paths, 13);
  const metaItem = (icon, text) => h("span", {className: "rec-meta-item"},
    icon, h("span", null, text));
  const metaSep = () => h("span", {className: "rec-meta-sep", "aria-hidden": "true"}, "|");
  const statSvg = (kind) => h("svg", {width: 26, height: 26, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round",
      strokeLinejoin: "round", "aria-hidden": "true"},
      kind === "records"
        ? [h("path", {key: "a", d: "M7 3h7l4 4v14H7z"}),
           h("path", {key: "b", d: "M14 3v4h4"}),
           h("path", {key: "c", d: "M10 12h5"}),
           h("path", {key: "d", d: "M10 16h5"})]
        : kind === "fields"
        ? [h("path", {key: "a", d: "M4 7h16"}),
           h("circle", {key: "b", cx: 9, cy: 7, r: 2}),
           h("path", {key: "c", d: "M4 12h16"}),
           h("circle", {key: "d", cx: 15, cy: 12, r: 2}),
           h("path", {key: "e", d: "M4 17h16"}),
           h("circle", {key: "f", cx: 8, cy: 17, r: 2})]
        : [h("circle", {key: "a", cx: 12, cy: 12, r: 8}),
           h("path", {key: "b", d: "M12 8v4l3 2"})]);
  const statCard = (kind, label, value) => h("div", {className: "rec-stat"},
      h("div", {className: "rec-stat-ico rec-stat-" + kind}, statSvg(kind)),
      h("div", {className: "rec-stat-tx"},
        h("div", {className: "rec-stat-l"}, label),
        h("div", {className: "rec-stat-v"}, value)));
  const refreshBtn = (key) => h("button", {key, className: "rec-act-btn",
      disabled: ctxLoading,
      title: "Refresh object details", onClick: refreshContext},
      svgW([h("path", {d: "M20 12a8 8 0 1 1-2.34-5.66"}), h("path", {d: "M20 4v5h-5"})]),
      h("span", null, "Refresh"));
  const exportBtn = (key) => h("button", {key, className: "rec-act-btn",
      disabled: !isRecord || ctxLoading,
      title: isRecord ? "Download this record's fields as CSV" : "Open a record page to export it",
      onClick: exportRecord},
      svgW([h("path", {d: "M12 4v11"}), h("path", {d: "M7 11l5 5 5-5"}),
        h("path", {d: "M5 20h14"})]),
      h("span", null, "Export Records"));

  return h("div", {className: "insp-panel"},
    (isRecord && h("div", {className: "rec-sum-card"},
      h("div", {className: "rec-sum-top"},
        h("div", {className: "rec-sum-id"},
          h("div", {className: "rec-sum-tile", "aria-hidden": "true"}, bldgSvg(30)),
          h("div", {className: "rec-sum-titles"},
            h("span", {className: "rec-sum-obj"}, dbSvg(11), h("span", null, sumLabel)),
            h("div", {className: "rec-sum-name"},
              ctxLoading && !recDetail ? "Loading…" : ((recDetail && recDetail.name) || sumLabel)),
            h("div", {className: "rec-sum-meta"},
              metaItem(dbSvg(13), `Object: ${pageRec.obj}`), metaSep(),
              metaItem(miniSvg(P_DOC), `API Name: ${pageRec.obj}`), metaSep(),
              metaItem(miniSvg(P_SLIDERS), `Fields: ${sumFields != null ? sumFields : "—"}`), metaSep(),
              metaItem(miniSvg(P_DOC), `Records: ${fmtCount(sumTotal)}`)),
            h("div", {className: "rec-sum-chips"},
              (recDetail && recDetail.recordType) && h("span", {className: "rec-chip"},
                miniSvg(P_CASE), h("span", null, recDetail.recordType)),
              (recDetail && recDetail.status) && h("span", {className: /active/i.test(recDetail.status)
                ? "rec-chip rec-chip-green" : "rec-chip rec-chip-soft"},
                h("span", {className: /active/i.test(recDetail.status)
                  ? "rec-dot" : "rec-dot rec-dot-grey", "aria-hidden": "true"}),
                h("span", null, recDetail.status)),
              (recDetail && recDetail.viaTooling) && h("span",
                {className: "rec-chip rec-chip-api", title: "This record is served through the Tooling API"},
                miniSvg(P_CODE), h("span", null, "Tooling API")),
              h("span", {className: "rec-chip rec-chip-soft"},
                miniSvg(P_CLOCK),
                h("span", null, "Last updated: " + ffFmtRelative(sumUpdated)))))),
        h("div", {className: "rec-sum-action"},
          h("button", {
            className: "rec-obj-showall",
            disabled: ctxLoading || detailLoading,
            title: `Show all data for this ${pageRec.obj} record`,
            onClick: openRecordModal
          }, gridSvg(), h("span", null, detailLoading ? "Loading…" : "Show All Data"),
            h("span", {className: "rec-obj-chev", "aria-hidden": "true"}, "›")))),
      h("div", {className: "rec-quick-split"},
        h("div", {className: "rec-quick-col"},
          h("h3", {className: "rec-quick-h"}, "Quick Overview"),
          h("div", {className: "rec-stats"},
            statCard("records", "Total Records", fmtCount(sumTotal)),
            statCard("fields", "Fields", sumFields != null ? String(sumFields) : "—"),
            statCard("updated", "Last Updated", ffFmtRelative(sumUpdated)))),
        h("div", {className: "rec-quick-col"},
          h("h3", {className: "rec-quick-h"}, "Quick Actions"),
          h("div", {className: "rec-actions"}, [refreshBtn("ref"), exportBtn("exp")]))),
      h("div", {className: "rec-empty"},
        h("div", {className: "rec-empty-ico", "aria-hidden": "true"}, bldgSvg(64)),
        h("div", {className: "rec-empty-t"}, `Ready to explore your ${sumLabel} records`),
        h("div", {className: "rec-empty-s"},
          `Click "Show All Data" to see every field of this ${sumLabel} record, or use the quick actions above to refresh details or export the record.`)
      )
    )),
    (showObject && h("div", {className: "rec-sum-card"},
      h("div", {className: "rec-sum-top"},
        h("div", {className: "rec-sum-id"},
          h("div", {className: "rec-sum-tile", "aria-hidden": "true"}, crownSvg(30)),
          h("div", {className: "rec-sum-titles"},
            h("div", {className: "rec-sum-name"}, sumLabel),
            h("div", {className: "rec-sum-chips"},
              h("span", {className: "rec-chip rec-chip-std"}, dbSvg(12), h("span", null, sumCustom ? "Custom" : "Standard")),
              h("span", {className: "rec-chip rec-chip-api"}, miniSvg(P_CODE), h("span", null, "API Name: " + objInput.trim()))),
            h("div", {className: "rec-sum-meta"},
              metaItem(miniSvg(P_SLIDERS), ((sumFields != null ? sumFields : "\u2014") + " Fields")), metaSep(),
              metaItem(miniSvg(P_DOC), `${fmtCount(sumTotal)} Records`), metaSep(),
              h("span", {className: "rec-meta-item"}, miniSvg(P_REFRESH),
                h("span", null, "Last refreshed: "),
                h("span", {className: "rec-fresh"}, ffFmtRelative(sumUpdated))))))),
      h("h3", {className: "rec-quick-h"}, "Quick overview"),
      h("div", {className: "rec-stats"},
        statCard("records", "Total Records", fmtCount(sumTotal)),
        statCard("fields", "Fields", sumFields != null ? String(sumFields) : "—"),
        statCard("updated", "Last Updated", ffFmtRelative(sumUpdated))),
      h("div", {className: "rec-actions rec-actions-under"},
        [refreshBtn("ref"), exportBtn("exp")]),
      h("div", {className: "rec-empty"},
        h("div", {className: "rec-empty-ico", "aria-hidden": "true"}, dbSvg(64)),
        h("div", {className: "rec-empty-t"}, "Ready to explore your records"),
        h("div", {className: "rec-empty-s"},
          "Open any record of this object to see all of its field values with Show All Data, " +
          "or use Refresh above to update these details.")
      )
    )),
    (!isRecord && !showObject && (ctxLoading
      ? h("div", {className: "insp-meta"}, resolvingId ? "Resolving record…" : "Loading…")
      : h("div", {className: "rec-nosel"},
          h("div", {className: "rec-nosel-art", "aria-hidden": "true"}, noselSvg()),
          h("div", {className: "rec-nosel-t"}, "No object selected"),
          h("div", {className: "rec-nosel-s"},
            "Open a Salesforce record or list view to explore and analyze its data here."),
          h("div", {className: "rec-nosel-box"},
            h("div", {className: "rec-nosel-box-t"}, "How to get started?"),
            h("ul", {className: "rec-nosel-list"},
              h("li", null, "Open any record page - its object, fields and record count load here automatically."),
              h("li", null, "Open a list view (for example Accounts) to inspect that object."),
              h("li", null, "Or type an object API name below (for example Account or Invoice__c)."))),
          h("div", {className: "rec-nosel-load"},
            h("input", {
              className: "rec-nosel-input",
              placeholder: "Object API name (e.g. Account)",
              "aria-label": "Object API name",
              value: objInput,
              onChange: (e) => setObjInput(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") loadManualObject(); }
            }),
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: !objInput.trim() || ctxLoading,
              onClick: loadManualObject
            }, "Load Object"))))),
    error && h("div", {className: "insp-error"}, error),
    (detailLoading || detail) && h(RecordDetailPanel, {
      detail,
      loading: detailLoading,
      onBack: () => setDetail(null),
      onSave: saveDetailChanges
    }),
  );
}

export {buildDetailRows, fetchFullRecord, RecordDetailPanel, RecordsTab};
