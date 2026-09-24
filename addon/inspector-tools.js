import {sfConn, apiVersion} from "./inspector.js";
import {getSavedConfig, getLLMProvider, hasValidConfig} from "./llm/llm-service.js";

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

function ResultTable({columns, rows, maxRows, onRowClick, rowHint}) {
  const shown = rows.slice(0, maxRows || 200);
  if (!columns.length) return h("div", {className: "insp-empty"}, "No rows");
  return h("div", {className: "insp-table-wrap"},
    h("table", {className: "insp-table"},
      h("thead", null,
        h("tr", null, columns.map(c => h("th", {key: c}, c)))
      ),
      h("tbody", null,
        shown.map((row, i) =>
          h("tr", {
            key: i,
            className: onRowClick ? "insp-row-click" : "",
            title: onRowClick ? (rowHint || "Click to show all data") : undefined,
            onClick: onRowClick ? () => onRowClick(row, i) : undefined
          },
            columns.map(c =>
              h("td", {key: c, title: row[c] == null ? "" : String(row[c])},
                row[c] == null ? "" : String(row[c]))
            )
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

// ─── SOQL tab ───────────────────────────────────────────────
function SoqlTab() {
  const [query, setQuery] = React.useState("SELECT Id, Name FROM Account LIMIT 50");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [limit, setLimit] = React.useState(500);
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
  const taRef = React.useRef(null);

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
    try {
      const r = await runSoql(q, limit);
      const flat = r.records.map(flattenRecord);
      const colSet = new Set();
      flat.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      setResult({...r, rows: flat, columns: [...colSet]});
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
  const objChips = objects
    .filter(o => {
      const f = (trailingFrom ? trailingFrom[1] : objFilter).toLowerCase();
      return !f || o.name.toLowerCase().includes(f) || (o.label || "").toLowerCase().includes(f);
    })
    .slice(0, 24);

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-check", title: "When a query fails, ask the configured LLM to explain the issue and suggest a fixed query"},
        h("input", {
          type: "checkbox",
          checked: !!useLlm,
          onChange: e => {
            setUseLlm(e.target.checked);
            ffSaveJson("ff_soql_use_llm", e.target.checked);
          }
        }),
        h("span", null, "✨ Use LLM")
      ),
      h("label", {className: "insp-field"},
        h("span", null, "Saved queries"),
        h("select", {
          value: "",
          onChange: e => {
            const hit = saved.find(s => s.label === e.target.value);
            if (hit) setQuery(hit.q);
            e.target.value = "";
          }
        },
          h("option", {value: ""}, saved.length ? "— load —" : "No saved queries"),
          saved.map(s => h("option", {key: s.label, value: s.label}, s.label))
        )
      ),
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Save current as"),
        h("input", {
          value: saveLabel,
          placeholder: "Query label",
          onChange: e => setSaveLabel(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") saveCurrent(); }
        })
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: !query.trim(),
        onClick: saveCurrent
      }, "Save Query"),
      h("label", {className: "insp-field"},
        h("span", null, "History"),
        h("select", {
          value: "",
          onChange: e => {
            if (e.target.value) { setQuery(e.target.value); run(e.target.value); }
            e.target.value = "";
          }
        },
          h("option", {value: ""}, history.length ? "— recent —" : "No history yet"),
          history.map((hh, i) =>
            h("option", {key: i, value: hh.q},
              `${new Date(hh.ts).toLocaleString()} — ${hh.q.slice(0, 60)}`)
          )
        )
      )
    ),
    h("div", {className: "insp-toolbar"},
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
        className: "btn btn-primary btn-sm",
        disabled: loading,
        onClick: () => run()
      }, loading ? "Running…" : "Run SOQL"),
      result && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: exportCsv
      }, "Export CSV"),
      (history.length > 0 || saved.length > 0) && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: clearHistory,
        title: "Clear recent query history"
      }, "Clear history")
    ),
    h("textarea", {
      ref: taRef,
      className: "insp-soql",
      value: query,
      spellCheck: false,
      onChange: e => setQuery(e.target.value),
      onKeyDown: e => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
      },
      placeholder: "SELECT Id, Name FROM Account LIMIT 50"
    }),
    saved.length > 0 && h("div", {className: "insp-chips-row"},
      h("span", {className: "insp-chips-label"}, "Saved:"),
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
    ),
    h("div", {className: "insp-chips-row"},
      h("span", {className: "insp-chips-label"},
        fromFields ? `Fields of ${fromObj}:` : "Objects:"),
      h("input", {
        className: "insp-chips-filter",
        value: objFilter,
        placeholder: fromFields ? "filter fields…" : "filter objects…",
        onChange: e => setObjFilter(e.target.value)
      })
    ),
    h("div", {className: "insp-chips"},
      (fromFields
        ? fromFields
            .filter(f => !objFilter ||
              f.name.toLowerCase().includes(objFilter.toLowerCase()) ||
              (f.label || "").toLowerCase().includes(objFilter.toLowerCase()))
            .slice(0, 30)
            .map(f => h("button", {
              key: f.name,
              className: "insp-chip",
              title: `${f.label} · ${f.type} — click to insert`,
              onClick: () => insertAtCursor(f.name)
            }, f.name))
        : objChips.map(o => h("button", {
            key: o.name,
            className: "insp-chip",
            title: `${o.label} — click to insert`,
            onClick: () => insertAtCursor(trailingFrom ? o.name.slice(trailingFrom[1].length) + " " : ` ${o.name}`)
          }, o.name))
      ),
      fromFields && h("button", {
        className: "insp-chip insp-chip-alt",
        onClick: () => setFromFields(null),
        title: "Back to object suggestions"
      }, "← objects")
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
            try { await navigator.clipboard.writeText(suggestion.fixedQuery); }
            catch (e) { /* ignore */ }
          }
        }, "Copy")
      )
    ),
    result && h("div", {className: "insp-meta"},
      `${result.totalSize} row(s) · pages OK · query ends LIMIT ${/\blimit\s+(\d+)/i.exec(result.query)?.[1] || "—"}`
    ),
    result && h(ResultTable, {columns: result.columns, rows: result.rows, maxRows: 300})
  );
}

// ─── Data Export tab ────────────────────────────────────────
function ExportTab() {
  const [objectApi, setObjectApi] = React.useState("");
  const [fields, setFields] = React.useState("Id, Name");
  const [where, setWhere] = React.useState("");
  const [limit, setLimit] = React.useState(10000);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [meta, setMeta] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
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
  const [objectApi, setObjectApi] = React.useState("");
  const [csvText, setCsvText] = React.useState("");
  const [headers, setHeaders] = React.useState([]);
  const [records, setRecords] = React.useState([]);
  const [fieldMap, setFieldMap] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);

  const onFile = async (file) => {
    setError(null);
    setResult(null);
    if (!file) return;
    const text = await file.text();
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
    const base = file.name.replace(/\.[^.]+$/, "");
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) setObjectApi(prev => prev || base);
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
  const [info, setInfo] = React.useState(null);

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

      setInfo({
        org: org.records && org.records[0] ? org.records[0] : null,
        limits: limits || null,
        user,
        customObjects: counts
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, []);

  const rows = [];
  if (info?.org) {
    const o = info.org;
    rows.push(["Org Name", o.Name]);
    rows.push(["Instance", o.InstanceName]);
    rows.push(["Type", o.OrganizationType]);
    rows.push(["Sandbox", o.IsSandbox ? "Yes" : "No"]);
    rows.push(["Locale", o.DefaultLocaleSidKey]);
    rows.push(["Fiscal year starts", o.FiscalYearStartMonth]);
    if (o.TrialExpirationDate) rows.push(["Trial expires", o.TrialExpirationDate]);
  }
  if (info?.user) {
    const u = info.user;
    rows.push(["User", u.preferred_username || u.username || u.Email || u.name || ""]);
    if (u.organization_id) rows.push(["Org Id", u.organization_id]);
    if (u.user_id || u.Id) rows.push(["User Id", u.user_id || u.Id]);
  }
  if (info?.customObjects != null) rows.push(["Customizable objects", String(info.customObjects)]);

  const limitRows = [];
  if (info?.limits) {
    const L = info.limits;
    const aliases = [
      ["Data Storage", ["DataStorage"]],
      ["File Storage", ["FileStorage"]],
      ["Daily API requests", ["DailyApiRequests"]],
      ["Daily Bulk API", ["DailyBulkApiRequests"]],
      ["Daily Streaming events", ["DailyStreamingApiEvents"]],
      ["Daily Scratch Orgs", ["DailyScratchOrgs"]],
      ["Concurrent Async GET", ["ConcurrentAsyncGet"]],
      ["Daily Workspace Node Count", ["DailyWorkspaceNodeCount"]]
    ];
    for (const [label, keys] of aliases) {
      let bucket = null;
      for (const k of keys) bucket = L[k] || bucket;
      if (bucket && typeof bucket === "object") {
        limitRows.push([
          label,
          bucket.Max != null
            ? `max ${bucket.Max}` + (bucket.Remaining != null ? ` · remaining ${bucket.Remaining}` : "")
            : JSON.stringify(bucket)
        ]);
      }
    }
  }

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-toolbar"},
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: loading,
        onClick: load
      }, loading ? "Loading…" : "Refresh org info")
    ),
    error && h("div", {className: "insp-error"}, error),
    info && h("div", {className: "insp-kv"},
      h("div", {className: "insp-kv-title"}, "Organization"),
      rows.map(([k, v]) =>
        h("div", {key: k, className: "insp-kv-row"},
          h("span", {className: "insp-kv-k"}, k),
          h("span", {className: "insp-kv-v"}, v == null || v === "" ? "—" : String(v))
        )
      )
    ),
    limitRows.length > 0 && h("div", {className: "insp-kv"},
      h("div", {className: "insp-kv-title"}, "Limits"),
      limitRows.map(([k, v]) =>
        h("div", {key: k, className: "insp-kv-row"},
          h("span", {className: "insp-kv-k"}, k),
          h("span", {className: "insp-kv-v"}, v)
        )
      )
    )
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

function RecordsTab() {
  const [objects, setObjects] = React.useState([]);
  const [objLoading, setObjLoading] = React.useState(false);
  const [objInput, setObjInput] = React.useState("");
  const [fields, setFields] = React.useState([]);
  const [checked, setChecked] = React.useState([]);
  const [descLoading, setDescLoading] = React.useState(false);
  const [rows, setRows] = React.useState([]);
  const [columns, setColumns] = React.useState([]);
  const [totalSize, setTotalSize] = React.useState(null);
  const [nextUrl, setNextUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

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
        name: f.name, label: f.label, type: f.type
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

  // "Show all data": fetch the FULL record (REST retrieve returns every
  // field) and render Field API Name | Label | Type | Value.
  const openDetail = async (row) => {
    const obj = objInput.trim();
    const id = row && (row.Id || row.id);
    if (!obj || !id) return;
    setDetailLoading(true);
    setError(null);
    try {
      const rec = await sfConn.rest(
        `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(obj)}/${encodeURIComponent(id)}`,
        {useCache: false});
      const meta = {};
      for (const f of fields) meta[f.name] = f;
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
          value: value == null || value === "" ? null : String(value)
        });
      }
      detailRows.sort((a, b) => a.api.localeCompare(b.api));
      setDetail({id, obj, rows: detailRows});
    } catch (e) {
      setError(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  return h("div", {className: "insp-panel"},
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
    (detailLoading || detail) && h("div", {className: "insp-detail"},
      h("div", {className: "insp-toolbar"},
        h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: () => setDetail(null)
        }, "← Back to list"),
        detail && h("span", {className: "insp-meta"},
          `Show all data: ${detail.obj} / ${detail.id} (${detail.rows.length} fields)`)
      ),
      detailLoading && h("div", {className: "insp-meta"}, "Loading full record…"),
      detail && h("div", {className: "insp-table-wrap"},
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
            detail.rows.map(r =>
              h("tr", {key: r.api},
                h("td", null, r.api),
                h("td", null, r.label),
                h("td", null, r.type),
                h("td", {
                  className: r.value == null ? "insp-blank" : "",
                  title: r.value == null ? "" : r.value
                }, r.value == null ? "(Blank)" : r.value)
              )
            )
          )
        )
      )
    )
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
      console.warn("[ForceForge] AppTabs identity lookup failed for", u, e.message);
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
    console.warn("[ForceForge] AppTabs profile listMetadata failed:", e.message);
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
    console.warn("[ForceForge] AppTabs tab-exists listMetadata failed:", e.message);
  }
  try {
    const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
      encodeURIComponent(
        `SELECT DeveloperName FROM CustomTab WHERE DeveloperName = '${String(tabApiName).trim().replace(/'/g, "\\'")}' LIMIT 1`),
      {useCache: false});
    if (res.records && res.records.length) return true;
  } catch (e) {
    console.warn("[ForceForge] AppTabs tab-exists Tooling failed:", e.message);
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
      console.warn("[ForceForge] AppTabs Tooling query failed:", e.message);
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
          console.log(`[ForceForge] AppTabs standard prefix: ${a.fullName} → ${prefixed}`);
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
    console.warn("[ForceForge] AppTabs listMetadata reconcile failed:", e.message);
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
      console.warn("[ForceForge] AppTabs CustomTab query failed:", e.message);
    }
  }
  try {
    const names = await appTabsListMetadataFullNames("CustomTab");
    for (const n of names) push(n, n);
  } catch (e) {
    console.warn("[ForceForge] AppTabs listMetadata CustomTab failed:", e.message);
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
  const [apps, setApps] = React.useState([]);
  const [appsLoading, setAppsLoading] = React.useState(false);
  const [sel, setSel] = React.useState("");
  const [customTabs, setCustomTabs] = React.useState([]);
  const [tabsLoading, setTabsLoading] = React.useState(false);
  const [tabName, setTabName] = React.useState("");
  const [currentTabs, setCurrentTabs] = React.useState(null);
  const [currentLoading, setCurrentLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [visWorking, setVisWorking] = React.useState(false);
  const [resolving, setResolving] = React.useState(false);
  const [appRef, setAppRef] = React.useState("");
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
      console.log(`[ForceForge] AppTabs read "${realName}": tabs=[${existing.join(", ")}]`);
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
          console.log(`[ForceForge] AppTabs workspace mappings ensured for console app (${mapped.size} mapped)`);
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
          console.log(`[ForceForge] AppTabs retrying update as "${writeName}"`);
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
        console.log(`[ForceForge] AppTabs verify "${writeName}" attempt ${i + 1}: tabs=[${postTabs.join(", ")}]`);
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
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    } catch (e) { /* ignore */ }
  };

  const selApp = apps.find(a => a.fullName === sel);
  const selLabel = (selApp || {}).label || sel;
  const dupes = selApp ? apps.filter(a => a.label === selApp.label) : [];

  return h("div", {className: "insp-panel"},
    h("p", {className: "app-section-hint"},
      "Standalone tool — no deploy needed. Pick the app by its metadata Developer Name (from Tooling, not the display label), pick or type the tab API name, then add. Every write is verified by re-reading the app metadata."
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
      ),
      h("button", {
        className: "btn btn-secondary btn-sm",
        disabled: appsLoading || tabsLoading || working,
        onClick: loadAll
      }, (appsLoading || tabsLoading) ? "Loading…" : "Reload apps + tabs")
    ),
    dupes.length > 1 && h("div", {className: "insp-warn"},
      `Warning: ${dupes.length} apps share the label "${selApp.label}" (${dupes.map(a => a.fullName).join(", ")}). ` +
      `Only the exact DeveloperName you update will change. Use the resolver below to pin the one you actually open.`
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Exact app? paste its App Manager URL or record Id"),
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
      sel && h("span", {className: "insp-meta"}, `Target: ${selLabel} → ${sel}`)
    ),
    currentTabs && h("div", {className: "insp-meta"},
      `Current tabs on ${sel} (${currentTabs.length}): ${currentTabs.join(", ") || "none"}`
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

function UsersTab() {
  const [q, setQ] = React.useState("");
  const [users, setUsers] = React.useState([]);
  const [userCols, setUserCols] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sel, setSel] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState(null);
  const [actionErr, setActionErr] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const search = async () => {
    setError(null);
    setSel(null);
    setDetail(null);
    const term = ffSoqlEscape(q.trim());
    if (!term) { setError("Type a name, username, email or alias"); return; }
    setLoading(true);
    try {
      const soql = `SELECT Id, Name, Username, Email, Alias, IsActive, ProfileId, LanguageLocaleKey ` +
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
    setDetailLoading(true);
    try {
      const [rec, prof] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${encodeURIComponent(row.Id)}`,
          {useCache: false}).catch(() => null),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${row.ProfileId}'`),
          {useCache: false}).catch(() => null)
      ]);
      setDetail({
        profile: prof && prof.records && prof.records[0] ? prof.records[0].Name : "unknown",
        lastLogin: rec && rec.LastLoginDate ? rec.LastLoginDate : null,
        created: rec && rec.CreatedDate ? rec.CreatedDate : null
      });
    } catch (e) {
      setDetail({profile: "unknown", lastLogin: null, created: null});
    } finally {
      setDetailLoading(false);
    }
  };

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
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sel.Id);
      setActionMsg(`Copied Id ${sel.Id}`);
    } catch (e) {
      setActionErr(e.message);
    }
  };

  return h("div", {className: "insp-panel"},
    h("p", {className: "app-section-hint"},
      "Search users, inspect details, log in as a user, or capture debug logs — all without leaving the extension."
    ),
    h("div", {className: "insp-toolbar insp-toolbar-wrap"},
      h("label", {className: "insp-field insp-field-grow"},
        h("span", null, "Name, username, email or alias"),
        h("input", {
          value: q,
          placeholder: "e.g. shiva or user@org.com",
          disabled: loading,
          onChange: e => setQ(e.target.value),
          onKeyDown: e => { if (e.key === "Enter") search(); }
        })
      ),
      h("button", {
        className: "btn btn-primary btn-sm",
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
      rowHint: "Click to select user"
    }),
    sel && h("div", {className: "insp-kv"},
      h("div", {className: "insp-kv-title"}, `User: ${sel.Name} (${sel.Alias})`),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "Username"),
        h("span", {className: "insp-kv-v"}, sel.Username)),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "Id"),
        h("span", {className: "insp-kv-v"}, sel.Id)),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "E-mail"),
        h("span", {className: "insp-kv-v"}, sel.Email || "—")),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "Profile"),
        h("span", {className: "insp-kv-v"},
          detailLoading ? "…" : (detail ? detail.profile : "—"))),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "Language"),
        h("span", {className: "insp-kv-v"}, sel.Language || "—")),
      h("div", {className: "insp-kv-row"},
        h("span", {className: "insp-kv-k"}, "Last login"),
        h("span", {className: "insp-kv-v"},
          detailLoading ? "…" : (detail && detail.lastLogin ? detail.lastLogin : "—"))),
      h("div", {className: "insp-toolbar insp-toolbar-wrap", style: {marginTop: "8px", marginBottom: "0"}},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: busy === "login",
          onClick: () => loginAs(false)
        }, busy === "login" ? "Opening…" : "Login As"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: busy === "logs",
          title: "Create a 30-minute USER_DEBUG trace flag for this user",
          onClick: enableLogs
        }, busy === "logs" ? "Enabling…" : "Enable Logs"),
        h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: copyId
        }, "Copy Id")
      )
    ),
    actionMsg && h("div", {className: "insp-ok"}, actionMsg),
    actionErr && h("div", {className: "insp-error"}, actionErr)
  );
}

export function InspectorPanel() {
  const [tab, setTab] = React.useState("soql");
  const tabs = [
    {id: "soql", label: "SOQL"},
    {id: "records", label: "Records"},
    {id: "export", label: "Export"},
    {id: "import", label: "Import"},
    {id: "users", label: "Users"},
    {id: "org", label: "Org Info"},
    {id: "apptabs", label: "App Tabs"}
  ];
  return h("div", {className: "insp-root"},
    h("div", {className: "insp-tabs"},
      tabs.map(t =>
        h("button", {
          key: t.id,
          className: `insp-tab ${tab === t.id ? "active" : ""}`,
          onClick: () => setTab(t.id)
        }, t.label)
      )
    ),
    tab === "soql" && h(SoqlTab),
    tab === "records" && h(RecordsTab),
    tab === "export" && h(ExportTab),
    tab === "import" && h(ImportTab),
    tab === "users" && h(UsersTab),
    tab === "org" && h(OrgTab),
    tab === "apptabs" && h(AppTabsTab)
  );
}
