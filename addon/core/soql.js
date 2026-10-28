// Pure SOQL helpers. No chrome/window/DOM access so they can be unit-tested
// with `node --test`.

// Escape a value for use inside a single-quoted SOQL string literal.
// Backslash must go first so the escapes added for quotes are not doubled.
export function escapeSoqlString(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Escape a value for use inside a LIKE pattern literal: as above, plus the
// LIKE wildcards % and _ so user input matches literally.
export function escapeSoqlLike(value) {
  return escapeSoqlString(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Replace the contents of string literals with spaces (same length) so
// keyword searches cannot match inside them.
function maskStrings(q) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (inStr) {
      if (c === "\\" && i + 1 < q.length) { out += "  "; i++; continue; }
      if (c === "'") { inStr = false; out += c; continue; }
      out += " ";
    } else {
      if (c === "'") inStr = true;
      out += c;
    }
  }
  return out;
}

// Additionally blank out everything inside parentheses, leaving only the
// top-level clauses (sub-queries, function arguments and IN lists vanish).
function maskNested(masked) {
  let out = "";
  let depth = 0;
  for (const c of masked) {
    if (c === "(") { depth++; out += c; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); out += c; continue; }
    out += depth > 0 ? " " : c;
  }
  return out;
}

const AGGREGATE_RE = /\b(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(/i;

// True when a default LIMIT may be added: the query has no top-level LIMIT,
// and it is not an aggregate query without GROUP BY (Salesforce rejects
// LIMIT on those with MALFORMED_QUERY).
export function soqlNeedsLimit(query) {
  const masked = maskStrings(String(query || ""));
  const top = maskNested(masked);
  if (/\bLIMIT\b/i.test(top)) return false;
  if (!AGGREGATE_RE.test(masked)) return true;
  return /\bGROUP\s+BY\b/i.test(top);
}

// Clauses that must come after LIMIT, in SOQL grammar order.
const AFTER_LIMIT_RE = /\b(OFFSET\b|FOR\s+(VIEW|REFERENCE|UPDATE)\b|UPDATE\s+(TRACKING|VIEWSTAT)\b)/i;

// Add `LIMIT n` when soqlNeedsLimit allows it, placed before any OFFSET /
// FOR VIEW / FOR REFERENCE / UPDATE TRACKING / UPDATE VIEWSTAT / FOR UPDATE
// clause. WITH clauses already precede LIMIT, so appending after them is
// correct.
export function applyDefaultLimit(query, n) {
  const q = String(query || "").trim();
  if (!q || !soqlNeedsLimit(q)) return q;
  const limit = parseInt(n, 10);
  if (!(limit > 0)) return q;
  const top = maskNested(maskStrings(q));
  const from = top.search(/\bFROM\b/i);
  const tail = from === -1 ? top : top.slice(from);
  const m = AFTER_LIMIT_RE.exec(tail);
  if (!m) return `${q} LIMIT ${limit}`;
  const at = (from === -1 ? 0 : from) + m.index;
  return `${q.slice(0, at).trimEnd()} LIMIT ${limit} ${q.slice(at)}`;
}
