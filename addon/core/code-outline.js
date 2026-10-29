// Readable outlines of metadata source for the Metadata tab: what an Apex
// class declares, what a trigger runs on, what an LWC / Aura bundle exposes,
// and which fields a validation formula uses. Regex-light, best effort, and
// pure so it can be unit-tested with `node --test`.

// Blank comments and string literals (same length) so declarations inside
// them are never matched.
export function maskCode(src) {
  const s = String(src || "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "/" && n === "/") {
      const end = s.indexOf("\n", i);
      const stop = end === -1 ? s.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "'" || c === "\"" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      out += c + " ".repeat(Math.max(0, Math.min(j, s.length) - i - 1)) + (j < s.length ? c : "");
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function depthAt(masked, index) {
  let d = 0;
  for (let i = 0; i < index; i++) {
    if (masked[i] === "{") d++;
    else if (masked[i] === "}") d--;
  }
  return d;
}

const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "when", "return", "new", "else", "do", "try", "synchronized"]);
const MODIFIERS = new Set(["public", "private", "protected", "global", "static", "final", "override", "virtual", "abstract", "testmethod", "webservice", "transient"]);

function countAll(re, text) {
  return (String(text).match(re) || []).length;
}

// Apex class outline: declaration, methods, fields and a few risk counters.
export function apexOutline(src) {
  const source = String(src || "");
  const m = maskCode(source);
  const decl = /((?:@\w+(?:\([^)]*\))?\s*)*)\b(global|public|private)?\s*(with sharing|without sharing|inherited sharing)?\s*(virtual|abstract)?\s*class\s+(\w+)(?:\s+extends\s+([\w.<>]+))?(?:\s+implements\s+([^{]+?))?\s*\{/i.exec(m);
  const out = {
    name: decl ? decl[5] : "", access: decl && decl[2] ? decl[2].toLowerCase() : "",
    sharing: decl && decl[3] ? decl[3].toLowerCase() : "", modifier: decl && decl[4] ? decl[4].toLowerCase() : "",
    annotations: decl ? (decl[1].match(/@\w+(?:\([^)]*\))?/g) || []) : [],
    extends: decl && decl[6] ? decl[6] : "",
    implements: decl && decl[7] ? decl[7].split(",").map(x => x.trim()).filter(Boolean) : [],
    methods: [], fields: [], innerClasses: [],
  };
  if (decl) {
    const rawAnn = source.slice(decl.index, decl.index + decl[1].length);
    out.annotations = rawAnn.match(/@\w+(?:\([^)]*\))?/g) || [];
  }
  out.isTest = out.annotations.some(a => /^@istest/i.test(a));
  const classDepth = decl ? depthAt(m, decl.index) : 0;
  // Methods and constructors: "<prefix> name(params) {" at class body level.
  const re = /(\w+)\s*\(([^()]*)\)\s*(?:throws\s+[\w.,\s]+)?\{/g;
  let x;
  while ((x = re.exec(m))) {
    const name = x[1];
    if (NOT_METHODS.has(name.toLowerCase())) continue;
    const d = depthAt(m, x.index);
    if (d !== classDepth + 1) continue;
    const before = m.slice(0, x.index);
    const start = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1;
    const prefixMasked = m.slice(start, x.index).replace(/@\w+(?:\([^)]*\))?/g, " ");
    if (/[=]|\breturn\b|\bnew\b|\bclass\b/.test(prefixMasked)) continue;
    const prefix = source.slice(start, x.index);
    const annotations = prefix.match(/@\w+(?:\([^)]*\))?/g) || [];
    // Words from the comment-free text so a comment above never leaks in.
    const words = prefixMasked.trim().split(/\s+/).filter(Boolean);
    const mods = words.filter(w => MODIFIERS.has(w.toLowerCase())).map(w => w.toLowerCase());
    const type = words.filter(w => !MODIFIERS.has(w.toLowerCase())).join(" ");
    const isCtor = !type && name === out.name;
    if (!type && !isCtor) continue;
    out.methods.push({
      name, returns: isCtor ? "" : type, params: source.slice(x.index + x[0].indexOf("(") + 1, x.index + x[0].indexOf("(") + 1 + x[2].length).replace(/\s+/g, " ").trim(),
      access: mods.find(w => ["public", "private", "protected", "global"].includes(w)) || "private",
      isStatic: mods.includes("static"), constructor: isCtor, annotations,
      line: before.split("\n").length,
    });
  }
  // Fields / properties: "<modifiers> Type name (= …|;|{ get; set; })" at class body level.
  const fre = /(^|[;{}])\s*((?:@\w+(?:\([^)]*\))?\s*)*)((?:(?:public|private|protected|global|static|final|transient)\s+)+)([\w.<>,\s[\]]+?)\s+(\w+)\s*(=|;|\{\s*get)/g;
  while ((x = fre.exec(m))) {
    const at = x.index + x[1].length;
    if (depthAt(m, at) !== classDepth + 1) continue;
    if (/\bclass\b|\benum\b|\binterface\b/.test(x[4])) continue;
    out.fields.push({name: x[5], type: x[4].replace(/\s+/g, " ").trim(), isStatic: /static/.test(x[3]), property: /get/.test(x[6])});
  }
  const inner = /\bclass\s+(\w+)/g;
  while ((x = inner.exec(m))) if (x[1] !== out.name && depthAt(m, x.index) === classDepth + 1) out.innerClasses.push(x[1]);
  out.stats = {
    lines: source.split("\n").length,
    soql: countAll(/\[\s*SELECT\b/gi, m) + countAll(/Database\.query\s*\(/gi, m),
    dml: countAll(/\b(insert|update|delete|upsert|undelete|merge)\s+(?!into\b)[\w(]/gi, m) + countAll(/Database\.(insert|update|delete|upsert|undelete|merge)\s*\(/gi, m),
    callouts: countAll(/\bnew\s+Http(Request)?\s*\(/g, m),
    auraEnabled: out.methods.filter(f => f.annotations.some(a => /@AuraEnabled/i.test(a))).length,
    invocable: out.methods.filter(f => f.annotations.some(a => /@InvocableMethod/i.test(a))).length,
    tests: out.methods.filter(f => f.annotations.some(a => /@IsTest/i.test(a)) || /testmethod/i.test(f.returns)).length,
  };
  return out;
}

// Trigger outline: object, events and the classes it hands work to.
export function triggerOutline(src) {
  const source = String(src || "");
  const m = maskCode(source);
  const head = /trigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/i.exec(m);
  const calls = new Set();
  const re = /\b([A-Z]\w*)\.(\w+)\s*\(/g;
  let x;
  while ((x = re.exec(m))) {
    if (!["Trigger", "System", "Database", "Schema", "String", "Math", "Date", "Datetime", "JSON", "Limits", "UserInfo", "Test"].includes(x[1])) {
      calls.add(`${x[1]}.${x[2]}`);
    }
  }
  return {
    name: head ? head[1] : "", object: head ? head[2] : "",
    events: head ? head[3].split(",").map(e => e.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean) : [],
    calls: [...calls],
    usesContext: [...new Set((m.match(/Trigger\.(new|old|newMap|oldMap|isInsert|isUpdate|isDelete|isBefore|isAfter|operationType)\b/g) || []))],
    stats: {lines: source.split("\n").length, soql: countAll(/\[\s*SELECT\b/gi, m), dml: countAll(/\b(insert|update|delete|upsert)\s+[\w(]/gi, m)},
  };
}

function attrs(tagText) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let x;
  while ((x = re.exec(tagText))) out[x[1]] = x[2];
  return out;
}

function tally(list) {
  const map = new Map();
  for (const v of list) map.set(v, (map.get(v) || 0) + 1);
  return [...map].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Visualforce page outline.
export function pageOutline(src) {
  const s = String(src || "");
  const page = /<apex:page\b([^>]*)>/i.exec(s);
  const a = page ? attrs(page[1]) : {};
  return {
    standardController: a.standardController || "", controller: a.controller || "",
    extensions: (a.extensions || "").split(",").map(x => x.trim()).filter(Boolean),
    renderAs: a.renderAs || "", lightningStylesheets: a.lightningStylesheets === "true",
    components: tally((s.match(/<apex:(\w+)/gi) || []).map(t => t.slice(1).toLowerCase()).filter(t => t !== "apex:page")),
    mergeFields: [...new Set((s.match(/\{!\s*([^}]+?)\s*\}/g) || []).map(t => t.replace(/^\{!\s*|\s*\}$/g, "")))].slice(0, 30),
    lines: s.split("\n").length,
  };
}

// LWC bundle outline from its files ({path, source}) and bundle metadata.
export function lwcOutline(files, meta) {
  const js = (files.find(f => /\.js$/.test(f.path) && !/\.test\.js$/.test(f.path)) || {}).source || "";
  const html = files.filter(f => /\.html$/.test(f.path)).map(f => f.source || "").join("\n");
  const mj = maskCode(js);
  const apis = [];
  const apiRe = /@api\s+(?:(get|set)\s+)?(\w+)/g;
  let x;
  while ((x = apiRe.exec(mj))) if (!apis.includes(x[2])) apis.push(x[2]);
  const apex = [];
  const apexRe = /import\s+(\w+)\s+from\s+['"]@salesforce\/apex\/([\w.]+)['"]/g;
  while ((x = apexRe.exec(js))) apex.push({local: x[1], method: x[2]});
  const wires = (mj.match(/@wire\s*\(\s*(\w+)/g) || []).map(w => w.replace(/@wire\s*\(\s*/, ""));
  const imports = [...new Set((js.match(/from\s+['"](lightning\/[\w/]+|@salesforce\/(?!apex)[\w/.]+)['"]/g) || [])
    .map(t => t.replace(/^from\s+['"]|['"]$/g, "")))];
  const events = [...new Set((js.match(/new\s+CustomEvent\s*\(\s*['"]([\w-]+)['"]/g) || []).map(t => t.replace(/.*\(\s*['"]|['"]$/g, "")))];
  const children = tally((html.match(/<(c|lightning)-[\w-]+/g) || []).map(t => t.slice(1)));
  const m = meta || {};
  const targets = m.targets && m.targets.target ? [].concat(m.targets.target) : [];
  return {
    label: m.masterLabel || "", exposed: !!m.isExposed, apiVersion: m.apiVersion || "", description: m.description || "",
    targets, apis, apex, wires, imports, events, children,
    navigation: /NavigationMixin/.test(js), toast: /ShowToastEvent/.test(js),
  };
}

// Aura bundle outline from its definitions ({defType, source}).
export function auraOutline(defs) {
  const cmp = (defs.find(d => d.defType === "COMPONENT" || d.defType === "APPLICATION") || {}).source || "";
  const ctrl = (defs.find(d => d.defType === "CONTROLLER") || {}).source || "";
  const root = /<aura:(component|application)\b([^>]*)>/i.exec(cmp);
  const a = root ? attrs(root[2]) : {};
  const list = (re, map) => { const out = []; let x; while ((x = re.exec(cmp))) out.push(map(attrs(x[1]))); return out; };
  return {
    kind: root ? root[1] : "component",
    implements: (a.implements || "").split(",").map(x => x.trim()).filter(Boolean),
    controller: a.controller || "", extends: a.extends || "", access: a.access || "",
    attributes: list(/<aura:attribute\b([^>]*)\/?>/gi, t => ({name: t.name, type: t.type, default: t.default})),
    handlers: list(/<aura:handler\b([^>]*)\/?>/gi, t => ({name: t.name || t.event, action: t.action})),
    events: list(/<aura:registerEvent\b([^>]*)\/?>/gi, t => ({name: t.name, type: t.type})),
    children: tally((cmp.match(/<(?!aura:)(\w+):(\w+)/g) || []).map(t => t.slice(1))),
    actions: [...new Set((maskCode(ctrl).match(/(\w+)\s*:\s*function/g) || []).map(t => t.replace(/\s*:\s*function/, "")))],
    defs: defs.map(d => d.defType),
  };
}

// ─── Formulas (validation rules) ─────────────────────────────────────────
const FORMULA_WORDS = new Set(["TRUE", "FALSE", "NULL", "AND", "OR", "NOT"]);

// Tokens: {t: "fn"|"field"|"str"|"num"|"op"|"kw"|"txt", v}
export function formulaTokens(formula) {
  const s = String(formula || "");
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\*[\s\S]*?\*\/)|(\b\d+(?:\.\d+)?\b)|(\$?[A-Za-z_][\w.$]*)|(&&|\|\||<>|!=|<=|>=|==|[-+*/^&=<>!(),])|(\s+)|(.)/g;
  const out = [];
  let x;
  while ((x = re.exec(s))) {
    if (x[1]) out.push({t: "str", v: x[1]});
    else if (x[2]) out.push({t: "cmt", v: x[2]});
    else if (x[3]) out.push({t: "num", v: x[3]});
    else if (x[4]) {
      const rest = s.slice(re.lastIndex);
      if (/^\s*\(/.test(rest)) out.push({t: "fn", v: x[4]});
      else if (FORMULA_WORDS.has(x[4].toUpperCase())) out.push({t: "kw", v: x[4]});
      else out.push({t: "field", v: x[4]});
    } else if (x[5]) out.push({t: "op", v: x[5]});
    else out.push({t: "txt", v: x[6] || x[7]});
  }
  return out;
}

// Field references used by a formula (first occurrence order).
export function formulaFields(formula) {
  const seen = [];
  for (const tok of formulaTokens(formula)) {
    if (tok.t === "field" && !tok.v.startsWith("$") && !seen.includes(tok.v)) seen.push(tok.v);
  }
  return seen;
}

// Functions used by a formula (upper-cased, first occurrence order).
export function formulaFunctions(formula) {
  const seen = [];
  for (const tok of formulaTokens(formula)) {
    const v = tok.v.toUpperCase();
    if (tok.t === "fn" && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

const TOK_CLASS = {fn: "tok-fn", field: "tok-col", str: "tok-s", num: "tok-n", op: "tok-op", kw: "tok-k", cmt: "tok-c"};

export function formulaHighlight(formula) {
  const esc = v => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return formulaTokens(formula).map(tok => (TOK_CLASS[tok.t] ? `<span class="${TOK_CLASS[tok.t]}">${esc(tok.v)}</span>` : esc(tok.v))).join("");
}
