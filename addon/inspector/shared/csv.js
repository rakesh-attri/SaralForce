import {parseCsv, toCsv as toCsvCore} from "../../core/csv.js";

// CSV parsing/writing lives in core/csv.js; these names are kept for the
// Export, Import, SOQL and Records tabs.
const parseCsvEx = parseCsv;
const toCsvEx = toCsvCore;

function toCsv(columns, rows) {
  // Quick downloads are opened in spreadsheets: neutralise formula cells.
  return toCsvCore(columns, rows, {guardFormulas: true});
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], {type: mime || "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stripAttributes = (v) => {
  if (Array.isArray(v)) return v.map(stripAttributes);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== "attributes") out[k] = stripAttributes(x);
  return out;
};

// One query record → one flat row. Parent relationships become dotted
// columns (Account.Name, Owner.Manager.Name) like a Bulk result; child
// sub-queries and compound values (address, location) stay as JSON text.
function flattenRecord(rec, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    const key = prefix + k;
    if (Array.isArray(v)) {
      out[key] = JSON.stringify(stripAttributes(v));
    } else if (v && typeof v === "object") {
      if (Array.isArray(v.records)) out[key] = JSON.stringify(stripAttributes(v.records));
      else if (v.attributes) flattenRecord(v, key + ".", out);
      else out[key] = JSON.stringify(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// Column list for flattened rows, in first-seen order after `known`. A null
// parent (Account: null) leaves a bare "Account" key on that row; it is
// dropped once other rows supply the real "Account.*" columns.
function columnsOf(rows, known = []) {
  const cols = new Set(known);
  for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
  const list = [...cols];
  return list.filter(c => !list.some(o => o.startsWith(c + ".")));
}

export {toCsv, downloadText, flattenRecord, columnsOf, parseCsvEx, toCsvEx};
