// Release Center: compare orgs, track changes, build a package, validate
// and deploy (forward or reverse) to any org you're logged into.
import {
  typeLabel, membersFromKeys, keysFromMembers, mergeMembers, parsePackageXml,
  METADATA_TYPES, allTypes
} from "../../core/deploy.js";
import {buildPackageXml, packageCount} from "../../core/metadata.js";
import {writeZip} from "../../core/zip.js";
import {apiVersion} from "../../inspector.js";
import {listComponents, retrieve, queryAll, loadCatalog} from "../shared/deploy-api.js";
import {downloadText} from "../shared/csv.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {useRelease, setRelease, orgByHost, loadOrgs, fmtWhen, downloadBytes, orgDaysAgo, orgDayStart, orgDate} from "./release-state.js";
import {auditDelete, auditPermissionEdits, sourceMemberDeletes, buildChanges, changeCounts} from "../../core/changes.js";
import {FFBadge} from "../shared/ui.js";
import {CardHead, orgOptions, OrgTag} from "./release-ui.js";
import {CompareView} from "./release-compare.js";
import {DeployView, resumeDeploy} from "./release-deploy.js";
import {HistoryView} from "./release-history.js";
import {ManualView} from "./release-manual.js";
import {ImpactView} from "./release-impact.js";
import {listReleases, listDrafts, putDraft, deleteDraft} from "../shared/release-store.js";
import {lastReleaseAt} from "../../core/release-history.js";

const h = React.createElement;

const RELEASE_VIEWS = [
  {id: "compare", label: "Compare", icon: "⚖️", hint: "Two orgs side by side; forward or reverse"},
  {id: "changes", label: "Changes", icon: "🕘", hint: "What changed in an org, by date and person"},
  {id: "package", label: "Package", icon: "📦", hint: "package.xml, deletes and source zip"},
  {id: "deploy", label: "Deploy", icon: "🚀", hint: "Validate, quick deploy, deploy now"},
  {id: "manual", label: "Manual steps", icon: "🧰", hint: "What a deploy can’t do: run or check off"},
  {id: "history", label: "History", icon: "🗂️", hint: "Versions, rollback, snapshots, drift"},
  {id: "impact", label: "Impact", icon: "🎯", hint: "Safe to change or delete?"}
];

const SINCE_PICKS = [
  {id: "1", label: "Today", days: 0},
  {id: "7", label: "7 days", days: 7},
  {id: "30", label: "30 days", days: 30}
];

const CHANGE_BADGE = {
  new: {kind: "ok", label: "New"},
  updated: {kind: "warn", label: "Updated"},
  deleted: {kind: "err", label: "Deleted"}
};

// Deleted components: source tracking first (sandboxes, scratch orgs), then
// the Setup audit trail. Either may be unavailable; that's not an error.
async function findDeletes(conn, sinceIso, onStatus) {
  const out = [];
  let tracking = false;
  try {
    onStatus("Checking source tracking for deletes…");
    const sm = await queryAll(conn, "SELECT MemberType, MemberName, IsNameObsolete, LastModifiedDate, LastModifiedById FROM SourceMember " +
      `WHERE IsNameObsolete = true AND LastModifiedDate >= ${sinceIso}`, {tooling: true});
    tracking = true;
    const ids = [...new Set(sm.map(r => r.LastModifiedById).filter(Boolean))];
    const users = ids.length ? await queryAll(conn, `SELECT Id, Name FROM User WHERE Id IN (${ids.map(i => "'" + i + "'").join(",")})`).catch(() => []) : [];
    out.push(...sourceMemberDeletes(sm, Object.fromEntries(users.map(u => [u.Id, u.Name]))));
  } catch (e) { /* no source tracking in this org */ }
  let audit = [];
  try {
    onStatus("Reading the Setup audit trail…");
    audit = await queryAll(conn, "SELECT CreatedDate, CreatedBy.Name, Action, Display, Section FROM SetupAuditTrail " +
      `WHERE CreatedDate >= ${sinceIso} ORDER BY CreatedDate DESC LIMIT 2000`);
    for (const a of audit) {
      const d = auditDelete(a);
      if (d) out.push(d);
    }
  } catch (e) { /* audit trail needs View Setup */ }
  return {deleted: out, audit, tracking};
}

// Profile / permission set edits listMetadata's date misses: their record's
// LastModifiedDate, and the audit trail's "Changed profile X: …" lines.
async function permissionEdits(conn, list, sinceIso, audit) {
  const out = [];
  const byId = new Map();
  for (const r of list.values()) if ((r.type === "Profile" || r.type === "PermissionSet") && r.id) byId.set(r.id.slice(0, 15), r);
  const [profiles, sets] = await Promise.all([
    queryAll(conn, "SELECT Id, Name, LastModifiedDate, LastModifiedBy.Name FROM Profile").catch(() => []),
    queryAll(conn, "SELECT Id, Name, Label, LastModifiedDate, LastModifiedBy.Name FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null").catch(() => [])
  ]);
  const byLabel = {Profile: new Map(), PermissionSet: new Map()};
  for (const [type, recs] of [["Profile", profiles], ["PermissionSet", sets]]) {
    for (const p of recs) {
      const r = byId.get(String(p.Id).slice(0, 15));
      const fullName = r ? r.fullName : type === "PermissionSet" ? p.Name : "";
      if (!fullName) continue;
      byLabel[type].set(String(type === "Profile" ? p.Name : p.Label || p.Name).toLowerCase(), fullName);
      if (p.LastModifiedDate && new Date(p.LastModifiedDate) >= new Date(sinceIso)) {
        out.push({type, fullName, by: p.LastModifiedBy ? p.LastModifiedBy.Name : "", at: p.LastModifiedDate});
      }
    }
  }
  for (const e of auditPermissionEdits(audit)) {
    const fullName = byLabel[e.type].get(e.label.toLowerCase());
    if (fullName) out.push({type: e.type, fullName, by: e.by, at: e.at});
  }
  return out;
}

// ─── Changes: what changed in one org since a date ─────────────────────
function ChangesView({goTo}) {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [host, setHost] = useFfSession("release", "changesHost", "");
  const [since, setSince] = useFfSession("release", "changesSince", () => orgDaysAgo(7));
  const [until, setUntil] = useFfSession("release", "changesUntil", "");
  const [statusFilter, setStatusFilter] = React.useState({new: true, updated: true, deleted: true});
  const [destructive, setDestructive] = useFfSession("release", "destructive", {});
  const [tracking, setTracking] = React.useState(null);
  const [by, setBy] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("");
  const [rows, setRows] = React.useState(null);
  const [audit, setAudit] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [sel, setSel] = React.useState(new Set());
  const [search, setSearch] = React.useState("");
  const [pkg, setPkg] = useFfSession("metadata", "pkg", {});
  const [note, setNote] = React.useState("");
  const orgs = st.orgs || [];
  const org = orgByHost(host) || orgs.find(o => o.isCurrent) || null;
  const [lastAt, setLastAt] = React.useState("");
  React.useEffect(() => {
    if (!org) return;
    listReleases().then(list => setLastAt(lastReleaseAt(list, org.host))).catch(() => setLastAt(""));
  }, [org && org.host, st.historyTick]);

  const run = async () => {
    if (!org) return;
    setBusy(true); setError(""); setRows(null); setAudit(null); setSel(new Set());
    try {
      await loadCatalog(org.conn);
      const types = allTypes();
      const t = orgDayStart(since || orgDaysAgo(7));
      const list = await listComponents(org.conn, types, {onProgress: (n, of) => setStatus(`Listing ${types.length} metadata types in ${org.name}… ${n}/${of}`)});
      const sinceIso = new Date(t).toISOString();
      const del = await findDeletes(org.conn, sinceIso, setStatus);
      setStatus("Checking profiles and permission sets…");
      const touched = await permissionEdits(org.conn, list, sinceIso, del.audit).catch(() => []);
      setRows(buildChanges([...list.values()], del.deleted, t, types, touched, until ? orgDayStart(until) + 864e5 : 0));
      setAudit(del.audit);
      setTracking(del.tracking);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false); setStatus("");
    }
  };

  const people = rows ? [...new Set(rows.map(r => r.by).filter(Boolean))].sort() : [];
  const counts = changeCounts(rows || []);
  const q = search.trim().toLowerCase();
  const typeCounts = [...(rows || []).reduce((m, r) => m.set(r.type, (m.get(r.type) || 0) + 1), new Map()).entries()]
    .sort((a, b) => typeLabel(a[0]).localeCompare(typeLabel(b[0])));
  const shown = (rows || []).filter(r => statusFilter[r.status] && (!by || r.by === by) && (!typeFilter || r.type === typeFilter) &&
    (!q || (r.fullName + " " + typeLabel(r.type)).toLowerCase().includes(q)));
  const toggle = key => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSel(next);
  };
  const allOn = shown.some(r => r.deployable) && shown.filter(r => r.deployable).every(r => sel.has(r.key));
  const picked = (rows || []).filter(r => sel.has(r.key));
  const flash = text => { setNote(text); setTimeout(() => setNote(""), 2500); };

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🕘", title: "What changed?"}),
      h("div", {className: "sq3-card-sub"}, "Every component of every metadata type changed in an org since a date, newest first. Filter by type or person, then pick what belongs in your release."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Org"),
          h(SearchSelect, {value: org ? org.host : "", options: orgOptions(orgs), onChange: setHost, disabled: busy,
            ariaLabel: "Org to check", placeholder: st.orgsBusy ? "Finding your orgs…" : "Pick an org"}),
          h(OrgTag, {org})),
        h("button", {className: "btn btn-secondary btn-sm", disabled: st.orgsBusy, onClick: () => loadOrgs(true), title: "Look again for orgs"}, st.orgsBusy ? "…" : "↻")),
      h("div", {className: "soql-save-row rel-run-row"},
        h("span", {className: "rel-org-l"}, "Changed since"),
        SINCE_PICKS.map(p => h("button", {key: p.id, type: "button", disabled: busy,
          className: "insp-chip rel-chip" + (since === orgDaysAgo(p.days) ? " on" : ""),
          onClick: () => setSince(orgDaysAgo(p.days))}, p.label)),
        lastAt && h("button", {type: "button", disabled: busy, title: "Since the last release deployed from this org",
          className: "insp-chip rel-chip" + (since === orgDate(lastAt) ? " on" : ""),
          onClick: () => setSince(orgDate(lastAt))}, "Last release"),
        h("input", {type: "date", className: "soql-save-input", value: since, disabled: busy, max: until || undefined,
          onChange: e => setSince(e.target.value), "aria-label": "Changed since"}),
        h("span", {className: "rel-org-l"}, "to"),
        h("input", {type: "date", className: "soql-save-input", value: until, disabled: busy, min: since || undefined,
          onChange: e => setUntil(e.target.value), "aria-label": "Changed until (empty: today)", title: "Leave empty for up to now"}),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !org, onClick: run}, busy ? "Looking…" : "Find changes")),
      busy && h("div", {className: "tr-progress"},
        h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      error && h("div", {className: "insp-error"}, error)),

    rows && h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "📋", title: `${rows.length} change(s) in ${org ? org.name : ""} since ${since}${until ? " to " + until : ""}`}),
      h("div", {className: "rel-filters"},
        ["new", "updated", "deleted"].map(k => h("button", {
          key: k, type: "button", "aria-pressed": statusFilter[k],
          className: "insp-chip rel-chip rel-st-" + ({new: "new", updated: "changed", deleted: "deleted"})[k] + (statusFilter[k] ? " on" : ""),
          onClick: () => setStatusFilter({...statusFilter, [k]: !statusFilter[k]})
        }, `${CHANGE_BADGE[k].label} · ${counts[k]}`)),
        h(SearchSelect, {value: typeFilter, className: "rel-type", ariaLabel: "Metadata type",
          options: [{value: "", label: "All metadata types"}, ...typeCounts.map(([t, n]) => ({value: t, label: `${typeLabel(t)} (${n})`}))],
          onChange: setTypeFilter}),
        h(SearchSelect, {
          value: by, className: "rel-by",
          options: [{value: "", label: "Anyone"}, ...people.map(p => ({value: p, label: p}))],
          onChange: setBy, ariaLabel: "Changed by"
        }),
        h("input", {className: "soql-save-input rel-search", placeholder: "Search name or type…", value: search,
          onChange: e => setSearch(e.target.value), "aria-label": "Search changes"})),
      shown.length === 0
        ? h("div", {className: "insp-meta"}, rows.length ? "Nothing matches the filters." : "No changes in this period.")
        : h("div", {className: "insp-table-wrap rel-table-wrap"},
          h("table", {className: "insp-table rel-table"},
            h("thead", null, h("tr", null,
              h("th", {className: "rel-cb"}, h("input", {type: "checkbox", checked: allOn, "aria-label": "Select all shown",
                onChange: e => {
                  const next = new Set(sel);
                  shown.forEach(r => { if (!r.deployable) return; if (e.target.checked) next.add(r.key); else next.delete(r.key); });
                  setSel(next);
                }})),
              h("th", null, "Status"), h("th", null, "Type"), h("th", null, "Name"), h("th", null, "Changed by"), h("th", null, "When"))),
            h("tbody", null, shown.slice(0, 1000).map(r => h("tr", {key: r.key, className: "rel-row" + (sel.has(r.key) ? " sel" : ""), onClick: () => toggle(r.key)},
              h("td", {className: "rel-cb", onClick: e => e.stopPropagation()},
                r.deployable && h("input", {type: "checkbox", checked: sel.has(r.key), onChange: () => toggle(r.key), "aria-label": "Pick " + r.fullName})),
              h("td", null, h(FFBadge, {kind: CHANGE_BADGE[r.status].kind}, CHANGE_BADGE[r.status].label)),
              h("td", {className: "insp-meta"}, typeLabel(r.type)),
              h("td", {className: "rel-name"}, r.fullName),
              h("td", null, r.by),
              h("td", {className: "insp-meta"}, fmtWhen(r.at))))))),
      counts.deleted === 0 && tracking === false && h("div", {className: "insp-meta rel-note"},
        "Deletes come from the Setup audit trail here (this org has no source tracking), so some deletes may not be listed."),
      audit && audit.length > 0 && h("details", {className: "rel-problems"},
        h("summary", null, `Setup audit trail: ${audit.length} change(s) in this period (some are not metadata and need manual steps)`),
        h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("tbody", null, audit.slice(0, 200).map((a, i) => h("tr", {key: i},
              h("td", {className: "insp-meta"}, fmtWhen(a.CreatedDate)),
              h("td", null, a.CreatedBy ? a.CreatedBy.Name : ""),
              h("td", {className: "insp-meta"}, a.Section),
              h("td", null, a.Display))))))),
      h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"}, `${picked.length} picked`),
        note && h("span", {className: "insp-status-ok"}, note),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !picked.length, onClick: () => {
          const keep = picked.filter(r => r.status !== "deleted").map(r => r.key);
          const gone = picked.filter(r => r.status === "deleted").map(r => r.key);
          if (keep.length) setPkg(mergeMembers(pkg, membersFromKeys(keep)));
          if (gone.length) setDestructive(mergeMembers(destructive, membersFromKeys(gone)));
          flash(`${keep.length} added to the package` + (gone.length ? `, ${gone.length} to the delete list` : "") + ".");
        }, title: "Deleted items go to the package's delete list"}, "Add to package"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !picked.length || !org, onClick: () => {
          setRelease({compareOnly: picked.map(r => r.key), sourceHost: org.host, compare: null, selected: new Set()});
          goTo("compare");
        }, title: "Compare these with another org before deploying"}, "Compare with another org →"))));
}

// ─── Package: package.xml + destructive changes ──────────────────────
function MemberList({members, onRemove, del}) {
  const types = Object.keys(members).filter(t => (members[t] || []).length).sort();
  if (!types.length) return h("div", {className: "insp-meta"}, del ? "Nothing to delete." : "Empty. Add items from Compare, Changes, Metadata (＋ package.xml), or below.");
  return h("div", {className: "rel-members"}, types.map(t => h("div", {key: t, className: "rel-mtype"},
    h("div", {className: "rel-mtype-h"}, typeLabel(t), h("span", {className: "insp-meta"}, ` · ${members[t].length}`)),
    h("div", {className: "insp-chips"}, members[t].map(m => h("span", {key: m, className: "insp-chip" + (del ? " rel-chip-del" : "")},
      m, h("button", {className: "rel-x", "aria-label": `Remove ${m}`, title: "Remove", onClick: () => onRemove(t, m)}, "×")))))));
}

function removeMember(members, type, name) {
  const next = {...members};
  next[type] = (next[type] || []).filter(x => x !== name);
  if (!next[type].length) delete next[type];
  return next;
}

// Every type the org can deploy (built-in + describeMetadata).
const typeOptions = () => METADATA_TYPES.filter(t => !t.hidden).map(t => ({value: t.name, label: t.label, sub: t.name}))
  .sort((a, b) => a.label.localeCompare(b.label));

// What the source org has of one type, for the Package search (cached).
const orgTypeCache = new Map();
function orgComponents(org, type) {
  const key = org.host + "|" + type;
  if (!orgTypeCache.has(key)) {
    orgTypeCache.set(key, loadCatalog(org.conn).then(() => listComponents(org.conn, [type]))
      .then(list => [...list.values()].filter(c => !c.isFolder || type.endsWith("Folder")).map(c => c.fullName).sort((a, b) => a.localeCompare(b)))
      .catch(e => { orgTypeCache.delete(key); throw e; }));
  }
  return orgTypeCache.get(key);
}

function PackageView({goTo}) {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [pkg, setPkg] = useFfSession("metadata", "pkg", {});
  const [destructive, setDestructive] = useFfSession("release", "destructive", {});
  const [type, setType] = React.useState("ApexClass");
  const [name, setName] = React.useState("");
  const [toDelete, setToDelete] = React.useState(false);
  const [paste, setPaste] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [err, setErr] = React.useState("");
  const source = orgByHost(st.sourceHost);
  // Search: everything of the chosen type in the source org.
  const [found, setFound] = React.useState({type: "", names: null, err: "", busy: false});
  React.useEffect(() => {
    if (!source || source.isGit || !type) { setFound({type, names: null, err: "", busy: false}); return undefined; }
    let stale = false;
    setFound({type, names: null, err: "", busy: true});
    orgComponents(source, type).then(names => { if (!stale) setFound({type, names, err: "", busy: false}); })
      .catch(e => { if (!stale) setFound({type, names: null, err: e.message || String(e), busy: false}); });
    return () => { stale = true; };
  }, [type, source && source.host]);
  const count = packageCount(pkg);
  const [relName] = useFfSession("release", "relName", "");
  const [drafts, setDrafts] = React.useState([]);
  const loadDrafts = () => listDrafts().then(setDrafts).catch(() => setDrafts([]));
  React.useEffect(() => { loadDrafts(); }, []);
  const saveDraft = async () => {
    const name = relName.trim() || `Draft ${`${new Date().toLocaleDateString(undefined, {day: "numeric", month: "short"})} ${new Date().toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}`}`;
    await putDraft({name, members: pkg, destructive, sourceName: source ? source.name : ""});
    setMsg(`Saved draft “${name}”.`);
    loadDrafts();
  };
  const loadDraft = d => {
    setPkg(mergeMembers(pkg, d.members || {}));
    setDestructive(mergeMembers(destructive, d.destructive || {}));
    setMsg(`Loaded “${d.name}” into the package.`);
  };
  const dropDraft = async d => { await deleteDraft(d.id); loadDrafts(); };
  const delCount = keysFromMembers(destructive).length;

  const add = () => {
    const n = name.trim();
    if (!n) return;
    const m = {[type]: n.split(/\s*,\s*/).filter(Boolean)};
    if (toDelete) setDestructive(mergeMembers(destructive, m)); else setPkg(mergeMembers(pkg, m));
    setName("");
  };
  const term = name.split(",").pop().trim().toLowerCase();
  const inPkg = n => ((toDelete ? destructive : pkg)[type] || []).includes(n);
  const matches = (found.names || []).filter(n => !term || n.toLowerCase().includes(term));
  const addNames = list => {
    const m = {[type]: list};
    if (toDelete) setDestructive(mergeMembers(destructive, m)); else setPkg(mergeMembers(pkg, m));
  };

  const load = (asDelete) => {
    const m = parsePackageXml(paste);
    if (!Object.keys(m).length) { setErr("No <types> found in the pasted XML."); return; }
    setErr("");
    if (asDelete) setDestructive(mergeMembers(destructive, m)); else setPkg(mergeMembers(pkg, m));
    setPaste("");
    setMsg(`Loaded ${keysFromMembers(m).length} item(s).`);
  };
  const sourceZip = async () => {
    if (!source) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await retrieve(source.conn, pkg, {onProgress: s => setMsg(`Retrieving from ${source.name}… ${s}`)});
      downloadBytes(`${source.name.replace(/[^\w-]+/g, "_")}-source.zip`, writeZip(res.files));
      setMsg(`Downloaded ${res.files.size} file(s) from ${source.name}.` + (res.messages.length ? ` ${res.messages.length} note(s) from Salesforce.` : ""));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "📦", title: `Package · ${count} item(s)`},
        h("button", {className: "btn btn-secondary btn-sm", disabled: !count, onClick: () => downloadText("package.xml", buildPackageXml(pkg, apiVersion))}, "package.xml"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !delCount, onClick: () => downloadText("destructiveChanges.xml", buildPackageXml(destructive, apiVersion))}, "destructiveChanges.xml"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !count || busy || !source || source.isGit, onClick: sourceZip,
          title: source ? `Retrieve these from ${source.name} as a zip` : "Pick a source org in Compare or Deploy"}, busy ? "Retrieving…" : "Source zip")),
      h("div", {className: "sq3-card-sub"}, "The same package as Metadata → ＋ package.xml. Deploy it from the Deploy step."),
      h(MemberList, {members: pkg, onRemove: (t, m) => setPkg(removeMember(pkg, t, m))}),
      delCount > 0 && h("div", {className: "rel-label"}, `Delete in target · ${delCount}`),
      delCount > 0 && h(MemberList, {members: destructive, del: true, onRemove: (t, m) => setDestructive(removeMember(destructive, t, m))}),
      h("div", {className: "rel-label"}, "Add by name"),
      h("div", {className: "soql-save-row"},
        h(SearchSelect, {value: type, options: typeOptions(), onChange: setType, ariaLabel: "Metadata type", className: "rel-type"}),
        h("input", {className: "soql-save-input", placeholder: "Search or type API name(s), comma separated (Object.Field__c for fields)", value: name,
          onChange: e => setName(e.target.value), onKeyDown: e => { if (e.key === "Enter") add(); }, "aria-label": "Component API name"}),
        h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: toDelete, onChange: e => setToDelete(e.target.checked)}), " delete"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !name.trim(), onClick: add}, "Add")),
      source && !source.isGit && h("div", {className: "rel-found"},
        h("div", {className: "insp-meta"},
          found.busy ? `Looking up ${typeLabel(type)} in ${source.name}…`
            : found.err ? `Could not list ${typeLabel(type)} in ${source.name}: ${found.err}`
              : found.names ? `${typeLabel(type)} in ${source.name}: ${found.names.length} item${found.names.length === 1 ? "" : "s"}${term ? ` · ${matches.length} matching “${term}”` : ""}${matches.length ? `. Click to add${toDelete ? " as deletes" : ""}.` : ""}` : ""),
        matches.length > 0 && h("div", {className: "rel-found-list"},
          matches.slice(0, 60).map(n => h("button", {
            key: n, type: "button", disabled: inPkg(n),
            className: "insp-chip rel-chip" + (inPkg(n) ? " on" : "") + (toDelete ? " rel-chip-del" : ""),
            onClick: () => addNames([n])
          }, (inPkg(n) ? "✓ " : "＋ ") + n)),
          matches.length > 60 && h("span", {className: "insp-meta"}, `+${matches.length - 60} more · type to narrow`),
          matches.filter(n => !inPkg(n)).length > 1 && h("button", {className: "field-action-btn", onClick: () => addNames(matches.filter(n => !inPkg(n)))},
            `Add all ${matches.filter(n => !inPkg(n)).length}`))),
      h("details", {className: "rel-paste"},
        h("summary", null, "Paste a package.xml or destructiveChanges.xml"),
        h("textarea", {className: "soql-save-input rel-textarea", rows: 6, value: paste, onChange: e => setPaste(e.target.value),
          placeholder: "<Package>…</Package>", "aria-label": "package.xml text"}),
        h("div", {className: "soql-save-row"},
          h("button", {className: "btn btn-secondary btn-sm", disabled: !paste.trim(), onClick: () => load(false)}, "Add to package"),
          h("button", {className: "btn btn-secondary btn-sm", disabled: !paste.trim(), onClick: () => load(true)}, "Add as deletes"))),
      drafts.length > 0 && h("div", {className: "rel-label"}, `Drafts · ${drafts.length}`),
      drafts.length > 0 && h("div", {className: "insp-table-wrap"},
        h("table", {className: "insp-table rel-table"},
          h("tbody", null, drafts.map(d => h("tr", {key: d.id},
            h("td", {className: "rel-name"}, d.name),
            h("td", {className: "insp-meta"}, `${keysFromMembers(d.members || {}).length} item(s)` + (keysFromMembers(d.destructive || {}).length ? `, ${keysFromMembers(d.destructive).length} delete(s)` : "") + (d.sourceName ? ` · from ${d.sourceName}` : "")),
            h("td", {className: "insp-meta"}, fmtWhen(d.at)),
            h("td", {className: "rel-snap-actions"},
              h("button", {className: "field-action-btn", onClick: () => loadDraft(d)}, "Load"),
              h("button", {className: "field-action-btn", onClick: () => dropDraft(d)}, "Delete"))))))),
      err && h("div", {className: "insp-error"}, err),
      msg && h("div", {className: "insp-meta"}, msg),
      h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: !count && !delCount, onClick: () => { setPkg({}); setDestructive({}); }}, "Clear all"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !count && !delCount, onClick: saveDraft,
          title: "Save this package to reuse later; named after Deploy → Release name, if set"}, "Save as draft"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !count && !delCount, onClick: () => goTo("deploy")}, "Next: validate & deploy →"))));
}

export function ReleaseTab() {
  const [view, setView] = useFfSession("release", "view", "compare");
  const st = useRelease();
  // A deploy restored after minimize keeps being watched on any sub-tab.
  React.useEffect(() => {
    if (!st.orgs && !st.orgsBusy) loadOrgs();
    resumeDeploy();
  }, [st.orgs, st.deploy && st.deploy.id]);
  const cur = RELEASE_VIEWS.find(v => v.id === view) || RELEASE_VIEWS[0];
  // Deploy opens on what you came from: Compare → compare selection,
  // Package / Changes → package, History → the rollback / restore plan.
  const FROM = {compare: "compare", package: "package", changes: "package", history: "plan"};
  const goTo = id => {
    if (id === "deploy" && FROM[cur.id]) setRelease({deployFrom: {mode: FROM[cur.id], view: cur.id}});
    setView(id);
    const body = document.querySelector(".inspector-body");
    if (body) body.scrollTop = 0;
  };
  return h("div", {className: "insp-panel"},
    h("div", {className: "x-subnav rel-subnav", role: "tablist", "aria-label": "SandShift tools"},
      RELEASE_VIEWS.map(v => h("button", {
        key: v.id, role: "tab", "aria-selected": cur.id === v.id,
        className: "x-subnav-btn" + (cur.id === v.id ? " active" : ""),
        onClick: () => goTo(v.id)
      },
        h("span", {className: "x-subnav-ico", "aria-hidden": "true"}, v.icon),
        h("span", {className: "x-subnav-tx"},
          h("span", {className: "x-subnav-label"}, v.label),
          h("span", {className: "x-subnav-hint"}, v.hint))))),
    cur.id === "compare" ? h(CompareView, {goTo})
      : cur.id === "changes" ? h(ChangesView, {goTo})
        : cur.id === "package" ? h(PackageView, {goTo})
          : cur.id === "history" ? h(HistoryView, {goTo})
            : cur.id === "manual" ? h(ManualView, {goTo})
              : cur.id === "impact" ? h(ImpactView, {goTo})
            : h(DeployView, {goTo}));
}
