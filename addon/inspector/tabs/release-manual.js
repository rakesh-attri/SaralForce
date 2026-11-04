// Release Center → Manual steps: the runbook for what the Metadata API
// can't do. Detected from what is (or was) deployed; automated steps run
// against the target org, the rest link to the right Setup page.
import {keysFromMembers, componentsFromZip, componentText} from "../../core/deploy.js";
import {detectSteps, mergeRunbook, sortRunbook, runbookProgress, stepsForPrompt, stepsFromAi} from "../../core/manual-steps.js";
import {lastReleaseAt} from "../../core/release-history.js";
import {readZip, bytesToText} from "../../core/zip.js";
import {setupUrl, queryAll} from "../shared/deploy-api.js";
import {runAction, hasAction, ACTION_EFFECT} from "../shared/manual-actions.js";
import {listReleases, putRelease, loadBytes, snapshotComponents} from "../shared/release-store.js";
import {runbookFromSteps} from "../shared/ai.js";
import {downloadText} from "../shared/csv.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {FFBadge} from "../shared/ui.js";
import {confirmDialog} from "../../ui/confirm.js";
import {useRelease, setRelease, releaseState, orgByHost, loadOrgs, fmtWhen} from "./release-state.js";
import {CardHead, AiError} from "./release-ui.js";

const h = React.createElement;

const STATUS = {
  todo: {kind: "info", label: "To do"},
  running: {kind: "info", label: "Running…"},
  done: {kind: "ok", label: "Done"},
  skipped: {kind: "off", label: "Skipped"},
  failed: {kind: "err", label: "Needs a look"}
};

// Detection input for the selection that is not deployed yet.
export function currentContext(st, pkg, destructivePkg) {
  const cmp = st.compare && st.compare.sourceHost === st.sourceHost && st.compare.targetHost === st.targetHost ? st.compare : null;
  if (cmp && st.selected.size) {
    const rows = cmp.rows.filter(r => st.selected.has(r.key));
    return {
      items: rows.filter(r => r.status !== "deleted").map(r => r.key),
      deletes: rows.filter(r => r.status === "deleted").map(r => r.key),
      texts: new Map(rows.map(r => [r.key, r.sourceText || ""])),
      before: new Map(rows.map(r => [r.key, r.targetText || ""]))
    };
  }
  return {items: keysFromMembers(pkg), deletes: keysFromMembers(destructivePkg), texts: new Map(), before: new Map()};
}

async function releaseContext(r) {
  const texts = new Map();
  const before = new Map();
  if (r.zipId) {
    const bytes = await loadBytes(r.zipId).catch(() => null);
    if (bytes) for (const [k, c] of componentsFromZip(await readZip(bytes), bytesToText)) texts.set(k, componentText(c));
  }
  if (r.snapshotId) {
    try {
      for (const [k, c] of await snapshotComponents(r.snapshotId)) before.set(k, componentText(c));
    } catch (e) { /* rollback point removed */ }
  }
  return {items: r.items || [], deletes: r.deletes || [], texts, before};
}

function StepCard({step, target, busy, onRun, onStatus, onRemove}) {
  const st = STATUS[step.status] || STATUS.todo;
  const auto = step.auto && hasAction(step.id);
  return h("div", {className: "rel-step rel-step-" + step.status},
    h("div", {className: "rel-step-h"},
      h("span", {className: "rel-step-t"}, step.title),
      auto ? h(FFBadge, {kind: "violet"}, "SaralForce can do this") : h(FFBadge, {kind: "off"}, "By hand"),
      h(FFBadge, {kind: st.kind}, st.label)),
    step.targets && step.targets.length > 0 && h("div", {className: "insp-chips"}, step.targets.map(t => h("span", {key: t, className: "insp-chip rel-target"}, t))),
    step.why && h("div", {className: "rel-step-why"}, step.why),
    step.code && h("pre", {className: "rel-pre"}, step.code),
    step.log && h("pre", {className: "rel-step-log"}, step.log),
    h("div", {className: "rel-step-actions"},
      auto && h("button", {className: "btn btn-primary btn-sm", disabled: busy || !target, onClick: onRun,
        title: target ? "" : "Log in to the target org first"}, step.status === "done" ? "Run again" : "Run"),
      step.setup && target && h("a", {className: "btn btn-secondary btn-sm", href: setupUrl(target.conn, step.setup), target: "_blank", rel: "noopener"}, "Open in Setup"),
      step.status !== "done" && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => onStatus("done")}, "Mark done"),
      step.status !== "skipped" && step.status !== "done" && h("button", {className: "field-action-btn", disabled: busy, onClick: () => onStatus("skipped")}, "Skip"),
      (step.status === "done" || step.status === "skipped") && h("button", {className: "field-action-btn", disabled: busy, onClick: () => onStatus("todo")}, "Reopen"),
      step.custom && h("button", {className: "field-action-btn", disabled: busy, onClick: onRemove}, "Remove")));
}

export function ManualView({goTo}) {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [pkg] = useFfSession("metadata", "pkg", {});
  const [destructivePkg] = useFfSession("release", "destructive", {});
  const [releases, setReleases] = React.useState([]);
  const [pick, setPick] = React.useState("");
  const [steps, setSteps] = React.useState(null);
  const [ctxInfo, setCtxInfo] = React.useState({source: null, target: null, label: ""});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [script, setScript] = React.useState("");
  const [custom, setCustom] = React.useState("");
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState("");
  const [aiSteps, setAiSteps] = React.useState(null);

  React.useEffect(() => {
    listReleases().then(list => {
      const real = list.filter(r => r.kind !== "validation");
      setReleases(real);
      // Right after a deploy, open its runbook.
      setPick(p => p || (real[0] && Date.now() - new Date(real[0].at).getTime() < 10 * 60e3 ? real[0].id : "current"));
    }).catch(() => setPick("current"));
  }, [st.historyTick]);

  const release = releases.find(r => r.id === pick) || null;

  React.useEffect(() => {
    if (!pick) return;
    let stale = false;
    (async () => {
      setErr("");
      if (pick === "current") {
        const ctx = currentContext(releaseState(), pkg, destructivePkg);
        if (!stale) {
          setSteps(mergeRunbook(releaseState().runbook || [], detectSteps(ctx)));
          setCtxInfo({source: orgByHost(st.sourceHost), target: orgByHost(st.targetHost), label: "the selection (not deployed yet)", count: ctx.items.length + ctx.deletes.length});
        }
      } else if (release) {
        const ctx = await releaseContext(release);
        if (!stale) {
          setSteps(mergeRunbook(release.runbook || [], detectSteps(ctx)));
          setCtxInfo({source: orgByHost(release.sourceHost), target: orgByHost(release.targetHost), label: `${release.version} · ${release.targetName}`,
            count: (release.items || []).length + (release.deletes || []).length, missingTarget: !orgByHost(release.targetHost) ? release.targetName : ""});
        }
      }
    })().catch(e => { if (!stale) setErr(e.message || String(e)); });
    return () => { stale = true; };
  }, [pick, release && release.id, st.orgs, st.sourceHost, st.targetHost, st.selected, st.compare]);

  // Save progress with the release (or in memory for the selection).
  const save = async (next) => {
    const sorted = sortRunbook(next);
    setSteps(sorted);
    const slim = sorted.map(s => ({...s, log: String(s.log || "").slice(0, 4000)}));
    if (pick === "current") setRelease({runbook: slim});
    else if (release) {
      const updated = {...release, runbook: slim};
      await putRelease(updated);
      setReleases(list => list.map(r => r.id === updated.id ? updated : r));
    }
  };
  const update = (key, patch) => save(steps.map(s => s.key === key ? {...s, ...patch} : s));

  const run = async (step) => {
    const target = ctxInfo.target;
    if (!target) return;
    const ok = await confirmDialog({
      title: step.title,
      message: `SaralForce ${ACTION_EFFECT[step.id] || "makes the change"} in ${target.name}${target.isSandbox ? "" : " (production)"}.` +
        (step.targets && step.targets.length ? ` For: ${step.targets.join(", ")}.` : ""),
      confirmLabel: "Run", danger: !target.isSandbox
    });
    if (!ok) return;
    setBusy(true);
    setSteps(list => list.map(s => s.key === step.key ? {...s, status: "running"} : s));
    try {
      const log = await runAction(step, {source: ctxInfo.source, target});
      const bad = /^✗/m.test(log);
      await update(step.key, {status: bad ? "failed" : "done", log: `${new Date().toLocaleString()}\n${log}`});
    } catch (e) {
      await update(step.key, {status: "failed", log: `${new Date().toLocaleString()}\n${e.message || e}`});
    } finally {
      setBusy(false);
    }
  };

  const addScript = () => {
    if (!script.trim()) return;
    save([...steps, {key: "script-" + Date.now(), id: "script", custom: true, phase: "post", title: "Run Apex script", why: "Your post-deploy script (anonymous Apex) in the target.",
      code: script.trim(), targets: [], auto: true, setup: "", status: "todo", log: ""}]);
    setScript("");
  };
  const addCustom = () => {
    if (!custom.trim()) return;
    save([...steps, {key: "own-" + Date.now(), id: "own", custom: true, phase: "post", title: custom.trim().slice(0, 140), why: "",
      targets: [], auto: false, setup: "", status: "todo", log: ""}]);
    setCustom("");
  };

  const askAi = async () => {
    setAiBusy(true); setAiErr(""); setAiSteps(null);
    try {
      let audit = [];
      const source = ctxInfo.source;
      if (source) {
        const since = lastReleaseAt(await listReleases(), source.host) || new Date(Date.now() - 30 * 86400e3).toISOString();
        const recs = await queryAll(source.conn, "SELECT CreatedDate, Section, Display FROM SetupAuditTrail " +
          `WHERE CreatedDate >= ${new Date(since).toISOString()} ORDER BY CreatedDate DESC LIMIT 200`).catch(() => []);
        audit = recs.map(a => `${String(a.CreatedDate).slice(0, 10)} ${a.Section}: ${a.Display}`);
      }
      const list = await runbookFromSteps(stepsForPrompt(steps, audit));
      setAiSteps(stepsFromAi(list).filter(a => !steps.some(s => s.title.toLowerCase() === a.title.toLowerCase())));
    } catch (e) {
      setAiErr(e.message || String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const exportMd = () => {
    const lines = [`# Runbook: ${ctxInfo.label}`, ""];
    for (const phase of ["pre", "post"]) {
      const list = steps.filter(s => s.phase === phase);
      if (!list.length) continue;
      lines.push(phase === "pre" ? "## Before the deploy" : "## After the deploy", "");
      for (const s of list) {
        lines.push(`- [${s.status === "done" ? "x" : " "}] **${s.title}**${s.targets && s.targets.length ? ` (${s.targets.join(", ")})` : ""}`);
        if (s.why) lines.push(`  ${s.why}`);
        if (s.setup && ctxInfo.target) lines.push(`  ${setupUrl(ctxInfo.target.conn, s.setup)}`);
      }
      lines.push("");
    }
    downloadText("runbook.md", lines.join("\n"));
  };

  const options = [{value: "current", label: "Selection not deployed yet", sub: st.targetHost ? "to " + ((orgByHost(st.targetHost) || {}).name || st.targetHost) : ""},
    ...releases.map(r => ({value: r.id, label: `${r.version} · ${r.targetName}`, sub: fmtWhen(r.at)}))];
  const prog = steps ? runbookProgress(steps) : {done: 0, total: 0};

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide", "data-release-manual": ""},
      h(CardHead, {icon: "🧰", title: "Manual steps"},
        steps && steps.length > 0 && h("button", {className: "btn btn-secondary btn-sm", onClick: exportMd, title: "Checklist for your change ticket"}, "Download checklist"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy || !steps, onClick: askAi,
          title: "AI adds the hand steps from the Setup audit trail and the release"}, aiBusy ? "Thinking…" : "✨ Write the runbook")),
      h("div", {className: "sq3-card-sub"},
        "What a deploy doesn't do for you: data like permission set assignments and custom setting values, flow activation, scheduled jobs, secrets and settings. SaralForce does what it can and links the rest to the right Setup page."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Runbook for"),
          h(SearchSelect, {value: pick, options, onChange: setPick, ariaLabel: "Runbook for"})),
        steps && h("div", {className: "rel-prog"},
          h("div", {className: "limit-bar"}, h("div", {className: "limit-fill", style: {width: (prog.total ? Math.round(prog.done / prog.total * 100) : 0) + "%"}})),
          h("span", {className: "insp-meta"}, `${prog.done} of ${prog.total} done`))),
      ctxInfo.missingTarget && h("div", {className: "insp-warn"}, `Log in to ${ctxInfo.missingTarget} in this browser to run steps there, then press ↻ in Compare.`),
      err && h("div", {className: "insp-error"}, err),
      h(AiError, {error: aiErr}),
      aiSteps && h("div", {className: "rel-ai"},
        h("div", {className: "rel-ai-h"}, h("span", null, `✨ ${aiSteps.length} more step(s) suggested`),
          h("div", {className: "audit-actions"},
            h("button", {className: "btn btn-primary btn-sm", disabled: !aiSteps.length, onClick: () => { save([...steps, ...aiSteps]); setAiSteps(null); }}, "Add these"),
            h("button", {className: "btn btn-secondary btn-sm", onClick: () => setAiSteps(null)}, "Dismiss"))),
        h("ul", {className: "rel-ai-body"}, aiSteps.map(s => h("li", {key: s.key}, h("b", null, `[${s.phase === "pre" ? "before" : "after"}] ${s.title}`), s.why ? " — " + s.why : "")))),
      steps && steps.length === 0 && h("div", {className: "insp-hint-strip"},
        ctxInfo.count ? "Nothing needs a manual step for this release. You can still add your own below." : "Nothing picked yet. Choose items in Compare or Package, or pick a deployed release above."),
      steps && ["pre", "post"].map(phase => {
        const list = steps.filter(s => s.phase === phase);
        if (!list.length) return null;
        return h("div", {key: phase},
          h("div", {className: "rel-label"}, phase === "pre" ? "Before the deploy" : "After the deploy"),
          list.map(s => h(StepCard, {key: s.key, step: s, target: ctxInfo.target, busy,
            onRun: () => run(s), onStatus: v => update(s.key, {status: v}),
            onRemove: () => save(steps.filter(x => x.key !== s.key))})));
      }),
      steps && h("details", {className: "rel-paste"},
        h("summary", null, "Add a post-deploy Apex script or your own step"),
        h("textarea", {className: "soql-save-input rel-textarea", rows: 5, value: script, onChange: e => setScript(e.target.value),
          placeholder: "insert new Region__c(Name = 'EMEA');", "aria-label": "Post-deploy Apex script"}),
        h("div", {className: "soql-save-row"},
          h("button", {className: "btn btn-secondary btn-sm", disabled: !script.trim(), onClick: addScript}, "Add script step")),
        h("div", {className: "soql-save-row"},
          h("input", {className: "soql-save-input", value: custom, placeholder: "e.g. Tell the support team about the new Invoice page", onChange: e => setCustom(e.target.value),
            onKeyDown: e => { if (e.key === "Enter") addCustom(); }, "aria-label": "Your own step"}),
          h("button", {className: "btn btn-secondary btn-sm", disabled: !custom.trim(), onClick: addCustom}, "Add step"))),
      pick === "current" && steps && steps.length > 0 && h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-primary btn-sm", onClick: () => goTo("deploy")}, "Go to Deploy →"))));
}
