// Release Center → Deploy: validate, quick deploy, deploy now, cancel.
import {
  allowedTestLevels, defaultTestLevel, hasApexChanges, membersFromKeys, keysFromMembers, mergeMembers,
  buildDeployEntries, componentsFromZip, suggestTests, failuresForPrompt, typeLabel, splitKey,
  expandMemberKeys, permissionRefs, pathToComponent, TYPE_BY_NAME, mergeZipFiles
} from "../../core/deploy.js";
import {retrieveAll} from "./release-compare.js";
import {packageCount} from "../../core/metadata.js";
import {hasSecurityEnforced} from "../../core/bundle-order.js";
import {bytesToText, writeZip, writeZipCompressed} from "../../core/zip.js";
import {apiVersion} from "../../inspector.js";
import {retrieve, startDeploy, waitForDeploy, quickDeploy, cancelDeploy, queryAll, setupUrl, listComponents} from "../shared/deploy-api.js";
import {analyzePlan, sizeProblems, overwriteRisks} from "../../core/analyzers.js";
import {listReleases, putRelease, saveSnapshot, saveBytes, newId} from "../shared/release-store.js";
import {nextVersion, trimSummary} from "../../core/release-history.js";
import {detectSteps} from "../../core/manual-steps.js";
import {explainDeployFailures} from "../shared/ai.js";
import {useFfSession} from "../shared/session-state.js";
import {FFBadge} from "../shared/ui.js";
import {confirmDialog} from "../../ui/confirm.js";
import {useRelease, setRelease, releaseState, gitComponents, orgByHost, orgLabel, downloadBytes, fmtWhen} from "./release-state.js";
import {OrgBar, CardHead, AiAnswer, AiError} from "./release-ui.js";

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
  if ((plan.members.Flow || []).length) out.push({kind: "info", text: "Flows: in production they arrive inactive unless “Deploy processes and flows as active” is on in Process Automation Settings."});
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

export function DeployView({goTo}) {
  const st = useRelease();
  const [relName, setRelName] = useFfSession("release", "relName", "");
  const [delWhen, setDelWhen] = useFfSession("release", "delWhen", "after");
  const [pkg] = useFfSession("metadata", "pkg", {});
  const [destructivePkg] = useFfSession("release", "destructive", {});
  const cmpReady = !!(st.compare && st.selected.size);
  const pending = st.pendingPlan;
  const [mode, setMode] = React.useState(pending ? "plan" : cmpReady ? "compare" : "package");
  React.useEffect(() => {
    if (pending) {
      setMode("plan");
      if (pending.targetHost && st.targetHost !== pending.targetHost) setRelease({targetHost: pending.targetHost});
    }
  }, [pending]);
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
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState("");
  const d = st.deploy;
  const running = !!(d && !d.finished);
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

  const run = async (checkOnly, preset = null) => {
    if ((!source && plan.mode !== "plan" && !preset) || !target) return;
    if (!checkOnly && !preset) {
      const ok = await confirmDialog({
        title: "Deploy now?",
        message: `Deploy ${count} item(s)${delCount ? ` and delete ${delCount}` : ""} to ${orgLabel(target)} without validating first.`,
        confirmLabel: "Deploy", danger: isProd
      });
      if (!ok) return;
    }
    setAi(null); setAiErr("");
    const label = checkOnly ? "Validation" : "Deploy";
    const base = {label, checkOnly, targetHost: target.host, startedAt: Date.now(), items: count, deletes: delCount};
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
      const id = await startDeploy(target.conn, entries, {checkOnly, testLevel: preset ? "NoTestRun" : level, runTests: tests});
      setRelease({deploy: {...base, entries, id, status: "Queued in Salesforce…"}});
      // In History from the start: a deploy that outlives this screen can still be checked and rolled back.
      record = await recordRelease({...info, kind: checkOnly ? "validation" : info.kind, deployId: id, success: false,
        status: "InProgress", summary: null, snapshotId}, checkOnly ? null : entries).catch(() => null);
      const summary = await waitForDeploy(target.conn, id, {
        onUpdate: s => setRelease(prev => ({deploy: {...prev.deploy, summary: s, status: s.stateDetail || s.status}}))
      });
      setRelease(prev => ({
        deploy: {...prev.deploy, summary, finished: true, status: summary.status},
        validation: checkOnly && summary.canQuickDeploy ? {id, targetHost: target.host, at: Date.now(), items: count, info, entries, noTests: !summary.tests.total && level !== "Default"} : (checkOnly ? null : prev.validation),
        ...(!checkOnly && summary.success && plan.mode === "plan" ? {pendingPlan: null} : {}),
        ...(!checkOnly && summary.success ? staleCompare(prev, target.host) : {})
      }));
      if (record) await finishRelease(record, {success: summary.success, status: summary.status, summary: trimSummary(summary)}).catch(() => {});
      if (summary.success && !(record && record.kind === "validation")) setRelName(""); // the next release gets its own name
    } catch (e) {
      if (record) await finishRelease(record, {status: "Unknown", error: e.message || String(e)}).catch(() => {});
      setRelease(prev => ({deploy: {...(prev.deploy || base), finished: true, error: e.message || String(e)}}));
    }
  };

  const quick = async () => {
    if (!validation) return;
    if (validation.noTests) {
      // Salesforce only quick-deploys validations that ran tests: send the
      // exact validated files instead (the rollback point is still taken).
      const ok = await confirmDialog({title: "Deploy the validated package?", message: `Deploy the same ${validation.items} item(s) that passed validation to ${orgLabel(target)}.`, confirmLabel: "Deploy", danger: isProd});
      if (ok) run(false, {entries: validation.entries, included: validation.info.items, info: validation.info});
      return;
    }
    const ok = await confirmDialog({
      title: "Quick deploy?",
      message: `Release the validated package (${validation.items} item(s)) to ${orgLabel(target)} now. Tests are not run again.`,
      confirmLabel: "Quick deploy", danger: isProd
    });
    if (!ok) return;
    const base = {label: "Quick deploy", checkOnly: false, targetHost: target.host, startedAt: Date.now(), items: validation.items};
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
      setRelease({deploy: {...base, id, status: "Queued in Salesforce…"}});
      record = await recordRelease({...info, kind: info.kind === "deploy" ? "quick" : info.kind, deployId: id, validationId: validation.id,
        success: false, status: "InProgress", summary: null, snapshotId}, validation.entries).catch(() => null);
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

  const explain = async () => {
    setAiBusy(true); setAiErr("");
    try {
      setAi(await explainDeployFailures(failuresForPrompt(d.summary || {componentFailures: [], testFailures: [], coverageWarnings: [], errorMessage: d.error})));
    } catch (e) {
      setAiErr(e.message || String(e));
    } finally {
      setAiBusy(false);
    }
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
  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🚀", title: "Validate & deploy"}),
      h(OrgBar, {disabled: running}),
      h("div", {className: "rel-label"}, "What to deploy"),
      pending && h("div", {className: "insp-warn rel-planbar"},
        h("b", null, pending.title), h("div", null, pending.detail),
        h("button", {className: "field-action-btn", disabled: running, onClick: () => { setRelease({pendingPlan: null}); setMode(cmpReady ? "compare" : "package"); }}, pending.kind === "rollback" ? "Cancel this rollback" : pending.kind === "promote" ? "Cancel" : "Cancel this restore")),
      h("div", {className: "rel-modes", role: "radiogroup"},
        pending && h("label", {className: "sq3-check"},
          h("input", {type: "radio", name: "rel-mode", checked: plan.mode === "plan", disabled: running, onChange: () => setMode("plan")}),
          ` ${pending.kind === "rollback" ? "Rollback" : pending.kind === "promote" ? "Release package" : "Restore"} (${pending.keys.length} to ${pending.kind === "promote" ? "deploy" : "restore"}${keysFromMembers(pending.destructive).length ? `, ${keysFromMembers(pending.destructive).length} to delete` : ""})`),
        h("label", {className: "sq3-check" + (cmpReady ? "" : " disabled")},
          h("input", {type: "radio", name: "rel-mode", checked: plan.mode === "compare", disabled: !cmpReady || running, onChange: () => setMode("compare")}),
          ` Compare selection (${st.selected.size})`),
        h("label", {className: "sq3-check"},
          h("input", {type: "radio", name: "rel-mode", checked: plan.mode === "package", disabled: running, onChange: () => setMode("package")}),
          ` Package (${packageCount(pkg)} item(s)${keysFromMembers(destructivePkg).length ? `, ${keysFromMembers(destructivePkg).length} to delete` : ""})`)),
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
          onClick: () => run(false)}, "Deploy now"),
        h("button", {className: "btn btn-primary btn-sm", disabled: running || blocked || (!count && !delCount) || (!source && plan.mode !== "plan") || !target,
          onClick: () => run(true), title: "Check-only deploy: nothing changes in the target"}, running && d.checkOnly ? "Validating…" : "Validate"))),

    d && h("div", {className: "org-card org-card-wide", "data-release-deploy": ""},
      h(CardHead, {icon: d.checkOnly ? "🧪" : "📦", title: `${d.label || "Deploy"} · ${target && d.targetHost === target.host ? orgLabel(target) : d.targetHost || ""}`},
        running && d.id && h("button", {className: "btn btn-secondary btn-sm", onClick: cancel}, "Cancel"),
        d.finished && h("button", {className: "btn btn-secondary btn-sm", onClick: () => setRelease({deploy: null})}, "Close")),
      !d.finished && h("div", {className: "tr-progress"},
        s ? h("div", {className: "limit-bar"}, h("div", {className: "limit-fill" + (s.components.errors || s.tests.errors ? " crit" : ""), style: {width: s.progress + "%"}}))
          : h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, d.status || "Working…")),
      s && h("div", {className: "tr-summary"},
        h("span", {className: "tr-stat"}, `Components ${s.components.deployed}/${s.components.total}`),
        s.components.errors > 0 && h("span", {className: "tr-stat bad"}, `✗ ${s.components.errors} error(s)`),
        s.tests.total > 0 && h("span", {className: "tr-stat" + (s.tests.errors ? " bad" : " ok")}, `Tests ${s.tests.completed}/${s.tests.total}` + (s.tests.errors ? ` · ${s.tests.errors} failed` : "")),
        d.finished && h(FFBadge, {kind: s.success ? "ok" : "err"}, s.status)),
      d.error && h("div", {className: "insp-error"}, d.error),
      s && s.errorMessage && h("div", {className: "insp-error"}, s.errorMessage),
      d.finished && s && s.success && !d.checkOnly && h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"}, "Flows to activate, assignments, scheduled jobs, secrets: check what the deploy didn’t do."),
        h("button", {className: "btn btn-primary btn-sm", onClick: () => goTo("manual")}, "Manual steps →")),
      d.finished && s && s.success && h("div", {className: "insp-status-ok rel-done"},
        d.checkOnly ? "✓ Validation passed. Nothing has changed in the target yet." : `✓ Deployed to ${target ? target.name : d.targetHost}.`),
      s && s.componentFailures.length > 0 && h("div", {className: "insp-table-wrap"},
        h("table", {className: "insp-table"},
          h("thead", null, h("tr", null, h("th", null, "Component"), h("th", null, "Line"), h("th", null, "Problem"))),
          h("tbody", null, s.componentFailures.map((f, i) => h("tr", {key: i},
            h("td", null, `${typeLabel(f.type)} ${f.fullName}`), h("td", null, f.line || ""), h("td", null, f.problem)))))),
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
      failed && h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy, onClick: explain}, aiBusy ? "Thinking…" : "✨ Explain failures")),
      ai && h(AiAnswer, {title: "How to fix", text: ai, onClose: () => setAi(null)}),
      h(AiError, {error: aiErr}),
      d.id && orgByHost(d.targetHost) && h("div", {className: "insp-meta"}, "Deploy id ", h("code", null, d.id), " · ",
        h("a", {href: setupUrl(orgByHost(d.targetHost).conn, "/lightning/setup/DeployStatus/home"), target: "_blank", rel: "noopener"}, "Deployment Status in Setup"))));
}

