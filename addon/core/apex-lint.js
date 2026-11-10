// Known Apex / LWC / Aura mistakes (mostly ones AI models make) caught
// before anything is sent to Salesforce. Each rule names the fix, so the AI
// can correct itself and a person can read why. Pure.
//
// lintFiles(files, {apiVersion}) → [{path, line, message}]

function strip(code) {
  // Keep line breaks so line numbers stay right.
  return String(code || "")
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

// Index of the ")" matching the "(" at open (or -1).
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

// Top-level arguments of the call whose "(" is at open.
function argCount(src, open) {
  const end = closeParen(src, open);
  const inner = src.slice(open + 1, end < 0 ? src.length : end);
  if (!inner.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of inner) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return n;
}

// Methods that do not exist in Apex but models often invent.
const FAKE_APIS = [
  [/\bTest\.getSentEmailMessages\s*\(/, "Test.getSentEmailMessages() does not exist. In a test, check Limits.getEmailInvocations() between Test.startTest() and Test.stopTest() instead."],
  [/\bMessaging\.getSentEmails\s*\(/, "Messaging.getSentEmails() does not exist. Use Limits.getEmailInvocations() in tests."],
  [/\bTest\.getEmailInvocations\s*\(/, "Test.getEmailInvocations() does not exist; use Limits.getEmailInvocations()."],
  [/\bString\.isNullOrEmpty\s*\(/, "String.isNullOrEmpty() does not exist in Apex; use String.isBlank() or String.isEmpty()."],
  [/\bJSON\.parse\s*\(/, "JSON.parse() does not exist in Apex; use JSON.deserialize() or JSON.deserializeUntyped()."],
  [/\.stream\s*\(\s*\)/, "Apex lists have no .stream(); loop over them instead."],
  [/\bList\.of\s*\(|\bMap\.of\s*\(|\bSet\.of\s*\(/, "Apex has no List.of / Map.of / Set.of; use new List<T>{…}."]
];

// SOQL inside [ … ]: WITH must come after WHERE and before GROUP BY / ORDER BY / LIMIT.
function soqlIssues(src) {
  const out = [];
  const re = /\[\s*SELECT\b[\s\S]*?\]/gi;
  let m;
  while ((m = re.exec(src))) {
    const q = m[0];
    const withAt = q.search(/\bWITH\s+(USER_MODE|SYSTEM_MODE|SECURITY_ENFORCED)\b/i);
    if (withAt < 0) continue;
    // Ignore ORDER BY / LIMIT inside sub-queries: (SELECT … FROM Contacts LIMIT 5)
    let before = q.slice(0, withAt);
    for (let prev = ""; prev !== before;) { prev = before; before = before.replace(/\([^()]*\)/g, x => " ".repeat(x.length)); }
    if (/\b(GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|FOR\s+(UPDATE|VIEW|REFERENCE))\b/i.test(before)) {
      out.push({index: m.index + withAt, message: "In SOQL, WITH USER_MODE goes right after WHERE (before GROUP BY, ORDER BY and LIMIT): SELECT … FROM … WHERE … WITH USER_MODE ORDER BY … LIMIT …"});
    }
  }
  return out;
}

export function lintApex(code, {apiVersion} = {}) {
  const src = strip(code);
  const out = [];
  for (const [re, message] of FAKE_APIS) {
    const m = re.exec(src);
    if (m) out.push({line: lineOf(src, m.index), message});
  }
  for (const s of soqlIssues(src)) out.push({line: lineOf(src, s.index), message: s.message});
  let m;
  // System.assertEquals(…) returns nothing; a call chained on it fails.
  const assertRe = /\bSystem\.assert(Equals|NotEquals)?\s*\(/g;
  while ((m = assertRe.exec(src))) {
    const end = closeParen(src, m.index + m[0].length - 1);
    if (end > 0 && /^\s*\.\s*\w/.test(src.slice(end + 1, end + 12))) {
      out.push({line: lineOf(src, m.index), message: "System.assertEquals returns nothing; don't chain a call on it."});
      break;
    }
  }
  const qwb = /\bDatabase\.queryWithBinds\s*\(/g;
  while ((m = qwb.exec(src))) {
    if (argCount(src, m.index + m[0].length - 1) < 3) {
      out.push({line: lineOf(src, m.index), message: "Database.queryWithBinds needs (query, bindMap, AccessLevel)."});
      break;
    }
  }
  const sec = /\bWITH\s+SECURITY_ENFORCED\b/i.exec(src);
  if (sec) out.push({line: lineOf(src, sec.index), message: "WITH SECURITY_ENFORCED is rejected by current API versions; use WITH USER_MODE."});
  if (apiVersion && Number(apiVersion) < 56) {
    const um = /\bWITH\s+USER_MODE\b|AccessLevel\.USER_MODE/i.exec(src);
    if (um) out.push({line: lineOf(src, um.index), message: `WITH USER_MODE needs API version 56.0 or later; this file uses ${apiVersion}.`});
  }
  // stripInaccessible returns SObjectAccessDecision, not a list: flag it
  // only where a list is expected (List<…> x = …, x[] = …, a for loop).
  const strip1 = /Security\.stripInaccessible\s*\(/g;
  while ((m = strip1.exec(src))) {
    const end = closeParen(src, m.index + m[0].length - 1);
    const after = end >= 0 ? src.slice(end + 1, end + 20) : "";
    const lead = src.slice(Math.max(0, m.index - 120), m.index);
    const wantsList = /(List\s*<[^;{}]*>\s*\w+\s*=|\w+\[\]\s*\w+\s*=|:)\s*$/.test(lead);
    if (wantsList && !/^\s*\.(getRecords|getRemovedFields|getModifiedIndexes)\s*\(/.test(after)) {
      out.push({line: lineOf(src, m.index), message: "Security.stripInaccessible(...) returns an SObjectAccessDecision; call .getRecords() on it to get the list (e.g. Security.stripInaccessible(AccessType.READABLE, rows).getRecords())."});
    }
  }
  // Cacheable methods can't do DML.
  const cacheRe = /@AuraEnabled\s*\(\s*cacheable\s*=\s*true\s*\)[^{]*\{/gi;
  while ((m = cacheRe.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(m.index + m[0].length, i);
    if (/(^|[;{\s])(insert|update|upsert|delete|undelete)\s+[\w(]/i.test(body) || /\bDatabase\.(insert|update|upsert|delete)\s*\(/.test(body)) {
      out.push({line: lineOf(src, m.index), message: "An @AuraEnabled(cacheable=true) method cannot do DML; remove cacheable=true or move the DML to another method."});
    }
  }
  // Test methods need at least one assert (mocks and data factories are
  // @isTest classes without test methods: fine).
  const hasTestMethods = /@isTest(?:\s*\([^)]*\))?\s+(?:(?:public|private|global|static)\s+)*void\b/i.test(src) || /\btestMethod\b/i.test(src);
  if (hasTestMethods && !/\b(System\.)?assert\w*\s*\(|\bAssert\.\w+\s*\(/i.test(src)) {
    out.push({line: 1, message: "This test class has no assert; add System.assertEquals / Assert.areEqual checks."});
  }
  return out;
}

export function lintLwcJs(code) {
  // Imports are strings: keep them, drop only comments.
  const src = String(code || "").replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  const out = [];
  const rules = [
    [/from\s+['"]lightning\/platformShowToastEvent['"]/, null],
    [/\bthis\.template\.querySelector\s*\([^)]*\)\s*\.innerHTML\s*=/, "LWC does not allow setting innerHTML."],
    [/@track\s+@api|@api\s+@track/, "A property can't be both @api and @track."],
    [/import\s+\{[^}]*\bwire\b[^}]*\}\s+from\s+['"]lightning\/uiRecordApi['"]/, "Import wire from 'lwc', not from 'lightning/uiRecordApi'."]
  ];
  for (const [re, message] of rules) {
    if (!message) continue;
    const m = re.exec(src);
    if (m) out.push({line: lineOf(src, m.index), message});
  }
  if (/ShowToastEvent/.test(src) && !/import\s+\{[^}]*ShowToastEvent[^}]*\}\s+from\s+['"]lightning\/platformShowToastEvent['"]/.test(src)) {
    out.push({line: 1, message: "ShowToastEvent is used but not imported: import { ShowToastEvent } from 'lightning/platformShowToastEvent';"});
  }
  return out;
}

// files: draft files [{path, content, readOnly?, generated?}]
export function lintFiles(files, {apiVersion} = {}) {
  const out = [];
  for (const f of files || []) {
    if (f.generated || f.readOnly) continue;
    const isApex = /\.(cls|trigger)$/.test(f.path);
    const isLwcJs = /^lwc\/.+\.js$/.test(f.path);
    const issues = isApex ? lintApex(f.content, {apiVersion}) : isLwcJs ? lintLwcJs(f.content) : [];
    for (const i of issues) out.push({path: f.path, ...i});
  }
  return out;
}

export function lintText(problems) {
  return problems.map(p => `${p.path.split("/").pop()} line ${p.line}: ${p.message}`).join("\n");
}
