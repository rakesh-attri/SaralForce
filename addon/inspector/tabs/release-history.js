// Release Center → History: every validation and deploy, rollback points,
// org snapshots, drift ("what changed since the snapshot?") and restore.
import {
  presetTypes, splitKey, typeLabel, membersFromKeys, classifyComponents, compareCounts, componentsFromZip
} from "../../core/deploy.js";
import {bytesToText, readZip} from "../../core/zip.js";
import {toSourceFiles} from "../../core/source-format.js";
import {githubConfig, commitFiles} from "../shared/github.js";
import {rollbackPlan, restoreFromDrift, DRIFT_LABELS, formatBytes} from "../../core/release-history.js";
import {listComponents} from "../shared/deploy-api.js";
import {
  listReleases, listSnapshots, deleteRelease, deleteSnapshot, getSnapshot, snapshotComponents, saveSnapshot,
  loadBytes, usage, exportRelease, importRelease, putRelease
} from "../shared/release-store.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {FFBadge} from "../shared/ui.js";
import {confirmDialog} from "../../ui/confirm.js";
import {useRelease, setRelease, orgByHost, loadOrgs, fmtWhen, downloadBytes} from "./release-state.js";
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

function ReleaseDetail({r, onRollback, onDelete, onExport, onCommit, busy}) {
  const s = r.summary || {};
  const canRollback = r.kind !== "validation" && r.success && r.snapshotId;
  return h("div", {className: "rel-hist-detail"},
    h("div", {className: "tr-summary"},
      s.components && h("span", {className: "tr-stat"}, `Components ${s.components.deployed}/${s.components.total}`),
      s.tests && s.tests.total > 0 && h("span", {className: "tr-stat" + (s.tests.errors ? " bad" : " ok")}, `Tests ${s.tests.completed}/${s.tests.total}`),
      r.testLevel && h("span", {className: "tr-stat"}, "Test level: " + r.testLevel),
      r.imported && h(FFBadge, {kind: "info"}, "Imported")),
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
      r.git && [" · ", h("a", {key: "g", href: r.git.url, target: "_blank", rel: "noopener"}, "commit on GitHub")]),
    h("div", {className: "rel-actionbar"},
      h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onDelete}, "Delete"),
      h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onExport, title: "Release record, deployed files and rollback point as one zip"}, "Download"),
      githubConfig() && r.zipId && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: onCommit,
        title: "Commit the deployed files to GitHub in source format"}, r.git ? "Commit again" : "Commit to GitHub"),
      canRollback && h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: onRollback,
        title: "Put back what the target had before this release"}, "Roll back…")));
}

// Snapshot vs the same org now.
async function driftCompare(snap, onStatus) {
  const org = orgByHost(snap.orgHost);
  if (!org) throw new Error(`Log in to ${snap.orgName || snap.orgHost} in this browser first, then press ↻.`);
  onStatus("Reading the snapshot…");
  const then = await snapshotComponents(snap.id);
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
      kind: "restore", title: `Restore from snapshot · ${drift.org.name}`,
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
    const ok = await confirmDialog({title: `Roll back ${r.version}?`, message: detail + " You'll validate it on the Deploy step first.", confirmLabel: "Prepare rollback"});
    if (!ok) return;
    setRelease({pendingPlan: {kind: "rollback", title: `Roll back ${r.version} · ${target.name}`, detail,
      comps, keys: plan.restore, destructive: membersFromKeys(plan.remove), targetHost: r.targetHost, releaseId: r.id}});
    goTo("deploy");
  });

  const removeRelease = r => work(async () => {
    const ok = await confirmDialog({title: "Delete this history entry?", message: `${r.version || "Validation"} to ${r.targetName}. Its rollback point is kept under Snapshots until you delete it.`, confirmLabel: "Delete", danger: true});
    if (!ok) return;
    await deleteRelease(r.id);
    await load();
  });

  const pushToGit = async (comps, message) => {
    const cfg = githubConfig();
    if (!cfg) throw new Error("Connect GitHub in Settings first.");
    const files = toSourceFiles(comps, cfg.base);
    if (!files.size) throw new Error("Nothing to commit.");
    return commitFiles(cfg, files, message, {onStatus: setStatus});
  };

  const commitRelease = r => work(async () => {
    const bytes = await loadBytes(r.zipId);
    if (!bytes) throw new Error("This release has no deployed files saved in this browser.");
    const comps = componentsFromZip(await readZip(bytes), bytesToText);
    const lines = [`${r.version}: ${r.sourceName || "?"} → ${r.targetName} (${(r.items || []).length} item(s))`, ""];
    if ((r.deletes || []).length) lines.push("Deleted in the org: " + r.deletes.join(", "), "");
    if (r.notes) lines.push(r.notes, "");
    lines.push(`Deploy id ${r.deployId || "-"} · ${r.status || ""} · by SaralForce`);
    const res = await pushToGit(comps, lines.join("\n"));
    await putRelease({...r, git: {url: res.url, sha: res.sha, at: new Date().toISOString()}});
    setMsg(res.unchanged ? "GitHub already had these files; nothing new to commit." : `Committed ${res.files} file(s) to GitHub.`);
    await load();
  });

  const commitSnap = s => work(async () => {
    const res = await pushToGit(await snapshotComponents(s.id), `Snapshot of ${s.orgName} (${new Date(s.at).toLocaleString()}) · ${(s.keys || []).length} component(s)`);
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
    const types = presetTypes(snapPresets);
    if (!types.length) throw new Error("Pick at least one kind of metadata.");
    const list = await listComponents(org.conn, types, {onProgress: (n, of) => setStatus(`Listing ${org.name}… ${n}/${of}`)});
    const keys = [...list.keys()].filter(keepObject);
    const {files} = keys.length ? await retrieveAll(org.conn, keys, org.name, setStatus) : {files: new Map()};
    setStatus("Saving…");
    const snap = await saveSnapshot({orgHost: org.host, orgName: org.name, kind: "manual",
      label: `Snapshot ${new Date().toLocaleDateString()}`, keys, missing: [], types}, files);
    setMsg(`Saved a snapshot of ${keys.length} component(s) from ${org.name} (${formatBytes(snap.size)}).`);
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
                h("th", null, "From → to"), h("th", null, "Items"), h("th", null, "Result"))),
              h("tbody", null, shown.map(r => [
                h("tr", {key: r.id, className: "rel-row" + (open === r.id ? " sel" : ""), onClick: () => setOpen(open === r.id ? null : r.id)},
                  h("td", {className: "rel-name"}, (open === r.id ? "▾ " : "▸ ") + (r.version || "—")),
                  h("td", null, h(FFBadge, {kind: (KIND_LABEL[r.kind] || KIND_LABEL.deploy).kind}, (KIND_LABEL[r.kind] || KIND_LABEL.deploy).label)),
                  h("td", {className: "insp-meta"}, fmtWhen(r.at)),
                  h("td", null, `${r.sourceName || "—"} → ${r.targetName}`),
                  h("td", null, `${(r.items || []).length}` + ((r.deletes || []).length ? ` · −${r.deletes.length}` : "")),
                  h("td", null, h(FFBadge, {kind: r.success ? "ok" : "err"}, r.status || (r.success ? "Succeeded" : "Failed")))),
                open === r.id && h("tr", {key: r.id + ":d", className: "rel-diff-row"},
                  h("td", {colSpan: 6}, h(ReleaseDetail, {r, busy, onRollback: () => rollback(r), onDelete: () => removeRelease(r), onExport: () => exportOne(r), onCommit: () => commitRelease(r)})))
              ]))))),

    drift && h(DriftCard, {drift, goTo, onClose: () => setDrift(null)}),

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
