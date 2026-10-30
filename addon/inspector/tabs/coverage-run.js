// Code Coverage → test runs followed by their job id (progress per class,
// abort, per-method pass/fail with message and stack trace, AI triage) and
// a line-level coverage view of a class or trigger.
import {sfConn, apiVersion} from "../../inspector.js";
import {hasValidConfig} from "../../llm/llm-service.js";
import {escapeSoqlString} from "../../core/soql.js";
import {
  summarizeQueue, abortableItems, groupTestResults, coverageLineMap, extractMethodSource, parseStackTrace
} from "../../core/test-run.js";
import {queryAll} from "../shared/query.js";
import {explainTestFailure} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {apexHighlight} from "../shared/highlight.js";
import {FFBadge} from "../shared/ui.js";
import {ffSleep, ffIsStopped} from "../shared/hooks.js";
import {confirmDialog} from "../../ui/confirm.js";

const h = React.createElement;
const tooling = {tooling: true};
const q = s => `'${escapeSoqlString(s)}'`;

async function startJob(body) {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/runTestsAsynchronous`, {method: "POST", useCache: false, body});
  const id = typeof res === "string" ? res : (res && (res.id || res.jobId)) || "";
  if (!/^[a-zA-Z0-9]{15,18}$/.test(String(id).replace(/"/g, ""))) throw new Error("Salesforce did not return a test job id.");
  return String(id).replace(/"/g, "");
}

const queueItems = jobId => queryAll(
  `SELECT Id, ApexClassId, ApexClass.Name, Status, ExtendedStatus FROM ApexTestQueueItem WHERE ParentJobId = ${q(jobId)}`);
const testResults = jobId => queryAll(
  "SELECT Id, ApexClassId, ApexClass.Name, MethodName, Outcome, Message, StackTrace, RunTime FROM ApexTestResult " +
  `WHERE AsyncApexJobId = ${q(jobId)} ORDER BY ApexClass.Name, MethodName`);

// Start, follow and abort one test run. onFinished(run) fires once at the end.
export function useTestRun(signal, onFinished) {
  const [run, setRun] = React.useState(null);
  const seq = React.useRef(0);

  const start = async (body, label) => {
    const mine = ++seq.current;
    setRun({label, status: "starting", progress: null, results: null, error: null, startedAt: Date.now()});
    try {
      const jobId = await startJob(body);
      setRun(r => ({...r, jobId, status: "running"}));
      let progress = null;
      for (let i = 0; i < 400 && mine === seq.current; i++) {
        await ffSleep(i < 3 ? 1500 : 3000, signal);
        progress = summarizeQueue(await queueItems(jobId).catch(() => []));
        setRun(r => (r && r.jobId === jobId ? {...r, progress} : r));
        if (progress.finished) break;
      }
      if (mine !== seq.current) return;
      const results = groupTestResults(await testResults(jobId).catch(() => []));
      const final = {label, jobId, status: progress && progress.finished ? "done" : "timeout", progress, results, error: null};
      setRun(r => ({...r, ...final}));
      if (onFinished) onFinished(final);
    } catch (e) {
      if (ffIsStopped(e)) return;
      setRun(r => ({...r, status: "error", error: e.message}));
    }
  };

  const abort = async () => {
    if (!run || !run.jobId) return;
    const ok = await confirmDialog({title: "Abort this test run?", message: "Test classes that haven't finished will be stopped.",
      confirmLabel: "Abort run", danger: true});
    if (!ok) return;
    const items = abortableItems(await queueItems(run.jobId).catch(() => []));
    for (const it of items) {
      try {
        await sfConn.rest(`/services/data/v${apiVersion}/sobjects/ApexTestQueueItem/${it.Id}`, {method: "PATCH", useCache: false, body: {Status: "Aborted"}});
      } catch (e) { /* item finished meanwhile */ }
    }
  };

  return {run, start, abort, running: !!run && (run.status === "starting" || run.status === "running"), clear: () => setRun(null)};
}

async function classBody(name) {
  const rows = await queryAll(`SELECT Body FROM ApexClass WHERE Name = ${q(name)}`, tooling).catch(() => []);
  return (rows[0] || {}).Body || "";
}

function FailureRow({cls, m}) {
  const [open, setOpen] = React.useState(true);
  const [ai, setAi] = React.useState(null);
  const explain = async () => {
    if (!hasValidConfig()) { setAi({error: "AI needs a provider + API key (Settings)."}); return; }
    setAi({busy: true});
    try {
      const testSource = extractMethodSource(await classBody(cls.className), m.name);
      const where = parseStackTrace(m.stackTrace).find(f => f.cls !== cls.className);
      let codeSource = "";
      if (where) codeSource = extractMethodSource(await classBody(where.cls.split(".")[0]), where.method);
      setAi({text: await explainTestFailure({className: cls.className, method: m.name, message: m.message, stackTrace: m.stackTrace, testSource, codeSource})});
    } catch (e) {
      setAi({error: e.message === "NO_LLM_CONFIG" ? "AI needs a provider + API key (Settings)." : e.message});
    }
  };
  return h("div", {className: "tr-fail"},
    h("button", {className: "tr-fail-h", onClick: () => setOpen(o => !o), "aria-expanded": open},
      h("span", {className: "tr-dot bad", "aria-hidden": "true"}, "✗"),
      h("span", {className: "tr-m"}, m.name),
      m.ms != null && h("span", {className: "tr-ms"}, `${m.ms} ms`),
      h("span", {className: "tr-chev", "aria-hidden": "true"}, open ? "▾" : "▸")),
    open && h("div", {className: "tr-fail-b"},
      h("div", {className: "tr-msg"}, m.message || "(no message)"),
      m.stackTrace && h("pre", {className: "tr-stack"}, m.stackTrace),
      h("div", {className: "tr-actions"},
        h("button", {className: "btn btn-primary btn-sm", disabled: ai && ai.busy, onClick: explain}, ai && ai.busy ? "Explaining…" : "✨ Explain failure")),
      ai && ai.error && h("div", {className: "insp-error"}, ai.error),
      ai && ai.text && h(AnalysisReport, {text: ai.text, copied: false, onCopy: () => {}})));
}

export function TestRunPanel({testRun}) {
  const {run, abort, running, clear} = testRun;
  if (!run) return null;
  const p = run.progress;
  const r = run.results;
  const secs = Math.round((Date.now() - (run.startedAt || Date.now())) / 1000);
  return h("div", {className: "tr-panel"},
    h("div", {className: "tr-head"},
      h("div", {className: "tr-title"},
        h("span", {className: "tr-ico", "aria-hidden": "true"}, "🧪"),
        h("span", null, `Test run · ${run.label}`),
        run.status === "done" && r && h(FFBadge, {kind: r.failed ? "err" : "ok"}, r.failed ? `${r.failed} failed` : "All passed"),
        running && h(FFBadge, {kind: "info"}, "Running"),
        run.status === "timeout" && h(FFBadge, {kind: "warn"}, "Still running"),
        run.status === "error" && h(FFBadge, {kind: "err"}, "Error")),
      h("div", {className: "tr-head-r"},
        running && run.jobId && h("button", {className: "btn btn-secondary btn-sm", onClick: abort}, "Abort run"),
        !running && h("button", {className: "btn btn-secondary btn-sm", onClick: clear}, "Close"))),
    run.error && h("div", {className: "insp-error"}, run.error),
    p && h("div", {className: "tr-progress"},
      h("div", {className: "limit-bar"}, h("div", {className: "limit-fill" + (p.failed ? " crit" : ""), style: {width: (p.total ? Math.round(p.done / p.total * 100) : 0) + "%"}})),
      h("span", {className: "insp-meta"}, `${p.done} of ${p.total} test class${p.total === 1 ? "" : "es"} finished` +
        (running ? ` · ${secs}s` : "") + (p.aborted ? ` · ${p.aborted} aborted` : ""))),
    !p && running && h("div", {className: "insp-meta"}, "Queuing tests…"),
    run.status === "timeout" && h("div", {className: "insp-warn"}, "The run is still going — results so far are shown; run it again later for the rest."),
    r && h("div", {className: "tr-summary"},
      h("span", {className: "tr-stat ok"}, `✓ ${r.passed} passed`),
      h("span", {className: "tr-stat bad"}, `✗ ${r.failed} failed`),
      r.skipped > 0 && h("span", {className: "tr-stat"}, `${r.skipped} skipped`)),
    r && r.classes.map(c => h("details", {key: c.className, className: "tr-class", open: c.failed > 0},
      h("summary", null,
        h("span", {className: "tr-dot " + (c.failed ? "bad" : "ok"), "aria-hidden": "true"}, c.failed ? "✗" : "✓"),
        h("span", {className: "tr-cls"}, c.className),
        h("span", {className: "insp-meta"}, `${c.passed}/${c.methods.length} passed`)),
      c.methods.filter(m => m.outcome === "Fail" || m.outcome === "CompileFail").map(m => h(FailureRow, {key: m.id, cls: c, m})),
      h("div", {className: "tr-passes"}, c.methods.filter(m => m.outcome === "Pass" || m.outcome === "Skip").map(m =>
        h("span", {key: m.id, className: "tr-pass" + (m.outcome === "Skip" ? " skip" : ""), title: m.ms != null ? `${m.ms} ms` : ""},
          m.outcome === "Skip" ? "○ " : "✓ ", m.name))))),
    r && !r.classes.length && run.status === "done" && h("div", {className: "insp-meta"}, "No test results were returned for this run."));
}

// Source of a class or trigger with covered lines green and uncovered red.
export function CoverageLines({target, onClose}) {
  const [state, setState] = React.useState({loading: true});
  React.useEffect(() => {
    let stale = false;
    (async () => {
      const [cov, body] = await Promise.all([
        queryAll(`SELECT Coverage, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate WHERE ApexClassOrTriggerId = ${q(target.id)}`, tooling),
        queryAll(`SELECT Body FROM ${target.isTrigger ? "ApexTrigger" : "ApexClass"} WHERE Id = ${q(target.id)}`, tooling),
      ]);
      if (stale) return;
      setState({map: coverageLineMap((cov[0] || {}).Coverage), body: (body[0] || {}).Body || ""});
    })().catch(e => { if (!stale) setState({error: e.message}); });
    return () => { stale = true; };
  }, [target.id, target.isTrigger]);
  React.useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const lines = state.body != null ? state.body.split("\n") : [];
  const covered = state.map ? Object.values(state.map).filter(v => v === "covered").length : 0;
  const uncovered = state.map ? Object.values(state.map).filter(v => v === "uncovered").length : 0;
  const firstGap = state.map ? Object.keys(state.map).map(Number).sort((a, b) => a - b).find(n => state.map[n] === "uncovered") : null;
  return h("div", {className: "usr-modal-veil", onMouseDown: e => { if (e.target === e.currentTarget) onClose(); }},
    h("div", {className: "usr-modal sq3-card tr-lines", role: "dialog", "aria-label": `Line coverage of ${target.name}`},
      h("div", {className: "usr-modal-h"},
        h("div", {className: "usr-modal-t"},
          h("div", {className: "mdn-title"}, target.name),
          h("div", {className: "sq3-card-sub"},
            state.map ? `${covered} lines covered · ${uncovered} not covered` : "Line coverage")),
        firstGap && h("button", {className: "btn btn-secondary btn-sm", onClick: () => {
          const el = document.querySelector(`.tr-code [data-ln="${firstGap}"]`);
          if (el) el.scrollIntoView({block: "center"});
        }}, "First uncovered line"),
        h("button", {className: "mdn-x", "aria-label": "Close", onClick: onClose}, "✕")),
      h("div", {className: "tr-legend"},
        h("span", {className: "tr-key covered"}, "Covered"), h("span", {className: "tr-key uncovered"}, "Not covered"),
        h("span", {className: "tr-key"}, "Not executable")),
      state.loading && h("div", {className: "insp-meta"}, "Loading…"),
      state.error && h("div", {className: "insp-error"}, state.error),
      state.body != null && h("div", {className: "soql-editor-box mdv-code tr-code"},
        h("table", {className: "mdv-code-t"}, h("tbody", null, lines.map((ln, i) => h("tr", {
          key: i, "data-ln": i + 1, className: state.map[i + 1] ? "tr-" + state.map[i + 1] : ""
        },
          h("td", {className: "mdv-ln"}, i + 1),
          h("td", {className: "mdv-src", dangerouslySetInnerHTML: {__html: apexHighlight(ln) || " "}}))))))));
}
