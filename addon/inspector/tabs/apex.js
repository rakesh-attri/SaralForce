import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {downloadText} from "../shared/csv.js";
import {useSfTimeZoneTick, ffFmtRelative} from "../shared/format.js";
import {ffIcon, FF_I_CLOCK, FF_I_BOOKMARK, FF_I_DOC, FF_I_ZAP} from "../shared/icons.js";
import {apexAiCheck} from "../shared/ai.js";
import {ffLoadJson, ffSaveJson, useFfSession} from "../shared/session-state.js";
import {Celebrate} from "../shared/celebrate.js";
import {apexHighlight} from "../shared/highlight.js";
import {appTabsResolveCurrentUserId, parseApexLog} from "../shared/apex-debug.js";

const h = React.createElement;

// Apex log levels for the TraceFlag DebugLevel (single dropdown drives
// every workflow category).
const APEX_LOG_LEVELS = ["Error", "Warn", "Info", "Debug", "Fine", "Finer", "Finest"];

// Display name for a history entry: first non-empty code line, truncated.
function apexRecentName(h) {
  const first = String((h && h.code) || "").split("\n").map(s => s.trim()).find(s => s);
  return (first || "(empty script)").slice(0, 40);
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

async function apexExecute(code, opts) {
  const timeoutMs = opts && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
  const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/executeAnonymous/?anonymousBody=` +
    encodeURIComponent(code), {useCache: false, timeoutMs});
  return res || {};
}

// Debug log level support: one DebugLevel record per level value
// (all workflow categories set to that level), then a 30-minute user
// TraceFlag pointing at it. Best-effort — callers proceed with org
// defaults when any step fails.
const _apexDebugLevelCache = {};
async function apexDebugLevelId(level) {
  const name = "SaralForce_" + level;
  if (_apexDebugLevelCache[name]) return _apexDebugLevelCache[name];
  const found = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
    encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${name}' LIMIT 1`),
    {useCache: false});
  if (found.records && found.records.length) {
    _apexDebugLevelCache[name] = found.records[0].Id;
    return found.records[0].Id;
  }
  const created = await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`, {
    method: "POST",
    body: {
      DeveloperName: name, MasterLabel: name,
      ApexCode: level, ApexProfiling: level, Callout: level,
      Database: level, System: level, Validation: level,
      Visualforce: level, Workflow: level
    }
  });
  if (!created || !created.id) throw new Error("DebugLevel create returned no id");
  _apexDebugLevelCache[name] = created.id;
  return created.id;
}

async function apexEnsureTraceFlag(logLevel) {
  const userId = await appTabsResolveCurrentUserId();
  const existing = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
    encodeURIComponent(
      `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND ExpirationDate > ${new Date().toISOString()} LIMIT 1`),
    {useCache: false});
  if (existing.records && existing.records.length) return existing.records[0].Id;
  const levelId = await apexDebugLevelId(logLevel);
  const start = new Date();
  const exp = new Date(start.getTime() + 30 * 60000);
  const created = await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
    method: "POST",
    body: {
      TracedEntityId: userId, LogType: "USER_DEBUG", DebugLevelId: levelId,
      StartDate: start.toISOString(), ExpirationDate: exp.toISOString()
    }
  });
  if (!created || !created.id) throw new Error("TraceFlag create returned no id");
  return created.id;
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

function ApexTab() {
  useSfTimeZoneTick();
  const [code, setCode] = useFfSession("apex", "code", "System.debug('Hello from SaralForce');");
  const [running, setRunning] = React.useState(false);
  const [exec, setExec] = useFfSession("apex", "exec", null);
  const [error, setError] = React.useState(null);
  const [log, setLog] = useFfSession("apex", "log", null);
  const [logNote, setLogNote] = React.useState(null);
  const [logLoading, setLogLoading] = React.useState(false);
  const [openLog, setOpenLog] = useFfSession("apex", "openLog", true);
  const [debugOnly, setDebugOnly] = useFfSession("apex", "debugOnly", false);
  const [eventFilter, setEventFilter] = useFfSession("apex", "eventFilter", "");
  const [logFilter, setLogFilter] = useFfSession("apex", "logFilter", "");
  const [history, setHistory] = React.useState(() => ffLoadJson("ff_apex_history", []));
  const [saved, setSaved] = React.useState(() => ffLoadJson("ff_apex_saved", []));
  const [saveLabel, setSaveLabel] = React.useState("");
  const [logLevel, setLogLevel] = useFfSession("apex", "logLevel", "Debug");
  const [timeoutSec, setTimeoutSec] = useFfSession("apex", "timeoutSec", 120);
  const [durationMs, setDurationMs] = React.useState(null);
  const [lastRunAt, setLastRunAt] = React.useState(null);
  const [lastModified, setLastModified] = React.useState(null);
  const [resultView, setResultView] = React.useState("logs");
  const [resultsCollapsed, setResultsCollapsed] = React.useState(false);
  const [showAllHistory, setShowAllHistory] = React.useState(false);
  const [showAllSaved, setShowAllSaved] = React.useState(false);
  const firstCode = React.useRef(true);
  React.useEffect(() => {
    if (firstCode.current) { firstCode.current = false; return; }
    setLastModified(Date.now());
  }, [code]);
  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);
  const [celeb, setCeleb] = React.useState(0);
  const [selRange, setSelRange] = React.useState({start: 0, end: 0});
  const [useAi, setUseAi] = useFfSession("apex", "useAi", false);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiCheck, setAiCheck] = React.useState(null);
  const [aiNote, setAiNote] = React.useState(null);

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
      const next = [{label, code: snippet, ts: Date.now()},
        ...prev.filter(t => t.label !== label)].slice(0, 30);
      ffSaveJson("ff_apex_saved", next);
      return next;
    });
    setSaveLabel("");
  };

  const saveInputRef = React.useRef(null);
  const focusSaveInput = () => {
    const el = saveInputRef.current;
    if (!el) return;
    try {
      el.scrollIntoView({behavior: "smooth", block: "nearest"});
      el.focus({preventScroll: true});
    } catch (e) { /* ignore */ }
  };
  const saveScriptOrFocus = () => {
    if (saveLabel.trim() && String(code || "").trim()) { saveTemplate(); return; }
    focusSaveInput();
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
    const timeoutMs = Math.round(Number(timeoutSec) * 1000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 600000) {
      setError("Timeout must be between 10 and 600 seconds.");
      return;
    }
    setRunning(true);
    setError(null);
    setExec(null);
    setLog(null);
    setLogNote(null);
    setAiNote(null);
    setAiCheck(null);
    setDurationMs(null);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      // Log level: make sure a TraceFlag points at a matching DebugLevel.
      // Any failure degrades to org defaults — the run still proceeds.
      try {
        await apexEnsureTraceFlag(logLevel);
      } catch (e) {
        setLogNote("TraceFlag setup failed (" + e.message + ") — continuing with org defaults.");
      }
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
      const r = await apexExecute(snippet, {timeoutMs});
      setExec(r);
      setLastRunAt(new Date().toISOString());
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
      let msg = e.message;
      // XHR timeout surfaces as a network error — label it when the run
      // actually ran past the deadline.
      if (timeoutMs && Date.now() - startMs >= timeoutMs - 250) {
        msg += " (stopped: timeout reached)";
      }
      setError(msg);
      pushHistory(snippet, false);
    } finally {
      setDurationMs(Date.now() - startMs);
      setRunning(false);
    }
  };

  const clearApex = () => {
    setCode("");
    setExec(null);
    setLog(null);
    setLogNote(null);
    setError(null);
    setDurationMs(null);
    setLastRunAt(null);
    setSelRange({start: 0, end: 0});
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
  // Parsed once per render for the Logs + Result tabs (same row markup as
  // before, probe-visible classes preserved).
  const logRows = log ? parseApexLog(log) : [];
  const debugRows = logRows.filter(r => r.event === "USER_DEBUG");

  return h("div", {className: "insp-panel"},
    h("div", {className: "apex-layout"},
      h("div", {className: "apex-side"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_ZAP)),
            h("span", {className: "sq3-card-t"}, "Apex Execution")),
          h("div", {className: "sq3-card-sub"},
            "Execute Apex code, run anonymous scripts, and view logs."),
          h("div", {className: "apex-mini-row"},
            h("label", {className: "apex-mini-field"},
              h("span", null, "Log Level"),
              h("select", {
                value: logLevel,
                onChange: e => setLogLevel(e.target.value)
              }, APEX_LOG_LEVELS.map(l => h("option", {key: l, value: l}, l)))),
            h("label", {className: "apex-mini-field"},
              h("span", null, "Timeout (seconds)"),
              h("input", {
                type: "number", min: 10, max: 600,
                value: timeoutSec,
                onChange: e => setTimeoutSec(e.target.value)
              }))),
          h("button", {
            className: "btn btn-primary apex-exec-btn",
            disabled: running || !String(code || "").trim(),
            title: "Execute the whole script (Ctrl+Enter)",
            onClick: () => run()
          }, ffIcon(FF_I_ZAP), h("span", null, "Execute")),
          h("span", {className: "sq3-kbd-hint"}, "Ctrl+Enter"),
          h("button", {
            className: "btn btn-secondary btn-sm apex-exec-btn apex-hl-btn",
            disabled: running || !hasSel,
            title: hasSel ? "Execute only the selected code" : "Select code in the editor first",
            onClick: runHighlighted
          }, "Execute Highlighted"),
          h("div", {className: "sq3-btn-row"},
            h("button", {className: "btn btn-secondary btn-sm", disabled: running, onClick: clearApex}, "Clear"),
            h("button", {className: "btn btn-secondary btn-sm", disabled: running || !String(code || "").trim(), onClick: saveScriptOrFocus}, "Save Script"))
        ),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_CLOCK)),
            h("span", {className: "sq3-card-t"}, "Recent Scripts"),
            (history.length > 5) && h("button", {className: "sq3-viewall", onClick: () => setShowAllHistory(v => !v)},
              showAllHistory ? "Show less" : `View All (${history.length})`)),
          (showAllHistory ? history : history.slice(0, 5)).map((hh, i) =>
            h("div", {
              key: i,
              className: "sq3-saved-row",
              role: "button",
              tabIndex: 0,
              title: hh.code,
              onClick: () => { setCode(hh.code); setSelRange({start: 0, end: 0}); },
              onKeyDown: e => { if (e.key === "Enter") { setCode(hh.code); setSelRange({start: 0, end: 0}); } }
            },
              h("span", {className: "sq3-saved-ico", "aria-hidden": "true"}, ffIcon(FF_I_DOC)),
              h("span", {className: "sq3-saved-tx"},
                h("span", {className: "sq3-saved-label"}, apexRecentName(hh)),
                h("span", {className: "sq3-saved-q"}, `Apex · ${ffFmtRelative(hh.ts)} ${hh.ok ? "✓" : "✗"}`)),
              h("span", {className: "sq3-saved-chev", "aria-hidden": "true"}, "›"))),
          !history.length && h("div", {className: "insp-meta"}, "No executions yet · run a script to see it here.")
        ),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_BOOKMARK)),
            h("span", {className: "sq3-card-t"}, "Saved Scripts"),
            (saved.length > 5) && h("button", {className: "sq3-viewall", onClick: () => setShowAllSaved(v => !v)},
              showAllSaved ? "Show less" : `View All (${saved.length})`)),
          h("div", {className: "insp-chips-row"},
            (showAllSaved ? saved : saved.slice(0, 5)).map(s =>
              h("span", {key: s.label, className: "insp-chip-group apex-saved-group"},
                h("button", {
                  className: "insp-chip apex-saved-chip",
                  title: s.code.slice(0, 160),
                  onClick: () => { setCode(s.code); setSelRange({start: 0, end: 0}); }
                },
                  h("span", {className: "sq3-saved-ico", "aria-hidden": "true"}, ffIcon(FF_I_DOC)),
                  h("span", {className: "apex-saved-label"}, s.label),
                  h("span", {className: "apex-saved-sub"},
                    s.ts ? `Apex · ${ffFmtRelative(s.ts)}` : s.code.slice(0, 40).replace(/\s+/g, " ")),
                  h("span", {className: "sq3-saved-chev", "aria-hidden": "true"}, "›")),
                h("button", {
                  className: "insp-chip-x",
                  title: `Delete "${s.label}"`,
                  onClick: () => deleteTemplate(s.label)
                }, "×"))),
          !saved.length && h("div", {className: "insp-meta"}, "Name the code below to save it as a reusable script."),
          h("div", {className: "insp-toolbar soql-save-row"},
            h("input", {
              className: "soql-save-input apex-save-input",
              ref: saveInputRef,
              value: saveLabel,
              placeholder: "Script label",
              title: "Name the current code and save it as a reusable script",
              onChange: e => setSaveLabel(e.target.value),
              onKeyDown: e => { if (e.key === "Enter") saveTemplate(); }
            }),
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: !String(code || "").trim(),
              onClick: saveTemplate
            }, "Save"))
        )
      )),
      h("div", {className: "apex-main"},
        h("div", {className: "sq3-card sq3-editor-card"},
          h("div", {className: "insp-card-header sq3-card-head"},
            h("div", {className: "sq3-title-wrap"},
              h("span", {className: "sq3-code-ico", "aria-hidden": "true"}, "</>"),
              h("div", null,
                h("div", {className: "insp-card-title"}, "Apex Code Editor"),
                h("div", {className: "sq3-card-sub"},
                  "Write and execute your Apex code. Use the options below to run, format or save your script."))),
            h("div", {className: "insp-card-actions"},
              h("button", {
                type: "button",
                role: "switch",
                className: `apex-ai-toggle${useAi ? " is-on" : ""}`,
                onClick: () => {
                  const v = !useAi;
                  setUseAi(v);
                  if (!v) { setAiCheck(null); setAiNote(null); }
                },
                title: useAi
                  ? "AI pre-check is ON — code is scanned before each run; compile errors get a suggested fix"
                  : "Turn on to let AI scan your code before each run and fix compile errors",
                "aria-checked": useAi ? "true" : "false",
                "aria-pressed": useAi ? "true" : "false"
              },
                h("span", {className: "apex-ai-spark", "aria-hidden": "true"}, "✨"),
                h("span", {className: "apex-ai-label"}, "Use AI"),
                h("span", {className: "apex-ai-track", "aria-hidden": "true"},
                  h("span", {className: "apex-ai-thumb"}))))
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
        h("div", {className: "apex-meta-row"},
          h("span", {className: "apex-meta-chip"}, "Language: Apex"),
          h("span", {className: "apex-meta-chip"}, `Lines: ${lineCount}`),
          lastModified && h("span", {className: "apex-meta-chip"}, `Last Modified: ${new Date(lastModified).toLocaleString()}`),
          h("label", {className: "apex-tpl-wrap"},
            h("span", null, "Quick Templates"),
            h("select", {
              value: "",
              onChange: e => {
                const tp = APEX_TEMPLATES.find(x => x.label === e.target.value);
                if (tp) { setCode(tp.code); setSelRange({start: 0, end: 0}); }
                e.target.value = "";
              }
            },
              h("option", {value: ""}, "Quick Templates"),
              APEX_TEMPLATES.map(t => h("option", {key: t.label, value: t.label}, t.label))))),
    h("div", {className: "apex-bar"},
      h("label", {className: "insp-check", title: "Fetch the debug log automatically after each run"},
        h("input", {
          type: "checkbox",
          checked: openLog,
          onChange: e => setOpenLog(e.target.checked)
        }),
        h("span", null, "Open Log")
      ),
      log && h("button", {
        className: "btn btn-secondary btn-sm",
        onClick: downloadLog
      }, "Download Log")
    ),
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
    h("div", {className: "sq3-card sq3-results-card"},
      h("div", {className: "apex-results-head"},
        h("div", {className: "sq3-card-h"},
          h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_DOC)),
          h("span", {className: "sq3-card-t"}, "Execution Results")),
        h("div", {className: "apex-results-meta"},
          running && h("span", {className: "apex-status-pill running"}, "Running"),
          (!running && exec) && h("span", {className: "apex-status-pill " + (ok ? "ok" : "bad")}, ok ? "Success" : "Failed"),
          durationMs != null && h("span", {className: "apex-duration"}, `${(durationMs / 1000).toFixed(2)}s`),
          h("button", {
            className: "apex-collapse-btn" + (resultsCollapsed ? " collapsed" : ""),
            title: resultsCollapsed ? "Expand results" : "Collapse results",
            "aria-expanded": (!resultsCollapsed).toString(),
            "aria-label": resultsCollapsed ? "Expand results" : "Collapse results",
            onClick: () => setResultsCollapsed(v => !v)
          },
            h("span", {className: "apex-collapse-chev", "aria-hidden": "true"}, resultsCollapsed ? "▸" : "▾"),
            h("span", null, resultsCollapsed ? "Expand" : "Collapse")))),
      !resultsCollapsed && h("div", {className: "apex-results-body"},
        ((!exec && !running && !error) && h("div", {className: "apex-empty"},
          h("div", {className: "apex-empty-t"}, "No execution yet"),
          h("div", {className: "insp-meta"}, "Run a script above to see execution results here."))),
        ((exec || log || logLoading || logNote) && h("div", {className: "apex-result-tabs", role: "tablist"},
          [["logs", "Logs"], ["result", "Result"], ["debug", "Debug Info"]].map(([id, label]) =>
            h("button", {key: id, className: "apex-result-tab" + (resultView === id ? " active" : ""),
              role: "tab", "aria-selected": resultView === id ? "true" : "false",
              onClick: () => setResultView(id)}, label)))),
        ((exec || log || logLoading || logNote) && resultView === "logs" && h("div", null,
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
    })(),
        )),
        ((exec || log || logLoading || logNote) && resultView === "result" && h("div", null,
          debugRows.length
            ? h("div", {className: "insp-table-wrap insp-log-table apex-logview"},
                h("table", {className: "insp-table"},
                  h("thead", null, h("tr", null,
                    h("th", null, "Timestamp"),
                    h("th", null, "Event"),
                    h("th", null, "Details"))),
                  h("tbody", null, debugRows.slice(0, 2000).map((r, i) =>
                    h("tr", {key: i, className: "insp-row-hl"},
                      h("td", {className: "insp-nowrap"}, r.ts),
                      h("td", null, h("span", {className: "ff-log-ev", title: r.event}, r.event)),
                      h("td", {className: "insp-nowrap", title: r.details}, r.details))))))
            : h("div", {className: "insp-empty"}, "No System.debug output in this log."))),
        ((exec || log || logLoading || logNote) && resultView === "debug" && h("div", null,
          h("dl", {className: "apex-debug-list"},
            h("div", {className: "apex-debug-row"},
              h("dt", null, "Status"),
              h("dd", null, running ? "Running" : exec ? (ok ? "Success" : "Failed") : "No run yet")),
            h("div", {className: "apex-debug-row"},
              h("dt", null, "Compiled"),
              h("dd", null, !exec ? "No run yet" : exec.compiled ? "Yes" : "No")),
            exec && exec.compileProblem && h("div", {className: "apex-debug-row"},
              h("dt", null, "Compile problem"),
              h("dd", null, `${exec.compileProblem}${exec.line ? ` (line ${exec.line}${exec.column ? ", column " + exec.column : ""})` : ""}`)),
            exec && exec.exceptionMessage && h("div", {className: "apex-debug-row"},
              h("dt", null, "Exception"),
              h("dd", null, exec.exceptionMessage)),
            h("div", {className: "apex-debug-row"},
              h("dt", null, "Duration"),
              h("dd", null, durationMs != null ? `${(durationMs / 1000).toFixed(2)}s` : "n/a")),
            h("div", {className: "apex-debug-row"},
              h("dt", null, "Log size"),
              h("dd", null, log ? `${log.length} chars` : "n/a")),
            h("div", {className: "apex-debug-row"},
              h("dt", null, "Executed at"),
              h("dd", null, lastRunAt ? new Date(lastRunAt).toLocaleString() : "n/a"))))),
      ),
    ),
  ),
  ),
);
}

export {ApexTab};
