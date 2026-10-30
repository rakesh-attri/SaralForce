// Schema → Data quality: profile a sample of records (fill rate, values,
// outliers, duplicates). Pure functions; the tab does the querying.

const SKIP_TYPES = new Set(["address", "location", "base64", "anyType", "complexvalue", "encryptedstring"]);
const NUMERIC = new Set(["double", "currency", "percent", "int", "long"]);
// Fields whose values identify a record; used to look for duplicates.
const DUP_KEYS = ["Name", "Email", "Phone", "Website", "Subject", "Title"];

// Fields worth profiling, at most `max` (a SELECT has a length limit). System
// audit fields are skipped; Id is always first.
export function qualityFields(describe, max = 80) {
  const audit = /^(Id|IsDeleted|SystemModstamp|LastViewedDate|LastReferencedDate|LastActivityDate|CreatedById|LastModifiedById|LastModifiedDate)$/;
  const fields = (describe.fields || []).filter(f => !SKIP_TYPES.has(f.type) && !audit.test(f.name) && !f.compoundFieldName);
  // Custom fields first: they are the ones admins can fix.
  fields.sort((a, b) => (b.custom ? 1 : 0) - (a.custom ? 1 : 0));
  return ["Id", ...fields.slice(0, max).map(f => f.name)];
}

export function qualityQuery(describe, fields, limit) {
  const hasCreated = (describe.fields || []).some(f => f.name === "CreatedDate");
  return `SELECT ${fields.join(", ")} FROM ${describe.name}${hasCreated ? " ORDER BY CreatedDate DESC" : ""} LIMIT ${limit}`;
}

const isBlank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
// Comparison key: phone numbers by digits, URLs without scheme/www, text by
// case and spacing.
const norm = v => {
  const s = String(v).trim().toLowerCase();
  if (/^[\d\s()+\-.]+$/.test(s)) return s.replace(/\D/g, "");
  return s.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").replace(/\s+/g, " ");
};

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Per-field profile. `describe` gives labels/types; records come from the query.
export function profileFields(records, describe, fields) {
  const byName = new Map((describe.fields || []).map(f => [f.name, f]));
  const n = records.length;
  return fields.filter(name => name !== "Id").map(name => {
    const f = byName.get(name) || {name, label: name, type: "string"};
    const values = records.map(r => r[name]);
    const filled = values.filter(v => !isBlank(v) && !(f.type === "boolean" && v === false));
    const counts = new Map();
    for (const v of filled) {
      const k = typeof v === "object" ? JSON.stringify(v) : String(v);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let top = null;
    for (const [k, c] of counts) if (!top || c > top.count) top = {value: k, count: c};
    const out = {
      name, label: f.label || name, type: f.type, custom: !!f.custom, required: f.nillable === false,
      filled: filled.length, fillPct: n ? Math.round((filled.length / n) * 100) : 0,
      distinct: counts.size, top: top ? {value: top.value, pct: Math.round((top.count / Math.max(1, filled.length)) * 100)} : null,
      outliers: 0
    };
    if (NUMERIC.has(f.type) && filled.length >= 8) {
      const nums = filled.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const q1 = quantile(nums, 0.25);
      const q3 = quantile(nums, 0.75);
      const iqr = q3 - q1;
      if (iqr > 0) {
        const lo = q1 - 3 * iqr;
        const hi = q3 + 3 * iqr;
        out.outliers = nums.filter(x => x < lo || x > hi).length;
        out.range = {min: nums[0], max: nums[nums.length - 1], lo, hi};
      }
    }
    if (f.type === "picklist" && Array.isArray(f.picklistValues) && f.picklistValues.length) {
      const allowed = new Set(f.picklistValues.filter(p => p.active !== false).map(p => p.value));
      out.invalid = filled.filter(v => !allowed.has(v)).length;
    }
    return out;
  });
}

// Records sharing a normalised Name / Email / Phone… value.
export function duplicateGroups(records, fields, maxGroups = 20) {
  const keys = DUP_KEYS.filter(k => fields.includes(k));
  const groups = [];
  for (const key of keys) {
    const map = new Map();
    for (const r of records) {
      const v = r[key];
      if (isBlank(v)) continue;
      const k = norm(v);
      if (!map.has(k)) map.set(k, {field: key, value: String(v), ids: []});
      map.get(k).ids.push(r.Id);
    }
    for (const g of map.values()) if (g.ids.length > 1) groups.push(g);
  }
  return groups.sort((a, b) => b.ids.length - a.ids.length).slice(0, maxGroups);
}

// Plain-words issues, worst first, and a 0-100 score.
export function qualityIssues(profiles, dups, sampleSize) {
  const issues = [];
  for (const p of profiles) {
    if (!sampleSize) break;
    if (p.filled === 0 && p.type !== "boolean") issues.push({level: "warn", field: p.name, text: `${p.label} is never filled in this sample — unused field?`});
    else if (p.fillPct < 20 && p.type !== "boolean") issues.push({level: "info", field: p.name, text: `${p.label} is filled on only ${p.fillPct}% of records`});
    if (p.filled >= 10 && p.distinct === 1 && p.type !== "boolean") issues.push({level: "info", field: p.name, text: `${p.label} always has the same value ("${String(p.top.value).slice(0, 40)}")`});
    if (p.outliers) issues.push({level: "warn", field: p.name, text: `${p.label} has ${p.outliers} extreme value(s) outside ${fmtNum(p.range.lo)} … ${fmtNum(p.range.hi)}`});
    if (p.invalid) issues.push({level: "warn", field: p.name, text: `${p.label} has ${p.invalid} value(s) that are not active picklist values`});
  }
  for (const g of dups.slice(0, 5)) {
    issues.push({level: "warn", field: g.field, text: `${g.ids.length} records share ${g.field} "${g.value.slice(0, 40)}" — possible duplicates`});
  }
  const rank = {warn: 0, info: 1};
  issues.sort((a, b) => rank[a.level] - rank[b.level]);
  const avgFill = profiles.length ? profiles.reduce((s, p) => s + p.fillPct, 0) / profiles.length : 100;
  const dupRecords = dups.reduce((s, g) => s + g.ids.length - 1, 0);
  const warnCount = issues.filter(i => i.level === "warn").length;
  const score = Math.max(0, Math.min(100, Math.round(avgFill * 0.6 + 40 - warnCount * 3 - (sampleSize ? (dupRecords / sampleSize) * 40 : 0))));
  return {issues, score};
}

function fmtNum(x) {
  return Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 100) / 100);
}

// Compact text for the AI summary (no record values beyond top values).
export function qualityForPrompt(objectName, sampleSize, profiles, dups, result) {
  const lines = [`Object: ${objectName}`, `Records sampled: ${sampleSize}`, `Score: ${result.score}/100`, "", "Fields (fill %, distinct, top value %):"];
  for (const p of profiles) {
    lines.push(`- ${p.name} (${p.type}${p.custom ? ", custom" : ""}${p.required ? ", required" : ""}): ${p.fillPct}% filled, ${p.distinct} distinct` +
      (p.top ? `, top ${p.top.pct}%` : "") + (p.outliers ? `, ${p.outliers} outliers` : "") + (p.invalid ? `, ${p.invalid} invalid picklist` : ""));
  }
  if (dups.length) {
    lines.push("", "Possible duplicates:");
    for (const g of dups.slice(0, 10)) lines.push(`- ${g.ids.length} records share ${g.field}`);
  }
  if (result.issues.length) {
    lines.push("", "Issues found:");
    for (const i of result.issues.slice(0, 25)) lines.push(`- ${i.text}`);
  }
  return lines.join("\n");
}
