import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {escapeSoqlLike} from "../../core/soql.js";
import {confirmDialog} from "../../ui/confirm.js";
import {isDateOnlyString, parseSfInstant, formatSfDateTime} from "../../sf-time.js";
import {downloadText} from "../shared/csv.js";
import {runSoql} from "../shared/query.js";
import {useUnmountSignal} from "../shared/hooks.js";
import {kickSfTzFetch, useSfTimeZoneTick} from "../shared/format.js";
import {ResultTable} from "../shared/result-table.js";
import {logsAskLlm} from "../shared/ai.js";
import {excerptLog} from "../../core/llm.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {useFfSession} from "../shared/session-state.js";
import {appTabsResolveCurrentUserId, usersEnsureDebugLevel, parseApexLog} from "../shared/apex-debug.js";

const h = React.createElement;

function ffDatetimeLocal(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ffFmtTs(x) {
  if (!x) return "—";
  kickSfTzFetch();
  // Salesforce record instants (TraceFlag/Log StartTime) render in the SF
  // user zone; date-only values pass through; local epoch numbers fall back.
  if (isDateOnlyString(String(x))) return String(x).slice(0, 10);
  const d = parseSfInstant(x);
  if (!d) {
    const t = new Date(x);
    return isNaN(t.getTime()) ? String(x) : t.toLocaleString();
  }
  return formatSfDateTime(d);
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
  const t = escapeSoqlLike(term.trim());
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
  // Errors near the end of long logs matter most: keep the head, tail and
  // every exception window rather than only the first maxChars characters.
  return `${head}\n\n${excerptLog(body, maxChars || 12000)}`;
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

function LogsTab() {
  useSfTimeZoneTick();
  const unmountRef = useUnmountSignal();
  const [entityType, setEntityType] = useFfSession("logs", "entityType", "User");
  const [lookupText, setLookupText] = React.useState("");
  const [lookupRes, setLookupRes] = React.useState([]);
  const [lookupBusy, setLookupBusy] = React.useState(false);
  const [lookupErr, setLookupErr] = React.useState(null);
  const [entity, setEntity] = useFfSession("logs", "entity", null);
  const [start, setStart] = useFfSession("logs", "start", () => ffDatetimeLocal(new Date(Date.now() - 30 * 60000)));
  const [end, setEnd] = useFfSession("logs", "end", () => ffDatetimeLocal(new Date(Date.now() + 60 * 60000)));
  const [levels, setLevels] = React.useState([]);
  const [levelId, setLevelId] = useFfSession("logs", "levelId", "");
  const [flags, setFlags] = React.useState([]);
  const [formErr, setFormErr] = React.useState(null);
  const [formMsg, setFormMsg] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [flagBusy, setFlagBusy] = React.useState(null);

  const [logs, setLogs] = useFfSession("logs", "logs", []);
  const [logsErr, setLogsErr] = React.useState(null);
  const [logsNote, setLogsNote] = useFfSession("logs", "logsNote", null);
  const [logsBusy, setLogsBusy] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = useFfSession("logs", "hasMore", false);
  const [search, setSearch] = useFfSession("logs", "search", "");
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [matched, setMatched] = useFfSession("logs", "matched", null);
  const [bodies, setBodies] = React.useState({});
  const [openLog, setOpenLog] = useFfSession("logs", "openLog", null);
  const [logFilter, setLogFilter] = useFfSession("logs", "logFilter", "");
  const [debugOnly, setDebugOnly] = useFfSession("logs", "debugOnly", false);
  const [selId, setSelId] = useFfSession("logs", "selId", null);
  const [analyses, setAnalyses] = useFfSession("logs", "analyses", {});
  const [analyzingId, setAnalyzingId] = React.useState(null);
  const [chats, setChats] = useFfSession("logs", "chats", {});
  const [chatInput, setChatInput] = useFfSession("logs", "chatInput", "");
  const [chatBusy, setChatBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [delBusy, setDelBusy] = React.useState(null);
  const [delAllOpen, setDelAllOpen] = React.useState(false);
  const [delAllText, setDelAllText] = React.useState("");
  const [delAllBusy, setDelAllBusy] = React.useState(false);
  const [delProgress, setDelProgress] = React.useState(null);
  const [delResult, setDelResult] = React.useState(null);
  const [win, setWin] = useFfSession("logs", "win", null);
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
    const ok = await confirmDialog({
      title: "Delete trace flag?",
      message: `Trace flag ${id} will be deleted and debug logging for this entity stops.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
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
    const signal = unmountRef.current.signal;
    setSearchBusy(true);
    setLogsErr(null);
    try {
      const list = logs.slice(0, LOGS_SEARCH_CAP);
      const next = {...bodies};
      for (let i = 0; i < list.length; i += 4) {
        if (signal.aborted) return;
        const chunk = list.slice(i, i + 4);
        await Promise.all(chunk.map(async lg => {
          if (next[lg.Id] != null) return;
          try { next[lg.Id] = await logsFetchBody(lg.Id); }
          catch (e) { next[lg.Id] = ""; }
        }));
        if (signal.aborted) return;
        setBodies({...next});
      }
      setBodies(next);
      const low = term.toLowerCase();
      setMatched(list.filter(lg => String(next[lg.Id] || "").toLowerCase().includes(low)).map(lg => lg.Id));
    } catch (err) {
      if (!signal.aborted) setLogsErr(err.message);
    } finally {
      if (!signal.aborted) setSearchBusy(false);
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
    const ok = await confirmDialog({
      title: "Delete debug log?",
      message: `Log ${lg.Id} will be permanently deleted from the org.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
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

export {LogsTab};
