import {sfConn, apiVersion} from "./inspector.js";
import {getSavedConfig, getLLMProvider, getProviderConfig, hasValidConfig, getCelebrateVariant} from "./llm/llm-service.js";
import {safeCopyText} from "./utils.js";

const h = React.createElement;

function csvEscape(v) {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns, rows) {
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.map(c => csvEscape(row[c])).join(","));
  }
  return lines.join("\r\n");
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return {headers: [], records: []};
  const headers = rows[0].map(x => String(x || "").trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => String(c || "").trim() === "")) continue;
    const obj = {};
    headers.forEach((hName, idx) => { obj[hName] = r[idx] ?? ""; });
    records.push(obj);
  }
  return {headers, records};
}

async function runSoql(query, limit) {
  let q = String(query || "").trim();
  if (!q) throw new Error("Enter a SOQL query");
  if (!/^select\b/i.test(q)) throw new Error("Only SELECT SOQL is supported");
  // Soft-cap rows unless the user already limited.
  if (limit && !/\blimit\s+\d+/i.test(q)) {
    q = `${q} LIMIT ${parseInt(limit, 10) || 2000}`;
  }
  const url = `/services/data/v${apiVersion}/query/?q=` + encodeURIComponent(q);
  let loc = url;
  let all = [];
  let pages = 0;
  const maxPages = 20;
  while (loc && pages < maxPages) {
    const res = await sfConn.rest(loc, {useCache: false});
    if (Array.isArray(res.records)) all = all.concat(res.records);
    pages++;
    if (res.done === false && res.nextRecordsUrl) {
      loc = res.nextRecordsUrl;
    } else {
      loc = null;
    }
    if (all.length > 20000) break;
  }
  return {records: all, totalSize: all.length, query: q};
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

// ─── Shared: open-in-Salesforce ────────────────────────────────────────────
// 15/18-char Salesforce Id validation (same rule as object-creator.js).
function ffIsSfId(value) {
  const v = String(value || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(v) || /^[a-zA-Z0-9]{18}$/.test(v);
}

function ffRecordUrl(id) {
  return "https://" + sfConn.instanceHostname + "/" + id;
}

function openRecordInSf(id, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!ffIsSfId(id) || !sfConn.instanceHostname) return;
  window.open(ffRecordUrl(id), "_blank");
}

// ─── Presentational helpers (visual only) ────────────────
function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}

function fmtStorage(mb) {
  if (typeof mb !== "number") return String(mb);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return (gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)) + " GB";
  }
  return Math.round(mb) + " MB";
}

// Relative label for list rows ("just now", "5m ago", "3h ago", "2d ago"),
// falling back to the absolute date past 30 days. Computed per render — the
// lists are static snapshots, no timer re-renders them.
function ffAgo(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value ? String(value) : "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return fmtDateTime(value);
}

function FFBadge({kind, children}) {
  return h("span", {className: "ff-badge ff-badge-" + (kind || "info")}, children);
}

function ffTruthy(v) {
  return v === true || v === "true";
}

function ResultTable({columns, rows, maxRows, onRowClick, rowHint, cellFmt}) {
  const shown = rows.slice(0, maxRows || 200);
  if (!columns.length) return h("div", {className: "insp-empty"}, "No rows");
  // ↗ gets its own column, right after Name (or at the row end when the
  // query has no Name). Id-less grids render exactly as before.
  const idField = columns.includes("Id") ? "Id" : null;
  const showOpen = !!idField && shown.some(r => r && ffIsSfId(r[idField]));
  const openIdx = columns.includes("Name")
    ? columns.indexOf("Name") + 1
    : columns.length;
  const cells = showOpen
    ? columns.slice(0, openIdx).concat("__open", columns.slice(openIdx))
    : columns.slice();
  return h("div", {className: "insp-table-wrap"},
    h("table", {className: "insp-table"},
      h("thead", null,
        h("tr", null, cells.map(c =>
          c === "__open"
            ? h("th", {key: c, className: "insp-open-col"})
            : h("th", {key: c}, c)))
      ),
      h("tbody", null,
        shown.map((row, i) =>
          h("tr", {
            key: i,
            className: onRowClick ? "insp-row-click" : "",
            title: onRowClick ? (rowHint || "Click to show all data") : undefined,
            onClick: onRowClick ? () => onRowClick(row, i) : undefined
          },
            cells.map(c => {
              if (c === "__open") {
                return h("td", {key: c, className: "insp-open-col"},
                  ffIsSfId(row[idField]) && h("a", {
                    href: ffRecordUrl(row[idField]),
                    target: "_blank",
                    rel: "noreferrer",
                    className: "insp-open-link",
                    title: "Open in Salesforce",
                    onClick: (e) => e.stopPropagation()
                  }, "↗"));
              }
              const raw = row[c] == null ? "" : String(row[c]);
              const isId = String(c).toLowerCase() === "id";
              const title = row[c] == null ? ""
                : (isId && onRowClick
                  ? `${raw} — ${rowHint || "click: open all record data in a popup"}`
                  : raw);
              return h("td", {key: c, title},
                row[c] == null ? ""
                  : (cellFmt && cellFmt[c] ? cellFmt[c](row[c], row) : String(row[c]))
              );
            })
          )
        )
      )
    ),
    rows.length > shown.length &&
      h("div", {className: "insp-more"}, `Showing ${shown.length} of ${rows.length} rows`)
  );
}

// ─── Shared: LLM SOQL fixer ───────────────────────────────
function parseJsonFromText(text) {
  const cleaned = String(text || "").trim()
    .replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// Ask the Options-configured LLM to fix a failing SOQL query.
// Returns {explanation, fixedQuery} — never runs anything itself.
async function suggestSoqlFix(failedQuery, sfError) {
  const config = getSavedConfig();
  if (!config || !hasValidConfig()) {
    throw new Error("NO_LLM_CONFIG");
  }
  const fromMatch = /\bfrom\s+([a-zA-Z0-9_]+)/i.exec(String(failedQuery || ""));
  let schemaHint = "";
  if (fromMatch) {
    try {
      const d = await ffDescribeObject(fromMatch[1]);
      const names = (d.fields || []).slice(0, 80)
        .map(f => `${f.name} (${f.type})`).join(", ");
      schemaHint = `\nObject "${fromMatch[1]}" fields: ${names}`;
    } catch (e) {
      schemaHint = `\n(Object "${fromMatch[1]}" describe failed: ${e.message})`;
    }
  }
  const provider = getLLMProvider(config.provider);
  const messages = [
    {role: "system", content:
      "You are a Salesforce SOQL expert helping a beginner. " +
      "Rules: SELECT-only queries. Never use SELECT *. Always keep or add a LIMIT. " +
      "Relationship queries use __r with the relationship name, filters use __c field API names. " +
      "Reply with ONLY a JSON object: " +
      '{"explanation": "<plain simple words, 1-2 sentences, no jargon>", "fixedQuery": "<corrected SOQL, single line>"}'},
    {role: "user", content:
      `Failed SOQL: ${failedQuery}\nSalesforce error: ${sfError}${schemaHint}`}
  ];
  const raw = config.baseUrl
    ? await provider.sendMessage(messages, config.apiKey, config.model, null, config.baseUrl)
    : await provider.sendMessage(messages, config.apiKey, config.model, null);
  const parsed = parseJsonFromText(raw);
  if (!parsed || !parsed.fixedQuery) {
    throw new Error("LLM did not return a usable fix. Raw reply: " + String(raw).slice(0, 300));
  }
  return {
    explanation: String(parsed.explanation || "Here is a corrected query."),
    fixedQuery: String(parsed.fixedQuery).trim()
  };
}

// Ask the Options-configured LLM to review Apex for compile errors BEFORE a run
// (or after Salesforce rejects it). Never executes anything itself.
// Returns {ok, error, line, explanation, fixedCode}.
async function apexAiCheck(sourceCode, serverError) {
  const config = getSavedConfig();
  if (!config || !hasValidConfig()) {
    throw new Error("NO_LLM_CONFIG");
  }
  const provider = getLLMProvider(config.provider);
  const messages = [
    {role: "system", content:
      "You are a Salesforce Apex expert helping a beginner. " +
      "Find compile errors: missing semicolons, unbalanced braces, unknown methods or variables, " +
      "wrong types, bad SOQL syntax. " +
      "Reply with ONLY a JSON object: " +
      '{"ok": true, "error": "", "line": null, "explanation": "", "fixedCode": ""} when the code is fine, ' +
      'or {"ok": false, "error": "<the compile error in plain words>", "line": <number or null>, ' +
      '"explanation": "<1-2 simple sentences a beginner understands>", "fixedCode": "<the FULL corrected code>"}'},
    {role: "user", content:
      serverError
        ? `Salesforce rejected this code with: ${serverError}\n\nApex code:\n${String(sourceCode || "").slice(0, 12000)}`
        : `Apex code:\n${String(sourceCode || "").slice(0, 12000)}`}
  ];
  const raw = config.baseUrl
    ? await provider.sendMessage(messages, config.apiKey, config.model, null, config.baseUrl)
    : await provider.sendMessage(messages, config.apiKey, config.model, null);
  const parsed = parseJsonFromText(raw);
  if (!parsed || typeof parsed.ok !== "boolean") {
    throw new Error("LLM did not return a usable check. Raw reply: " + String(raw).slice(0, 300));
  }
  return {
    ok: !!parsed.ok,
    error: String(parsed.error || ""),
    line: parsed.line || null,
    explanation: String(parsed.explanation || ""),
    fixedCode: String(parsed.fixedCode || "")
  };
}

// ─── Shared: per-org localStorage, cached object/describe lists ──
function ffHostKey() {
  try { return sfConn.instanceHostname || "default"; }
  catch (e) { return "default"; }
}

function ffLoadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key + "_" + ffHostKey());
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}

function ffSaveJson(key, val) {
  try { localStorage.setItem(key + "_" + ffHostKey(), JSON.stringify(val)); }
  catch (e) { /* quota, ignore */ }
}

// ── Sidebar session snapshot ────────────────────────────────────────────────
// Minimizing (main SaralForce button) destroys the sidebar iframe, so live
// React state dies with it. App._saveState serializes this snapshot into
// sessionStorage on `sfoc-save-state` and restores it in the constructor on
// reopen — same round-trip the builder chat already uses. Nothing writes the
// key on page refresh, so a refresh of the host page resets everything.
// Ephemeral state (log bodies, loading flags, lookups) stays plain useState
// and is refetched on demand.
let ffRestored = null;
const ffLive = {};

export function ffApplyRestore(snapshot) {
  ffRestored = snapshot && typeof snapshot === "object" ? snapshot : null;
}

function ffUseSession(scope, key, initial) {
  const [val, setVal] = React.useState(() => {
    // Live values from this document session win over the reopen snapshot
    // (tabs unmount when switching Builder ⇄ Inspector mid-session).
    const live = ffLive[scope];
    if (live && Object.prototype.hasOwnProperty.call(live, key)) return live[key];
    const src = ffRestored && ffRestored[scope];
    if (src && Object.prototype.hasOwnProperty.call(src, key)) return src[key];
    return typeof initial === "function" ? initial() : initial;
  });
  React.useEffect(() => {
    if (!ffLive[scope]) ffLive[scope] = {};
    ffLive[scope][key] = val;
  }, [val]);
  return [val, setVal];
}

// Dropped first when the snapshot approaches the sessionStorage quota; every
// one of these is either re-fetchable or re-derivable from its sibling keys.
const FF_TRIM_KEYS = {
  soql: ["result"],
  records: ["rows"],
  import: ["csvText", "records"],
  export: ["preview"],
  logs: ["analyses", "chats", "openLog"],
  apex: ["log"]
};

function ffClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ffTrim(snapshot) {
  const out = ffClone(snapshot);
  for (const [scope, keys] of Object.entries(FF_TRIM_KEYS)) {
    if (!out[scope]) continue;
    keys.forEach(k => delete out[scope][k]);
  }
  return out;
}

export function ffTakeSnapshot() {
  // Live values win; scopes never mounted this session keep their restored data.
  const merged = {};
  for (const src of [ffRestored, ffLive]) {
    if (!src) continue;
    for (const [scope, vals] of Object.entries(src)) {
      merged[scope] = {...(merged[scope] || {}), ...vals};
    }
  }
  try {
    const full = ffClone(merged);
    // Stay well under the 5MB sessionStorage budget for this key.
    if (JSON.stringify(full).length < 2000000) return full;
    return ffTrim(merged);
  } catch (e) {
    try { return ffTrim(merged); } catch (e2) { return null; }
  }
}

function ffSoqlEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

let _ffObjectsCache = null;
async function ffGetObjects(force) {
  if (_ffObjectsCache && !force) return _ffObjectsCache;
  _ffObjectsCache = await recordsListObjects();
  return _ffObjectsCache;
}

const _ffDescribeCache = {};
async function ffDescribeObject(objApi) {
  const key = String(objApi || "").trim();
  if (!key) throw new Error("Enter an object API name");
  if (_ffDescribeCache[key]) return _ffDescribeCache[key];
  const d = await sfConn.rest(
    `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(key)}/describe`,
    {useCache: false});
  _ffDescribeCache[key] = d;
  return d;
}

// ─── Shared code-editor pieces (SOQL + Apex tabs) ─────────────────────
// Success celebration: a paper plane (default) arcs across the editor after
// a run succeeds. Purely visual — pointer-events:none, aria-hidden, keyed so
// it plays exactly once per success and unmounts on animationend. The variant
// (plane | confetti) is read fresh from Settings → Preferences in options.html.
const CONFETTI_COLORS = ["#22a7f0", "#f59e0b", "#a855f7", "#22c555", "#eab308", "#ec4899"];

function Celebrate({seq, onDone}) {
  if (!seq) return null;
  const variant = getCelebrateVariant();
  return h("div", {
    key: seq,
    className: "code-celebrate",
    "aria-hidden": "true",
    onAnimationEnd: e => { if (e.target === e.currentTarget) onDone(); }
  },
    variant === "confetti"
      ? Array.from({length: 16}, (_, i) =>
          h("span", {
            key: i,
            className: "cc-chip",
            style: {"--i": i, background: CONFETTI_COLORS[i % CONFETTI_COLORS.length]}
          }))
      : h("span", {className: "cc-plane"},
          h("svg", {width: 26, height: 26, viewBox: "0 0 24 24", "aria-hidden": "true"},
            h("path", {
              d: "M2.5 11.8 L21.5 3.5 L13.6 20.8 L11 13.2 Z",
              style: {fill: "var(--tok-t, #56d4f1)", stroke: "var(--code-fg, #1e2a3d)"}
            }),
            h("path", {
              d: "M21.5 3.5 L11 13.2",
              style: {stroke: "var(--code-fg, #1e2a3d)", opacity: 0.55}
            })))
  );
}

// SOQL lexer: comments → strings → numbers → identifiers (contextualized by
// keyword / function / table-after-FROM / alias-after-AS / column) →
// operators → punctuation. Output mirrors apexHighlight (escaped HTML).
const SOQL_KEYWORDS = new Set((
  "select from where and or not order by group having limit offset asc desc " +
  "nulls first last like in is null exists between includes excludes with for " +
  "view update typeof end else when then case as union all inner left right " +
  "full outer join on distinct using"
).split(" "));
const SOQL_LOGIC = new Set(["and", "or", "not", "like", "in", "is", "null",
  "exists", "between", "includes", "excludes"]);

function soqlHighlight(src) {
  const text = String(src == null ? "" : src);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:\\.|[^"\\])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([=<>!]+|[-+*/%^])|([(),;.])/g;
  let out = "";
  let last = 0;
  let prev = "";
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      const lw = w.toLowerCase();
      const isCall = /^\s*\(/.test(text.slice(m.index + w.length));
      if (isCall && !SOQL_KEYWORDS.has(lw)) out += `<span class="tok-fn">${esc(w)}</span>`;
      else if (SOQL_KEYWORDS.has(lw)) out += `<span class="${SOQL_LOGIC.has(lw) ? "tok-k2" : "tok-k"}">${esc(w)}</span>`;
      else if (prev === "from" || prev === "join" || prev === "into" || prev === "update") out += `<span class="tok-t">${esc(w)}</span>`;
      else if (prev === "as") out += `<span class="tok-al">${esc(w)}</span>`;
      else out += `<span class="tok-col">${esc(w)}</span>`;
      prev = lw;
    }
    else if (m[5]) out += `<span class="tok-op">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-p">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

// ─── SOQL tab ───────────────────────────────────────────────
function SoqlTab() {
  const [query, setQuery] = ffUseSession("soql", "query", "SELECT Id, Name FROM Account LIMIT 50");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = ffUseSession("soql", "result", null);
  const [limit, setLimit] = ffUseSession("soql", "limit", 500);
  const [soqlDetail, setSoqlDetail] = ffUseSession("soql", "detail", null);
  const [soqlDetailLoading, setSoqlDetailLoading] = React.useState(false);
  const [detailHint, setDetailHint] = React.useState(null);
  const [useLlm, setUseLlm] = React.useState(() => ffLoadJson("ff_soql_use_llm", false));
  const [fixing, setFixing] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState(null);
  const [fixError, setFixError] = React.useState(null);
  const [objects, setObjects] = React.useState([]);
  const [objFilter, setObjFilter] = React.useState("");
  const [fromFields, setFromFields] = React.useState(null);
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_soql_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_soql_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const [resultFilter, setResultFilter] = React.useState("");
  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);
  const [celeb, setCeleb] = React.useState(0);

  const lineCount = Math.max(1, String(query || "").split("\n").length);
  const onTermScroll = e => {
    const t = e.target;
    if (hlRef.current) {
      hlRef.current.scrollTop = t.scrollTop;
      hlRef.current.scrollLeft = t.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop;
  };

  React.useEffect(() => {
    ffGetObjects().then(setObjects).catch(() => {});
  }, []);

  // Object detected after the last FROM — offer its fields.
  const fromMatch = /\bfrom\s+([a-zA-Z0-9_]*)$/i.exec(query) ||
    /\bfrom\s+([a-zA-Z0-9_]+)/i.exec(query);
  const fromObj = fromMatch ? fromMatch[1] : "";

  React.useEffect(() => {
    if (!fromObj) { setFromFields(null); return; }
    ffDescribeObject(fromObj)
      .then(d => setFromFields((d.fields || []).map(f => ({name: f.name, label: f.label, type: f.type}))))
      .catch(() => setFromFields(null));
  }, [fromObj]);

  const insertAtCursor = (text) => {
    const ta = taRef.current;
    if (!ta) { setQuery(q => q + text); return; }
    const start = ta.selectionStart ?? query.length;
    const end = ta.selectionEnd ?? query.length;
    const next = query.slice(0, start) + text + query.slice(end);
    setQuery(next);
    requestAnimationFrame(() => {
      try {
        ta.focus();
        const pos = start + text.length;
        ta.setSelectionRange(pos, pos);
      } catch (e) { /* ignore */ }
    });
  };

  const run = async (overrideQuery) => {
    const q = String(overrideQuery ?? query);
    setLoading(true);
    setError(null);
    setSuggestion(null);
    setFixError(null);
    setSoqlDetail(null);
    setDetailHint(null);
    try {
      const r = await runSoql(q, limit);
      const flat = r.records.map(flattenRecord);
      const colSet = new Set();
      flat.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      setResult({...r, rows: flat, columns: [...colSet]});
      setResultFilter("");
      setCeleb(c => c + 1);
      setHistory(prev => {
        const next = [{q, ts: Date.now()}, ...prev.filter(h => h.q !== q)].slice(0, 20);
        ffSaveJson("ff_soql_history", next);
        return next;
      });
    } catch (e) {
      setError(e.message);
      setResult(null);
      // Smart fix, only when the user opted in via the checkbox.
      if (useLlm) askLlmForFix(q, e.message);
    } finally {
      setLoading(false);
    }
  };

  // PATCH changed fields, then paint them immediately (same as RecordsTab).
  const saveSoqlDetailChanges = async (obj, id, changes) => {
    await sfConn.rest(
      `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`,
      {method: "PATCH", body: changes});
    setSoqlDetail(prev => {
      if (!prev || prev.id !== id) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => Object.prototype.hasOwnProperty.call(changes, r.api)
          ? {...r, value: changes[r.api] == null ? null : String(changes[r.api])}
          : r)
      };
    });
  };

  // "Show all data" for a SOQL row: needs an Id in the row and a simple
  // SELECT ... FROM <Object> executed query. The object is parsed from
  // result.query (not the live textarea) so post-run edits can't misresolve it.
  const openSoqlDetail = async (row) => {
    const id = row && (row.Id || row.id);
    if (!id) {
      setDetailHint("Select Id in your query to use Show all data.");
      return;
    }
    const m = /\bfrom\s+([a-zA-Z0-9_]+)/i.exec(String((result && result.query) || ""));
    if (!m) {
      setDetailHint("Show all data needs a simple SELECT ... FROM <Object> query.");
      return;
    }
    setDetailHint(null);
    setSoqlDetailLoading(true);
    try {
      const d = await ffDescribeObject(m[1]);
      const rec = await fetchFullRecord(m[1], id);
      setSoqlDetail({id, obj: m[1], rows: buildDetailRows(rec, d.fields || [])});
    } catch (e) {
      setDetailHint(`Could not load the full record: ${e.message}`);
    } finally {
      setSoqlDetailLoading(false);
    }
  };

  const askLlmForFix = async (failedQuery, sfError) => {
    if (!hasValidConfig()) {
      setFixError("NO_LLM_CONFIG");
      return;
    }
    setFixing(true);
    setFixError(null);
    try {
      setSuggestion(await suggestSoqlFix(failedQuery, sfError));
    } catch (e) {
      setFixError(e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message);
    } finally {
      setFixing(false);
    }
  };

  const openSettings = () => {
    try {
      chrome.runtime.sendMessage({message: "openOptions", host: ""});
    } catch (e) { /* extension context only */ }
  };

  const exportCsv = () => {
    if (!result) return;
    downloadText("soql-results.csv", toCsv(result.columns, result.rows));
  };

  const saveCurrent = () => {
    const q = query.trim();
    if (!q) return;
    const label = saveLabel.trim() || `Query ${saved.length + 1}`;
    const next = [{label, q}, ...saved.filter(s => s.label !== label)].slice(0, 50);
    setSaved(next);
    ffSaveJson("ff_soql_saved", next);
    setSaveLabel("");
  };

  const deleteSaved = (label) => {
    const next = saved.filter(s => s.label !== label);
    setSaved(next);
    ffSaveJson("ff_soql_saved", next);
  };

  const clearHistory = () => {
    setHistory([]);
    ffSaveJson("ff_soql_history", []);
  };

  const trailingFrom = /\bfrom\s+([a-zA-Z0-9_]*)$/i.exec(query);
  const caretPos = taRef.current && taRef.current.selectionStart != null
    ? taRef.current.selectionStart : query.length;
  const wordBeforeCaret = (/\w+$/.exec(query.slice(0, caretPos)) || [""])[0].toLowerCase();
  const queryTokens = new Set(
    (String(query || "").replace(/'[^']*'/g, " ").match(/[A-Za-z0-9_]+/g) || [])
      .map(t => t.toLowerCase())
  );
  const objChips = objects
    .filter(o => {
      const f = (trailingFrom ? trailingFrom[1] : objFilter).toLowerCase();
      return !f || o.name.toLowerCase().includes(f) || (o.label || "").toLowerCase().includes(f);
    })
    .slice(0, 24);

  // Accepting an object suggestion swaps the whole trailing FROM token for
  // the full API name. The old code appended name.slice(typed.length) and
  // kept the typed text — that only worked when the typed letters were a
  // literal prefix of the name; typing "md" for "...__mdt" produced garbage
  // like "mdANNEL_ORDERS__..." instead of the suggested object.
  const insertObject = (name) => {
    if (trailingFrom) {
      const next = query.slice(0, query.length - trailingFrom[1].length) + name + " ";
      setQuery(next);
      const ta = taRef.current;
      requestAnimationFrame(() => {
        if (!ta) return;
        try { ta.focus(); ta.setSelectionRange(next.length, next.length); } catch (e) { /* ignore */ }
      });
      return;
    }
    insertAtCursor(` ${name}`);
  };

  const insertField = (name) => {
    const ta = taRef.current;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : query.length;
    const before = query.slice(0, caret);
    const quotes = (before.match(/'/g) || []).length;
    const m = quotes % 2 === 0 ? /(\w+)$/.exec(before) : null;
    if (!m) { insertAtCursor(name); return; }
    const start = caret - m[1].length;
    const suffix = caret === query.length ? " " : "";
    const next = query.slice(0, start) + name + suffix + query.slice(caret);
    setQuery(next);
    const pos = start + name.length + suffix.length;
    requestAnimationFrame(() => {
      if (!ta) return;
      try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    });
  };

  // Deterministic pastel tone per field/object name (colourful pills, image-style)
  const pillTone = (name) => {
    let hv = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) hv = (hv * 31 + s.charCodeAt(i)) >>> 0;
    return hv % 8;
  };

  const rf = resultFilter.trim().toLowerCase();
  const visibleRows = !result ? []
    : !rf ? result.rows
    : result.rows.filter(r => result.columns.some(c =>
        String(r[c] == null ? "" : r[c]).toLowerCase().includes(rf)));

  return h("div", {className: "insp-panel"},
    h("div", {className: "soql-layout"},

      // ── Left column (1/4): settings · row limit · history · saved ──
      h("div", {className: "soql-side"},
        h("div", {className: "soql-side-h"}, "LLM"),
        (() => {
          // Read live every render so what the frontend captured is always
          // visible — no more guessing whether Options saved correctly.
          const cfg = getSavedConfig();
          const ok = hasValidConfig();
          const def = cfg && cfg.provider ? getProviderConfig(cfg.provider) : null;
          return h("label", {
            className: "llm-chip" + (ok ? " ok" : " off"),
            title: ok
              ? `Provider: ${cfg.provider}\nModel: ${cfg.model || "(default)"}\nKey: ${cfg.apiKey ? "••••" + String(cfg.apiKey).slice(-4) : "missing"}\n(uncheck to stop asking the LLM when a query fails)`
              : "Open Settings (⚙ in the sidebar header) → choose provider, paste API key, Save Settings"
          },
            h("input", {
              type: "checkbox",
              checked: !!useLlm,
              onChange: e => {
                setUseLlm(e.target.checked);
                ffSaveJson("ff_soql_use_llm", e.target.checked);
              }
            }),
            h("span", null, ok
              ? `✨ ${def ? def.name : cfg.provider} · ${cfg.model || "default"}`
              : "✨ LLM not configured")
          );
        })(),
        h("label", {className: "insp-field"},
          h("span", null, "Row limit"),
          h("input", {
            type: "number",
            min: 1,
            max: 20000,
            value: limit,
            onChange: e => setLimit(e.target.value)
          })
        ),
        h("button", {
          className: "btn btn-primary",
          disabled: loading,
          onClick: () => run()
        }, loading ? "Running…" : "▶ Run SOQL"),
        h("div", {className: "soql-side-h"}, "History"),
        h("label", {className: "insp-field"},
          h("select", {
            value: "",
            onChange: e => {
              if (e.target.value) { setQuery(e.target.value); run(e.target.value); }
              e.target.value = "";
            }
          },
            h("option", {value: ""}, history.length ? "— recent queries —" : "No history yet"),
            history.map((hh, i) =>
              h("option", {key: i, value: hh.q},
                `${new Date(hh.ts).toLocaleString()} — ${hh.q.slice(0, 60)}`)
            )
          )
        ),
        h("div", {className: "soql-side-h"}, "Saved queries"),
        saved.length > 0
          ? h("div", {className: "insp-chips soql-saved-chips"},
              saved.slice(0, 12).map(s =>
                h("span", {key: s.label, className: "insp-chip-group"},
                  h("button", {
                    className: "insp-chip",
                    title: s.q,
                    onClick: () => setQuery(s.q)
                  }, s.label),
                  h("button", {
                    className: "insp-chip-x",
                    title: `Delete "${s.label}"`,
                    onClick: () => deleteSaved(s.label)
                  }, "×")
                )
              )
            )
          : h("div", {className: "insp-meta"}, "Save a query to reuse it later."),
        h("div", {className: "soql-save-row"},
          h("input", {
            className: "soql-save-input",
            value: saveLabel,
            placeholder: "Query label",
            onChange: e => setSaveLabel(e.target.value),
            onKeyDown: e => { if (e.key === "Enter") saveCurrent(); }
          }),
          h("button", {
            className: "btn btn-primary btn-sm",
            disabled: !query.trim(),
            onClick: saveCurrent
          }, "Save Query")
        ),
        history.length > 0 && h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: clearHistory,
          title: "Clear recent query history"
        }, "Clear history")
      ),

      // ── Right column (3/4): editor · field explorer · results ──
      h("div", {className: "soql-main"},
        h("div", {className: "insp-card-header"},
          h("div", {className: "insp-card-title"}, "SOQL Query Editor"),
          h("div", {className: "insp-card-actions"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: !query.trim(),
              onClick: saveCurrent
            }, "Save Query"),
            result && h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: exportCsv
            }, "Export CSV")
          )
        ),
        h("div", {className: "soql-editor-box"},
          h("div", {className: "soql-term"},
            h("div", {className: "soql-gutter", ref: gutterRef, "aria-hidden": "true"},
              Array.from({length: lineCount}, (_, i) =>
                h("div", {key: i, className: "soql-ln"}, String(i + 1)))),
            h("div", {className: "soql-pane"},
              h("pre", {className: "soql-hl", ref: hlRef, "aria-hidden": "true"},
                h("code", {dangerouslySetInnerHTML: {__html: soqlHighlight(query)}})),
              h("textarea", {
                ref: taRef,
                className: "insp-soql",
                value: query,
                spellCheck: false,
                wrap: "off",
                onChange: e => setQuery(e.target.value),
                onScroll: onTermScroll,
                onKeyDown: e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
                },
                placeholder: "SELECT Id, Name FROM Account LIMIT 50"
              })),
            h(Celebrate, {seq: celeb, onDone: () => setCeleb(0)})),
          h("div", {className: "soql-hint-row"},
            h("span", null,
              h("kbd", null, "Ctrl"), " / ", h("kbd", null, "⌘"),
              " + ", h("kbd", null, "Enter"), " to run")
          )
        ),
        error && h("div", {className: "insp-error"}, error),
        fixing && h("div", {className: "insp-meta"}, "✨ Asking LLM to fix the query…"),
        fixError === "NO_LLM_CONFIG" && h("div", {className: "insp-warn"},
          "LLM fix needs a provider + API key. ",
          h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")
        ),
        fixError && fixError !== "NO_LLM_CONFIG" && h("div", {className: "insp-error"},
          "LLM fix failed: " + fixError),
        suggestion && h("div", {className: "insp-fix"},
          h("div", {className: "insp-fix-title"}, "✨ Suggested fix"),
          h("div", {className: "insp-fix-why"}, suggestion.explanation),
          h("div", {className: "insp-fix-query"}, suggestion.fixedQuery),
          h("div", {className: "insp-toolbar", style: {marginBottom: "0", marginTop: "8px"}},
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: loading,
              onClick: () => { setQuery(suggestion.fixedQuery); run(suggestion.fixedQuery); }
            }, loading ? "Running…" : "Apply & Run"),
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: async () => {
                try { await safeCopyText(suggestion.fixedQuery); }
                catch (e) { /* ignore */ }
              }
            }, "Copy")
          )
        ),

        // Field Explorer — colourful pill tags + in-field search icon
        h("div", {className: "soql-explorer-h"},
          h("div", {className: "insp-card-title"},
            fromFields ? `Available Fields · ${fromObj}` : "Available Objects"),
          h("div", {className: "soql-search"},
            h("svg", {
              className: "soql-search-ico",
              width: 14, height: 14, viewBox: "0 0 24 24",
              fill: "currentColor", "aria-hidden": "true"
            }, h("path", {
              d: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
            })),
            h("input", {
              className: "soql-search-input",
              value: objFilter,
              placeholder: fromFields ? "filter fields…" : "filter objects…",
              onChange: e => setObjFilter(e.target.value)
            })
          )
        ),
        h("div", {className: "insp-chips soql-fields"},
          (fromFields
            ? (() => {
                let list = fromFields.filter(f => !objFilter ||
                  f.name.toLowerCase().includes(objFilter.toLowerCase()) ||
                  (f.label || "").toLowerCase().includes(objFilter.toLowerCase()));
                const w = wordBeforeCaret;
                const rank = f => {
                  const n = f.name.toLowerCase();
                  const used = queryTokens.has(n);
                  const typed = !!w && n.startsWith(w);
                  if (used && typed) return 0;
                  if (typed) return 1;
                  if (used) return 2;
                  if (w && ((f.label || "").toLowerCase().startsWith(w) || n.includes(w))) return 3;
                  return 4;
                };
                list = list.slice().sort((a, b) => rank(a) - rank(b));
                return list.slice(0, 60).map(f => h("button", {
                  key: f.name,
                  className: "insp-chip t" + pillTone(f.name),
                  title: `${f.label} · ${f.type} — click to insert`,
                  onClick: () => insertField(f.name)
                }, f.name));
              })()
            : objChips.map(o => h("button", {
                key: o.name,
                className: "insp-chip t" + pillTone(o.name),
                title: `${o.label} — click to insert`,
                onClick: () => insertObject(o.name)
              }, o.name))
          ),
          fromFields && h("button", {
            className: "insp-chip insp-chip-alt",
            onClick: () => setFromFields(null),
            title: "Back to object suggestions"
          }, "← objects")
        ),

        result && h("div", {className: "soql-results-h"},
          h("div", {className: "insp-meta"},
            rf
              ? `showing ${visibleRows.length} of ${result.rows.length} row(s)`
              : `${result.totalSize} row(s) · pages OK · query ends LIMIT ${/\blimit\s+(\d+)/i.exec(result.query)?.[1] || "—"}`
          ),
          h("div", {className: "soql-search"},
            h("svg", {
              className: "soql-search-ico",
              width: 14, height: 14, viewBox: "0 0 24 24",
              fill: "currentColor", "aria-hidden": "true"
            }, h("path", {
              d: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
            })),
            h("input", {
              className: "soql-search-input",
              value: resultFilter,
              placeholder: "search results…",
              onChange: e => setResultFilter(e.target.value)
            })
          )
        ),
        result && h("div", {className: "soql-id-hint"},
          "Click on any Id to Show the all data for record"),
        result && (rf && !visibleRows.length
          ? h("div", {className: "insp-empty"}, "No matching rows.")
          : h(ResultTable, {
              columns: result.columns,
              rows: visibleRows,
              maxRows: 300,
              onRowClick: openSoqlDetail,
              rowHint: "Click to show all data"
            })),
        detailHint && h("div", {className: "insp-meta"}, detailHint),
        (soqlDetailLoading || soqlDetail) && h(RecordDetailPanel, {
          detail: soqlDetail,
          loading: soqlDetailLoading,
          onBack: () => setSoqlDetail(null),
          onSave: saveSoqlDetailChanges
        })
      )
    )
  );
}

// ─── Data Export tab ────────────────────────────────────────
function ExportTab() {
  const [objectApi, setObjectApi] = ffUseSession("export", "objectApi", "");
  const [fields, setFields] = ffUseSession("export", "fields", "Id, Name");
  const [where, setWhere] = ffUseSession("export", "where", "");
  const [limit, setLimit] = ffUseSession("export", "limit", 10000);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [meta, setMeta] = ffUseSession("export", "meta", null);
  const [preview, setPreview] = ffUseSession("export", "preview", null);
  const [objects, setObjects] = React.useState([]);
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_export_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_export_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");

  React.useEffect(() => {
    ffGetObjects().then(setObjects).catch(() => {});
  }, []);

  const currentConfig = () => ({
    objectApi: objectApi.trim(),
    fields: fields.trim(),
    where: where.trim(),
    limit: parseInt(limit, 10) || 10000
  });

  const applyConfig = (c) => {
    setObjectApi(c.objectApi || "");
    setFields(c.fields || "Id, Name");
    setWhere(c.where || "");
    if (c.limit) setLimit(c.limit);
    setPreview(null);
  };

  const describe = async () => {
    setError(null);
    const obj = objectApi.trim();
    if (!obj) { setError("Enter an object API name"); return; }
    setLoading(true);
    try {
      const d = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/describe`);
      const fieldList = (d.fields || []).map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        updateable: f.updateable,
        createable: f.createable
      }));
      setMeta({name: d.name, label: d.label, fields: fieldList});
      setFields(["Id", ...(d.fields || []).filter(f => f.name !== "Id" &&
        ["string", "textarea", "email", "phone", "url", "date", "datetime", "currency",
         "double", "int", "boolean", "picklist", "multipicklist", "reference"].includes(f.type))
        .slice(0, 8).map(f => f.name)].join(", "));
    } catch (e) {
      setError(e.message);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  };

  const runExport = async () => {
    setError(null);
    setLoading(true);
    setPreview(null);
    try {
      const obj = objectApi.trim();
      if (!obj) throw new Error("Enter an object API name");
      let q = `SELECT ${fields.trim() || "Id, Name"} FROM ${obj}`;
      if (where.trim()) q += ` WHERE ${where.trim()}`;
      if (!/\blimit\s+\d+/i.test(q)) q += ` LIMIT ${parseInt(limit, 10) || 10000}`;
      const r = await runSoql(q, null);
      const rows = r.records.map(flattenRecord);
      const colSet = new Set();
      rows.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      const columns = [...colSet];
      setPreview({columns, rows, total: r.totalSize, query: q});
      setHistory(prev => {
        const entry = {...currentConfig(), ts: Date.now()};
        const next = [entry,
          ...prev.filter(h => JSON.stringify({...h, ts: 0}) !== JSON.stringify({...entry, ts: 0}))]
          .slice(0, 15);
        ffSaveJson("ff_export_history", next);
        return next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveCurrent = () => {
    if (!objectApi.trim()) return;
    const label = saveLabel.trim() || `${objectApi.trim()} export ${saved.length + 1}`;
    const next = [{label, ...currentConfig()},
      ...saved.filter(s => s.label !== label)].slice(0, 50);
    setSaved(next);
    ffSaveJson("ff_export_saved", next);
    setSaveLabel("");
  };

  const deleteSaved = (label) => {
    const next = saved.filter(s => s.label !== label);
    setSaved(next);
    ffSaveJson("ff_export_saved", next);
  };

  const download = () => {
    if (!preview) return;
    downloadText(`${objectApi.trim() || "export"}.csv`, toCsv(preview.columns, preview.rows));
  };

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field"},
        h("span", null, "Saved exports"),
        h("select", {
          value: "",
          onChange: e => {
            const hit = saved.find(s => s.label === e.target.value);
            if (hit) applyConfig(hit);
            e.target.value = "";
          }
        },
          h("option", {value: ""}, saved.length ? "— load —" : "No saved exports"),
          saved.map(s => h("option", {key: s.label, value: s.label}, s.label))
        )
      ),
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Save current as"),
        h("input", {
          value: saveLabel,
          placeholder: "Export label",
          onChange: e => setSaveLabel(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") saveCurrent(); }
        })
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: loading || !objectApi.trim(),
        onClick: saveCurrent
      }, "Save Export"),
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "History"),
        h("select", {
          value: "",
          onChange: e => {
            const idx = parseInt(e.target.value, 10);
            if (!isNaN(idx) && history[idx]) applyConfig(history[idx]);
            e.target.value = "";
          }
        },
          h("option", {value: ""}, history.length ? "— recent —" : "No history yet"),
          history.map((hh, i) =>
            h("option", {key: i, value: String(i)},
              `${new Date(hh.ts).toLocaleString()} — ${hh.objectApi}`)
          )
        )
      )
    ),
    saved.length > 0 && h("div", {className: "insp-chips-row"},
      h("span", {className: "insp-chips-label"}, "Saved:"),
      saved.slice(0, 12).map(s =>
        h("span", {key: s.label, className: "insp-chip-group"},
          h("button", {
            className: "insp-chip",
            title: `${s.objectApi} — ${s.fields}${s.where ? ` WHERE ${s.where}` : ""}`,
            onClick: () => applyConfig(s)
          }, s.label),
          h("button", {
            className: "insp-chip-x",
            title: `Delete "${s.label}"`,
            onClick: () => deleteSaved(s.label)
          }, "×")
        )
      )
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Object API name"),
        h("input", {
          value: objectApi,
          list: "insp-export-objects",
          placeholder: "Account / IT_Asset__c — type to filter",
          onChange: e => setObjectApi(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") describe(); }
        }),
        h("datalist", {id: "insp-export-objects"},
          objects.map(o =>
            h("option", {key: o.name, value: o.name}, `${o.label}${o.custom ? " (custom)" : ""}`)
          )
        )
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: loading,
        onClick: describe
      }, "Describe")
    ),
    h("label", {className: "insp-field"},
      h("span", null, "Fields (comma-separated)"),
      h("input", {
        value: fields,
        onChange: e => setFields(e.target.value),
        placeholder: "Id, Name"
      })
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "WHERE (optional)"),
        h("input", {
          value: where,
          onChange: e => setWhere(e.target.value),
          placeholder: "Industry = 'Tech'"
        })
      ),
      h("label", {className: "insp-field"},
        h("span", null, "Limit"),
        h("input", {
          type: "number",
          min: 1,
          max: 50000,
          value: limit,
          onChange: e => setLimit(e.target.value)
        })
      ),
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: loading,
        onClick: runExport
      }, loading ? "Exporting…" : "Query & Preview"),
      preview && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: download
      }, "Download CSV")
    ),
    meta && h("div", {className: "insp-meta"},
      `${meta.label || meta.name} · ${meta.fields.length} fields (describe OK)`
    ),
    error && h("div", {className: "insp-error"}, error),
    preview && h("div", {className: "insp-meta"},
      `${preview.total} row(s) ready · ${preview.columns.length} columns`
    ),
    preview && h(ResultTable, {
      columns: preview.columns,
      rows: preview.rows,
      maxRows: 200
    })
  );
}

// ─── Data Import tab ────────────────────────────────────────
function ImportTab() {
  const [objectApi, setObjectApi] = ffUseSession("import", "objectApi", "");
  const [csvText, setCsvText] = ffUseSession("import", "csvText", "");
  const [headers, setHeaders] = ffUseSession("import", "headers", []);
  const [records, setRecords] = ffUseSession("import", "records", []);
  const [fieldMap, setFieldMap] = ffUseSession("import", "fieldMap", {});
  const [pasteText, setPasteText] = ffUseSession("import", "pasteText", "");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = ffUseSession("import", "result", null);

  // Shared loader for both the file picker and the paste box.
  const loadCsvText = (text, name) => {
    setError(null);
    setResult(null);
    if (!text) return;
    setCsvText(text);
    const parsed = parseCsv(text);
    setHeaders(parsed.headers);
    setRecords(parsed.records);
    // Auto-map header → field when header looks like an API name.
    const map = {};
    for (const hd of parsed.headers) {
      map[hd] = hd;
    }
    setFieldMap(map);
    // Guess object from filename: Account.csv → Account
    if (name) {
      const base = name.replace(/\.[^.]+$/, "");
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) setObjectApi(prev => prev || base);
    }
  };

  const onFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    loadCsvText(text, file.name);
  };

  const loadPasted = () => {
    if (!pasteText.trim()) return;
    loadCsvText(pasteText, "");
  };

  const importRows = async () => {
    setError(null);
    setResult(null);
    const obj = objectApi.trim();
    if (!obj) { setError("Enter target object API name"); return; }
    if (!records.length) { setError("Load a CSV first"); return; }
    const mapped = [];
    for (const rec of records) {
      const body = {};
      for (const [csvKey, fieldApi] of Object.entries(fieldMap)) {
        if (!fieldApi) continue;
        const v = rec[csvKey];
        if (v === undefined || v === null || v === "") continue;
        body[fieldApi] = v;
      }
      if (Object.keys(body).length) mapped.push(body);
    }
    if (!mapped.length) { setError("No mappable rows — map at least one column to a field"); return; }
    setLoading(true);
    let ok = 0;
    const failures = [];
    try {
      for (let i = 0; i < mapped.length; i++) {
        try {
          await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}`, {
            method: "POST",
            body: mapped[i],
            useCache: false
          });
          ok++;
        } catch (e) {
          failures.push(`row ${i + 1}: ${e.message}`);
          if (failures.length >= 5) break;
        }
      }
      setResult({
        ok,
        failed: mapped.length - ok,
        failures: failures.slice(0, 5),
        total: mapped.length
      });
    } finally {
      setLoading(false);
    }
  };

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Target object"),
        h("input", {
          value: objectApi,
          placeholder: "Account / IT_Asset__c",
          onChange: e => setObjectApi(e.target.value)
        })
      ),
      h("label", {className: "insp-file"},
        h("span", null, "CSV file"),
        h("input", {
          type: "file",
          accept: ".csv,text/csv",
          onChange: e => onFile(e.target.files && e.target.files[0])
        })
      )
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "…or paste CSV (first line = column headers)"),
        h("textarea", {
          rows: 3,
          value: pasteText,
          placeholder: "Id,Name,Industry\n001xx…,Acme,Technology",
          onChange: e => setPasteText(e.target.value)
        })
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        style: {alignSelf: "flex-end"},
        disabled: !pasteText.trim(),
        onClick: loadPasted
      }, "Load pasted CSV")
    ),
    records.length > 0 && h("div", {className: "insp-meta"},
      `${records.length} data row(s) · ${headers.length} column(s)`
    ),
    headers.length > 0 && h("div", {className: "insp-map"},
      h("div", {className: "insp-map-title"}, "Column → Salesforce field"),
      h("div", {className: "insp-map-grid"},
        headers.map(hd =>
          h("div", {key: hd, className: "insp-map-row"},
            h("span", {className: "insp-map-csv"}, hd),
            h("span", {className: "insp-map-arrow"}, "→"),
            h("input", {
              value: fieldMap[hd] || "",
              placeholder: "Field API name",
              onChange: e => setFieldMap(prev => ({...prev, [hd]: e.target.value}))
            })
          )
        )
      )
    ),
    h("div", {className: "insp-toolbar"},
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: loading || !records.length,
        onClick: importRows
      }, loading ? `Importing…` : `Import ${records.length} row(s)`)
    ),
    error && h("div", {className: "insp-error"}, error),
    result && h("div", {
      className: result.failed ? "insp-warn" : "insp-ok"
    },
      `Imported ${result.ok}/${result.total}` +
      (result.failed ? ` · ${result.failed} failed` : "") +
      (result.failures && result.failures.length
        ? ` — first errors: ${result.failures.join("; ")}`
        : "")
    ),
    records.length > 0 && h("details", {className: "insp-details"},
      h("summary", null, "Preview CSV"),
      h("textarea", {
        className: "insp-csv-preview",
        readOnly: true,
        value: csvText.slice(0, 8000)
      })
    )
  );
}

// ─── Org Info tab ───────────────────────────────────────────
function OrgTab() {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [info, setInfo] = ffUseSession("org", "info", null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const org = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(
          "SELECT Id, Name, InstanceName, IsSandbox, OrganizationType, TrialExpirationDate, FiscalYearStartMonth, DefaultLocaleSidKey FROM Organization LIMIT 1"),
        {useCache: false});
      const limits = await sfConn.rest(`/services/data/v${apiVersion}/limits`);
      let user = null;
      try {
        user = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/me`);
      } catch (e) {
        try {
          const idRes = await fetch("https://" + sfConn.instanceHostname + "/services/oauth2/userinfo", {
            headers: {Authorization: "Bearer " + sfConn.sessionId}
          });
          if (idRes.ok) user = await idRes.json();
        } catch (e2) { /* ignore */ }
      }
      let counts = null;
      try {
        const cRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(
            "SELECT COUNT() FROM EntityDefinition WHERE IsCustomizable = true"));
        counts = cRes && typeof cRes.totalSize === "number" ? cRes.totalSize : null;
      } catch (e) { /* ignore */ }

      // Permission sets — best effort, each query failing independently.
      const q = (soql) => sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const uid = user && (user.user_id || user.Id);
      const [psRes, psgRes, mineRes] = await Promise.all([
        q("SELECT Id, Label, Name, Description, NamespacePrefix, LicenseId, IsOwnedByProfile, CreatedDate " +
          "FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label LIMIT 2000").catch(() => null),
        q("SELECT COUNT() FROM PermissionSetGroup").catch(() => null),
        uid
          ? q("SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = '" + uid + "'").catch(() => null)
          : Promise.resolve(null)
      ]);

      setInfo({
        org: org.records && org.records[0] ? org.records[0] : null,
        limits: limits || null,
        user,
        customObjects: counts,
        permsets: psRes ? {records: psRes.records || [], total: psRes.totalSize || 0} : null,
        permsetGroups: psgRes && typeof psgRes.totalSize === "number" ? psgRes.totalSize : null,
        myPermsets: mineRes && typeof mineRes.totalSize === "number" ? mineRes.totalSize : null
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, []);

  const details = [];
  if (info?.org) {
    const o = info.org;
    if (o.FiscalYearStartMonth) details.push(["Fiscal year starts", o.FiscalYearStartMonth]);
  }
  if (info?.user) {
    const u = info.user;
    details.push(["User", u.preferred_username || u.username || u.Email || u.name || ""]);
    if (u.organization_id) details.push(["Org Id", u.organization_id]);
    if (u.user_id || u.Id) details.push(["User Id", u.user_id || u.Id]);
  }
  if (info?.customObjects != null) details.push(["Customizable objects", fmtNum(info.customObjects)]);

  const limitTiles = [];
  const limitPlain = [];
  if (info?.limits) {
    const L = info.limits;
    // The Limits API returns storage as DataStorageMB/FileStorageMB (MB,
    // requires Manage Users); older orgs/docs may use DataStorage/FileStorage.
    const aliases = [
      ["Data Storage", ["DataStorageMB", "DataStorage"]],
      ["File Storage", ["FileStorageMB", "FileStorage"]],
      ["Daily API requests", ["DailyApiRequests"]],
      ["Daily Bulk API", ["DailyBulkApiRequests", "DailyBulkBatches"]],
      ["Daily Streaming events", ["DailyStreamingApiEvents"]],
      ["Daily Scratch Orgs", ["DailyScratchOrgs"]],
      ["Concurrent Async GET", ["ConcurrentAsyncGet", "ConcurrentAsyncGetReportInstances"]],
      ["Daily Workspace Node Count", ["DailyWorkspaceNodeCount"]]
    ];
    for (const [label, keys] of aliases) {
      let bucket = null;
      let matchedKey = null;
      for (const k of keys) {
        if (L[k] != null) { bucket = L[k]; matchedKey = k; }
      }
      if (bucket && typeof bucket === "object") {
        if (bucket.Max != null) {
          limitTiles.push({
            label,
            max: bucket.Max,
            remaining: bucket.Remaining,
            storage: /MB$/.test(matchedKey)
          });
        } else {
          limitPlain.push([label, JSON.stringify(bucket)]);
        }
      }
    }
  }
  const hasStorage = limitTiles.some(t => t.storage);

  const org = info && info.org;
  const orgRows = [];
  if (org) {
    orgRows.push(["Org Name", org.Name || "Organization"]);
    if (org.InstanceName) orgRows.push(["Instance", org.InstanceName]);
    if (org.OrganizationType) orgRows.push(["Organization Type", org.OrganizationType]);
    if (org.IsSandbox != null) orgRows.push(["Environment", org.IsSandbox ? "Sandbox" : "Production"]);
    if (org.DefaultLocaleSidKey) orgRows.push(["Locale", org.DefaultLocaleSidKey]);
    if (org.TrialExpirationDate) orgRows.push(["Trial ends", fmtDateTime(org.TrialExpirationDate)]);
  }
  for (const [k, v] of details) orgRows.push([k, v]);

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-card-header"},
      h("div", {className: "insp-card-title"}, "Org Details & Limits"),
      h("div", {className: "insp-card-actions"},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: loading,
          onClick: load
        }, loading ? "Loading…" : "Refresh org info")
      )
    ),
    error && h("div", {className: "insp-error"}, error),
    info && h("div", {className: "org-grid"},

      // General details — description list, Users-view style
      h("div", {className: "org-card"},
        h("div", {className: "org-card-h"},
          h("span", {className: "org-card-ico"}, "🏢"),
          h("span", {className: "org-card-t"}, "Organization")
        ),
        orgRows.length > 0
          ? h("dl", {className: "org-dl"},
              orgRows.map(([k, v]) =>
                h("div", {key: k, className: "org-dl-row"},
                  h("dt", null, k),
                  h("dd", null, v == null || v === "" ? "—" : String(v))
                )
              )
            )
          : h("div", {className: "insp-empty"}, "No data yet")
      ),

      // Limits — visual progress bars only, no "X remaining" sentences
      h("div", {className: "org-card"},
        h("div", {className: "org-card-h"},
          h("span", {className: "org-card-ico"}, "📈"),
          h("span", {className: "org-card-t"}, "Org Limits")
        ),
        limitTiles.length > 0
          ? limitTiles.map(r => {
              const remaining = r.remaining != null ? r.remaining : r.max;
              let pct, kind;
              if (r.storage) {
                // Storage bars show usage (high = bad); values are MB.
                const used = Math.max(0, r.max - remaining);
                pct = r.max > 0 ? Math.max(0, Math.min(100, Math.round(used / r.max * 100))) : 0;
                kind = pct > 90 ? " crit" : (pct > 70 ? " warn" : "");
              } else {
                pct = r.max > 0 ? Math.max(0, Math.min(100, Math.round(remaining / r.max * 100))) : 100;
                kind = pct > 60 ? "" : (pct > 30 ? " warn" : " crit");
              }
              return h("div", {key: r.label, className: "limit-item"},
                h("div", {className: "limit-label"}, r.label),
                h("div", {className: "limit-bar"},
                  h("div", {className: "limit-fill" + kind, style: {width: pct + "%"}})),
                h("div", {className: "limit-foot"},
                  h("span", null, r.storage
                    ? `${fmtStorage(r.max - remaining)} of ${fmtStorage(r.max)} used`
                    : `${fmtNum(remaining)} / ${fmtNum(r.max)}`),
                  h("span", {className: "limit-pct"}, `${pct}%`))
              );
            })
          : h("div", {className: "insp-empty"}, "No limit data"),
        limitPlain.length > 0 && h("dl", {className: "org-dl"},
          limitPlain.map(([k, v]) =>
            h("div", {key: k, className: "org-dl-row"},
              h("dt", null, k),
              h("dd", null, v)
            )
          )
        ),
        !hasStorage && limitTiles.length > 0 &&
          h("div", {className: "insp-hint-strip", style: {margin: "10px 0 0"}},
            "Data/File storage not returned — requires the Manage Users permission.")
      ),

      // Permission sets — counts + searchable list.
      h(PermSetsCard, {info}),

      // Setup changes (SetupAuditTrail) — newest 200, search + copy.
      h(SetupAuditCard, {info}),

      // Recent async Apex work (AsyncApexJob) — newest 20, status badges.
      h(ApexJobsCard, null),

      // Logins (LoginHistory) — newest 200, status badges + copy.
      h(LoginHistoryCard, {info}),

      // AI hygiene audit — facts gathered on demand, then one LLM call.
      h(AuditCard, {info})
    )
  );
}

function PermSetsCard({info}) {
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(null);
  const ps = info && info.permsets;
  const list = (ps && ps.records) || [];
  const licensed = list.filter(p => p && p.LicenseId).length;

  const stats = [];
  stats.push(["Total", ps ? fmtNum(ps.total) : null]);
  if (info && info.myPermsets != null) stats.push(["Assigned to me", fmtNum(info.myPermsets)]);
  if (ps) stats.push(["Licensed (needs PSL)", fmtNum(licensed)]);
  if (info && info.permsetGroups != null) stats.push(["Permission set groups", fmtNum(info.permsetGroups)]);
  const anyStat = stats.some(([, v]) => v != null);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? list.filter(p => p && (
        (p.Label || "").toLowerCase().includes(needle) ||
        (p.Name || "").toLowerCase().includes(needle)))
    : list;

  const copy = (name) => {
    try { safeCopyText(name); } catch (e) { /* ignore */ }
    setCopied(name);
    setTimeout(() => setCopied(null), 1200);
  };

  return h("div", {className: "org-card"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, "🔐"),
      h("span", {className: "org-card-t"}, "Permission Sets")
    ),
    anyStat
      ? h("dl", {className: "org-dl"},
          stats.map(([k, v]) =>
            h("div", {key: k, className: "org-dl-row"},
              h("dt", null, k),
              h("dd", null, v == null ? "—" : String(v))
            )
          )
        )
      : h("div", {className: "insp-empty"}, "No data yet"),
    list.length > 0 && h("div", {className: "perm-block"},
      h("input", {
        className: "perm-search",
        type: "search",
        placeholder: `Filter ${fmtNum(list.length)} permission sets\u2026`,
        value: filter,
        onChange: (e) => setFilter(e.target.value)
      }),
      h("div", {className: "perm-list"},
        shown.map(p =>
          h("div", {
            key: p.Id || p.Name,
            className: "perm-row",
            title: "Click to copy " + p.Name,
            onClick: () => copy(p.Name)
          },
            h("span", {className: "perm-l"}, p.Label || p.Name),
            p.LicenseId ? h(FFBadge, {kind: "warn"}, "PSL") : null,
            p.NamespacePrefix ? h(FFBadge, {kind: "info"}, "managed") : null,
            h("span", {className: "perm-n"}, copied === p.Name ? "\u2713 copied" : p.Name)
          )
        ),
        shown.length === 0 && h("div", {className: "insp-empty"}, "No matches")
      ),
      ps && ps.total > list.length &&
        h("div", {className: "perm-more"},
          `Showing first ${fmtNum(list.length)} of ${fmtNum(ps.total)}`)
    )
  );
}

// ─── Shared searchable list card (Org Info) ─────────────────────────
// LoginHistory has no traversable `User` relationship (INVALID_FIELD on
// `User.Name`), so we fetch ids only and resolve display names with a
// second query. Best-effort: on failure rows keep their raw ids.
const resolveUserNames = async (rows, idKey) => {
  const ids = [];
  rows.forEach(r => { const id = r[idKey]; if (id && ids.indexOf(id) === -1) ids.push(id); });
  if (!ids.length) return rows;
  try {
    const q = "SELECT Id, Name FROM User WHERE Id IN (" +
      ids.map(i => "'" + i + "'").join(",") + ")";
    const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` + encodeURIComponent(q));
    const map = Object.create(null);
    (res.records || []).forEach(u => { map[u.Id] = u.Name; });
    rows.forEach(r => { r._name = map[r[idKey]] || null; });
  } catch (e) { /* keep raw ids */ }
  return rows;
};

// Fetches one SOQL list on mount (header Refresh re-runs it), then renders
// stats, a filter box and click-to-copy rows. `row(r, {copied, copy})`
// draws each line; `match(r, needle)` does the (already lowercased) filter.
function OrgLogCard({icon, title, soql, placeholder, match, stats, row, emptyText, postFetch}) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      let recs = (res && res.records) || [];
      if (postFetch) recs = await postFetch(recs);
      setRows(recs);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => { load(); }, []);

  const copy = (key, text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const list = rows || [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? list.filter(r => match(r, needle)) : list;

  return h("div", {className: "org-card"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, icon),
      h("span", {className: "org-card-t"}, title),
      h("div", {className: "audit-actions"},
        h("button", {
          className: "field-action-btn",
          disabled: busy,
          onClick: load
        }, busy ? (rows ? "Refreshing…" : "Loading…") : "Refresh"))
    ),
    error && h("div", {className: "insp-error"}, error),
    rows === null && !error &&
      h("div", {className: "insp-status-info"}, "Loading " + title.toLowerCase() + "\u2026"),
    rows !== null && stats && h("dl", {className: "org-dl"},
      stats(rows).map(([k, v]) =>
        h("div", {key: k, className: "org-dl-row"},
          h("dt", null, k),
          h("dd", null, String(v))
        )
      )
    ),
    rows !== null && list.length === 0 &&
      h("div", {className: "insp-empty"}, emptyText || "No records found."),
    rows !== null && list.length > 0 && h(React.Fragment, null,
      h("input", {
        className: "perm-search",
        type: "search",
        placeholder: placeholder(list.length),
        value: filter,
        onChange: (e) => setFilter(e.target.value)
      }),
      h("div", {className: "perm-list"},
        shown.map(r => row(r, {copied, copy})),
        shown.length === 0 && h("div", {className: "insp-empty"}, "No matches")
      ),
      list.length >= 200 &&
        h("div", {className: "perm-more"}, "Showing the newest 200 rows.")
    )
  );
}

// Newest setup changes — the SOQL-visible Setup Audit Trail object.
// Row click opens a detail popup (Esc / overlay-click / × close); the popup
// keeps the copy-row action as a button.
function SetupAuditCard({info}) {
  const me = info && info.user && (info.user.user_id || info.user.Id);
  const nm = (r) => r._name || r.CreatedById || "Unknown user";
  const [detail, setDetail] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const lineOf = (r) => [ffAgo(r.CreatedDate), nm(r), r.Action, r.Section, r.Display]
    .filter(x => x != null && x !== "").join(" | ");
  const copyLine = (text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  React.useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === "Escape") setDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);
  return h(React.Fragment, null,
    h(OrgLogCard, {
      icon: "\ud83d\udcdc",
      title: "Setup Audit Trail",
      soql: "SELECT Id, CreatedDate, CreatedById, Action, Section, Display " +
        "FROM SetupAuditTrail ORDER BY CreatedDate DESC LIMIT 200",
      postFetch: (rows) => resolveUserNames(rows, "CreatedById"),
      emptyText: "No setup changes recorded.",
      placeholder: (n) => `Filter ${fmtNum(n)} setup changes\u2026`,
      match: (r, needle) =>
        [nm(r), r.Section, r.Action, r.Display].join(" ").toLowerCase().includes(needle),
      stats: (rows) => [
        ["Total", fmtNum(rows.length)],
        ["Changed by me", fmtNum(rows.filter(r => me && r.CreatedById === me).length)]
      ],
      row: (r) => h("div", {
          key: r.Id || r.Display,
          className: "perm-row",
          title: "Click to view details: " + lineOf(r),
          onClick: () => { setCopied(false); setDetail(r); }
        },
        h("span", {className: "perm-l"}, r.Display || r.Action || "(change)"),
        me && r.CreatedById === me && h(FFBadge, {kind: "info"}, "you"),
        r.Section && h(FFBadge, {kind: "off"}, r.Section),
        h("span", {className: "perm-n"},
          `${ffAgo(r.CreatedDate)} · ${nm(r)}${r.Action ? " · " + r.Action : ""}`)
      )
    }),
    detail && h("div", {
        className: "ff-modal-overlay",
        onMouseDown: (e) => { if (e.target === e.currentTarget) setDetail(null); }
      },
      h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
        h("div", {className: "ff-modal-head"},
          h("div", {className: "ff-modal-title"}, "Setup change details",
            h("span", {className: "ff-modal-sub"},
              ` - ${detail.Section || "Setup"} / ${detail.Action || ""}`)),
          h("button", {className: "ff-modal-x", title: "Close (Esc)",
            onClick: () => setDetail(null)}, "\u00d7")
        ),
        h("div", {className: "ff-modal-body"},
          h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table"},
              h("thead", null,
                h("tr", null, h("th", null, "Field"), h("th", null, "Value"))),
              h("tbody", null,
                [["Change", detail.Display],
                 ["Action", detail.Action],
                 ["Section", detail.Section],
                 ["When", fmtDateTime(detail.CreatedDate)],
                 ["Changed by", nm(detail)],
                 ["Record Id", detail.Id]].map(([k, v]) =>
                  h("tr", {key: k},
                    h("td", null, k),
                    h("td", null, v == null || v === "" ? "(Blank)" : String(v))))
              )
            )
          )
        ),
        h("div", {className: "insp-toolbar"},
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => copyLine(lineOf(detail))},
            copied ? "\u2713 copied" : "Copy row"),
          h("span", {className: "insp-meta"}, "Esc or click outside to close")
        )
      )
    )
  );
}

// Recent async Apex work — AsyncApexJob, newest 20: class, status badge,
// progress and error count. Row click opens a detail popup (Esc / overlay /
// × close) mirroring the Salesforce Apex Jobs page columns.
function ApexJobsCard() {
  const st = (r) => String(r.Status || "");
  const cls = (r) => (r.ApexClass && r.ApexClass.Name) || r.ApexClassId || "(class)";
  const failed = (r) => /^(Failed|Aborted)/i.test(st(r));
  const active = (r) => /^(Processing|Preparing|Queued)/i.test(st(r));
  const prog = (r) => r.TotalJobItems != null && r.TotalJobItems > 0
    ? `${fmtNum(r.JobItemsProcessed || 0)}/${fmtNum(r.TotalJobItems)} items`
    : "";
  const [detail, setDetail] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const lineOf = (r) => [cls(r), st(r) || "?", r.JobType, prog(r),
    r.CreatedDate && fmtDateTime(r.CreatedDate), r.MethodName,
    (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`,
    r.ExtendedStatus].filter(x => x != null && x !== "" && x !== false).join(" | ");
  const copyLine = (text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  React.useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === "Escape") setDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);
  return h(React.Fragment, null,
    h(OrgLogCard, {
      icon: "⚡",
      title: "Apex Jobs",
      soql: "SELECT Id, ApexClass.Name, JobType, Status, MethodName, TotalJobItems, " +
        "JobItemsProcessed, NumberOfErrors, CreatedDate, CompletedDate, ExtendedStatus " +
        "FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT 20",
      emptyText: "No recent Apex jobs.",
      placeholder: (n) => `Filter ${fmtNum(n)} apex jobs\u2026`,
      match: (r, needle) =>
        [cls(r), r.JobType, r.Status, r.MethodName, r.ExtendedStatus]
          .join(" ").toLowerCase().includes(needle),
      stats: (rows) => [
        ["Total", fmtNum(rows.length)],
        ["Failed", fmtNum(rows.filter(failed).length)],
        ["Active", fmtNum(rows.filter(active).length)]
      ],
      row: (r) => {
        const key = r.Id || (r.CreatedDate + "-" + cls(r));
        const bad = failed(r);
        const done = /^Completed/i.test(st(r));
        const kind = bad ? "err" : done ? "ok"
          : /^(Processing|Preparing)/i.test(st(r)) ? "warn"
          : st(r) ? "info" : "off";
        const line = [cls(r), st(r) || "?", r.JobType, prog(r), ffAgo(r.CreatedDate),
          r.MethodName, (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`,
          r.ExtendedStatus].filter(x => x != null && x !== "" && x !== false).join(" | ");
        return h("div", {
          key,
          className: "perm-row",
          title: "Click to view details: " + line,
          onClick: () => { setCopied(false); setDetail(r); }
        },
          h("span", {className: "perm-l"}, cls(r)),
          h(FFBadge, {kind}, st(r) || "?"),
          h("span", {className: "perm-n"},
            [ffAgo(r.CreatedDate), r.JobType, prog(r),
             (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`]
              .filter(x => x != null && x !== "" && x !== false).join(" · "))
        );
      }
    }),
    detail && h("div", {
        className: "ff-modal-overlay",
        onMouseDown: (e) => { if (e.target === e.currentTarget) setDetail(null); }
      },
      h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
        h("div", {className: "ff-modal-head"},
          h("div", {className: "ff-modal-title"}, "Apex job details",
            h("span", {className: "ff-modal-sub"},
              ` - ${cls(detail)} / ${st(detail) || "?"}`)),
          h("button", {className: "ff-modal-x", title: "Close (Esc)",
            onClick: () => setDetail(null)}, "\u00d7")
        ),
        h("div", {className: "ff-modal-body"},
          h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table"},
              h("thead", null,
                h("tr", null, h("th", null, "Field"), h("th", null, "Value"))),
              h("tbody", null,
                [["Apex Class", cls(detail)],
                 ["Job Type", detail.JobType],
                 ["Status", detail.Status],
                 ["Status Detail", detail.ExtendedStatus],
                 ["Method", detail.MethodName],
                 ["Total Batches", detail.TotalJobItems],
                 ["Batches Processed", detail.JobItemsProcessed],
                 ["Failures", detail.NumberOfErrors],
                 ["Submitted Date", detail.CreatedDate && fmtDateTime(detail.CreatedDate)],
                 ["Completion Date", detail.CompletedDate && fmtDateTime(detail.CompletedDate)],
                 ["Job Id", detail.Id]].map(([k, v]) =>
                  h("tr", {key: k},
                    h("td", null, k),
                    h("td", null, v == null || v === "" ? "(Blank)" : String(v))))
              )
            )
          )
        ),
        h("div", {className: "insp-toolbar"},
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => copyLine(lineOf(detail))},
            copied ? "\u2713 copied" : "Copy row"),
          h("span", {className: "insp-meta"}, "Esc or click outside to close")
        )
      )
    )
  );
}

// Recent logins — success/failure badges, IP in the secondary line.
function LoginHistoryCard({info}) {
  const me = info && info.user && (info.user.user_id || info.user.Id);
  const nm = (r) => r._name || r.UserId || "Unknown user";
  const failed = (r) => !/^Success/i.test(r.Status || "");
  return h(OrgLogCard, {
    icon: "\ud83d\udeaa",
    title: "Login History",
    soql: "SELECT Id, UserId, LoginTime, SourceIp, Status, LoginType " +
      "FROM LoginHistory ORDER BY LoginTime DESC LIMIT 200",
    postFetch: (rows) => resolveUserNames(rows, "UserId"),
    emptyText: "No logins recorded.",
    placeholder: (n) => `Filter ${fmtNum(n)} logins\u2026`,
    match: (r, needle) =>
      [nm(r), r.Status, r.SourceIp, r.LoginType]
        .join(" ").toLowerCase().includes(needle),
    stats: (rows) => [
      ["Total", fmtNum(rows.length)],
      ["Failed", fmtNum(rows.filter(failed).length)]
    ],
    row: (r, ctx) => {
      const key = r.Id || (r.LoginTime + "-" + r.UserId);
      const bad = failed(r);
      const line = [ffAgo(r.LoginTime), nm(r), r.Status, r.SourceIp, r.LoginType]
        .filter(x => x != null && x !== "").join(" | ");
      return h("div", {
        key,
        className: "perm-row",
        title: "Click to copy: " + line,
        onClick: () => ctx.copy(key, line)
      },
        h("span", {className: "perm-l"}, nm(r)),
        me && r.UserId === me && h(FFBadge, {kind: "info"}, "you"),
        h(FFBadge, {kind: bad ? "err" : "ok"}, bad ? "Failed" : "Success"),
        h("span", {className: "perm-n"},
          ctx.copied === key
            ? "\u2713 copied"
            : `${ffAgo(r.LoginTime)} · ${r.Status || "?"}${r.SourceIp ? " · " + r.SourceIp : ""}`)
      );
    }
  });
}

// ─── Org hygiene audit: cheap facts → one LLM call → report ────────
const ORG_AUDIT_SYSTEM =
  "You are a senior Salesforce org hygiene auditor reviewing ONE org for a beginner admin. " +
  "You are given a plain-text facts snapshot collected live from the org. " +
  "Reply as plain text with exactly these sections: SUMMARY, ISSUES, NEXT ACTIONS. " +
  "Keep it under 250 words. Base every issue strictly on the facts given — never invent " +
  "numbers, objects or settings that are not in the facts. Call out concrete risks (storage " +
  "pressure, API usage, inactive users, permission sprawl) with the exact numbers from the " +
  "facts. NEXT ACTIONS must be short actionable bullets a beginner can do in Setup.";

// Best-effort extra facts for the audit: inactive users, profile count,
// recent logins. Each query fails independently (read-only COUNT queries).
async function orgAuditFacts(info) {
  const q = (soql) => sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(soql), {useCache: false});
  const cnt = async (soql) => {
    try {
      const r = await q(soql);
      return r && typeof r.totalSize === "number" ? r.totalSize : null;
    } catch (e) { return null; }
  };
  const [profiles, inactive, neverLoggedIn, psetAssignments] = await Promise.all([
    cnt("SELECT COUNT() FROM Profile"),
    cnt("SELECT COUNT() FROM User WHERE IsActive = false"),
    cnt("SELECT COUNT() FROM User WHERE LastLoginDate = null"),
    cnt("SELECT COUNT() FROM PermissionSetAssignment")
  ]);
  return {profiles, inactive, neverLoggedIn, psetAssignments};
}

// Compact plain-text snapshot handed to the LLM (and shown under the report).
function orgAuditSnapshot(info, facts) {
  const L = (key) => facts && facts[key] != null ? fmtNum(facts[key]) : "unknown";
  const lines = [];
  const o = info && info.org;
  if (o) {
    lines.push(`Org: ${o.Name || "?"} (${o.OrganizationType || "?"}, ` +
      `${o.IsSandbox ? "Sandbox" : "Production"}, instance ${o.InstanceName || "?"})`);
  }
  if (info && info.customObjects != null) {
    lines.push(`Customizable objects: ${fmtNum(info.customObjects)}`);
  }
  lines.push(`Profiles: ${L("profiles")}`);
  lines.push(`Inactive users: ${L("inactive")}`);
  lines.push(`Users who never logged in: ${L("neverLoggedIn")}`);
  const ps = info && info.permsets;
  if (ps) {
    const licensed = ps.records.filter(p => p && p.LicenseId).length;
    lines.push(`Permission sets (non-profile): ${fmtNum(ps.total)} ` +
      `(${fmtNum(licensed)} license-restricted, ${L("psetAssignments")} assignments)`);
  } else {
    lines.push(`Permission sets (non-profile): unknown`);
  }
  if (info && info.permsetGroups != null) lines.push(`Permission set groups: ${fmtNum(info.permsetGroups)}`);
  const lim = info && info.limits;
  if (lim) {
    const pct = (bucket) => {
      if (!bucket || typeof bucket !== "object" || !bucket.Max) return null;
      const used = bucket.Max - (bucket.Remaining != null ? bucket.Remaining : bucket.Max);
      return Math.max(0, Math.min(100, Math.round(used / bucket.Max * 100)));
    };
    const d = pct(lim.DataStorageMB || lim.DataStorage);
    const f = pct(lim.FileStorageMB || lim.FileStorage);
    const a = pct(lim.DailyApiRequests);
    if (d != null) lines.push(`Data storage used: ${d}%`);
    if (f != null) lines.push(`File storage used: ${f}%`);
    if (a != null) lines.push(`Daily API requests used: ${a}%`);
  }
  return lines.join("\n");
}

// Card in the Org Info grid: Run audit → facts → AI report (persisted per session).
function AuditCard({info}) {
  const [running, setRunning] = React.useState(false);
  const [report, setReport] = ffUseSession("org", "auditReport", null);
  const [snapshot, setSnapshot] = ffUseSession("org", "auditSnapshot", null);
  const [auditErr, setAuditErr] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  const openSettings = () => {
    try {
      chrome.runtime.sendMessage({message: "openOptions", host: ""});
    } catch (e) { /* extension context only */ }
  };

  const run = async () => {
    setAuditErr(null);
    if (!hasValidConfig()) { setAuditErr("NO_LLM_CONFIG"); return; }
    setRunning(true);
    try {
      const facts = await orgAuditFacts(info);
      const snap = orgAuditSnapshot(info, facts);
      setSnapshot(snap);
      const text = await logsAskLlm(ORG_AUDIT_SYSTEM, "Org hygiene facts:\n" + snap);
      setReport({text, at: Date.now()});
    } catch (e) {
      setAuditErr(e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message);
    } finally {
      setRunning(false);
    }
  };

  const onCopy = () => {
    try {
      if (report) safeCopyText(report.text);
    } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return h("div", {className: "org-card org-card-wide"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, "🩺"),
      h("span", {className: "org-card-t"}, "AI Org Hygiene Audit"),
      h("div", {className: "audit-actions"},
        report && h("span", {className: "audit-at"},
          "Last run " + fmtDateTime(report.at)),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: running,
          onClick: run
        }, running ? "Auditing…" : report ? "Run again" : "Run audit")
      )
    ),
    (!hasValidConfig() || auditErr === "NO_LLM_CONFIG") &&
      h("div", {className: "insp-warn"},
        "AI audit needs a provider + API key. ",
        h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")),
    auditErr && auditErr !== "NO_LLM_CONFIG" &&
      h("div", {className: "insp-error"}, auditErr),
    running && h("div", {className: "insp-status-info"},
      "Collecting org facts, then asking the AI — usually a few seconds…"),
    report && h(AnalysisReport, {text: report.text, copied, onCopy}),
    report && snapshot &&
      h("details", {className: "audit-details"},
        h("summary", null, "Facts sent to the AI"),
        h("pre", {className: "audit-facts"}, snapshot)),
    !report && !running && !auditErr &&
      h("div", {className: "insp-hint-strip"},
        "Runs read-only counts (profiles, inactive users, storage, API) and asks your AI " +
        "for risks and next steps. Nothing is changed in the org.")
  );
}

// ─── Records: browse all data of an object ────────────────────
async function recordsListObjects() {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/`, {useCache: false});
  const list = (res.sobjects || [])
    .filter(o => o && o.queryable !== false && o.name)
    .map(o => ({name: o.name, label: o.label || o.name, custom: !!o.custom}));
  list.sort((a, b) =>
    (b.custom - a.custom) || a.label.localeCompare(b.label));
  return list;
}

// ─── Shared: "Show all data" record detail ────────────────────────────────
// Full-record fetch (REST retrieve returns every field) shaped into sorted
// {api, label, type, value} rows, plus the detail panel both Records and
// SOQL tabs render. Labels/types come from describe metadata; unknown
// fields fall back to inferred types.
function buildDetailRows(rec, metaFields) {
  const meta = {};
  for (const f of metaFields || []) meta[f.name] = f;
  const detailRows = [];
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    const m = meta[k] || {};
    let type = m.type || "";
    if (!type) {
      type = v == null ? "" : typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : "string";
    }
    let value = v;
    if (value && typeof value === "object") {
      value = Array.isArray(value) ? JSON.stringify(value) : (value.Name || value.name || JSON.stringify(value));
    }
    detailRows.push({
      api: k,
      label: m.label || (k === "Id" ? "Record ID" : ""),
      type,
      value: value == null || value === "" ? null : String(value),
      editable: k !== "Id" && m.updateable === true &&
        !["address", "location", "base64", "anyType"].includes(m.type),
      options: normalizePicklistValues(m.picklistValues)
    });
  }
  detailRows.sort((a, b) => a.api.localeCompare(b.api));
  return detailRows;
}

// Accepts raw describe picklistValues ([{active, value}]) or the already
// flattened active-value arrays kept by tab state.
function normalizePicklistValues(picklistValues) {
  const picks = [];
  for (const p of picklistValues || []) {
    if (p && typeof p === "object") {
      if (p.active !== false && p.value != null) picks.push(String(p.value));
    } else if (p != null) {
      picks.push(String(p));
    }
  }
  return picks;
}

async function fetchFullRecord(obj, id) {
  return sfConn.rest(
    `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`,
    {useCache: true});
}

// Render an ISO instant for a datetime-local input (browser-local wall time).
function toLocalInput(s) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 16);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function detailDraftSeed(row) {
  if (row.value == null) return row.type === "boolean" ? "false" : "";
  const s = String(row.value);
  if (row.type === "boolean") return s.toLowerCase() === "true" ? "true" : "false";
  if (row.type === "date") return s.slice(0, 10);
  if (row.type === "datetime") return toLocalInput(s);
  return s;
}

function draftDiffers(row, draftVal) {
  const orig = row.value == null ? "" : String(row.value);
  if (row.type === "boolean") return (String(draftVal) === "true") !== (orig.toLowerCase() === "true");
  if (row.type === "date") return String(draftVal) !== orig.slice(0, 10);
  if (row.type === "datetime") return String(draftVal) !== toLocalInput(orig);
  return String(draftVal) !== orig;
}

function coerceDetailValue(row, draftVal) {
  if (draftVal === "" || draftVal == null) return null;
  if (row.type === "boolean") return draftVal === "true";
  if (row.type === "datetime") {
    const t = Date.parse(String(draftVal));
    if (isNaN(t)) throw new Error(`${row.api}: "${draftVal}" is not a valid date/time.`);
    return new Date(t).toISOString();
  }
  if (["int", "double", "currency", "percent"].includes(row.type)) {
    const n = Number(draftVal);
    if (!Number.isFinite(n)) throw new Error(`${row.api}: "${draftVal}" is not a number.`);
    return n;
  }
  return String(draftVal);
}

function RecordDetailPanel({detail, loading, onBack, onSave}) {
  const [editingApi, setEditingApi] = React.useState(null);
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);
  const [saveErr, setSaveErr] = React.useState(null);
  const [rowFilter, setRowFilter] = React.useState("");
  const recordKey = detail ? `${detail.obj}/${detail.id}` : "";
  React.useEffect(() => {
    setEditingApi(null);
    setDrafts({});
    setSaveMsg(null);
    setSaveErr(null);
    setRowFilter("");
  }, [recordKey]);
  // Esc closes the modal (editor Esc is handled inside the input and
  // stops propagation, so it only cancels the cell edit).
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  const canEdit = !loading && !saving && !!onSave;
  const changed = detail
    ? detail.rows.filter(r => r.editable && drafts[r.api] !== undefined && draftDiffers(r, drafts[r.api]))
    : [];
  const rf = rowFilter.trim().toLowerCase();
  const shownRows = !detail ? []
    : !rf ? detail.rows
    : detail.rows.filter(r => {
        const val = drafts[r.api] !== undefined
          ? String(drafts[r.api])
          : (r.value == null ? "" : String(r.value));
        return [r.api, r.label, r.type, val].join(" ").toLowerCase().includes(rf);
      });
  const startEdit = (row) => {
    if (!row.editable || !canEdit) return;
    setSaveMsg(null);
    setSaveErr(null);
    setDrafts(prev => (prev[row.api] !== undefined
      ? prev
      : {...prev, [row.api]: detailDraftSeed(row)}));
    setEditingApi(row.api);
  };
  const closeEditor = (discard) => {
    if (discard && editingApi) {
      const api = editingApi;
      setDrafts(prev => {
        const next = {...prev};
        delete next[api];
        return next;
      });
    }
    setEditingApi(null);
  };
  const cancelAll = () => {
    setDrafts({});
    setEditingApi(null);
    setSaveMsg(null);
    setSaveErr(null);
  };
  const doSave = async () => {
    if (!detail || !changed.length || saving) return;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const payload = {};
      for (const r of changed) payload[r.api] = coerceDetailValue(r, drafts[r.api]);
      await onSave(detail.obj, detail.id, payload);
      setDrafts({});
      setEditingApi(null);
      setSaveMsg(`Saved ${changed.length} field${changed.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  const renderEditor = (row) => {
    const val = drafts[row.api] !== undefined ? drafts[row.api] : detailDraftSeed(row);
    const set = (v) => setDrafts(prev => ({...prev, [row.api]: v}));
    const common = {
      className: "insp-edit-input",
      disabled: saving,
      onKeyDown: (e) => {
        if (e.key === "Escape") { e.stopPropagation(); closeEditor(true); }
        if (e.key === "Enter" && row.type !== "textarea" && !/longtext/i.test(String(row.type))) {
          e.preventDefault();
          setEditingApi(null);
        }
      },
      onClick: (e) => e.stopPropagation()
    };
    if (row.type === "boolean") {
      return h("input", {...common,
        type: "checkbox",
        checked: val === "true",
        onChange: (e) => set(e.target.checked ? "true" : "false")});
    }
    if (row.type === "picklist" && row.options && row.options.length) {
      const opts = (val === "" || row.options.includes(val)) ? row.options : [...row.options, val];
      return h("select", {...common, value: val, onChange: (e) => set(e.target.value)},
        h("option", {key: "", value: ""}, "(Blank)"),
        opts.map(o => h("option", {key: o, value: o}, o)));
    }
    if (row.type === "textarea" || /longtext/i.test(String(row.type))) {
      return h("textarea", {...common, rows: 2, value: val, onChange: (e) => set(e.target.value)});
    }
    if (row.type === "date") {
      return h("input", {...common, type: "date", value: String(val).slice(0, 10),
        onChange: (e) => set(e.target.value)});
    }
    if (row.type === "datetime") {
      return h("input", {...common, type: "datetime-local", value: String(val).slice(0, 16),
        onChange: (e) => set(e.target.value)});
    }
    if (["int", "double", "currency", "percent"].includes(row.type)) {
      return h("input", {...common, type: "number", value: val, onChange: (e) => set(e.target.value)});
    }
    return h("input", {...common, type: "text", value: val, onChange: (e) => set(e.target.value)});
  };
  const renderValue = (row) => {
    if (editingApi === row.api) return renderEditor(row);
    const hasDraft = drafts[row.api] !== undefined && draftDiffers(row, drafts[row.api]);
    const shown = hasDraft ? String(drafts[row.api]) : (row.value == null ? "(Blank)" : row.value);
    return h("span", null,
      shown,
      hasDraft && h("span", {className: "insp-dirty-dot", title: "Unsaved change"}, " *"));
  };
  return h("div", {
      className: "ff-modal-overlay",
      onMouseDown: (e) => { if (e.target === e.currentTarget) onBack(); }
    },
    h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
      h("div", {className: "ff-modal-head"},
        h("div", {className: "ff-modal-title"}, "Show all data",
          detail && h("span", {className: "ff-modal-sub"},
            rf ? ` - ${detail.obj} / ${detail.id} (${shownRows.length} of ${detail.rows.length} fields)`
               : ` - ${detail.obj} / ${detail.id} (${detail.rows.length} fields)`)),
        h("button", {className: "ff-modal-x", title: "Close (Esc)", onClick: onBack}, "\u00d7")
      ),
      h("div", {className: "insp-toolbar"},
      detail && ffIsSfId(detail.id) && h("button", {
        className: "btn btn-secondary btn-sm",
        title: "Open this record in Salesforce",
        onClick: (e) => openRecordInSf(detail.id, e)
        }, "Open in Salesforce ↗"),
      detail && h("span", {className: "insp-meta"},
        "Click an editable value to change it - Esc cancels the current edit"),
      h("div", {className: "soql-search"},
        h("svg", {
          className: "soql-search-ico",
          width: 14, height: 14, viewBox: "0 0 24 24",
          fill: "currentColor", "aria-hidden": "true"
        }, h("path", {
          d: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
        })),
        h("input", {
          className: "soql-search-input",
          value: rowFilter,
          placeholder: "search fields…",
          onChange: e => setRowFilter(e.target.value)
        })
      )
    ),
    loading && h("div", {className: "insp-meta"}, "Loading full record…"),
    detail && h("div", {className: "ff-modal-body"},
      h("div", {className: "insp-table-wrap"},
      h("table", {className: "insp-table"},
        h("thead", null,
          h("tr", null,
            h("th", null, "Field API Name"),
            h("th", null, "Label"),
            h("th", null, "Type"),
            h("th", null, "Value")
          )
        ),
        h("tbody", null,
          shownRows.map(r => {
            const isEditing = editingApi === r.api;
            const hasDraft = drafts[r.api] !== undefined && draftDiffers(r, drafts[r.api]);
            const canStart = r.editable && canEdit;
            return h("tr", {key: r.api},
              h("td", null, r.api),
              h("td", null, r.label),
              h("td", null, r.type),
              h("td", {
                className: [
                  (!hasDraft && r.value == null) ? "insp-blank" : "",
                  canStart ? "insp-cell-editable" : "",
                  hasDraft ? "insp-cell-dirty" : ""
                ].join(" "),
                title: canStart ? (isEditing ? "" : "Click to edit") : (r.value == null ? "" : r.value),
                onClick: canStart && !isEditing ? () => startEdit(r) : undefined
              }, renderValue(r))
            );
          })
        )
      )
    ),
    ),
    detail && rf && shownRows.length === 0 &&
      h("div", {className: "insp-empty"}, "No matching fields."),
    (changed.length > 0 || saveMsg || saveErr) && h("div", {className: "insp-edit-bar"},
      changed.length > 0 && h("span", {className: "insp-meta"},
        `${changed.length} field${changed.length === 1 ? "" : "s"} changed`),
      saveMsg && h("span", {className: "insp-save-ok"}, saveMsg),
      saveErr && h("span", {className: "insp-error"}, saveErr),
      h("span", {className: "insp-edit-actions"},
        changed.length > 0 && h("button", {
          className: "btn btn-danger btn-sm",
          disabled: saving,
          onClick: cancelAll
        }, "Cancel"),
        changed.length > 0 && h("button", {
          className: "btn btn-primary btn-sm",
          disabled: saving,
          onClick: doSave
        }, saving ? "Saving..." : "Save")
      ),
    ),
    ),
  );
}

function RecordsTab() {
  const [objects, setObjects] = React.useState([]);
  const [objLoading, setObjLoading] = React.useState(false);
  const [objInput, setObjInput] = ffUseSession("records", "objInput", "");
  const [fields, setFields] = ffUseSession("records", "fields", []);
  const [checked, setChecked] = ffUseSession("records", "checked", []);
  const [descLoading, setDescLoading] = React.useState(false);
  const [rows, setRows] = ffUseSession("records", "rows", []);
  const [columns, setColumns] = ffUseSession("records", "columns", []);
  const [totalSize, setTotalSize] = ffUseSession("records", "totalSize", null);
  const [nextUrl, setNextUrl] = ffUseSession("records", "nextUrl", null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [detail, setDetail] = ffUseSession("records", "detail", null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [openRec, setOpenRec] = React.useState(null);
  const [pageLoading, setPageLoading] = React.useState(false);

  React.useEffect(() => {
    const onMsg = (e) => {
      if (e.data && e.data.type === "sfoc-open-record") setOpenRec(e.data.rec || null);
    };
    window.addEventListener("message", onMsg);
    try { window.parent.postMessage({type: "sfoc-query-open-record"}, "*"); } catch (err) { /* standalone */ }
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // "Show All Data" for the current page record: describe + full record,
  // painted through the same detail panel (search + save included).
  // The open record is re-queried on EVERY click — Lightning SPA navigation
  // doesn't remount the tab, so a mount-time snapshot would go stale when
  // the user moves from one record to another.
  const queryOpenRec = () => new Promise((resolve) => {
    let done = false;
    const onMsg = (e) => {
      if (e.data && e.data.type === "sfoc-open-record") {
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(e.data.rec || null);
      }
    };
    window.addEventListener("message", onMsg);
    try {
      window.parent.postMessage({type: "sfoc-query-open-record"}, "*");
    } catch (err) {
      window.removeEventListener("message", onMsg);
      resolve(null);
    }
    setTimeout(() => {
      if (!done) {
        window.removeEventListener("message", onMsg);
        resolve(null);
      }
    }, 1500);
  });

  const openPageRecord = async () => {
    setPageLoading(true);
    setError(null);
    try {
      const fresh = await queryOpenRec();
      const rec = fresh && fresh.obj && fresh.id ? fresh : openRec;
      setOpenRec(rec);
      if (!rec || !rec.obj || !rec.id) return;
      const d = await ffDescribeObject(rec.obj);
      const full = await fetchFullRecord(rec.obj, rec.id);
      setDetail({id: rec.id, obj: rec.obj, rows: buildDetailRows(full, d.fields || [])});
    } catch (e) {
      setError(e.message);
    } finally {
      setPageLoading(false);
    }
  };
  const loadObjects = async () => {
    setObjLoading(true);
    setError(null);
    try {
      setObjects(await recordsListObjects());
    } catch (e) {
      setError(e.message);
    } finally {
      setObjLoading(false);
    }
  };

  React.useEffect(() => { loadObjects(); }, []);

  const pickDefaultFields = (fieldList) => {
    const names = new Set(fieldList.map(f => f.name));
    const preferred = ["Id", "Name", "Subject", "Title", "CaseNumber",
      "DeveloperName", "MasterLabel", "LastName", "FirstName"];
    const picks = preferred.filter(n => names.has(n));
    for (const f of fieldList) {
      if (picks.length >= 6) break;
      if (!picks.includes(f.name) &&
          ["string", "textarea", "email", "phone", "url", "date", "datetime",
           "currency", "double", "int", "boolean", "picklist", "reference"].includes(f.type)) {
        picks.push(f.name);
      }
    }
    return picks.length ? picks : fieldList.slice(0, 6).map(f => f.name);
  };

  const describe = async (objName) => {
    const obj = String(objName || objInput || "").trim();
    if (!obj) { setError("Pick or type an object API name"); return; }
    setObjInput(obj);
    setDescLoading(true);
    setError(null);
    try {
      const d = await sfConn.rest(
        `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/describe`,
        {useCache: false});
      const fieldList = (d.fields || []).map(f => ({
        name: f.name, label: f.label, type: f.type,
        updateable: f.updateable, nillable: f.nillable,
        picklistValues: (f.picklistValues || []).filter(p => p.active).map(p => String(p.value))
      }));
      setFields(fieldList);
      setChecked(pickDefaultFields(fieldList));
      setRows([]);
      setColumns([]);
      setTotalSize(null);
      setNextUrl(null);
    } catch (e) {
      setError(e.message);
      setFields([]);
      setChecked([]);
    } finally {
      setDescLoading(false);
    }
  };

  const toggleField = (name) => {
    setChecked(prev => prev.includes(name)
      ? prev.filter(n => n !== name)
      : [...prev, name]);
  };

  const mergeRows = (flat) => {
    setRows(prev => [...prev, ...flat]);
    setColumns(prev => {
      const set = new Set(prev);
      flat.forEach(r => Object.keys(r).forEach(k => set.add(k)));
      return [...set];
    });
  };

  const runQuery = async () => {
    setError(null);
    const obj = objInput.trim();
    if (!obj) { setError("Pick or type an object API name"); return; }
    if (!checked.length) { setError("Tick at least one field"); return; }
    setLoading(true);
    setRows([]);
    setColumns([]);
    setTotalSize(null);
    setNextUrl(null);
    try {
      const q = `SELECT ${checked.join(", ")} FROM ${obj} LIMIT 200`;
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(q), {useCache: false});
      mergeRows((res.records || []).map(flattenRecord));
      setTotalSize(typeof res.totalSize === "number" ? res.totalSize : null);
      setNextUrl(res.done === false && res.nextRecordsUrl ? res.nextRecordsUrl : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextUrl) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await sfConn.rest(nextUrl, {useCache: false});
      mergeRows((res.records || []).map(flattenRecord));
      if (typeof res.totalSize === "number") setTotalSize(res.totalSize);
      setNextUrl(res.done === false && res.nextRecordsUrl ? res.nextRecordsUrl : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const download = () => {
    if (!rows.length) return;
    downloadText(`${objInput.trim() || "records"}.csv`, toCsv(columns, rows));
  };

  // "Show all data": fetch the FULL record and shape it via the shared helper.
  const openDetail = async (row) => {
    const obj = objInput.trim();
    const id = row && (row.Id || row.id);
    if (!obj || !id) return;
    setDetailLoading(true);
    setError(null);
    try {
      const rec = await fetchFullRecord(obj, id);
      setDetail({id, obj, rows: buildDetailRows(rec, fields)});
    } catch (e) {
      setError(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  // PATCH changed fields, then paint them immediately: the server accepted
  // the payload, so there is no need to wait for another round trip (and no
  // stale-value flash while a re-fetch is in flight).
  const saveDetailChanges = async (obj, id, changes) => {
    await sfConn.rest(
      `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`,
      {method: "PATCH", body: changes});
    setDetail(prev => {
      if (!prev || prev.id !== id) return prev;
      return {
        ...prev,
        rows: prev.rows.map(r => Object.prototype.hasOwnProperty.call(changes, r.api)
          ? {...r, value: changes[r.api] == null ? null : String(changes[r.api])}
          : r)
      };
    });
  };

  return h("div", {className: "insp-panel"},
    window.parent !== window && h("div", {className: "records-page-rec"},
      h("button", {
        className: "records-showall-btn",
        disabled: !openRec || !openRec.obj || pageLoading,
        title: openRec && openRec.obj
          ? `Show all data for this page's ${openRec.obj} record`
          : "Open a Salesforce record page, then reopen this tab",
        onClick: openPageRecord
      },
        h("svg", {
          className: "records-showall-ico",
          width: 15, height: 15, viewBox: "0 0 24 24",
          fill: "none", stroke: "currentColor", strokeWidth: 2.2,
          "aria-hidden": "true"
        },
          h("rect", {x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5}),
          h("rect", {x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5}),
          h("rect", {x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5}),
          h("rect", {x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.5})),
        h("span", null, pageLoading ? "Loading…" : "Show All Data")),
      h("div", {className: "insp-meta"},
        openRec && openRec.obj
          ? `Current page: ${openRec.obj} · ${String(openRec.id).slice(0, 6)}…`
          : "No record page detected")
    ),
    h("p", {className: "app-section-hint"},
      "Pick an object to see all of its records. Tick fields, run, then Load more to page through everything."
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Object"),
        h("input", {
          value: objInput,
          list: "insp-records-objects",
          placeholder: "Account / IT_Asset__c — type to filter",
          disabled: loading || descLoading,
          onChange: e => setObjInput(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") describe(); }
        }),
        h("datalist", {id: "insp-records-objects"},
          objects.map(o =>
            h("option", {key: o.name, value: o.name}, `${o.label}${o.custom ? " (custom)" : ""}`)
          )
        )
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: objLoading || descLoading || loading,
        onClick: loadObjects
      }, objLoading ? "Loading…" : `Objects (${objects.length || "—"})`),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: descLoading || loading || !objInput.trim(),
        onClick: () => describe()
      }, descLoading ? "Describing…" : "Describe")
    ),
    fields.length > 0 && h("div", {className: "insp-map"},
      h("div", {className: "insp-map-title"},
        `Fields (${checked.length}/${fields.length}) — `,
        h("button", {
          className: "field-action-btn",
          onClick: () => setChecked(fields.map(f => f.name))
        }, "All"),
        " ",
        h("button", {
          className: "field-action-btn",
          onClick: () => setChecked([])
        }, "None")
      ),
      h("div", {className: "insp-field-checks"},
        fields.map(f =>
          h("label", {key: f.name, className: "insp-check", title: `${f.label} · ${f.type}`},
            h("input", {
              type: "checkbox",
              checked: checked.includes(f.name),
              onChange: () => toggleField(f.name)
            }),
            h("span", null, f.name)
          )
        )
      )
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: loading || !objInput.trim() || !checked.length,
        onClick: runQuery
      }, loading ? "Querying…" : "Show all records"),
      rows.length > 0 && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: download
      }, "Export CSV"),
      nextUrl && h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: loadingMore,
        onClick: loadMore
      }, loadingMore ? "Loading…" : `Load more (${rows.length}${totalSize != null ? `/${totalSize}` : ""})`)
    ),
    error && h("div", {className: "insp-error"}, error),
    totalSize != null && h("div", {className: "insp-meta"},
      `${objInput.trim()}: ${totalSize} record(s) total · showing ${rows.length}` +
      (nextUrl ? " · more available" : " · all loaded") +
      " · click a row for Show all data"
    ),
    rows.length > 0 && h(ResultTable, {
      columns, rows, maxRows: 500,
      onRowClick: (row) => openDetail(row)
    }),
    (detailLoading || detail) && h(RecordDetailPanel, {
      detail,
      loading: detailLoading,
      onBack: () => setDetail(null),
      onSave: saveDetailChanges
    }),
    // Detail markup consolidated into RecordDetailPanel (see Shared section).
  );
}

// ─── App Tabs: standalone "Add Tab to App" ────────────────────
// Independent of the builder deploy flow. Uses the Tooling API as the
// source of truth for the app fullName (DeveloperName) so a display
// label like "Shivam" can never resolve to the wrong app. Update is a
// full read-modify-write round-trip (partial CustomApplication writes
// would wipe fields); verify is a strict re-read loop, never a guess.
function appTabsIsSfId(v) {
  const s = String(v || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(s) || /^[a-zA-Z0-9]{18}$/.test(s);
}

function appTabsEscXml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function appTabsDomLocal(el) {
  if (!el) return "";
  return el.localName || String(el.tagName || "").split(":").pop();
}

function appTabsDomChildren(el) {
  if (!el || !el.childNodes) return [];
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}

function appTabsDomFind(root, local) {
  if (!root) return null;
  if (appTabsDomLocal(root) === local) return root;
  const stack = appTabsDomChildren(root);
  while (stack.length) {
    const el = stack.shift();
    if (appTabsDomLocal(el) === local) return el;
    stack.unshift(...appTabsDomChildren(el));
  }
  return null;
}

function appTabsDomFindAll(root, local, out) {
  out = out || [];
  if (!root) return out;
  if (appTabsDomLocal(root) === local) out.push(root);
  for (const c of appTabsDomChildren(root)) appTabsDomFindAll(c, local, out);
  return out;
}

function appTabsDomToMetXml(el) {
  const tag = appTabsDomLocal(el);
  let attrs = "";
  if (el.attributes) {
    for (const a of Array.from(el.attributes)) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      attrs += ` ${a.name}="${appTabsEscXml(a.value)}"`;
    }
  }
  const kids = appTabsDomChildren(el);
  let text = "";
  for (const n of Array.from(el.childNodes || [])) {
    if (n.nodeType === 3 || n.nodeType === 4) text += n.data;
  }
  if (kids.length > 0) {
    if (text.trim() === "") text = "";
    else text = appTabsEscXml(text);
    return `<met:${tag}${attrs}>${text}${kids.map(appTabsDomToMetXml).join("")}</met:${tag}>`;
  }
  if (text === "") return `<met:${tag}${attrs}/>`;
  return `<met:${tag}${attrs}>${appTabsEscXml(text)}</met:${tag}>`;
}

// Children that must follow <tabs> in CustomApplication XSD sequence.
const APP_TABS_AFTER = new Set([
  "uiType", "workspace", "actionOverrides", "profileActionOverrides",
  "objectTabs", "listViews", "navType", "formFactors", "brand", "brandColor",
  "customTab", "logo", "palette", "platform", "urlTarget", "type",
  "showInAppLauncher", "showInMobileSearch", "showLightningRuntime",
  "ssoAttemptLogin", "headerColor", "dataServiceUrl", "scriptLocs",
  "oAuthCustomScope", "platformActionOverrides", "microsite"
]);

let _appTabsDebug = null;
function appTabsNote(action, requestXml, responseText) {
  try {
    _appTabsDebug = {
      action,
      request: String(requestXml || "").slice(-4000),
      response: String(responseText || "").slice(0, 4000)
    };
  } catch (e) { /* ignore */ }
}

async function appTabsSoapPost(bodyInnerXml, timeoutMs) {
  const url = "https://" + sfConn.instanceHostname + "/services/Soap/m/" + apiVersion;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <met:SessionHeader>
      <met:sessionId>${sfConn.sessionId}</met:sessionId>
    </met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    ${bodyInnerXml}
  </soapenv:Body>
</soapenv:Envelope>`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "text/xml", "SOAPAction": '""'},
      body: envelope,
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    appTabsNote("soap", bodyInnerXml, "FETCH FAILED: " + (e.message || e));
    throw new Error(e.name === "AbortError" ? "Request timed out after 60s" : "Network error: " + e.message);
  }
  clearTimeout(timer);
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    appTabsNote("soap", bodyInnerXml, text);
    throw new Error("Failed to parse Metadata API response XML");
  }
  const fault = appTabsDomFind(doc.documentElement, "Fault");
  if (fault) {
    const fs = appTabsDomFind(fault, "faultstring");
    appTabsNote("soap", bodyInnerXml, text);
    throw new Error(fs ? fs.textContent : "Metadata API SOAP fault");
  }
  return {doc, text};
}

async function appTabsReadRecords(fullName) {
  const body = `<met:readMetadata><met:type>CustomApplication</met:type>` +
    `<met:fullNames>${appTabsEscXml(fullName)}</met:fullNames></met:readMetadata>`;
  const {doc} = await appTabsSoapPost(body);
  return appTabsDomFind(doc.documentElement, "records") || null;
}

async function appTabsListMetadataFullNames(type) {
  const body = `<met:listMetadata><met:queries><met:type>${appTabsEscXml(type)}</met:type></met:queries></met:listMetadata>`;
  const {doc} = await appTabsSoapPost(body);
  const names = [];
  for (const fp of appTabsDomFindAll(doc.documentElement, "fileProperties")) {
    const fn = appTabsDomFind(fp, "fullName");
    if (fn && fn.textContent) names.push(fn.textContent);
  }
  if (!names.length) {
    for (const fn of appTabsDomFindAll(doc.documentElement, "fullName")) {
      if (fn.textContent) names.push(fn.textContent);
    }
  }
  return names;
}

async function appTabsUpdateMetadataRaw(xml) {
  const body = `<met:updateMetadata>${xml}</met:updateMetadata>`;
  const {doc, text} = await appTabsSoapPost(body);
  appTabsNote("updateMetadata", xml, text);
  const resultEl = doc.querySelector("result");
  if (resultEl) {
    const successEl = resultEl.querySelector("success");
    const errorsEl = resultEl.querySelector("errors");
    const success = successEl ? successEl.textContent : "true";
    if (success === "false" && errorsEl) {
      const msgEl = errorsEl.querySelector("message");
      throw new Error(msgEl ? msgEl.textContent : "Metadata API returned error");
    }
    return;
  }
  const faultEl = doc.querySelector("faultstring");
  if (faultEl) throw new Error(faultEl.textContent);
  throw new Error("Could not parse updateMetadata response: " + text.substring(0, 300));
}

async function appTabsUpdateRecords(fullName, recordsEl) {
  if (appTabsIsSfId(fullName)) {
    throw new Error(`Refusing updateMetadata: "${fullName}" is a Salesforce Id, not a metadata name`);
  }
  const parts = [];
  for (const child of appTabsDomChildren(recordsEl)) {
    if (appTabsDomLocal(child) === "fullName") continue;
    parts.push(appTabsDomToMetXml(child));
  }
  const xml = `<met:metadata xsi:type="met:CustomApplication">` +
    `<met:fullName>${appTabsEscXml(fullName)}</met:fullName>${parts.join("")}</met:metadata>`;
  return appTabsUpdateMetadataRaw(xml);
}

const appTabsDelay = ms => new Promise(r => setTimeout(r, ms));

async function appTabsResolveCurrentUserId() {
  const urls = [
    "https://" + sfConn.instanceHostname + "/services/oauth2/userinfo",
    "https://" + sfConn.instanceHostname + "/id"
  ];
  let lastStatus = 0;
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {"Authorization": "Bearer " + sfConn.sessionId}
      });
      lastStatus = res.status;
      if (!res.ok) continue;
      const data = await res.json();
      const uid = data?.user_id || data?.userId || (data?.sub ? String(data.sub).split("/").pop() : null);
      if (uid) return uid;
    } catch (e) {
      console.warn("[SaralForce] AppTabs identity lookup failed for", u, e.message);
    }
  }
  throw new Error("Could not get user identity (tried userinfo and /id, last status " + lastStatus + ")");
}

function appTabsNormName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Set tabVisibilities DefaultOn for the running user's profile so the tab
// shows in App Launcher search. Returns the profile fullName written.
async function appTabsEnsureTabVisibleForMe(tabApiName) {
  const userId = await appTabsResolveCurrentUserId();
  const ures = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(`SELECT ProfileId FROM User WHERE Id = '${userId}'`), {useCache: false});
  const pid = ures?.records?.[0]?.ProfileId;
  if (!pid) throw new Error("Could not determine your profile (User.ProfileId missing)");
  const pres = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${pid}'`), {useCache: false});
  const label = pres?.records?.[0]?.Name;
  if (!label) throw new Error("Could not determine your profile name");
  // Label → metadata fullName ("System Administrator" → "Admin").
  let fullName = label;
  try {
    const names = await appTabsListMetadataFullNames("Profile");
    const targets = [appTabsNormName(label)];
    if (targets.includes("systemadministrator")) targets.push("admin");
    fullName = names.find(n => targets.includes(appTabsNormName(n))) ||
      names.find(n => {
        const nn = appTabsNormName(n);
        return nn && targets.some(t => nn.startsWith(t) || t.startsWith(nn));
      }) || label;
  } catch (e) {
    console.warn("[SaralForce] AppTabs profile listMetadata failed:", e.message);
  }
  const xml = `<met:metadata xsi:type="met:Profile">` +
    `<met:fullName>${appTabsEscXml(fullName)}</met:fullName>` +
    `<met:tabVisibilities><met:tab>${appTabsEscXml(tabApiName)}</met:tab>` +
    `<met:visibility>DefaultOn</met:visibility></met:tabVisibilities></met:metadata>`;
  await appTabsUpdateMetadataRaw(xml);
  await appTabsDelay(1200);
  return fullName;
}

async function appTabsTabExists(tabApiName) {
  const want = String(tabApiName || "").trim().toLowerCase();
  if (!want) return false;
  try {
    const names = await appTabsListMetadataFullNames("CustomTab");
    if (names.some(n => String(n).trim().toLowerCase() === want)) return true;
  } catch (e) {
    console.warn("[SaralForce] AppTabs tab-exists listMetadata failed:", e.message);
  }
  try {
    const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
      encodeURIComponent(
        `SELECT DeveloperName FROM CustomTab WHERE DeveloperName = '${String(tabApiName).trim().replace(/'/g, "\\'")}' LIMIT 1`),
      {useCache: false});
    if (res.records && res.records.length) return true;
  } catch (e) {
    console.warn("[SaralForce] AppTabs tab-exists Tooling failed:", e.message);
  }
  return false;
}

function appTabsOfRecords(recordsEl) {
  const tabs = [];
  if (!recordsEl) return tabs;
  for (const child of appTabsDomChildren(recordsEl)) {
    if (appTabsDomLocal(child) === "tabs" && child.textContent) {
      tabs.push(child.textContent.trim());
    }
  }
  return tabs;
}

async function appTabsLoadApps() {
  const apps = [];
  const seen = new Set();
  const push = (fullName, label) => {
    const fn = String(fullName || "").trim();
    if (!fn || appTabsIsSfId(fn)) return;
    const key = fn.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    apps.push({fullName: fn, label: String(label || fn).trim() || fn});
  };
  const queries = [
    "SELECT Id, DeveloperName, Name FROM CustomApplication ORDER BY Name",
    "SELECT Id, DeveloperName, MasterLabel FROM CustomApplication ORDER BY MasterLabel",
    "SELECT Id, DeveloperName FROM CustomApplication ORDER BY DeveloperName"
  ];
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const rows = res.records || [];
      if (!rows.length) continue;
      for (const a of rows) {
        push(a.DeveloperName, a.Name || a.MasterLabel || a.DeveloperName);
      }
      if (apps.length) break;
    } catch (e) {
      console.warn("[SaralForce] AppTabs Tooling query failed:", e.message);
    }
  }
  // Reconcile with listMetadata truth: standard apps (ServiceConsole, Sales…)
  // have metadata fullNames like standard__ServiceConsole while Tooling
  // returns the bare DeveloperName — updating the bare name fails with
  // "no CustomApplication named X found".
  try {
    const names = await appTabsListMetadataFullNames("CustomApplication");
    const nameSet = new Set(names.map(n => String(n).toLowerCase()));
    for (const a of apps) {
      if (!nameSet.has(a.fullName.toLowerCase())) {
        const prefixed = "standard__" + a.fullName;
        if (nameSet.has(prefixed.toLowerCase())) {
          console.log(`[SaralForce] AppTabs standard prefix: ${a.fullName} → ${prefixed}`);
          seen.delete(a.fullName.toLowerCase());
          a.fullName = prefixed;
          seen.add(prefixed.toLowerCase());
        }
      }
    }
    for (const n of names) {
      push(n, n);
    }
  } catch (e) {
    console.warn("[SaralForce] AppTabs listMetadata reconcile failed:", e.message);
  }
  apps.sort((a, b) => a.label.localeCompare(b.label));
  if (!apps.length) throw new Error("No apps found (Tooling + listMetadata both empty)");
  return apps;
}

async function appTabsLoadCustomTabs() {  const tabs = [];
  const seen = new Set();
  const push = (apiName, label) => {
    const n = String(apiName || "").trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tabs.push({apiName: n, label: String(label || n).trim() || n});
  };
  const queries = [
    "SELECT Id, DeveloperName, MasterLabel FROM CustomTab ORDER BY MasterLabel",
    "SELECT Id, DeveloperName, Name FROM CustomTab ORDER BY Name"
  ];
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const rows = res.records || [];
      if (!rows.length) continue;
      for (const t of rows) {
        push(t.DeveloperName, t.MasterLabel || t.Name || t.DeveloperName);
      }
      if (tabs.length) break;
    } catch (e) {
      console.warn("[SaralForce] AppTabs CustomTab query failed:", e.message);
    }
  }
  try {
    const names = await appTabsListMetadataFullNames("CustomTab");
    for (const n of names) push(n, n);
  } catch (e) {
    console.warn("[SaralForce] AppTabs listMetadata CustomTab failed:", e.message);
  }
  tabs.sort((a, b) => a.label.localeCompare(b.label));
  return tabs;
}

// Resolve the EXACT app from pasted text: an App Manager URL, a setup page
// URL, or a bare record Id. CustomApplication Ids start with 02u. Returns
// {id, fullName, label} — the metadata DeveloperName, never a guess from
// a duplicated display label.
async function appTabsResolveAppByRecordId(pasted) {
  const text = String(pasted || "");
  const m = text.match(/02u[a-zA-Z0-9]{12,15}/);
  if (!m) {
    throw new Error(
      "No app record Id found in that text. Open App Manager → click the dropdown next to the app → the page URL contains its Id (starts with 02u) — paste the full URL here.");
  }
  const id = m[0];
  const queries = [
    `SELECT Id, DeveloperName, Name FROM CustomApplication WHERE Id = '${id}'`,
    `SELECT Id, DeveloperName, MasterLabel FROM CustomApplication WHERE Id = '${id}'`
  ];
  let lastErr = null;
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const row = res.records && res.records[0];
      if (row && row.DeveloperName) {
        return {
          id,
          fullName: row.DeveloperName,
          label: row.Name || row.MasterLabel || row.DeveloperName
        };
      }
      lastErr = new Error(`Id ${id} is not a CustomApplication record`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Could not resolve app Id ${id}`);
}

function AppTabsTab() {
  const [apps, setApps] = ffUseSession("apptabs", "apps", []);
  const [appsLoading, setAppsLoading] = React.useState(false);
  const [sel, setSel] = ffUseSession("apptabs", "sel", "");
  const [customTabs, setCustomTabs] = ffUseSession("apptabs", "customTabs", []);
  const [tabsLoading, setTabsLoading] = React.useState(false);
  const [tabName, setTabName] = ffUseSession("apptabs", "tabName", "");
  const [currentTabs, setCurrentTabs] = ffUseSession("apptabs", "currentTabs", null);
  const [currentLoading, setCurrentLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [visWorking, setVisWorking] = React.useState(false);
  const [resolving, setResolving] = React.useState(false);
  const [appRef, setAppRef] = ffUseSession("apptabs", "appRef", "");
  const [refMsg, setRefMsg] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [debug, setDebug] = React.useState("");

  const loadAll = async () => {
    setAppsLoading(true);
    setTabsLoading(true);
    setError(null);
    try {
      const [a, t] = await Promise.all([appTabsLoadApps(), appTabsLoadCustomTabs()]);
      setApps(a);
      setCustomTabs(t);
      if (!sel && a.length) setSel(a[0].fullName);
    } catch (e) {
      setError(e.message);
    } finally {
      setAppsLoading(false);
      setTabsLoading(false);
    }
  };

  React.useEffect(() => { loadAll(); }, []);

  const refreshCurrent = async (fullName) => {
    const fn = fullName || sel;
    if (!fn) return;
    setCurrentLoading(true);
    setError(null);
    try {
      const rec = await appTabsReadRecords(fn);
      if (!rec) throw new Error(`Could not read CustomApplication metadata for "${fn}"`);
      setCurrentTabs(appTabsOfRecords(rec));
    } catch (e) {
      setError(e.message);
      setCurrentTabs(null);
    } finally {
      setCurrentLoading(false);
    }
  };

  React.useEffect(() => {
    if (sel) refreshCurrent(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // Pinpoint the exact app via its record Id (from the App Manager URL).
  // Display labels are NOT unique — two apps can both be called
  // "Service Console" while only one is the app you actually open.
  const resolveFromRef = async () => {
    setRefMsg(null);
    setError(null);
    if (!appRef.trim()) {
      setRefMsg({ok: false, text: "Paste the App Manager URL or app record Id first."});
      return;
    }
    setResolving(true);
    try {
      const hit = await appTabsResolveAppByRecordId(appRef);
      setApps(prev => {
        if (prev.some(a => a.fullName.toLowerCase() === hit.fullName.toLowerCase())) {
          return prev.map(a => a.fullName.toLowerCase() === hit.fullName.toLowerCase()
            ? {...a, label: hit.label}
            : a);
        }
        return [...prev, {fullName: hit.fullName, label: hit.label}]
          .sort((a, b) => a.label.localeCompare(b.label));
      });
      setSel(hit.fullName);
      setRefMsg({ok: true, text: `Pinned to "${hit.label}" (${hit.fullName}) — this is now the exact app that will be updated.`});
    } catch (e) {
      setRefMsg({ok: false, text: e.message});
    } finally {
      setResolving(false);
    }
  };

  const addTab = async () => {
    setError(null);
    setStatus(null);
    setDebug("");
    const fullName = String(sel || "").trim();
    let tab = String(tabName || "").trim();
    if (!fullName) { setError("Select an app first"); return; }
    if (!tab) { setError("Enter a tab API name (e.g. IT_Asset__c) or pick one from the list"); return; }
    // Custom object tabs carry the __c suffix; never accept an Id.
    if (appTabsIsSfId(tab)) { setError(`"${tab}" looks like a Salesforce Id — enter the tab API name instead`); return; }
    setWorking(true);
    try {
      // Never add a tab that doesn't exist — it writes a dead entry and the
      // app still shows nothing. Metadata can lag right after deploy.
      const exists = await appTabsTabExists(tab);
      if (!exists) {
        throw new Error(
          `Tab "${tab}" was not found in this org (checked CustomTab metadata + Tooling). ` +
          `If you just deployed it, wait a minute and press Reload, then try again. ` +
          `Otherwise check Setup → Tabs for the exact API name.`);
      }
      const tried = [fullName];
      let records = await appTabsReadRecords(fullName);
      if (!records) {
        throw new Error(
          `Could not read CustomApplication metadata for "${fullName}". ` +
          `Open Setup → App Manager → edit the app and confirm its Developer Name.`);
      }
      // Trust the fullName inside the returned records (never an Id).
      const fnEl = appTabsDomFind(records, "fullName");
      const realName = fnEl && fnEl.textContent && !appTabsIsSfId(fnEl.textContent)
        ? fnEl.textContent.trim()
        : fullName;
      let existing = appTabsOfRecords(records);
      console.log(`[SaralForce] AppTabs read "${realName}": tabs=[${existing.join(", ")}]`);
      if (existing.includes(tab)) {
        setStatus(`"${tab}" is already on "${realName}" — nothing to do. If you still don't see it, switch apps once to refresh the nav bar.`);
        setCurrentTabs(existing);
        return;
      }
      const desired = existing.length ? [...existing, tab] : ["standard-home", tab];
      const doc = records.ownerDocument;
      let insertParent = null;
      let insertRef = null;
      let lastTabsEl = null;
      for (const child of appTabsDomChildren(records)) {
        if (appTabsDomLocal(child) === "tabs") lastTabsEl = child;
      }
      if (lastTabsEl && lastTabsEl.parentNode) {
        insertParent = lastTabsEl.parentNode;
        insertRef = lastTabsEl.nextSibling;
      } else {
        insertParent = records;
        insertRef = null;
        for (const child of appTabsDomChildren(records)) {
          const ln = appTabsDomLocal(child);
          if (ln === "tabs" || ln === "fullName") continue;
          if (APP_TABS_AFTER.has(ln)) {
            insertRef = child;
            break;
          }
        }
      }
      for (const child of [...appTabsDomChildren(records)]) {
        if (appTabsDomLocal(child) === "tabs") child.remove();
      }
      const tabEls = desired.map(t => {
        const el = doc.createElement("tabs");
        el.textContent = t;
        return el;
      });
      if (insertParent) {
        // Advance past the just-inserted node, otherwise each insert lands
        // BEFORE the previous one and the whole nav order gets reversed.
        let cursor = insertRef;
        for (const el of tabEls) {
          insertParent.insertBefore(el, cursor);
          cursor = el.nextSibling;
        }
      } else {
        for (const el of tabEls) records.appendChild(el);
      }
      // Console apps (Service Console…) reject any tab without a workspace
      // mapping: "The X tab doesn't include a workspace mapping." Ensure
      // every desired tab has one before writing.
      {
        let ws = appTabsDomFind(records, "workspaceConfig");
        const navTypeEl = appTabsDomFind(records, "navType");
        const isConsole = !!ws ||
          (navTypeEl && /console/i.test(navTypeEl.textContent || ""));
        if (isConsole) {
          if (!ws) {
            // workspaceConfig sits last in CustomApplication XSD order.
            ws = doc.createElement("workspaceConfig");
            records.appendChild(ws);
          }
          const mapped = new Set();
          for (const m of appTabsDomChildren(ws)) {
            if (appTabsDomLocal(m) !== "mappings") continue;
            const t = appTabsDomFind(m, "tab");
            if (t && t.textContent) mapped.add(t.textContent.trim());
          }
          for (const t of desired) {
            if (mapped.has(t)) continue;
            const mapping = doc.createElement("mappings");
            const tabEl = doc.createElement("tab");
            tabEl.textContent = t;
            mapping.appendChild(tabEl);
            ws.appendChild(mapping);
            mapped.add(t);
          }
          console.log(`[SaralForce] AppTabs workspace mappings ensured for console app (${mapped.size} mapped)`);
        }
      }
      // Standard apps must be written as standard__Name — retry with the
      // prefix when Salesforce says the bare DeveloperName doesn't exist.
      let writeName = realName;
      try {
        await appTabsUpdateRecords(writeName, records);
      } catch (ue) {
        if (/no CustomApplication named/i.test(ue.message || "") &&
            !/^standard__/i.test(writeName)) {
          writeName = "standard__" + writeName;
          console.log(`[SaralForce] AppTabs retrying update as "${writeName}"`);
          await appTabsUpdateRecords(writeName, records);
        } else {
          throw ue;
        }
      }
      // Strict verify: re-read until the tab shows up (metadata can lag).
      // Always verify against the name that was actually written.
      let postTabs = [];
      let ok = false;
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const verify = await appTabsReadRecords(writeName);
        postTabs = appTabsOfRecords(verify);
        console.log(`[SaralForce] AppTabs verify "${writeName}" attempt ${i + 1}: tabs=[${postTabs.join(", ")}]`);
        if (postTabs.includes(tab)) { ok = true; break; }
      }
      setCurrentTabs(postTabs);
      if (sel !== writeName) setSel(writeName);
      if (!ok) {
        throw new Error(
          `Update reported success but "${tab}" is missing from "${writeName}" after 4 re-reads ` +
          `(tried: ${tried.join(", ")}; tabs now: ${postTabs.join(", ") || "none"}). ` +
          `Most likely causes: (1) this is not the Developer Name of the app you open — check Setup → App Manager; ` +
          `(2) the app uses an App Page / managed navigation instead of CustomApplication tabs. ` +
          `Use Copy debug below and compare with App Manager → Navigation Items.`);
      }
      // Search visibility: App Launcher search only lists tabs your profile
      // can see. Set DefaultOn automatically so "assigned but not showing"
      // doesn't happen; the button below remains for manual retry.
      let visNote = "";
      try {
        const profileFn = await appTabsEnsureTabVisibleForMe(tab);
        visNote = ` Visibility DefaultOn set for your profile (${profileFn}).`;
      } catch (ve) {
        visNote = ` Could not set visibility automatically (${ve.message}) — use "Make visible for me".`;
      }
      setStatus(`"${tab}" is now on "${writeName}" (verified by re-read).${visNote} If the nav bar still doesn't show it, switch to another app and back, or hard-refresh Lightning.`);
    } catch (e) {
      setError(e.message);
      if (_appTabsDebug) {
        setDebug(
          `SOAP action: ${_appTabsDebug.action}\n--- request (tail) ---\n${_appTabsDebug.request}\n--- response (head) ---\n${_appTabsDebug.response}`);
      }
    } finally {
      setWorking(false);
    }
  };

  // App Launcher search only lists tabs your profile can see (DefaultOn).
  // This sets it without a redeploy and without touching Setup.
  const makeVisible = async () => {
    setError(null);
    setStatus(null);
    const tab = String(tabName || "").trim();
    if (!tab) { setError("Enter a tab API name first"); return; }
    if (appTabsIsSfId(tab)) { setError(`"${tab}" looks like a Salesforce Id — enter the tab API name instead`); return; }
    setVisWorking(true);
    try {
      const exists = await appTabsTabExists(tab);
      if (!exists) {
        throw new Error(
          `Tab "${tab}" was not found in this org. If you just deployed it, wait a minute and retry.`);
      }
      const profileFn = await appTabsEnsureTabVisibleForMe(tab);
      setStatus(`Tab "${tab}" set to DefaultOn for your profile (${profileFn}). Open App Launcher search in ~30s — if it still doesn't appear, hard-refresh Lightning.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setVisWorking(false);
    }
  };

  const copyDebug = async () => {    const selApp = apps.find(a => a.fullName === sel);
    const text =
      `App label: ${selApp ? selApp.label : ""}\n` +
      `App fullName (DeveloperName): ${sel}\n` +
      `Tab: ${tabName}\n` +
      `Current tabs: ${(currentTabs || []).join(", ") || "unknown"}\n\n${debug}`;
    try {
      await safeCopyText(text);
    } catch (e) { /* ignore */ }
  };

  const selApp = apps.find(a => a.fullName === sel);
  const selLabel = (selApp || {}).label || sel;
  const dupes = selApp ? apps.filter(a => a.label === selApp.label) : [];

  return h("div", {className: "insp-panel"},
    h("p", {className: "insp-hint-strip"},
      "Standalone tool — no deploy needed. Pick the app by its metadata Developer Name (from Tooling, not the display label), pick or type the tab API name, then add. Every write is verified by re-reading the app metadata."
    ),
    h("div", {className: "insp-card-header"},
      h("div", {className: "insp-card-title"}, "1 · Choose app"),
      h("div", {className: "insp-card-actions"},
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: appsLoading || tabsLoading || working,
          onClick: loadAll
        }, (appsLoading || tabsLoading) ? "Loading…" : "Reload apps + tabs")
      )
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "App (DeveloperName)"),
        h("select", {
          value: sel,
          disabled: appsLoading || working,
          onChange: e => { setSel(e.target.value); setStatus(null); setError(null); setRefMsg(null); }
        },
          apps.map(a =>
            h("option", {key: a.fullName, value: a.fullName},
              `${a.label} (${a.fullName})`)
          )
        )
      )
    ),
    dupes.length > 1 && h("div", {className: "insp-warn"},
      `Warning: ${dupes.length} apps share the label "${selApp.label}" (${dupes.map(a => a.fullName).join(", ")}). ` +
      `Only the exact DeveloperName you update will change. Use the resolver below to pin the one you actually open.`
    ),
    h("div", {className: "insp-card-header"},
      h("div", {className: "insp-card-title"}, "2 · Pin exact app (optional)")
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "App URL or record Id"),
        h("input", {
          value: appRef,
          placeholder: "https://…/lightning/setup/…/02u…  (or just the 02u… Id)",
          disabled: resolving || working,
          onChange: e => setAppRef(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") resolveFromRef(); }
        })
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: resolving || working || !appRef.trim(),
        title: "Look up the exact CustomApplication by record Id and select it",
        onClick: resolveFromRef
      }, resolving ? "Resolving…" : "Find app")
    ),
    refMsg && h("div", {className: refMsg.ok ? "insp-ok" : "insp-error"}, refMsg.text),
    h("div", {className: "insp-card-header"},
      h("div", {className: "insp-card-title"}, "3 · Add tab")
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Tab API name"),
        h("input", {
          value: tabName,
          placeholder: "IT_Asset__c",
          disabled: working,
          onChange: e => setTabName(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") addTab(); }
        })
      ),
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "…or pick a custom tab"),
        h("select", {
          value: "",
          disabled: tabsLoading || working || !customTabs.length,
          onChange: e => { if (e.target.value) setTabName(e.target.value); }
        },
          h("option", {value: ""}, customTabs.length ? "— choose —" : "No custom tabs found"),
          customTabs.map(t =>
            h("option", {key: t.apiName, value: t.apiName},
              `${t.label} (${t.apiName})`)
          )
        )
      ),
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: working || !sel,
        onClick: addTab
      }, working ? "Working…" : "Add tab to app"),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: visWorking || working || !tabName.trim(),
        title: "Set this tab to DefaultOn for your profile so it appears in App Launcher search",
        onClick: makeVisible
      }, visWorking ? "Setting…" : "Make visible for me")
    ),
    h("div", {className: "insp-toolbar"},
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: currentLoading || !sel || working,
        onClick: () => refreshCurrent()
      }, currentLoading ? "Reading…" : "Show current tabs"),
      sel && h("span", {className: "ff-badge ff-badge-info"},
        `${selLabel} → ${sel}`)
    ),
    currentTabs && h("div", {className: "insp-current"},
      h("div", {className: "insp-chips-label"},
        `Current tabs on ${sel} (${currentTabs.length}):`),
      currentTabs.length
        ? h("div", {className: "insp-chips"},
            currentTabs.map(t =>
              h("button", {
                key: t,
                className: "insp-chip",
                title: "Click to fill the Tab API name field",
                disabled: working,
                onClick: () => setTabName(t)
              }, t)
            )
          )
        : h("div", {className: "insp-empty"}, "none")
    ),
    status && h("div", {className: "insp-ok"}, status),
    error && h("div", {className: "insp-error"}, error),
    debug && h("div", {className: "insp-toolbar"},
      h("button", {className: "btn btn-secondary btn-sm", onClick: copyDebug}, "Copy debug")
    ),
    debug && h("textarea", {
      className: "insp-csv-preview",
      readOnly: true,
      value: debug.slice(0, 8000)
    })
  );
}

// ─── Users tab ──────────────────────────────────────────
let _ffOrgId = null;
async function ffGetOrgId() {
  if (_ffOrgId) return _ffOrgId;
  const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent("SELECT Id FROM Organization LIMIT 1"), {useCache: false});
  _ffOrgId = res.records && res.records[0] && res.records[0].Id;
  if (!_ffOrgId) throw new Error("Could not determine org Id");
  return _ffOrgId;
}

async function usersEnsureDebugLevel() {
  try {
    const q = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
      encodeURIComponent("SELECT Id FROM DebugLevel WHERE DeveloperName = 'FF_UserDebug' LIMIT 1"),
      {useCache: false});
    if (q.records && q.records.length) return q.records[0].Id;
  } catch (e) { /* fall through to create */ }
  const created = await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`, {
    method: "POST",
    useCache: false,
    body: {
      DeveloperName: "FF_UserDebug",
      MasterLabel: "FF User Debug",
      ApexCode: "DEBUG",
      ApexProfiling: "INFO",
      Callout: "INFO",
      Database: "INFO",
      System: "DEBUG",
      Validation: "INFO",
      Visualforce: "INFO",
      Workflow: "INFO"
    }
  });
  if (!created || !created.id) throw new Error("Could not create DebugLevel");
  return created.id;
}

// Multi-select dropdown with search (clone-user assignment picker):
// button shows "Label (n/m selected)", panel lists checkboxes + All/Clear.
function MultiCheckDropdown({label, items, selected, onChange, emptyText}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const sel = new Set(selected || []);
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter(it => it.name.toLowerCase().includes(needle)) : items;
  const toggle = (id) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (e.target.closest && e.target.closest(".ff-multi")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return h("div", {className: "ff-multi"},
    h("button", {
      type: "button",
      className: "btn btn-secondary btn-sm",
      disabled: !items.length,
      title: items.length ? `Pick ${label.toLowerCase()} to copy` : `No ${label.toLowerCase()} assigned`,
      onClick: () => setOpen(o => !o),
      "aria-expanded": open
    }, `${label} (${sel.size}/${items.length} selected ▾)`),
    open && h("div", {className: "ff-multi-panel"},
      h("div", {className: "ff-multi-tools"},
        h("input", {
          className: "ff-multi-search",
          placeholder: "Filter…",
          value: q,
          onChange: e => setQ(e.target.value),
          onClick: e => e.stopPropagation()
        }),
        h("button", {type: "button", className: "field-action-btn",
          onClick: () => onChange(items.map(it => it.id))}, "All"),
        h("button", {type: "button", className: "field-action-btn",
          onClick: () => onChange([])}, "Clear")
      ),
      h("div", {className: "ff-multi-list"},
        shown.map(it => h("label", {key: it.id, className: "ff-multi-row", title: it.id},
          h("input", {type: "checkbox", checked: sel.has(it.id), onChange: () => toggle(it.id)}),
          h("span", null, it.name)
        )),
        shown.length === 0 && h("div", {className: "insp-empty"}, emptyText || "No matches")
      )
    )
  );
}

function UsersTab() {
  const [q, setQ] = ffUseSession("users", "q", "");
  const [users, setUsers] = ffUseSession("users", "users", []);
  const [userCols, setUserCols] = ffUseSession("users", "userCols", []);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sel, setSel] = ffUseSession("users", "sel", null);
  const [detail, setDetail] = ffUseSession("users", "detail", null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState(null);
  const [actionErr, setActionErr] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [srcRec, setSrcRec] = React.useState(null);
  const [cloneOpen, setCloneOpen] = React.useState(false);
  const [profiles, setProfiles] = React.useState([]);
  const [roles, setRoles] = React.useState([]);
  const [srcPerms, setSrcPerms] = React.useState(null);
  const [srcLoading, setSrcLoading] = React.useState(false);
  const [cf, setCf] = React.useState(null);
  const [cloning, setCloning] = React.useState(false);
  const [cloneResult, setCloneResult] = React.useState(null);
  const [sites, setSites] = React.useState([]);
  const [expSite, setExpSite] = React.useState("");

  const search = async () => {
    setError(null);
    setSel(null);
    setDetail(null);
    const term = ffSoqlEscape(q.trim());
    if (!term) { setError("Type a name, username, email or alias"); return; }
    setLoading(true);
    try {
      const soql = `SELECT Id, Name, Username, Email, Alias, IsActive, ProfileId, UserRoleId, UserType, LanguageLocaleKey ` +
        `FROM User WHERE Name LIKE '%${term}%' OR Username LIKE '%${term}%' ` +
        `OR Email LIKE '%${term}%' OR Alias LIKE '%${term}%' ORDER BY Name LIMIT 50`;
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const flat = (res.records || []).map(r => ({
        Id: r.Id,
        Name: r.Name,
        Username: r.Username,
        Email: r.Email,
        Alias: r.Alias,
        Active: r.IsActive ? "true" : "false",
        ProfileId: r.ProfileId,
        RoleId: r.UserRoleId,
        UserType: r.UserType || "Standard",
        Language: r.LanguageLocaleKey
      }));
      setUsers(flat);
      setUserCols(["Name", "Username", "Email", "Alias", "Active"]);
      if (!flat.length) setError(`No users matching "${q.trim()}"`);
    } catch (e) {
      setError(e.message);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const selectUser = async (row) => {
    setSel(row);
    setDetail(null);
    setActionMsg(null);
    setActionErr(null);
    setSrcRec(null);
    setCloneOpen(false);
    setCloneResult(null);
    setDetailLoading(true);
    try {
      const [rec, prof, roleQ] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${encodeURIComponent(row.Id)}`,
          {useCache: false}).catch(() => null),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${row.ProfileId}'`),
          {useCache: false}).catch(() => null),
        row.RoleId ? sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM UserRole WHERE Id = '${row.RoleId}'`),
          {useCache: false}).catch(() => null) : Promise.resolve(null)
      ]);
      setSrcRec(rec);
      setDetail({
        profile: prof && prof.records && prof.records[0] ? prof.records[0].Name : "unknown",
        role: roleQ && roleQ.records && roleQ.records[0]
          ? roleQ.records[0].Name : (row.RoleId ? "unknown" : "—"),
        lastLogin: rec && rec.LastLoginDate ? rec.LastLoginDate : null,
        created: rec && rec.CreatedDate ? rec.CreatedDate : null
      });
    } catch (e) {
      setDetail({profile: "unknown", role: "—", lastLogin: null, created: null});
    } finally {
      setDetailLoading(false);
    }
  };

  const isCommunityUser = (u) => !!u && ffTruthy(u.Active) && !!u.UserType && u.UserType !== "Standard";

  React.useEffect(() => {
    if (!isCommunityUser(sel)) { setSites([]); setExpSite(""); return; }
    let cancelled = false;
    setSites([]);
    setExpSite("");
    sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
      encodeURIComponent("SELECT Id, Name, UrlPathPrefix, Status FROM Network WHERE Status = 'Live' ORDER BY Name"),
      {useCache: false})
      .then(res => {
        if (cancelled) return;
        const list = res.records || [];
        setSites(list);
        setExpSite(list.length ? list[0].Id : "");
      })
      .catch(() => { if (!cancelled) { setSites([]); setExpSite(""); } });
    return () => { cancelled = true; };
  }, [sel]);

  const loginAs = async (incognito) => {
    if (!sel) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("login");
    try {
      const orgId = await ffGetOrgId();
      const url = `https://${sfConn.instanceHostname}/servlet/servlet.su` +
        `?oid=${orgId}&suorgadminid=${sel.Id}&retURL=%2F&targetURL=%2Flightning%2Fpage%2Fhome`;
      window.open(url, "_blank");
      setActionMsg(`Login-as link opened for ${sel.Username} (requires "Log in as another user" permission).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const loginToExpSite = async () => {
    if (!sel || !expSite) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("expLogin");
    try {
      const orgId = await ffGetOrgId();
      const site = sites.find(s => s.Id === expSite) || sites[0];
      const prefix = site && site.UrlPathPrefix ? `/${site.UrlPathPrefix}` : "";
      const home = `${prefix}/s/`;
      const url = `https://${sfConn.instanceHostname}/servlet/servlet.su` +
        `?oid=${orgId}&suorgadminid=${sel.Id}&retURL=${encodeURIComponent(home)}&targetURL=${encodeURIComponent(home)}`;
      window.open(url, "_blank");
      setActionMsg(`Experience login opened for ${sel.Username} on ${site ? site.Name : "site"} (requires login-as permission).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const enableLogs = async () => {
    if (!sel) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("logs");
    try {
      const levelId = await usersEnsureDebugLevel();
      const now = new Date();
      const exp = new Date(now.getTime() + 30 * 60000);
      await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
        method: "POST",
        useCache: false,
        body: {
          TracedEntityId: sel.Id,
          LogType: "USER_DEBUG",
          DebugLevelId: levelId,
          StartDate: now.toISOString(),
          ExpirationDate: exp.toISOString()
        }
      });
      setActionMsg(`Debug logs enabled for ${sel.Username} for 30 minutes (Setup → Debug Logs).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const copyId = async () => {
    if (!sel) return;
    const ok = await safeCopyText(sel.Id);
    if (ok) setActionMsg(`Copied Id ${sel.Id}`);
    else setActionErr(`Copy was blocked by the browser — copy the Id manually: ${sel.Id}`);
  };

  // ── Clone user: same profile/role, copied permission sets, groups ──
  const openClone = async () => {
    if (!sel) return;
    setCloneOpen(true);
    setCloneResult(null);
    setSrcLoading(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const [profRes, roleRes, assignRes, grpRes] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name"), {useCache: false}),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent("SELECT Id, Name FROM UserRole ORDER BY Name"), {useCache: false})
          .catch(() => ({records: []})),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(
            `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, ` +
            `PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment ` +
            `WHERE AssigneeId = '${sel.Id}'`), {useCache: false}),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(
            `SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${sel.Id}'`),
          {useCache: false}).catch(() => ({records: []}))
      ]);
      setProfiles((profRes.records || []).map(p => ({id: p.Id, name: p.Name})));
      setRoles((roleRes.records || []).map(r => ({id: r.Id, name: r.Name})));
      const rows = assignRes.records || [];
      const direct = rows.filter(a =>
        a.PermissionSet && a.PermissionSet.IsOwnedByProfile !== true && a.PermissionSetId);
      let psgIds = new Set();
      try {
        const ids = direct.map(a => `'${a.PermissionSetId}'`).join(",");
        if (ids) {
          const gRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT Id FROM PermissionSetGroup WHERE Id IN (${ids})`),
            {useCache: false});
          psgIds = new Set((gRes.records || []).map(g => g.Id));
        }
      } catch (e) { /* treat all as permission sets */ }
      const ps = [];
      const psg = [];
      for (const a of direct) {
        const entry = {
          id: a.PermissionSetId,
          name: (a.PermissionSet && (a.PermissionSet.Label || a.PermissionSet.Name)) || a.PermissionSetId
        };
        (psgIds.has(a.PermissionSetId) ? psg : ps).push(entry);
      }
      let groups = [];
      const grpIds = (grpRes.records || []).map(g => g.GroupId).filter(Boolean);
      if (grpIds.length) {
        try {
          const gDetail = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(
              `SELECT Id, Name, Type FROM Group WHERE Id IN (${grpIds.map(id => `'${id}'`).join(",")})`),
            {useCache: false});
          groups = (gDetail.records || [])
            .filter(g => g.Type === "Regular" || g.Type === "Queue")
            .map(g => ({id: g.Id, name: `${g.Name} (${g.Type})`}));
        } catch (e) { /* skip groups */ }
      }
      setSrcPerms({ps, psg, groups});
      const rec = srcRec || {};
      setCf({
        firstName: rec.FirstName || "",
        lastName: rec.LastName || "",
        email: "",
        username: "",
        alias: String(rec.Alias || "").slice(0, 8),
        nick: "",
        password: "",
        profileId: rec.ProfileId || sel.ProfileId || "",
        roleId: rec.UserRoleId || "",
        psIds: [...ps, ...psg].map(p => p.id),
        grpIds: groups.map(g => g.id),
        active: true,
        locale: {
          TimeZoneSidKey: rec.TimeZoneSidKey || "Asia/Kolkata",
          LocaleSidKey: rec.LocaleSidKey || "en_US",
          EmailEncodingKey: rec.EmailEncodingKey || "UTF-8",
          LanguageLocaleKey: rec.LanguageLocaleKey || "en_US"
        }
      });
    } catch (e) {
      setActionErr(e.message);
      setCloneOpen(false);
    } finally {
      setSrcLoading(false);
    }
  };

  const doClone = async () => {
    if (!sel || !cf) return;
    setCloneResult(null);
    setActionErr(null);
    const firstName = cf.firstName.trim();
    const lastName = cf.lastName.trim();
    const email = cf.email.trim();
    const username = cf.username.trim();
    if (!lastName) { setActionErr("Last Name is required"); return; }
    if (!email) { setActionErr("Email is required"); return; }
    if (!username) { setActionErr("Username is required (must be globally unique, e.g. name@company.org)"); return; }
    if (!cf.profileId) { setActionErr("Pick a profile"); return; }
    setCloning(true);
    const failures = [];
    let newId = null;
    try {
      // 1. Create the user (identity fields come from the form, everything
      //    else — profile, role, locale — is cloned from the source user).
      const body = {
        FirstName: firstName || undefined,
        LastName: lastName,
        Email: email,
        Username: username,
        Alias: (cf.alias.trim() || lastName.replace(/[^A-Za-z]/g, "") || "user").slice(0, 8),
        CommunityNickname: cf.nick.trim() || username.split("@")[0].slice(0, 40),
        TimeZoneSidKey: cf.locale.TimeZoneSidKey,
        LocaleSidKey: cf.locale.LocaleSidKey,
        EmailEncodingKey: cf.locale.EmailEncodingKey,
        LanguageLocaleKey: cf.locale.LanguageLocaleKey,
        ProfileId: cf.profileId,
        IsActive: !!cf.active
      };
      if (cf.roleId) body.UserRoleId = cf.roleId;
      const created = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User`, {
        method: "POST",
        useCache: false,
        body
      });
      newId = created && created.id;
      if (!newId) throw new Error("User create returned no Id");
      // 2. Optional password (admin-set).
      let pwOk = null;
      if (cf.password) {
        try {
          await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${newId}/password`, {
            method: "POST",
            useCache: false,
            body: {NewPassword: cf.password}
          });
          pwOk = true;
        } catch (e) {
          pwOk = false;
          failures.push(`password: ${e.message}`);
        }
      }
      // 3. Copy selected permission sets + permission set groups.
      let psOk = 0;
      const wantPs = new Set(cf.psIds || []);
      const psList = srcPerms ? [...srcPerms.ps, ...srcPerms.psg].filter(p => wantPs.has(p.id)) : [];
      if (srcPerms) {
        for (const p of psList) {
          try {
            await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetAssignment`, {
              method: "POST",
              useCache: false,
              body: {AssigneeId: newId, PermissionSetId: p.id}
            });
            psOk++;
          } catch (e) {
            failures.push(`${p.name}: ${e.message}`);
          }
        }
      }
      // 4. Copy selected public group / queue memberships.
      let grpOk = 0;
      const wantGrp = new Set(cf.grpIds || []);
      const grpList = srcPerms ? srcPerms.groups.filter(g => wantGrp.has(g.id)) : [];
      if (srcPerms) {
        for (const g of grpList) {
          try {
            await sfConn.rest(`/services/data/v${apiVersion}/sobjects/GroupMember`, {
              method: "POST",
              useCache: false,
              body: {GroupId: g.id, UserOrGroupId: newId}
            });
            grpOk++;
          } catch (e) {
            failures.push(`${g.name}: ${e.message}`);
          }
        }
      }
      const totalPs = psList.length;
      const totalGrp = grpList.length;
      setCloneResult({
        ok: failures.length === 0,
        newId,
        summary: `User created (${newId}): ` +
          `${psOk}/${totalPs} permission sets/groups, ` +
          `${grpOk}/${totalGrp} group memberships` +
          (cf.password ? (pwOk ? ", password set" : ", password FAILED") : ", no password set") +
          ".",
        failures: failures.slice(0, 6)
      });
      setCf(prev => prev ? {...prev, password: ""} : prev);
    } catch (e) {
      setCloneResult({
        ok: false,
        newId,
        summary: e.message,
        failures: failures.slice(0, 6)
      });
    } finally {
      setCloning(false);
    }
  };

  return h("div", {className: "insp-panel"},
    h("p", {className: "insp-hint-strip"},
      "Search users, inspect details, log in as a user, or capture debug logs — all without leaving the extension."
    ),
    h("div", {className: "insp-cmdbar"},
      h("input", {
        value: q,
        placeholder: "Search by name, username, email or alias…",
        disabled: loading,
        onChange: e => setQ(e.target.value),
        onKeyDown: e => { if (e.key === "Enter") search(); }
      }),
      h("button", {
        className: "btn btn-primary",
        disabled: loading || !q.trim(),
        onClick: search
      }, loading ? "Searching…" : "Search users")
    ),
    error && h("div", {className: "insp-error"}, error),
    users.length > 0 && h(ResultTable, {
      columns: userCols,
      rows: users,
      maxRows: 50,
      onRowClick: (row) => selectUser(row),
      rowHint: "Click to select user",
      cellFmt: {
        Active: v => h(FFBadge, {kind: ffTruthy(v) ? "ok" : "off"},
          ffTruthy(v) ? "Active" : "Inactive"),
        LastLogin: v => v
          ? h("span", {className: "ff-date", title: String(v)}, fmtDateTime(v))
          : ""
      }
    }),
    sel && h("div", {className: "user-card"},
      h("div", {className: "user-head"},
        h("div", {className: "user-avatar"},
          (sel.Alias || sel.Name || "?").slice(0, 2).toUpperCase()),
        h("div", {style: {minWidth: 0}},
          h("div", {className: "user-name"},
            sel.Name,
            sel.Alias ? ` (${sel.Alias})` : "",
            " ",
            sel.Active != null && h(FFBadge, {kind: ffTruthy(sel.Active) ? "ok" : "off"},
              ffTruthy(sel.Active) ? "Active" : "Inactive")
          ),
          h("div", {className: "user-handle"}, sel.Username)
        )
      ),
      h("div", {className: "user-chips"},
        h(FFBadge, {kind: "info"},
          detailLoading ? "Loading profile…" : (detail ? detail.profile : "Profile")),
        h(FFBadge, {kind: "info"},
          detailLoading ? "Loading role…" : (detail ? (detail.role || "No role") : "Role")),
        sel.Language && h(FFBadge, {key: "lang"}, sel.Language)
      ),
      h("div", null,
        h("div", {className: "insp-kv-row"},
          h("span", {className: "insp-kv-k"}, "Id"),
          h("span", {className: "insp-kv-v ff-mono"}, sel.Id)),
        h("div", {className: "insp-kv-row"},
          h("span", {className: "insp-kv-k"}, "E-mail"),
          h("span", {className: "insp-kv-v"}, sel.Email || "—")),
        h("div", {className: "insp-kv-row"},
          h("span", {className: "insp-kv-k"}, "Last login"),
          h("span", {
            className: "insp-kv-v ff-date",
            title: detail && detail.lastLogin ? String(detail.lastLogin) : ""
          },
            detailLoading ? "…" : (detail && detail.lastLogin ? fmtDateTime(detail.lastLogin) : "—")))
      ),
      h("div", {className: "user-actions"},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: busy === "login",
          onClick: () => loginAs(false)
        }, busy === "login" ? "Opening…" : "Login As"),
        isCommunityUser(sel) && h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: busy === "expLogin" || !sites.length,
          title: !sites.length
            ? "No live Experience sites found in this org"
            : `Log in to the Experience site as ${sel.Username} (community user must be active)`,
          onClick: loginToExpSite
        }, busy === "expLogin" ? "Opening…" : "Login to Exp Site"),
        isCommunityUser(sel) && sites.length > 1 && h("label", {className: "insp-field", title: "Choose the Experience site"},
          h("span", null, "Site"),
          h("select", {
            value: expSite,
            onChange: e => setExpSite(e.target.value)
          }, sites.map(s => h("option", {key: s.Id, value: s.Id}, s.Name)))
        ),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: busy === "logs",
          title: "Create a 30-minute USER_DEBUG trace flag for this user",
          onClick: enableLogs
        }, busy === "logs" ? "Enabling…" : "Enable Logs"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          title: "Create a new user with the same profile, role, permission sets and groups — you provide name, email, username, password",
          onClick: () => (cloneOpen ? setCloneOpen(false) : openClone())
        }, cloneOpen ? "Close Clone" : "Clone User"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: copyId
        }, "Copy Id"),
        ffIsSfId(sel.Id) && h("button", {
          className: "btn btn-secondary btn-sm",
          title: "Open this user in Salesforce",
          onClick: (e) => openRecordInSf(sel.Id, e)
        }, "Open ↗")
      )
    ),
    sel && cloneOpen && h("div", {className: "insp-kv"},
      h("div", {className: "insp-kv-title"}, `Clone ${sel.Name} → new user`),
      srcLoading && h("div", {className: "insp-meta"}, "Loading profile, role and assignments…"),
      !srcLoading && cf && h("div", null,
        h("div", {className: "insp-meta"},
          `Source: profile ${detail ? detail.profile : "…"} · ` +
          `${srcPerms ? `${srcPerms.ps.length} permission set(s), ${srcPerms.psg.length} group(s), ${srcPerms.groups.length} public group(s)` : "…"}`
        ),
        h("div", {className: "insp-form-grid"},
          h("label", {className: "insp-field"},
            h("span", null, "First Name"),
            h("input", {
              value: cf.firstName,
              onChange: e => setCf({...cf, firstName: e.target.value})
            })
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Last Name *"),
            h("input", {
              value: cf.lastName,
              onChange: e => setCf({...cf, lastName: e.target.value})
            })
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Email *"),
            h("input", {
              value: cf.email,
              placeholder: "user@company.com",
              onChange: e => setCf({...cf, email: e.target.value})
            })
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Username *"),
            h("input", {
              value: cf.username,
              placeholder: "name@company.org (globally unique)",
              onChange: e => setCf({...cf, username: e.target.value})
            })
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Alias (≤8)"),
            h("input", {
              value: cf.alias,
              onChange: e => setCf({...cf, alias: e.target.value})
            })
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Nickname"),
            h("input", {
              value: cf.nick,
              placeholder: "defaults to username prefix",
              onChange: e => setCf({...cf, nick: e.target.value})
            })
          ),
          h("label", {className: "insp-field insp-field-grow"},
            h("span", null, "Password (optional, admin-set)"),
            h("input", {
              type: "password",
              value: cf.password,
              placeholder: "leave blank to skip",
              onChange: e => setCf({...cf, password: e.target.value})
            })
          ),
          h("label", {className: "insp-field insp-field-grow"},
            h("span", null, "Profile * (cloned from source)"),
            h("select", {
              value: cf.profileId,
              onChange: e => setCf({...cf, profileId: e.target.value})
            },
              h("option", {value: ""}, "— pick —"),
              profiles.map(p => h("option", {key: p.id, value: p.id}, p.name))
            )
          ),
          h("label", {className: "insp-field insp-field-grow"},
            h("span", null, "Role (cloned from source)"),
            h("select", {
              value: cf.roleId,
              onChange: e => setCf({...cf, roleId: e.target.value})
            },
              h("option", {value: ""}, "— none —"),
              roles.map(r => h("option", {key: r.id, value: r.id}, r.name))
            )
          )
        ),
        h("div", {className: "insp-toolbar insp-toolbar-wrap", style: {marginTop: "8px"}},
          srcPerms && h(MultiCheckDropdown, {
            label: "Permission sets",
            items: [...srcPerms.ps, ...srcPerms.psg],
            selected: cf.psIds,
            onChange: (psIds) => setCf({...cf, psIds})
          }),
          srcPerms && h(MultiCheckDropdown, {
            label: "Public groups",
            items: srcPerms.groups,
            selected: cf.grpIds,
            onChange: (grpIds) => setCf({...cf, grpIds})
          }),
          h("label", {className: "insp-check"},
            h("input", {
              type: "checkbox",
              checked: cf.active,
              onChange: e => setCf({...cf, active: e.target.checked})
            }),
            h("span", null, "Active")
          ),
          h("button", {
            className: "btn btn-primary btn-sm",
            disabled: cloning,
            onClick: doClone
          }, cloning ? "Creating…" : "Create cloned user")
        )
      )
    ),
    cloneResult && h("div", {className: cloneResult.ok ? "insp-ok" : "insp-warn"},
      cloneResult.summary,
      cloneResult.failures && cloneResult.failures.length > 0 &&
        h("div", null, "First issues: " + cloneResult.failures.join("; "))
    ),
    actionMsg && h("div", {className: "insp-ok"}, actionMsg),
    actionErr && h("div", {className: "insp-error"}, actionErr)
  );
}

// ─── Apex tab (Execute Anonymous, Dev-Console style) ───────
// Runs anonymous Apex through the Tooling API (the same endpoint the
// Developer Console's "Open Execute Anonymous Window" uses) and pulls
// the resulting debug log — no Dev Console needed.
const APEX_KEYWORDS = new Set((
  "abstract and as before boolean break byte case cast catch char class const continue " +
  "currency date datetime decimal default delete desc do double else enum export extends " +
  "false final finally float for from global goto group having if implements import in inner " +
  "insert instanceof int integer interface into like limit list long loop map merge new not " +
  "null object on or outer override package private protected public return returning search " +
  "select set short static super switch synchronized testmethod this throw throws transient " +
  "trigger try undelete update upsert using virtual void webservice when where while with without"
).split(" "));

function apexHighlight(src) {
  const text = String(src == null ? "" : src);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([=<>!]+|[-+*/%^])|([(),;.[\]{}])/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      if (APEX_KEYWORDS.has(w.toLowerCase())) out += `<span class="tok-k">${esc(w)}</span>`;
      else if (/^\s*\(/.test(text.slice(m.index + w.length))) out += `<span class="tok-fn">${esc(w)}</span>`;
      else if (/^[A-Z]/.test(w)) out += `<span class="tok-t">${esc(w)}</span>`;
      else out += esc(w);
    }
    else if (m[5]) out += `<span class="tok-op">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-p">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

const APEX_TEMPLATES = [
  {label: "Debug test", code: "System.debug('Hello from SaralForce');"},
  {label: "Query loop", code:
`List<Account> accs = [SELECT Id, Name FROM Account LIMIT 5];
for (Account a : accs) {
  System.debug(a.Name);
}`},
  {label: "Run batch", code:
`// Replace MyBatchClass with your batch class name:
// Database.executeBatch(new MyBatchClass(), 200);
System.debug('Uncomment the line above to run your batch');`}
];

async function apexExecute(code) {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/executeAnonymous/?anonymousBody=` +
    encodeURIComponent(code), {useCache: false});
  return res || {};
}

async function apexLatestLog(sinceIso) {
  const userId = await appTabsResolveCurrentUserId();
  let soql = `SELECT Id FROM ApexLog WHERE LogUserId = '${userId}'`;
  if (sinceIso) {
    // Window from run start minus clock-skew margin — never "now": the fresh
    // log's StartTime is seconds in the past by the time we query for it.
    const t = new Date(new Date(sinceIso).getTime() - 10000);
    if (!isNaN(t.getTime())) {
      soql += ` AND StartTime >= ${t.toISOString().replace(/\.\d+Z$/, "Z")}`;
    }
  }
  soql += " ORDER BY StartTime DESC LIMIT 1";
  const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(soql), {useCache: false});
  if (!res.records || !res.records.length) return null;
  const body = await sfConn.rest(
    `/services/data/v${apiVersion}/sobjects/ApexLog/${res.records[0].Id}/Body`,
    {responseType: "text", useCache: false});
  return String(body || "");
}

// Parse a raw Apex debug log into Execution-Log rows:
// "15:34:27:001 USER_DEBUG [38]|DEBUG|message" → {ts, event, details}.
// Continuation lines attach to the previous row.
function parseApexLog(text) {
  const rows = [];
  // Pipe format (modern): 18:20:45.1 (1444464)|USER_INFO|[EXTERNAL]|…
  const rePipe = /^(\d{1,2}:\d{2}:\d{2})[:.](\d+)\s*(?:\(\d+\))?\|([A-Z][A-Z0-9_]*)\|(.*)$/;
  // Space format (older): 18:16:06:001 USER_INFO [EXTERNAL]|…
  const reSpace = /^(\d{1,2}:\d{2}:\d{2}:\d{1,3})\s+([A-Z][A-Z0-9_]*)(?:\s+(.*))?$/;
  const pad = d => String(d || "0").padEnd(3, "0").slice(0, 3);
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let m = rePipe.exec(line);
    if (m) {
      rows.push({ts: `${m[1]}:${pad(m[2])}`, event: m[3], details: m[4] || ""});
      continue;
    }
    m = reSpace.exec(line);
    if (m) {
      rows.push({ts: m[1], event: m[2], details: m[3] || ""});
      continue;
    }
    // Continuation lines (stack traces) attach to the previous row. Anything
    // before the first timestamp is preamble (version, levels, Execute
    // Anonymous source) — it stays in the Raw log only, never a table row.
    if (rows.length) rows[rows.length - 1].details += "\n" + line;
  }
  return rows;
}

function ApexTab() {
  const [code, setCode] = ffUseSession("apex", "code", "System.debug('Hello from SaralForce');");
  const [running, setRunning] = React.useState(false);
  const [exec, setExec] = ffUseSession("apex", "exec", null);
  const [error, setError] = React.useState(null);
  const [log, setLog] = ffUseSession("apex", "log", null);
  const [logNote, setLogNote] = React.useState(null);
  const [logLoading, setLogLoading] = React.useState(false);
  const [openLog, setOpenLog] = ffUseSession("apex", "openLog", true);
  const [debugOnly, setDebugOnly] = ffUseSession("apex", "debugOnly", false);
  const [eventFilter, setEventFilter] = ffUseSession("apex", "eventFilter", "");
  const [logFilter, setLogFilter] = ffUseSession("apex", "logFilter", "");
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_apex_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_apex_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);
  const [celeb, setCeleb] = React.useState(0);
  const [selRange, setSelRange] = React.useState({start: 0, end: 0});
  const [useAi, setUseAi] = ffUseSession("apex", "useAi", false);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiCheck, setAiCheck] = React.useState(null);
  const [aiNote, setAiNote] = React.useState(null);
  const openSettings = () => {
    chrome.runtime.sendMessage({message: "openOptions", host: ""});
  };

  const pushHistory = (snippet, ok) => {
    setHistory(prev => {
      const next = [{code: snippet, ts: Date.now(), ok: !!ok},
        ...prev.filter(h => h.code !== snippet)].slice(0, 15);
      ffSaveJson("ff_apex_history", next);
      return next;
    });
  };

  // Save the current editor code as a named template (mirrors the SOQL
  // "Save Query" flow): chips row + click to load, × to delete.
  const saveTemplate = () => {
    const label = saveLabel.trim();
    const snippet = String(code || "");
    if (!label || !snippet.trim()) return;
    setSaved(prev => {
      const next = [{label, code: snippet}, ...prev.filter(t => t.label !== label)].slice(0, 30);
      ffSaveJson("ff_apex_saved", next);
      return next;
    });
    setSaveLabel("");
  };

  const deleteTemplate = (label) => {
    setSaved(prev => {
      const next = prev.filter(t => t.label !== label);
      ffSaveJson("ff_apex_saved", next);
      return next;
    });
  };

  const fetchLog = async (sinceIso) => {
    setLogLoading(true);
    setLogNote(null);
    try {
      // Log rows AND their bodies land asynchronously — a fast fetch catches
      // a partially-flushed body (events missing). Poll until the body stops
      // growing (stable twice) or rounds run out, keeping the longest body
      // seen so a partial log still displays on timeout.
      let best = null;
      let lastErr = null;
      let stable = 0;
      let lastLen = -1;
      for (let i = 0; i < 8 && stable < 2; i++) {
        await new Promise(r => setTimeout(r, 1500));
        let body = null;
        try {
          body = await apexLatestLog(sinceIso);
        } catch (e) { lastErr = e; }
        if (body != null) {
          if (best == null || body.length > best.length) best = body;
          if (body.length === lastLen) stable++;
          else { stable = 0; lastLen = body.length; }
          if (/EXECUTION_FINISHED/.test(body) && stable >= 1) break;
        }
      }
      if (best == null) {
        setLog(null);
        setLogNote(lastErr
          ? "Could not fetch debug log: " + lastErr.message
          : "No fresh debug log found — check Setup → Debug Logs, or tick Open Log and run again.");
      } else {
        setLog(best.slice(0, 30000));
        if (stable < 2) setLogNote("Log may still be writing — hit Refresh log in a few seconds for the remainder.");
      }
    } catch (e) {
      setLog(null);
      setLogNote("Could not fetch debug log: " + e.message);
    } finally {
      setLogLoading(false);
    }
  };

  const run = async (snippetOverride, opts) => {
    const skipAiCheck = !!(opts && opts.skipAiCheck);
    const snippet = String(snippetOverride == null ? (code || "") : snippetOverride);
    if (!snippet.trim()) { setError("Enter some Apex code first"); return; }
    if (encodeURIComponent(snippet).length > 16000) {
      setError("Script is too long for URL-based execution — split it into smaller chunks.");
      return;
    }
    setRunning(true);
    setError(null);
    setExec(null);
    setLog(null);
    setLogNote(null);
    setAiNote(null);
    setAiCheck(null);
    const startedAt = new Date().toISOString();
    try {
      // Pre-flight: with "Use AI" on, let the model scan for compile errors
      // first — a detected problem BLOCKS the run and shows a suggested fix.
      if (useAi && !skipAiCheck) {
        setAiBusy(true);
        try {
          const chk = await apexAiCheck(snippet, null);
          if (!chk.ok) {
            setAiCheck(Object.assign({stage: "preflight"}, chk));
            return;
          }
        } catch (e) {
          setAiNote(e.message === "NO_LLM_CONFIG"
            ? "AI check skipped — set a provider + API key in Options."
            : "AI check failed: " + e.message);
        } finally {
          setAiBusy(false);
        }
      }
      const r = await apexExecute(snippet);
      setExec(r);
      pushHistory(snippet, r.compiled && r.success);
      // Celebration only on a real success (compiled AND executed OK) —
      // compile problems, runtime failures and errors never trigger it.
      if (r && r.compiled && r.success) setCeleb(c => c + 1);
      // On-error: Salesforce still rejected it → offer an AI fix when enabled.
      if (useAi && !(r.compiled && r.success) && r.compileProblem) {
        setAiBusy(true);
        try {
          const chk = await apexAiCheck(snippet, r.compileProblem);
          if (!chk.ok) setAiCheck(Object.assign({stage: "server"}, chk));
        } catch (e) {
          if (e.message !== "NO_LLM_CONFIG") setAiNote("AI fix unavailable: " + e.message);
        } finally {
          setAiBusy(false);
        }
      }
      if (openLog) await fetchLog(startedAt);
    } catch (e) {
      setError(e.message);
      pushHistory(snippet, false);
    } finally {
      setRunning(false);
    }
  };

  const runHighlighted = () => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    if (e <= s) return;
    run(String(code || "").slice(s, e));
  };

  const syncSel = e => {
    const t = e.target;
    setSelRange({start: t.selectionStart ?? 0, end: t.selectionEnd ?? 0});
  };

  const onTermScroll = e => {
    const t = e.target;
    if (hlRef.current) {
      hlRef.current.scrollTop = t.scrollTop;
      hlRef.current.scrollLeft = t.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop;
  };

  const downloadLog = () => {
    if (!log) return;
    downloadText("apex-execute-anonymous.log", log, "text/plain;charset=utf-8");
  };

  const ok = exec && exec.compiled && exec.success;
  const hasSel = selRange.end > selRange.start && selRange.end <= String(code || "").length;
  const lineCount = Math.max(1, String(code || "").split("\n").length);

  return h("div", {className: "insp-panel"},
    h("p", {className: "insp-hint-strip"},
      "Execute Anonymous Apex — same engine as the Developer Console (Debug → Open Execute Anonymous Window). Batch, callouts and queries all work."
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field"},
        h("span", null, "History"),
        h("select", {
          value: "",
          onChange: e => {
            const idx = parseInt(e.target.value, 10);
            if (!isNaN(idx) && history[idx]) {
              setCode(history[idx].code);
              setSelRange({start: 0, end: 0});
            }
            e.target.value = "";
          }
        },
          h("option", {value: ""}, history.length ? "— recent —" : "No history yet"),
          history.map((hh, i) =>
            h("option", {key: i, value: String(i)},
              `${new Date(hh.ts).toLocaleString()} ${hh.ok ? "✓" : "✗"} — ${hh.code.slice(0, 60).replace(/\s+/g, " ")}`)
          )
        )
      ),
      h("div", {className: "insp-chips-row"},
        h("span", {className: "insp-chips-label"}, "Templates:"),
        APEX_TEMPLATES.map(t =>
          h("button", {
            key: t.label,
            className: "insp-chip",
            title: "Insert template",
            onClick: () => { setCode(t.code); setSelRange({start: 0, end: 0}); }
          }, t.label)
        )
      ),
      saved.length > 0 && h("div", {className: "insp-chips-row"},
        h("span", {className: "insp-chips-label"}, "Saved:"),
        saved.slice(0, 12).map(s =>
          h("span", {key: s.label, className: "insp-chip-group"},
            h("button", {
              className: "insp-chip",
              title: s.code.slice(0, 160),
              onClick: () => { setCode(s.code); setSelRange({start: 0, end: 0}); }
            }, s.label),
            h("button", {
              className: "insp-chip-x",
              title: `Delete "${s.label}"`,
              onClick: () => deleteTemplate(s.label)
            }, "×")
          )
        )
      ),
      h("div", {className: "soql-save-row"},
        h("input", {
          className: "soql-save-input",
          value: saveLabel,
          placeholder: "Save as template…",
          title: "Name the current code and save it as a reusable template",
          onChange: e => setSaveLabel(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") saveTemplate(); }
        }),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: !String(code || "").trim(),
          onClick: saveTemplate
        }, "Save")
      )
    ),
    h("div", {className: "apex-term"},
      h("div", {className: "apex-gutter", ref: gutterRef, "aria-hidden": "true"},
        Array.from({length: lineCount}, (_, i) =>
          h("div", {key: i, className: "apex-ln"}, String(i + 1)))
      ),
      h("div", {className: "apex-pane"},
        h("pre", {className: "apex-hl", ref: hlRef, "aria-hidden": "true"},
          h("code", {dangerouslySetInnerHTML: {__html: apexHighlight(code)}})
        ),
        h("textarea", {
          ref: taRef,
          className: "apex-input",
          value: code,
          spellCheck: false,
          onChange: e => setCode(e.target.value),
          onSelect: syncSel,
          onScroll: onTermScroll,
          onKeyDown: e => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
            if (e.key === "Tab") {
              e.preventDefault();
              const ta = taRef.current;
              if (ta) {
                const s = ta.selectionStart ?? code.length;
                setCode(code.slice(0, s) + "  " + code.slice(ta.selectionEnd ?? s));
                requestAnimationFrame(() => {
                  try { ta.focus(); ta.setSelectionRange(s + 2, s + 2); } catch (e2) { /* ignore */ }
                });
              }
            }
          },
          placeholder: "Enter Apex Code… (Ctrl+Enter to execute)"
        })
      ),
      h(Celebrate, {seq: celeb, onDone: () => setCeleb(0)})
    ),
    h("div", {className: "apex-bar"},
      h("label", {className: "insp-check", title: "Fetch the debug log automatically after each run"},
        h("input", {
          type: "checkbox",
          checked: openLog,
          onChange: e => setOpenLog(e.target.checked)
        }),
        h("span", null, "Open Log")
      ),
      h("button", {
        type: "button",
        className: `apex-ai-toggle${useAi ? " is-on" : ""}`,
        onClick: () => {
          const v = !useAi;
          setUseAi(v);
          if (!v) {
            setAiCheck(null);
            setAiNote(null);
          }
        },
        title: useAi
          ? "AI pre-check is ON — code is scanned before each run; compile errors get a suggested fix"
          : "Turn on to let AI scan your code before each run and fix compile errors",
        "aria-pressed": useAi ? "true" : "false"
      },
        h("span", {className: "apex-ai-spark", "aria-hidden": "true"}, "\u2728"),
        h("span", null, "Use AI"),
        h("span", {className: "apex-ai-state"}, useAi ? "ON" : "OFF")
      ),
      useAi && h("span", {className: "apex-ai-hint"},
        "pre-checks code before each run"),
      log && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: downloadLog
      }, "Download Log"),
      h("div", {className: "apex-bar-end"},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: running || !code.trim(),
          title: "Execute the whole script (Ctrl+Enter)",
          onClick: () => run()
        }, running ? "Executing…" : "Execute"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: running || !hasSel,
          title: hasSel ? "Execute only the selected code" : "Select code in the editor first",
          onClick: runHighlighted
        }, "Execute Highlighted")
      )
    ),
    error && h("div", {className: "insp-error"}, error),
    exec && (ok
      ? h("div", {className: "insp-ok"}, "Apex executed successfully (compiled ✓).")
      : h("div", {className: "insp-error"},
          exec.compileProblem
            ? `Compile error${exec.line ? ` (line ${exec.line}${exec.column ? ", column " + exec.column : ""})` : ""}: ${exec.compileProblem}`
            : (exec.exceptionMessage || "Execution failed."),
          exec.exceptionStackTrace && h("pre", {className: "insp-log insp-log-small"},
            String(exec.exceptionStackTrace).slice(0, 4000))
        )
    ),
    aiNote && h("div", {className: "insp-warn"}, aiNote),
    aiBusy && h("div", {className: "insp-meta"}, "✨ AI is checking your code…"),
    aiCheck && h("div", {className: "insp-fix"},
      h("div", {className: "insp-fix-title"}, "✨ AI suggested fix"),
      h("div", {className: "insp-fix-why"},
        (aiCheck.stage === "server"
          ? `Salesforce compile error: ${aiCheck.error || exec?.compileProblem || "rejected the code"}`
          : `Likely compile error${aiCheck.line ? ` (line ${aiCheck.line})` : ""}: ${aiCheck.error || "problem found"}`),
        aiCheck.explanation ? ` — ${aiCheck.explanation}` : ""),
      aiCheck.fixedCode && h("div", {className: "insp-fix-query"}, aiCheck.fixedCode),
      h("div", {className: "insp-toolbar", style: {marginBottom: "0", marginTop: "8px"}},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: running || !aiCheck.fixedCode,
          onClick: () => {
            const fixed = aiCheck.fixedCode;
            setAiCheck(null);
            setCode(fixed);
            run(fixed, {skipAiCheck: true});
          }
        }, running ? "Running…" : "Apply & Run"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: async () => {
            try { await safeCopyText(aiCheck.fixedCode); }
            catch (e) { /* ignore */ }
          }
        }, "Copy")
      )
    ),
    (logLoading || log || logNote) && h("div", {className: "insp-meta"},
      logLoading
        ? "Fetching debug log…"
        : (log ? `Execution Log (${log.length} chars)` : "Debug log"),
      !logLoading && h("button", {
        className: "field-action-btn",
        style: {marginLeft: "8px"},
        onClick: () => fetchLog()
      }, log ? "Refresh log" : "Retry")
    ),
    logNote && h("div", {className: "insp-warn"}, logNote),
    log && (() => {
      const allRows = parseApexLog(log);
      const events = [...new Set(allRows.map(r => r.event).filter(Boolean))].sort();
      const f = logFilter.trim().toLowerCase();
      const shown = allRows.filter(r =>
        (!debugOnly || r.event === "USER_DEBUG") &&
        (!eventFilter || r.event === eventFilter) &&
        (!f || `${r.ts} ${r.event} ${r.details}`.toLowerCase().includes(f)));
      return h("div", null,
        h("div", {className: "insp-toolbar insp-toolbar-wrap"},
          h("label", {className: "insp-check", title: "Show only USER_DEBUG lines (your System.debug output)"},
            h("input", {
              type: "checkbox",
              checked: debugOnly,
              onChange: e => {
                const v = e.target.checked;
                setDebugOnly(v);
                // Debug Only means USER_DEBUG — drop a conflicting event pick
                // so the rows can't be filtered away twice.
                if (v) setEventFilter("");
              }
            }),
            h("span", null, "Debug Only")
          ),
          h("label", {className: "insp-field"},
            h("span", null, "Event"),
            h("select", {
              value: eventFilter,
              onChange: e => setEventFilter(e.target.value)
            },
              h("option", {value: ""}, `All events (${events.length})`),
              events.map(ev =>
                h("option", {key: ev, value: ev},
                  `${ev} (${allRows.filter(r => r.event === ev).length})`)
              )
            )
          ),
          h("label", {className: "insp-field insp-field-grow"},
            h("span", null, "Filter"),
            h("input", {
              value: logFilter,
              placeholder: "Click here to filter the log",
              onChange: e => setLogFilter(e.target.value)
            })
          ),
          h("span", {className: "insp-meta"},
            `${shown.length}/${allRows.length} lines`)
        ),
        h("div", {className: "insp-table-wrap insp-log-table"},
          h("table", {className: "insp-table"},
            h("thead", null,
              h("tr", null,
                h("th", null, "Timestamp"),
                h("th", null, "Event"),
                h("th", null, "Details")
              )
            ),
            h("tbody", null,
              shown.slice(0, 2000).map((r, i) =>
                h("tr", {
                  key: i,
                  className: r.event === "USER_DEBUG" ? "insp-row-hl" : ""
                },
                  h("td", {className: "insp-nowrap"}, r.ts),
                  h("td", null, h("span", {className: "ff-log-ev", title: r.event}, r.event)),
                  h("td", {className: "insp-nowrap", title: r.details}, r.details)
                )
              )
            )
          ),
          shown.length > 2000 &&
            h("div", {className: "insp-more"}, `Showing 2000 of ${shown.length} lines — narrow the filter`)
        ),
        h("details", {className: "insp-details"},
          h("summary", null, "Raw log"),
          h("pre", {className: "insp-log"}, log)
        )
      );
    })()
  );
}

// ─── Logs tab: trace flags + debug log search + AI analysis ──
function ffDatetimeLocal(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ffFmtTs(x) {
  if (!x) return "—";
  const d = new Date(x);
  return isNaN(d.getTime()) ? String(x) : d.toLocaleString();
}

async function logsToolingQuery(soql) {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
    encodeURIComponent(soql), {useCache: false});
  return (res && res.records) || [];
}

async function logsListDebugLevels() {
  return logsToolingQuery(
    "SELECT Id, DeveloperName, MasterLabel FROM DebugLevel ORDER BY MasterLabel LIMIT 200");
}

async function logsLookupEntities(type, term) {
  const t = ffSoqlEscape(term.trim());
  if (!t) return [];
  if (type === "User") {
    const res = await runSoql(
      `SELECT Id, Name, Username FROM User ` +
      `WHERE Name LIKE '%${t}%' OR Username LIKE '%${t}%' ORDER BY Name LIMIT 20`, 20);
    return res.records.map(r => ({id: r.Id, name: r.Name, sub: r.Username}));
  }
  const rows = await logsToolingQuery(
    `SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE Name LIKE '%${t}%' ` +
    `ORDER BY Name LIMIT 20`);
  return rows.map(r => ({
    id: r.Id,
    name: r.NamespacePrefix ? `${r.NamespacePrefix}.${r.Name}` : r.Name,
    sub: "Apex class"
  }));
}

async function logsListTraceFlags(entityId) {
  return logsToolingQuery(
    `SELECT Id, LogType, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag ` +
    `WHERE TracedEntityId = '${entityId}' ORDER BY StartDate DESC LIMIT 50`);
}

async function logsCreateTraceFlag({entityId, levelId, startMs, endMs, logType}) {
  const created = await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
    method: "POST",
    useCache: false,
    body: {
      TracedEntityId: entityId,
      LogType: logType,
      DebugLevelId: levelId,
      StartDate: new Date(startMs).toISOString(),
      ExpirationDate: new Date(endMs).toISOString()
    }
  });
  const id = created && (created.id || created.Id);
  if (!id) throw new Error("Salesforce did not return a TraceFlag Id");
  // Read it back — never report a success we did not confirm.
  const rec = await sfConn.rest(
    `/services/data/v${apiVersion}/tooling/sobjects/TraceFlag/${encodeURIComponent(id)}`,
    {useCache: false});
  if (!rec || rec.Id !== id) throw new Error(`TraceFlag ${id} was created but could not be read back`);
  return rec;
}

async function logsDeleteTraceFlag(id) {
  await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/TraceFlag/${encodeURIComponent(id)}`, {
    method: "DELETE",
    useCache: false
  });
}

// ApexLog has NO Name column — Id is the only label (the old INVALID_FIELD
// bug). LogUser.Name is Setup's "User" column; Request/Application/Operation/
// Status match Setup → Debug Logs. Pages with keyset on StartTime, not OFFSET.
const LOGS_PAGE = 30;
const LOGS_MAX = 300;
const LOGS_SEARCH_CAP = 60;

async function logsQueryApexLogs({startMs, endMs, userId, limitN, beforeMs}) {
  const n = limitN || LOGS_PAGE;
  const where = `StartTime >= ${new Date(startMs).toISOString()} ` +
    `AND StartTime <= ${new Date(endMs).toISOString()}` +
    (beforeMs != null ? ` AND StartTime < ${new Date(beforeMs).toISOString()}` : "") +
    (userId ? ` AND LogUserId = '${userId}'` : "");
  const full = `SELECT Id, LogUserId, LogUser.Name, Request, Application, Operation, ` +
    `Status, DurationMilliseconds, LogLength, StartTime FROM ApexLog ` +
    `WHERE ${where} ORDER BY StartTime DESC LIMIT ${n}`;
  try {
    const res = await runSoql(full, n);
    return {records: res.records, warned: null};
  } catch (e) {
    if (!/INVALID_FIELD|No such column/i.test(String(e.message || e))) throw e;
    // Defensive: never leave the tab dead over one unavailable field.
    const minimal = `SELECT Id, LogUserId, StartTime, Status, Operation FROM ApexLog ` +
      `WHERE ${where} ORDER BY StartTime DESC LIMIT ${n}`;
    const res = await runSoql(minimal, n);
    return {records: res.records,
      warned: "Some log columns are unavailable in this org — showing the basic ones."};
  }
}

async function logsDeleteApexLog(id) {
  const enc = encodeURIComponent(id);
  const bases = [
    `/services/data/v${apiVersion}/tooling/sobjects/ApexLog/`,
    `/services/data/v${apiVersion}/sobjects/ApexLog/`
  ];
  let lastErr = null;
  for (const base of bases) {
    try {
      await sfConn.rest(base + enc, {method: "DELETE", useCache: false});
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Could not delete the log");
}

async function logsFetchBody(id) {
  const body = await sfConn.rest(
    `/services/data/v${apiVersion}/sobjects/ApexLog/${encodeURIComponent(id)}/Body`,
    {responseType: "text", useCache: false});
  return String(body || "");
}

// One shared call to the Options-configured LLM (Quick Analysis + chat).
async function logsAskLlm(systemPrompt, userText) {
  const config = getSavedConfig();
  if (!config || !hasValidConfig()) throw new Error("NO_LLM_CONFIG");
  const provider = getLLMProvider(config.provider);
  const messages = [
    {role: "system", content: systemPrompt},
    {role: "user", content: userText}
  ];
  const raw = config.baseUrl
    ? await provider.sendMessage(messages, config.apiKey, config.model, null, config.baseUrl)
    : await provider.sendMessage(messages, config.apiKey, config.model, null);
  const text = String(raw || "").trim();
  if (!text) throw new Error("The AI returned an empty reply");
  return text;
}

const LOGS_ANALYZE_SYSTEM =
  "You are a senior Salesforce developer reviewing ONE Salesforce debug log for a beginner. " +
  "Reply as plain text with exactly these short sections: WHAT HAPPENED, ERRORS, " +
  "DEBUG HIGHLIGHTS, NEXT STEP. Keep it under 200 words. Quote exact error messages and " +
  "class, trigger or method names from the log. Never invent details that are not in the log.";

const LOGS_CHAT_SYSTEM =
  "You are a senior Salesforce developer answering a question about ONE Salesforce debug " +
  "log supplied with the question. Plain language, brief. Quote exact lines, errors or " +
  "class names from the log when useful. If the answer is not in the log, say so honestly.";

function logsUserName(lg) {
  const lu = lg && lg.LogUser;
  if (lu && typeof lu === "object") return lu.Name || "";
  return (lg && lg.LogUserId) || "";
}

// Header the AI needs so it knows what it is looking at.
function logsExcerpt(lg, body, maxChars) {
  const head = [
    `Log Id: ${lg.Id}`,
    `User: ${logsUserName(lg) || "unknown"}`,
    `Request: ${lg.Request || "-"} | Application: ${lg.Application || "-"} | Operation: ${lg.Operation || "-"}`,
    `Status: ${lg.Status || "-"} | Duration: ${lg.DurationMilliseconds != null ? lg.DurationMilliseconds + " ms" : "-"} | Size: ${lg.LogLength != null ? lg.LogLength + " bytes" : "-"}`,
    `Started: ${ffFmtTs(lg.StartTime)}`
  ].join("\n");
  return `${head}\n\n${String(body || "").slice(0, maxChars || 12000)}`;
}

// First executed unit from the body: "CODE_UNIT_STARTED|1|PaymentGateway:run".
function logsHeadUnit(body) {
  const s = String(body || "");
  const m = /CODE_UNIT_STARTED\|[^\n]*?\|([^|\n]+)/.exec(s);
  if (m && m[1].trim()) return m[1].trim();
  if (/\[EXECUTE\]|Execute Anonymous/i.test(s)) return "Execute Anonymous";
  return null;
}

// Setup-style status → chip colour.
function logsStatusKind(status) {
  const s = String(status || "").toLowerCase();
  if (s.startsWith("suc")) return "ok";
  if (s.startsWith("fail")) return "fail";
  if (s.startsWith("ab")) return "warn";
  return "other";
}

// Split an AI analysis into "SECTION NAME" + body blocks so each section can
// be colour-coded. Tolerates numbering/markdown emphasis around the heading.
// Returns [] when nothing heading-like is found.
function parseAnalysisSections(text) {
  const src = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  const out = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const t = line.trim()
      .replace(/^[#*\s]+/, "")
      .replace(/[*#\s:]+$/, "");
    const isHeading = /^[A-Z][A-Z0-9 &/()-]{1,48}$/.test(t) && /[A-Z]{2}/.test(t);
    if (isHeading) {
      if (cur) out.push(cur);
      cur = {heading: t, body: []};
    } else if (cur) {
      cur.body.push(line);
    } else {
      cur = {heading: "", body: [line]};
    }
  }
  if (cur) out.push(cur);
  return out
    .map(s => ({heading: s.heading, body: s.body.join("\n").trim()}))
    .filter(s => s.heading || s.body);
}

// Map a section heading to its colour family.
function analysisSectionKind(heading) {
  const h = String(heading || "").toUpperCase();
  if (h.includes("ERROR") || h.includes("ISSUE") || h.includes("FAIL")) return "err";
  if (h.includes("NEXT") || h.includes("ACTION")) return "next";
  if (h.includes("DEBUG") || h.includes("HIGHLIGHT") || h.includes("DETAIL")) return "debug";
  if (h.includes("HAPPEN") || h.includes("SUMMARY") || h.includes("OVERVIEW")) return "info";
  return "plain";
}

// Colour-coded card for the AI Quick Analysis response. Errors render red
// (green "None." when there are none), NEXT STEP teal, DEBUG HIGHLIGHTS
// purple, WHAT HAPPENED blue; unknown sections get a neutral tint.
function AnalysisReport({text, copied, onCopy}) {
  const secs = parseAnalysisSections(text);
  const iconFor = {info: "📋", err: "⚠️", next: "🧭", debug: "🔍", plain: "📄"};
  return h("div", {className: "ai-report"},
    secs.length
      ? secs.map((s, i) => {
          const kind = analysisSectionKind(s.heading);
          const noneOk = kind === "err" && /^(none|no errors?|nil|n\/a)\.?$/i.test(s.body);
          const cls = noneOk ? "ok" : kind;
          return h("div", {key: i, className: `ai-sec ai-sec-${cls}`},
            s.heading && h("div", {className: "ai-sec-h"},
              `${noneOk ? "✅" : (iconFor[kind] || "📄")} ${s.heading}`),
            h("div", {className: "ai-sec-body"}, s.body || (noneOk ? "None." : "—"))
          );
        })
      : h("div", {className: "ai-sec ai-sec-plain"},
          h("div", {className: "ai-sec-body"}, text)),
    h("button", {
      className: copied ? "field-action-btn btn-ok" : "field-action-btn",
      style: {marginTop: "2px", alignSelf: "flex-start"},
      onClick: onCopy
    }, copied ? "Copied ✓" : "Copy")
  );
}

function LogsTab() {
  const [entityType, setEntityType] = ffUseSession("logs", "entityType", "User");
  const [lookupText, setLookupText] = React.useState("");
  const [lookupRes, setLookupRes] = React.useState([]);
  const [lookupBusy, setLookupBusy] = React.useState(false);
  const [lookupErr, setLookupErr] = React.useState(null);
  const [entity, setEntity] = ffUseSession("logs", "entity", null);
  const [start, setStart] = ffUseSession("logs", "start", () => ffDatetimeLocal(new Date(Date.now() - 30 * 60000)));
  const [end, setEnd] = ffUseSession("logs", "end", () => ffDatetimeLocal(new Date(Date.now() + 60 * 60000)));
  const [levels, setLevels] = React.useState([]);
  const [levelId, setLevelId] = ffUseSession("logs", "levelId", "");
  const [flags, setFlags] = React.useState([]);
  const [formErr, setFormErr] = React.useState(null);
  const [formMsg, setFormMsg] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [flagBusy, setFlagBusy] = React.useState(null);

  const [logs, setLogs] = ffUseSession("logs", "logs", []);
  const [logsErr, setLogsErr] = React.useState(null);
  const [logsNote, setLogsNote] = ffUseSession("logs", "logsNote", null);
  const [logsBusy, setLogsBusy] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = ffUseSession("logs", "hasMore", false);
  const [search, setSearch] = ffUseSession("logs", "search", "");
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [matched, setMatched] = ffUseSession("logs", "matched", null);
  const [bodies, setBodies] = React.useState({});
  const [openLog, setOpenLog] = ffUseSession("logs", "openLog", null);
  const [logFilter, setLogFilter] = ffUseSession("logs", "logFilter", "");
  const [debugOnly, setDebugOnly] = ffUseSession("logs", "debugOnly", false);
  const [selId, setSelId] = ffUseSession("logs", "selId", null);
  const [analyses, setAnalyses] = ffUseSession("logs", "analyses", {});
  const [analyzingId, setAnalyzingId] = React.useState(null);
  const [chats, setChats] = ffUseSession("logs", "chats", {});
  const [chatInput, setChatInput] = ffUseSession("logs", "chatInput", "");
  const [chatBusy, setChatBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [delBusy, setDelBusy] = React.useState(null);
  const [delAllOpen, setDelAllOpen] = React.useState(false);
  const [delAllText, setDelAllText] = React.useState("");
  const [delAllBusy, setDelAllBusy] = React.useState(false);
  const [delProgress, setDelProgress] = React.useState(null);
  const [delResult, setDelResult] = React.useState(null);
  const [win, setWin] = ffUseSession("logs", "win", null);
  const chatRef = React.useRef(null);
  const aiRef = React.useRef(null);
  const logDataRef = React.useRef(null);

  React.useEffect(() => {
    (async () => {
      try {
        let rows = await logsListDebugLevels();
        if (!rows.length) {
          await usersEnsureDebugLevel();
          rows = await logsListDebugLevels();
        }
        setLevels(rows);
        const prefer = rows.find(r => r.DeveloperName === "FF_UserDebug") || rows[0];
        // Keep a restored selection (e.g. a user-created debug level).
        if (prefer) setLevelId(prev => prev || prefer.Id);
      } catch (e) {
        setFormErr(`Could not load Debug Levels: ${e.message}`);
      }
    })();
  }, []);

  React.useEffect(() => {
    const term = lookupText.trim();
    if (!term || entity) { setLookupRes([]); setLookupErr(null); return; }
    let cancelled = false;
    setLookupBusy(true);
    const timer = setTimeout(() => {
      logsLookupEntities(entityType, term)
        .then(rows => {
          if (cancelled) return;
          setLookupRes(rows);
          setLookupErr(rows.length ? null : `No ${entityType === "User" ? "user" : "Apex class"} matches "${term}"`);
        })
        .catch(e => { if (!cancelled) setLookupErr(e.message); })
        .finally(() => { if (!cancelled) setLookupBusy(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [lookupText, entityType, entity]);

  const loadFlags = async (id) => {
    if (!id) { setFlags([]); return; }
    try { setFlags(await logsListTraceFlags(id)); }
    catch (e) { setFlags([]); }
  };

  const entityInitRef = React.useRef(true);
  React.useEffect(() => {
    // First mount after a reopen keeps the restored win/logs; flags are live
    // server data either way, so always reload them.
    if (entityInitRef.current) {
      entityInitRef.current = false;
      if (entity) loadFlags(entity.id);
      return;
    }
    setFlags([]);
    setWin(null);
    if (entity) loadFlags(entity.id);
  }, [entity]);

  const levelLabel = (id) => {
    const l = levels.find(x => x.Id === id);
    return l ? (l.MasterLabel || l.DeveloperName) : (id || "—");
  };

  const pickEntity = (row) => {
    setEntity(row);
    setLookupText("");
    setLookupRes([]);
    setLookupErr(null);
    setFormMsg(null);
    setFormErr(null);
  };

  const useMe = async () => {
    setFormErr(null);
    setFormMsg(null);
    try {
      const id = await appTabsResolveCurrentUserId();
      const res = await runSoql(`SELECT Id, Name, Username FROM User WHERE Id = '${id}' LIMIT 1`, 1);
      const r = res.records[0];
      setEntityType("User");
      setEntity({id, name: r ? r.Name : id, sub: r ? r.Username : ""});
      setLookupText("");
      setLookupErr(null);
    } catch (e) {
      setFormErr(e.message);
    }
  };

  const createFlag = async () => {
    setFormErr(null);
    setFormMsg(null);
    if (!entity) { setFormErr("Pick an entity first — type in the name lookup or use \"Use me\"."); return; }
    if (!levelId) { setFormErr("Pick a Debug Level."); return; }
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (isNaN(s) || isNaN(e)) { setFormErr("Start and End must be valid date/times."); return; }
    if (e <= s) { setFormErr("End must be after Start."); return; }
    const now = Date.now();
    const sClamped = Math.min(s, now);
    if (e <= sClamped) { setFormErr("End must be in the future."); return; }
    const logType = entityType === "User" ? "USER_DEBUG" : "CLASS_TRACING";
    setCreating(true);
    try {
      // Salesforce rejects overlapping trace flags with a raw
      // FIELD_INTEGRITY_EXCEPTION — check first and explain it kindly.
      const existing = await logsListTraceFlags(entity.id);
      const overlap = existing.find(f => {
        if (f.LogType !== logType) return false;
        const fs = Date.parse(f.StartDate);
        const fe = Date.parse(f.ExpirationDate);
        return !isNaN(fs) && !isNaN(fe) && fe > sClamped && fs < e;
      });
      if (overlap) {
        setFormErr(`An overlapping ${logType} trace flag already exists for ${entity.name} ` +
          `(it expires ${ffFmtTs(overlap.ExpirationDate)}). Salesforce allows only one per ` +
          `time window — delete that flag in the list below first, or just use it: logs are ` +
          `already being captured.`);
        return;
      }
      const rec = await logsCreateTraceFlag({
        entityId: entity.id,
        levelId,
        startMs: sClamped,
        endMs: e,
        logType
      });
      setFormMsg(`Trace flag ${rec.Id} created for ${entity.name} — logging until ${ffFmtTs(new Date(e).toISOString())}.`);
      await loadFlags(entity.id);
    } catch (err) {
      const msg = String(err.message || err);
      setFormErr(/FIELD_INTEGRITY|overlap|already being traced/i.test(msg)
        ? "That time window overlaps an existing trace flag for this entity. " +
          "Delete the old flag in the list below first, or use the existing one."
        : msg);
    } finally {
      setCreating(false);
    }
  };

  const deleteFlag = async (id) => {
    setFlagBusy(id);
    setFormErr(null);
    setFormMsg(null);
    try {
      await logsDeleteTraceFlag(id);
      setFormMsg(`Trace flag ${id} deleted.`);
      if (entity) await loadFlags(entity.id);
    } catch (e) {
      setFormErr(e.message);
    } finally {
      setFlagBusy(null);
    }
  };

  const windowRange = () => {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (isNaN(s) || isNaN(e)) throw new Error("Start and End must be valid date/times.");
    if (e <= s) throw new Error("End must be after Start.");
    return {startMs: s, endMs: e};
  };

  const userIdFilter = () => (entityType === "User" && entity ? entity.id : null);

  const startOfTodayMs = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  // Effective window for the log list. With no entity selected it always
  // covers today ("Load logs without a username → all of today's logs");
  // the End is never allowed to be in the past so old defaults still work.
  const logWindow = () => {
    const {startMs, endMs} = windowRange();
    const today = startOfTodayMs();
    const s = entity ? startMs : Math.min(startMs, today);
    return {startMs: s, endMs: Math.max(endMs, Date.now())};
  };

  const loadLogs = async () => {
    setLogsErr(null);
    setLogsNote(null);
    setMatched(null);
    setSearch("");
    setAnalyses({});
    setChats({});
    setSelId(null);
    setOpenLog(null);
    setDelResult(null);
    setDelProgress(null);
    setLogsBusy(true);
    setHasMore(false);
    try {
      const first = logWindow();
      const userId = userIdFilter();
      const today = startOfTodayMs();
      const now = Date.now();
      // Fallback ladder: requested window → today (+same user) → today (all users).
      const attempts = [{startMs: first.startMs, endMs: first.endMs, userId, note: null}];
      if (first.startMs > today || first.endMs < now) {
        attempts.push({
          startMs: today, endMs: Math.max(first.endMs, now), userId,
          note: "No logs in your selected window — showing today's logs instead."
        });
      }
      if (userId) {
        attempts.push({
          startMs: today, endMs: Math.max(first.endMs, now), userId: null,
          note: "No logs for that user today — showing today's logs for all users instead."
        });
      }

      let page = null;
      let used = null;
      for (const a of attempts) {
        page = await logsQueryApexLogs({
          startMs: a.startMs, endMs: a.endMs, userId: a.userId, limitN: LOGS_PAGE
        });
        if (page.records.length) { used = a; break; }
      }
      if (!used) used = attempts[attempts.length - 1];

      setWin({startMs: used.startMs, endMs: used.endMs, userId: used.userId});
      setLogs(page.records);
      setHasMore(page.records.length >= LOGS_PAGE);
      const notes = [used.note, page.warned].filter(Boolean);
      if (notes.length) setLogsNote(notes.join(" "));
      if (!page.records.length) {
        setLogsNote("No debug logs found (the window was widened to today before giving up). " +
          "Check that a trace flag is active above, reproduce the problem, wait a few seconds, " +
          "then Load logs again.");
      }
    } catch (err) {
      setLogs([]);
      setLogsErr(err.message);
    } finally {
      setLogsBusy(false);
    }
  };

  // Keyset paging: StartTime < oldest loaded row, dedupe by Id.
  // Pages inside the SAME window the list was loaded with (`win`).
  const loadMore = async () => {
    if (!logs.length) return;
    setLoadingMore(true);
    setLogsErr(null);
    try {
      const w = win || logWindow();
      const oldest = logs.reduce((min, lg) => {
        const t = Date.parse(lg.StartTime);
        return isNaN(t) ? min : Math.min(min, t);
      }, Infinity);
      if (!isFinite(oldest)) throw new Error("Could not read the last log's timestamp");
      const page = await logsQueryApexLogs({
        startMs: w.startMs, endMs: w.endMs, userId: w.userId, limitN: LOGS_PAGE, beforeMs: oldest
      });
      const seen = new Set(logs.map(l => l.Id));
      const fresh = page.records.filter(r => !seen.has(r.Id));
      const total = logs.length + fresh.length;
      setLogs(prev => [...prev, ...fresh]);
      if (!fresh.length && page.records.length) {
        // Same StartTime values repeated — keyset cannot advance further.
        setHasMore(false);
        setLogsNote("No newer page could be read — narrow the time window to see more.");
        return;
      }
      setHasMore(page.records.length >= LOGS_PAGE && total < LOGS_MAX);
      if (total >= LOGS_MAX) {
        setLogsNote(`Stopped at ${LOGS_MAX} logs (page cap) — narrow the time window to see more.`);
      } else if (!page.records.length) {
        setLogsNote("No more logs in this window.");
      }
    } catch (err) {
      setLogsErr(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const ensureBody = async (lg) => {
    if (bodies[lg.Id] != null) return bodies[lg.Id];
    const text = await logsFetchBody(lg.Id);
    setBodies(prev => ({...prev, [lg.Id]: text}));
    return text;
  };

  const searchLogs = async () => {
    const term = search.trim();
    if (!term) { setMatched(null); return; }
    setSearchBusy(true);
    setLogsErr(null);
    try {
      const list = logs.slice(0, LOGS_SEARCH_CAP);
      const next = {...bodies};
      for (let i = 0; i < list.length; i += 4) {
        const chunk = list.slice(i, i + 4);
        await Promise.all(chunk.map(async lg => {
          if (next[lg.Id] != null) return;
          try { next[lg.Id] = await logsFetchBody(lg.Id); }
          catch (e) { next[lg.Id] = ""; }
        }));
        setBodies({...next});
      }
      setBodies(next);
      const low = term.toLowerCase();
      setMatched(list.filter(lg => String(next[lg.Id] || "").toLowerCase().includes(low)).map(lg => lg.Id));
    } catch (err) {
      setLogsErr(err.message);
    } finally {
      setSearchBusy(false);
    }
  };

  const viewLog = async (lg) => {
    try {
      const text = await ensureBody(lg);
      setOpenLog({id: lg.Id, name: lg.Id, text: String(text || "")});
      setLogFilter("");
      setDebugOnly(false);
      // Jump to the freshly opened raw-log block.
      requestAnimationFrame(() => {
        if (logDataRef.current && logDataRef.current.scrollIntoView) {
          logDataRef.current.scrollIntoView({block: "start", behavior: "smooth"});
        }
      });
    } catch (e) {
      setLogsErr(`Could not fetch the log body: ${e.message}`);
    }
  };

  const downloadLog = async (lg) => {
    try {
      const text = await ensureBody(lg);
      downloadText(`log-${lg.Id}.log`, text, "text/plain");
    } catch (e) {
      setLogsErr(`Could not fetch the log body: ${e.message}`);
    }
  };

  // ⚡ Quick Analysis — one plain-English verdict, cached per log id.
  // Clicking Analyze on an already-analyzed log NEVER calls the AI again:
  // it just selects the log and shows the saved result.
  const analyzeLog = async (lg, force) => {
    setSelId(lg.Id);
    // Always surface the AI pane (right column) so the analysis is visible.
    if (aiRef.current && aiRef.current.scrollIntoView) {
      aiRef.current.scrollIntoView({block: "nearest", behavior: "smooth"});
    }
    const prev = analyses[lg.Id];
    if (prev && prev.text && !force) {
      return;
    }
    setAnalyzingId(lg.Id);
    setAnalyses(p => ({...p, [lg.Id]: {pending: true}}));
    try {
      const body = await ensureBody(lg);
      const text = await logsAskLlm(LOGS_ANALYZE_SYSTEM, logsExcerpt(lg, body, 12000));
      setAnalyses(p => ({...p, [lg.Id]: {text}}));
    } catch (e) {
      setAnalyses(p => ({...p, [lg.Id]: {
        error: e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message}}));
    } finally {
      setAnalyzingId(null);
    }
  };

  // 💬 Ask AI About This Log — per-log chat history.
  const askAboutLog = async (lg, question) => {
    const q = String(question || "").trim();
    if (!q || chatBusy) return;
    const hist = chats[lg.Id] || [];
    setChats(p => ({...p, [lg.Id]: [...(p[lg.Id] || []), {role: "user", text: q}]}));
    setChatInput("");
    setChatBusy(true);
    try {
      const body = await ensureBody(lg);
      const transcript = hist.slice(-6)
        .map(m => `${m.role === "user" ? "Question" : "Assistant"}: ${m.text}`).join("\n");
      const prompt = `DEBUG LOG:\n${logsExcerpt(lg, body, 12000)}\n\n` +
        (transcript ? `EARLIER IN THIS CONVERSATION:\n${transcript}\n\n` : "") +
        `QUESTION: ${q}`;
      const answer = await logsAskLlm(LOGS_CHAT_SYSTEM, prompt);
      setChats(p => ({...p, [lg.Id]: [...(p[lg.Id] || []), {role: "ai", text: answer}]}));
    } catch (e) {
      setChats(p => ({...p, [lg.Id]: [...(p[lg.Id] || []),
        {role: "err", text: e.message === "NO_LLM_CONFIG"
          ? "No AI provider configured — open Options to set one up."
          : e.message}]}));
    } finally {
      setChatBusy(false);
    }
  };

  const deleteLog = async (lg) => {
    setDelBusy(lg.Id);
    setLogsErr(null);
    setDelResult(null);
    try {
      await logsDeleteApexLog(lg.Id);
      setLogs(prev => prev.filter(l => l.Id !== lg.Id));
      if (selId === lg.Id) setSelId(null);
      if (openLog && openLog.id === lg.Id) setOpenLog(null);
      setDelResult({ok: true, text: `Log ${lg.Id} deleted.`});
    } catch (e) {
      setDelResult({ok: false, text: `Could not delete ${lg.Id}: ${e.message}`});
    } finally {
      setDelBusy(null);
    }
  };

  const deleteAllLogs = async () => {
    if (delAllText.trim().toUpperCase() !== "DELETE" || !logs.length) return;
    const targets = [...logs];
    setDelAllBusy(true);
    setDelResult(null);
    setDelProgress(`0/${targets.length}`);
    let ok = 0;
    const failed = [];
    let done = 0;
    for (let i = 0; i < targets.length; i += 4) {
      const chunk = targets.slice(i, i + 4);
      await Promise.all(chunk.map(async lg => {
        try { await logsDeleteApexLog(lg.Id); ok++; }
        catch (e) { failed.push(lg.Id); }
        finally {
          done++;
          setDelProgress(`${done}/${targets.length}`);
        }
      }));
    }
    // Only rows that really failed are kept — no false green.
    setLogs(prev => prev.filter(l => failed.includes(l.Id)));
    setSelId(null);
    setOpenLog(null);
    setMatched(null);
    setAnalyses({});
    setChats({});
    setDelAllBusy(false);
    setDelAllOpen(false);
    setDelAllText("");
    setDelProgress(null);
    setDelResult(failed.length
      ? {ok: false, text: `Deleted ${ok} of ${targets.length} log(s). Failed: ` +
          `${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}.`}
      : {ok: true, text: `Deleted ${ok} log(s).`});
  };

  const copyAnalysis = async () => {
    try {
      const text = selAnalysis && selAnalysis.text ? selAnalysis.text : "";
      await safeCopyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) { /* clipboard unavailable */ }
  };

  const openSettings = () => {
    try {
      chrome.runtime.sendMessage({message: "openOptions", host: ""});
    } catch (e) { /* extension context only */ }
  };

  const isUser = entityType === "User";
  const selected = logs.find(l => l.Id === selId) || null;
  const matchedSet = matched ? new Set(matched) : null;
  const matchedCount = matched ? matched.filter(id => logs.some(l => l.Id === id)).length : 0;
  const selAnalysis = selected ? analyses[selected.Id] : null;
  const selChat = selected ? (chats[selected.Id] || []) : [];

  return h("div", null,
    h("div", {className: "insp-kv"},
      h("div", {className: "insp-kv-title"}, "Create / manage trace flags"),
      h("div", {className: "insp-toolbar insp-toolbar-wrap"},
        h("label", {className: "insp-field"},
          h("span", null, "Entity type"),
          h("select", {
            value: entityType,
            onChange: e => {
              setEntityType(e.target.value);
              setEntity(null);
              setLookupText("");
              setLookupRes([]);
              setLookupErr(null);
            }
          },
            h("option", {value: "User"}, "User"),
            h("option", {value: "ApexClass"}, "Apex class")
          )
        ),
        h("label", {className: "insp-field insp-field-grow"},
          h("span", null, isUser ? "User name" : "Apex class name"),
          h("input", {
            value: entity ? `${entity.name}${entity.sub ? " — " + entity.sub : ""}` : lookupText,
            placeholder: isUser ? "Type a name or username…" : "Type a class name…",
            onChange: e => {
              setEntity(null);
              setLookupText(e.target.value);
              setLookupRes([]);
              setLookupErr(null);
            }
          })
        ),
        isUser && h("button", {
          className: "btn btn-secondary btn-sm",
          title: "Trace the currently logged-in user",
          onClick: useMe
        }, "Use me"),
        h("label", {className: "insp-field"},
          h("span", null, "Start"),
          h("input", {type: "datetime-local", value: start, onChange: e => setStart(e.target.value)})
        ),
        h("label", {className: "insp-field"},
          h("span", null, "End"),
          h("input", {type: "datetime-local", value: end, onChange: e => setEnd(e.target.value)})
        ),
        h("label", {className: "insp-field"},
          h("span", null, "Debug level"),
          h("select", {value: levelId, onChange: e => setLevelId(e.target.value)},
            levels.length
              ? levels.map(l =>
                  h("option", {key: l.Id, value: l.Id}, l.MasterLabel || l.DeveloperName))
              : h("option", {value: ""}, "Loading…")
          )
        ),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: creating || !entity,
          title: entityType === "User"
            ? "Create a USER_DEBUG trace flag for this user"
            : "Create a CLASS_TRACING trace flag for this class",
          onClick: createFlag
        }, creating ? "Creating…" : "Create trace flag")
      ),
      lookupRes.length > 0 && h("div", {className: "insp-lookup-list"},
        lookupRes.map(r =>
          h("button", {key: r.id, className: "insp-lookup-item", onClick: () => pickEntity(r)},
            h("span", {className: "insp-lookup-name"}, r.name),
            r.sub && h("span", {className: "insp-lookup-sub"}, r.sub)
          )
        )
      ),
      lookupBusy && h("div", {className: "insp-meta"}, "Searching…"),
      lookupErr && h("div", {className: "insp-warn"}, lookupErr),
      formErr && h("div", {className: "insp-error"}, formErr),
      formMsg && h("div", {className: "insp-ok"}, formMsg),
      entity && h("div", null,
        h("div", {className: "insp-meta"},
          flags.length
            ? `${flags.length} trace flag(s) for ${entity.name}`
            : `No trace flags for ${entity.name}`),
        flags.length > 0 && h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null,
              h("tr", null,
                ["Log type", "Level", "Start", "Expires", ""].map((c, i) =>
                  h("th", {key: i}, c))
              )
            ),
            h("tbody", null,
              flags.map(f =>
                h("tr", {key: f.Id},
                  h("td", null, f.LogType),
                  h("td", null, levelLabel(f.DebugLevelId)),
                  h("td", {className: "insp-nowrap"}, ffFmtTs(f.StartDate)),
                  h("td", {className: "insp-nowrap"}, ffFmtTs(f.ExpirationDate)),
                  h("td", null, h("button", {
                    className: "btn btn-secondary btn-sm",
                    disabled: flagBusy === f.Id,
                    onClick: () => deleteFlag(f.Id)
                  }, flagBusy === f.Id ? "Deleting…" : "Delete"))
                )
              )
            )
          )
        )
      )
    ),
    h("div", {className: "logs-panel"},
      h("div", {className: "logs-head"},
        h("div", {className: "logs-title"},
          h("strong", null, "Debug Logs"),
          h("span", {className: "insp-meta"},
            logs.length
              ? ` (${logs.length} loaded${hasMore ? "+" : ""}` +
                `${matched ? ` · ${matchedCount} matched` : ""})`
              : "")
        ),
        h("input", {
          className: "logs-search",
          value: search,
          placeholder: "Search string across all loaded debug logs…",
          onChange: e => {
            setSearch(e.target.value);
            if (matched) setMatched(null);
          },
          onKeyDown: e => { if (e.key === "Enter") searchLogs(); }
        }),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: searchBusy || !logs.length || !search.trim(),
          onClick: searchLogs
        }, searchBusy ? "Searching…" : "Search"),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: logsBusy || loadingMore,
          onClick: loadLogs
        }, logsBusy ? "Loading…" : "Load logs"),
        h("button", {
          className: "btn btn-danger btn-sm",
          disabled: !logs.length || delAllBusy,
          onClick: () => setDelAllOpen(!delAllOpen)
        }, delAllOpen ? "Cancel" : "Delete All Logs")
      ),
      delAllOpen && h("div", {className: "logs-confirm"},
        h("span", null, `Type DELETE to remove all ${logs.length} loaded log(s) from this org:`),
        h("input", {
          value: delAllText,
          placeholder: "DELETE",
          onChange: e => setDelAllText(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") deleteAllLogs(); }
        }),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: delAllText.trim().toUpperCase() !== "DELETE" || delAllBusy,
          onClick: deleteAllLogs
        }, delAllBusy ? "Deleting…" : "Delete")
      ),
      delAllBusy && delProgress && h("div", {className: "insp-meta"}, `Deleting… ${delProgress}`),
      logsNote && h("div", {className: "insp-warn"}, logsNote),
      logsErr && h("div", {className: "insp-error"}, logsErr),
      delResult && h("div", {className: delResult.ok ? "insp-ok" : "insp-error"}, delResult.text),
      searchBusy && h("div", {className: "insp-meta"},
        `Fetching log bodies… (up to ${LOGS_SEARCH_CAP} logs)`),
      logsBusy && h("div", {className: "insp-meta"}, "Querying ApexLog…"),
      !logsBusy && !logs.length && !logsErr && !logsNote &&
        h("div", {className: "insp-empty"},
          "No logs loaded yet — set a time window above and click Load logs."),
      logs.length > 0 && h("div", {className: "logs-grid"},
        h("div", {className: "logs-list"},
          logs.map(lg => {
            const hit = matchedSet ? matchedSet.has(lg.Id) : null;
            const dim = matchedSet && !hit;
            const kind = logsStatusKind(lg.Status);
            const unit = bodies[lg.Id] != null ? logsHeadUnit(bodies[lg.Id]) : null;
            const a = analyses[lg.Id];
            return h("div", {
              key: lg.Id,
              className: `logs-card${selId === lg.Id ? " active" : ""}${dim ? " dim" : ""}`,
              onClick: () => setSelId(lg.Id)
            },
              h("div", {className: "logs-card-hd"},
                h("span", {className: "logs-card-id"}, `Log · ${String(lg.Id).slice(-8)}`),
                h("span", {className: "logs-card-time"}, ffFmtTs(lg.StartTime)),
                a && a.text && h("span", {className: "logs-card-ai"}, "AI ✓"),
                hit && h("span", {className: "insp-badge-match"}, "MATCH")
              ),
              h("div", {className: "logs-card-sub"},
                unit || `${lg.Request || "—"} · ${lg.Application || "—"}`
              ),
              h("div", {className: "logs-card-meta"},
                h("span", {className: `logs-status logs-status-${kind}`}, lg.Status || "Unknown"),
                h("span", null, `User: ${logsUserName(lg) || "—"}`),
                lg.Operation && h("span", null, `Op: ${lg.Operation}`),
                lg.DurationMilliseconds != null &&
                  h("span", null, `${lg.DurationMilliseconds} ms`),
                lg.LogLength != null &&
                  h("span", null, `${Math.max(1, Math.round(lg.LogLength / 1024))} KB`)
              ),
              h("div", {className: "logs-card-actions", onClick: e => e.stopPropagation()},
                h("button", {
                  className: "btn btn-secondary btn-sm" +
                    (analyzingId === lg.Id ? " btn-busy" : (a && a.text ? " btn-ok" : "")),
                  disabled: analyzingId === lg.Id,
                  title: a && a.text
                    ? "Already analyzed — click to show the saved result (no new AI call)"
                    : "Plain-English analysis of this log",
                  onClick: () => analyzeLog(lg)
                }, analyzingId === lg.Id
                  ? "Analyzing…"
                  : (a && a.text) ? "✓ Analyzed" : "⚡ Analyze"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => {
                    setSelId(lg.Id);
                    // Focus after re-render — chatRef is null until the pane
                    // has a selected log to render the chat input for.
                    requestAnimationFrame(() => {
                      if (aiRef.current && aiRef.current.scrollIntoView) {
                        aiRef.current.scrollIntoView({block: "nearest", behavior: "smooth"});
                      }
                      if (chatRef.current) chatRef.current.focus();
                    });
                  }
                }, "💬 Ask AI"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => viewLog(lg)
                }, "View"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => downloadLog(lg)
                }, "Download"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  disabled: delBusy === lg.Id,
                  onClick: () => deleteLog(lg)
                }, delBusy === lg.Id ? "Deleting…" : "Delete")
              )
            );
          }),
          hasMore && h("div", {className: "logs-more"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: loadingMore,
              onClick: loadMore
            }, loadingMore ? "Loading…" : `Load more (${LOGS_PAGE})`),
            h("span", {className: "insp-meta"}, `Showing ${logs.length}`)
          )
        ),
        h("div", {className: "logs-ai", ref: aiRef},
          !selected && h("div", {className: "insp-empty"},
            "Select a log on the left → ⚡ Analyze, or ask a question about it."),
          selected && h("div", null,
            h("div", {className: "logs-ai-title"},
              "🤖 SaralAI · ",
              h("span", {className: "logs-ai-id"}, `Log ${selected.Id}`)
            ),
            h("div", {className: "logs-ai-section"},
              h("div", {className: "logs-ai-h"},
                h("span", null, "⚡ AI Quick Analysis (Plain English)"),
                h("button", {
                  className: "field-action-btn",
                  disabled: analyzingId === selected.Id,
                  title: selAnalysis && selAnalysis.text
                    ? "The saved result is already shown — this sends the log to the AI again (uses tokens)"
                    : "Ask the AI to analyze this log",
                  onClick: () => analyzeLog(selected, true)
                }, selAnalysis && selAnalysis.text ? "↻ Re-run (new AI call)" : "Analyze")
              ),
              selAnalysis && selAnalysis.text &&
                h("div", {className: "insp-status-ok"},
                  "Saved result shown — no AI call made."),
              selAnalysis && selAnalysis.pending &&
                h("div", {className: "insp-status-info"}, "Reading the log and asking the AI…"),
              selAnalysis && selAnalysis.error === "NO_LLM_CONFIG" &&
                h("div", {className: "insp-error"},
                  "No AI provider configured — set one up in Options to use the AI panel.",
                  h("button", {
                    className: "field-action-btn",
                    style: {marginLeft: "8px"},
                    onClick: openSettings
                  }, "Open Settings")
                ),
              selAnalysis && selAnalysis.error && selAnalysis.error !== "NO_LLM_CONFIG" &&
                h("div", {className: "insp-error"}, selAnalysis.error),
              selAnalysis && selAnalysis.text && h(AnalysisReport, {
                text: selAnalysis.text,
                copied,
                onCopy: copyAnalysis
              })
            ),
            h("div", {className: "logs-ai-section"},
              h("div", {className: "logs-ai-h"}, "💬 Ask AI About This Log"),
              h("div", {className: "logs-chat"},
                selChat.length === 0 && !chatBusy &&
                  h("div", {className: "insp-meta"},
                    "Ask what an error means, where it came from, or how to fix it…"),
                selChat.map((m, i) =>
                  h("div", {key: i, className: `logs-bubble logs-bubble-${m.role}`}, m.text)),
                chatBusy && h("div", {className: "logs-bubble logs-bubble-status"}, "…")
              ),
              h("div", {className: "logs-chat-row"},
                h("input", {
                  ref: chatRef,
                  value: chatInput,
                  placeholder: "Type your question here…",
                  disabled: chatBusy,
                  onChange: e => setChatInput(e.target.value),
                  onKeyDown: e => { if (e.key === "Enter") askAboutLog(selected, chatInput); }
                }),
                h("button", {
                  className: "btn btn-primary btn-sm",
                  disabled: chatBusy || !chatInput.trim(),
                  onClick: () => askAboutLog(selected, chatInput)
                }, chatBusy ? "…" : "Ask")
              )
            )
          )
        )
      ),
      openLog && (() => {
        const allRows = parseApexLog(openLog.text);
        const events = [...new Set(allRows.map(r => r.event).filter(Boolean))].sort();
        const f = logFilter.trim().toLowerCase();
        const shown = allRows.filter(r =>
          (!debugOnly || r.event === "USER_DEBUG") &&
          (!f || `${r.ts} ${r.event} ${r.details}`.toLowerCase().includes(f)));
        return h("div", {ref: logDataRef, style: {marginTop: "12px"}},
          h("div", {className: "insp-toolbar insp-toolbar-wrap"},
            h("span", {className: "insp-meta"},
              `Log ${openLog.name} · ${allRows.length} lines`),
            h("label", {className: "insp-check", title: "Show only USER_DEBUG lines (your System.debug output)"},
              h("input", {
                type: "checkbox",
                checked: debugOnly,
                onChange: e => {
                  const v = e.target.checked;
                  setDebugOnly(v);
                  // Debug Only means USER_DEBUG — drop the competing filter so
                  // rows can't be filtered away twice (dropdown shares logFilter).
                  if (v) setLogFilter("");
                }
              }),
              h("span", null, "Debug Only")
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Event"),
              h("select", {value: logFilter && !events.includes(logFilter) ? "" : logFilter,
                onChange: e => setLogFilter(e.target.value)},
                h("option", {value: ""}, `All events (${events.length})`),
                events.map(ev =>
                  h("option", {key: ev, value: ev},
                    `${ev} (${allRows.filter(r => r.event === ev).length})`))
              )
            ),
            h("label", {className: "insp-field insp-field-grow"},
              h("span", null, "Filter"),
              h("input", {
                value: logFilter,
                placeholder: "Click here to filter the log",
                onChange: e => setLogFilter(e.target.value)
              })
            ),
            h("span", {className: "insp-meta"}, `${shown.length}/${allRows.length} lines`),
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: () => downloadText(`${openLog.name}.log`, openLog.text, "text/plain")
            }, "Download"),
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: () => setOpenLog(null)
            }, "Close")
          ),
          h(ResultTable, {
            columns: ["Timestamp", "Event", "Details"],
            rows: shown.map(r => ({Timestamp: r.ts, Event: r.event, Details: r.details})),
            maxRows: 2000,
            cellFmt: {
              Event: v => h("span", {className: "ff-log-ev", title: String(v)}, String(v)),
              Details: v => h("span", {className: "ff-log-det", title: String(v)}, String(v))
            }
          }),
          h("details", {className: "insp-details"},
            h("summary", null, "Raw log"),
            h("pre", {className: "insp-log"}, openLog.text)
          )
        );
      })()
    )
  );
}

export function InspectorPanel() {
  const [tab, setTab] = ffUseSession("inspector", "tab", "soql");
  const tabs = [
    {id: "soql", label: "SOQL"},
    {id: "apex", label: "Run-Apex"},
    {id: "records", label: "Records"},
    {id: "export", label: "Export"},
    {id: "import", label: "Import"},
    {id: "users", label: "Users"},
    {id: "logs", label: "Logs"},
    {id: "org", label: "Org Info"},
    {id: "apptabs", label: "App Tabs"}
  ];
  // A restored snapshot may name a tab id that no longer exists.
  const active = tabs.some(t => t.id === tab) ? tab : "soql";
  const pickTab = id => {
    if (id !== tab) {
      setTab(id);
      // Tab content heights differ — start each tab at the top.
      const body = document.querySelector(".inspector-body");
      if (body) body.scrollTop = 0;
    }
  };
  // The pill bar lives OUTSIDE the scroller (shell = nav + body) so it can
  // never scroll away with the content.
  return h("div", {className: "insp-shell"},
    h("div", {className: "insp-tabs"},
      tabs.map(t =>
        h("button", {
          key: t.id,
          className: `insp-tab ${active === t.id ? "active" : ""}`,
          onClick: () => pickTab(t.id)
        }, t.label)
      )
    ),
    h("div", {className: "inspector-body"},
      active === "soql" && h(SoqlTab),
      active === "apex" && h(ApexTab),
      active === "records" && h(RecordsTab),
      active === "export" && h(ExportTab),
      active === "import" && h(ImportTab),
      active === "users" && h(UsersTab),
      active === "logs" && h(LogsTab),
      active === "org" && h(OrgTab),
      active === "apptabs" && h(AppTabsTab)
    )
  );
}
