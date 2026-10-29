// Context-aware SOQL autocomplete. Works out what is being typed at the
// caret (object after FROM, field or relationship path such as
// `Owner.Profile.Na`, child relationship in a sub-query, or a clause
// keyword) and resolves suggestions through an injected describe function.
// No chrome/window/DOM access so it can be unit-tested with `node --test`.

// Blank string literal contents (same length) so keywords and parentheses
// inside quotes are ignored. Returns {text, open} where open means the
// input ends inside an unterminated literal.
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
  return {text: out, open: inStr};
}

// Blank everything inside parentheses so only this scope's own clauses stay.
function maskNested(text) {
  let out = "";
  let depth = 0;
  for (const c of text) {
    if (c === "(") { depth++; out += c; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); out += c; continue; }
    out += depth > 0 ? " " : c;
  }
  return out;
}

// Index just after the innermost '(' that is still open at `pos`, or -1.
function openParenBefore(text, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// Index of the ')' closing the scope that starts at `from`, or text.length.
function closeParenAfter(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return text.length;
}

const CLAUSES = [
  ["select", /\bSELECT\b/gi],
  ["from", /\bFROM\b/gi],
  ["where", /\bWHERE\b/gi],
  ["with", /\bWITH\b/gi],
  ["groupby", /\bGROUP\s+BY\b/gi],
  ["having", /\bHAVING\b/gi],
  ["orderby", /\bORDER\s+BY\b/gi],
  ["limit", /\bLIMIT\b/gi],
  ["offset", /\bOFFSET\b/gi],
];

// Last clause keyword that starts before `pos` in a nested-masked scope.
function clauseAt(scopeText, pos) {
  let best = null;
  let bestAt = -1;
  for (const [name, re] of CLAUSES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scopeText)) && m.index < pos) {
      if (m.index + m[0].length <= pos && m.index > bestAt) {
        best = name;
        bestAt = m.index;
      }
    }
  }
  return best;
}

function scopeFrom(scopeText) {
  const m = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(scopeText);
  return m ? m[1] : null;
}

// Describes the scope (a SELECT statement) containing `pos`. Function
// parentheses such as COUNT( or IN ( are walked through to the enclosing
// SELECT. Returns {start, end, nested, parent} or the top-level scope.
function scopeAt(masked, pos) {
  let p = pos;
  for (;;) {
    const open = openParenBefore(masked, p);
    if (open === -1) return {start: 0, end: masked.length, parentPos: -1};
    const start = open + 1;
    if (/^\s*SELECT\b/i.test(masked.slice(start))) {
      return {start, end: closeParenAfter(masked, start), parentPos: open};
    }
    p = open;
  }
}

function scopeInfo(masked, pos) {
  const s = scopeAt(masked, pos);
  const text = maskNested(masked.slice(s.start, s.end));
  const info = {text, start: s.start, rel: pos - s.start, from: null, parent: null, childSubquery: false};
  if (s.parentPos !== -1) {
    const parent = scopeInfo(masked, s.parentPos);
    info.parent = parent;
    // (SELECT … FROM Contacts) in the parent's SELECT list is a child
    // relationship; in WHERE it is a semi-join on a regular object.
    info.childSubquery = clauseAt(parent.text, parent.rel) === "select";
  }
  return info;
}

const KEYWORDS_AFTER = {
  from: ["WHERE", "WITH SECURITY_ENFORCED", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "FOR VIEW", "FOR REFERENCE", "ALL ROWS"],
  where: ["AND", "OR", "NOT", "IN", "NOT IN", "LIKE", "INCLUDES", "EXCLUDES", "NULL", "TRUE", "FALSE",
    "TODAY", "YESTERDAY", "LAST_N_DAYS:", "THIS_WEEK", "THIS_MONTH", "THIS_YEAR", "LAST_MONTH", "LAST_YEAR",
    "ORDER BY", "GROUP BY", "LIMIT"],
  orderby: ["ASC", "DESC", "NULLS FIRST", "NULLS LAST", "LIMIT", "OFFSET"],
  groupby: ["HAVING", "ORDER BY", "LIMIT", "ROLLUP(", "CUBE("],
  having: ["AND", "OR", "ORDER BY", "LIMIT"],
};

const SELECT_EXTRAS = ["FIELDS(ALL)", "FIELDS(STANDARD)", "FIELDS(CUSTOM)", "COUNT()", "COUNT_DISTINCT(", "MAX(", "MIN(", "SUM(", "AVG(", "TYPEOF"];

// What is being typed at `caret`, or null when nothing should be offered
// (inside a string literal, after LIMIT/OFFSET, …).
//   kind:   "object" | "child" | "field" | "keyword"
//   prefix: partial word being typed (after the last dot)
//   start:  index where `prefix` begins (the text replaced on accept)
//   end:    index where the word under the caret ends
//   path:   relationship names before the prefix, e.g. ["Owner", "Profile"]
//   object: FROM object of this scope (field kind)
//   parentObject: FROM object of the enclosing query (child kind, or field
//                 kind inside a child sub-query where object is the relationship)
export function soqlCompletionContext(query, caret) {
  const q = String(query || "");
  const pos = Math.max(0, Math.min(caret == null ? q.length : caret, q.length));
  const {text: masked, open} = maskStrings(q.slice(0, pos));
  if (open) return null;
  const full = masked + maskStrings(q.slice(pos)).text;
  const token = /[A-Za-z0-9_.]*$/.exec(masked)[0];
  const parts = token.split(".");
  const prefix = parts.pop();
  const path = parts;
  if (path.some(p => !p)) return null;
  const start = pos - prefix.length;
  const end = pos + /^[A-Za-z0-9_]*/.exec(q.slice(pos))[0].length;
  const scope = scopeInfo(full, pos);
  const tokenStartRel = scope.rel - token.length;
  const clause = clauseAt(scope.text, tokenStartRel);
  if (!clause) {
    return path.length ? null : {kind: "keyword", prefix, start, end, path, keywords: ["SELECT"]};
  }
  // An unclosed "COUNT(" while typing hides the top-level FROM from the
  // nested mask; fall back to the first FROM after the caret.
  const fromObj = scopeFrom(scope.text) ||
    (!scope.parent ? scopeFrom(full.slice(pos)) : null);
  const parentObject = scope.parent ? scopeFrom(scope.parent.text) : null;
  const beforeToken = scope.text.slice(0, tokenStartRel);
  if (clause === "from") {
    if (path.length) return null;
    if (/\bFROM\s*$/i.test(beforeToken)) {
      if (scope.childSubquery) return {kind: "child", prefix, start, end, path, parentObject};
      return {kind: "object", prefix, start, end, path};
    }
    return {kind: "keyword", prefix, start, end, path, keywords: KEYWORDS_AFTER.from};
  }
  if (clause === "limit" || clause === "offset" || clause === "with") return null;
  if (!fromObj) {
    // SELECT list typed before FROM exists: nothing to describe yet.
    return clause === "select" && !path.length
      ? {kind: "keyword", prefix, start, end, path, keywords: SELECT_EXTRAS.concat("FROM")}
      : null;
  }
  return {
    kind: "field", prefix, start, end, path, clause,
    object: fromObj,
    parentObject: scope.childSubquery ? parentObject : null,
    keywords: path.length ? [] : clause === "select"
      ? SELECT_EXTRAS.concat(/,\s*$|SELECT\s*$/i.test(beforeToken) ? [] : ["FROM"])
      : (KEYWORDS_AFTER[clause] || []),
  };
}

// Filter and order suggestions for a typed prefix. Items:
// {value, label?, detail?, kind}. Name prefix > label prefix > contains.
export function rankCompletions(items, prefix, max = 50) {
  const p = String(prefix || "").toLowerCase();
  const scored = [];
  for (const it of items) {
    const v = String(it.value).toLowerCase();
    const l = String(it.label || "").toLowerCase();
    let s;
    if (!p) s = 3;
    else if (v === p) s = 0;
    else if (v.startsWith(p)) s = 1;
    else if (l.startsWith(p)) s = 2;
    else if (v.includes(p) || l.includes(p)) s = 4;
    else continue;
    scored.push({it, s});
  }
  scored.sort((a, b) => a.s - b.s || String(a.it.value).localeCompare(String(b.it.value)));
  return scored.slice(0, max).map(x => x.it);
}

// Target object of a lookup field. Polymorphic lookups (Owner → User/Group)
// prefer User, which is what people mean nearly every time.
function referenceTarget(field) {
  const refs = field.referenceTo || [];
  if (refs.length > 1 && refs.includes("User")) return "User";
  return refs[0] || null;
}

// Follow `path` (relationship names) from `object`; resolves to the object
// at the end of the path or null when a step is unknown.
export async function resolveRelationshipPath(object, path, describe) {
  let obj = object;
  for (const step of path) {
    const d = await describe(obj);
    const f = (d.fields || []).find(x => x.relationshipName &&
      x.relationshipName.toLowerCase() === step.toLowerCase());
    obj = f ? referenceTarget(f) : null;
    if (!obj) return null;
  }
  return obj;
}

// Child sub-query FROM: the child object behind a relationship name.
async function childObjectFor(parentObject, relationshipName, describe) {
  const d = await describe(parentObject);
  const r = (d.childRelationships || []).find(x => x.relationshipName &&
    x.relationshipName.toLowerCase() === relationshipName.toLowerCase());
  return r ? r.childSObject : null;
}

function fieldItems(describeResult, withRelationships) {
  const out = [];
  for (const f of describeResult.fields || []) {
    out.push({value: f.name, label: f.label, detail: f.type, kind: "field"});
    if (withRelationships && f.type === "reference" && f.relationshipName) {
      const target = referenceTarget(f);
      out.push({value: f.relationshipName + ".", label: f.label,
        detail: target ? `→ ${target}` : "relationship", kind: "relationship"});
    }
  }
  return out;
}

// Suggestions for a context from soqlCompletionContext. deps:
//   describe(objectName) → describe result (throws when unknown)
//   listObjects() → [{name, label}]
export async function soqlCompletions(ctx, {describe, listObjects}) {
  if (!ctx) return [];
  const kw = (ctx.keywords || []).map(k => ({value: k, detail: "keyword", kind: "keyword"}));
  if (ctx.kind === "keyword") return rankCompletions(kw, ctx.prefix);
  if (ctx.kind === "object") {
    const objs = await listObjects();
    return rankCompletions(objs.map(o => ({value: o.name, label: o.label, detail: "object", kind: "object"})), ctx.prefix);
  }
  if (ctx.kind === "child") {
    if (!ctx.parentObject) return [];
    const d = await describe(ctx.parentObject);
    const items = (d.childRelationships || [])
      .filter(r => r.relationshipName)
      .map(r => ({value: r.relationshipName, label: r.childSObject, detail: `child · ${r.childSObject}`, kind: "child"}));
    return rankCompletions(items, ctx.prefix);
  }
  let base = ctx.object;
  if (ctx.parentObject) base = await childObjectFor(ctx.parentObject, ctx.object, describe) || ctx.object;
  const target = await resolveRelationshipPath(base, ctx.path, describe);
  if (!target) return [];
  const d = await describe(target);
  // Lookups can be followed up to five levels in SOQL.
  const items = fieldItems(d, ctx.path.length < 5);
  return rankCompletions(ctx.prefix ? items.concat(kw) : items, ctx.prefix);
}

// Replace the word at the caret with the accepted suggestion. Returns the
// new text and caret. A relationship ("Owner.") keeps the caret right after
// the dot so the next level can be offered; objects get a trailing space.
export function applyCompletion(query, ctx, item) {
  const q = String(query || "");
  let insert = String(item.value);
  const after = q.slice(ctx.end);
  if (item.kind === "object" || item.kind === "child" || (item.kind === "keyword" && !/[(:]$/.test(insert))) {
    if (!/^\s/.test(after)) insert += " ";
  }
  const text = q.slice(0, ctx.start) + insert + after;
  return {text, caret: ctx.start + insert.length};
}

// Pick the objects a plain-English request most likely refers to, so the
// AI prompt can carry their fields. Scores label/name words against the
// request with naive singular/plural folding.
export function pickObjectsForPrompt(prompt, objects, max = 2) {
  const fold = w => w.toLowerCase().replace(/ies$/, "y").replace(/(ss)$/, "$1").replace(/([^s])s$/, "$1");
  const words = new Set((String(prompt || "").match(/[A-Za-z0-9_]+/g) || []).map(fold));
  const scored = [];
  for (const o of objects || []) {
    const name = String(o.name || "");
    const nameWords = name.replace(/__c$|__mdt$|__e$/i, "").split(/_+/).filter(Boolean).map(fold);
    const labelWords = (String(o.label || "").match(/[A-Za-z0-9]+/g) || []).map(fold);
    let score = 0;
    if (words.has(fold(name))) score += 6;
    const all = [...new Set([...nameWords, ...labelWords])];
    const hits = all.filter(w => words.has(w)).length;
    if (all.length && hits === all.length) score += 4 + all.length;
    else score += hits;
    if (score > 0) scored.push({o, score});
  }
  scored.sort((a, b) => b.score - a.score || String(a.o.name).length - String(b.o.name).length);
  return scored.slice(0, max).map(x => x.o.name);
}
