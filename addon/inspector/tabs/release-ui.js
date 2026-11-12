// Release Center building blocks: org pickers, type presets, diff view.
import {SearchSelect} from "../shared/combo.js";
import {TYPE_PRESETS, TYPE_PICK, TYPE_BY_NAME, ALL_TYPES, allTypes, otherTypes, typeLabel, presetTypes} from "../../core/deploy.js";
import {diffLines, diffStats, sideBySide} from "../../core/text-diff.js";
import {useRelease, setRelease, loadOrgs, orgByHost, setGitBranch} from "./release-state.js";
import {listBranches} from "../shared/github.js";

const h = React.createElement;

export function openSettings() {
  try { chrome.runtime.sendMessage({message: "openOptions", host: ""}); } catch (e) { /* extension only */ }
}

export function CardHead({icon, title, children}) {
  return h("div", {className: "org-card-h"},
    h("span", {className: "org-card-ico", "aria-hidden": "true"}, icon),
    h("span", {className: "org-card-t"}, title),
    children && h("div", {className: "audit-actions"}, children));
}

export function orgOptions(orgs, exclude, {git = false} = {}) {
  return (orgs || []).filter(o => o.host !== exclude && (git || !o.isGit)).map(o => ({
    value: o.host,
    label: o.name + (o.isCurrent ? " · this org" : ""),
    sub: o.host,
    tag: o.isGit ? "Git" : o.isSandbox ? "Sandbox" : "Production",
    tagTone: o.isGit ? "violet" : o.isSandbox ? "ok" : "warn"
  }));
}

// Shown under an org picker: what kind of org it is, and its address.
export function OrgTag({org}) {
  if (!org) return null;
  const kind = org.isGit ? "git" : org.isSandbox ? "sandbox" : "prod";
  const label = {git: "GitHub branch", sandbox: "Sandbox", prod: "Production"}[kind];
  const icon = {git: "🐙", sandbox: "🧪", prod: "🏭"}[kind];
  return h("div", {className: "rel-orgtag rel-orgtag-" + kind, title: org.host},
    h("span", {className: "rel-orgtag-k"}, h("span", {"aria-hidden": "true"}, icon), " ", label),
    h("span", {className: "rel-orgtag-h"}, org.isGit ? org.host.replace(/^git:/, "") : org.host),
    org.isCurrent && h("span", {className: "rel-orgtag-me"}, "this org"));
}

// Branch of the GitHub source (lists the repository's branches).
function BranchPicker({org, disabled}) {
  const [branches, setBranches] = React.useState(null);
  React.useEffect(() => {
    let stale = false;
    listBranches(org.git).then(b => { if (!stale) setBranches(b); }).catch(() => { if (!stale) setBranches([]); });
    return () => { stale = true; };
  }, [org.git.repo]);
  return h("div", {className: "rel-branch"},
    h("span", {className: "rel-org-l"}, "Branch"),
    h(SearchSelect, {value: org.git.branch, options: (branches || [org.git.branch]).map(b => ({value: b, label: b})), allowFree: true,
      disabled, ariaLabel: "Git branch", onChange: b => { if (b && b !== org.git.branch) setGitBranch(b); }}));
}

// Source → target pickers with swap (reverse deployment) and refresh.
// fixedSource {title, sub}: a rollback or restore comes from a saved copy, not
// an org; lockTarget keeps it on the org it belongs to.
export function OrgBar({showTarget = true, sourceLabel = "Source", disabled, fixedSource = null, lockTarget = false}) {
  const st = useRelease();
  React.useEffect(() => {
    if (!st.orgs && !st.orgsBusy) loadOrgs();
  }, []);
  const orgs = st.orgs || [];
  const target = orgByHost(st.targetHost);
  // Never switch orgs under a running deploy (cancel and links follow it).
  disabled = disabled || !!(st.deploy && !st.deploy.finished);
  const swap = () => setRelease({sourceHost: st.targetHost, targetHost: st.sourceHost, compare: null, selected: new Set(), validation: null});
  return h("div", {className: "rel-orgbar"},
    fixedSource ? h("div", {className: "rel-org"},
      h("span", {className: "rel-org-l"}, sourceLabel),
      h("div", {className: "rel-fixed-src", title: fixedSource.sub}, h("b", null, fixedSource.title), h("span", {className: "insp-meta"}, fixedSource.sub))) :
    h("div", {className: "rel-org"},
      h("span", {className: "rel-org-l"}, sourceLabel),
      h(SearchSelect, {
        value: st.sourceHost, options: orgOptions(orgs, null, {git: showTarget}), disabled,
        ariaLabel: sourceLabel + " org", placeholder: st.orgsBusy ? "Finding your orgs…" : "Pick an org",
        onChange: v => setRelease({sourceHost: v, ...(v === st.targetHost ? {targetHost: ""} : {}), compare: null, selected: new Set()})
      }),
      h(OrgTag, {org: orgByHost(st.sourceHost)}),
      orgByHost(st.sourceHost) && orgByHost(st.sourceHost).isGit && h(BranchPicker, {org: orgByHost(st.sourceHost), disabled})),
    showTarget && !fixedSource && h("button", {
      className: "btn btn-secondary btn-sm rel-swap", disabled: disabled || !st.sourceHost || !st.targetHost || st.sourceHost.startsWith("git:"),
      title: "Swap source and target (reverse deployment)", "aria-label": "Swap source and target", onClick: swap
    }, "⇄"),
    showTarget && h("div", {className: "rel-org"},
      h("span", {className: "rel-org-l"}, "Target"),
      h(SearchSelect, {
        value: st.targetHost, options: orgOptions(orgs, fixedSource ? null : st.sourceHost), disabled: disabled || lockTarget,
        ariaLabel: "Target org", placeholder: orgs.length < 2 ? "Log in to another org first" : "Pick the target org",
        emptyText: "No other org found",
        onChange: v => setRelease({targetHost: v, compare: null, selected: new Set(), validation: null})
      }),
      h(OrgTag, {org: target})),
    h("button", {
      className: "btn btn-secondary btn-sm", disabled: st.orgsBusy || disabled, title: "Look again for orgs you're logged into",
      onClick: () => loadOrgs(true)
    }, st.orgsBusy ? "…" : "↻"),
    showTarget && target && !target.isSandbox && h("div", {className: "insp-warn rel-full"}, "🏭 The target is a production org: validate first, then use Quick deploy."),
    st.orgsError && h("div", {className: "insp-error"}, "Could not list orgs: " + st.orgsError),
    showTarget && st.orgs && orgs.length < 2 && h("div", {className: "insp-hint-strip rel-full"},
      "Only this org was found. Log in to the other org (sandbox, UAT or production) in another tab of this browser, then press ↻. " +
      "SaralForce uses that login; nothing extra to set up."));
}

// Type groups (presets), plus any single type the org has under "More types".
// Groups show only the types this org has; empty groups are hidden.
export function PresetPicker({value, onChange, disabled}) {
  useRelease(); // re-render once the org's type list has loaded
  const all = value.includes(ALL_TYPES);
  // "All types" stands alone; picking a group switches it off.
  const toggle = id => onChange(all ? [id] : value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const picked = all ? [] : value.filter(v => String(v).startsWith(TYPE_PICK));
  const others = otherTypes().filter(t => !picked.includes(TYPE_PICK + t));
  const count = allTypes().length;
  return h("div", {className: "rel-presets", role: "group", "aria-label": "What to include"},
    h("button", {
      type: "button", disabled,
      className: "insp-chip rel-chip rel-chip-all" + (all ? " on" : ""),
      "aria-pressed": all,
      title: `Every metadata type this org has (${count}). Big orgs take a while: use "Only changed since" to narrow it.`,
      onClick: () => onChange(all ? [] : [ALL_TYPES])
    }, (all ? "✓ " : "★ ") + `All types (${count})`),
    TYPE_PRESETS.map(p => ({...p, have: p.types.filter(t => TYPE_BY_NAME[t])})).filter(p => p.have.length).map(p => h("button", {
      key: p.id, type: "button", disabled,
      className: "insp-chip rel-chip" + (!all && value.includes(p.id) ? " on" : ""),
      "aria-pressed": !all && value.includes(p.id),
      title: p.have.join(", "),
      onClick: () => toggle(p.id)
    }, (!all && value.includes(p.id) ? "✓ " : "") + p.label)),
    picked.map(v => h("button", {
      key: v, type: "button", disabled, className: "insp-chip rel-chip on",
      title: "Remove " + v.slice(TYPE_PICK.length), onClick: () => onChange(value.filter(x => x !== v))
    }, "✓ " + typeLabel(v.slice(TYPE_PICK.length)) + " ✕")),
    !all && others.length > 0 && h("div", {className: "rel-more-types"},
      h(SearchSelect, {
        value: "", disabled, ariaLabel: "More metadata types",
        placeholder: `＋ More types (${others.length})…`,
        emptyText: "No other types",
        options: others.map(t => ({value: t, label: typeLabel(t), sub: t})),
        onChange: t => { if (t) onChange([...value, TYPE_PICK + t]); }
      })));
}

// ── Comparison filters (like Gearset's): which types a compare covers ──
const FILTERS_KEY = "sf_release_filters";
const pick = types => types.map(t => TYPE_PICK + t);
export const STANDARD_FILTERS = [
  {id: "all", label: "Compare all", presets: [ALL_TYPES]},
  {id: "default", label: "Default comparison", presets: ["apex", "ui", "flows", "objects", "pages", "security", "automation", "config"]},
  {id: "basic", label: "Basic comparison", presets: pick(["ApexClass", "ApexTrigger", "ApexPage", "ApexComponent", "CustomObject", "CustomField"])},
  {id: "perms", label: "Profiles & permission sets", presets: pick(["Profile", "PermissionSet", "PermissionSetGroup", "MutingPermissionSet", "CustomPermission",
    "CustomObject", "CustomField", "ApexClass", "ApexPage", "CustomTab", "CustomApplication", "Layout", "RecordType", "Flow"])},
  {id: "picklists", label: "Picklists", presets: pick(["CustomField", "GlobalValueSet", "StandardValueSet", "RecordType", "BusinessProcess"])},
  ...TYPE_PRESETS.map(p => ({id: "p:" + p.id, label: p.label, presets: [p.id]}))
];

export function savedFilters() {
  try { return JSON.parse(localStorage.getItem(FILTERS_KEY) || "[]").filter(f => f && f.id && Array.isArray(f.presets)); } catch (e) { return []; }
}
function storeFilters(list) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
}
export function findFilter(id) {
  return STANDARD_FILTERS.find(f => f.id === id) || savedFilters().find(f => f.id === id) || STANDARD_FILTERS[0];
}
export function filterTypes(f) {
  return presetTypes(f.presets);
}

// One combo: standard filters, your saved ones, and "＋ New filter / manage".
export function FilterPicker({value, onChange, disabled}) {
  useRelease(); // counts follow the org's type list
  const [editing, setEditing] = React.useState(null); // {id?, name, presets}
  const [mine, setMine] = React.useState(savedFilters);
  const opt = (f, group) => ({value: f.id, label: `${f.label} (${filterTypes(f).length})`, sub: group});
  const options = [
    ...STANDARD_FILTERS.map(f => opt(f, f.id === "all" ? "" : "Standard")),
    ...mine.map(f => opt(f, "My filter")),
    {value: "__new", label: "＋ New filter…", sub: ""},
    ...(mine.length ? [{value: "__manage", label: "✎ Edit my filters…", sub: ""}] : [])
  ];
  const save = () => {
    const name = (editing.name || "").trim();
    if (!name || !filterTypes(editing).length) return;
    const f = {id: editing.id || "c:" + Date.now().toString(36), label: name, presets: editing.presets};
    const list = [...mine.filter(x => x.id !== f.id), f];
    storeFilters(list); setMine(list); setEditing(null); onChange(f.id);
  };
  const remove = id => {
    const list = mine.filter(x => x.id !== id);
    storeFilters(list); setMine(list);
    if (value === id) onChange("all");
    setEditing(null);
  };
  return h("div", {className: "rel-filter"},
    h("div", {className: "rel-filter-row"},
      h("span", {className: "rel-org-l"}, "Comparison filter"),
      h(SearchSelect, {value, options, disabled, className: "rel-filter-combo", ariaLabel: "Comparison filter",
        onChange: v => {
          if (v === "__new") setEditing({name: "", presets: []});
          else if (v === "__manage") setEditing({manage: true});
          else if (v) onChange(v);
        }}),
      h("span", {className: "insp-meta"}, filterTypes(findFilter(value)).length + " metadata types")),
    editing && editing.manage && h("div", {className: "rel-filter-edit"},
      h("div", {className: "rel-label"}, "My filters"),
      mine.map(f => h("div", {key: f.id, className: "rel-filter-item"},
        h("b", null, f.label), h("span", {className: "insp-meta"}, `${filterTypes(f).length} types`),
        h("button", {className: "field-action-btn", onClick: () => setEditing({id: f.id, name: f.label, presets: f.presets})}, "Edit"),
        h("button", {className: "field-action-btn", onClick: () => remove(f.id)}, "Delete"))),
      h("div", {className: "rel-filter-actions"}, h("button", {className: "btn btn-secondary btn-sm", onClick: () => setEditing(null)}, "Close"))),
    editing && !editing.manage && h("div", {className: "rel-filter-edit"},
      h("div", {className: "rel-label"}, editing.id ? "Edit filter" : "New comparison filter"),
      h("input", {className: "soql-save-input", placeholder: "Filter name, e.g. Sales release", value: editing.name, autoFocus: true,
        onChange: e => setEditing({...editing, name: e.target.value}), "aria-label": "Filter name"}),
      h(PresetPicker, {value: editing.presets, onChange: p => setEditing({...editing, presets: p})}),
      h("div", {className: "rel-filter-actions"},
        h("span", {className: "insp-meta"}, `${filterTypes(editing).length} metadata types`),
        editing.id && h("button", {className: "field-action-btn", onClick: () => remove(editing.id)}, "Delete"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => setEditing(null)}, "Cancel"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !(editing.name || "").trim() || !filterTypes(editing).length, onClick: save}, "Save filter"))));
}

// ── Date range: from / to (empty = open), with quick picks ────────────
export function DateRange({from, to, onChange, disabled, picks}) {
  return h("div", {className: "rel-range"},
    h("span", {className: "rel-org-l"}, "Changed"),
    picks.map(p => h("button", {key: p.id, type: "button", disabled,
      className: "insp-chip rel-chip" + (p.from === from && p.to === to ? " on" : ""),
      onClick: () => onChange(p.from, p.to)}, p.label)),
    h("label", {className: "rel-range-l"}, "from ",
      h("input", {type: "date", className: "soql-save-input", value: from, max: to || undefined, disabled,
        onChange: e => onChange(e.target.value, to), "aria-label": "Changed from"})),
    h("label", {className: "rel-range-l"}, "to ",
      h("input", {type: "date", className: "soql-save-input", value: to, min: from || undefined, disabled,
        onChange: e => onChange(from, e.target.value), "aria-label": "Changed to"})));
}

const MAX_DIFF_ROWS = 3000;

// Side-by-side diff: target (what's there now) vs source (incoming).
export function DiffView({row, heading}) {
  const data = React.useMemo(() => {
    const rows = diffLines(row.targetText || "", row.sourceText || "");
    return {stats: diffStats(rows), pairs: sideBySide(rows, {context: 3})};
  }, [row.key, row.sourceText, row.targetText]);
  const pairs = data.pairs.slice(0, MAX_DIFF_ROWS);
  return h("div", {className: "rel-diff-wrap"},
    h("div", {className: "rel-diff-head"},
      h("span", null, heading || (row.status === "new" ? "Only in source (new in target)" : row.status === "deleted" ? "Only in target" : "Target now  →  Source (incoming)")),
      h("span", {className: "rel-diff-stat"},
        h("span", {className: "rel-add"}, "+" + data.stats.added), " ",
        h("span", {className: "rel-del"}, "−" + data.stats.removed))),
    row.status === "same"
      ? h("div", {className: "insp-meta"}, "No differences.")
      : h("div", {className: "rel-diff-scroll"},
        h("table", {className: "rel-diff"},
          h("colgroup", null, h("col", {className: "rel-ln-col"}), h("col", null), h("col", {className: "rel-ln-col"}), h("col", null)),
          h("tbody", null, pairs.map((p, i) => p.fold
            ? h("tr", {key: i, className: "rel-fold"}, h("td", {colSpan: 4}, `⋯ ${p.fold} unchanged line${p.fold === 1 ? "" : "s"}`))
            : h("tr", {key: i, className: "rel-" + p.kind},
              h("td", {className: "rel-ln"}, p.left ? p.left.n : ""),
              h("td", {className: "rel-code" + (p.left && p.kind !== "same" ? " rel-l" : "")}, p.left ? p.left.text : ""),
              h("td", {className: "rel-ln"}, p.right ? p.right.n : ""),
              h("td", {className: "rel-code" + (p.right && p.kind !== "same" ? " rel-r" : "")}, p.right ? p.right.text : "")))))),
    data.pairs.length > MAX_DIFF_ROWS && h("div", {className: "insp-meta"}, `Showing the first ${MAX_DIFF_ROWS} lines of the diff.`));
}

export const STATUS_BADGE = {
  new: {kind: "ok", label: "New"},
  changed: {kind: "warn", label: "Changed"},
  deleted: {kind: "err", label: "Only in target"},
  same: {kind: "off", label: "Same"}
};

// What a deploy does to a row in the target (Gearset's "difference type",
// said as the action): added, modified, deleted, or left alone.
// selected: what the deploy will do; not selected: what it would do.
export const TARGET_ACTION = {
  new: {kind: "add", on: "＋ Will be added", off: "＋ Add"},
  changed: {kind: "mod", on: "✎ Will be modified", off: "✎ Modify"},
  deleted: {kind: "del", on: "− Will be deleted", off: "Kept (tick to delete)"},
  same: {kind: "off", on: "No change", off: "No change"}
};
export function TargetAction({status, selected}) {
  const a = TARGET_ACTION[status] || TARGET_ACTION.same;
  return h("span", {className: "rel-act rel-act-" + (selected ? a.kind : "off"),
    title: selected ? "Selected: this is what the deploy does in the target" : "Not selected: nothing happens to it in the target"},
  selected ? a.on : a.off);
}

// AI answer card with copy (shared by release notes and failure help).
// AI answers: **bold**, `code`, bullet and numbered lines, headings. Builds
// React elements only (never HTML), so the reply can't inject markup.
function inline(text, key) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] != null ? h("b", {key: key + "b" + i++}, m[1]) : h("code", {key: key + "c" + i++}, m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function RichText({text}) {
  const lines = String(text || "").split("\n");
  return h("div", {className: "rel-rich"}, lines.map((line, n) => {
    const t = line.replace(/\s+$/, "");
    const indent = (/^\s*/.exec(line)[0].length >= 2) ? " rel-rich-in" : "";
    let m;
    if (!t.trim()) return h("div", {key: n, className: "rel-rich-gap"});
    if ((m = /^\s*#{1,4}\s+(.*)$/.exec(t))) return h("div", {key: n, className: "rel-rich-h"}, inline(m[1], n));
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(t))) return h("div", {key: n, className: "rel-rich-li" + indent}, h("span", {className: "rel-rich-dot"}, "•"), h("span", null, inline(m[1], n)));
    if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(t))) return h("div", {key: n, className: "rel-rich-li" + indent}, h("span", {className: "rel-rich-num"}, m[1] + "."), h("span", null, inline(m[2], n)));
    return h("div", {key: n, className: "rel-rich-p" + indent}, inline(t, n));
  }));
}

export function AiAnswer({title, text, onClose}) {
  const [copied, setCopied] = React.useState(false);
  return h("div", {className: "rel-ai"},
    h("div", {className: "rel-ai-h"},
      h("span", null, "✨ " + title),
      h("div", {className: "audit-actions"},
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => {
          try { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { /* no clipboard */ }
        }}, copied ? "Copied" : "Copy"),
        onClose && h("button", {className: "btn btn-secondary btn-sm", onClick: onClose}, "Close"))),
    h("div", {className: "rel-ai-body rel-ai-rich"}, h(RichText, {text})));
}

export function AiError({error}) {
  if (!error) return null;
  if (error === "NO_LLM_CONFIG") {
    return h("div", {className: "insp-warn"}, "Add an AI provider key in Settings to use this. ",
      h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings"));
  }
  return h("div", {className: "insp-error"}, "AI request failed: " + error);
}
