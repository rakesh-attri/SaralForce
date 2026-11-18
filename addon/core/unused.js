// "Unused" custom fields and objects: nothing refers to them (Salesforce's
// dependency data and a text search of Apex / Visualforce) and they hold no
// data. Pure; the org reads are in inspector/tabs/release-impact.js.
//
// row: {kind: "field"|"object", name, refs, code, filled, total, created, modified}
//   refs   components that use it (MetadataComponentDependency), null = unknown
//   code   Apex classes / triggers / VF pages whose code names it, null = unknown
//   filled records with a value (fields) or records (objects), null = unknown
//   total  records in the object (fields), for "n of total"

export const UNUSED_LEVELS = {
  unused: {label: "Unused", kind: "ok"},
  review: {label: "Nothing uses it, has data", kind: "warn"},
  unknown: {label: "Couldn't fully check", kind: "info"},
  used: {label: "Used", kind: "off"}
};

export function unusedVerdict(r) {
  const reasons = [];
  if (r.refs > 0) reasons.push(`${r.refs} component(s) use it`);
  if (r.code > 0) reasons.push(`named in the code of ${r.code} class(es), trigger(s) or page(s)`);
  if (reasons.length) return {level: "used", reasons};
  const data = r.filled;
  if (r.refs == null || r.code == null) {
    reasons.push(r.refs == null ? "the dependency data couldn't be read" : "the code couldn't be searched");
    return {level: "unknown", reasons};
  }
  if (data == null) return {level: "unknown", reasons: ["nothing uses it, but its data couldn't be counted"]};
  if (data > 0) {
    return {level: "review", reasons: [r.kind === "object"
      ? `nothing uses it, but it has ${data.toLocaleString()} record(s)`
      : `nothing uses it, but ${data.toLocaleString()} record(s) have a value${r.total ? ` (${pct(data, r.total)})` : ""}`]};
  }
  return {level: "unused", reasons: [r.kind === "object" ? "nothing uses it and it has no records" : "nothing uses it and no record has a value"]};
}

function pct(n, total) {
  const p = (n / total) * 100;
  return (p < 1 && p > 0 ? "<1" : Math.round(p)) + "%";
}

// Rows with verdicts, most removable first, then by name.
export function rankUnused(rows) {
  const order = {unused: 0, review: 1, unknown: 2, used: 3};
  return rows.map(r => ({...r, verdict: unusedVerdict(r)}))
    .sort((a, b) => order[a.verdict.level] - order[b.verdict.level] || a.name.localeCompare(b.name));
}

export function unusedCounts(rows) {
  const c = {unused: 0, review: 0, unknown: 0, used: 0};
  for (const r of rows) c[r.verdict.level]++;
  return c;
}

// Short id form for matching (18-char Tooling ids vs 15-char references).
export const id15 = id => String(id || "").slice(0, 15);
