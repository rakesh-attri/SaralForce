import {toCsv} from "../../core/csv.js";

// Pure module (no React/DOM/chrome/session at import time) so it is
// unit-tested with node --test. These two mirror record-links.js and
// format.js, which pull in the live session.
function ffIsSfId(value) {
  const v = String(value || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(v) || /^[a-zA-Z0-9]{18}$/.test(v);
}
function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}

// ── Import mapping + validation ────────────────────────────────────────────
// Suggest header → field mappings by exact API name first, then by label
// (case/punctuation-insensitive). Each field is consumed at most once.
function ffSuggestFieldMap(headers, fields) {
  const byName = {};
  const byLabel = {};
  for (const f of fields || []) {
    if (!f || !f.name) continue;
    byName[String(f.name).toLowerCase()] = f.name;
    if (f.label) byLabel[String(f.label).toLowerCase().replace(/[^a-z0-9]/g, "")] = f.name;
  }
  const map = {};
  const used = new Set();
  for (const hd of headers || []) {
    const low = String(hd || "").trim().toLowerCase();
    let hit = byName[low] || byLabel[low.replace(/[^a-z0-9]/g, "")] || "";
    if (hit && used.has(hit)) hit = "";
    if (hit) used.add(hit);
    map[hd] = hit;
  }
  return map;
}

const FF_BOOL_TRUE = /^(true|1|yes|y|on)$/i;
const FF_BOOL_FALSE = /^(false|0|no|n|off)$/i;
const FF_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FF_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Client-side import validation. Preliminary by design — only Salesforce
// can enforce server-side validation, automation and duplicate rules.
// Returns {issues, rowSeverity, okRows, warnRows, errorRows, hardErrors}.
function ffValidateImport(opts) {
  const headers = opts.headers || [];
  const records = opts.records || [];
  const fieldMap = opts.fieldMap || {};
  const fields = opts.fields || [];
  const operation = opts.operation || "insert";
  const externalId = opts.externalId || "";
  const issues = [];
  const fieldByName = {};
  for (const f of fields) if (f && f.name) fieldByName[f.name] = f;

  // Duplicate CSV headers.
  const seen = {};
  for (const hd of headers) {
    const k = String(hd).toLowerCase();
    seen[k] = (seen[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(seen)) {
    if (n > 1) issues.push({row: 0, field: k, severity: "error",
      problem: `Duplicate CSV header appears ${n} times`,
      suggestion: "Rename the duplicate column in your CSV"});
  }

  // Duplicate target fields.
  const targets = {};
  for (const [hd, fa] of Object.entries(fieldMap)) {
    if (!fa) continue;
    (targets[fa] = targets[fa] || []).push(hd);
  }
  for (const [fa, cols] of Object.entries(targets)) {
    if (cols.length > 1) issues.push({row: 0, field: fa, severity: "error",
      problem: `Mapped from ${cols.length} CSV columns (${cols.join(", ")})`,
      suggestion: "Map only one column to each Salesforce field"});
  }

  // Unknown fields.
  for (const [hd, fa] of Object.entries(fieldMap)) {
    if (fa && !fieldByName[fa]) issues.push({row: 0, field: fa, severity: "error",
      problem: `"${fa}" (mapped from "${hd}") is not a field on this object`,
      suggestion: "Pick a field from the dropdown"});
  }

  // Operation-specific configuration.
  if (operation === "upsert" && !externalId) {
    issues.push({row: 0, field: "(upsert)", severity: "error",
      problem: "Upsert requires an External ID field",
      suggestion: "Choose the External ID field in Import Setup"});
  }
  const idMapped = Object.values(fieldMap).some(fa => fa === "Id");
  if ((operation === "update" || operation === "delete") && !idMapped) {
    issues.push({row: 0, field: "Id", severity: "error",
      problem: `${operation === "update" ? "Update" : "Delete"} requires an Id column mapped to Id`,
      suggestion: "Map a CSV column containing Salesforce record IDs to Id"});
  }

  // Required fields (createable, not nillable, no default) for row-creating ops.
  if (operation === "insert" || operation === "upsert") {
    const mappedTargets = new Set(Object.values(fieldMap).filter(Boolean));
    for (const f of fields) {
      if (!f || !f.name || f.name === "Id") continue;
      if (f.nillable === false && f.defaultedOnCreate !== true && !mappedTargets.has(f.name)) {
        issues.push({row: 0, field: f.name, severity: "error",
          problem: `Required field ${f.name} is not mapped`,
          suggestion: `Map a CSV column to ${f.label || f.name}`});
      }
    }
  }

  // Per-row checks.
  const rowSeverity = {};
  const mark = (idx, sev) => {
    if (sev === "error") rowSeverity[idx] = "error";
    else if (sev === "warn" && rowSeverity[idx] !== "error") rowSeverity[idx] = "warn";
    else if (!rowSeverity[idx]) rowSeverity[idx] = "ok";
  };
  records.forEach((rec, idx) => {
    const rowNo = idx + 2; // 1-based + header row
    for (const [hd, fa] of Object.entries(fieldMap)) {
      if (!fa || !fieldByName[fa]) continue;
      const f = fieldByName[fa];
      const raw = rec[hd];
      if (raw == null || String(raw).trim() === "") {
        if (f.nillable === false && f.defaultedOnCreate !== true &&
            (operation === "insert" || operation === "upsert")) {
          issues.push({row: rowNo, field: fa, severity: "error",
            problem: "Required field is blank", suggestion: `Provide a value for ${fa}`});
          mark(idx, "error");
        }
        continue;
      }
      const v = String(raw).trim();
      const t = String(f.type || "").toLowerCase();
      const err = (problem, suggestion) => {
        issues.push({row: rowNo, field: fa, severity: "error", problem, suggestion});
        mark(idx, "error");
      };
      if (t === "boolean" && !FF_BOOL_TRUE.test(v) && !FF_BOOL_FALSE.test(v)) {
        err(`"${v}" is not a valid boolean`, "Use true/false (or 1/0)");
      } else if (["int", "double", "currency", "percent"].includes(t) && isNaN(Number(v.replace(/,/g, "")))) {
        err(`"${v}" is not a valid number`, "Use a plain number, e.g. 1234.56");
      } else if (t === "date" && !FF_DATE_RE.test(v)) {
        err(`"${v}" is not a valid date`, "Use YYYY-MM-DD");
      } else if (t === "datetime" && !FF_DATETIME_RE.test(v)) {
        err(`"${v}" is not a valid datetime`, "Use ISO 8601, e.g. 2026-01-31T10:00:00Z");
      } else if ((t === "picklist" || t === "multipicklist") && f.picklistValues &&
          f.picklistValues.length &&
          !f.picklistValues.some(pl => String(pl.value) === v)) {
        issues.push({row: rowNo, field: fa, severity: "warn",
          problem: `"${v}" is not an active picklist value`,
          suggestion: "Salesforce will reject restricted picklists; check the field setup"});
        mark(idx, "warn");
      } else if (fa === "Id" && !ffIsSfId(v)) {
        err(`"${v}" is not a valid Salesforce Id`, "Ids are 15 or 18 characters, e.g. 001...");
      }
    }
    mark(idx, rowSeverity[idx] || "ok");
  });

  // Record-count guidance.
  if (records.length > 100000) {
    issues.push({row: 0, field: "(file)", severity: "warn",
      problem: `${fmtNum(records.length)} rows is very large for in-browser processing`,
      suggestion: "Split the file or use Bulk API 2.0"});
  }

  let okRows = 0, warnRows = 0, errorRows = 0;
  for (let i = 0; i < records.length; i++) {
    const s = rowSeverity[i];
    if (s === "error") errorRows++;
    else if (s === "warn") warnRows++;
    else okRows++;
  }
  const hardErrors = issues.filter(x => x.severity === "error").length;
  return {issues, rowSeverity, okRows, warnRows, errorRows, hardErrors};
}

// ── Data API import via sObject Collections ────────────────────────────────
// Prepared rows look like {index, body, idVal, extVal} (see prepareRows in
// tabs/import.js). Spreadsheet row number = index + 2 (header is row 1).
const ffImportRowNum = (row) => row.index + 2;

// Records per Collections call: 1..200, default 200.
function ffCollectionsChunkSize(value) {
  const n = parseInt(value, 10);
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : 200, 200));
}

// Builds the Collections payload for one chunk of rows. Rows that cannot be
// sent (missing Id / external ID value) are rejected with the same messages
// the old per-row REST code produced. Returns {send: [{row, record}], rejected:
// [{row, message}]} where record is a field map (insert/update/upsert) or an
// Id string (delete).
function ffBuildCollectionsChunk(rows, operation, externalId) {
  const send = [];
  const rejected = [];
  for (const row of rows || []) {
    const fail = (message) => rejected.push({row: ffImportRowNum(row), message});
    if (operation === "insert") {
      send.push({row, record: Object.assign({}, row.body)});
    } else if (operation === "update") {
      if (!row.idVal) { fail("Missing Id"); continue; }
      send.push({row, record: Object.assign({}, row.body, {Id: row.idVal})});
    } else if (operation === "upsert") {
      if (!externalId) { fail("External ID field not selected"); continue; }
      if (!row.extVal) { fail(`Missing value for External ID ${externalId}`); continue; }
      send.push({row, record: Object.assign({}, row.body, {[externalId]: row.extVal})});
    } else if (operation === "delete") {
      if (!row.idVal) { fail("Missing Id"); continue; }
      send.push({row, record: row.idVal});
    } else {
      fail("Hard Delete requires Bulk API 2.0");
    }
  }
  return {send, rejected};
}

// "STATUS_CODE: message [Field1, Field2]" per error, one per line (same
// format the REST client uses for request errors).
function ffFormatSaveErrors(errors) {
  const lines = (errors || []).filter(Boolean).map(e => {
    const code = e.statusCode || e.errorCode;
    const fields = e.fields && e.fields.length ? ` [${e.fields.join(", ")}]` : "";
    return `${code ? code + ": " : ""}${e.message || ""}${fields}`;
  });
  return lines.join("\n") || "Unknown error";
}

// Maps SaveResults (input order) back to their source rows.
// Returns {successes: [{row, index, id, created?}], failures: [{row, index, message}]}.
// created is only set for upsert, where Salesforce reports it.
function ffMapSaveResults(send, results, operation) {
  const successes = [];
  const failures = [];
  (send || []).forEach((item, i) => {
    const r = results ? results[i] : null;
    const row = ffImportRowNum(item.row);
    const index = item.row.index;
    if (!r) {
      failures.push({row, index, message: "No result returned by Salesforce for this record"});
    } else if (r.success) {
      const s = {row, index, id: r.id || (typeof item.record === "string" ? item.record : "") || ""};
      if (operation === "upsert" && typeof r.created === "boolean") s.created = r.created;
      successes.push(s);
    } else {
      failures.push({row, index, message: ffFormatSaveErrors(r.errors)});
    }
  });
  return {successes, failures};
}

// Marks every sent row of a chunk as failed (the whole Collections call was
// rejected, e.g. network error or an invalid field in the payload).
function ffFailChunk(send, message) {
  return (send || []).map(item => ({row: ffImportRowNum(item.row), index: item.row.index, message}));
}

// Result files for a Data API run, shaped like the Bulk 2.0 ones: the source
// CSV columns prefixed with sf__Id (+ sf__Created for upsert) or sf__Error.
function ffDataResultFiles({headers, records, successes, failures, operation, lineEnding}) {
  const opts = {delimiter: ",", lineEnding, guardFormulas: false};
  const pick = (index) => (index != null && records && records[index]) || {};
  const okCols = ["sf__Id"].concat(operation === "upsert" ? ["sf__Created"] : [], headers || []);
  const okRows = (successes || []).map(s => Object.assign({}, pick(s.index), {
    sf__Id: s.id || "",
    sf__Created: s.created == null ? "" : String(s.created)
  }));
  const errCols = ["sf__Error"].concat(headers || []);
  const errRows = (failures || []).map(f => Object.assign({}, pick(f.index), {sf__Error: f.message}));
  return {
    success: okRows.length ? toCsv(okCols, okRows, opts) : "",
    failed: errRows.length ? toCsv(errCols, errRows, opts) : ""
  };
}

export {ffSuggestFieldMap, ffValidateImport, ffCollectionsChunkSize, ffBuildCollectionsChunk,
  ffFormatSaveErrors, ffMapSaveResults, ffFailChunk, ffDataResultFiles};
