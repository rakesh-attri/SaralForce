import {sfConn, apiVersion} from "../../inspector.js";
import {getSavedConfig, getProviderConfig, hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {toCsv, downloadText, flattenRecord} from "../shared/csv.js";
import {runSoql, runSoqlMore} from "../shared/query.js";
import {useSfTimeZoneTick} from "../shared/format.js";
import {ffIcon, FF_I_DB, FF_I_CLOCK, FF_I_BOOKMARK, FF_I_SLIDERS, FF_I_DOWNLOAD, FF_I_DOC} from "../shared/icons.js";
import {ResultTable} from "../shared/result-table.js";
import {suggestSoqlFix, soqlFromText, explainSoql} from "../shared/ai.js";
import {ffLoadJson, ffSaveJson, useFfSession} from "../shared/session-state.js";
import {ffGetObjects, ffApiModeOf, ffDescribeObject, toolingListObjects} from "../shared/describe.js";
import {Celebrate} from "../shared/celebrate.js";
import {soqlHighlight} from "../shared/highlight.js";
import {useSoqlAutocomplete} from "../shared/soql-autocomplete.js";
import {buildDetailRows, fetchFullRecord, RecordDetailPanel} from "./records.js";

const h = React.createElement;

// Rows per results page; every fetched row stays reachable through the pager.
const SOQL_PAGE_SIZE = 300;

// row object -> position in result.rows, built once per result so row
// selection stays O(1) per row instead of indexOf over every row.
const _soqlRowIndexCache = new WeakMap();
function soqlRowIndexMap(rows) {
  let m = _soqlRowIndexCache.get(rows);
  if (!m) {
    m = new Map();
    rows.forEach((r, i) => m.set(r, i));
    _soqlRowIndexCache.set(rows, m);
  }
  return m;
}

// ─── SOQL tab ───────────────────────────────────────────────
function SoqlTab() {
  useSfTimeZoneTick();
  const [query, setQuery] = useFfSession("soql", "query", "SELECT Id, Name FROM Account LIMIT 50");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = useFfSession("soql", "result", null);
  const [limit, setLimit] = useFfSession("soql", "limit", 500);
  const [soqlDetail, setSoqlDetail] = useFfSession("soql", "detail", null);
  const [soqlDetailLoading, setSoqlDetailLoading] = React.useState(false);
  const [detailHint, setDetailHint] = React.useState(null);
  const [useLlm, setUseLlm] = React.useState(() => ffLoadJson("ff_soql_use_llm", false));
  // API mode toggles: Tooling API and Recycle Bin are mutually exclusive —
  // enabling one switches the other off. Persisted like the LLM checkbox.
  const [useTooling, setUseToolingState] = React.useState(() => ffLoadJson("ff_soql_use_tooling", false));
  const [useRecycle, setUseRecycleState] = React.useState(() => ffLoadJson("ff_soql_use_recycle", false));
  const setApiMode = (mode) => {
    const tooling = mode === "tooling";
    const recycle = mode === "recycle";
    setUseToolingState(tooling);
    setUseRecycleState(recycle);
    ffSaveJson("ff_soql_use_tooling", tooling);
    ffSaveJson("ff_soql_use_recycle", recycle);
  };
  const [fieldsExpanded, setFieldsExpanded] = React.useState(false);
  const [showLlmHelp, setShowLlmHelp] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState(null);
  const [fixError, setFixError] = React.useState(null);
  // Plain English → SOQL and Explain (only shown with LLM assistance on).
  const [aiAsk, setAiAsk] = useFfSession("soql", "aiAsk", "");
  const [aiBusy, setAiBusy] = React.useState(null);
  const [aiNote, setAiNote] = React.useState(null);
  const [objects, setObjects] = React.useState([]);
  const [objFilter, setObjFilter] = React.useState("");
  const [fromFields, setFromFields] = React.useState(null);
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_soql_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_soql_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const [resultFilter, setResultFilter] = React.useState("");
  const [fieldCat, setFieldCat] = React.useState("All");
  const [sortCol, setSortCol] = React.useState(null);
  const [sortDir, setSortDir] = React.useState(1);
  const [selected, setSelected] = React.useState(() => new Set());
  const [page, setPage] = React.useState(0);
  const [fetchingMore, setFetchingMore] = React.useState(false);
  // A new filter or sort order starts from the first page.
  React.useEffect(() => { setPage(0); }, [resultFilter, sortCol, sortDir]);
  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);
  const [celeb, setCeleb] = React.useState(0);
  const objectsRef = React.useRef(objects);
  objectsRef.current = objects;
  const acDescribe = React.useCallback(name => ffDescribeObject(name, {tooling: useTooling}), [useTooling]);
  const acObjects = React.useCallback(async () => objectsRef.current, []);
  const ac = useSoqlAutocomplete({taRef, setQuery, describe: acDescribe, listObjects: acObjects});

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
    let stale = false;
    if (!useTooling) { ffGetObjects().then(setObjects).catch(() => {}); return; }
    toolingListObjects()
      .then(list => { if (!stale) setObjects(list); })
      .catch((e) => {
        if (stale) return;
        setError("Tooling API object list failed: " + e.message + ". Showing standard objects instead.");
        ffGetObjects().then(setObjects).catch(() => {});
      });
    return () => { stale = true; };
  }, [useTooling]);

  // The tab lives inside white .insp-panel — flush it so the CloudFlow
  // page/card contrast shows through. Removed again on unmount.
  React.useEffect(() => {
    let panel = null;
    try {
      const root = document.querySelector(".soql-layout");
      panel = root && root.closest ? root.closest(".insp-panel") : null;
      if (panel) panel.classList.add("insp-panel-flush");
    } catch (e) { /* ignore */ }
    return () => {
      try { if (panel) panel.classList.remove("insp-panel-flush"); }
      catch (e) { /* ignore */ }
    };
  }, []);

  // Object detected after the last FROM — offer its fields.
  const fromMatch = /\bfrom\s+([a-zA-Z0-9_]*)$/i.exec(query) ||
    /\bfrom\s+([a-zA-Z0-9_]+)/i.exec(query);
  const fromObj = fromMatch ? fromMatch[1] : "";

  React.useEffect(() => {
    let stale = false;
    if (!fromObj) { setFromFields(null); return; }
    ffDescribeObject(fromObj, {tooling: useTooling})
      .then(d => {
        if (stale) return;
        setFromFields((d.fields || []).map(f => ({
          name: f.name, label: f.label, type: f.type,
          custom: !!f.custom, calculated: !!f.calculated
        })));
      })
      .catch(() => { if (!stale) setFromFields(null); });
    return () => { stale = true; };
  }, [fromObj, useTooling]);

  const insertAtCursor = (text) => {
    const ta = taRef.current;
    if (!ta) { setQuery(q => q + text); return; }
    const src = (typeof ta.value === "string") ? ta.value : query;
    const start = ta.selectionStart ?? src.length;
    const end = ta.selectionEnd ?? src.length;
    const next = src.slice(0, start) + text + src.slice(end);
    setQuery(next);
    const appliedQuery = next;
    requestAnimationFrame(() => {
      try {
        if (ta.value !== appliedQuery) return;
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
      const r = await runSoql(q, limit, {tooling: useTooling, allRows: useRecycle});
      const flat = r.records.map(flattenRecord);
      const colSet = new Set();
      flat.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      setResult({...r, rows: flat, columns: [...colSet]});
      setResultFilter("");
      setPage(0);
      setCeleb(c => c + 1);
      scrollAfterCelebration();
      setSortCol(null);
      setSortDir(1);
      setSelected(new Set());
      setHistory(prev => {
        const next = [{q, ts: Date.now()}, ...prev.filter(h => h.q !== q)].slice(0, 20);
        ffSaveJson("ff_soql_history", next);
        return next;
      });
    } catch (e) {
      setError(e.message + (useTooling
        ? " (Tooling API — turn the toggle off to use the standard API.)"
        : useRecycle
        ? " (Recycle Bin lookup — turn the toggle off for live records only.)"
        : ""));
      setResult(null);
      // Smart fix, only when the user opted in via the checkbox.
      if (useLlm) askLlmForFix(q, e.message);
    } finally {
      setLoading(false);
    }
  };

  // Continue a capped result from the server cursor; the page stays put.
  const fetchMore = async () => {
    if (!result || !result.nextUrl || fetchingMore) return;
    setFetchingMore(true);
    setError(null);
    try {
      const more = await runSoqlMore(result.nextUrl);
      const flat = more.records.map(flattenRecord);
      setResult(prev => {
        const colSet = new Set(prev.columns);
        flat.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
        return {...prev, rows: prev.rows.concat(flat), columns: [...colSet],
          fetched: prev.rows.length + flat.length, truncated: more.truncated, nextUrl: more.nextUrl};
      });
    } catch (e) {
      setError(`Could not fetch more rows: ${e.message}` +
        (/INVALID_QUERY_LOCATOR/i.test(e.message) ? " The server cursor expired; run the query again." : ""));
    } finally {
      setFetchingMore(false);
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
      const d = await ffDescribeObject(m[1], {tooling: useTooling});
      const rec = await fetchFullRecord(m[1], id);
      setSoqlDetail({id, obj: m[1], rows: buildDetailRows(rec, d.fields || []),
        meta: {label: (d && d.label) || m[1], custom: !!(d && d.custom),
          viaTooling: ffApiModeOf(m[1]) === "tooling",
          total: null, updated: null}});
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

  const askAiFor = async (kind) => {
    if (!hasValidConfig()) {
      setAiNote({error: "NO_LLM_CONFIG"});
      return;
    }
    setAiBusy(kind);
    setAiNote(null);
    try {
      if (kind === "generate") {
        const r = await soqlFromText(aiAsk, {currentObject: fromObj || null});
        setAiNote({title: "✨ Generated query", text: r.explanation, query: r.query});
      } else {
        setAiNote({title: "✨ What this query does", text: await explainSoql(query)});
      }
    } catch (e) {
      setAiNote({error: e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message});
    } finally {
      setAiBusy(null);
    }
  };

  const openSettings = () => {
    try {
      chrome.runtime.sendMessage({message: "openOptions", host: ""});
    } catch (e) { /* extension context only */ }
  };

  const exportCsv = () => {
    if (!result) return;
    // Checked rows win; with nothing checked the whole loaded set goes.
    const rows = selected.size
      ? result.rows.filter((_, i) => selected.has(i))
      : result.rows;
    downloadText("soql-results.csv", toCsv(result.columns, rows));
  };

  // Field categories for the explorer pills (mutually exclusive).
  const fieldCategory = (f) => {
    const t = String(f.type || "").toLowerCase();
    if (t === "picklist" || t === "multipicklist") return "Picklist";
    if (f.calculated) return "Formula";
    if (t === "reference") return "Relationships";
    if (f.custom) return "Custom";
    if (["string", "textarea", "email", "phone", "url", "id",
         "boolean", "date", "datetime", "time"].includes(t)) return "Standard";
    return "Other";
  };
  const FIELD_CATS = ["All", "Standard", "Custom", "Relationships",
    "Picklist", "Formula", "Other"];

  // Stroke-only type glyphs (SVG keeps card innerText equal to the bare
  // field name, which the probes assert on).
  const fieldTypeSvg = (type) => {
    const t = String(type || "").toLowerCase();
    const num = ["int", "double", "currency", "percent"].includes(t);
    const dt = ["date", "datetime", "time"].includes(t);
    const d = num
      ? "M9 4L7 20M17 4l-2 16M4 9h17M3 15h17"
      : dt
      ? "M5 6h14v13H5zM5 10h14M8 3v5M16 3v5"
      : t === "boolean"
      ? "M5 12l5 5 9-11"
      : (t === "picklist" || t === "multipicklist")
      ? "M4 7h16M4 12h16M4 17h10"
      : t === "reference"
      ? "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"
      : "M7 3h7l4 4v14H7zM14 3v4h4";
    return h("svg", {width: 18, height: 18, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 1.9,
      strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true"},
      h("path", {d}));
  };

  // Quote-aware lightweight formatter: case + whitespace only, the query
  // semantics never change.
  const formatSoql = () => {
    const src = String(query || "");
    if (!src.trim()) return;
    const segs = src.split(/('[^']*')/g);
    const majors = ["select", "from", "where", "group by", "order by",
      "having", "limit", "offset"];
    const minors = ["and", "or", "not", "in", "like", "asc", "desc",
      "nulls first", "nulls last"];
    const out = segs.map((seg, i) => {
      if (i % 2 === 1) return seg;
      let s = seg.replace(/\s+/g, " ");
      for (const kw of [...majors, ...minors].sort((a, b) => b.length - a.length)) {
        const re = new RegExp(`\\b${kw.replace(/ /g, "\\s+")}\\b`, "gi");
        s = s.replace(re, kw.toUpperCase());
      }
      for (const kw of majors.slice(1)) {
        s = s.replace(new RegExp(`\\b${kw.replace(/ /g, "\\s+")}\\b`, "gi"), `\n${kw.toUpperCase()}`);
      }
      return s;
    }).join("");
    setQuery(out.trim());
  };

  const clearQuery = () => {
    setQuery("SELECT Id, Name FROM Account LIMIT 50");
    setResult(null);
    setResultFilter("");
    setError(null);
    setSuggestion(null);
    setFixError(null);
    setSoqlDetail(null);
    setDetailHint(null);
    setSortCol(null);
    setSortDir(1);
    setSelected(new Set());
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

  // Scroll to results only AFTER the success celebration has played
  // (its animationend clears celeb). The timeout is a fallback in case the
  // animation end never fires (e.g. reduced motion); whichever fires first
  // consumes the pending scroll.
  const ranAt = React.useRef(0);
  const scrollToResults = () => {
    try {
      const el = document.querySelector(".sq3-results-card");
      if (el && el.scrollIntoView) el.scrollIntoView({behavior: "smooth", block: "nearest"});
    } catch (e) { /* ignore */ }
  };
  const scrollAfterCelebration = () => {
    ranAt.current += 1;
    const seq = ranAt.current;
    setTimeout(() => {
      if (ranAt.current !== seq) return;
      ranAt.current = 0;
      scrollToResults();
    }, 4000);
  };
  React.useEffect(() => {
    if (celeb !== 0 || !ranAt.current) return;
    ranAt.current = 0;
    scrollToResults();
  }, [celeb]);

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
      const appliedQuery = next;
      requestAnimationFrame(() => {
        if (!ta) return;
        try {
          if (ta.value !== appliedQuery) return;
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        } catch (e) { /* ignore */ }
      });
      return;
    }
    insertAtCursor(` ${name}`);
  };

  const insertField = (name) => {
    // Live DOM is the source of truth: after rapid edits the render closure
    // can hold a stale query string, but the textarea always shows the
    // committed text, so inserts never compute on outdated state.
    const ta = taRef.current;
    const src = (ta && typeof ta.value === "string") ? ta.value : query;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : src.length;
    const before = src.slice(0, caret);
    const quotes = (before.match(/'/g) || []).length;
    const m = quotes % 2 === 0 ? /(\w+)$/.exec(before) : null;
    insertFieldAt(name, m ? caret - m[1].length : caret, caret, src);
  };

  // Single choke point for FIELD insertion (partial-word replace AND
  // mid-text caret paths): exactly one comma separator, never before FROM,
  // never doubled. Object names keep the raw insertAtCursor path below.
  const insertFieldAt = (name, start, caretPos, src) => {
    const ta = taRef.current;
    const contextBefore = src.slice(0, start);
    const after = src.slice(caretPos);
    const inSelectList = /\bfrom\b/i.test(after);
    let head = contextBefore;
    if (inSelectList && /[A-Za-z0-9_)]\s*$/.test(contextBefore) &&
        !/\bselect\s*$/i.test(contextBefore)) {
      head = contextBefore.replace(/\s+$/, "") + ", ";
    }
    let sep = "";
    if (!/^\s*,/.test(after) && !/^\s*from\b/i.test(after)) sep = ",";
    if (after === "" || /^[^\s,]/.test(after)) sep += " ";
    const next = head + name + sep + after;
    const pos = (head + name + sep).length;
    setQuery(next);
    // Restore focus/caret on the next frame - but only if no newer edit
    // landed meanwhile (a late frame must never clobber fresh input).
    const appliedQuery = next;
    requestAnimationFrame(() => {
      if (!ta) return;
      try {
        if (ta.value !== appliedQuery) return;
        ta.focus(); ta.setSelectionRange(pos, pos);
      } catch (e) { /* ignore */ }
    });
  };

  // Ctrl+Space: insert ALL available fields for the FROM object.
  const insertAllFields = async () => {
    const ta = taRef.current;
    const src = (ta && typeof ta.value === "string") ? ta.value : query;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : src.length;
    if (!fromObj) {
      setError("Type FROM <Object> first, then press Ctrl+Space.");
      return;
    }
    setError(null);
    let fieldNames = (fromFields && fromFields.length)
      ? fromFields.map(f => f.name)
      : null;
    if (!fieldNames) {
      try {
        const d = await ffDescribeObject(fromObj, {tooling: useTooling});
        fieldNames = (d.fields || []).map(f => f.name);
      } catch (e) {
        setError(`Could not load fields for ${fromObj}: ${e.message}`);
        return;
      }
    }
    if (!fieldNames.length) {
      setError(`No fields found for ${fromObj}.`);
      return;
    }
    let all = fieldNames.join(", ");
    if (all.length > 15000) {
      all = fieldNames.slice(0, 100).join(", ");
      setError("Field list truncated to 100 fields (query length guard).");
    }
    const before = src.slice(0, caret);
    const quotes = (before.match(/'/g) || []).length;
    const m = quotes % 2 === 0 ? /(\w+)$/.exec(before) : null;
    const start = m ? caret - m[1].length : caret;
    const next = src.slice(0, start) + all + " " + src.slice(caret).replace(/^\s+/, "");
    setQuery(next);
    const pos = start + all.length + 1;
    const appliedQuery = next;
    requestAnimationFrame(() => {
      if (!ta) return;
      try {
        if (ta.value !== appliedQuery) return;
        ta.focus(); ta.setSelectionRange(pos, pos);
      } catch (e) { /* ignore */ }
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
  const displayRows = sortCol ? visibleRows.slice().sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  }) : visibleRows;
  const pageCount = Math.max(1, Math.ceil(displayRows.length / SOQL_PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = displayRows.slice(curPage * SOQL_PAGE_SIZE, (curPage + 1) * SOQL_PAGE_SIZE);
  const toggleSort = (col) => {
    if (sortCol !== col) { setSortCol(col); setSortDir(1); return; }
    if (sortDir === 1) { setSortDir(-1); return; }
    setSortCol(null); setSortDir(1);
  };
  const rowIndexMap = result ? soqlRowIndexMap(result.rows) : null;
  const resultRowIndex = (row) => {
    const i = rowIndexMap ? rowIndexMap.get(row) : undefined;
    return i === undefined ? -1 : i;
  };
  // Describe-driven datetime formatting: same record must match Salesforce UI.
  const soqlFieldTypes = {};
  if (fromFields) {
    for (const f of fromFields) {
      if (f && f.name) soqlFieldTypes[f.name] = f.type;
    }
  }
  const catCounts = {};
  if (fromFields) {
    for (const f of fromFields) {
      const c = fieldCategory(f);
      catCounts[c] = (catCounts[c] || 0) + 1;
    }
  }

  const apiToggle = (label, hint, on, onFlip) => h("label", {className: "sq3-toggle", title: hint},
    h("span", {className: "sq3-toggle-lbl"}, label),
    h("span", {className: "sq3-switch"},
      h("input", {
        type: "checkbox",
        checked: !!on,
        onChange: e => onFlip(e.target.checked)
      }),
      h("span", {className: "sq3-slider"})),
    h("span", {className: "sq3-toggle-state"}, on ? "Enabled" : "Disabled"));

  return h("div", {className: "insp-panel"},
    h("div", {className: "soql-layout"},

      // ── Left column (1/4): settings · row limit · history · saved ──
      h("div", {className: "soql-side"},
        h("div", {className: "sq3-card sq3-card-llm"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, "✨"),
            h("span", {className: "sq3-card-t"}, "LLM Assistant"),
            (() => {
              // Read live every render so what the frontend captured is always
              // visible — no more guessing whether Options saved correctly.
              const cfg = getSavedConfig();
              const ok = hasValidConfig();
              const def = cfg && cfg.provider ? getProviderConfig(cfg.provider) : null;
              return h("span", {
                className: "sq3-pill-state " + (ok ? "ok" : "warn"),
                title: ok
                  ? `Provider: ${cfg.provider}\nModel: ${cfg.model || "(default)"}\nKey: ${cfg.apiKey ? "••••" + String(cfg.apiKey).slice(-4) : "missing"}\n(uncheck to stop asking the LLM when a query fails)`
                  : "Open Settings (gear in the sidebar header) → choose provider, paste API key, Save Settings"
    }, ok ? (def ? def.name : cfg.provider) : "Not configured");
            })(),
            h("button", {
              className: "sq3-info-btn",
              title: "How to enable LLM assistance",
              "aria-expanded": !!showLlmHelp,
              onClick: () => setShowLlmHelp(v => !v)
            }, "i")),
          h("label", {className: "sq3-check"},
            h("input", {
              type: "checkbox",
              checked: !!useLlm,
              onChange: e => {
                setUseLlm(e.target.checked);
                ffSaveJson("ff_soql_use_llm", e.target.checked);
              }
            }),
            h("span", null, "Enable LLM assistance")),
          h("div", {className: "sq3-card-sub"},
            "Enable AI-powered query assistance when an LLM provider is configured."),
          showLlmHelp && h("div", {className: "sq3-info-panel"},
            h("div", {className: "sq3-info-t"}, "How to enable:"),
            h("ol", {className: "sq3-info-steps"},
              h("li", {key: 1}, "Click the gear icon in the sidebar header, then Settings."),
              h("li", {key: 2}, "Choose a provider (OpenAI, Claude, Gemini, or OpenAI-compatible)."),
              h("li", {key: 3}, "Paste your API key, pick a model, and Save Settings."),
              h("li", {key: 4}, "Return here and tick Enable LLM assistance.")),
            h("div", {className: "sq3-card-sub"},
              "Your API key stays in this browser and is only sent to your chosen provider."))
        ),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_SLIDERS)),
            h("span", {className: "sq3-card-t"}, "Query Tools")),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Row Limit"),
            h("input", {
              type: "number",
              min: 1,
              max: 20000,
              value: limit,
              onChange: e => setLimit(e.target.value)
            })
          ),
          h("button", {
            className: "btn btn-primary sq3-run",
            disabled: loading,
            onClick: () => run()
          }, loading ? "Running…" : "▶ Run SOQL",
            h("span", {className: "sq3-kbd-hint"}, "Ctrl+Enter"))
        ),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_CLOCK)),
            h("span", {className: "sq3-card-t"}, "History")),
          h("label", {className: "insp-field sq3-field"},
            h("select", {
              value: "",
              onChange: e => {
                if (e.target.value) { setQuery(e.target.value); run(e.target.value); }
                e.target.value = "";
              }
            },
              h("option", {value: ""}, history.length ? "Select from history" : "No history yet"),
              history.map((hh, i) =>
                h("option", {key: i, value: hh.q},
                  `${new Date(hh.ts).toLocaleString()} — ${hh.q.slice(0, 60)}`)
              )
            )
          ),
          history.length > 0 && h("button", {
            className: "btn btn-secondary btn-sm",
            onClick: clearHistory,
            title: "Clear recent query history"
          }, "Clear history")
        ),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_BOOKMARK)),
            h("span", {className: "sq3-card-t"}, "Saved Queries")),
          h("div", {className: "sq3-card-sub"}, "Save a query to reuse it later."),
          saved.length > 0 && h("div", {className: "sq3-saved-list"},
            saved.slice(0, 12).map(s =>
              h("div", {
                key: s.label,
                className: "sq3-saved-row",
                role: "button",
                tabIndex: 0,
                title: s.q,
                onClick: () => setQuery(s.q),
                onKeyDown: e => { if (e.key === "Enter") setQuery(s.q); }
              },
                h("span", {className: "sq3-saved-ico", "aria-hidden": "true"}, ffIcon(FF_I_DOC)),
                h("span", {className: "sq3-saved-tx"},
                  h("span", {className: "sq3-saved-label"}, s.label),
                  h("span", {className: "sq3-saved-q"}, s.q)),
                h("span", {className: "sq3-saved-chev", "aria-hidden": "true"}, "›"),
                h("button", {
                  className: "sq3-saved-x",
                  title: `Delete "${s.label}"`,
                  onClick: (e) => { e.stopPropagation(); deleteSaved(s.label); }
                }, "×"))
            )
          ),
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
          )
        ),
      ),

      // ── Right column (3/4): editor · field explorer · results ──
      h("div", {className: "soql-main"},
        h("div", {className: "sq3-card sq3-editor-card"},
          h("div", {className: "insp-card-header sq3-card-head"},
            h("div", {className: "sq3-title-wrap"},
              h("span", {className: "sq3-code-ico", "aria-hidden": "true"}, "</>"),
              h("div", null,
                h("div", {className: "insp-card-title"}, "SOQL Query Editor"),
                h("div", {className: "sq3-card-sub"},
                  "Write and execute SOQL queries against your Salesforce org."))),
            h("div", {className: "insp-card-actions"},
              apiToggle("Tooling API",
                "Use the Salesforce Tooling API for objects and metadata available through Setup.",
                useTooling, on => setApiMode(on ? "tooling" : "standard")),
              apiToggle("Recycle Bin",
                "Retrieve deleted records from the Salesforce Recycle Bin.",
                useRecycle, on => setApiMode(on ? "recycle" : "standard"))
            )
          ),
          h("div", {className: "sq3-editor-actions"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: !query.trim(),
              onClick: saveCurrent
            }, "Save Query"),
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: loading,
              onClick: clearQuery
            }, "Clear")
          ),
          useLlm && h("div", {className: "soql-save-row soql-ai-row"},
            h("input", {
              className: "soql-save-input",
              value: aiAsk,
              placeholder: "Describe the records you want, e.g. accounts in Energy created this year",
              "aria-label": "Describe the query in plain English",
              onChange: e => setAiAsk(e.target.value),
              onKeyDown: e => { if (e.key === "Enter" && aiAsk.trim() && !aiBusy) askAiFor("generate"); }
            }),
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: !aiAsk.trim() || !!aiBusy,
              onClick: () => askAiFor("generate")
            }, aiBusy === "generate" ? "Writing…" : "✨ Write SOQL"),
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: !query.trim() || !!aiBusy,
              title: "Explain the query in the editor in plain words",
              onClick: () => askAiFor("explain")
            }, aiBusy === "explain" ? "Explaining…" : "Explain")
          ),
          aiNote && aiNote.error === "NO_LLM_CONFIG" && h("div", {className: "insp-warn"},
            "AI needs a provider + API key. ",
            h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")),
          aiNote && aiNote.error && aiNote.error !== "NO_LLM_CONFIG" &&
            h("div", {className: "insp-error"}, "AI request failed: " + aiNote.error),
          aiNote && !aiNote.error && h("div", {className: "insp-fix"},
            h("div", {className: "insp-fix-title"}, aiNote.title),
            aiNote.text && h("div", {className: "insp-fix-why"}, aiNote.text),
            aiNote.query && h("div", {className: "insp-fix-query"}, aiNote.query),
            h("div", {className: "insp-toolbar", style: {marginBottom: "0", marginTop: "8px"}},
              aiNote.query && h("button", {
                className: "btn btn-primary btn-sm",
                disabled: loading,
                onClick: () => { setQuery(aiNote.query); setAiNote(null); run(aiNote.query); }
              }, "Use & Run"),
              aiNote.query && h("button", {
                className: "btn btn-secondary btn-sm",
                onClick: () => { setQuery(aiNote.query); setAiNote(null); }
              }, "Use query"),
              h("button", {
                className: "btn btn-secondary btn-sm",
                onClick: () => setAiNote(null)
              }, "Dismiss"))),
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
                onChange: e => {
                  setQuery(e.target.value);
                  ac.refresh(e.target.value, e.target.selectionStart);
                },
                onScroll: e => { onTermScroll(e); ac.close(); },
                onBlur: ac.close,
                onClick: ac.close,
                "aria-autocomplete": "list",
                "aria-expanded": ac.open,
                onKeyDown: e => {
                  if (ac.onKeyDown(e)) return;
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
                  if ((e.ctrlKey || e.metaKey) && e.key === "/") {
                    e.preventDefault();
                    formatSoql();
                  }
                  if ((e.ctrlKey || e.metaKey) && e.key === " ") {
                    e.preventDefault();
                    insertAllFields();
                  }
                },
                placeholder: "SELECT Id, Name FROM Account LIMIT 50"
              })),
            h(Celebrate, {seq: celeb, onDone: () => setCeleb(0)})),
          ac.popup,
          h("div", {className: "soql-hint-row"},
            h("span", null,
              h("kbd", null, "Ctrl"), " / ", h("kbd", null, "⌘"),
              " + ", h("kbd", null, "Enter"), " to run"),
            h("button", {
              className: "sq3-format-btn",
              onClick: formatSoql,
              title: "Format query"
            }, "Ctrl+/ Format")
          ),
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
        ), // sq3-editor-card

        // Field Explorer — category pills + field cards with type icons
        h("div", {className: "sq3-card sq3-explorer-card"},
        h("div", {className: "soql-explorer-h"},
          h("div", {className: "insp-card-title sq3-explorer-title"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DB)),
            h("span", null, fromFields ? `Available Fields · ${fromObj}` : "Available Objects")),
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
        fromFields && h("div", {className: "sq3-pills", role: "group", "aria-label": "Field categories"},
          FIELD_CATS.map(c => h("button", {
            key: c,
            className: "sq3-pill" + (fieldCat === c ? " active" : ""),
            onClick: () => setFieldCat(c)
          }, `${c} (${c === "All" ? (fromFields ? fromFields.length : 0) : (catCounts[c] || 0)})`))
        ),
        h("div", {className: "insp-chips soql-fields sq3-field-grid"},
          (fromFields
            ? (() => {
                let list = fromFields.filter(f =>
                  (fieldCat === "All" || fieldCategory(f) === fieldCat) &&
                  (!objFilter ||
                    f.name.toLowerCase().includes(objFilter.toLowerCase()) ||
                    (f.label || "").toLowerCase().includes(objFilter.toLowerCase())));
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
                const cards = list.slice(0, fieldsExpanded ? 60 : 6).map(f => h("button", {
                  key: f.name,
                  "data-name": f.name,
                  className: "sq3-field",
                  title: `${f.label} · ${f.type} — click to insert`,
                  onClick: () => insertField(f.name)
                },
                  h("span", {className: "sq3-field-ico", "aria-hidden": "true"}, fieldTypeSvg(f.type)),
                  h("span", {className: "sq3-field-tx"},
                    h("span", {className: "sq3-field-name"}, f.name),
                    h("span", {className: "sq3-field-type"}, f.type || ""))));
                return cards.length ? cards : h("div", {
                  key: "__empty",
                  className: "insp-empty sq3-pills-empty"
                }, `No ${fieldCat} fields match.`);
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
        ), // sq3-explorer-card

        fromFields && fromFields.length > 6 && h("button", {
          className: "sq3-expander" + (fieldsExpanded ? " expanded" : ""),
          onClick: () => setFieldsExpanded(v => !v)
        }, fieldsExpanded ? "Show fewer" : `Show all ${fromFields.length} fields`),

        result && h("div", {className: "sq3-card sq3-results-card"},
        h("div", {className: "soql-results-h"},
          h("div", {className: "sq3-results-title"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DB)),
            h("span", {className: "insp-card-title"}, "Results")),
          h("div", {className: "insp-meta"},
            rf
              ? `showing ${visibleRows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} row(s)`
              : result.rows.length && result.totalSize !== result.rows.length
              ? `${result.rows.length.toLocaleString()} of ${result.totalSize.toLocaleString()} row(s) fetched`
              : `${result.totalSize.toLocaleString()} row(s)`
          ),
          h("button", {
            className: "btn btn-secondary btn-sm",
            onClick: exportCsv,
            title: selected.size
              ? `Download ${selected.size} selected row(s)`
              : "Download all loaded rows"
          }, ffIcon(FF_I_DOWNLOAD), h("span", null, "Download")),
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
        result.columns && result.columns.some(c => String(c).toLowerCase() === "id") &&
          h("div", {className: "soql-id-hint"}, "Click on ID to Show All Data"),
        result.truncated &&
          h("div", {className: "insp-meta soql-truncation-note", role: "status"},
            `Fetched ${result.rows.length.toLocaleString()} of ${result.totalSize.toLocaleString()} total rows. `,
            result.nextUrl && h("button", {
              className: "field-action-btn",
              disabled: fetchingMore,
              onClick: fetchMore
            }, fetchingMore ? "Fetching…" : "Fetch more rows"),
            result.nextUrl ? " or use " : "Use ",
            "Data Export (Bulk API) for very large sets."),
        result && (rf && !visibleRows.length
          ? h("div", {className: "insp-empty"}, "No matching rows.")
          : h(ResultTable, {
              columns: result.columns,
              rows: pageRows,
              maxRows: SOQL_PAGE_SIZE,
              onRowClick: openSoqlDetail,
              rowHint: "Click to show all data",
              wrapClass: "soql-results-table",
              selectable: true,
              isSelected: (row) => selected.has(resultRowIndex(row)),
              onToggle: (row) => {
                const i = resultRowIndex(row);
                if (i < 0) return;
                setSelected(prev => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i); else next.add(i);
                  return next;
                });
              },
              allChecked: displayRows.length > 0 &&
                displayRows.every(r => selected.has(resultRowIndex(r))),
              onToggleAll: () => {
                const idx = displayRows.map(resultRowIndex).filter(i => i >= 0);
                setSelected(prev => {
                  const all = idx.length > 0 && idx.every(i => prev.has(i));
                  const next = new Set(prev);
                  idx.forEach(i => { if (all) next.delete(i); else next.add(i); });
                  return next;
                });
              },
              sortCol, sortDir, onSort: toggleSort,
              fieldTypes: soqlFieldTypes
            })),
        pageCount > 1 && h("div", {className: "insp-toolbar soql-pager", role: "navigation", "aria-label": "Result pages"},
          h("button", {
            className: "btn btn-secondary btn-sm",
            disabled: curPage === 0,
            onClick: () => setPage(curPage - 1)
          }, "‹ Prev"),
          h("span", {className: "insp-meta"},
            `Rows ${(curPage * SOQL_PAGE_SIZE + 1).toLocaleString()}–` +
            `${Math.min((curPage + 1) * SOQL_PAGE_SIZE, displayRows.length).toLocaleString()} of ` +
            `${displayRows.length.toLocaleString()}${rf ? " matching" : ""}`),
          h("button", {
            className: "btn btn-secondary btn-sm",
            disabled: curPage >= pageCount - 1,
            onClick: () => setPage(curPage + 1)
          }, "Next ›")),
        ), // sq3-results-card
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

export {SoqlTab};
