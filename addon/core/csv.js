// CSV parsing and writing shared by every tool (SOQL download, Export,
// Import, Records). Pure: no DOM or browser APIs, so it is unit-tested.

// Parses delimited text with quoted values, escaped quotes ("") and
// embedded delimiters/newlines. Returns {headers, records, duplicates}, or
// {headers: [], records: [], parseError} when a quoted value is never closed.
// Blank rows are skipped; headers are trimmed.
export function parseCsv(text, opts) {
  const o = opts || {};
  const delim = o.delimiter || ",";
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (inQuotes) {
    return {headers: [], records: [], duplicates: [], parseError: "CSV parsing error: a quoted value is never closed (missing \")."};
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return {headers: [], records: [], duplicates: []};
  const headers = rows[0].map(x => String(x == null ? "" : x).trim());
  const seen = {};
  const duplicates = [];
  for (const hd of headers) {
    const k = hd.toLowerCase();
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] === 2) duplicates.push(hd);
  }
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => String(c || "").trim() === "")) continue;
    const obj = {};
    headers.forEach((hName, idx) => { obj[hName] = r[idx] ?? ""; });
    records.push(obj);
  }
  return {headers, records, duplicates};
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+([.,]\d+)*|\.\d+)([eE][+-]?\d+)?%?$/;

// Spreadsheet apps run cells starting with = + - @ as formulas, so exported
// org data could execute in Excel. Such values get a leading apostrophe,
// except plain numbers like -42 or +3.5, which stay untouched.
export function guardFormula(s) {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? "'" + s : s;
}

// Serialises rows (objects keyed by column) as delimited text.
// opts: delimiter (","), quoting "minimal" | "all", headers (true),
// nullValue (""), lineEnding "\r\n" | "\n", guardFormulas (false).
export function toCsv(columns, rows, opts) {
  const o = opts || {};
  const delim = o.delimiter || ",";
  const quoteAll = o.quoting === "all";
  const nullValue = o.nullValue != null ? String(o.nullValue) : "";
  const esc = (v) => {
    if (v == null || v === "") return nullValue;
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (o.guardFormulas) s = guardFormula(s);
    if (quoteAll || s.includes(delim) || /["\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [];
  if (o.headers !== false) lines.push(columns.map(c => esc(c)).join(delim));
  for (const row of rows) lines.push(columns.map(c => esc(row[c])).join(delim));
  return lines.join(o.lineEnding === "\n" ? "\n" : "\r\n");
}

// Single-value escape with the default options (comma, minimal quoting).
export function csvEscape(v) {
  return toCsv(["v"], [{v}], {headers: false});
}
