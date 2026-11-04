// Release Center → Compare: two orgs side by side, pick what to move.
import {
  presetTypes, compKey, splitKey, typeLabel, membersFromKeys, chunkMembers, componentsFromZip,
  classifyComponents, compareCounts, dependencyGaps, changesForPrompt, mergeMembers, mergeZipFiles
} from "../../core/deploy.js";
import {bytesToText} from "../../core/zip.js";
import {listComponents, retrieve, queryAll} from "../shared/deploy-api.js";
import {releaseNotesFromChanges} from "../shared/ai.js";
import {permissionHolders} from "../../core/analyzers.js";
import {putDraft} from "../shared/release-store.js";
import {useFfSession} from "../shared/session-state.js";
import {FFBadge} from "../shared/ui.js";
import {useRelease, setRelease, releaseState, orgByHost, orgLabel, fmtWhen, gitComponents, orgDayStart} from "./release-state.js";
import {OrgBar, PresetPicker, DiffView, CardHead, STATUS_BADGE, AiAnswer, AiError} from "./release-ui.js";

const h = React.createElement;
const PAGE = 300;

// Standard objects are huge and rarely moved whole; compare custom ones.
export function keepObject(key) {
  const {type, fullName} = splitKey(key);
  return type !== "CustomObject" || /__/.test(fullName);
}

// onStatus(text, percent): percent runs from `from` to `to` across the parts
// (Salesforce reports no counts while it retrieves, so each poll creeps on).
export async function retrieveAll(conn, keys, label, onStatus, {from = 0, to = 100} = {}) {
  const files = new Map();
  const problems = [];
  const parts = chunkMembers(membersFromKeys(keys));
  for (let i = 0; i < parts.length; i++) {
    const pct = polls => Math.round(from + (to - from) * ((i + Math.min(0.92, polls * 0.08)) / parts.length));
    let polls = 0;
    onStatus(`Retrieving ${keys.length.toLocaleString()} component(s) from ${label}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}…`, pct(0));
    const res = await retrieve(conn, parts[i], {onProgress: s => onStatus(`Retrieving from ${label}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}… ${s}`, pct(++polls))});
    mergeZipFiles(files, res.files, bytesToText);
    problems.push(...res.messages);
    onStatus(`Retrieved part ${i + 1} of ${parts.length} from ${label}`, Math.round(from + (to - from) * ((i + 1) / parts.length)));
  }
  return {files, problems};
}

// Apex / LWC / Flow references from MetadataComponentDependency (source org).
async function dependencyEdges(conn, rows) {
  const TYPES = ["ApexClass", "ApexTrigger", "ApexPage", "ApexComponent", "LightningComponentBundle", "AuraDefinitionBundle", "Flow"];
  const pick = rows.filter(r => r.status !== "deleted" && r.status !== "same" && TYPES.includes(r.type));
  const edges = [];
  const keys = new Set(rows.map(r => r.key));
  for (let i = 0; i < pick.length; i += 100) {
    const names = pick.slice(i, i + 100).map(r => "'" + r.fullName.replace(/'/g, "\\'") + "'").join(",");
    const recs = await queryAll(conn, "SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType " +
      `FROM MetadataComponentDependency WHERE MetadataComponentName IN (${names})`, {tooling: true});
    for (const d of recs) {
      const from = compKey(d.MetadataComponentType, d.MetadataComponentName);
      const to = compKey(d.RefMetadataComponentType, d.RefMetadataComponentName);
      if (keys.has(from) && keys.has(to) && from !== to) edges.push({from, to});
    }
  }
  return edges;
}

// A GitHub branch (source format) against an org.
async function compareFromGit(src, tgt, {presets, onStatus, only}) {
  onStatus(`Reading ${src.name}…`, 5);
  const comps = await gitComponents(src, t => onStatus(t, 15), {fresh: true});
  const types = only && only.length ? [...new Set(only.map(k => splitKey(k).type))] : presetTypes(presets);
  if (!types.length) throw new Error("Pick at least one kind of metadata.");
  const want = only && only.length ? new Set(only) : null;
  const srcKeys = [...comps.keys()].filter(k => types.includes(splitKey(k).type) && keepObject(k) && (!want || want.has(k)));
  onStatus(`Listing ${tgt.name}…`, 30);
  const tgtList = await listComponents(tgt.conn, types, {onProgress: (n, of) => onStatus(`Listing ${tgt.name}… ${n}/${of}`, 30 + Math.round(15 * n / of))});
  for (const k of [...tgtList.keys()]) if (!keepObject(k) || (want && !want.has(k))) tgtList.delete(k);
  const sourceComps = new Map(srcKeys.map(k => [k, comps.get(k)]));
  const common = srcKeys.filter(k => tgtList.has(k));
  const t = common.length ? await retrieveAll(tgt.conn, common, tgt.name, onStatus, {from: 45, to: 92}) : {files: new Map(), problems: []};
  onStatus("Comparing…", 95);
  const targetComps = componentsFromZip(t.files, bytesToText);
  for (const k of common) if (!targetComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  for (const k of tgtList.keys()) if (!targetComps.has(k) && !sourceComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  // Only compare what the branch holds plus target-only items of the same types.
  for (const k of [...targetComps.keys()]) if (!sourceComps.has(k) && !tgtList.has(k)) targetComps.delete(k);
  const info = Object.fromEntries([...tgtList.entries()].map(([k, v]) => [k, {by: v.lastModifiedByName, at: v.lastModifiedDate}]));
  const rows = classifyComponents(sourceComps, targetComps, {targetInfo: info});
  return {sourceHost: src.host, targetHost: tgt.host, rows, sourceComps, edges: [], at: new Date().toISOString(), problems: t.problems.filter(p => p.problem), since: ""};
}

export async function runCompare({presets, since, onStatus}) {
  const st = releaseState();
  const src = orgByHost(st.sourceHost);
  const tgt = orgByHost(st.targetHost);
  if (!src || !tgt) throw new Error("Pick a source and a target org.");
  const only = st.compareOnly;
  if (src.isGit) return compareFromGit(src, tgt, {presets, since, onStatus, only});
  let srcList;
  let tgtList;
  if (only && only.length) {
    const types = [...new Set(only.map(k => splitKey(k).type))];
    onStatus("Listing components in both orgs…", 5);
    [srcList, tgtList] = await Promise.all([listComponents(src.conn, types), listComponents(tgt.conn, types)]);
    const want = new Set(only);
    for (const k of [...srcList.keys()]) if (!want.has(k)) srcList.delete(k);
    for (const k of [...tgtList.keys()]) if (!want.has(k)) tgtList.delete(k);
  } else {
    const types = presetTypes(presets);
    if (!types.length) throw new Error("Pick at least one kind of metadata.");
    onStatus(`Listing ${types.length} metadata types in ${src.name}…`, 1);
    srcList = await listComponents(src.conn, types, {onProgress: (n, of) => onStatus(`Listing ${src.name}… ${n}/${of}`, Math.round(15 * n / of))});
    onStatus(`Listing ${types.length} metadata types in ${tgt.name}…`, 15);
    tgtList = await listComponents(tgt.conn, types, {onProgress: (n, of) => onStatus(`Listing ${tgt.name}… ${n}/${of}`, 15 + Math.round(15 * n / of))});
  }
  for (const list of [srcList, tgtList]) for (const k of [...list.keys()]) if (!keepObject(k)) list.delete(k);
  let srcKeys = [...srcList.keys()];
  if (since) {
    const t = orgDayStart(since);
    srcKeys = srcKeys.filter(k => {
      const d = srcList.get(k).lastModifiedDate;
      return d && new Date(d).getTime() >= t;
    });
  }
  const common = srcKeys.filter(k => tgtList.has(k));
  if (!srcKeys.length && !tgtList.size) throw new Error("Nothing found for the kinds you picked.");
  // Both orgs retrieve at the same time; progress weighs each by its size.
  const total = srcKeys.length + common.length || 1;
  const part = {s: 0, t: 0};
  const both = who => (text, pct) => {
    if (pct != null) part[who] = pct / 100;
    onStatus(text, Math.round(30 + 62 * ((part.s * srcKeys.length + part.t * common.length) / total)));
  };
  const [s, t] = await Promise.all([
    srcKeys.length ? retrieveAll(src.conn, srcKeys, src.name, both("s")) : {files: new Map(), problems: []},
    common.length ? retrieveAll(tgt.conn, common, tgt.name, both("t")) : {files: new Map(), problems: []}
  ]);
  onStatus("Comparing…", 94);
  const sourceComps = componentsFromZip(s.files, bytesToText);
  const targetComps = componentsFromZip(t.files, bytesToText);
  // Listed but not in a zip (e.g. empty folders): keep presence for status.
  for (const k of srcKeys) if (!sourceComps.has(k)) sourceComps.set(k, {...splitKey(k), files: {}, raw: {}});
  for (const k of common) if (!targetComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  if (!since) for (const k of tgtList.keys()) if (!targetComps.has(k) && !sourceComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  const info = list => Object.fromEntries([...list.entries()].map(([k, v]) => [k, {by: v.lastModifiedByName, at: v.lastModifiedDate}]));
  const rows = classifyComponents(sourceComps, targetComps, {sourceInfo: info(srcList), targetInfo: info(tgtList)});
  let edges = [];
  try {
    onStatus("Checking dependencies…", 97);
    edges = await dependencyEdges(src.conn, rows);
  } catch (e) { /* MetadataComponentDependency is optional */ }
  return {sourceHost: src.host, targetHost: tgt.host, rows, sourceComps, edges, at: new Date().toISOString(),
    problems: [...s.problems, ...t.problems].filter(p => p.problem), since: since || ""};
}

export function CompareView({goTo}) {
  const st = useRelease();
  const [presets, setPresets] = useFfSession("release", "presets", ["apex", "ui", "flows", "objects", "pages"]);
  const [since, setSince] = useFfSession("release", "since", "");
  const [filter, setFilter] = React.useState({new: true, changed: true, deleted: true, same: false});
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatusState] = React.useState({text: "", pct: null, started: 0});
  const setStatus = (text, pct) => setStatusState(prev => ({text, pct: pct == null ? prev.pct : Math.max(prev.pct || 0, pct), started: prev.started || Date.now()}));
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const [error, setError] = React.useState("");
  const [limit, setLimit] = React.useState(PAGE);
  const [notes, setNotes] = React.useState(null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState("");
  const [pkg, setPkg] = useFfSession("metadata", "pkg", {});
  const [added, setAdded] = React.useState("");
  const cmp = st.compare && st.compare.sourceHost === st.sourceHost && st.compare.targetHost === st.targetHost ? st.compare : null;

  const run = async () => {
    setBusy(true); setError(""); setNotes(null); setOpen(null); setLimit(PAGE);
    setStatusState({text: "Starting…", pct: 0, started: Date.now()});
    try {
      const result = await runCompare({presets, since, onStatus: setStatus});
      setRelease({compare: result, selected: new Set(), compareOnly: null});
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false); setStatusState({text: "", pct: null, started: 0});
    }
  };

  const rows = cmp ? cmp.rows : [];
  const counts = React.useMemo(() => compareCounts(rows), [rows]);
  const q = search.trim().toLowerCase();
  const shown = rows.filter(r => filter[r.status] && (!q || (r.fullName + " " + typeLabel(r.type)).toLowerCase().includes(q)));
  const sel = st.selected;
  const gaps = React.useMemo(() => cmp ? dependencyGaps(rows, sel, {edges: cmp.edges}) : [], [cmp, sel, rows]);
  const toggle = key => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    setRelease({selected: next});
  };
  const selectShown = on => {
    const next = new Set(sel);
    for (const r of shown) if (r.status !== "same") { if (on) next.add(r.key); else next.delete(r.key); }
    setRelease({selected: next});
  };
  const perms = React.useMemo(() => cmp ? permissionHolders(rows, sel) : [], [cmp, sel, rows]);
  const addPerms = () => {
    const next = new Set(sel);
    perms.forEach(k => next.add(k));
    setRelease({selected: next});
  };
  const [relName] = useFfSession("release", "relName", "");
  const saveDraft = async () => {
    const name = relName.trim() || `Draft ${`${new Date().toLocaleDateString(undefined, {day: "numeric", month: "short"})} ${new Date().toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}`}`;
    await putDraft({name: name.trim(), members: membersFromKeys(deploying.map(r => r.key)), destructive: membersFromKeys(deleting.map(r => r.key)),
      sourceName: orgByHost(cmp.sourceHost) ? orgByHost(cmp.sourceHost).name : cmp.sourceHost});
    setAdded(`Saved draft “${name.trim()}”. Load it from Package.`);
    setTimeout(() => setAdded(""), 3000);
  };
  const addMissing = () => {
    const next = new Set(sel);
    gaps.forEach(g => next.add(g.key));
    setRelease({selected: next});
  };
  const selRows = rows.filter(r => sel.has(r.key));
  const deploying = selRows.filter(r => r.status !== "deleted");
  const deleting = selRows.filter(r => r.status === "deleted");
  const allShownOn = shown.some(r => r.status !== "same") && shown.filter(r => r.status !== "same").every(r => sel.has(r.key));

  const addToPackage = () => {
    setPkg(mergeMembers(pkg, membersFromKeys(deploying.map(r => r.key))));
    setAdded(`${deploying.length} item(s) added to the package.`);
    setTimeout(() => setAdded(""), 2500);
  };
  const writeNotes = async () => {
    setAiBusy(true); setAiErr("");
    try {
      const text = await releaseNotesFromChanges(changesForPrompt(selRows.length ? selRows : rows.filter(r => r.status !== "same")),
        {source: orgLabel(orgByHost(cmp.sourceHost)), target: orgLabel(orgByHost(cmp.targetHost))});
      setNotes(text);
      setRelease({releaseNotes: text});
    } catch (e) {
      setAiErr(e.message || String(e));
    } finally {
      setAiBusy(false);
    }
  };

  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "⚖️", title: "Compare orgs"}),
      h("div", {className: "sq3-card-sub"},
        "Pick where changes come from and where they go. ⇄ swaps them for a reverse deployment (bring production fixes back to a sandbox)."),
      h(OrgBar, {disabled: busy}),
      st.compareOnly && st.compareOnly.length
        ? h("div", {className: "insp-hint-strip"}, `Comparing the ${st.compareOnly.length} component(s) picked in Changes. `,
          h("button", {className: "field-action-btn", onClick: () => setRelease({compareOnly: null})}, "Compare by kind instead"))
        : h(React.Fragment, null,
          h("div", {className: "rel-label"}, "What to compare"),
          h(PresetPicker, {value: presets, onChange: setPresets, disabled: busy})),
      h("div", {className: "soql-save-row rel-run-row"},
        h("label", {className: "rel-since"}, "Only changed since ",
          h("input", {type: "date", className: "soql-save-input", value: since, disabled: busy || !!(st.compareOnly && st.compareOnly.length) || st.sourceHost.startsWith("git:"),
            onChange: e => setSince(e.target.value), "aria-label": "Only components changed in the source since"})),
        since && h("button", {className: "field-action-btn", onClick: () => setSince("")}, "Any time"),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !st.sourceHost || !st.targetHost, onClick: run},
          busy ? "Comparing…" : cmp ? "Compare again" : "Compare")),
      busy && h("div", {className: "tr-progress"},
        status.pct == null
          ? h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"}))
          : h("div", {className: "limit-bar rel-cmp-bar", role: "progressbar", "aria-valuenow": status.pct, "aria-valuemin": 0, "aria-valuemax": 100},
            h("div", {className: "limit-fill rel-cmp-fill", style: {width: status.pct + "%"}})),
        h("span", {className: "insp-meta"}, (status.pct != null ? `${status.pct}% · ` : "") +
          `${Math.floor((Date.now() - (status.started || Date.now())) / 60000)}:${String(Math.floor((Date.now() - (status.started || Date.now())) / 1000) % 60).padStart(2, "0")} · ${status.text}`)),
      error && h("div", {className: "insp-error"}, error)),

    cmp && h("div", {className: "org-card org-card-wide", "data-release-results": ""},
      h(CardHead, {icon: "🔍", title: `Differences · ${orgByHost(cmp.sourceHost) ? orgByHost(cmp.sourceHost).name : cmp.sourceHost} → ${orgByHost(cmp.targetHost) ? orgByHost(cmp.targetHost).name : cmp.targetHost}`},
        h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy || !rows.length, onClick: writeNotes,
          title: "AI writes plain release notes from the selected changes (or all changes)"}, aiBusy ? "Writing…" : "✨ Release notes")),
      h("div", {className: "rel-filters"},
        ["new", "changed", "deleted", "same"].map(k => h("button", {
          key: k, type: "button", "aria-pressed": filter[k],
          className: "insp-chip rel-chip rel-st-" + k + (filter[k] ? " on" : ""),
          onClick: () => setFilter({...filter, [k]: !filter[k]})
        }, `${STATUS_BADGE[k].label} · ${counts[k]}`)),
        h("input", {className: "soql-save-input rel-search", placeholder: "Search name or type…", value: search,
          onChange: e => { setSearch(e.target.value); setLimit(PAGE); }, "aria-label": "Search differences"}),
        cmp.since && h("span", {className: "insp-meta"}, "Changed since " + cmp.since)),
      cmp.stale && h("div", {className: "insp-warn"}, "You deployed to the target since this compare, so these results are out of date. ",
        h("button", {className: "field-action-btn", disabled: busy, onClick: run}, "Compare again")),
      cmp.problems.length > 0 && h("details", {className: "insp-meta rel-problems"},
        h("summary", null, `${cmp.problems.length} retrieve note(s) from Salesforce`),
        cmp.problems.slice(0, 50).map((p, i) => h("div", {key: i}, `${p.fileName}: ${p.problem}`))),
      notes && h(AiAnswer, {title: "Release notes", text: notes, onClose: () => setNotes(null)}),
      h(AiError, {error: aiErr}),
      perms.length > 0 && h("div", {className: "insp-hint-strip rel-perms"},
        `${perms.length} permission set(s)/profile(s) grant access to what you picked: ${perms.slice(0, 4).map(k => splitKey(k).fullName).join(", ")}${perms.length > 4 ? "…" : ""}. `,
        h("button", {className: "field-action-btn", onClick: addPerms}, "Include them")),
      gaps.length > 0 && h("div", {className: "insp-warn rel-gaps"},
        h("div", null, h("b", null, `${gaps.length} thing(s) your selection needs are missing in the target and not selected:`)),
        h("ul", null, gaps.slice(0, 8).map(g => h("li", {key: g.key}, `${typeLabel(g.type)} ${g.fullName}`,
          h("span", {className: "insp-meta"}, " ← needed by " + g.neededBy.slice(0, 2).map(k => splitKey(k).fullName).join(", "))))),
        gaps.length > 8 && h("div", {className: "insp-meta"}, `…and ${gaps.length - 8} more`),
        h("button", {className: "btn btn-primary btn-sm", onClick: addMissing}, "Add missing")),
      shown.length === 0
        ? h("div", {className: "insp-meta"}, rows.length ? "Nothing matches the filters." : "No components found.")
        : h("div", {className: "insp-table-wrap rel-table-wrap"},
          h("table", {className: "insp-table rel-table"},
            h("thead", null, h("tr", null,
              h("th", {className: "rel-cb"}, h("input", {type: "checkbox", checked: allShownOn, onChange: e => selectShown(e.target.checked),
                "aria-label": "Select all shown"})),
              h("th", null, "Status"), h("th", null, "Type"), h("th", null, "Name"),
              h("th", null, "Changed in source"), h("th", null, "Changed in target"))),
            h("tbody", null, shown.slice(0, limit).map(r => [
              h("tr", {key: r.key, className: "rel-row" + (open === r.key ? " open" : "") + (sel.has(r.key) ? " sel" : ""),
                onClick: () => setOpen(open === r.key ? null : r.key)},
                h("td", {className: "rel-cb", onClick: e => e.stopPropagation()},
                  r.status !== "same" && h("input", {type: "checkbox", checked: sel.has(r.key), onChange: () => toggle(r.key),
                    "aria-label": (r.status === "deleted" ? "Delete in target: " : "Deploy ") + r.fullName})),
                h("td", null, h(FFBadge, {kind: STATUS_BADGE[r.status].kind}, STATUS_BADGE[r.status].label)),
                h("td", {className: "insp-meta"}, typeLabel(r.type)),
                h("td", {className: "rel-name"}, (open === r.key ? "▾ " : "▸ ") + r.fullName),
                h("td", {className: "insp-meta"}, r.source ? [r.source.by, fmtWhen(r.source.at)].filter(Boolean).join(" · ") : ""),
                h("td", {className: "insp-meta"}, r.target ? [r.target.by, fmtWhen(r.target.at)].filter(Boolean).join(" · ") : "")),
              open === r.key && h("tr", {key: r.key + ":diff", className: "rel-diff-row"},
                h("td", {colSpan: 6}, h(DiffView, {row: r})))
            ])))),
      shown.length > limit && h("button", {className: "btn btn-secondary btn-sm", onClick: () => setLimit(limit + PAGE)},
        `Show more (${shown.length - limit} left)`),
      h("div", {className: "rel-actionbar"},
        h("span", {className: "insp-meta"},
          `${deploying.length} to deploy` + (deleting.length ? ` · ${deleting.length} to delete in target` : "")),
        added && h("span", {className: "insp-status-ok"}, added),
        deleting.length === 1 && h("button", {className: "btn btn-secondary btn-sm", title: "What in the target still uses it?", onClick: () => {
          setRelease({impactTarget: {host: cmp.targetHost, type: deleting[0].type, fullName: deleting[0].fullName}});
          goTo("impact");
        }}, "Check impact of delete"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !sel.size, onClick: saveDraft, title: "Save this selection to reuse later (Package → Drafts)"}, "Save draft"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !deploying.length, onClick: addToPackage}, "Add to package"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !sel.size, onClick: () => setRelease({selected: new Set()})}, "Clear"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !sel.size, onClick: () => goTo("deploy")}, "Next: validate & deploy →"))));
}
