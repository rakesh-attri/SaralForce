// Release Center: compare orgs, track changes, build a package, validate
// and deploy (forward or reverse) to any org you're logged into.
import {
  presetTypes, typeLabel, membersFromKeys, keysFromMembers, mergeMembers, parsePackageXml, compKey,
  METADATA_TYPES
} from "../../core/deploy.js";
import {buildPackageXml, packageCount} from "../../core/metadata.js";
import {writeZip} from "../../core/zip.js";
import {apiVersion} from "../../inspector.js";
import {listComponents, retrieve, queryAll} from "../shared/deploy-api.js";
import {downloadText} from "../shared/csv.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {useRelease, setRelease, orgByHost, loadOrgs, fmtWhen, downloadBytes} from "./release-state.js";
import {CardHead, PresetPicker, orgOptions, OrgTag} from "./release-ui.js";
import {CompareView} from "./release-compare.js";
import {DeployView} from "./release-deploy.js";
import {HistoryView} from "./release-history.js";
import {ManualView} from "./release-manual.js";
import {ImpactView} from "./release-impact.js";
import {listReleases} from "../shared/release-store.js";
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

function daysAgoIso(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── Changes: what changed in one org since a date ─────────────────────
function ChangesView({goTo}) {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [host, setHost] = useFfSession("release", "changesHost", "");
  const [presets, setPresets] = useFfSession("release", "changesPresets", ["apex", "ui", "flows", "objects", "pages", "security", "config"]);
  const [since, setSince] = useFfSession("release", "changesSince", daysAgoIso(7));
  const [by, setBy] = React.useState("");
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
      const types = presetTypes(presets);
      if (!types.length) throw new Error("Pick at least one kind of metadata.");
      const t = new Date(since || daysAgoIso(7)).getTime();
      const list = await listComponents(org.conn, types, {onProgress: (n, of) => setStatus(`Listing ${org.name}… ${n}/${of}`)});
      const found = [...list.values()].filter(r => r.lastModifiedDate && new Date(r.lastModifiedDate).getTime() >= t)
        .map(r => ({...r, key: compKey(r.type, r.fullName)}))
        .sort((a, b) => String(b.lastModifiedDate).localeCompare(String(a.lastModifiedDate)));
      setRows(found);
      setStatus("Reading the Setup audit trail…");
      try {
        const recs = await queryAll(org.conn, "SELECT CreatedDate, CreatedBy.Name, Display, Section FROM SetupAuditTrail " +
          `WHERE CreatedDate >= ${new Date(t).toISOString()} ORDER BY CreatedDate DESC LIMIT 500`);
        setAudit(recs);
      } catch (e) { setAudit([]); }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false); setStatus("");
    }
  };

  const people = rows ? [...new Set(rows.map(r => r.lastModifiedByName).filter(Boolean))].sort() : [];
  const q = search.trim().toLowerCase();
  const shown = (rows || []).filter(r => (!by || r.lastModifiedByName === by) &&
    (!q || (r.fullName + " " + typeLabel(r.type)).toLowerCase().includes(q)));
  const toggle = key => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSel(next);
  };
  const allOn = shown.length > 0 && shown.every(r => sel.has(r.key));
  const picked = (rows || []).filter(r => sel.has(r.key));
  const flash = text => { setNote(text); setTimeout(() => setNote(""), 2500); };

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🕘", title: "What changed?"}),
      h("div", {className: "sq3-card-sub"}, "Every component changed in an org since a date, newest first. Pick what belongs in your release."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Org"),
          h(SearchSelect, {value: org ? org.host : "", options: orgOptions(orgs), onChange: setHost, disabled: busy,
            ariaLabel: "Org to check", placeholder: st.orgsBusy ? "Finding your orgs…" : "Pick an org"}),
          h(OrgTag, {org})),
        h("button", {className: "btn btn-secondary btn-sm", disabled: st.orgsBusy, onClick: () => loadOrgs(true), title: "Look again for orgs"}, st.orgsBusy ? "…" : "↻")),
      h("div", {className: "rel-label"}, "What to look at"),
      h(PresetPicker, {value: presets, onChange: setPresets, disabled: busy}),
      h("div", {className: "soql-save-row rel-run-row"},
        h("span", {className: "rel-org-l"}, "Changed since"),
        SINCE_PICKS.map(p => h("button", {key: p.id, type: "button", disabled: busy,
          className: "insp-chip rel-chip" + (since === daysAgoIso(p.days) ? " on" : ""),
          onClick: () => setSince(daysAgoIso(p.days))}, p.label)),
        lastAt && h("button", {type: "button", disabled: busy, title: "Since the last release deployed from this org",
          className: "insp-chip rel-chip" + (since === lastAt.slice(0, 10) ? " on" : ""),
          onClick: () => setSince(lastAt.slice(0, 10))}, "Last release"),
        h("input", {type: "date", className: "soql-save-input", value: since, disabled: busy,
          onChange: e => setSince(e.target.value), "aria-label": "Changed since"}),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !org, onClick: run}, busy ? "Looking…" : "Find changes")),
      busy && h("div", {className: "tr-progress"},
        h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      error && h("div", {className: "insp-error"}, error)),

    rows && h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "📋", title: `${rows.length} changed component(s) in ${org ? org.name : ""}`}),
      h("div", {className: "rel-filters"},
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
                  shown.forEach(r => { if (e.target.checked) next.add(r.key); else next.delete(r.key); });
                  setSel(next);
                }})),
              h("th", null, "Type"), h("th", null, "Name"), h("th", null, "Changed by"), h("th", null, "When"))),
            h("tbody", null, shown.slice(0, 1000).map(r => h("tr", {key: r.key, className: "rel-row" + (sel.has(r.key) ? " sel" : ""), onClick: () => toggle(r.key)},
              h("td", {className: "rel-cb", onClick: e => e.stopPropagation()},
                h("input", {type: "checkbox", checked: sel.has(r.key), onChange: () => toggle(r.key), "aria-label": "Pick " + r.fullName})),
              h("td", {className: "insp-meta"}, typeLabel(r.type)),
              h("td", {className: "rel-name"}, r.fullName),
              h("td", null, r.lastModifiedByName),
              h("td", {className: "insp-meta"}, fmtWhen(r.lastModifiedDate))))))),
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
          setPkg(mergeMembers(pkg, membersFromKeys(picked.map(r => r.key))));
          flash(`${picked.length} item(s) added to the package.`);
        }}, "Add to package"),
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

const TYPE_OPTIONS = METADATA_TYPES.filter(t => !t.hidden).map(t => ({value: t.name, label: t.label, sub: t.name}))
  .sort((a, b) => a.label.localeCompare(b.label));

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
  const count = packageCount(pkg);
  const delCount = keysFromMembers(destructive).length;

  const add = () => {
    const n = name.trim();
    if (!n) return;
    const m = {[type]: n.split(/\s*,\s*/).filter(Boolean)};
    if (toDelete) setDestructive(mergeMembers(destructive, m)); else setPkg(mergeMembers(pkg, m));
    setName("");
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
        h(SearchSelect, {value: type, options: TYPE_OPTIONS, onChange: setType, ariaLabel: "Metadata type", className: "rel-type"}),
        h("input", {className: "soql-save-input", placeholder: "API name(s), comma separated (Object.Field__c for fields)", value: name,
          onChange: e => setName(e.target.value), onKeyDown: e => { if (e.key === "Enter") add(); }, "aria-label": "Component API name"}),
        h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: toDelete, onChange: e => setToDelete(e.target.checked)}), " delete"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !name.trim(), onClick: add}, "Add")),
      h("details", {className: "rel-paste"},
        h("summary", null, "Paste a package.xml or destructiveChanges.xml"),
        h("textarea", {className: "soql-save-input rel-textarea", rows: 6, value: paste, onChange: e => setPaste(e.target.value),
          placeholder: "<Package>…</Package>", "aria-label": "package.xml text"}),
        h("div", {className: "soql-save-row"},
          h("button", {className: "btn btn-secondary btn-sm", disabled: !paste.trim(), onClick: () => load(false)}, "Add to package"),
          h("button", {className: "btn btn-secondary btn-sm", disabled: !paste.trim(), onClick: () => load(true)}, "Add as deletes"))),
      err && h("div", {className: "insp-error"}, err),
      msg && h("div", {className: "insp-meta"}, msg),
      h("div", {className: "rel-actionbar"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: !count && !delCount, onClick: () => { setPkg({}); setDestructive({}); }}, "Clear all"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !count && !delCount, onClick: () => goTo("deploy")}, "Next: validate & deploy →"))));
}

export function ReleaseTab() {
  const [view, setView] = useFfSession("release", "view", "compare");
  const cur = RELEASE_VIEWS.find(v => v.id === view) || RELEASE_VIEWS[0];
  const goTo = id => {
    setView(id);
    const body = document.querySelector(".inspector-body");
    if (body) body.scrollTop = 0;
  };
  return h("div", {className: "insp-panel"},
    h("div", {className: "x-subnav rel-subnav", role: "tablist", "aria-label": "Release tools"},
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
