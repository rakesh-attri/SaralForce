// Release Center building blocks: org pickers, type presets, diff view.
import {SearchSelect} from "../shared/combo.js";
import {TYPE_PRESETS} from "../../core/deploy.js";
import {diffLines, diffStats, sideBySide} from "../../core/text-diff.js";
import {useRelease, setRelease, loadOrgs, orgByHost} from "./release-state.js";

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

// Source → target pickers with swap (reverse deployment) and refresh.
export function OrgBar({showTarget = true, sourceLabel = "Source", disabled}) {
  const st = useRelease();
  React.useEffect(() => {
    if (!st.orgs && !st.orgsBusy) loadOrgs();
  }, []);
  const orgs = st.orgs || [];
  const target = orgByHost(st.targetHost);
  const swap = () => setRelease({sourceHost: st.targetHost, targetHost: st.sourceHost, compare: null, selected: new Set(), validation: null});
  return h("div", {className: "rel-orgbar"},
    h("div", {className: "rel-org"},
      h("span", {className: "rel-org-l"}, sourceLabel),
      h(SearchSelect, {
        value: st.sourceHost, options: orgOptions(orgs, null, {git: showTarget}), disabled,
        ariaLabel: sourceLabel + " org", placeholder: st.orgsBusy ? "Finding your orgs…" : "Pick an org",
        onChange: v => setRelease({sourceHost: v, ...(v === st.targetHost ? {targetHost: ""} : {}), compare: null, selected: new Set()})
      }),
      h(OrgTag, {org: orgByHost(st.sourceHost)})),
    showTarget && h("button", {
      className: "btn btn-secondary btn-sm rel-swap", disabled: disabled || !st.sourceHost || !st.targetHost || st.sourceHost.startsWith("git:"),
      title: "Swap source and target (reverse deployment)", "aria-label": "Swap source and target", onClick: swap
    }, "⇄"),
    showTarget && h("div", {className: "rel-org"},
      h("span", {className: "rel-org-l"}, "Target"),
      h(SearchSelect, {
        value: st.targetHost, options: orgOptions(orgs, st.sourceHost), disabled,
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

export function PresetPicker({value, onChange, disabled}) {
  const toggle = id => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  return h("div", {className: "rel-presets", role: "group", "aria-label": "What to include"},
    TYPE_PRESETS.map(p => h("button", {
      key: p.id, type: "button", disabled,
      className: "insp-chip rel-chip" + (value.includes(p.id) ? " on" : ""),
      "aria-pressed": value.includes(p.id),
      title: p.types.join(", "),
      onClick: () => toggle(p.id)
    }, (value.includes(p.id) ? "✓ " : "") + p.label)));
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

// AI answer card with copy (shared by release notes and failure help).
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
    h("div", {className: "rel-ai-body"}, text));
}

export function AiError({error}) {
  if (!error) return null;
  if (error === "NO_LLM_CONFIG") {
    return h("div", {className: "insp-warn"}, "Add an AI provider key in Settings to use this. ",
      h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings"));
  }
  return h("div", {className: "insp-error"}, "AI request failed: " + error);
}
