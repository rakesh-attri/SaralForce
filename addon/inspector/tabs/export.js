import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {applyDefaultLimit} from "../../core/soql.js";
import {normalizeLocator, mergeCsvChunks} from "../../core/bulk.js";
import {confirmDialog} from "../../ui/confirm.js";
import {isDateOnlyString, looksLikeSfDateTime, parseSfInstant} from "../../sf-time.js";
import {downloadText, flattenRecord, parseCsvEx, toCsvEx} from "../shared/csv.js";
import {toXlsxBlob} from "../shared/xlsx.js";
import {ffBulkQueryCreate, ffBulkQueryStatus, ffBulkQueryResults, ffBulkJobCancel, ffBulkPoll} from "../shared/bulk-api.js";
import {ffStoppedError, ffIsStopped, useUnmountSignal} from "../shared/hooks.js";
import {useSfTimeZoneTick, fmtNum} from "../shared/format.js";
import {ffIcon, FF_I_DB, FF_I_CLOCK, FF_I_SLIDERS, FF_I_DOWNLOAD, FF_I_ZAP} from "../shared/icons.js";
import {ResultTable} from "../shared/result-table.js";
import {ffLoadJson, ffSaveJson, useFfSession} from "../shared/session-state.js";
import {ffGetObjects, ffDescribeObject} from "../shared/describe.js";
import {soqlHighlight} from "../shared/highlight.js";

const h = React.createElement;

function ffDownloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─── Data Export tab (v1.5.0 — three-column data manager) ──────────────────
// Left: setup (saved/history/API/mode/object/limit/format). Center: SOQL
// editor + Field Explorer + bounded preview. Right: advanced options + Bulk
// 2.0 job tracking. All results come from real Salesforce query responses.
const FF_EXPORT_FORMATS = ["CSV", "Excel (.xlsx)", "JSON"];

function ExportTab() {
  useSfTimeZoneTick();
  const unmountRef = useUnmountSignal();
  // ── Setup state (left panel) ────────────────────────────────
  const [objectApi, setObjectApi] = useFfSession("export", "objectApi", "");
  const [fields, setFields] = useFfSession("export", "fields", "Id, Name");
  const [where, setWhere] = useFfSession("export", "where", "");
  const [limit, setLimit] = useFfSession("export", "limit", 10000);
  const [apiMode, setApiMode] = useFfSession("export", "apiMode", "data"); // data | bulk
  const [expMode, setExpMode] = useFfSession("export", "expMode", "soql"); // soql | object
  const [format, setFormat] = useFfSession("export", "format", "CSV");
  const [includeDeleted, setIncludeDeleted] = useFfSession("export", "includeDeleted", false);
  const [includeFormula, setIncludeFormula] = useFfSession("export", "includeFormula", false);
  const [includeHeaders, setIncludeHeaders] = useFfSession("export", "includeHeaders", true);

  // ── Advanced CSV / export options (right panel) ─────────────
  const [csvDelimiter, setCsvDelimiter] = useFfSession("export", "csvDelimiter", ",");
  const [csvQuoting, setCsvQuoting] = useFfSession("export", "csvQuoting", "minimal");
  const [csvEncoding, setCsvEncoding] = useFfSession("export", "csvEncoding", "utf8"); // utf8 | utf8bom
  const [csvDateFormat, setCsvDateFormat] = useFfSession("export", "csvDateFormat", "iso");
  const [csvNullValue, setCsvNullValue] = useFfSession("export", "csvNullValue", "");
  const [csvLineEnding, setCsvLineEnding] = useFfSession("export", "csvLineEnding", "\r\n");
  // CSV only: XLSX cells are written as inline strings, which Excel never
  // evaluates as formulas, and JSON is not opened in spreadsheets.
  const [csvGuardFormulas, setCsvGuardFormulas] = useFfSession("export", "csvGuardFormulas", true);

  // ── Query editor state (center) ─────────────────────────────
  const [query, setQuery] = useFfSession("export", "query",
    "SELECT Id, Name FROM Account LIMIT 10000");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [note, setNote] = React.useState(null);
  const [meta, setMeta] = useFfSession("export", "meta", null);
  const [preview, setPreview] = useFfSession("export", "preview", null);
  const [sortCol, setSortCol] = React.useState(null);
  const [sortDir, setSortDir] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [expandFields, setExpandFields] = React.useState(false);
  const [objFilter, setObjFilter] = React.useState("");
  const [fieldCat, setFieldCat] = React.useState("All");
  const [objects, setObjects] = React.useState([]);
  const [recents, setRecents] = React.useState(() => ffLoadJson("ff_recent_objects", []));
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_export_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_export_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const [examplesOpen, setExamplesOpen] = React.useState(false);

  // ── Bulk 2.0 query job (right panel) ────────────────────────
  const [bulkJob, setBulkJob] = useFfSession("export", "bulkJob", null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState(null);

  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);

  const PAGE_SIZE = 200;
  const lineCount = Math.max(1, String(query || "").split("\n").length);

  React.useEffect(() => {
    ffGetObjects().then(setObjects).catch(() => {});
  }, []);

  const onTermScroll = (e) => {
    const t = e.target;
    if (hlRef.current) {
      hlRef.current.scrollTop = t.scrollTop;
      hlRef.current.scrollLeft = t.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop;
  };

  const currentConfig = () => ({
    objectApi: objectApi.trim(),
    fields: fields.trim(),
    where: where.trim(),
    limit: parseInt(limit, 10) || 10000,
    query: query.trim(),
    apiMode, expMode, format
  });

  const applyConfig = (c) => {
    setObjectApi(c.objectApi || "");
    setFields(c.fields || "Id, Name");
    setWhere(c.where || "");
    if (c.limit) setLimit(c.limit);
    if (c.query) setQuery(c.query);
    if (c.apiMode) setApiMode(c.apiMode);
    if (c.expMode) setExpMode(c.expMode);
    if (c.format) setFormat(c.format);
    setPreview(null);
    setError(null);
  };

  // Deterministic pastel pill tone (same hash trick as the SOQL tab).
  const pillTone = (name) => {
    let hv = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) hv = (hv * 31 + s.charCodeAt(i)) >>> 0;
    return hv % 8;
  };

  // describe() accepts an override so the Recent Objects chips can set the
  // object and describe it in one click (state updates are async).
  const describe = async (objOverride) => {
    setError(null);
    const obj = String(objOverride != null ? objOverride : objectApi).trim();
    if (!obj) { setError("Enter an object API name"); return; }
    setLoading(true);
    try {
      const d = await ffDescribeObject(obj);
      const fieldList = (d.fields || []).map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        custom: !!f.custom,
        calculated: !!f.calculated,
        updateable: f.updateable,
        createable: f.createable
      }));
      setMeta({name: d.name, label: d.label, fields: fieldList});
      // Recent objects (org-scoped; shared with the Import tab).
      try {
        const next = [obj, ...ffLoadJson("ff_recent_objects", []).filter(n => n !== obj)].slice(0, 12);
        ffSaveJson("ff_recent_objects", next);
        setRecents(next);
      } catch (e) { /* ignore */ }
      // Object Export mode: seed the editor with a sane field list.
      if (expMode === "object") {
        const seed = ["Id",
          ...(d.fields || []).filter(f => f.name !== "Id" &&
            ["string", "textarea", "email", "phone", "url", "date", "datetime", "currency",
             "double", "int", "boolean", "picklist", "multipicklist", "reference"].includes(f.type))
          .slice(0, 8).map(f => f.name)];
        setFields(seed.join(", "));
      }
      setNote(`${d.label || d.name}: ${fieldList.length} fields loaded`);
    } catch (e) {
      setError(e.message);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  };

  // Build the executable SOQL. Both modes run the editor text — Object
  // Export mode seeds it from Setup (Describe / Rebuild SOQL), SOQL mode is
  // free editing. One code path keeps preview/downloads honest.
  const buildQuery = () => {
    const q = String(query || "").trim();
    if (!q) throw new Error("Enter a SOQL query");
    if (!/^select\b/i.test(q)) throw new Error("Only SELECT queries are supported");
    if (expMode === "object" && !objectApi.trim()) throw new Error("Enter an object API name");
    if (apiMode === "data") return applyDefaultLimit(q, parseInt(limit, 10) || 10000);
    return q;
  };

  // Object Export: assemble SELECT <fields> FROM <object> [WHERE …] LIMIT n.
  // "Include formula fields" appends every calculated field from describe.
  const rebuildQuery = () => {
    const obj = objectApi.trim();
    if (!obj) { setError("Enter an object API name"); return; }
    let sel = fields.trim() || "Id, Name";
    if (includeFormula && meta && meta.name === obj) {
      const formulaNames = meta.fields.filter(f => f.calculated).map(f => f.name);
      const have = new Set(sel.split(",").map(s => s.trim().toLowerCase()));
      const add = formulaNames.filter(n => !have.has(n.toLowerCase()));
      if (add.length) sel = `${sel}, ${add.join(", ")}`;
    }
    let q = `SELECT ${sel} FROM ${obj}`;
    if (where.trim()) q += ` WHERE ${where.trim()}`;
    q = applyDefaultLimit(q, parseInt(limit, 10) || 10000);
    setQuery(q);
    setPreview(null);
    setError(null);
  };

  // Field Explorer categories (shared vocabulary with the SOQL tab).
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
  const FIELD_CATS = ["All", "Standard", "Custom", "Relationships", "Picklist", "Formula", "Other"];
  const catCounts = {};
  if (meta && meta.fields) {
    for (const f of meta.fields) {
      const c = fieldCategory(f);
      catCounts[c] = (catCounts[c] || 0) + 1;
    }
  }

  // Insert a field into the editor's SELECT list: comma-safe, no duplicates,
  // never before FROM. Mirrors the SOQL tab's insertFieldAt rules.
  const insertField = (name) => {
    const ta = taRef.current;
    const src = (ta && typeof ta.value === "string") ? ta.value : query;
    const inSelect = /\bfrom\s/i.test(src);
    if (inSelect) {
      // Duplicate guard: already present as a SELECT token?
      const selPart = (/\bselect\s+([\s\S]*?)\s+from\b/i.exec(src) || [null, ""])[1];
      const tokens = selPart.split(",").map(s => s.trim().toLowerCase())
        .filter(s => s && !/[\s(]/.test(s));
      if (tokens.includes(name.toLowerCase())) {
        setNote(`"${name}" is already in the query`);
        return;
      }
    }
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : src.length;
    const before = src.slice(0, caret);
    const quotes = (before.match(/'/g) || []).length;
    // Only replace a token when the caret is genuinely inside a word (chars on
    // both sides). Placing the caret right after "Name" and clicking Status
    // must APPEND — silently dropping the existing field would lose data.
    let start = caret;
    let end = caret;
    if (quotes % 2 === 0) {
      const left = /(\w+)$/.exec(before);
      const right = /^\w+/.exec(src.slice(caret));
      if (left && right) {
        start = caret - left[1].length;
        end = caret + right[0].length;
      }
    }
    const after = src.slice(end);
    // Insert into the SELECT list when there is no FROM yet (incomplete
    // query) or when the caret still sits before the FROM clause.
    const inSelectList = !/\bfrom\b/i.test(src) || /\bfrom\b/i.test(after);
    let head = src.slice(0, start);
    if (inSelectList && /[A-Za-z0-9_)]\s*$/.test(head) && !/\bselect\s*$/i.test(head)) {
      head = head.replace(/\s+$/, "") + ", ";
    }
    let sep = "";
    if (!/^\s*,/.test(after) && !/^\s*from\b/i.test(after)) sep = ",";
    if (after === "" || /^[^\s,]/.test(after)) sep += " ";
    const next = head + name + sep + after;
    const pos = (head + name + sep).length;
    setQuery(next);
    const applied = next;
    requestAnimationFrame(() => {
      if (!ta || ta.value !== applied) return;
      try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    });
    setNote(null);
  };

  // Insert the whole FROM object's fields (Ctrl+Space equivalent).
  const insertAllFields = () => {
    if (!meta || !meta.fields.length) {
      setNote("Run Describe first to load fields.");
      return;
    }
    const names = meta.fields.map(f => f.name);
    if (names.length > 120) {
      setNote(`Refusing to insert ${names.length} fields — pick individual fields.`);
      return;
    }
    const obj = objectApi.trim();
    setQuery(applyDefaultLimit(`SELECT ${names.join(", ")} FROM ${obj}` +
      (where.trim() ? ` WHERE ${where.trim()}` : ""), parseInt(limit, 10) || 10000));
    setNote(null);
  };

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
    setQuery("");
    setPreview(null);
    setError(null);
    setNote(null);
  };

  // Lightweight SOQL sanity check (client-side; the server remains the
  // authority — Run Preview executes against Salesforce for real).
  const validateSoql = () => {
    setError(null);
    const q = String(query || "").trim();
    const problems = [];
    if (!q) problems.push("Query is empty.");
    if (q && !/^select\b/i.test(q)) problems.push("Only SELECT queries are supported.");
    if (q && !/\bfrom\s+[A-Za-z0-9_]/i.test(q)) problems.push("Missing FROM <Object>.");
    if ((q.match(/\(/g) || []).length !== (q.match(/\)/g) || []).length) {
      problems.push("Unbalanced parentheses.");
    }
    const quotes = (q.match(/'/g) || []).length;
    if (quotes % 2 !== 0) problems.push("Unbalanced single quotes.");
    if (problems.length) {
      setError("Validation failed: " + problems.join(" "));
      return false;
    }
    setNote("Query looks valid. Run Preview to execute it against Salesforce.");
    return true;
  };

  const QUERY_EXAMPLES = [
    {label: "Accounts by industry",
     q: "SELECT Id, Name, Industry FROM Account WHERE Industry != null ORDER BY Name LIMIT 100"},
    {label: "Recent opportunities",
     q: "SELECT Id, Name, Amount, StageName, CloseDate FROM Opportunity ORDER BY CloseDate DESC LIMIT 100"},
    {label: "Open cases",
     q: "SELECT Id, CaseNumber, Subject, Status, Priority FROM Case WHERE IsClosed = false LIMIT 100"},
    {label: "Active contacts with email",
     q: "SELECT Id, Name, Email, Account.Name FROM Contact WHERE Email != null LIMIT 100"},
    {label: "Count accounts by type",
     q: "SELECT Type, COUNT(Id) FROM Account GROUP BY Type"},
    {label: "Custom object records",
     q: "SELECT Id, Name FROM IT_Asset__c ORDER BY LastModifiedDate DESC LIMIT 100"}
  ];

  // ── Data API preview (bounded, paginated through nextRecordsUrl) ──
  const runDataPreview = async (q) => {
    const url = `/services/data/v${apiVersion}/` +
      (includeDeleted ? "queryAll" : "query") + "/?q=" + encodeURIComponent(q);
    const res = await sfConn.rest(url, {useCache: false});
    const rows = (res.records || []).map(flattenRecord);
    return {rows, total: res.totalSize, done: res.done !== false, next: res.done === false ? res.nextRecordsUrl : null};
  };

  // Bulk 2.0 query: create → poll → retrieve result CSV chunks.
  const runBulkQuery = async (q) => {
    const signal = unmountRef.current.signal;
    setBulkError(null);
    const job = await ffBulkQueryCreate(q, {allRows: includeDeleted, signal});
    if (signal.aborted) throw ffStoppedError();
    setBulkJob({id: job.id, state: job.state, object: objectApi.trim() || null,
      operation: job.operation || "query", createdDate: job.createdDate || new Date().toISOString(),
      api: "Bulk 2.0", query: q});
    const done = await ffBulkPoll(ffBulkQueryStatus, job.id, {
      signal,
      terminal: ["UploadResults", "JobComplete", "Failed", "Aborted"],
      onTick: j => setBulkJob(prev => prev ? {...prev, state: j.state,
        numberRecordsProcessed: j.numberRecordsProcessed,
        errorMessage: j.errorMessage || null} : prev)
    });
    // Query jobs land in UploadResults (results ready) before JobComplete.
    if (done.state === "Failed") throw new Error(done.errorMessage || "Bulk query job failed");
    // The user cancelled mid-flight: stop here instead of pulling a result set
    // they already asked to abandon.
    if (done.state === "Aborted") throw new Error("Bulk query job was cancelled");
    // Retrieve all result chunks (Sforce-Locator pagination).
    // Every chunk repeats the header row, so merge instead of concatenating.
    const chunks = [];
    let locator = null;
    let guard = 0;
    do {
      if (signal.aborted) throw ffStoppedError();
      const chunk = await ffBulkQueryResults(job.id, locator, {signal});
      chunks.push(chunk.csv);
      locator = normalizeLocator(chunk.locator);
      guard++;
    } while (locator && guard < 500);
    const csv = mergeCsvChunks(chunks);
    setBulkJob(prev => prev ? {...prev, state: done.state,
      numberRecordsProcessed: done.numberRecordsProcessed} : prev);
    const parsed = parseCsvEx(csv, {delimiter: ","});
    return {rows: parsed.records, total: parsed.records.length, done: true, next: null};
  };

  const pushHistory = (q) => {
    const entry = {...currentConfig(), query: q, ts: Date.now()};
    setHistory(prev => {
      const next = [entry,
        ...prev.filter(hh => JSON.stringify({...hh, ts: 0}) !== JSON.stringify({...entry, ts: 0}))]
        .slice(0, 15);
      ffSaveJson("ff_export_history", next);
      return next;
    });
  };

  const runPreview = async () => {
    setError(null);
    setNote(null);
    setSortCol(null);
    setSortDir(1);
    setPage(1);
    setLoading(true);
    setPreview(null);
    try {
      const q = buildQuery();
      const r = apiMode === "bulk"
        ? await runBulkQuery(q)
        : await runDataPreview(q);
      // Column order: sorted set from first row + any late additions.
      const colSet = new Set();
      r.rows.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      const columns = [...colSet];
      setPreview({columns, rows: r.rows, total: r.total, query: q,
        next: r.next, fetched: r.rows.length});
      pushHistory(q);
    } catch (e) {
      if (ffIsStopped(e)) return;
      setError(e.message);
      if (apiMode === "bulk") setBulkError(e.message);
    } finally {
      if (!unmountRef.current.signal.aborted) setLoading(false);
    }
  };

  // Load the next server page (Data API only — Bulk returns everything).
  const loadMore = async () => {
    if (!preview || !preview.next) return;
    setLoading(true);
    setError(null);
    try {
      const res = await sfConn.rest(preview.next, {useCache: false});
      const more = (res.records || []).map(flattenRecord);
      const colSet = new Set(preview.columns);
      more.forEach(row => Object.keys(row).forEach(k => colSet.add(k)));
      setPreview({...preview, rows: preview.rows.concat(more),
        columns: [...colSet], next: res.done === false ? res.nextRecordsUrl : null,
        fetched: preview.rows.length + more.length});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const cancelBulkJob = async () => {
    if (!bulkJob || !bulkJob.id) return;
    const ok = await confirmDialog({
      title: "Cancel Bulk query job?",
      message: `Job ${bulkJob.id} will be aborted in Salesforce and its results discarded.`,
      confirmLabel: "Cancel Job",
      cancelLabel: "Keep Running",
      danger: true
    });
    if (!ok) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await ffBulkJobCancel(bulkJob.id, "query");
      setBulkJob(prev => prev ? {...prev, state: "Aborted"} : prev);
      setNote("Bulk query job cancelled.");
    } catch (e) {
      setBulkError(e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  const copyJobId = async () => {
    if (!bulkJob || !bulkJob.id) return;
    try {
      await safeCopyText(bulkJob.id);
      setNote("Job ID copied.");
    } catch (e) { /* ignore */ }
  };

  // ── Downloads (always from real retrieved rows) ─────────────
  const applyDateFormat = (v) => {
    if (v == null || v === "") return v;
    const s = String(v);
    if (csvDateFormat === "iso") return v;
    if (!looksLikeSfDateTime(s)) return v;
    const d = parseSfInstant(s);
    if (!d) return v;
    if (csvDateFormat === "ymd") {
      return isDateOnlyString(s) ? s.slice(0, 10)
        : d.toISOString().replace("T", " ").slice(0, 19);
    }
    return d.toISOString();
  };

  const exportRows = () => {
    if (!preview) return [];
    return preview.rows.map(row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = (v === null || v === undefined || v === "") ? csvNullValue : applyDateFormat(v);
      }
      return out;
    });
  };

  const download = () => {
    if (!preview) return;
    const rows = exportRows();
    const base = (objectApi.trim() || "export").replace(/[^A-Za-z0-9_-]/g, "_");
    try {
      if (format === "JSON") {
        const json = includeHeaders === false ? rows
          : Object.fromEntries(preview.columns.map(c => [c, rows.map(r => r[c])]));
        downloadText(`${base}.json`, JSON.stringify(json, null, 2), "application/json;charset=utf-8");
      } else if (format === "Excel (.xlsx)") {
        ffDownloadBlob(`${base}.xlsx`,
          toXlsxBlob(base, preview.columns, rows));
      } else {
        let text = toCsvEx(preview.columns, rows, {
          delimiter: csvDelimiter, quoting: csvQuoting,
          headers: includeHeaders, nullValue: csvNullValue,
          lineEnding: csvLineEnding, guardFormulas: csvGuardFormulas !== false
        });
        if (csvEncoding === "utf8bom") text = "\uFEFF" + text;
        downloadText(`${base}.csv`, text, "text/csv;charset=utf-8");
      }
      setNote(`Downloaded ${fmtNum(rows.length)} row(s) as ${format}.`);
    } catch (e) {
      setError("Download failed: " + e.message);
    }
  };

  const copyQuery = async () => {
    try {
      await safeCopyText(preview ? preview.query : buildQuery());
      setNote("SOQL copied to clipboard.");
    } catch (e) {
      setNote("Copy failed: " + e.message);
    }
  };

  const saveCurrent = () => {
    const label = saveLabel.trim() || `${objectApi.trim() || "query"} export ${saved.length + 1}`;
    const next = [{label, ...currentConfig()},
      ...saved.filter(s => s.label !== label)].slice(0, 50);
    setSaved(next);
    ffSaveJson("ff_export_saved", next);
    setSaveLabel("");
    setNote(`Saved export "${label}".`);
  };

  const renameSaved = (oldLabel) => {
    const fresh = (window.prompt(`Rename "${oldLabel}"`, oldLabel) || "").trim();
    if (!fresh || fresh === oldLabel) return;
    const next = saved.map(s => s.label === oldLabel ? {...s, label: fresh} : s);
    setSaved(next);
    ffSaveJson("ff_export_saved", next);
  };

  const deleteSaved = (label) => {
    const next = saved.filter(s => s.label !== label);
    setSaved(next);
    ffSaveJson("ff_export_saved", next);
  };

  // ── Preview table (bounded pages + client-side sort) ────────
  const sortedRows = React.useMemo(() => {
    if (!preview) return [];
    if (sortCol == null) return preview.rows;
    return preview.rows.slice().sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }, [preview, sortCol, sortDir]);

  const pagedRows = sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const toggleSort = (col) => {
    if (sortCol !== col) { setSortCol(col); setSortDir(1); return; }
    if (sortDir === 1) { setSortDir(-1); return; }
    setSortCol(null); setSortDir(1);
  };

  const fieldTypes = {};
  if (meta && meta.fields) for (const f of meta.fields) fieldTypes[f.name] = f.type;

  // Visible field list in the explorer (search + category).
  const explorerFields = (() => {
    if (!meta || !meta.fields) return [];
    let list = meta.fields.filter(f =>
      (fieldCat === "All" || fieldCategory(f) === fieldCat) &&
      (!objFilter ||
        f.name.toLowerCase().includes(objFilter.toLowerCase()) ||
        (f.label || "").toLowerCase().includes(objFilter.toLowerCase())));
    // Fields already in the query sink to the bottom (not hidden — visible state).
    const usedSel = (/\bselect\s+([\s\S]*?)\s+from\b/i.exec(
      expMode === "object" ? `SELECT ${fields} FROM x` : query) || [null, ""])[1];
    const used = new Set(usedSel.split(",").map(s => s.trim().toLowerCase()));
    list = list.slice().sort((a, b) => (used.has(a.name.toLowerCase()) ? 1 : 0) -
      (used.has(b.name.toLowerCase()) ? 1 : 0));
    return list;
  })();
  const visibleFields = expandFields ? explorerFields.slice(0, 120) : explorerFields.slice(0, 12);

  const btnState = (label) => loading ? "…" : label;

  return h("div", {className: "insp-panel"},
    h("div", {className: "dm-layout dm-exp"},

      // ── Left: Export Setup ─────────────────────────────────
      h("div", {className: "dm-side"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DB)),
            h("span", {className: "sq3-card-t"}, "Export Setup")),
          h("label", {className: "insp-field sq3-field"},
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
          h("div", {className: "soql-save-row"},
            h("input", {
              className: "soql-save-input",
              value: saveLabel,
              placeholder: "Export name",
              onChange: e => setSaveLabel(e.target.value),
              onKeyDown: e => { if (e.key === "Enter") saveCurrent(); }
            }),
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: saveCurrent
            }, "Save Export")
          ),
          saved.length > 0 && h("div", {className: "insp-chips-row"},
            saved.slice(0, 8).map(s =>
              h("span", {key: s.label, className: "insp-chip-group"},
                h("button", {
                  className: "insp-chip",
                  title: s.query || `${s.objectApi} — ${s.fields}`,
                  onClick: () => applyConfig(s)
                }, s.label),
                h("button", {
                  className: "insp-chip-x",
                  title: `Rename "${s.label}"`,
                  onClick: () => renameSaved(s.label)
                }, "✎"),
                h("button", {
                  className: "insp-chip-x",
                  title: `Delete "${s.label}"`,
                  onClick: () => deleteSaved(s.label)
                }, "×")
              )
            )
          ),
          history.length > 0 && h("label", {className: "insp-field sq3-field"},
            h("span", null, "Export history"),
            h("select", {
              value: "",
              onChange: e => {
                const idx = parseInt(e.target.value, 10);
                if (!isNaN(idx) && history[idx]) applyConfig(history[idx]);
                e.target.value = "";
              }
            },
              h("option", {value: ""}, "— recent exports —"),
              history.map((hh, i) =>
                h("option", {key: i, value: String(i)},
                  `${new Date(hh.ts).toLocaleString()} — ${hh.objectApi || "query"}`))
            )
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "API"),
            h("select", {value: apiMode, onChange: e => setApiMode(e.target.value)},
              h("option", {value: "data"}, "Data API (synchronous query)"),
              h("option", {value: "bulk"}, "Bulk API 2.0 (large exports)")
            )
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Export mode"),
            h("select", {value: expMode, onChange: e => setExpMode(e.target.value)},
              h("option", {value: "soql"}, "SOQL Query"),
              h("option", {value: "object"}, "Object Export")
            )
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Object"),
            h("input", {
              value: objectApi,
              list: "dm-exp-objects",
              placeholder: "Account / IT_Asset__c",
              onChange: e => setObjectApi(e.target.value),
              onKeyDown: e => { if (e.key === "Enter") describe(); }
            }),
            h("datalist", {id: "dm-exp-objects"},
              objects.map(o =>
                h("option", {key: o.name, value: o.name}, `${o.label}${o.custom ? " (custom)" : ""}`))
            )
          ),
          h("div", {className: "dm-btn-row"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: loading || !objectApi.trim(),
              // Wrap: React passes the click event as the first argument, and
              // describe() treats it as an object-name override.
              onClick: () => describe()
            }, loading ? "Describing…" : "Describe")
          ),
          expMode === "object" && h("label", {className: "insp-field sq3-field"},
            h("span", null, "Fields (comma-separated)"),
            h("input", {value: fields, onChange: e => setFields(e.target.value), placeholder: "Id, Name"})
          ),
          expMode === "object" && h("label", {className: "insp-field sq3-field"},
            h("span", null, "WHERE (optional)"),
            h("input", {value: where, onChange: e => setWhere(e.target.value), placeholder: "Industry = 'Tech'"})
          ),
          expMode === "object" && h("div", {className: "dm-btn-row"},
            h("button", {className: "btn btn-secondary btn-sm", onClick: rebuildQuery,
              title: "Assemble SELECT … FROM … from Setup into the editor"},
              "Rebuild SOQL")
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Row limit (Data API)"),
            h("input", {
              type: "number", min: 1, max: 2000000, value: limit,
              onChange: e => setLimit(e.target.value),
              title: apiMode === "bulk"
                ? "Bulk API 2.0 jobs are not capped by this value — the full result set is exported."
                : "Maximum rows fetched through the synchronous Data API."
            })
          ),
          apiMode === "bulk" && h("div", {className: "insp-meta dm-note"},
            "Bulk API 2.0: row limit applies to preview only; jobs return the full result set."),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Output format"),
            h("select", {value: format, onChange: e => setFormat(e.target.value)},
              FF_EXPORT_FORMATS.map(f => h("option", {key: f, value: f}, f))
            )
          )
        )
      ),

      // ── Center: Query Builder & Preview ────────────────────
      h("div", {className: "dm-main"},
        h("div", {className: "sq3-card sq3-editor-card"},
          h("div", {className: "insp-card-title", style: {marginBottom: "8px"}},
            expMode === "object" ? "Object Export — generated SOQL" : "SOQL Query Editor"),
          expMode === "object" && h("div", {className: "sq3-card-sub"},
            "Object Export mode builds the query from Setup. Switch to SOQL Query for free editing."),
          h("div", {className: "sq3-editor-actions"},
            h("button", {className: "btn btn-secondary btn-sm", onClick: validateSoql,
              disabled: loading}, "Validate"),
            h("button", {className: "btn btn-secondary btn-sm", onClick: formatSoql,
              disabled: loading}, "Format Query"),
            h("button", {className: "btn btn-secondary btn-sm", onClick: clearQuery,
              disabled: loading}, "Clear"),
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: () => setExamplesOpen(v => !v)
            }, examplesOpen ? "Hide Examples" : "Query Examples"),
            h("button", {className: "btn btn-secondary btn-sm", onClick: copyQuery,
              title: preview ? "Copy the executed query" : "Copy the current query"},
              "Copy Query"),
            h("button", {className: "btn btn-primary btn-sm", onClick: runPreview,
              disabled: loading},
              loading ? btnState("Running…") : "Run Preview"),
            h("button", {className: "btn btn-secondary btn-sm", onClick: saveCurrent},
              "Save Export")
          ),
          examplesOpen && h("div", {className: "dm-examples"},
            QUERY_EXAMPLES.map(ex =>
              h("button", {
                key: ex.label,
                className: "dm-example",
                onClick: () => { setQuery(ex.q); setExamplesOpen(false); setNote(null); }
              }, ex.label))),
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
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runPreview();
                    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
                      e.preventDefault();
                      insertAllFields();
                    }
                  },
                  placeholder: "SELECT Id, Name FROM Account LIMIT 10000"
                })))),
          h("div", {className: "soql-hint-row"},
            h("span", null, h("kbd", null, "Ctrl"), " + ", h("kbd", null, "Enter"),
              " run · ", h("kbd", null, "Ctrl"), " + ", h("kbd", null, "Space"),
              " insert all fields")
          )
        ),

        // Field Explorer
        h("div", {className: "sq3-card"},
          h("div", {className: "soql-explorer-h"},
            h("div", {className: "insp-card-title"},
              meta ? `Field Explorer · ${meta.label || meta.name}` : "Field Explorer"),
            h("div", {className: "soql-search"},
              h("input", {
                className: "soql-search-input",
                value: objFilter,
                placeholder: meta ? "search fields…" : "select an object and Describe",
                onChange: e => setObjFilter(e.target.value)
              }))
          ),
          meta && h("div", {className: "sq3-pills", role: "group", "aria-label": "Field categories"},
            FIELD_CATS.map(c => h("button", {
              key: c,
              className: "sq3-pill" + (fieldCat === c ? " active" : ""),
              onClick: () => setFieldCat(c)
            }, `${c} (${c === "All" ? meta.fields.length : (catCounts[c] || 0)})`))
          ),
          h("div", {className: "insp-chips soql-fields sq3-field-grid"},
            !meta && h("div", {key: "__e", className: "insp-empty"},
              "Choose an object in Export Setup and click Describe to load its fields."),
            meta && (visibleFields.length
              ? visibleFields.map(f => h("button", {
                  key: f.name,
                  "data-name": f.name,
                  className: "sq3-field-btn",
                  title: `${f.label} · ${f.type} — click to insert into SELECT`,
                  onClick: () => insertField(f.name)
                },
                  h("span", {className: "sq3-field-name"}, f.name),
                  h("span", {className: "sq3-field-type"}, f.type || "")))
              : h("div", {key: "__e", className: "insp-empty"},
                  `No ${fieldCat} fields match.`))
          ),
          meta && explorerFields.length > 12 && h("button", {
            className: "sq3-expander" + (expandFields ? " expanded" : ""),
            onClick: () => setExpandFields(v => !v)
          }, expandFields ? "Show fewer" : `Show all ${explorerFields.length} fields`)
        ),

        note && h("div", {className: "insp-meta"}, note),
        error && h("div", {className: "insp-error"}, error),

        // Results preview
        preview && h("div", {className: "sq3-card sq3-results-card"},
          h("div", {className: "soql-results-h"},
            h("div", {className: "sq3-results-title"},
              h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DB)),
              h("span", {className: "insp-card-title"}, "Results Preview")),
            h("div", {className: "insp-meta"},
              `${fmtNum(preview.rows.length)} loaded · ` +
              `${fmtNum(preview.total)} total · ${preview.columns.length} columns` +
              (preview.next ? ` · page ${page}/${pageCount}` : "")),
            h("div", {className: "dm-btn-row"},
              h("button", {className: "btn btn-secondary btn-sm", onClick: download},
                ffIcon(FF_I_DOWNLOAD), h("span", null, `Download ${format}`)),
              h("button", {className: "btn btn-secondary btn-sm", onClick: copyQuery},
                "Copy Query"))
          ),
          preview.rows.length === 0
            ? h("div", {className: "insp-empty"},
                "No records matched this query.")
            : h(ResultTable, {
                columns: preview.columns,
                rows: pagedRows,
                maxRows: PAGE_SIZE,
                sortCol, sortDir, onSort: toggleSort,
                fieldTypes
              }),
          (pageCount > 1 || preview.next) && h("div", {className: "dm-pager"},
            h("button", {className: "btn btn-secondary btn-sm", disabled: page <= 1,
              onClick: () => setPage(p => Math.max(1, p - 1))}, "‹ Prev"),
            h("span", {className: "insp-meta"},
              `Page ${page} of ${pageCount}`),
            h("button", {className: "btn btn-secondary btn-sm", disabled: page >= pageCount,
              onClick: () => setPage(p => Math.min(pageCount, p + 1))}, "Next ›"),
            preview.next && h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: loading,
              onClick: loadMore
            }, loading ? "Loading…" : "Load more from server"))
        ),
        !preview && !error && h("div", {className: "insp-empty"},
          "Run a preview to see real records here.")
      ),

      // ── Right: Advanced options ────────────────────────────
      h("div", {className: "dm-adv"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_SLIDERS)),
            h("span", {className: "sq3-card-t"}, "Advanced Options")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: includeDeleted,
              onChange: e => setIncludeDeleted(e.target.checked)}),
            h("span", null, "Include deleted/recycled records",
              apiMode === "data" ? " (queryAll)" : " (queryAll job)")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: includeFormula,
              onChange: e => setIncludeFormula(e.target.checked),
              disabled: expMode !== "object"}),
            h("span", null, "Include formula fields",
              expMode !== "object" ? " (Object Export mode — formula fields are selectable in SOQL)" : "")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: includeHeaders,
              onChange: e => setIncludeHeaders(e.target.checked)}),
            h("span", null, "Include CSV headers")),
          h("div", {className: "sq3-card-sub", style: {marginTop: "10px"}}, "CSV output"),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Delimiter"),
            h("select", {value: csvDelimiter, onChange: e => setCsvDelimiter(e.target.value)},
              h("option", {value: ","}, "Comma ( , )"),
              h("option", {value: ";"}, "Semicolon ( ; )"),
              h("option", {value: "\t"}, "Tab"),
              h("option", {value: "|"}, "Pipe ( | )"))
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Quoting"),
            h("select", {value: csvQuoting, onChange: e => setCsvQuoting(e.target.value)},
              h("option", {value: "minimal"}, "Minimal (when needed)"),
              h("option", {value: "all"}, "Always quote"))
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Encoding"),
            h("select", {value: csvEncoding, onChange: e => setCsvEncoding(e.target.value)},
              h("option", {value: "utf8"}, "UTF-8"),
              h("option", {value: "utf8bom"}, "UTF-8 with BOM (Excel)"))
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Date format"),
            h("select", {value: csvDateFormat, onChange: e => setCsvDateFormat(e.target.value)},
              h("option", {value: "iso"}, "ISO 8601 (raw)"),
              h("option", {value: "ymd"}, "YYYY-MM-DD HH:MM:SS (UTC)"))
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Null/blank value"),
            h("input", {value: csvNullValue, placeholder: "(empty)",
              onChange: e => setCsvNullValue(e.target.value)})
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Line ending"),
            h("select", {value: csvLineEnding, onChange: e => setCsvLineEnding(e.target.value)},
              h("option", {value: "\r\n"}, "CRLF (Windows)"),
              h("option", {value: "\n"}, "LF (Unix)"))
          ),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: csvGuardFormulas !== false,
              onChange: e => setCsvGuardFormulas(e.target.checked)}),
            h("span", null, "Protect against spreadsheet formulas")),
          h("div", {className: "insp-meta"},
            "Cells starting with = + - @ get a leading apostrophe so spreadsheets don't run them; plain numbers like -42 are kept.")
        ),

        // Bulk 2.0 job tracking
        apiMode === "bulk" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_ZAP)),
            h("span", {className: "sq3-card-t"}, "Bulk 2.0 Query Job")),
          bulkJob
            ? h("div", {className: "dm-job"},
                h("div", {className: "dm-job-row"},
                  h("span", {className: "dm-job-k"}, "Job ID"),
                  h("span", {className: "dm-job-v dm-mono", title: bulkJob.id},
                    bulkJob.id || "—"),
                  h("button", {className: "btn btn-secondary btn-sm", onClick: copyJobId},
                    "Copy")),
                h("div", {className: "dm-job-row"},
                  h("span", {className: "dm-job-k"}, "State"),
                  h("span", {className: "dm-job-v dm-state dm-state-" +
                    String(bulkJob.state || "").toLowerCase()},
                    bulkJob.state || "—")),
                h("div", {className: "dm-job-row"},
                  h("span", {className: "dm-job-k"}, "Records processed"),
                  h("span", {className: "dm-job-v"},
                    bulkJob.numberRecordsProcessed != null
                      ? fmtNum(bulkJob.numberRecordsProcessed) : "—")),
                bulkJob.errorMessage && h("div", {className: "insp-error"},
                  bulkJob.errorMessage),
                h("div", {className: "dm-btn-row"},
                  h("button", {
                    className: "btn btn-secondary btn-sm",
                    disabled: bulkBusy ||
                      ["JobComplete", "Failed", "Aborted"].includes(bulkJob.state),
                    onClick: cancelBulkJob
                  }, bulkBusy ? "Cancelling…" : "Cancel Job")))
            : h("div", {className: "insp-empty"},
                "Run a preview with Bulk API 2.0 to create a query job."),
          bulkError && h("div", {className: "insp-error"}, bulkError)
        ),

        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_CLOCK)),
            h("span", {className: "sq3-card-t"}, "Recent Objects")),
          recents.length
            ? h("div", {className: "insp-chips"},
                recents.slice(0, 10).map(n => h("button", {
                  key: n,
                  className: "insp-chip t" + pillTone(n),
                  title: `Describe ${n}`,
                  onClick: () => { setObjectApi(n); describe(n); }
                }, n)))
            : h("div", {className: "insp-empty"},
                "Objects you Describe appear here (org-scoped).")
        )
      )
    )
  );
}

export {ExportTab};
