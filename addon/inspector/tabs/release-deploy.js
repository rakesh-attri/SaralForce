// Release Center → Deploy: validate, quick deploy, deploy now, cancel.
import {
  allowedTestLevels, defaultTestLevel, hasApexChanges, membersFromKeys, keysFromMembers, mergeMembers,
  buildDeployEntries, componentsFromZip, suggestTests, typeLabel, splitKey,
  expandMemberKeys, permissionRefs, pathToComponent, TYPE_BY_NAME, mergeZipFiles
} from "../../core/deploy.js";
import {retrieveAll, SkippedTypes} from "./release-compare.js";
import {packageCount} from "../../core/metadata.js";
import {hasSecurityEnforced} from "../../core/bundle-order.js";
import {bytesToText, writeZip, writeZipCompressed} from "../../core/zip.js";
import {apiVersion} from "../../inspector.js";
import {retrieve, startDeploy, waitForDeploy, quickDeploy, cancelDeploy, queryAll, setupUrl, listComponents, deployStatus} from "../shared/deploy-api.js";
import {analyzePlan, sizeProblems, overwriteRisks} from "../../core/analyzers.js";
import {listReleases, putRelease, saveSnapshot, saveBytes, newId} from "../shared/release-store.js";
import {nextVersion, trimSummary} from "../../core/release-history.js";
import {detectSteps, mergeRunbook, pendingPreSteps} from "../../core/manual-steps.js";
import {chatDeployFailures} from "../shared/ai.js";
import {analyzeFailures, groupText, failuresPromptText, classifyProblem} from "../../core/deploy-errors.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {activeFlows, deactivateFlows, flowDeleteBlockers, deleteFlowsTooling} from "../shared/manual-actions.js";
import {flowDeleteReport} from "../../core/impact.js";
import {useFfSession} from "../shared/session-state.js";
import {FFBadge, FriendlyError} from "../shared/ui.js";
import {confirmDialog} from "../../ui/confirm.js";
import {useStepsAsk, selectionSig} from "./release-steps-ask.js";
import {useRelease, setRelease, releaseState, gitComponents, orgByHost, orgLabel, downloadBytes, fmtWhen} from "./release-state.js";
import {OrgBar, CardHead, AiError, RichText} from "./release-ui.js";

const h = React.createElement;

// What will be deployed: the compare selection, or the package basket.
function usePlan(mode, pkg, destructivePkg) {
  const st = useRelease();
  if (mode === "plan" && st.pendingPlan) {
    const p = st.pendingPlan;
    return {mode, cmp: null, comps: p.comps, keys: p.keys, members: membersFromKeys(p.keys), destructive: p.destructive, texts: [], since: p.since || ""};
  }
  const cmp = st.compare && st.compare.sourceHost === st.sourceHost && st.compare.targetHost === st.targetHost ? st.compare : null;
  if (mode === "compare" && cmp) {
    const rows = cmp.rows.filter(r => st.selected.has(r.key));
    const deploy = rows.filter(r => r.status !== "deleted");
    const del = rows.filter(r => r.status === "deleted");
    return {mode, cmp, keys: deploy.map(r => r.key), members: membersFromKeys(deploy.map(r => r.key)),
      destructive: membersFromKeys(del.map(r => r.key)), texts: deploy.map(r => ({key: r.key, text: r.sourceText})),
      statuses: new Map(deploy.map(r => [r.key, r.status])), before: new Map(deploy.map(r => [r.key, r.targetText || ""])), since: cmp.at};
  }
  return {mode: "package", cmp: null, keys: keysFromMembers(pkg), members: pkg, destructive: destructivePkg || {}, texts: []};
}

function preflight(plan, target, testLevel, targetApi) {
  const isProd = target && !target.isSandbox;
  const out = analyzePlan(plan, {targetApi, isProd});
  if ((plan.members.Flow || []).length) out.push({kind: "info", text: "Flows: in production they arrive inactive unless “Deploy processes and flows as active” is on in Process Automation Settings. With that setting on, Salesforce also needs Apex tests that cover the flows: pick Specified or Local tests."});
  if (isProd && !hasApexChanges(plan.members) && testLevel === "Default") out.push({kind: "info", text: "No Apex in this release, so production runs no tests (Default). Salesforce can't quick deploy a validation without tests: after Validate, use “Deploy validated package”, or Deploy now."});
  const legacy = plan.texts.filter(t => /^Apex(Class|Trigger):/.test(t.key) && hasSecurityEnforced(t.text));
  if (legacy.length) out.push({kind: "err", text: `${legacy.map(t => splitKey(t.key).fullName).join(", ")} use WITH SECURITY_ENFORCED, which new API versions reject. Change it to WITH USER_MODE in the source first.`});
  if (isProd && testLevel === "NoTestRun") out.push({kind: "err", text: "Production does not allow “No tests”."});
  if (isProd && hasApexChanges(plan.members) && testLevel === "Default") out.push({kind: "info", text: "Production with Apex: Salesforce runs all local tests for the Default level."});
  const manual = detectSteps({items: plan.keys, deletes: keysFromMembers(plan.destructive), texts: new Map(plan.texts.map(t => [t.key, t.text])), before: new Map()});
  if (manual.length) out.push({kind: "info", text: `${manual.length} manual step(s) for this release (${manual.map(m => m.title.toLowerCase()).slice(0, 3).join("; ")}${manual.length > 3 ? "…" : ""}). See Manual steps.`, manual: true});
  return out;
}

// Saves the target's current version of everything a deploy touches, so
// the release can be rolled back. Keys missing in the target are recorded
// as "did not exist" (a rollback deletes them).
async function takeRollbackPoint(target, keys, onStatus, entries = []) {
  if (!keys.length) return null;
  onStatus(`Saving a rollback point from ${target.name}…`);
  // Profiles / permission sets: also retrieve what they grant access to, so
  // the saved copy holds the old access lines too.
  const extra = new Set();
  for (const [path, data] of entries) {
    if (/^(profiles|permissionsets)\//.test(path) && !path.endsWith("-meta.xml")) {
      permissionRefs(typeof data === "string" ? data : bytesToText(data)).forEach(k => extra.add(k));
    }
  }
  const all = [...new Set([...keys, ...extra])];
  const {files} = await retrieveAll(target.conn, all, target.name, x => onStatus(`Saving a rollback point… ${x}`));
  const comps = componentsFromZip(files, bytesToText);
  const have = new Set([...comps.keys()].map(k => k.toLowerCase()));
  // "Did not exist" only when the org's own listing agrees (case-insensitive).
  let listed = null;
  try {
    listed = new Set([...(await listComponents(target.conn, [...new Set(keys.map(k => splitKey(k).type))])).keys()].map(k => k.toLowerCase()));
  } catch (e) { /* no listing: trust the retrieve */ }
  const missing = keys.filter(k => !have.has(k.toLowerCase()) && (!listed || !listed.has(k.toLowerCase())));
  return saveSnapshot({orgHost: target.host, orgName: target.name, kind: "pre-deploy", label: "Before release",
    keys, missing}, files);
}

// The target changed: its compare results are out of date and the ticks
// must not be sent again by accident.
function staleCompare(prev, targetHost) {
  if (!prev.compare || prev.compare.targetHost !== targetHost) return {};
  return {compare: {...prev.compare, stale: true}, selected: new Set()};
}

async function finishRelease(r, patch) {
  // finishedAt: later changes in the target are someone else's (rollback overwrite check).
  const done = {...r, ...patch, finishedAt: new Date().toISOString()};
  await putRelease(done);
  setRelease(prev => ({historyTick: (prev.historyTick || 0) + 1}));
  return done;
}

async function recordRelease(rec, entries) {
  const all = await listReleases().catch(() => []);
  const id = newId("rel");
  let zipId = "";
  if (entries && rec.kind !== "validation") {
    zipId = "zip-" + id;
    await saveBytes(zipId, writeZip(entries)).catch(() => { zipId = ""; });
  }
  const runbook = rec.kind === "validation" ? undefined : (releaseState().runbook || []);
  const r = {...rec, id, zipId, runbook, at: new Date().toISOString(),
    version: rec.kind === "validation" ? "" : (rec.version || nextVersion(all, rec.targetHost))};
  await putRelease(r);
  setRelease(prev => ({historyTick: (prev.historyTick || 0) + 1, ...(runbook ? {runbook: null} : {})}));
  return r;
}

// Deploys this document is polling. A deploy restored after minimize is
// not in here, so resumeDeploy() picks it up again.
const watching = new Set();

export async function resumeDeploy() {
  const d = releaseState().deploy;
  if (!d || d.finished || !d.id || watching.has(d.id)) return;
  const org = orgByHost(d.targetHost);
  if (!org || !org.conn) return;
  watching.add(d.id);
  try {
    const summary = await waitForDeploy(org.conn, d.id, {
      onUpdate: x => setRelease(prev => ({deploy: {...prev.deploy, summary: x, status: x.stateDetail || x.status}}))
    });
    setRelease(prev => ({
      deploy: {...prev.deploy, summary, finished: true, status: summary.status},
      ...(d.checkOnly && summary.canQuickDeploy && d.info
        ? {validation: {id: d.id, targetHost: d.targetHost, at: Date.now(), items: d.items, info: d.info, entries: d.entries, level: d.level, noTests: !summary.tests.total}} : {}),
      ...(!d.checkOnly && summary.success ? staleCompare(prev, d.targetHost) : {}),
      ...(!d.checkOnly && summary.success && d.info && d.info.kind !== "deploy" ? {pendingPlan: null} : {})
    }));
    if (d.recordId) {
      const r = (await listReleases()).find(x => x.id === d.recordId);
      if (r) await finishRelease(r, {success: summary.success, status: summary.status, summary: trimSummary(summary)});
    }
  } catch (e) {
    setRelease(prev => ({deploy: {...prev.deploy, status: "Lost contact with Salesforce: " + (e.message || e) + " Use Check status."}}));
  } finally {
    watching.delete(d.id);
  }
}

// After "insufficient access rights on cross-reference id" on a flow delete:
// find what blocks it in the target and offer the fixes.
function FlowDeleteHelp({names, target, isProd, checkOnly, disabled}) {
  const [busy, setBusy] = React.useState("");
  const [report, setReport] = React.useState(null);
  const [done, setDone] = React.useState("");
  const check = async () => {
    setBusy("check");
    try { setReport(flowDeleteReport(await flowDeleteBlockers(target.conn, names))); }
    catch (e) { setReport({blocked: [], clear: [], text: "Could not check: " + e.message}); }
    setBusy("");
  };
  React.useEffect(() => { check(); }, []);
  const act = async (kind) => {
    const list = kind === "deactivate" ? names : report.clear;
    const ok = await confirmDialog(kind === "deactivate"
      ? {title: "Deactivate the flows?", message: `Deactivate ${list.join(", ")} in ${orgLabel(target)}.`, confirmLabel: "Deactivate", danger: isProd}
      : {title: "Delete with the Tooling API?", message: `Delete ${list.join(", ")} (every version) from ${orgLabel(target)} now. This is a real delete, not a validation.`, confirmLabel: "Delete", danger: true});
    if (!ok) return;
    setBusy(kind);
    try {
      setDone(kind === "deactivate" ? await deactivateFlows({target, targets: list}) : await deleteFlowsTooling({target, targets: list}));
    } catch (e) { setDone("✗ " + e.message); }
    await check();
  };
  const anyActive = report && /version \d+ is active/.test(report.text);
  return h("div", {className: "insp-hint-strip rel-flowhelp"},
    h("div", null, h("b", null, "Why: "),
      "Salesforce refuses to delete a flow while something still points at one of its versions: an active version, a paused or waiting run, queued scheduled-path actions, or other metadata that calls it. It is not about your admin rights."),
    busy === "check" ? h("div", {className: "insp-meta"}, `Checking ${names.join(", ")} in ${target.name}…`)
      : report && h("pre", {className: "rel-pre"}, report.text),
    done && h("pre", {className: "rel-pre"}, done),
    busy && busy !== "check" && h("div", {className: "insp-meta"}, busy === "deactivate" ? "Deactivating…" : "Deleting…"),
    report && !busy && h("div", {className: "rel-flowhelp-actions"},
      h("button", {className: "field-action-btn", disabled, onClick: check}, "Check again"),
      anyActive && h("button", {className: "field-action-btn", disabled, onClick: () => act("deactivate")}, "Deactivate in the target"),
      report.clear.length > 0 && h("button", {className: "field-action-btn", disabled, onClick: () => act("tooling")},
        `Delete ${report.clear.length === 1 ? report.clear[0] : report.clear.length + " flows"} with the Tooling API`),
      h("a", {className: "field-action-btn", href: setupUrl(target.conn, "/lightning/setup/Pausedflows/home"), target: "_blank", rel: "noopener noreferrer"}, "Paused runs in Setup ↗"),
      h("span", {className: "insp-meta"}, `Then press ${checkOnly ? "Validate" : "Deploy"} again.`)));
}

// Failures grouped by root cause: what went wrong, why, and what to do, with
// "add it to the deploy" when the missing item is in the source. The raw list
// (full text, filter, CSV) is one click away.
const CATEGORY_SHORT = {missing: "Missing", reference: "User/record", compile: "Compile", feature: "Feature", change: "Change", access: "Access", conflict: "Conflict", package: "Package", other: "Other"};

// Chat with the AI about this run's failures. context() builds the facts
// (target, tests, what was sent, grouped errors); ask {q, n} sends a question.
function FailureChat({ask, context, onClose}) {
  const [msgs, setMsgs] = React.useState([]);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const ctx = React.useRef(null);
  const ctrl = React.useRef(null);
  const endRef = React.useRef(null);
  const send = async q => {
    const question = String(q || "").trim();
    if (!question || busy) return;
    if (!ctx.current) ctx.current = context();
    const history = [...msgs, {role: "user", content: question}];
    setMsgs([...history, {role: "assistant", content: ""}]);
    setText(""); setErr(""); setBusy(true);
    ctrl.current = new AbortController();
    try {
      const reply = await chatDeployFailures({context: ctx.current, history, signal: ctrl.current.signal,
        onChunk: t => setMsgs([...history, {role: "assistant", content: t}])});
      setMsgs([...history, {role: "assistant", content: reply}]);
    } catch (e) {
      setMsgs(history);
      if (!(e && e.name === "AbortError")) setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => { if (ask && ask.q) send(ask.q); }, [ask && ask.n]);
  React.useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({block: "nearest"}); }, [msgs]);
  React.useEffect(() => () => ctrl.current && ctrl.current.abort(), []);
  const SUGGEST = ["Can I fix this in the same package, or do I need a separate deploy first?", "What should I add to this deploy?", "Which errors are caused by other errors?"];
  return h("div", {className: "rel-ai rel-chat"},
    h("div", {className: "rel-ai-h"},
      h("span", null, "✨ Ask AI about these failures"),
      h("div", {className: "audit-actions"},
        busy && h("button", {className: "btn btn-secondary btn-sm", onClick: () => ctrl.current && ctrl.current.abort()}, "Stop"),
        msgs.length > 0 && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => { setMsgs([]); setErr(""); }}, "Clear"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: onClose}, "Close"))),
    h("div", {className: "rel-chat-log"},
      msgs.map((m, i) => h("div", {key: i, className: "rel-chat-msg rel-chat-" + m.role},
        m.role === "user" ? h("div", {className: "rel-chat-q"}, m.content)
          : m.content ? h(RichText, {text: m.content}) : h("div", {className: "insp-meta"}, "Thinking…"),
        m.role === "assistant" && m.content && !busy && h("button", {className: "field-action-btn rel-chat-copy",
          onClick: () => { try { navigator.clipboard.writeText(m.content); } catch (e) { /* no clipboard */ } }}, "Copy"))),
      h("div", {ref: endRef})),
    h(AiError, {error: err}),
    !busy && h("div", {className: "rel-chat-suggest"}, SUGGEST.map(sg => h("button", {key: sg, type: "button", className: "insp-chip rel-chip", onClick: () => send(sg)}, sg))),
    h("div", {className: "rel-chat-input"},
      h("textarea", {rows: 2, value: text, placeholder: "Ask a follow-up… (Enter to send, Shift+Enter for a new line)", "aria-label": "Ask the AI",
        onChange: e => setText(e.target.value),
        onKeyDown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}),
      h("button", {className: "btn btn-primary btn-sm", disabled: busy || !text.trim(), onClick: () => send(text)}, busy ? "…" : "Send")),
    h("div", {className: "insp-meta rel-chat-note"}, "Sent to your AI provider: this deploy's target, test level, component counts and the error messages (no file contents)."));
}

function DeployErrors({summary, context, canAdd, disabled, onAdd, onRevalidate, onAsk}) {
  const a = React.useMemo(() => analyzeFailures(summary, context), [summary, context.sourceKeys.length]);
  const [open, setOpen] = React.useState(() => new Set(a.groups.slice(0, 3).map(g => g.key)));
  const [added, setAdded] = React.useState(new Set());
  const [showAll, setShowAll] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [copied, setCopied] = React.useState("");
  const toggle = k => { const n = new Set(open); if (n.has(k)) n.delete(k); else n.add(k); setOpen(n); };
  const copy = (text, what) => {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => { setCopied(what); setTimeout(() => setCopied(""), 1800); }).catch(() => {});
  };
  const top = a.groups[0];
  const rows = summary.componentFailures.filter(f => !q || (f.type + " " + f.fullName + " " + f.problem).toLowerCase().includes(q.toLowerCase()));
  const fixOf = React.useMemo(() => { const m = new Map(); return p => { if (!m.has(p)) m.set(p, classifyProblem(p)); return m.get(p); }; }, [summary]);
  const csv = () => downloadText(`deploy-errors-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(["Type", "Component", "Line", "Problem"], summary.componentFailures.map(f => ({"Type": typeLabel(f.type), "Component": f.fullName, "Line": f.line || "", "Problem": f.problem}))));
  const card = (g, nested) => {
    const isOpen = open.has(g.key);
    const comps = g.components.map(c => `${typeLabel(c.type)} ${c.fullName}${c.count > 1 ? ` ×${c.count}` : ""}${c.lines.length ? ` (line ${[...new Set(c.lines)].slice(0, 3).join(", ")})` : ""}`);
    return h("div", {key: g.key, className: "rel-err" + (nested ? " rel-err-nested" : "") + " rel-err-" + g.category},
      h("button", {type: "button", className: "rel-err-head", "aria-expanded": isOpen, onClick: () => toggle(g.key)},
        h("span", {className: "rel-err-caret"}, isOpen ? "▾" : "▸"),
        h("span", {className: "rel-err-cat"}, g.categoryLabel),
        h("span", {className: "rel-err-title"}, g.title),
        h("span", {className: "rel-err-count"}, `${g.total || g.count} error${(g.total || g.count) === 1 ? "" : "s"}`)),
      isOpen && h("div", {className: "rel-err-body"},
        h("div", {className: "rel-err-line"}, h("b", null, "Affected: "), comps.slice(0, 5).join(" · "), comps.length > 5 ? ` · +${comps.length - 5} more` : ""),
        g.why && h("div", {className: "rel-err-line"}, h("b", null, "Why: "), g.why),
        g.fix && h("div", {className: "rel-err-line"}, h("b", null, "Fix: "), g.fix),
        g.refStatus === "failed" && h("div", {className: "rel-err-line insp-meta"}, "The missing item is in this deploy but failed itself: fix that one first."),
        g.refStatus === "absent" && g.category === "missing" && h("div", {className: "rel-err-line insp-meta"}, "It isn't in the source either: create it there first, or check the name."),
        h("div", {className: "rel-err-line rel-err-said"}, h("b", null, "Salesforce says: "), g.sample),
        h("div", {className: "rel-err-actions"},
          g.addKey && canAdd && !added.has(g.addKey) && h("button", {className: "btn btn-primary btn-sm", disabled, onClick: () => { onAdd(g.addKey); setAdded(new Set([...added, g.addKey])); }},
            `＋ Add ${g.ref ? g.ref.name : "it"} to the deploy`),
          g.addKey && added.has(g.addKey) && h("span", {className: "insp-status-ok"}, "✓ Added to the selection"),
          g.addKey && !canAdd && h("span", {className: "insp-meta"}, `${g.ref.name} is in the source: add it to the package.`),
          onAsk && h("button", {className: "field-action-btn", onClick: () => onAsk(`How do I fix this: ${g.title}? (${g.total || g.count} error(s), e.g. on ${typeLabel(g.components[0].type)} ${g.components[0].fullName})`)}, "✨ Ask AI"),
          h("button", {className: "field-action-btn", onClick: () => copy(groupText(g), g.key)}, copied === g.key ? "✓ Copied" : "Copy")),
        g.children.length > 0 && h("div", {className: "rel-err-kids"},
          h("div", {className: "insp-meta"}, `Also fails because of this (${g.children.reduce((n, c) => n + c.count, 0)}):`),
          g.children.map(c => card(c, true)))));
  };
  return h("div", {className: "rel-errs"},
    h("div", {className: "rel-err-summary"},
      h("b", null, `${a.total} error${a.total === 1 ? "" : "s"} · ${a.rootCount} root cause${a.rootCount === 1 ? "" : "s"}`),
      top && top.total > 1 && h("span", null, ` · fixing “${top.title}” clears ${top.total}`),
      added.size > 0 && h("button", {className: "btn btn-primary btn-sm", disabled, onClick: onRevalidate}, "Validate again")),
    a.groups.map(g => card(g, false)),
    h("div", {className: "rel-err-actions"},
      h("button", {className: "field-action-btn", onClick: () => setShowAll(!showAll)}, showAll ? "Hide the full list" : `Show all ${a.total} errors`),
      h("button", {className: "field-action-btn", onClick: () => copy(a.groups.map(g => groupText(g)).join("\n\n"), "all")}, copied === "all" ? "✓ Copied" : "Copy summary"),
      h("button", {className: "field-action-btn", onClick: csv}, "⬇ Export CSV")),
    showAll && h(React.Fragment, null,
      h("input", {className: "rel-err-filter", placeholder: "Filter by component or message…", value: q, onChange: e => setQ(e.target.value), "aria-label": "Filter errors"}),
      h("div", {className: "insp-table-wrap"},
        h("table", {className: "insp-table rel-err-table"},
          h("thead", null, h("tr", null, h("th", null, "Component"), h("th", null, "Line"), h("th", null, "Problem"), h("th", null, "Fix"))),
          h("tbody", null, rows.slice(0, 500).map((f, i) => {
            const c = fixOf(f.problem);
            return h("tr", {key: i},
              h("td", null, `${typeLabel(f.type)} ${f.fullName}`), h("td", null, f.line || ""),
              h("td", null, h("span", {className: "rel-err-cat"}, CATEGORY_SHORT[c.category] || "Other"), " ", f.problem),
              h("td", {className: "rel-err-fix"}, c.fix));
          })))),
      rows.length > 500 && h("div", {className: "insp-meta"}, `First 500 of ${rows.length}: export the CSV for all.`)));
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Re-render every second while something runs (elapsed time, hints).
function useTick(on) {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setN(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

// Highest API version the org supports (deploys of newer metadata fail).
const apiCache = new Map();
function useTargetApi(target) {
  const [v, setV] = React.useState(target ? apiCache.get(target.host) || null : null);
  React.useEffect(() => {
    if (!target || target.isGit || !target.conn) return;
    if (apiCache.has(target.host)) { setV(apiCache.get(target.host)); return; }
    let stale = false;
    target.conn.client.request("/services/data/", {useCache: false}).then(list => {
      const max = Math.max(...(list || []).map(x => Number(x.version)).filter(Number.isFinite));
      if (Number.isFinite(max)) { apiCache.set(target.host, max); if (!stale) setV(max); }
    }).catch(() => {});
    return () => { stale = true; };
  }, [target && target.host]);
  return v;
}

// Components in the target changed after `since` by someone (a deploy
// would overwrite their work). Asks before going on; false = stop.
async function confirmNoOverwrite(target, keys, since, onStatus) {
  if (!since || !keys.length || !target.conn) return true;
  onStatus(`Checking ${target.name} for newer changes…`);
  let listed;
  try {
    listed = await listComponents(target.conn, [...new Set(keys.map(k => splitKey(k).type))]);
  } catch (e) {
    return true; // can't tell: don't block the release
  }
  const risks = overwriteRisks(keys, listed, since);
  if (!risks.length) return true;
  return confirmDialog({
    title: `${risks.length} item(s) changed in ${target.name} since you compared`,
    message: risks.slice(0, 8).map(r => `${r.fullName} (${r.by || "someone"}, ${fmtWhen(r.at)})`).join(", ") +
      (risks.length > 8 ? ` and ${risks.length - 8} more` : "") + ". Deploying overwrites those changes. Compare again to see them, or deploy anyway.",
    confirmLabel: "Deploy anyway", danger: true
  });
}

// Package retrieves: split like compare retrieves, parent files merged.
async function retrieveAllMembers(source, members, onStatus) {
  const plain = {};
  const wild = {};
  for (const [t, names] of Object.entries(members)) (names.includes("*") ? wild : plain)[t] = names;
  const files = new Map();
  if (Object.keys(plain).length) mergeZipFiles(files, (await retrieveAll(source.conn, keysFromMembers(plain), source.name, onStatus)).files, bytesToText);
  if (Object.keys(wild).length) {
    onStatus(`Retrieving from ${source.name}…`);
    mergeZipFiles(files, (await retrieve(source.conn, wild, {onProgress: x => onStatus(`Retrieving from ${source.name}… ${x}`)})).files, bytesToText);
  }
  return {files};
}

// One "What to deploy" choice: a large, clickable card with a radio inside.
function ModeOption({id, plan, running, setMode, disabled = false, icon, title, sub}) {
  const on = plan.mode === id;
  return h("label", {className: "rel-mode-opt" + (on ? " active" : "") + (disabled || running ? " disabled" : "")},
    h("input", {type: "radio", name: "rel-mode", value: id, checked: on, disabled: disabled || running, onChange: () => setMode(id)}),
    h("span", {className: "rel-mode-ico", "aria-hidden": "true"}, icon),
    h("span", {className: "rel-mode-tx"},
      h("span", {className: "rel-mode-title"}, title),
      h("span", {className: "rel-mode-sub"}, sub)));
}

export function DeployView({goTo}) {
  const st = useRelease();
  const [relName, setRelName] = useFfSession("release", "relName", "");
  const [delWhen, setDelWhen] = useFfSession("release", "delWhen", "after");
  const [pkg] = useFfSession("metadata", "pkg", {});
  const [destructivePkg] = useFfSession("release", "destructive", {});
  const cmpReady = !!(st.compare && st.selected.size);
  const pending = st.pendingPlan;
  const from = st.deployFrom || null;
  const usable = m => m === "plan" ? !!pending : m === "compare" ? cmpReady : m === "package";
  const [mode, setMode] = React.useState(() => from && usable(from.mode) ? from.mode : pending ? "plan" : cmpReady ? "compare" : "package");
  // A new rollback / restore / promote plan opens itself.
  const lastPlan = React.useRef(pending);
  React.useEffect(() => {
    if (pending && pending !== lastPlan.current) setMode("plan");
    lastPlan.current = pending;
  }, [pending]);
  React.useEffect(() => {
    if (mode === "plan" && pending && pending.targetHost && st.targetHost !== pending.targetHost) setRelease({targetHost: pending.targetHost});
  }, [mode, pending]);
  const BACK = {compare: "Compare", package: "Package", changes: "Changes", history: "History"};
  const plan = usePlan(mode, pkg, destructivePkg);
  const source = orgByHost(st.sourceHost);
  const target = orgByHost(st.targetHost);
  const isProd = !!target && !target.isSandbox;
  const levels = allowedTestLevels(isProd);
  const [testLevel, setTestLevel] = useFfSession("release", "testLevel", "");
  const level = levels.some(l => l.id === testLevel) ? testLevel : defaultTestLevel(isProd, hasApexChanges(plan.members));
  const [runTests, setRunTests] = useFfSession("release", "runTests", "");
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestMsg, setSuggestMsg] = React.useState("");
  const [ai, setAi] = React.useState(null);
  const d = st.deploy;
  const running = !!(d && !d.finished);
  useTick(running);
  React.useEffect(() => { resumeDeploy(); }, [st.orgs, d && d.id, d && d.finished]);
  const [checking, setChecking] = React.useState(false);
  const checkNow = async () => {
    const org = d && orgByHost(d.targetHost);
    if (!org) return;
    setChecking(true);
    try {
      const x = await deployStatus(org.conn, d.id);
      setRelease(prev => ({deploy: {...prev.deploy, summary: x, status: x.stateDetail || x.status}}));
      resumeDeploy();
    } catch (e) {
      setRelease(prev => ({deploy: {...prev.deploy, status: "Could not read the status: " + e.message}}));
    } finally {
      setChecking(false);
    }
  };
  const elapsed = d && d.startedAt ? Date.now() - d.startedAt : 0;
  const pendingLong = running && d.id && (!d.summary || /Pending/.test(d.summary.status)) && elapsed > 20000;
  const count = plan.keys.length;
  const delCount = keysFromMembers(plan.destructive).length;
  const targetApi = useTargetApi(target);
  const checks = preflight(plan, target, level, targetApi);
  if (pending && pending.targetHost && plan.mode === "plan" && target && target.host !== pending.targetHost) {
    const home = orgByHost(pending.targetHost);
    checks.unshift({kind: "err", text: `This ${pending.kind} belongs to ${home ? home.name : pending.targetHost}. Pick that org as the target, or cancel it.`});
  }
  const blocked = checks.some(c => c.kind === "err");
  const validation = st.validation && target && st.validation.targetHost === target.host ? st.validation : null;

  const buildEntries = async (onStatus) => {
    if (plan.mode === "compare") {
      return buildDeployEntries(plan.keys, plan.cmp.sourceComps, apiVersion, {destructive: plan.destructive, post: delWhen !== "before", trimProfiles: true});
    }
    if (plan.mode === "plan") {
      return buildDeployEntries(plan.keys, plan.comps, apiVersion, {destructive: plan.destructive, post: delWhen !== "before"});
    }
    let comps = new Map();
    let passthrough = new Map();
    const known = {};
    const extraMembers = {};
    for (const [type, names] of Object.entries(plan.members)) {
      if (TYPE_BY_NAME[type] || type === "CustomLabels") known[type] = names; else extraMembers[type] = names;
    }
    if (count && source.isGit) {
      comps = await gitComponents(source, onStatus, {fresh: true});
    } else if (count) {
      const {files} = await retrieveAllMembers(source, plan.members, onStatus);
      comps = componentsFromZip(files, bytesToText);
      // Types SaralForce doesn't model (Workflow, Settings…) go as retrieved.
      passthrough = new Map([...files.entries()].filter(([p]) => p !== "package.xml" && !pathToComponent(p)));
    }
    const keys = expandMemberKeys(known, comps).filter(k => !k.startsWith("CustomLabels:"));
    const built = buildDeployEntries(keys, comps, apiVersion, {destructive: plan.destructive, post: delWhen !== "before",
      passthrough: source.isGit ? null : passthrough, extraMembers: source.isGit ? null : extraMembers});
    const notFound = keys.filter(k => !comps.has(k) && !k.endsWith(":*"));
    return {...built, notFound};
  };

  const releaseInfo = (keys, kindOverride) => ({
    kind: kindOverride || (plan.mode === "plan" ? pending.kind : "deploy"),
    name: relName.trim() || (plan.mode === "plan" ? pending.title : ""),
    by: (target && target.user) || (source && source.user) || "",
    rolledBack: plan.mode === "plan" ? pending.releaseId || "" : "",
    sourceHost: plan.mode === "plan" ? "" : (source ? source.host : ""),
    sourceName: plan.mode === "plan" ? (pending.sourceName || (pending.kind === "rollback" ? "Rollback point" : "Snapshot")) : (source ? source.name : ""),
    targetHost: target.host, targetName: target.name, targetSandbox: !!target.isSandbox,
    items: keys, deletes: keysFromMembers(plan.destructive), testLevel: level,
    notes: plan.mode === "compare" ? st.releaseNotes || "" : ""
  });

  // Pre-deployment steps of this selection (status from Manual steps).
  const detected = detectSteps({items: plan.keys, deletes: keysFromMembers(plan.destructive),
    texts: new Map(plan.texts.map(t => [t.key, t.text])), before: new Map()});
  const preSteps = pendingPreSteps(mergeRunbook(st.runbook || [], detected));
  // Once per selection: ask for the hand steps (Compare may have asked already).
  const {askSteps: askOnce, dialog: stepsDialog} = useStepsAsk();
  const curSig = selectionSig(plan.keys, keysFromMembers(plan.destructive));
  const [showOld, setShowOld] = React.useState(false);
  // What was on screen when the run finished (a rollback clears its plan as it
  // ends): picking something else later turns the result into "last run".
  const dNow = st.deploy;
  React.useEffect(() => {
    if (dNow && dNow.finished && dNow.sig && !dNow.viewSig) setRelease(prev => prev.deploy ? {deploy: {...prev.deploy, viewSig: curSig}} : {});
  }, [dNow && dNow.finished, dNow && dNow.startedAt]);
  React.useEffect(() => { setShowOld(false); }, [curSig]);
  const askSteps = checkOnly => askOnce({keys: plan.keys, deletes: keysFromMembers(plan.destructive), detected, verb: checkOnly ? "validate" : "deploy"});
  const preOk = async () => {
    const preSteps = pendingPreSteps(mergeRunbook(releaseState().runbook || [], detected));
    if (!preSteps.length) return true;
    const ok = await confirmDialog({
      title: `${preSteps.length} pre-deployment step(s) not done`,
      message: preSteps.map(p => "• " + p.title + (p.targets && p.targets.length ? `: ${p.targets.slice(0, 4).join(", ")}` : "")).join("\n") +
        "\n\nDo them in Manual steps first (mark each Done or Skipped), or deploy anyway.",
      confirmLabel: "Deploy anyway", cancelLabel: "Not yet", danger: isProd
    });
    return ok;
  };

  const run = async (checkOnly, preset = null) => {
    if ((!source && plan.mode !== "plan" && !preset) || !target) return;
    if (!preset && !(await askSteps(checkOnly))) return;
    if (!checkOnly && !(await preOk())) return;
    if (!checkOnly && !preset) {
      const ok = await confirmDialog({
        title: "Deploy now?",
        message: `Deploy ${count} item(s)${delCount ? ` and delete ${delCount}` : ""} to ${orgLabel(target)} without validating first.`,
        confirmLabel: "Deploy", danger: isProd
      });
      if (!ok) return;
    }
    setAi(null);
    const label = checkOnly ? "Validation" : "Deploy";
    const base = {label, checkOnly, targetHost: target.host, startedAt: Date.now(), items: count, deletes: delCount, sig: curSig};
    setRelease({deploy: {...base, status: "Preparing the package…"}});
    let record = null;
    try {
      const built = preset || await buildEntries(s => setRelease({deploy: {...base, status: s}}));
      const {entries, included} = built;
      if (!included.length && !delCount && !preset) throw new Error("Nothing to deploy: the selected items were not found in the source.");
      if (built.notFound && built.notFound.length) {
        const go = await confirmDialog({title: `${built.notFound.length} item(s) not found in ${source ? source.name : "the source"}`,
          message: built.notFound.slice(0, 10).map(k => splitKey(k).fullName).join(", ") + (built.notFound.length > 10 ? "…" : "") + ". Go on without them?", confirmLabel: "Go on"});
        if (!go) throw new Error("Stopped: some items were not found in the source.");
      }
      const tooBig = sizeProblems(entries, (await writeZipCompressed(entries)).length);
      if (tooBig.length) throw new Error(tooBig.map(p => p.text).join(" "));
      if (!checkOnly && !(await confirmNoOverwrite(target, [...included, ...keysFromMembers(plan.destructive)], plan.since,
        x => setRelease({deploy: {...base, status: x}})))) throw new Error("Stopped: the target has newer changes. Compare again before deploying.");
      let ignoreWarnings = false;
      const flowDeletes = preset ? [] : keysFromMembers(plan.destructive).filter(k => splitKey(k).type === "Flow").map(k => splitKey(k).fullName);
      if (flowDeletes.length) {
        setRelease({deploy: {...base, entries, status: "Checking flows to delete…"}});
        const active = await activeFlows(target.conn, flowDeletes).catch(() => []);
        if (active.length) {
          const go = await confirmDialog({
            title: `Deactivate ${active.length} flow(s) first?`,
            message: `Salesforce can't delete a flow while a version is active: ${active.map(d => d.DeveloperName).join(", ")}.\n\n` +
              `Deactivate ${active.length === 1 ? "it" : "them"} in ${orgLabel(target)} now? ${checkOnly ? "(This changes the target before validating; nothing else is deployed yet.)" : ""}`,
            confirmLabel: "Deactivate and continue", danger: isProd
          });
          if (!go) throw new Error(`Stopped: ${active.map(d => d.DeveloperName).join(", ")} must be deactivated before ${active.length === 1 ? "it" : "they"} can be deleted.`);
          setRelease({deploy: {...base, entries, status: "Deactivating flows…"}});
          const log = await deactivateFlows({target, targets: active.map(d => d.DeveloperName)});
          if (/✗/.test(log)) throw new Error("Could not deactivate: " + log.split("\n").filter(l => l.startsWith("✗")).join("; "));
        }
        setRelease({deploy: {...base, entries, status: "Checking what uses the flows…"}});
        const found = await flowDeleteBlockers(target.conn, flowDeletes).catch(() => []);
        // Already gone (deleted by hand or with the Tooling API): let the rest go through.
        ignoreWarnings = found.some(f => !f.found);
        const report = flowDeleteReport(found);
        if (report.blocked.length) {
          const go = await confirmDialog({title: "These flows can't be deleted yet",
            message: report.text + "\n\nSalesforce will refuse the delete until these are cleared. Send anyway?", confirmLabel: "Send anyway"});
          if (!go) throw new Error("Stopped: clear what uses the flows first (" + report.blocked.join(", ") + ").");
        }
      }
      setRelease({deploy: {...base, entries, status: `Sending to ${target.name}…`}});
      const tests = level === "RunSpecifiedTests" ? runTests.split(/[\s,]+/).filter(Boolean) : [];
      if (level === "RunSpecifiedTests" && !tests.length) throw new Error("Add at least one test class for “Specified tests”.");
      const info = preset ? preset.info : releaseInfo(included);
      let snapshotId = "";
      if (!checkOnly) {
        try {
          const snap = await takeRollbackPoint(target, [...included, ...info.deletes], st2 => setRelease({deploy: {...base, entries, status: st2}}), entries);
          snapshotId = snap ? snap.id : "";
        } catch (e) {
          const go = await confirmDialog({title: "No rollback point", message: `Could not save the target's current version (${e.message}). Deploy without a rollback point?`, confirmLabel: "Deploy anyway", danger: true});
          if (!go) throw new Error("Stopped: no rollback point was saved.");
        }
      }
      const id = await startDeploy(target.conn, entries, {checkOnly, testLevel: preset ? preset.level || (isProd ? "Default" : "NoTestRun") : level, runTests: tests, ignoreWarnings});
      watching.add(id);
      setRelease({deploy: {...base, entries, id, status: "Queued in Salesforce…"}});
      // In History from the start: a deploy that outlives this screen can still be checked and rolled back.
      record = await recordRelease({...info, kind: checkOnly ? "validation" : info.kind, deployId: id, success: false,
        status: "InProgress", summary: null, snapshotId}, checkOnly ? null : entries).catch(() => null);
      setRelease(prev => ({deploy: {...prev.deploy, recordId: record ? record.id : "", info, level: preset ? preset.level || (isProd ? "Default" : "NoTestRun") : level}}));
      const summary = await waitForDeploy(target.conn, id, {
        onUpdate: s => setRelease(prev => ({deploy: {...prev.deploy, summary: s, status: s.stateDetail || s.status}}))
      });
      setRelease(prev => ({
        deploy: {...prev.deploy, summary, finished: true, status: summary.status},
        validation: checkOnly && summary.canQuickDeploy ? {id, targetHost: target.host, at: Date.now(), items: count, info, entries, level: preset ? preset.level || level : level, noTests: !summary.tests.total} : (checkOnly ? null : prev.validation),
        ...(!checkOnly && summary.success && plan.mode === "plan" ? {pendingPlan: null} : {}),
        ...(!checkOnly && summary.success ? staleCompare(prev, target.host) : {})
      }));
      if (record) await finishRelease(record, {success: summary.success, status: summary.status, summary: trimSummary(summary)}).catch(() => {});
      if (summary.success && !(record && record.kind === "validation")) setRelName(""); // the next release gets its own name
    } catch (e) {
      if (record) await finishRelease(record, {status: "Unknown", error: e.message || String(e)}).catch(() => {});
      setRelease(prev => ({deploy: {...(prev.deploy || base), finished: true, error: e.message || String(e)}}));
    } finally {
      const d = releaseState().deploy;
      if (d && d.id) watching.delete(d.id);
    }
  };

  const quick = async () => {
    if (!validation) return;
    if (!validation.noTests && !(await preOk())) return;
    if (validation.noTests) {
      // Salesforce only quick-deploys validations that ran tests: send the
      // exact validated files instead (the rollback point is still taken).
      const ok = await confirmDialog({title: "Deploy the validated package?", message: `Deploy the same ${validation.items} item(s) that passed validation to ${orgLabel(target)}.`, confirmLabel: "Deploy", danger: isProd});
      if (ok) run(false, {entries: validation.entries, included: validation.info.items, info: validation.info, level: validation.level || (isProd ? "Default" : "NoTestRun")});
      return;
    }
    const ok = await confirmDialog({
      title: "Quick deploy?",
      message: `Release the validated package (${validation.items} item(s)` +
        (validation.info && validation.info.deletes && validation.info.deletes.length ? `, and delete ${validation.info.deletes.length} component(s)` : "") +
        `) to ${orgLabel(target)} now. Tests are not run again.`,
      confirmLabel: "Quick deploy", danger: isProd
    });
    if (!ok) return;
    const base = {label: "Quick deploy", checkOnly: false, targetHost: target.host, startedAt: Date.now(), items: validation.items, sig: curSig};
    setRelease({deploy: {...base, status: "Starting quick deploy…"}});
    const info = validation.info || releaseInfo([]);
    let record = null;
    try {
      if (!(await confirmNoOverwrite(target, [...info.items, ...info.deletes], new Date(validation.at).toISOString(),
        x => setRelease({deploy: {...base, status: x}})))) throw new Error("Stopped: the target changed after the validation. Validate again.");
      let snapshotId = "";
      try {
        const snap = await takeRollbackPoint(target, [...info.items, ...info.deletes], x => setRelease({deploy: {...base, status: x}}));
        snapshotId = snap ? snap.id : "";
      } catch (e) {
        const go = await confirmDialog({title: "No rollback point", message: `Could not save the target's current version (${e.message}). Quick deploy without a rollback point?`, confirmLabel: "Deploy anyway", danger: true});
        if (!go) throw new Error("Stopped: no rollback point was saved.");
      }
      const id = await quickDeploy(target.conn, validation.id);
      watching.add(id);
      setRelease({deploy: {...base, id, status: "Queued in Salesforce…"}});
      record = await recordRelease({...info, kind: info.kind === "deploy" ? "quick" : info.kind, deployId: id, validationId: validation.id,
        success: false, status: "InProgress", summary: null, snapshotId}, validation.entries).catch(() => null);
      setRelease(prev => ({deploy: {...prev.deploy, recordId: record ? record.id : "", info}}));
      const summary = await waitForDeploy(target.conn, id, {
        onUpdate: s => setRelease(prev => ({deploy: {...prev.deploy, summary: s, status: s.stateDetail || s.status}}))
      });
      setRelease(prev => ({deploy: {...prev.deploy, summary, finished: true, status: summary.status}, validation: summary.success ? null : prev.validation,
        ...(summary.success && info.kind !== "deploy" ? {pendingPlan: null} : {}),
        ...(summary.success ? staleCompare(prev, target.host) : {})}));
      if (record) await finishRelease(record, {success: summary.success, status: summary.status, summary: trimSummary(summary)}).catch(() => {});
      if (summary.success && !(record && record.kind === "validation")) setRelName(""); // the next release gets its own name
    } catch (e) {
      if (record) await finishRelease(record, {status: "Unknown", error: e.message || String(e)}).catch(() => {});
      setRelease(prev => ({deploy: {...(prev.deploy || base), finished: true, error: e.message || String(e)}}));
    } finally {
      const d = releaseState().deploy;
      if (d && d.id) watching.delete(d.id);
    }
  };

  const cancel = async () => {
    const org = d && orgByHost(d.targetHost);
    if (!d || !d.id || !org) return;
    try {
      await cancelDeploy(org.conn, d.id);
      setRelease(prev => ({deploy: {...prev.deploy, status: "Cancel requested…"}}));
    } catch (e) {
      setRelease(prev => ({deploy: {...prev.deploy, status: "Could not cancel: " + e.message}}));
    }
  };

  const suggest = async () => {
    setSuggesting(true); setSuggestMsg("");
    try {
      const changed = [...(plan.members.ApexClass || []), ...(plan.members.ApexTrigger || [])];
      const tests = await queryAll(source.conn, "SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null AND (Name LIKE '%Test%' OR Name LIKE '%_T')", {tooling: true});
      const names = suggestTests(changed, tests.filter(t => /@isTest|testMethod/i.test(t.Body || "")).map(t => ({name: t.Name, body: t.Body})));
      if (names.length) {
        setRunTests(names.join(", "));
        setSuggestMsg(`${names.length} test class(es) reference the changed Apex.`);
      } else setSuggestMsg("No test class mentions the changed Apex. Add one by name.");
    } catch (e) {
      setSuggestMsg("Could not read test classes: " + e.message);
    } finally {
      setSuggesting(false);
    }
  };

  // "Explain failures" and each card's "Ask AI" open one chat about this run.
  const askAi = q => setAi({q, n: Date.now()});
  const explain = () => askAi("Explain these failures and how to fix them, most important first.");
  const chatContext = () => {
    const sum = d.summary || {componentFailures: [], testFailures: [], coverageWarnings: [], errorMessage: d.error};
    const a = analyzeFailures(sum, errorContext);
    const tgt = orgByHost(d.targetHost);
    const items = (d.info && d.info.items) || plan.keys;
    const dels = (d.info && d.info.deletes) || keysFromMembers(plan.destructive);
    const byType = {};
    for (const k of items) { const t = splitKey(k).type; byType[t] = (byType[t] || 0) + 1; }
    const addable = a.groups.flatMap(g => [g, ...g.children]).filter(g => g.addKey).map(g => splitKey(g.addKey).fullName);
    return [
      `Target org: ${tgt ? tgt.name : d.targetHost} (${tgt && !tgt.isSandbox ? "production" : "sandbox"}). Run: ${d.checkOnly ? "validation (check only)" : "deploy"}. Test level: ${d.level || level}.`,
      `Selection from: ${plan.mode === "compare" ? `Compare (source org ${source ? source.name : "?"})` : plan.mode === "plan" ? (pending && pending.kind) || "plan" : "Package"}.`,
      `Sent: ${items.length} component(s): ${Object.entries(byType).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t} ${n}`).join(", ")}; ${dels.length} delete(s), run ${delWhen === "before" ? "before" : "after"} the deploy.`,
      addable.length ? `In the source and not selected (SaralForce can add them): ${addable.join(", ")}.` : "",
      "",
      failuresPromptText(sum, a)
    ].filter(x => x !== "").join("\n");
  };

  const downloadZip = async () => {
    try {
      const {entries} = await buildEntries(() => {});
      downloadBytes(`deploy-${new Date().toISOString().slice(0, 10)}.zip`, writeZip(entries));
    } catch (e) {
      setRelease({deploy: {finished: true, error: "Could not build the zip: " + e.message}});
    }
  };

  const s = d && d.summary;
  const failed = d && d.finished && (d.error || (s && !s.success));
  // What was sent, and what the source has that the target lacks (addable).
  const errorContext = {
    deployKeys: (d && d.info && d.info.items) || plan.keys,
    sourceKeys: plan.mode === "compare" && plan.cmp ? plan.cmp.rows.filter(r => r.status === "new" && !st.selected.has(r.key)).map(r => r.key) : []
  };
  // Older runs (no sig) count as stale once the selection or target changed.
  const staleRun = !!(d && d.finished && !showOld && (!d.sig || (d.viewSig && d.viewSig !== curSig) || (target && d.targetHost !== target.host)));
  return h("div", {className: "org-grid"},
    stepsDialog,
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🚀", title: "Validate & deploy"}),
      from && BACK[from.view] && h("button", {className: "field-action-btn rel-back", onClick: () => goTo(from.view)}, `← Back to ${BACK[from.view]}`),
      h(OrgBar, {disabled: running, ...(pending && plan.mode === "plan" && pending.kind !== "promote" ? {
        sourceLabel: "From", lockTarget: true,
        fixedSource: {title: pending.kind === "rollback" ? "⏪ Rollback point" : "♻️ Snapshot",
          sub: pending.sourceName || `Saved copy of ${orgLabel(orgByHost(pending.targetHost) || target)} from before the release`}
      } : {})}),
      pending && plan.mode === "plan" && pending.kind === "rollback" && h("div", {className: "insp-hint-strip"},
        `A rollback puts ${orgByHost(pending.targetHost) ? orgByHost(pending.targetHost).name : "the org"} back the way it was before that release, from the copy saved just before it. ` +
        "So the target is the org the release went to. To bring changes from production back to a sandbox, use Compare and ⇄ (reverse deployment)."),
      preSteps.length > 0 && h("div", {className: "insp-warn rel-prestrip"},
        h("b", null, `⏮️ ${preSteps.length} pre-deployment step(s) to do first: `),
        preSteps.map(p => p.title).join(" · "), " ",
        h("button", {className: "field-action-btn", onClick: () => { setRelease({manualPick: "current"}); goTo("manual"); }}, "Open Manual steps")),
      h("div", {className: "rel-label", id: "rel-mode-label"}, "What to deploy"),
      h("div", {className: "rel-modes", role: "radiogroup", "aria-labelledby": "rel-mode-label"},
        pending && h(ModeOption, {id: "plan", plan, running, setMode,
          icon: pending.kind === "rollback" ? "⏪" : pending.kind === "promote" ? "📤" : "♻️",
          title: pending.kind === "rollback" ? "Rollback" : pending.kind === "promote" ? "Release package" : "Restore",
          sub: `${pending.keys.length} to ${pending.kind === "promote" ? "deploy" : "restore"}${keysFromMembers(pending.destructive).length ? `, ${keysFromMembers(pending.destructive).length} to delete` : ""}`}),
        h(ModeOption, {id: "compare", plan, running, setMode, disabled: !cmpReady, icon: "⚖️", title: "Compare selection",
          sub: cmpReady ? `${st.selected.size} selected` : "Nothing compared yet"}),
        h(ModeOption, {id: "package", plan, running, setMode, icon: "📦", title: "Package",
          sub: `${packageCount(pkg)} item(s)${keysFromMembers(destructivePkg).length ? `, ${keysFromMembers(destructivePkg).length} to delete` : ""}`})),
      plan.mode === "compare" && plan.cmp && h(SkippedTypes, {skipped: plan.cmp.skipped, sourceHost: plan.cmp.sourceHost, targetHost: plan.cmp.targetHost}),
      // The plan's warning only while that plan is the one being deployed.
      pending && plan.mode === "plan" && h("div", {className: "insp-warn rel-planbar"},
        h("b", null, pending.title), h("div", null, pending.detail),
        h("button", {className: "field-action-btn", disabled: running, onClick: () => { setRelease({pendingPlan: null}); setMode(cmpReady ? "compare" : "package"); }}, pending.kind === "rollback" ? "Cancel this rollback" : pending.kind === "promote" ? "Cancel" : "Cancel this restore")),
      !count && !delCount && h("div", {className: "insp-hint-strip"},
        "Nothing selected yet. ",
        h("button", {className: "field-action-btn", onClick: () => goTo("compare")}, "Compare orgs"), " or ",
        h("button", {className: "field-action-btn", onClick: () => goTo("package")}, "build a package"), "."),
      (count > 0 || delCount > 0) && h("details", {className: "rel-plan"},
        h("summary", null, `${count} to deploy` + (delCount ? ` · ${delCount} to delete` : "")),
        h("div", {className: "rel-plan-list"},
          Object.entries(mergeMembers(plan.members)).map(([t, names]) => h("div", {key: t}, h("b", null, typeLabel(t) + ": "), names.join(", "))),
          Object.entries(plan.destructive).map(([t, names]) => h("div", {key: "d" + t, className: "rel-del"}, h("b", null, "Delete " + typeLabel(t) + ": "), names.join(", "))))),
      h("div", {className: "rel-label"}, "Release name or ticket"),
      h("div", {className: "soql-save-row rel-relname"},
        h("input", {className: "soql-save-input", value: relName, disabled: running, maxLength: 120,
          placeholder: "e.g. JIRA-1234 Invoice tax (shown in History, Git commits and the checklist)",
          onChange: e => setRelName(e.target.value), "aria-label": "Release name or ticket"}),
        delCount > 0 && h("label", {className: "rel-since"}, "Run deletes ",
          h("select", {className: "soql-save-input", value: delWhen, disabled: running, onChange: e => setDelWhen(e.target.value),
            "aria-label": "When deletes run"},
            h("option", {value: "after"}, "after the deploy (usual)"),
            h("option", {value: "before"}, "before the deploy")))),
      h("div", {className: "rel-label"}, "Tests"),
      h("div", {className: "rel-levels", role: "radiogroup", "aria-label": "Test level"},
        levels.map(l => h("label", {key: l.id, className: "rel-level" + (level === l.id ? " on" : ""), title: l.hint},
          h("input", {type: "radio", name: "rel-level", checked: level === l.id, disabled: running, onChange: () => setTestLevel(l.id)}),
          h("span", {className: "rel-level-t"}, l.label),
          h("span", {className: "rel-level-h"}, l.hint)))),
      level === "RunSpecifiedTests" && h("div", {className: "soql-save-row"},
        h("input", {className: "soql-save-input", placeholder: "Test classes, comma separated", value: runTests, disabled: running,
          onChange: e => setRunTests(e.target.value), "aria-label": "Test classes to run"}),
        h("button", {className: "btn btn-secondary btn-sm", disabled: suggesting || running || !source || source.isGit, onClick: suggest,
          title: "Find test classes in the source that reference the changed Apex"}, suggesting ? "Looking…" : "Suggest tests")),
      suggestMsg && h("div", {className: "insp-meta"}, suggestMsg),
      checks.length > 0 && h("ul", {className: "rel-checks"}, checks.map((c, i) =>
        h("li", {key: i, className: "rel-check rel-check-" + c.kind}, c.kind === "err" ? "⛔ " : c.kind === "warn" ? "⚠ " : "ℹ ", c.text))),
      h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: running || (!count && !delCount), onClick: downloadZip,
          title: "Download the exact zip that will be sent"}, "Download zip"),
        target && target.isSandbox && h("button", {className: "btn btn-secondary btn-sm", disabled: running || blocked || (!count && !delCount) || (!source && plan.mode !== "plan"),
          onClick: () => run(false)}, plan.mode === "plan" && pending && pending.kind === "rollback" ? "Deploy now (RB)" : "Deploy now"),
        h("button", {className: "btn btn-primary btn-sm", disabled: running || blocked || (!count && !delCount) || (!source && plan.mode !== "plan") || !target,
          onClick: () => run(true), title: "Check-only deploy: nothing changes in the target"},
          running && d.checkOnly ? "Validating…" : plan.mode === "plan" && pending && pending.kind === "rollback" ? "Validate (RB)" : "Validate"))),

    // A finished run for another selection (or org) is history, not this page's result.
    d && d.finished && staleRun && h("div", {className: "insp-hint-strip rel-last-run"},
      `Last run: ${d.label || "Deploy"} to ${orgByHost(d.targetHost) ? orgByHost(d.targetHost).name : d.targetHost || "?"}` +
      ` · ${d.summary ? d.summary.status : d.error ? "Failed" : "Finished"} · for a different selection. `,
      h("button", {className: "field-action-btn", onClick: () => setShowOld(true)}, "Show"), " ",
      h("button", {className: "field-action-btn", onClick: () => setRelease({deploy: null})}, "Dismiss"), " ",
      h("button", {className: "field-action-btn", onClick: () => goTo("history")}, "History")),
    d && !(d.finished && staleRun) && h("div", {className: "org-card org-card-wide", "data-release-deploy": ""},
      h(CardHead, {icon: d.checkOnly ? "🧪" : "📦", title: `${d.label || "Deploy"} · ${target && d.targetHost === target.host ? orgLabel(target) : d.targetHost || ""}`},
        running && d.id && h("button", {className: "btn btn-secondary btn-sm", disabled: checking, onClick: checkNow,
          title: "Ask Salesforce for the current status now"}, checking ? "Checking…" : "Check status"),
        running && d.id && h("button", {className: "btn btn-secondary btn-sm", onClick: cancel}, "Cancel"),
        d.finished && h("button", {className: "btn btn-secondary btn-sm", onClick: () => setRelease({deploy: null})}, "Close")),
      !d.finished && h("div", {className: "tr-progress"},
        s ? h("div", {className: "limit-bar"}, h("div", {className: "limit-fill" + (s.components.errors || s.tests.errors ? " crit" : ""), style: {width: s.progress + "%"}}))
          : h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, `${d.status || "Working…"}${s && s.progress ? ` · ${s.progress}%` : ""} · ${fmtElapsed(elapsed)}`)),
      pendingLong && h("div", {className: "insp-hint-strip"},
        `Salesforce has queued this ${d.checkOnly ? "validation" : "deploy"} but not started it yet. That usually means another deployment or test run is busy in ${orgByHost(d.targetHost) ? orgByHost(d.targetHost).name : "the target"}; it starts by itself when that finishes. `,
        orgByHost(d.targetHost) && h("a", {href: setupUrl(orgByHost(d.targetHost).conn, "/lightning/setup/DeployStatus/home"), target: "_blank", rel: "noopener"}, "See what's running"),
        " · or Cancel and try again later."),
      s && h("div", {className: "tr-summary"},
        h("span", {className: "tr-stat"}, `Components ${s.components.deployed}/${s.components.total}`),
        s.components.errors > 0 && h("span", {className: "tr-stat bad"}, `✗ ${s.components.errors} error(s)`),
        s.tests.total > 0 && h("span", {className: "tr-stat" + (s.tests.errors ? " bad" : " ok")}, `Tests ${s.tests.completed}/${s.tests.total}` + (s.tests.errors ? ` · ${s.tests.errors} failed` : "")),
        d.finished && h(FFBadge, {kind: s.success ? "ok" : "err"}, s.status)),
      d.error && h(FriendlyError, {error: d.error}),
      s && s.errorMessage && h(FriendlyError, {error: s.errorMessage}),
      d.finished && s && s.success && !d.checkOnly && h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"}, "Flows to activate, assignments, scheduled jobs, secrets: check what the deploy didn’t do."),
        h("button", {className: "btn btn-primary btn-sm", onClick: () => goTo("manual")}, "Manual steps →")),
      d.finished && s && s.success && h("div", {className: "insp-status-ok rel-done"},
        d.checkOnly ? "✓ Validation passed. Nothing has changed in the target yet." : `✓ Deployed to ${target ? target.name : d.targetHost}.`),
      s && s.componentFailures.length > 0 && h(DeployErrors, {key: d.id || d.startedAt, summary: s, context: errorContext,
        canAdd: plan.mode === "compare" && !!plan.cmp, disabled: running,
        // Still this result's selection (plus the fix): keep it on screen.
        onAdd: key => setRelease(prev => ({selected: new Set([...prev.selected, key]),
          deploy: prev.deploy ? {...prev.deploy, viewSig: selectionSig([...plan.keys, key], keysFromMembers(plan.destructive))} : prev.deploy})),
        onRevalidate: () => run(true), onAsk: askAi}),
      s && target && d.info && s.componentFailures.some(f => f.type === "Flow" && /cross-reference id/i.test(f.problem || "")) &&
        (d.info.deletes || []).some(k => k.startsWith("Flow:")) &&
        h(FlowDeleteHelp, {key: d.id || d.startedAt, target, isProd, checkOnly: d.checkOnly, disabled: running,
          names: (d.info.deletes || []).filter(k => k.startsWith("Flow:")).map(k => splitKey(k).fullName)}),
      s && s.testFailures.length > 0 && h("details", {className: "tr-class", open: true},
        h("summary", null, h("span", {className: "tr-dot bad"}, "✗"), h("span", {className: "tr-cls"}, `${s.testFailures.length} failing test(s)`)),
        s.testFailures.map((t, i) => h("div", {key: i, className: "rel-testfail"},
          h("b", null, `${t.className}.${t.method}`), h("div", null, t.message), t.stackTrace && h("pre", {className: "rel-pre"}, t.stackTrace)))),
      s && (s.coverageWarnings.length > 0 || s.lowCoverage.length > 0) && h("div", {className: "insp-warn"},
        h("b", null, "Code coverage"),
        s.coverageWarnings.map((w, i) => h("div", {key: "w" + i}, `${w.name ? w.name + ": " : ""}${w.message}`)),
        s.lowCoverage.map(c => h("div", {key: c.name}, `${c.name}: ${c.percent}% (needs 75%)`))),
      d.finished && validation && d.checkOnly && h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"}, validation.noTests ? "No tests ran in this validation, so Salesforce can't quick deploy it; this sends the exact validated files." : "Quick deploy releases this validated package in seconds, without running tests again (valid for 10 days)."),
        h("button", {className: "btn btn-primary btn-sm", onClick: quick}, validation.noTests ? "Deploy validated package" : "Quick deploy")),
      failed && !ai && h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-secondary btn-sm", onClick: explain, title: "Opens a chat with the AI about these failures"}, "✨ Explain failures / ask AI")),
      failed && ai && h(FailureChat, {key: d.id || d.startedAt, ask: ai, context: chatContext, onClose: () => setAi(null)}),
      d.id && orgByHost(d.targetHost) && h("div", {className: "insp-meta"}, "Deploy id ", h("code", null, d.id), " · ",
        h("a", {href: setupUrl(orgByHost(d.targetHost).conn, "/lightning/setup/DeployStatus/home"), target: "_blank", rel: "noopener"}, "Deployment Status in Setup"))));
}

