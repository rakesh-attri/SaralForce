// Release Center → History: every validation and deploy, rollback points,
// org snapshots, drift ("what changed since the snapshot?") and restore.
import {
  presetTypes, splitKey, typeLabel, membersFromKeys, classifyComponents, compareCounts, componentsFromZip
} from "../../core/deploy.js";
import {bytesToText, readZip} from "../../core/zip.js";
import {toSourceFiles} from "../../core/source-format.js";
import {githubConfig, commitFiles, openPullRequest, listPaths} from "../shared/github.js";
import {sourcePathType} from "../../core/source-format.js";
import {deployStatus} from "../shared/deploy-api.js";
import {queryAll} from "../shared/deploy-api.js";
import {rollbackPlan, restoreFromDrift, DRIFT_LABELS, formatBytes, trimSummary} from "../../core/release-history.js";
import {listComponents, loadCatalog} from "../shared/deploy-api.js";
import {
  listReleases, listSnapshots, deleteRelease, deleteSnapshot, getSnapshot, snapshotComponents, saveSnapshot,
  loadBytes, usage, exportRelease, importRelease, putRelease
} from "../shared/release-store.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {FFBadge} from "../shared/ui.js";
import {confirmDialog} from "../../ui/confirm.js";
import {useRelease, setRelease, orgByHost, loadOrgs, fmtWhen, downloadBytes} from "./release-state.js";
import {setupUrl} from "../shared/deploy-api.js";
import {CardHead, PresetPicker, DiffView, orgOptions, OrgTag} from "./release-ui.js";
import {retrieveAll, keepObject} from "./release-compare.js";

const h = React.createElement;

const KIND_LABEL = {
  validation: {label: "Validation", kind: "info"},
  deploy: {label: "Deploy", kind: "ok"},
  quick: {label: "Quick deploy", kind: "ok"},
  rollback: {label: "Rollback", kind: "warn"},
  restore: {label: "Restore", kind: "warn"}
};

function safeName(s) {
  return String(s || "release").replace(/[^\w.-]+/g, "_");
}

function groupKeys(keys) {
  const by = {};
  for (const k of keys || []) {
    const {type, fullName} = splitKey(k);
    (by[type] = by[type] || []).push(fullName);
  }
  return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
}

function KeyList({keys, del}) {
  if (!keys || !keys.length) return null;
  return h("div", {className: "rel-plan-list" + (del ? " rel-del" : "")}, groupKeys(keys).map(([t, names]) =>
    h("div", {key: t}, h("b", null, (del ? "Delete " : "") + typeLabel(t) + ": "), names.join(", "))));
}

function ReleaseDetail({r, onRollback, onDelete, onExport, onCommit, onPromote, onPullRequest, onCompareAgain, onCheck, busy}) {
  const s = r.summary || {};
  const canRollback = r.kind !== "validation" && r.snapshotId && (r.success || r.status === "Unknown" || r.status === "InProgress");
  const unsure = r.deployId && (r.status === "Unknown" || r.status === "InProgress");
  return h("div", {className: "rel-hist-detail"},
    h("div", {className: "tr-summary"},
      s.components && h("span", {className: "tr-stat"}, `Components ${s.components.deployed}/${s.components.total}`),
      s.tests && s.tests.total > 0 && h("span", {className: "tr-stat" + (s.tests.errors ? " bad" : " ok")}, `Tests ${s.tests.completed}/${s.tests.total}`),
      r.testLevel && h("span", {className: "tr-stat"}, "Test level: " + r.testLevel),
      r.imported && h(FFBadge, {kind: "info"}, "Imported")),
    unsure && h("div", {className: "insp-warn"}, "SaralForce lost track of this deploy before it finished. ",
      h("button", {className: "field-action-btn", disabled: busy, onClick: onCheck}, "Check status"), r.error ? ` (${r.error})` : ""),
    (r.name || r.by) && h("div", {className: "insp-meta"}, [r.name && `Release: ${r.name}`, r.by && `Deployed by ${r.by}`].filter(Boolean).join(" · ")),
    h(KeyList, {keys: r.items}),
    h(KeyList, {keys: r.deletes, del: true}),
    s.errorMessage && h("div", {className: "insp-error"}, s.errorMessage),
    (s.componentFailures || []).length > 0 && h("ul", {className: "rel-checks"}, s.componentFailures.slice(0, 10).map((f, i) =>
      h("li", {key: i, className: "rel-check rel-check-err"}, `${typeLabel(f.type)} ${f.fullName}${f.line ? ` line ${f.line}` : ""}: ${f.problem}`))),
    (s.testFailures || []).length > 0 && h("ul", {className: "rel-checks"}, s.testFailures.slice(0, 10).map((t, i) =>
      h("li", {key: i, className: "rel-check rel-check-err"}, `${t.className}.${t.method}: ${t.message}`))),
    r.notes && h("details", {className: "rel-paste"}, h("summary", null, "Release notes"), h("div", {className: "rel-ai-body"}, r.notes)),
    h("div", {className: "insp-meta"},
      r.deployId && ["Deploy id ", h("code", {key: "d"}, r.deployId)],
      r.validationId && [" · validation ", h("code", {key: "v"}, r.validationId)],
      r.snapshotId ? " · rollback point saved" : (r.kind !== "validation" ? " · no rollback point" : ""),
      r.git && [" · ", h("a", {key: "g", href: r.git.url, target: "_blank", rel: "noopener"}, "commit on GitHub")],
      r.pr && [" · ", h("a", {key: "p", href: r.pr.url, target: "_blank", rel: "noopener"}, `pull request #${r.pr.number}`)]),
    h("div", {className: "rel-actionbar"},
      h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onDelete}, "Delete"),
      h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onExport, title: "Release record, deployed files and rollback point as one zip"}, "Download"),
      githubConfig() && r.zipId && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onCommit,
        title: "Commit the deployed files to GitHub in source format"}, r.git ? "Commit again" : "Commit to GitHub"),
      githubConfig() && r.zipId && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onPullRequest,
        title: "Commit to a new branch and open a pull request for review"}, r.pr ? "Update pull request" : "Open pull request"),
      (r.items || []).length > 0 && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onCompareAgain,
        title: "Compare these items again between any two orgs (clone the package)"}, "Compare again"),
      r.zipId && r.kind !== "validation" && r.success && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onPromote,
        title: "Send this exact package to the next org (for example UAT → production)"}, "Deploy to another org…"),
      canRollback && h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: onRollback,
        title: "Put back what the target had before this release"}, "Roll back…")));
}

// Snapshot vs the same org now.
async function driftCompare(snap, onStatus) {
  const org = orgByHost(snap.orgHost);
  if (!org) throw new Error(`Log in to ${snap.orgName || snap.orgHost} in this browser first, then press ↻.`);
  onStatus("Reading the snapshot…");
  const then = await snapshotComponents(snap.id);
  if (!(snap.types && snap.types.length)) {
    const own = new Set((snap.keys || []).map(k => k.toLowerCase()));
    for (const k of [...then.keys()]) if (!own.has(k.toLowerCase())) then.delete(k);
  }
  const types = snap.types && snap.types.length ? snap.types : [...new Set((snap.keys || []).map(k => splitKey(k).type))];
  onStatus(`Listing ${org.name}…`);
  const live = await listComponents(org.conn, types, {onProgress: (n, of) => onStatus(`Listing ${org.name}… ${n}/${of}`)});
  const scope = snap.types && snap.types.length ? null : new Set(snap.keys || []);
  const liveKeys = [...live.keys()].filter(k => keepObject(k) && (!scope || scope.has(k)));
  const now = liveKeys.length ? (await retrieveAll(org.conn, liveKeys, org.name, onStatus)).files : new Map();
  const nowComps = componentsFromZip(now, bytesToText);
  for (const k of liveKeys) if (!nowComps.has(k)) nowComps.set(k, {...splitKey(k), files: {}, raw: {}});
  // Pre-deploy snapshots only hold the touched parts: compare those.
  if (scope) for (const k of [...nowComps.keys()]) if (!scope.has(k)) nowComps.delete(k);
  return {snap, org, then, rows: classifyComponents(then, nowComps)};
}

function DriftCard({drift, onClose, goTo}) {
  const [filter, setFilter] = React.useState({new: true, changed: true, deleted: true, same: false});
  const [open, setOpen] = React.useState(null);
  const [sel, setSel] = React.useState(new Set());
  const counts = compareCounts(drift.rows);
  const shown = drift.rows.filter(r => filter[r.status]);
  const toggle = k => { const n = new Set(sel); if (n.has(k)) n.delete(k); else n.add(k); setSel(n); };
  const restore = () => {
    const {restore: keys, remove} = restoreFromDrift(drift.rows, sel);
    setRelease({pendingPlan: {
      kind: "restore", title: `Restore from snapshot · ${drift.org.name}`, since: new Date().toISOString(),
      detail: `Puts back ${keys.length} component(s) as they were on ${new Date(drift.snap.at).toLocaleString()}` +
        (remove.length ? ` and deletes ${remove.length} added since.` : "."),
      comps: drift.then, keys, destructive: membersFromKeys(remove), targetHost: drift.org.host
    }});
    goTo("deploy");
  };
  return h("div", {className: "org-card org-card-wide", "data-release-drift": ""},
    h(CardHead, {icon: "🧭", title: `Changes since ${drift.snap.label || "snapshot"} · ${drift.org.name}`},
      h("button", {className: "btn btn-secondary btn-sm", onClick: onClose}, "Close")),
    h("div", {className: "sq3-card-sub"}, `Snapshot from ${new Date(drift.snap.at).toLocaleString()} compared with the org now.`),
    h("div", {className: "rel-filters"}, ["changed", "new", "deleted", "same"].map(k => h("button", {
      key: k, type: "button", "aria-pressed": filter[k], className: "insp-chip rel-chip" + (filter[k] ? " on" : ""),
      onClick: () => setFilter({...filter, [k]: !filter[k]})
    }, `${DRIFT_LABELS[k].label} · ${counts[k]}`))),
    shown.length === 0 ? h("div", {className: "insp-meta"}, counts.changed + counts.new + counts.deleted ? "Nothing matches the filters." : "No drift: the org matches the snapshot.")
      : h("div", {className: "insp-table-wrap rel-table-wrap"},
        h("table", {className: "insp-table rel-table"},
          h("thead", null, h("tr", null, h("th", {className: "rel-cb"}), h("th", null, "Status"), h("th", null, "Type"), h("th", null, "Name"))),
          h("tbody", null, shown.slice(0, 500).map(r => [
            h("tr", {key: r.key, className: "rel-row" + (sel.has(r.key) ? " sel" : ""), onClick: () => setOpen(open === r.key ? null : r.key)},
              h("td", {className: "rel-cb", onClick: e => e.stopPropagation()},
                r.status !== "same" && h("input", {type: "checkbox", checked: sel.has(r.key), onChange: () => toggle(r.key), "aria-label": "Restore " + r.fullName})),
              h("td", null, h(FFBadge, {kind: DRIFT_LABELS[r.status].kind}, DRIFT_LABELS[r.status].label)),
              h("td", {className: "insp-meta"}, typeLabel(r.type)),
              h("td", {className: "rel-name"}, (open === r.key ? "▾ " : "▸ ") + r.fullName)),
            open === r.key && h("tr", {key: r.key + ":d", className: "rel-diff-row"},
              h("td", {colSpan: 4}, h(DiffView, {row: r, heading: "Now  →  Snapshot (what a restore puts back)"})))])))),
    h("div", {className: "rel-actionbar"},
      h("span", {className: "insp-meta"}, `${sel.size} picked`),
      h("button", {className: "btn btn-primary btn-sm", disabled: !sel.size, onClick: restore}, "Restore picked…")));
}

// Every deployment Salesforce recorded in an org, whatever tool made it
// (change sets, CLI, other DevOps tools, SaralForce), last 30 days.
function OrgDeployments({releases}) {
  const st = useRelease();
  const orgs = (st.orgs || []).filter(o => !o.isGit);
  const [host, setHost] = React.useState("");
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const org = orgByHost(host) || orgByHost(st.targetHost) || orgs.find(o => o.isCurrent) || null;
  const load = async () => {
    if (!org) return;
    setBusy(true); setErr(""); setRows(null);
    const rich = "SELECT Id, Status, CheckOnly, StartDate, CompletedDate, CreatedBy.Name, NumberComponentsTotal, NumberComponentErrors, NumberTestsTotal, NumberTestErrors FROM DeployRequest ORDER BY StartDate DESC LIMIT 100";
    const lean = "SELECT Id, Status, CheckOnly, StartDate, CompletedDate, CreatedById FROM DeployRequest ORDER BY StartDate DESC LIMIT 100";
    try {
      let list;
      try { list = await queryAll(org.conn, rich, {tooling: true}); } catch (e) { list = await queryAll(org.conn, lean, {tooling: true}); }
      setRows(list);
    } catch (e) {
      setErr("Salesforce did not return the deployment list here (" + (e.message || e) + "). Open Deployment Status in Setup instead.");
    } finally {
      setBusy(false);
    }
  };
  const ours = new Map(releases.filter(r => r.deployId).map(r => [String(r.deployId).slice(0, 15), r]));
  return h("div", {className: "org-card org-card-wide", "data-release-orgdeploys": ""},
    h(CardHead, {icon: "🛰️", title: "All deployments in an org"},
      org && h("a", {className: "btn btn-secondary btn-sm", href: setupUrl(org.conn, "/lightning/setup/DeployStatus/home"), target: "_blank", rel: "noopener"}, "Deployment Status"),
      h("button", {className: "btn btn-primary btn-sm", disabled: busy || !org, onClick: load}, busy ? "Loading…" : rows ? "Refresh" : "Load")),
    h("div", {className: "sq3-card-sub"}, "What Salesforce itself recorded: deployments and validations from any tool (change sets, CLI, other DevOps tools, SaralForce), so nothing reaches the org unseen."),
    h("div", {className: "rel-orgbar"},
      h("div", {className: "rel-org"},
        h("span", {className: "rel-org-l"}, "Org"),
        h(SearchSelect, {value: org ? org.host : "", options: orgOptions(orgs), onChange: v => { setHost(v); setRows(null); }, ariaLabel: "Org for deployment list"}),
        h(OrgTag, {org}))),
    err && h("div", {className: "insp-warn"}, err),
    rows && (rows.length === 0 ? h("div", {className: "insp-meta"}, "No deployments recorded recently.")
      : h("div", {className: "insp-table-wrap rel-table-wrap"},
        h("table", {className: "insp-table rel-table"},
          h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "What"), h("th", null, "By"), h("th", null, "Components"), h("th", null, "Tests"), h("th", null, "Result"), h("th", null, "From"))),
          h("tbody", null, rows.map(d => {
            const mine = ours.get(String(d.Id).slice(0, 15));
            const okish = /Succeeded/.test(d.Status || "");
            return h("tr", {key: d.Id},
              h("td", {className: "insp-meta"}, fmtWhen(d.CompletedDate || d.StartDate)),
              h("td", null, d.CheckOnly ? "Validation" : "Deploy"),
              h("td", null, d.CreatedBy ? d.CreatedBy.Name : (d.CreatedById || "")),
              h("td", null, d.NumberComponentsTotal != null ? `${d.NumberComponentsTotal}` + (d.NumberComponentErrors ? ` · ${d.NumberComponentErrors} err` : "") : ""),
              h("td", null, d.NumberTestsTotal ? `${d.NumberTestsTotal}` + (d.NumberTestErrors ? ` · ${d.NumberTestErrors} failed` : "") : ""),
              h("td", null, h(FFBadge, {kind: okish ? "ok" : /Fail|Cancel/.test(d.Status || "") ? "err" : "info"}, d.Status)),
              h("td", {className: "insp-meta"}, mine ? `SaralForce ${mine.version || "validation"}` : "Other tool"));
          }))))));
}

export function HistoryView({goTo}) {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [releases, setReleases] = React.useState(null);
  const [snaps, setSnaps] = React.useState([]);
  const [space, setSpace] = React.useState(null);
  const [err, setErr] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [orgFilter, setOrgFilter] = React.useState("");
  const [showValidations, setShowValidations] = React.useState(false);
  const [open, setOpen] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [drift, setDrift] = React.useState(null);
  const [rbPick, setRbPick] = React.useState(null);
  const startRollback = () => {
    const {r, target, comps, plan, picked} = rbPick;
    const restore = plan.restore.filter(k => picked.has(k));
    const remove = plan.remove.filter(k => picked.has(k));
    const partial = restore.length + remove.length < plan.restore.length + plan.remove.length;
    setRelease({pendingPlan: {kind: "rollback", title: `Roll back ${r.version}${partial ? " (partly)" : ""} · ${target.name}`,
      detail: `Restores ${restore.length} component(s)` + (remove.length ? ` and deletes ${remove.length} that ${r.version} added` : "") + ". Validate first, then Quick deploy.",
      since: r.finishedAt || r.at, comps, keys: restore, destructive: membersFromKeys(remove), targetHost: r.targetHost, releaseId: r.id,
      sourceName: `${r.targetName || target.name} as it was before ${r.version || "the release"}${r.at ? " (" + new Date(r.at).toLocaleString(undefined, {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}) + ")" : ""}`}});
    setRbPick(null);
    goTo("deploy");
  };
  const checkStatus = r => work(async () => {
    const org = orgByHost(r.targetHost);
    if (!org) throw new Error(`Log in to ${r.targetName} in this browser first, then press ↻ in Compare.`);
    const sum = await deployStatus(org.conn, r.deployId);
    if (!sum.done) { setMsg(`Still running in ${r.targetName}: ${sum.stateDetail || sum.status}.`); return; }
    await putRelease({...r, success: sum.success, status: sum.status, summary: trimSummary(sum), error: ""});
    setMsg(`${r.version || "Validation"}: ${sum.status}.`);
    await load();
  });
  const compareAgain = r => {
    setRelease({compareOnly: [...(r.items || []), ...(r.deletes || [])]});
    goTo("compare");
  };
  const [snapHost, setSnapHost] = useFfSession("release", "snapHost", "");
  const [snapPresets, setSnapPresets] = useFfSession("release", "snapPresets", ["apex", "ui", "flows", "objects"]);
  const fileRef = React.useRef(null);

  const load = async () => {
    try {
      const [r, s] = await Promise.all([listReleases(), listSnapshots()]);
      setReleases(r); setSnaps(s); setSpace(await usage());
    } catch (e) {
      setErr("Could not read the release history: " + (e.message || e));
      setReleases([]);
    }
  };
  React.useEffect(() => { load(); }, [st.historyTick]);

  const work = async (fn) => {
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); setStatus(""); }
  };

  const rollback = r => work(async () => {
    const target = orgByHost(r.targetHost);
    if (!target) throw new Error(`Log in to ${r.targetName || r.targetHost} in this browser first, then press ↻ in Compare.`);
    const snap = await getSnapshot(r.snapshotId);
    if (!snap) throw new Error("The rollback point for this release is gone (deleted or cleared from this browser).");
    const comps = await snapshotComponents(snap.id);
    const plan = rollbackPlan(r, new Set(comps.keys()), snap.missing);
    const detail = `Restores ${plan.restore.length} component(s) to how they were before ${r.version}` +
      (plan.remove.length ? ` and deletes ${plan.remove.length} that ${r.version} added.` : ".") +
      (plan.unknown.length ? ` ${plan.unknown.length} item(s) have no saved state and stay as they are.` : "");
    // Pick what to roll back (all by default): a partial rollback.
    setRbPick({r, target, comps, plan, detail, picked: new Set([...plan.restore, ...plan.remove])});
  });

  const removeRelease = r => work(async () => {
    const ok = await confirmDialog({title: "Delete this history entry?", message: `${r.version || "Validation"} to ${r.targetName}. Its rollback point is kept under Snapshots until you delete it.`, confirmLabel: "Delete", danger: true});
    if (!ok) return;
    await deleteRelease(r.id);
    await load();
  });

  const pushToGit = async (comps, message, opts = {}) => {
    const cfg = githubConfig();
    if (!cfg) throw new Error("Connect GitHub in Settings first.");
    const files = toSourceFiles(comps, cfg.base);
    if (!files.size && !(opts.deletePaths || []).length) throw new Error("Nothing to commit.");
    return commitFiles(cfg, files, message, {onStatus: setStatus, ...opts});
  };

  // Source paths of a release's deletes, from its rollback point.
  const deletedPaths = async r => {
    const cfg = githubConfig();
    if (!(r.deletes || []).length || !r.snapshotId) return [];
    const snap = await snapshotComponents(r.snapshotId).catch(() => new Map());
    const gone = new Map([...snap.entries()].filter(([k]) => r.deletes.some(d => d.toLowerCase() === k.toLowerCase())));
    return [...toSourceFiles(gone, cfg.base).keys()];
  };

  const releaseComps = async r => {
    const bytes = await loadBytes(r.zipId);
    if (!bytes) throw new Error("This release has no deployed files saved in this browser.");
    return componentsFromZip(await readZip(bytes), bytesToText);
  };

  const promote = r => work(async () => {
    const comps = await releaseComps(r);
    const keys = (r.items || []).filter(k => comps.has(k));
    setRelease({pendingPlan: {kind: "promote", title: `Deploy ${r.version}${r.name ? " (" + r.name + ")" : ""} to another org`,
      detail: `The exact package that went to ${r.targetName}: ${keys.length} item(s)` + ((r.deletes || []).length ? `, ${r.deletes.length} delete(s)` : "") +
        ". Pick the target above, validate, then Quick deploy.",
      sourceName: `${r.version} package (${r.targetName})`, comps, keys, destructive: membersFromKeys(r.deletes || []), targetHost: ""}});
    goTo("deploy");
  });

  const pullRequest = r => work(async () => {
    const cfg = githubConfig();
    if (!cfg) throw new Error("Connect GitHub in Settings first.");
    const files = toSourceFiles(await releaseComps(r), cfg.base);
    const slug = String(r.name || r.targetName || "release").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const branch = `release/${r.version || "v"}-${slug}`;
    const body = [`Deployed to **${r.targetName}** from ${r.sourceName || "?"} on ${new Date(r.at).toLocaleString()}${r.by ? " by " + r.by : ""}.`,
      `${(r.items || []).length} item(s)` + ((r.deletes || []).length ? `; deleted: ${r.deletes.join(", ")}` : ""), r.notes ? "\n" + r.notes : "",
      "\nOpened by SaralForce SandShift."].filter(Boolean).join("\n");
    const pr = await openPullRequest(cfg, files, {branch, title: `${r.version}${r.name ? ": " + r.name : ""} → ${r.targetName}`, body, onStatus: setStatus, deletePaths: await deletedPaths(r)});
    await putRelease({...r, pr: {url: pr.url, number: pr.number}});
    setMsg(pr.existing ? `Updated pull request #${pr.number}.` : `Opened pull request #${pr.number}.`);
    await load();
  });

  const commitRelease = r => work(async () => {
    const bytes = await loadBytes(r.zipId);
    if (!bytes) throw new Error("This release has no deployed files saved in this browser.");
    const comps = componentsFromZip(await readZip(bytes), bytesToText);
    const lines = [`${r.version}: ${r.sourceName || "?"} → ${r.targetName} (${(r.items || []).length} item(s))`, ""];
    if ((r.deletes || []).length) lines.push("Deleted in the org: " + r.deletes.join(", "), "");
    if (r.notes) lines.push(r.notes, "");
    lines.push(`Deploy id ${r.deployId || "-"} · ${r.status || ""} · by SaralForce`);
    const res = await pushToGit(comps, lines.join("\n"), {deletePaths: await deletedPaths(r)});
    await putRelease({...r, git: {url: res.url, sha: res.sha, at: new Date().toISOString()}});
    setMsg(res.unchanged ? "GitHub already had these files; nothing new to commit." : `Committed ${res.files} file(s) to GitHub.`);
    await load();
  });

  const commitSnap = s => work(async () => {
    const cfg = githubConfig();
    const comps = await snapshotComponents(s.id);
    const types = new Set(s.types && s.types.length ? s.types : (s.keys || []).map(k => splitKey(k).type));
    const newPaths = new Set([...toSourceFiles(comps, "").keys()]);
    // A full snapshot replaces the branch's files of those types: what the org no longer has goes.
    const onBranch = s.types && s.types.length && cfg ? await listPaths(cfg) : new Set();
    if (onBranch.truncated) throw new Error("This repository is too large for GitHub to list in one request, so SaralForce cannot tell which files the snapshot replaces. Nothing was committed.");
    const deletePaths = s.types && s.types.length && cfg
      ? [...onBranch].filter(p => { const t = sourcePathType(p); return t && types.has(t.type) && !newPaths.has(p); })
        .map(p => (cfg.base ? cfg.base.replace(/^\/+|\/+$/g, "") + "/" : "") + p)
      : [];
    const res = await pushToGit(comps, `Snapshot of ${s.orgName} (${new Date(s.at).toLocaleString()}) · ${(s.keys || []).length} component(s)`,
      {deletePaths, mergeLabels: !types.has("CustomLabel")});
    setMsg(res.unchanged ? "GitHub already matches this snapshot." : `Committed the snapshot (${res.files} files) to GitHub: ${res.url}`);
  });

  const exportOne = r => work(async () => {
    const bytes = await exportRelease(r);
    downloadBytes(`${safeName(r.targetName)}-${r.version || "validation"}-${r.at.slice(0, 10)}.zip`, bytes);
  });

  const importOne = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    work(async () => {
      const r = await importRelease(new Uint8Array(await file.arrayBuffer()));
      setMsg(`Imported ${r.version || "validation"} for ${r.targetName}.`);
      await load();
    });
  };

  const takeSnapshot = () => work(async () => {
    const org = orgByHost(snapHost) || (st.orgs || []).find(o => o.isCurrent);
    if (!org) throw new Error("Pick an org.");
    await loadCatalog(org.conn);
    const types = presetTypes(snapPresets);
    if (!types.length) throw new Error("Pick at least one kind of metadata.");
    const list = await listComponents(org.conn, types, {onProgress: (n, of) => setStatus(`Listing ${org.name}… ${n}/${of}`)});
    const skipped = list.skipped || [];
    const keys = [...list.keys()].filter(keepObject);
    const {files} = keys.length ? await retrieveAll(org.conn, keys, org.name, setStatus) : {files: new Map()};
    setStatus("Saving…");
    const snap = await saveSnapshot({orgHost: org.host, orgName: org.name, kind: "manual",
      label: `Snapshot ${new Date().toLocaleDateString()}`, keys, missing: [], types}, files);
    setMsg(`Saved a snapshot of ${keys.length} component(s) from ${org.name} (${formatBytes(snap.size)}).` +
      (skipped.length ? ` Not included (Salesforce could not list them here): ${skipped.map(typeLabel).join(", ")}.` : ""));
    await load();
  });

  const compareSnap = s => work(async () => {
    setDrift(await driftCompare(s, setStatus));
  });

  const downloadSnap = s => work(async () => {
    const b = await loadBytes(s.id);
    if (!b) throw new Error("The snapshot files are missing.");
    downloadBytes(`${safeName(s.orgName)}-snapshot-${s.at.slice(0, 10)}.zip`, b);
  });

  const removeSnap = s => work(async () => {
    const used = (releases || []).filter(r => r.snapshotId === s.id);
    const ok = await confirmDialog({title: "Delete this snapshot?",
      message: used.length ? `It is the rollback point of ${used.map(r => r.version).join(", ")}; those can no longer be rolled back.` : "It will be removed from this browser.",
      confirmLabel: "Delete", danger: true});
    if (!ok) return;
    await deleteSnapshot(s.id);
    if (drift && drift.snap.id === s.id) setDrift(null);
    await load();
  });

  const orgs = st.orgs || [];
  const hostsInHistory = [...new Set((releases || []).map(r => r.targetHost))];
  const filterOptions = [{value: "", label: "All target orgs"},
    ...hostsInHistory.map(host => {
      const r = releases.find(x => x.targetHost === host);
      return {value: host, label: r.targetName || host, sub: host};
    })];
  const shown = (releases || []).filter(r => (!orgFilter || r.targetHost === orgFilter) && (showValidations || r.kind !== "validation"));

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🗂️", title: "Releases"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => fileRef.current && fileRef.current.click(),
          title: "Load a release downloaded from SaralForce"}, "Import"),
        h("input", {ref: fileRef, type: "file", accept: ".zip", hidden: true, onChange: importOne})),
      h("div", {className: "sq3-card-sub"},
        "Every deploy gets a version per target org and a rollback point: the target's own copy of what it changed, saved just before. Kept in this browser only."),
      h("div", {className: "rel-filters"},
        h(SearchSelect, {value: orgFilter, options: filterOptions, onChange: setOrgFilter, ariaLabel: "Target org", className: "rel-by"}),
        h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: showValidations, onChange: e => setShowValidations(e.target.checked)}), " Show validations")),
      err && h("div", {className: "insp-error"}, err),
      msg && h("div", {className: "insp-status-ok"}, msg),
      busy && status && h("div", {className: "tr-progress"},
        h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      releases === null ? h("div", {className: "insp-meta"}, "Loading…")
        : shown.length === 0 ? h("div", {className: "insp-hint-strip"}, releases.length ? "Nothing matches." : "No releases yet. Deploys made from the Deploy step show up here.")
          : h("div", {className: "insp-table-wrap rel-table-wrap"},
            h("table", {className: "insp-table rel-table"},
              h("thead", null, h("tr", null, h("th", null, "Version"), h("th", null, "What"), h("th", null, "When"),
                h("th", null, "From → to"), h("th", null, "Items"), h("th", null, "By"), h("th", null, "Result"))),
              h("tbody", null, shown.map(r => [
                h("tr", {key: r.id, className: "rel-row" + (open === r.id ? " sel" : ""), onClick: () => setOpen(open === r.id ? null : r.id)},
                  h("td", {className: "rel-name"}, (open === r.id ? "▾ " : "▸ ") + (r.version || "—"), r.name && h("div", {className: "insp-meta rel-relname-cell"}, r.name)),
                  h("td", null, h(FFBadge, {kind: (KIND_LABEL[r.kind] || KIND_LABEL.deploy).kind}, (KIND_LABEL[r.kind] || KIND_LABEL.deploy).label)),
                  h("td", {className: "insp-meta"}, fmtWhen(r.at)),
                  h("td", null, `${r.sourceName || "—"} → ${r.targetName}`),
                  h("td", null, `${(r.items || []).length}` + ((r.deletes || []).length ? ` · −${r.deletes.length}` : "")),
                  h("td", {className: "insp-meta"}, r.by || ""),
                  h("td", null, h(FFBadge, {kind: r.success ? "ok" : "err"}, r.status || (r.success ? "Succeeded" : "Failed")))),
                open === r.id && h("tr", {key: r.id + ":d", className: "rel-diff-row"},
                  h("td", {colSpan: 7}, h(ReleaseDetail, {r, busy, onRollback: () => rollback(r), onDelete: () => removeRelease(r), onExport: () => exportOne(r), onCommit: () => commitRelease(r), onPromote: () => promote(r), onPullRequest: () => pullRequest(r), onCompareAgain: () => compareAgain(r), onCheck: () => checkStatus(r)})))
              ]))))),

    rbPick && h("div", {className: "org-card org-card-wide", "data-release-rbpick": ""},
      h(CardHead, {icon: "↩️", title: `Roll back ${rbPick.r.version} · ${rbPick.target.name}`},
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => setRbPick(null)}, "Cancel")),
      h("div", {className: "sq3-card-sub"}, rbPick.detail + " Untick anything you want to keep as it is now."),
      h("div", {className: "insp-table-wrap rel-table-wrap"},
        h("table", {className: "insp-table rel-table"},
          h("tbody", null, [...rbPick.plan.restore.map(k => [k, "Restore old version"]), ...rbPick.plan.remove.map(k => [k, "Delete (added by the release)"])].map(([k, what]) =>
            h("tr", {key: k, className: "rel-row" + (rbPick.picked.has(k) ? " sel" : ""), onClick: () => {
              const next = new Set(rbPick.picked);
              if (next.has(k)) next.delete(k); else next.add(k);
              setRbPick({...rbPick, picked: next});
            }},
              h("td", {className: "rel-cb"}, h("input", {type: "checkbox", readOnly: true, checked: rbPick.picked.has(k), "aria-label": "Roll back " + k})),
              h("td", null, h(FFBadge, {kind: what.startsWith("Delete") ? "err" : "warn"}, what)),
              h("td", {className: "insp-meta"}, typeLabel(splitKey(k).type)),
              h("td", {className: "rel-name"}, splitKey(k).fullName)))))),
      rbPick.plan.unknown.length > 0 && h("div", {className: "insp-meta rel-note"}, `${rbPick.plan.unknown.length} item(s) have no saved state and stay as they are.`),
      h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"}, `${rbPick.picked.size} of ${rbPick.plan.restore.length + rbPick.plan.remove.length} picked`),
        h("button", {className: "btn btn-primary btn-sm", disabled: !rbPick.picked.size, onClick: startRollback}, "Prepare rollback →"))),
    drift && h(DriftCard, {drift, goTo, onClose: () => setDrift(null)}),
    h(OrgDeployments, {releases: releases || []}),

    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "📸", title: `Snapshots · ${snaps.length}`}),
      h("div", {className: "sq3-card-sub"},
        "A snapshot is a point-in-time copy of an org's metadata. Compare it with the org now to see drift (changes made outside your releases), and restore what you pick."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Org"),
          h(SearchSelect, {value: (orgByHost(snapHost) || orgs.find(o => o.isCurrent) || {}).host || "", options: orgOptions(orgs),
            onChange: setSnapHost, disabled: busy, ariaLabel: "Org to snapshot", placeholder: st.orgsBusy ? "Finding your orgs…" : "Pick an org"}),
          h(OrgTag, {org: orgByHost(snapHost) || orgs.find(o => o.isCurrent)}))),
      h(PresetPicker, {value: snapPresets, onChange: setSnapPresets, disabled: busy}),
      h("div", {className: "rel-actionbar"},
        space && space.quota > 0 && h("span", {className: "insp-meta"}, `Using ${formatBytes(space.used)} of this browser's storage`),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !orgs.length, onClick: takeSnapshot}, busy && status ? "Working…" : "Take snapshot")),
      snaps.length > 0 && h("div", {className: "insp-table-wrap rel-table-wrap"},
        h("table", {className: "insp-table rel-table"},
          h("thead", null, h("tr", null, h("th", null, "Snapshot"), h("th", null, "Org"), h("th", null, "When"), h("th", null, "Items"), h("th", null, "Size"), h("th", null, ""))),
          h("tbody", null, snaps.map(s => {
            const usedBy = (releases || []).find(r => r.snapshotId === s.id);
            return h("tr", {key: s.id},
              h("td", null, usedBy ? `Before ${usedBy.version}` : s.label, s.kind === "pre-deploy" && h("span", {className: "insp-meta"}, " · rollback point")),
              h("td", null, s.orgName),
              h("td", {className: "insp-meta"}, fmtWhen(s.at)),
              h("td", null, (s.keys || []).length),
              h("td", {className: "insp-meta"}, formatBytes(s.size)),
              h("td", {className: "rel-snap-actions"},
                h("button", {className: "field-action-btn", disabled: busy, onClick: () => compareSnap(s)}, "Compare with now"),
                h("button", {className: "field-action-btn", disabled: busy, onClick: () => downloadSnap(s)}, "Download"),
                githubConfig() && h("button", {className: "field-action-btn", disabled: busy, onClick: () => commitSnap(s), title: "Commit this snapshot to GitHub (a backup you can diff)"}, "Commit to GitHub"),
                h("button", {className: "field-action-btn", disabled: busy, onClick: () => removeSnap(s)}, "Delete")));
          }))))));
}
