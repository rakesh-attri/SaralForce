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

function flattenRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = v.name || v.Id || v.url || JSON.stringify(v);
    } else if (Array.isArray(v)) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export {toCsv, downloadText, flattenRecord, parseCsvEx, toCsvEx};
