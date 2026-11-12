// Release Center → Compare: two orgs side by side, pick what to move.
import {
  presetTypes, compKey, splitKey, typeLabel, membersFromKeys, chunkMembers, componentsFromZip,
  classifyComponents, compareCounts, dependencyGaps, changesForPrompt, mergeMembers, mergeZipFiles, ALL_TYPES
} from "../../core/deploy.js";
import {SearchSelect} from "../shared/combo.js";
import {inRange, trustedDate} from "../../core/changes.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {detectSteps} from "../../core/manual-steps.js";
import {useStepsAsk} from "./release-steps-ask.js";
import {bytesToText} from "../../core/zip.js";
import {listComponents, retrieve, queryAll, loadCatalog} from "../shared/deploy-api.js";
import {releaseNotesFromChanges} from "../shared/ai.js";
import {permissionHolders} from "../../core/analyzers.js";
import {putDraft} from "../shared/release-store.js";
import {useFfSession} from "../shared/session-state.js";
import {FFBadge} from "../shared/ui.js";
import {useRelease, setRelease, releaseState, orgByHost, orgLabel, fmtWhen, gitComponents, orgDayStart, orgDaysAgo} from "./release-state.js";
import {OrgBar, DiffView, CardHead, STATUS_BADGE, TARGET_ACTION, TargetAction, AiAnswer, AiError, FilterPicker, findFilter, filterTypes, DateRange} from "./release-ui.js";

const h = React.createElement;
const PAGE = 300;

// Standard objects are huge and rarely moved whole; compare custom ones.
export function keepObject(key) {
  const {type, fullName} = splitKey(key);
  return type !== "CustomObject" || /__/.test(fullName);
}

// onStatus(text, percent): percent runs from `from` to `to` across the parts
// (Salesforce reports no counts while it retrieves, so each poll creeps on).
export async function retrieveAll(conn, keys, label, onStatus, {from = 0, to = 100, signal} = {}) {
  const files = new Map();
  const problems = [];
  const parts = chunkMembers(membersFromKeys(keys));
  for (let i = 0; i < parts.length; i++) {
    const pct = polls => Math.round(from + (to - from) * ((i + Math.min(0.92, polls * 0.08)) / parts.length));
    let polls = 0;
    onStatus(`Retrieving ${keys.length.toLocaleString()} component(s) from ${label}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}…`, pct(0));
    const res = await retrieve(conn, parts[i], {signal, onProgress: s => onStatus(`Retrieving from ${label}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}… ${s}`, pct(++polls))});
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
async function compareFromGit(src, tgt, {presets, onStatus, only, signal}) {
  onStatus(`Reading ${src.name}…`, 5);
  const comps = await gitComponents(src, t => onStatus(t, 15), {fresh: true});
  const types = only && only.length ? [...new Set(only.map(k => splitKey(k).type))] : presetTypes(presets);
  if (!types.length) throw new Error("Pick at least one kind of metadata.");
  const want = only && only.length ? new Set(only) : null;
  const srcKeys = [...comps.keys()].filter(k => types.includes(splitKey(k).type) && keepObject(k) && (!want || want.has(k)));
  onStatus(`Listing ${tgt.name}…`, 30);
  const tgtList = await listComponents(tgt.conn, types, {signal, onProgress: (n, of) => onStatus(`Listing ${tgt.name}… ${n}/${of}`, 30 + Math.round(15 * n / of))});
  for (const k of [...tgtList.keys()]) if (!keepObject(k) || (want && !want.has(k))) tgtList.delete(k);
  const sourceComps = new Map(srcKeys.map(k => [k, comps.get(k)]));
  const common = srcKeys.filter(k => tgtList.has(k));
  const t = common.length ? await retrieveAll(tgt.conn, common, tgt.name, onStatus, {from: 45, to: 92, signal}) : {files: new Map(), problems: []};
  onStatus("Comparing…", 95);
  const targetComps = componentsFromZip(t.files, bytesToText);
  for (const k of common) if (!targetComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  for (const k of tgtList.keys()) if (!targetComps.has(k) && !sourceComps.has(k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  // Only compare what the branch holds plus target-only items of the same types.
  for (const k of [...targetComps.keys()]) if (!sourceComps.has(k) && !tgtList.has(k)) targetComps.delete(k);
  const info = Object.fromEntries([...tgtList.entries()].map(([k, v]) => [k, {by: v.lastModifiedByName, at: v.lastModifiedDate}]));
  const rows = classifyComponents(sourceComps, targetComps, {targetInfo: info});
  return {sourceHost: src.host, targetHost: tgt.host, rows, sourceComps, edges: [], at: new Date().toISOString(), problems: t.problems.filter(p => p.problem), since: "",
    skipped: {source: [], target: tgtList.skipped || []},
    git: {truncated: !!comps.truncated, dropped: comps.skipped || [], ignored: comps.ignored || 0}};
}

// from / to: "YYYY-MM-DD" in the org's zone ("" = open). Items changed in the
// source in that range are compared; items without a usable date stay in.
export async function runCompare({presets = [ALL_TYPES], from = "", to = "", since = "", onStatus, signal}) {
  from = from || since;
  const ranged = !!(from || to);
  const st = releaseState();
  const src = orgByHost(st.sourceHost);
  const tgt = orgByHost(st.targetHost);
  if (!src || !tgt) throw new Error("Pick a source and a target org.");
  const only = st.compareOnly;
  if (src.isGit) return compareFromGit(src, tgt, {presets, onStatus, only, signal});
  await Promise.all([loadCatalog(src.conn), loadCatalog(tgt.conn)]);
  let srcList;
  let tgtList;
  if (only && only.length) {
    const types = [...new Set(only.map(k => splitKey(k).type))];
    onStatus("Listing components in both orgs…", 5);
    [srcList, tgtList] = await Promise.all([listComponents(src.conn, types, {signal}), listComponents(tgt.conn, types, {signal})]);
    const want = new Set(only);
    for (const k of [...srcList.keys()]) if (!want.has(k)) srcList.delete(k);
    for (const k of [...tgtList.keys()]) if (!want.has(k)) tgtList.delete(k);
  } else {
    const types = presetTypes(presets);
    if (!types.length) throw new Error("Pick at least one kind of metadata.");
    onStatus(`Listing ${types.length} metadata types in ${src.name}…`, 1);
    srcList = await listComponents(src.conn, types, {signal, onProgress: (n, of) => onStatus(`Listing ${src.name}… ${n}/${of}`, Math.round(15 * n / of))});
    onStatus(`Listing ${types.length} metadata types in ${tgt.name}…`, 15);
    tgtList = await listComponents(tgt.conn, types, {signal, onProgress: (n, of) => onStatus(`Listing ${tgt.name}… ${n}/${of}`, 15 + Math.round(15 * n / of))});
  }
  for (const list of [srcList, tgtList]) for (const k of [...list.keys()]) if (!keepObject(k)) list.delete(k);
  let srcKeys = [...srcList.keys()];
  if (ranged) {
    const fromMs = from ? orgDayStart(from) : 0;
    const toMs = to ? orgDayStart(to) + 864e5 : 0;
    srcKeys = srcKeys.filter(k => inRange(srcList.get(k).lastModifiedDate, fromMs, toMs));
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
    srcKeys.length ? retrieveAll(src.conn, srcKeys, src.name, both("s"), {signal}) : {files: new Map(), problems: []},
    common.length ? retrieveAll(tgt.conn, common, tgt.name, both("t"), {signal}) : {files: new Map(), problems: []}
  ]);
  onStatus("Comparing…", 94);
  const sourceComps = componentsFromZip(s.files, bytesToText);
  const targetComps = componentsFromZip(t.files, bytesToText);
  // Listed but not in a zip (e.g. empty folders): keep presence for status.
  // (Settings are assumed, not listed: only what a retrieve returned exists.)
  const real = (list, k) => !(list.get(k) || {}).synthetic;
  for (const k of srcKeys) if (!sourceComps.has(k) && real(srcList, k)) sourceComps.set(k, {...splitKey(k), files: {}, raw: {}});
  for (const k of common) if (!targetComps.has(k) && real(tgtList, k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  if (!ranged) for (const k of tgtList.keys()) if (!targetComps.has(k) && !sourceComps.has(k) && real(tgtList, k)) targetComps.set(k, {...splitKey(k), files: {}, raw: {}});
  const info = list => Object.fromEntries([...list.entries()].map(([k, v]) => [k, {by: v.lastModifiedByName, at: v.lastModifiedDate}]));
  const rows = classifyComponents(sourceComps, targetComps, {sourceInfo: info(srcList), targetInfo: info(tgtList)});
  let edges = [];
  if (signal && signal.aborted) throw new Error("Cancelled");
  try {
    onStatus("Checking dependencies…", 97);
    edges = await dependencyEdges(src.conn, rows);
  } catch (e) { /* MetadataComponentDependency is optional */ }
  return {sourceHost: src.host, targetHost: tgt.host, rows, sourceComps, edges, at: new Date().toISOString(),
    problems: [...s.problems, ...t.problems].filter(p => p.problem), from, to, since: from || "",
    skipped: {source: srcList.skipped || [], target: tgtList.skipped || []}};
}

// One compare at a time, surviving a switch to another sub-tab: progress is in
// the shared release state (not persisted) and Cancel aborts the calls. A run
// that was cancelled or replaced never writes its result.
let activeCompare = null;

export function cancelCompare() {
  if (!activeCompare) return;
  activeCompare.ctrl.abort();
  activeCompare = null;
  setRelease({comparing: null, compareError: "Compare cancelled. Nothing changed."});
}

// Types an org refused to list (not enabled, no access): compared as absent.
export function SkippedTypes({skipped, sourceHost, targetHost}) {
  if (!skipped) return null;
  const name = host => (orgByHost(host) || {}).name || host;
  const parts = [[sourceHost, skipped.source || []], [targetHost, skipped.target || []]].filter(([, list]) => list.length);
  if (!parts.length) return null;
  return h("div", {className: "insp-warn rel-skipped"},
    h("b", null, "These types could not be listed and were skipped: "),
    parts.map(([host, list]) => `${name(host)}: ${list.map(typeLabel).join(", ")}`).join(" · "),
    ". Items of these types are not in this compare.");
}

// What a Git branch read left out: a cut-short listing, object subfolders that
// aren't metadata SaralForce knows, and files .forceignore excludes.
export function GitNotes({git}) {
  if (!git) return null;
  return h(React.Fragment, null,
    git.truncated && h("div", {className: "insp-warn"}, h("b", null, "The branch listing is incomplete: "),
      "GitHub cut the file list short (the repository is very large), so some files are missing from this compare. Point the GitHub folder in Settings at a smaller part of the repository."),
    git.dropped && git.dropped.length > 0 && h("details", {className: "insp-meta rel-problems"},
      h("summary", null, `${git.dropped.length} file(s) under objects/ were left out (not a known object part)`),
      git.dropped.slice(0, 50).map(p => h("div", {key: p}, p))),
    git.ignored > 0 && h("div", {className: "insp-meta"}, `${git.ignored} file(s) left out by .forceignore.`));
}

export function CompareView({goTo}) {
  const st = useRelease();
  // "Compare all" by default (a deploy needs the full picture); narrow it with
  // a comparison filter, a date range, or the filters under Differences.
  const [filterId, setFilterId] = useFfSession("release", "cmpFilter", "all");
  const filter = findFilter(filterId);
  const [from, setFrom] = useFfSession("release", "since", "");
  const [to, setTo] = useFfSession("release", "until", "");
  const [sortSrc, setSortSrc] = React.useState(false);
  const [tab, setTab] = React.useState("diff");
  const [typeFilter, setTypeFilter] = React.useState("");
  const [byFilter, setByFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState(null);
  const busy = !!st.comparing;
  const status = st.comparing || {text: "", pct: null, started: 0};
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const error = st.compareError || "";
  const [limit, setLimit] = React.useState(PAGE);
  const [notes, setNotes] = React.useState(null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState("");
  const [pkg, setPkg] = useFfSession("metadata", "pkg", {});
  const [added, setAdded] = React.useState("");
  const cmp = st.compare && st.compare.sourceHost === st.sourceHost && st.compare.targetHost === st.targetHost ? st.compare : null;
  const {askSteps, dialog: stepsDialog} = useStepsAsk();

  const run = async () => {
    if (activeCompare) return;
    const me = {ctrl: new AbortController()};
    activeCompare = me;
    setNotes(null); setOpen(null); setLimit(PAGE);
    setRelease({comparing: {text: "Starting…", pct: 0, started: Date.now()}, compareError: ""});
    const onStatus = (text, pct) => {
      if (activeCompare !== me) return;
      setRelease(prev => prev.comparing ? {comparing: {...prev.comparing, text, pct: pct == null ? prev.comparing.pct : Math.max(prev.comparing.pct || 0, pct)}} : {});
    };
    try {
      const result = await runCompare({presets: filter.presets, from, to, onStatus, signal: me.ctrl.signal});
      if (activeCompare !== me) return;
      result.filterLabel = `${filter.label} (${filterTypes(filter).length} types)`;
      setRelease({compare: result, selected: new Set(), compareOnly: null});
    } catch (e) {
      if (activeCompare === me) setRelease({compareError: e.message || String(e)});
    } finally {
      if (activeCompare === me) { activeCompare = null; setRelease({comparing: null}); }
    }
  };

  const rows = cmp ? cmp.rows : [];
  const counts = React.useMemo(() => compareCounts(rows), [rows]);
  const q = search.trim().toLowerCase();
  const inTab = r => tab === "diff" ? r.status !== "same" : r.status === tab;
  const byOf = r => [r.source && r.source.by, r.target && r.target.by].filter(Boolean);
  const srcAt = r => trustedDate(r.source && r.source.at) || 0;
  const filtered = rows.filter(r => inTab(r) && (!typeFilter || r.type === typeFilter) && (!byFilter || byOf(r).includes(byFilter)) &&
    (!q || (r.fullName + " " + (r.label || "") + " " + typeLabel(r.type)).toLowerCase().includes(q)));
  const shown = sortSrc ? filtered.slice().sort((a, b) => srcAt(b) - srcAt(a)) : filtered;
  const exportCsv = () => {
    const cols = ["Status", "In target", "Type", "Name", "Label", "Changed in source", "Changed by (source)", "Changed in target", "Changed by (target)"];
    const out = shown.map(r => ({
      "Status": STATUS_BADGE[r.status].label,
      "In target": (TARGET_ACTION[r.status] || TARGET_ACTION.same)[sel.has(r.key) ? "on" : "off"].replace(/^[^A-Za-z]+/, ""),
      "Type": typeLabel(r.type), "Name": r.fullName, "Label": r.label || "",
      "Changed in source": r.source && r.source.at || "", "Changed by (source)": r.source && r.source.by || "",
      "Changed in target": r.target && r.target.at || "", "Changed by (target)": r.target && r.target.by || ""
    }));
    downloadText(`compare-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(cols, out));
  };
  const typeCounts = React.useMemo(() => {
    const m = new Map();
    for (const r of rows) if (inTab(r)) m.set(r.type, (m.get(r.type) || 0) + 1);
    return [...m.entries()].sort((a, b) => typeLabel(a[0]).localeCompare(typeLabel(b[0])));
  }, [rows, tab]);
  const people = React.useMemo(() => [...new Set(rows.flatMap(byOf))].sort(), [rows]);
  const sel = st.selected;
  const gaps = React.useMemo(() => cmp ? dependencyGaps(rows, sel, {edges: cmp.edges}) : [], [cmp, sel, rows]);
  const toggle = key => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    setRelease({selected: next});
  };
  const selectShown = on => {
    const next = new Set(sel);
    // "Select all" never queues deletes from the mixed view: target-only rows
    // are ticked one by one, or all at once from the "Only in target" tab.
    for (const r of shown) {
      if (r.status === "same") continue;
      if (!on) next.delete(r.key);
      else if (r.status !== "deleted" || tab === "deleted") next.add(r.key);
    }
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
  const bulkPick = shown.filter(r => r.status !== "same" && (r.status !== "deleted" || tab === "deleted"));
  const allShownOn = bulkPick.length > 0 && bulkPick.every(r => sel.has(r.key));

  // Ask for the hand steps here, once per selection (Deploy then won't ask again).
  const nextToDeploy = async () => {
    const keys = deploying.map(r => r.key);
    const deletes = deleting.map(r => r.key);
    const detected = detectSteps({items: keys, deletes, texts: new Map(deploying.map(r => [r.key, r.sourceText])), before: new Map()});
    if (await askSteps({keys, deletes, detected, verb: "continue"})) goTo("deploy");
  };

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
          h("button", {className: "field-action-btn", onClick: () => setRelease({compareOnly: null})}, "Compare everything instead"))
        : h(FilterPicker, {value: filter.id, onChange: setFilterId, disabled: busy}),
      h("div", {className: "soql-save-row rel-run-row"},
        h(DateRange, {from, to, disabled: busy || !!(st.compareOnly && st.compareOnly.length) || st.sourceHost.startsWith("git:"),
          onChange: (f, t) => { setFrom(f); setTo(t); },
          picks: [{id: "all", label: "All time", from: "", to: ""}, {id: "0", label: "Today", from: orgDaysAgo(0), to: ""},
            {id: "7", label: "7 days", from: orgDaysAgo(7), to: ""}, {id: "30", label: "30 days", from: orgDaysAgo(30), to: ""}]}),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !st.sourceHost || !st.targetHost, onClick: run},
          busy ? "Comparing…" : cmp ? "Compare again" : "Compare"),
        busy && h("button", {className: "btn btn-secondary btn-sm", onClick: cancelCompare, title: "Stop this compare; nothing changes in either org"}, "Cancel")),
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
          title: "AI writes plain release notes from the selected changes (or all changes). Sent to your AI provider: each component's name and type, up to 15 added and 15 removed lines (or the first 600 characters of a new one). Credentials-type metadata (named credentials, connected apps, certificates…) is never sent."}, aiBusy ? "Writing…" : "✨ Release notes"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !shown.length, onClick: exportCsv, title: "Download what's shown as a CSV"}, "⬇ Export results")),
      h("div", {className: "rel-filters"},
        h("div", {className: "rel-tabs", role: "tablist", "aria-label": "Difference type"},
          [["diff", "All differences", counts.new + counts.changed + counts.deleted], ...["new", "changed", "deleted", "same"].map(k => [k, k === "same" ? "No difference" : STATUS_BADGE[k].label, counts[k]])]
            .map(([k, label, n]) => h("button", {
              key: k, type: "button", role: "tab", "aria-selected": tab === k,
              className: "insp-chip rel-chip rel-st-" + k + (tab === k ? " on" : ""),
              onClick: () => { setTab(k); setLimit(PAGE); }
            }, `${label} · ${n}`))),
        h(SearchSelect, {value: typeFilter, className: "rel-type", ariaLabel: "Metadata type",
          options: [{value: "", label: "All metadata types"}, ...typeCounts.map(([t, n]) => ({value: t, label: `${typeLabel(t)} (${n})`}))],
          onChange: v => { setTypeFilter(v); setLimit(PAGE); }}),
        people.length > 0 && h(SearchSelect, {value: byFilter, className: "rel-by", ariaLabel: "Changed by",
          options: [{value: "", label: "Changed by anyone"}, ...people.map(p => ({value: p, label: p}))],
          onChange: v => { setByFilter(v); setLimit(PAGE); }}),
        h("input", {className: "soql-save-input rel-search", placeholder: "Search name or type…", value: search,
          onChange: e => { setSearch(e.target.value); setLimit(PAGE); }, "aria-label": "Search differences"}),
        h("span", {className: "insp-meta"}, [cmp.filterLabel, cmp.from || cmp.to ? `changed ${cmp.from ? "from " + cmp.from : ""}${cmp.to ? " to " + cmp.to : ""}` : ""].filter(Boolean).join(" · "))),
      cmp.stale && h("div", {className: "insp-warn"}, "You deployed to the target since this compare, so these results are out of date. ",
        h("button", {className: "field-action-btn", disabled: busy, onClick: run}, "Compare again")),
      h(SkippedTypes, {skipped: cmp.skipped, sourceHost: cmp.sourceHost, targetHost: cmp.targetHost}),
      h(GitNotes, {git: cmp.git}),
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
              h("th", null, "Status"), h("th", {title: "What a deploy does to it in the target"}, "In target"), h("th", null, "Type"), h("th", null, "Name"),
              h("th", {className: "rel-sort" + (sortSrc ? " on" : ""), onClick: () => setSortSrc(!sortSrc), title: "Sort by date changed in the source",
                "aria-sort": sortSrc ? "descending" : "none"}, "Changed in source " + (sortSrc ? "↓" : "⇅")),
              h("th", null, "Changed in target"))),
            h("tbody", null, shown.slice(0, limit).map(r => [
              h("tr", {key: r.key, className: "rel-row" + (open === r.key ? " open" : "") + (sel.has(r.key) ? " sel" : ""),
                onClick: () => setOpen(open === r.key ? null : r.key)},
                h("td", {className: "rel-cb", onClick: e => e.stopPropagation()},
                  r.status !== "same" && h("input", {type: "checkbox", checked: sel.has(r.key), onChange: () => toggle(r.key),
                    "aria-label": (r.status === "deleted" ? "Delete in target: " : "Deploy ") + r.fullName})),
                h("td", null, h(FFBadge, {kind: STATUS_BADGE[r.status].kind}, STATUS_BADGE[r.status].label)),
                h("td", null, h(TargetAction, {status: r.status, selected: sel.has(r.key)})),
                h("td", {className: "insp-meta"}, typeLabel(r.type)),
                h("td", {className: "rel-name", title: r.label ? `Label in Setup: ${r.label} · API name: ${r.fullName}` : undefined},
                  (open === r.key ? "▾ " : "▸ ") + r.fullName,
                  r.label && h("span", {className: "rel-setup-label"}, r.label)),
                h("td", {className: "insp-meta"}, r.source ? [r.source.by, fmtWhen(r.source.at)].filter(Boolean).join(" · ") : ""),
                h("td", {className: "insp-meta"}, r.target ? [r.target.by, fmtWhen(r.target.at)].filter(Boolean).join(" · ") : "")),
              open === r.key && h("tr", {key: r.key + ":diff", className: "rel-diff-row"},
                h("td", {colSpan: 7}, h(DiffView, {row: r})))
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
        h("button", {className: "btn btn-primary btn-sm", disabled: !sel.size, onClick: nextToDeploy}, "Next: validate & deploy →"))),
    stepsDialog);
}
