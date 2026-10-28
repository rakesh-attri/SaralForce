import {sf} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {countCsvRecords} from "../../core/bulk.js";
import {confirmDialog} from "../../ui/confirm.js";
import {downloadText, parseCsvEx, toCsvEx} from "../shared/csv.js";
import {ffBulkIngestCreate, ffBulkIngestUpload, ffBulkIngestClose, ffBulkIngestStatus, ffBulkIngestResults, ffBulkJobCancel, ffBulkPoll} from "../shared/bulk-api.js";
import {ffIsStopped, useUnmountSignal} from "../shared/hooks.js";
import {ffSuggestFieldMap, ffValidateImport, ffCollectionsChunkSize, ffBuildCollectionsChunk, ffMapSaveResults, ffFailChunk, ffDataResultFiles} from "../shared/import-map.js";
import {useSfTimeZoneTick, fmtDateTime, fmtNum} from "../shared/format.js";
import {ffIcon, FF_I_CLOCK, FF_I_BOOKMARK, FF_I_DOC, FF_I_ZAP} from "../shared/icons.js";
import {ffLoadJson, ffSaveJson, useFfSession} from "../shared/session-state.js";
import {ffDescribeObject} from "../shared/describe.js";

const h = React.createElement;

// ─── Data Import tab (v1.5.0 — three-column data manager) ──────────────────
// Left: setup (saved/history/operation/API/object/external ID/batch/CSV
// options). Center: upload + parse + field mapping + validation + preview.
// Right: execution (Data API batches or Bulk 2.0 ingest) + job tracking.
// Every result shown comes from actual Salesforce responses.
const FF_IMPORT_OPS = [
  {id: "insert", label: "Insert", destructive: false},
  {id: "update", label: "Update", destructive: false},
  {id: "upsert", label: "Upsert", destructive: false},
  {id: "delete", label: "Delete", destructive: true, recoverable: true},
  {id: "hardDelete", label: "Hard Delete", destructive: true, recoverable: false}
];

function ImportTab() {
  useSfTimeZoneTick();
  const unmountRef = useUnmountSignal();
  // ── Setup (left) ────────────────────────────────────────────
  const [objectApi, setObjectApi] = useFfSession("import", "objectApi", "");
  const [operation, setOperation] = useFfSession("import", "operation", "insert");
  const [apiMode, setApiMode] = useFfSession("import", "apiMode", "data"); // data | bulk
  const [externalId, setExternalId] = useFfSession("import", "externalId", "");
  const [batchSize, setBatchSize] = useFfSession("import", "batchSize", 200);
  const [csvDelimiter, setCsvDelimiter] = useFfSession("import", "csvDelimiter", ",");
  const [csvLineEnding, setCsvLineEnding] = useFfSession("import", "csvLineEnding", "\r\n");
  const [useFirstRowHeaders, setUseFirstRowHeaders] = useFfSession("import", "useFirstRowHeaders", true);
  const [ignoreBlanks, setIgnoreBlanks] = useFfSession("import", "ignoreBlanks", true);
  const [autoTrim, setAutoTrim] = useFfSession("import", "autoTrim", true);
  const [allowPartial, setAllowPartial] = useFfSession("import", "allowPartial", true);

  // ── Data (center) ───────────────────────────────────────────
  const [, setCsvText] = useFfSession("import", "csvText", "");
  const [fileName, setFileName] = useFfSession("import", "fileName", "");
  const [fileSize, setFileSize] = useFfSession("import", "fileSize", 0);
  const [headers, setHeaders] = useFfSession("import", "headers", []);
  const [records, setRecords] = useFfSession("import", "records", []);
  const [dupHeaders, setDupHeaders] = useFfSession("import", "dupHeaders", []);
  const [parseError, setParseError] = useFfSession("import", "parseError", null);
  const [fieldMap, setFieldMap] = useFfSession("import", "fieldMap", {});
  const [pasteText, setPasteText] = React.useState("");
  const [dragOver, setDragOver] = React.useState(false);

  // ── Describe / validation / preview ─────────────────────────
  const [meta, setMeta] = useFfSession("import", "meta", null);
  const [validation, setValidation] = useFfSession("import", "validation", null);
  const [mapTemplateLabel, setMapTemplateLabel] = React.useState("");
  const [mapTemplates, setMapTemplates] = React.useState(() => ffLoadJson("ff_import_templates", []));
  const loading = false; // validation is synchronous
  const [error, setError] = React.useState(null);
  const [note, setNote] = React.useState(null);
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_import_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_import_history", []));
  const [dupCheckKey, setDupCheckKey] = React.useState("");

  // ── Execution (right) ───────────────────────────────────────
  const [result, setResult] = useFfSession("import", "result", null);
  const [runJob, setRunJob] = useFfSession("import", "runJob", null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState(null);
  const [confirming, setConfirming] = React.useState(false);
  const [resultFiles, setResultFiles] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  // Data API run: {done, total} rows sent so far, and the Stop controller.
  const [dataProgress, setDataProgress] = React.useState(null);
  const dataStopRef = React.useRef(null);

  // Double-submit guard: refs are immune to stale renders.
  const runRef = React.useRef(false);

  const opDef = FF_IMPORT_OPS.find(o => o.id === operation) || FF_IMPORT_OPS[0];
  const fieldByName = {};
  if (meta && meta.fields) for (const f of meta.fields) fieldByName[f.name] = f;
  const fields = meta && meta.fields ? meta.fields : [];

  // External-ID candidates: describe fields flagged externalId/idLookup,
  // falling back to any Id-candidate list when the describe lacks flags.
  const externalIdOptions = React.useMemo(() => {
    const list = fields.filter(f => f.externalId || f.idLookup || f.name === "Id");
    return list.length ? list : [{name: "Id", label: "Id", type: "id"}];
  }, [fields]);

  // Hard Delete only when supported: Bulk API 2.0 + hardDelete operation.
  const hardDeleteSupported = apiMode === "bulk";

  // Recent objects shared with the Export tab (org-scoped localStorage).
  const [recents, setRecents] = React.useState(() => ffLoadJson("ff_recent_objects", []));
  const rememberObject = (key) => {
    try {
      const next = [key, ...ffLoadJson("ff_recent_objects", []).filter(n => n !== key)].slice(0, 12);
      ffSaveJson("ff_recent_objects", next);
      setRecents(next);
    } catch (e) { /* ignore */ }
  };

  // Auto-describe when an object is set (field dropdowns need it).
  const describeObject = React.useCallback(async (obj) => {
    const key = String(obj || "").trim();
    if (!key) return null;
    try {
      const d = await ffDescribeObject(key);
      const fieldList = (d.fields || []).map(f => ({
        name: f.name, label: f.label, type: f.type,
        custom: !!f.custom, calculated: !!f.calculated,
        nillable: f.nillable !== false,
        createable: f.createable !== false,
        updateable: f.updateable !== false,
        defaultedOnCreate: !!f.defaultedOnCreate,
        externalId: !!f.externalId,
        idLookup: !!f.idLookup,
        picklistValues: f.picklistValues || []
      }));
      const m = {name: d.name, label: d.label, fields: fieldList};
      setMeta(m);
      rememberObject(key);
      return m;
    } catch (e) {
      setError(`Describe failed for ${key}: ${e.message}`);
      setMeta(null);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (objectApi.trim()) describeObject(objectApi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectApi]);

  // ── CSV ingest (file + paste share one loader) ──────────────
  const loadCsvText = (text, name, size) => {
    setError(null);
    setNote(null);
    setResult(null);
    setValidation(null);
    if (!text) return;
    setCsvText(text);
    setFileName(name || "pasted.csv");
    setFileSize(size || text.length);
    const parsed = parseCsvEx(text, {delimiter: csvDelimiter});
    if (parsed.parseError) {
      setParseError(parsed.parseError);
      setHeaders([]);
      setRecords([]);
      setDupHeaders([]);
      setError(parsed.parseError);
      return;
    }
    setParseError(null);
    let hd = parsed.headers;
    let recs = parsed.records;
    if (!useFirstRowHeaders) {
      // Treat the first row as data: synthesize Column1..N headers.
      const n = Math.max(...parsed.records.map(r => Object.keys(r).length), hd.length);
      hd = Array.from({length: n}, (_, i) => `Column${i + 1}`);
      recs = parsed.records;
    }
    if (autoTrim) {
      recs = recs.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) out[k] = String(v == null ? "" : v).trim();
        return out;
      });
    }
    setHeaders(hd);
    setRecords(recs);
    setDupHeaders(parsed.duplicates || []);
    // Auto-map: only exact API-name hits (suggestions never guess silently).
    const autoMap = {};
    for (const col of hd) autoMap[col] = "";
    const byName = {};
    if (meta && meta.fields) {
      for (const f of meta.fields) byName[f.name.toLowerCase()] = f.name;
    }
    for (const col of hd) {
      const hit = byName[String(col).trim().toLowerCase()];
      if (hit) autoMap[col] = hit;
    }
    setFieldMap(autoMap);
    // Guess object from filename: Account.csv → Account (if nothing set).
    if (name) {
      const base = name.replace(/\.[^.]+$/, "");
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) setObjectApi(prev => prev || base);
    }
    setNote(`Parsed ${fmtNum(recs.length)} row(s) · ${hd.length} column(s)`);
  };

  const onFile = async (file) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setError("File larger than 50 MB — split it or use Bulk API 2.0 with a smaller file.");
      return;
    }
    const text = await file.text();
    loadCsvText(text, file.name, file.size);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  const loadPasted = () => {
    if (!pasteText.trim()) return;
    loadCsvText(pasteText, "", pasteText.length);
  };

  // ── Mapping helpers ─────────────────────────────────────────
  const suggestMappings = async () => {
    setError(null);
    const m = meta || await describeObject(objectApi);
    if (!m) { setError("Set an object first (auto-describe runs on selection)."); return; }
    const suggested = ffSuggestFieldMap(headers, m.fields);
    setFieldMap(suggested);
    const hitCount = Object.values(suggested).filter(Boolean).length;
    setNote(`Suggested ${hitCount} of ${headers.length} column(s).`);
    setValidation(null);
  };

  const setMapping = (col, val) => {
    setFieldMap(prev => ({...prev, [col]: val}));
    setValidation(null);
  };

  const clearMapping = (col) => setMapping(col, "");

  const duplicateTargets = React.useMemo(() => {
    const counts = {};
    for (const fa of Object.values(fieldMap)) {
      if (!fa) continue;
      counts[fa] = (counts[fa] || 0) + 1;
    }
    return counts;
  }, [fieldMap]);

  const mappingStatus = (col) => {
    const fa = fieldMap[col];
    if (!fa) return {kind: "warn", text: "Unmapped"};
    const f = fieldByName[fa];
    if (!f) return {kind: "error", text: "Unknown field"};
    if (duplicateTargets[fa] > 1) return {kind: "error", text: "Duplicate mapping"};
    if (operation === "insert" && f.createable === false) {
      return {kind: "error", text: "Not createable"};
    }
    if ((operation === "update" || operation === "upsert") &&
        f.updateable === false && f.name !== "Id") {
      return {kind: "warn", text: "Not updateable (read-only)"};
    }
    if (f.calculated) return {kind: "warn", text: "Formula field (read-only)"};
    return {kind: "ok", text: (f.type || "field") + (f.custom ? " · custom" : "")};
  };

  // ── Mapping templates ───────────────────────────────────────
  const saveTemplate = () => {
    const label = mapTemplateLabel.trim() ||
      `${objectApi.trim() || "object"} ${operation} template ${mapTemplates.length + 1}`;
    const next = [{label, objectApi: objectApi.trim(), operation, externalId,
      fieldMap}, ...mapTemplates.filter(t => t.label !== label)].slice(0, 30);
    setMapTemplates(next);
    ffSaveJson("ff_import_templates", next);
    setMapTemplateLabel("");
    setNote(`Mapping template "${label}" saved.`);
  };

  const loadTemplate = (label) => {
    const t = mapTemplates.find(x => x.label === label);
    if (!t) return;
    setObjectApi(t.objectApi || "");
    setOperation(t.operation || "insert");
    if (t.externalId !== undefined) setExternalId(t.externalId);
    setFieldMap(t.fieldMap || {});
    setValidation(null);
    setNote(`Loaded template "${t.label}".`);
  };

  const deleteTemplate = (label) => {
    const next = mapTemplates.filter(t => t.label !== label);
    setMapTemplates(next);
    ffSaveJson("ff_import_templates", next);
  };

  // ── Validation ──────────────────────────────────────────────
  const validateData = async () => {
    setError(null);
    if (!records.length) { setError("Load a CSV first."); return; }
    const m = meta || await describeObject(objectApi);
    if (!m) { setError("Set a target object first."); return; }
    const v = ffValidateImport({
      headers, records, fieldMap, fields: m.fields,
      operation, externalId
    });
    setValidation(v);
    setNote(null);
    if (!v.issues.length) {
      setNote(`All ${fmtNum(records.length)} row(s) passed client-side checks.`);
    }
  };

  const downloadErrors = () => {
    if (!validation || !validation.issues.length) return;
    const cols = ["Row", "Field", "Severity", "Problem", "Suggested correction"];
    const rows = validation.issues.map(x => ({
      Row: x.row, Field: x.field, Severity: x.severity,
      Problem: x.problem, "Suggested correction": x.suggestion || ""
    }));
    downloadText("import-validation-errors.csv", toCsvEx(cols, rows, {delimiter: ","}),
      "text/csv;charset=utf-8");
  };

  // Client-side duplicate detection (distinct from Salesforce duplicate rules).
  const runDupCheck = () => {
    const fa = fieldMap[dupCheckKey];
    if (!fa || !records.length) return;
    const seen = new Map();
    const dups = [];
    records.forEach((r, i) => {
      const v = String(r[dupCheckKey] == null ? "" : r[dupCheckKey]).trim();
      if (!v) return;
      if (seen.has(v)) dups.push({value: v, rows: [seen.get(v) + 2, i + 2]});
      else seen.set(v, i);
    });
    if (dups.length) {
      setNote(`Client-side duplicate check: ${dups.length} duplicated value(s) in ` +
        `"${dupCheckKey}" (${fa}) — e.g. "${dups[0].value}" on rows ${dups[0].rows.join(" & ")}. ` +
        `This is a plain value check, NOT Salesforce duplicate rules.`);
    } else {
      setNote(`Client-side duplicate check: no duplicates in "${dupCheckKey}". ` +
        `This does not replace Salesforce duplicate rules.`);
    }
  };

  // ── Row preparation for execution ───────────────────────────
  const prepareRows = () => {
    const active = Object.entries(fieldMap).filter(([, fa]) => fa && fieldByName[fa]);
    const out = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const body = {};
      let hasValue = false;
      let idVal = null;
      let extVal = null;
      for (const [col, fa] of active) {
        let v = rec[col];
        if (v == null) continue;
        v = String(v);
        if (autoTrim) v = v.trim();
        if (v === "" && ignoreBlanks) continue;
        if (v === "" && !ignoreBlanks) {
          body[fa] = null; // explicit blank (clears the field on update)
          hasValue = true;
          continue;
        }
        if (fa === "Id") idVal = v;
        if (fa === externalId) extVal = v;
        body[fa] = v;
        hasValue = true;
      }
      out.push({index: i, body, idVal, extVal, hasValue});
    }
    return out.filter(r => r.hasValue || operation === "delete" || operation === "hardDelete");
  };

  const pushHistory = (extra) => {
    const entry = {objectApi: objectApi.trim(), operation, apiMode,
      rows: records.length, mapped: Object.values(fieldMap).filter(Boolean).length,
      ts: Date.now(), ...extra};
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, 15);
      ffSaveJson("ff_import_history", next);
      return next;
    });
  };

  // ── Data API execution (batched, per-record results) ────────
  // sObject Collections: one call per chunk of up to 200 records
  // (allOrNone=false), each SaveResult mapped back to its source row. Chunks
  // run sequentially; Stop (or closing the view) takes effect between chunks,
  // so an in-flight call always completes and its results are reported.
  // No automatic retry (non-idempotent writes).
  const runDataImport = async (rows, stopSignal) => {
    const obj = objectApi.trim();
    const size = ffCollectionsChunkSize(batchSize);
    const successes = [];
    const failures = [];
    let sent = 0;
    let stopped = false;
    setDataProgress({done: 0, total: rows.length});
    for (let i = 0; i < rows.length; i += size) {
      if (stopSignal.aborted || unmountRef.current.signal.aborted) { stopped = true; break; }
      const chunk = rows.slice(i, i + size);
      const {send, rejected} = ffBuildCollectionsChunk(chunk, operation, externalId);
      failures.push(...rejected);
      if (send.length) {
        try {
          const results = await sf.collections(
            operation, send.map(s => s.record),
            {sobject: obj, externalIdField: externalId, allOrNone: false});
          const mapped = ffMapSaveResults(send, results, operation);
          successes.push(...mapped.successes);
          failures.push(...mapped.failures);
        } catch (e) {
          // The whole call was rejected: every row in it failed with that error.
          failures.push(...ffFailChunk(send, e.message));
        }
      }
      sent = Math.min(i + chunk.length, rows.length);
      if (!unmountRef.current.signal.aborted) setDataProgress({done: sent, total: rows.length});
      if (!allowPartial && failures.length) {
        if (sent < rows.length) {
          const next = rows[sent];
          failures.push({row: next.index + 2, index: next.index, message: "Stopped: partial success disabled"});
        }
        break;
      }
    }
    failures.sort((a, b) => a.row - b.row);
    return {successes, failures, stopped, notSent: rows.length - sent};
  };

  // ── Bulk 2.0 ingest execution ───────────────────────────────
  // Serialize mapped rows as Bulk 2.0 ingest CSV: one header line of target
  // field API names, RFC-4180 quoting, chosen line ending.
  const buildBulkCsv = (rows) => {
    const targets = [...new Set(Object.values(fieldMap).filter(fa => fa && fieldByName[fa]))];
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const eol = csvLineEnding === "\n" ? "\n" : "\r\n";
    const lines = [targets.map(esc).join(",")];
    for (const row of rows) {
      lines.push(targets.map(t => esc(row.body[t])).join(","));
    }
    return lines.join(eol);
  };

  const runBulkImport = async (rows) => {
    setBulkBusy(true);
    setBulkError(null);
    setResultFiles(null);
    try {
      const csv = buildBulkCsv(rows);
      const job = await ffBulkIngestCreate({
        operation, object: objectApi.trim(),
        externalIdFieldName: operation === "upsert" ? externalId : null,
        lineEnding: csvLineEnding
      });
      setRunJob({id: job.id, state: job.state, operation, object: objectApi.trim(),
        api: "Bulk 2.0", createdDate: job.createdDate || new Date().toISOString(),
        apiMode: "bulk"});
      await ffBulkIngestUpload(job.id, csv, {signal: unmountRef.current.signal});
      await ffBulkIngestClose(job.id, {signal: unmountRef.current.signal});
      const done = await ffBulkPoll(ffBulkIngestStatus, job.id, {
        signal: unmountRef.current.signal,
        onTick: j => setRunJob(prev => prev ? {...prev, state: j.state,
          numberRecordsProcessed: j.numberRecordsProcessed,
          numberRecordsFailed: j.numberRecordsFailed} : prev)
      });
      setRunJob(prev => prev ? {...prev, state: done.state,
        numberRecordsProcessed: done.numberRecordsProcessed,
        numberRecordsFailed: done.numberRecordsFailed,
        completedDate: done.systemModstamp || new Date().toISOString()} : prev);
      if (done.state === "Failed") {
        throw new Error(done.errorMessage || "Bulk ingest job failed");
      }
      // Retrieve the three result files (actual SF responses).
      let successText = "", failedText = "", unprocessedText = "";
      try { successText = await ffBulkIngestResults(job.id, "successfulResults"); }
      catch (e) { /* job may have no successes */ }
      try { failedText = await ffBulkIngestResults(job.id, "failedResults"); }
      catch (e) { /* no failures */ }
      try { unprocessedText = await ffBulkIngestResults(job.id, "unprocessedRecords"); }
      catch (e) { /* none */ }
      setResultFiles({success: successText, failed: failedText, unprocessed: unprocessedText});
      // Quote-aware: field values may contain line breaks.
      const successRows = countCsvRecords(successText);
      const failedRows = countCsvRecords(failedText);
      pushHistory({jobId: job.id, ok: successRows, failed: failedRows,
        total: done.numberRecordsProcessed || rows.length});
      return {ok: successRows, failed: failedRows,
        total: rows.length, jobId: job.id, bulk: true,
        failureSample: failedRows
          ? parseCsvEx(failedText).records.slice(0, 3)
            .map(r => Object.values(r).join(", ").replace(/\s+/g, " "))
          : []};
    } catch (e) {
      if (ffIsStopped(e)) return null;
      setBulkError(e.message);
      return null;
    } finally {
      if (!unmountRef.current.signal.aborted) setBulkBusy(false);
    }
  };

  const downloadResultFile = (kind) => {
    if (!resultFiles) return;
    const text = kind === "success" ? resultFiles.success
      : kind === "failed" ? resultFiles.failed : resultFiles.unprocessed;
    const name = kind === "success" ? "successful-records.csv"
      : kind === "failed" ? "failed-records.csv" : "unprocessed-records.csv";
    if (text === null || text === undefined || text === "") {
      setNote(`No ${kind} records returned by Salesforce.`);
      return;
    }
    downloadText(name, text, "text/csv;charset=utf-8");
  };

  const copyJobId = async () => {
    if (!runJob || !runJob.id) return;
    try {
      await safeCopyText(runJob.id);
      setNote("Job ID copied.");
    } catch (e) { /* ignore */ }
  };

  const cancelJob = async () => {
    if (!runJob || !runJob.id) return;
    const ok = await confirmDialog({
      title: "Abort Bulk job?",
      message: `Job ${runJob.id} will be aborted in Salesforce. Records already processed ` +
        "stay changed; unprocessed records are skipped.",
      confirmLabel: "Abort Job",
      cancelLabel: "Keep Running",
      danger: true
    });
    if (!ok) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await ffBulkJobCancel(runJob.id, "ingest");
      setRunJob(prev => prev ? {...prev, state: "Aborted"} : prev);
      setNote("Bulk job cancelled.");
    } catch (e) {
      setBulkError(e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Main run (with destructive confirmation + double-submit guard) ──
  const startRun = async () => {
    if (runRef.current) return; // already in flight
    setError(null);
    setNote(null);
    setResult(null);
    if (!objectApi.trim()) { setError("Enter a target object API name"); return; }
    if (!records.length) { setError("Load a CSV first"); return; }
    if (operation === "upsert" && !externalId) {
      setError("Upsert requires an External ID field (choose it in Import Setup)"); return;
    }
    if (operation === "hardDelete" && !hardDeleteSupported) {
      setError("Hard Delete requires Bulk API 2.0 (switch the API selector)"); return;
    }
    const rows = prepareRows();
    if (!rows.length) { setError("No mappable rows — map at least one column to a field"); return; }
    // Warn (don't block) when validation hasn't run or has errors.
    if (!validation) {
      setNote("Running without Validate Data — client-side validation is preliminary; " +
        "Salesforce remains the final authority.");
    } else if (validation.hardErrors) {
      setNote(`Continuing with ${fmtNum(validation.hardErrors)} validation error(s) — ` +
        "Salesforce will reject invalid rows and report them individually.");
    }

    runRef.current = true;
    setRunning(true);
    setConfirming(false);
    try {
      if (apiMode === "bulk") {
        const r = await runBulkImport(rows);
        if (r) setResult(r);
      } else {
        const stopper = new AbortController();
        dataStopRef.current = stopper;
        setResultFiles(null);
        const r = await runDataImport(rows, stopper.signal);
        const total = rows.length;
        const created = operation === "upsert"
          ? r.successes.filter(s => s.created === true).length : null;
        setResult({ok: r.successes.length, failed: r.failures.length, total,
          failures: r.failures.slice(0, 20), bulk: false,
          created, updated: created == null ? null : r.successes.length - created});
        setResultFiles({
          ...ffDataResultFiles({headers, records, successes: r.successes, failures: r.failures,
            operation, lineEnding: csvLineEnding}),
          dataApi: true
        });
        pushHistory({ok: r.successes.length, failed: r.failures.length, total});
        if (r.stopped) {
          setNote(`Stopped by user: ${fmtNum(r.notSent)} row(s) were not sent. ` +
            "Rows already sent stay changed.");
        } else if (r.failures.length && !allowPartial) {
          setNote("Stopped early: Allow partial success is disabled.");
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      runRef.current = false;
      dataStopRef.current = null;
      setDataProgress(null);
      setRunning(false);
    }
  };

  // Destructive ops need explicit confirmation (object + count shown).
  const needsConfirm = opDef.destructive;
  const onClickRun = () => {
    if (needsConfirm && !confirming) { setConfirming(true); return; }
    startRun();
  };

  const saveCurrent = () => {
    const label = saveLabel.trim() ||
      `${objectApi.trim() || "import"} ${operation} ${saved.length + 1}`;
    const next = [{label, objectApi: objectApi.trim(), operation, apiMode,
      externalId, batchSize, fieldMap, csvDelimiter, ignoreBlanks, autoTrim,
      allowPartial},
      ...saved.filter(s => s.label !== label)].slice(0, 50);
    setSaved(next);
    ffSaveJson("ff_import_saved", next);
    setSaveLabel("");
    setNote(`Saved import "${label}".`);
  };

  const loadSaved = (label) => {
    const s = saved.find(x => x.label === label);
    if (!s) return;
    setObjectApi(s.objectApi || "");
    setOperation(s.operation || "insert");
    setApiMode(s.apiMode || "data");
    setExternalId(s.externalId || "");
    if (s.batchSize) setBatchSize(s.batchSize);
    setFieldMap(s.fieldMap || {});
    if (s.csvDelimiter) setCsvDelimiter(s.csvDelimiter);
    if (s.ignoreBlanks !== undefined) setIgnoreBlanks(s.ignoreBlanks);
    if (s.autoTrim !== undefined) setAutoTrim(s.autoTrim);
    if (s.allowPartial !== undefined) setAllowPartial(s.allowPartial);
    setValidation(null);
    setResult(null);
    setNote(`Loaded saved import "${label}". Load the CSV again to re-parse.`);
  };

  const deleteSaved = (label) => {
    const next = saved.filter(s => s.label !== label);
    setSaved(next);
    ffSaveJson("ff_import_saved", next);
  };

  // ── Preview table (first 50 rows + severity indicators) ─────
  const previewRows = records.slice(0, 50);
  const previewRowIdx = i => validation ? (validation.rowSeverity[i] || "ok") : null;

  const stats = [
    ["Rows", fmtNum(records.length)],
    ["Columns", String(headers.length)],
    ["Object", objectApi.trim() || "—"],
    ["Operation", opDef.label],
    ["API", apiMode === "bulk" ? "Bulk 2.0" : "Data API"],
    ["Mapped", `${Object.values(fieldMap).filter(Boolean).length}/${headers.length}`],
    ["Validation", validation
      ? (validation.hardErrors
        ? `${validation.hardErrors} error(s)`
        : "Passed")
      : "Not run"]
  ];

  const statusPill = (kind) =>
    "dm-pill dm-pill-" + (kind || "ok");

  return h("div", {className: "insp-panel"},
    h("div", {className: "dm-layout dm-imp"},

      // ── Left: Import Setup ─────────────────────────────────
      h("div", {className: "dm-side"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DOC)),
            h("span", {className: "sq3-card-t"}, "Import Setup")),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Saved imports"),
            h("select", {
              value: "",
              onChange: e => { loadSaved(e.target.value); e.target.value = ""; }
            },
              h("option", {value: ""}, saved.length ? "— load —" : "No saved imports"),
              saved.map(s => h("option", {key: s.label, value: s.label}, s.label))
            )
          ),
          h("div", {className: "soql-save-row"},
            h("input", {
              className: "soql-save-input",
              value: saveLabel,
              placeholder: "Import name",
              onChange: e => setSaveLabel(e.target.value),
              onKeyDown: e => { if (e.key === "Enter") saveCurrent(); }
            }),
            h("button", {className: "btn btn-secondary btn-sm", onClick: saveCurrent},
              "Save Import")
          ),
          saved.length > 0 && h("div", {className: "insp-chips-row"},
            saved.slice(0, 6).map(s =>
              h("span", {key: s.label, className: "insp-chip-group"},
                h("button", {className: "insp-chip", title: `${s.objectApi} · ${s.operation}`,
                  onClick: () => loadSaved(s.label)}, s.label),
                h("button", {className: "insp-chip-x", title: `Delete "${s.label}"`,
                  onClick: () => deleteSaved(s.label)}, "×")
              )
            )
          ),
          history.length > 0 && h("label", {className: "insp-field sq3-field"},
            h("span", null, "Import history"),
            h("select", {value: "", onChange: e => {
              const i = parseInt(e.target.value, 10);
              if (!isNaN(i) && history[i]) {
                const hh = history[i];
                setNote(`History: ${hh.operation} ${hh.objectApi} — ` +
                  `${fmtNum(hh.ok || 0)} ok / ${fmtNum(hh.failed || 0)} failed ` +
                  `on ${new Date(hh.ts).toLocaleString()}` +
                  (hh.jobId ? ` · job ${hh.jobId}` : ""));
              }
              e.target.value = "";
            }},
              h("option", {value: ""}, "— recent imports —"),
              history.map((hh, i) => h("option", {key: i, value: String(i)},
                `${new Date(hh.ts).toLocaleString()} — ${hh.operation} ${hh.objectApi}`))
            )
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Operation"),
            h("select", {value: operation, onChange: e => {
              setOperation(e.target.value);
              setConfirming(false);
              setValidation(null);
            }},
              FF_IMPORT_OPS.map(o => h("option", {key: o.id, value: o.id,
                disabled: o.id === "hardDelete" && !hardDeleteSupported}, o.label))
            )
          ),
          operation === "hardDelete" && !hardDeleteSupported &&
            h("div", {className: "insp-warn"},
              "Hard Delete needs Bulk API 2.0 — switch the API selector."),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "API"),
            h("select", {value: apiMode, onChange: e => {
              setApiMode(e.target.value);
              if (e.target.value !== "bulk" && operation === "hardDelete") {
                setOperation("delete");
              }
            }},
              h("option", {value: "data"}, "Data API (batched REST)"),
              h("option", {value: "bulk"}, "Bulk API 2.0 (ingest job)")
            )
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Object"),
            h("input", {
              value: objectApi,
              list: "dm-imp-objects",
              placeholder: "Account / IT_Asset__c",
              onChange: e => setObjectApi(e.target.value)
            }),
            h("datalist", {id: "dm-imp-objects"},
              recents.map(n => h("option", {key: n, value: n})))
          ),
          operation === "upsert" && h("label", {className: "insp-field sq3-field"},
            h("span", null, "External ID field"),
            h("select", {value: externalId, onChange: e => setExternalId(e.target.value)},
              h("option", {value: ""},
                meta ? "— select —" : "Describe the object first"),
              externalIdOptions.map(f => h("option", {key: f.name, value: f.name},
                `${f.name} (${f.label || f.type || ""})`))
            )
          ),
          apiMode === "data" && h("label", {className: "insp-field sq3-field"},
            h("span", null, "Records per call"),
            h("input", {type: "number", min: 1, max: 200, value: batchSize,
              onChange: e => setBatchSize(e.target.value),
              title: "Records sent per sObject Collections call (1–200, default 200)"}),
            h("span", {className: "insp-meta"},
              "Records per sObject Collections request (1–200). Lower it if triggers or flows hit limits.")
          ),
          h("div", {className: "sq3-card-sub", style: {marginTop: "8px"}}, "CSV settings"),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Delimiter"),
            h("select", {value: csvDelimiter, onChange: e => setCsvDelimiter(e.target.value)},
              h("option", {value: ","}, "Comma ( , )"),
              h("option", {value: ";"}, "Semicolon ( ; )"),
              h("option", {value: "\t"}, "Tab"),
              h("option", {value: "|"}, "Pipe ( | )"))
          ),
          h("label", {className: "insp-field sq3-field"},
            h("span", null, "Line ending (export/upload)"),
            h("select", {value: csvLineEnding === "\n" ? "\n" : "\r\n",
              onChange: e => setCsvLineEnding(e.target.value)},
              h("option", {value: "\r\n"}, "CRLF (Windows)"),
              h("option", {value: "\n"}, "LF (Unix)"))
          ),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: useFirstRowHeaders,
              onChange: e => setUseFirstRowHeaders(e.target.checked)}),
            h("span", null, "Use first row as headers")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: ignoreBlanks,
              onChange: e => setIgnoreBlanks(e.target.checked)}),
            h("span", null, "Ignore blank fields")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: autoTrim,
              onChange: e => setAutoTrim(e.target.checked)}),
            h("span", null, "Auto-trim spaces")),
          h("label", {className: "sq3-check"},
            h("input", {type: "checkbox", checked: allowPartial,
              onChange: e => setAllowPartial(e.target.checked)}),
            h("span", null, "Allow partial success"))
        )
      ),

      // ── Center: Upload & Field Mapping ─────────────────────
      h("div", {className: "dm-main"},
        h("div", {className: "sq3-card"},
          h("div", {className: "insp-card-title", style: {marginBottom: "8px"}},
            "Upload Data"),
          h("div", {
            className: "dm-drop" + (dragOver ? " over" : ""),
            onDragOver: e => { e.preventDefault(); setDragOver(true); },
            onDragLeave: () => setDragOver(false),
            onDrop
          },
            h("div", {className: "dm-drop-t"}, "Drag & drop a CSV file here"),
            h("div", {className: "dm-drop-s"}, "or"),
            h("label", {className: "insp-file"},
              h("span", {className: "btn btn-secondary btn-sm"}, "Choose CSV file"),
              h("input", {
                type: "file",
                accept: ".csv,text/csv",
                style: {display: "none"},
                onChange: e => onFile(e.target.files && e.target.files[0])
              })
            )
          ),
          h("div", {className: "dm-paste-row"},
            h("textarea", {
              rows: 3,
              value: pasteText,
              placeholder: "…or paste CSV here (first line = column headers)\nId,Name,Industry\n001xx…,Acme,Technology",
              onChange: e => setPasteText(e.target.value)
            }),
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: !pasteText.trim(),
              onClick: loadPasted
            }, "Load pasted CSV")
          ),
          records.length > 0 && h("div", {className: "dm-stats"},
            h("span", {className: "dm-stat"},
              h("b", null, fileName || "pasted.csv")),
            fileSize > 0 && h("span", {className: "dm-stat"},
              `${(fileSize / 1024).toFixed(1)} KB`),
            stats.map(([k, v]) => h("span", {key: k, className: "dm-stat"},
              h("i", null, k + ": "), v)),
            h("span", {className: statusPill(validation
              ? (validation.hardErrors ? "error" : "ok") : "idle")},
              validation
                ? (validation.hardErrors ? "Validation: errors" : "Validation: passed")
                : "Validation: not run")
          ),
          parseError && h("div", {className: "insp-error"}, parseError),
          dupHeaders.length > 0 && h("div", {className: "insp-warn"},
            `Duplicate CSV header(s): ${dupHeaders.join(", ")} — rename them before importing.`)
        ),

        // Field mapping
        headers.length > 0 && h("div", {className: "sq3-card"},
          h("div", {className: "soql-results-h"},
            h("div", {className: "insp-card-title"}, "Field Mapping"),
            h("div", {className: "dm-btn-row"},
              h("button", {className: "btn btn-secondary btn-sm", onClick: suggestMappings},
                "Auto-suggest"),
              h("button", {className: "btn btn-secondary btn-sm",
                onClick: () => { setFieldMap({}); setValidation(null); }},
                "Clear all"))),
          h("div", {className: "dm-map"},
            h("div", {className: "dm-map-head"},
              h("span", null, "CSV Column"),
              h("span", null, "Sample value"),
              h("span", null, "Salesforce field"),
              h("span", null, "Status")),
            headers.map(col => {
              const sampleRec = records.find(r => String(r[col] || "").trim() !== "");
              const sample = sampleRec ? String(sampleRec[col]) : "";
              const st = mappingStatus(col);
              const fa = fieldMap[col] || "";
              return h("div", {key: col, className: "dm-map-row"},
                h("span", {className: "dm-map-csv", title: col}, col),
                h("span", {className: "dm-map-sample", title: sample},
                  sample.length > 40 ? sample.slice(0, 40) + "…" : (sample || "—")),
                h("span", {className: "dm-map-field"},
                  h("input", {
                    list: "dm-field-options",
                    value: fa,
                    placeholder: "Field API name (type to search)",
                    onChange: e => setMapping(col, e.target.value)
                  }),
                  fa && h("button", {
                    className: "insp-chip-x",
                    title: "Clear mapping",
                    onClick: () => clearMapping(col)
                  }, "×")),
                h("span", {className: statusPill(st.kind), title: st.text}, st.text)
              );
            })
          ),
          h("datalist", {id: "dm-field-options"},
            fields.map(f => h("option", {key: f.name, value: f.name},
              `${f.label || f.name} (${f.type || ""})`))),
          h("div", {className: "dm-tpl-row"},
            h("input", {
              value: mapTemplateLabel,
              placeholder: "Template name",
              onChange: e => setMapTemplateLabel(e.target.value)
            }),
            h("button", {className: "btn btn-secondary btn-sm", onClick: saveTemplate},
              "Save Template"),
            mapTemplates.length > 0 && h("select", {
              value: "",
              onChange: e => { loadTemplate(e.target.value); e.target.value = ""; }
            },
              h("option", {value: ""}, "— load template —"),
              mapTemplates.map(t => h("option", {key: t.label, value: t.label}, t.label)))),
          mapTemplates.length > 0 && h("div", {className: "insp-chips-row"},
            mapTemplates.slice(0, 6).map(t =>
              h("span", {key: t.label, className: "insp-chip-group"},
                h("button", {className: "insp-chip", onClick: () => loadTemplate(t.label)},
                  t.label),
                h("button", {className: "insp-chip-x",
                  onClick: () => deleteTemplate(t.label)}, "×"))))
        ),

        // Validation actions
        headers.length > 0 && h("div", {className: "sq3-card"},
          h("div", {className: "soql-results-h"},
            h("div", {className: "insp-card-title"}, "Validate Data"),
            h("div", {className: "dm-btn-row"},
              h("button", {
                className: "btn btn-primary btn-sm",
                disabled: loading || !records.length,
                onClick: validateData
              }, loading ? "Validating…" : "Validate Data"),
              validation && validation.issues.length > 0 && h("button", {
                className: "btn btn-secondary btn-sm",
                onClick: downloadErrors
              }, "Download error CSV"),
              records.length > 0 && h("select", {
                className: "dm-dupselect",
                value: dupCheckKey,
                onChange: e => setDupCheckKey(e.target.value),
                title: "Client-side duplicate check column"
              },
                h("option", {value: ""}, "Duplicate check…"),
                headers.map(c => h("option", {key: c, value: c}, c))),
              dupCheckKey && h("button", {
                className: "btn btn-secondary btn-sm",
                onClick: runDupCheck
              }, "Run duplicate check"))),
          validation && h("div", {className: "dm-valstats"},
            h("span", {className: "dm-pill dm-pill-ok"},
              `${fmtNum(validation.okRows)} ok`),
            h("span", {className: "dm-pill dm-pill-warn"},
              `${fmtNum(validation.warnRows)} warning(s)`),
            h("span", {className: "dm-pill dm-pill-error"},
              `${fmtNum(validation.errorRows)} error(s)`),
            h("span", {className: "insp-meta"},
              "Client-side validation is preliminary — Salesforce decides the final result.")),
          validation && validation.issues.length > 0 && h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table dm-valtable"},
              h("thead", null, h("tr", null,
                h("th", null, "Row"), h("th", null, "Field"),
                h("th", null, "Problem"), h("th", null, "Severity"),
                h("th", null, "Suggested fix"))),
              h("tbody", null,
                validation.issues.slice(0, 100).map((x, i) => h("tr", {key: i},
                  h("td", null, x.row === 0 ? "—" : x.row),
                  h("td", null, x.field),
                  h("td", null, x.problem),
                  h("td", null, h("span", {className: statusPill(
                    x.severity === "error" ? "error" : "warn")}, x.severity)),
                  h("td", null, x.suggestion || "—")))),
              validation.issues.length > 100 && h("tfoot", null, h("tr", null,
                h("td", {colSpan: 5},
                  `Showing 100 of ${validation.issues.length} — download the error CSV for all.`)))))
        ),

        // Preview table with row indicators
        previewRows.length > 0 && h("div", {className: "sq3-card"},
          h("div", {className: "insp-card-title", style: {marginBottom: "8px"}},
            `Import Preview · first ${previewRows.length} of ${fmtNum(records.length)}`),
          h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table"},
              h("thead", null, h("tr", null,
                h("th", {className: "dm-sev-col"}, ""),
                h("th", null, "#"),
                headers.map(c => h("th", {key: c}, c)))),
              h("tbody", null,
                previewRows.map((r, i) => {
                  const sev = previewRowIdx(i);
                  return h("tr", {key: i,
                    className: sev === "error" ? "dm-row-error"
                      : sev === "warn" ? "dm-row-warn" : "",
                    title: sev === "error" ? "This row has validation errors"
                      : sev === "warn" ? "This row has validation warnings" : undefined},
                    h("td", {className: "dm-sev-col"},
                      sev ? h("span", {className: statusPill(sev), title: sev},
                        sev === "error" ? "!" : sev === "warn" ? "△" : "✓") : ""),
                    h("td", null, i + 2),
                    headers.map(c => h("td", {key: c},
                      String(r[c] == null ? "" : r[c]).slice(0, 60))));
                })))),
          records.length > previewRows.length && h("div", {className: "insp-more"},
            `Showing first ${previewRows.length} of ${fmtNum(records.length)} rows.`)
        ),

        note && h("div", {className: "insp-meta"}, note),
        error && h("div", {className: "insp-error"}, error),

        // The action bar + destructive confirmation live at the end of the
        // layout (see below), not inside this column — see the note there.

        result && h("div", {
          className: result.failed ? "insp-warn" : "insp-ok"
        },
          `Imported ${fmtNum(result.ok)}/${fmtNum(result.total)} — ` +
          `${fmtNum(result.failed)} failed` +
          (result.jobId ? ` · job ${result.jobId}` : "") +
          (result.failures && result.failures.length
            ? ` — first errors: ${result.failures.slice(0, 3)
                .map(f => `row ${f.row}: ${f.message}`).join("; ")}`
            : "") +
          (result.failureSample && result.failureSample.length
            ? ` — failed rows: ${result.failureSample.slice(0, 2).join(" | ")}`
            : "") +
          (result.created != null
            ? ` · ${fmtNum(result.created)} created, ${fmtNum(result.updated)} updated`
            : "")),
        result && !result.bulk && resultFiles && resultFiles.dataApi && h("div", {className: "dm-resultfiles"},
          h("div", {className: "sq3-card-sub"}, "Result files (from the Salesforce responses)"),
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => downloadResultFile("success")},
            "Download successful records"),
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => downloadResultFile("failed")},
            "Download failed records"))
      ),

      // ── Right: Execution & Job Tracking ────────────────────
      h("div", {className: "dm-adv"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_ZAP)),
            h("span", {className: "sq3-card-t"}, "Execution")),
          h("div", {className: "dm-job"},
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Mode"),
              h("span", {className: "dm-job-v"},
                apiMode === "bulk" ? "Bulk API 2.0 ingest" : "Data API (sObject Collections)")),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Operation"),
              h("span", {className: "dm-job-v"}, opDef.label)),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Object"),
              h("span", {className: "dm-job-v"}, objectApi.trim() || "—")),
            apiMode === "data" && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Records per call"),
              h("span", {className: "dm-job-v"}, ffCollectionsChunkSize(batchSize))),
            operation === "upsert" && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "External ID"),
              h("span", {className: "dm-job-v"}, externalId || "—"))
          ),
          apiMode === "data"
            ? h("div", {className: "sq3-card-sub"},
                "Records are sent in sObject Collections calls (up to 200 each); every success and failure is captured from its own SaveResult. Partial success is reported honestly — never as full success.")
            : h("div", {className: "sq3-card-sub"},
                "Bulk ingest: create job → upload CSV → close → poll → download result files.")
        ),

        runJob && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_CLOCK)),
            h("span", {className: "sq3-card-t"}, "Import Job")),
          h("div", {className: "dm-job"},
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Job ID"),
              h("span", {className: "dm-job-v dm-mono", title: runJob.id},
                runJob.id || "—"),
              h("button", {className: "btn btn-secondary btn-sm", onClick: copyJobId},
                "Copy")),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Operation"),
              h("span", {className: "dm-job-v"},
                (FF_IMPORT_OPS.find(o => o.id === runJob.operation) || {}).label ||
                runJob.operation)),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Object"),
              h("span", {className: "dm-job-v"}, runJob.object || "—")),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "API"),
              h("span", {className: "dm-job-v"}, runJob.api || "Bulk 2.0")),
            h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Status"),
              h("span", {className: "dm-job-v dm-state dm-state-" +
                String(runJob.state || "").toLowerCase()},
                runJob.state || "—")),
            runJob.numberRecordsProcessed != null && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Processed"),
              h("span", {className: "dm-job-v"},
                fmtNum(runJob.numberRecordsProcessed))),
            runJob.numberRecordsFailed != null && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Failed"),
              h("span", {className: "dm-job-v"},
                fmtNum(runJob.numberRecordsFailed))),
            runJob.createdDate && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Started"),
              h("span", {className: "dm-job-v"}, fmtDateTime(runJob.createdDate))),
            runJob.completedDate && h("div", {className: "dm-job-row"},
              h("span", {className: "dm-job-k"}, "Completed"),
              h("span", {className: "dm-job-v"}, fmtDateTime(runJob.completedDate))),
            h("div", {className: "dm-btn-row"},
              h("button", {
                className: "btn btn-secondary btn-sm",
                disabled: bulkBusy || ["JobComplete", "Failed", "Aborted"].includes(runJob.state),
                onClick: cancelJob
              }, bulkBusy ? "Cancelling…" : "Cancel Job"))
          ),
          bulkError && h("div", {className: "insp-error"}, bulkError),
          resultFiles && !resultFiles.dataApi && h("div", {className: "dm-resultfiles"},
            h("div", {className: "sq3-card-sub"}, "Result files (from Salesforce)"),
            h("button", {className: "btn btn-secondary btn-sm",
              onClick: () => downloadResultFile("success")},
              "Download successful records"),
            h("button", {className: "btn btn-secondary btn-sm",
              onClick: () => downloadResultFile("failed")},
              "Download failed records"),
            h("button", {className: "btn btn-secondary btn-sm",
              onClick: () => downloadResultFile("unprocessed")},
              "Download unprocessed records"))
        ),

        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_BOOKMARK)),
            h("span", {className: "sq3-card-t"}, "Security notes")),
          h("ul", {className: "dm-security"},
            h("li", null, "Runs on your existing Salesforce session — no tokens stored."),
            h("li", null, "CRUD/FLS still apply: Salesforce rejects what you can't do."),
            h("li", null, "Destructive operations always ask for confirmation."),
            h("li", null, "Saved configs are scoped to this org (localStorage key suffix)."))
        )
      ),

      // ── Action bar (spans the full layout) ─────────────────
      // It used to sit inside the centre column, whose height is smaller than
      // the row: once the page scrolled past that column the bar scrolled out
      // of the viewport and the Run button became unreachable. As its own
      // full-width row at the end of the grid it is always the last thing in
      // the scroll range, so it is reachable at every scroll position (and
      // becomes a fixed bottom bar below 860px, where the columns stack).
      h("div", {className: "dm-runbar"},
        h("button", {
          className: "btn btn-primary",
          disabled: running || bulkBusy || !records.length,
          onClick: onClickRun,
          "data-testid": "dm-import-run"
        },
          running || bulkBusy
            ? (apiMode === "bulk" ? "Bulk job running…"
              : (dataProgress
                ? `Importing… ${fmtNum(dataProgress.done)}/${fmtNum(dataProgress.total)}`
                : "Importing…"))
            : (confirming
              ? `Click again to confirm ${opDef.label} of ${fmtNum(records.length)} rows`
              : `${opDef.label} ${fmtNum(records.length)} row(s)`)),
        confirming && h("button", {
          className: "btn btn-secondary",
          onClick: () => setConfirming(false)
        }, "Cancel"),
        running && apiMode === "data" && h("button", {
          className: "btn btn-secondary",
          title: "Stops after the records currently being sent; nothing is rolled back",
          onClick: () => { if (dataStopRef.current) dataStopRef.current.abort(); }
        }, "Stop"),
        needsConfirm && !confirming && h("span", {className: "insp-meta"},
          "Destructive operation — you'll be asked to confirm.")),
      needsConfirm && confirming && h("div", {className: "dm-danger"},
        h("div", {className: "dm-danger-t"},
          `Confirm ${opDef.label}: ${records.length} ${objectApi.trim()} record(s)`),
        h("div", {className: "dm-danger-b"},
          opDef.recoverable
            ? "Deleted records go to the Salesforce Recycle Bin and can be restored within 15 days (subject to org setup)."
            : "Hard Delete removes records permanently — they bypass the Recycle Bin and CANNOT be recovered."),
        h("div", {className: "dm-danger-b"},
          `API: ${apiMode === "bulk" ? "Bulk 2.0" : "Data API"} · ` +
          "No automatic retries will be attempted for this operation."))
    )
  );
}

export {ImportTab};
