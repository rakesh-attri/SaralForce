import {hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {
  buildCompareMatrix, filterMatrix, effectiveAccess, summarizeRiskyAccess,
  humanizePermission, OBJECT_PERM_FLAGS, pickKey, splitPick, mergeCompareData,
  columnLabels, describeRowDiff, diffSummary, COMPARE_PARTS, matchUser, buildRoleGroupMatrix, sharingRulesSection
} from "../../core/access.js";
import {baseUsername} from "../../core/manual-steps.js";
import {confirmDialog} from "../../ui/confirm.js";
import {
  loadPermSetList, loadPermFieldNames, loadCompareData, userPermSources,
  loadUserList, loadUserAccess, loadRoleGroupList, loadRoleGroupData, loadSharingRules,
  objectPermRows, fieldPermRows, systemPermRows, riskyAssignments
} from "../shared/access-data.js";
import {ffGetObjects} from "../shared/describe.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {logsAskLlm} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {FFBadge, EmptyState} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {ApprovalsView} from "./approvals.js";
import {SharingCompareCard} from "./sharing-compare.js";
import {SearchSelect} from "../shared/combo.js";
import {useRelease, loadOrgs, orgByHost} from "./release-state.js";
import {orgOptions, OrgTag} from "./release-ui.js";

const h = React.createElement;
const MAX_COMPARE = 5;

function openSettings() {
  try { chrome.runtime.sendMessage({message: "openOptions", host: ""}); }
  catch (e) { /* extension context only */ }
}

function CardHead({icon, title, children}) {
  return h("div", {className: "org-card-h"},
    h("span", {className: "org-card-ico", "aria-hidden": "true"}, icon),
    h("span", {className: "org-card-t"}, title),
    children && h("div", {className: "audit-actions"}, children));
}

// ─── Compare 2-5 permission sets / profiles side by side ─────────────
// One cell of the compare matrix in words: object access as Read / Create /
// … labels (the ones that differ along the row highlighted), Yes / No for
// system permissions and apps, "Not set" for tabs.
function AccessCell({section, value, row}) {
  if (section === "objects") {
    if (!value || value === "—") return h("span", {className: "acc-none"}, "No access");
    const varies = l => row.values.some(v => String(v).includes(l)) && !row.values.every(v => String(v).includes(l));
    return h("span", {className: "acc-flags"}, OBJECT_PERM_FLAGS.filter(([, , l]) => String(value).includes(l)).map(([, label, l]) =>
      h("span", {key: l, className: "acc-flag" + (varies(l) ? " diff" : ""), title: varies(l) ? "Not the same in every column" : ""}, label)));
  }
  if (ACCESS_EMPTY[section]) return value ? h("span", {className: "acc-tab"}, value) : h("span", {className: "acc-none"}, ACCESS_EMPTY[section]);
  return value ? h("span", {className: "acc-yes" + (row.differs ? " diff" : "")}, "✓ Yes") : h("span", {className: "acc-no"}, "No");
}

// Two sides, Compare (left) and With (right), each from its own org (this org
// or another you're logged into); host "" = this org. Three kinds of thing:
// profiles & permission sets, users (their combined access), roles & groups.
const KIND_TAG = {profile: ["Profile", "info"], set: ["Permission set", "ok"], group: ["Group", "violet"], queue: ["Queue", "warn"],
  role: ["Role", "info"], user: ["User", "ok"]};
const ACCESS_EMPTY = {tabs: "Not set", fields: "No access", owd: "—", general: "—", rgSettings: "—", sharingRules: "Not in this org"};
const SECTION_HEAD = {objects: "Object", fields: "Field", tabs: "Tab", apps: "App", apex: "Apex class", pages: "Visualforce page",
  customPerms: "Custom permission", connectedApps: "Connected app", flows: "Flow", owd: "Object", general: "Setting",
  rgSettings: "Setting", members: "Member", queueObjects: "Object", sharingRules: "Rule"};
const COMPARE_KINDS = [
  ["perm", "Profiles & permission sets", "profiles, permission sets or groups"],
  ["users", "Users", "users"],
  ["roles", "Roles & groups", "roles, public groups or queues"]
];
const SHARING_PART = ["sharingRules", "Sharing rules"];
const KIND_PARTS = {
  perm: [...COMPARE_PARTS, SHARING_PART],
  users: [...COMPARE_PARTS, SHARING_PART],
  roles: [["rgSettings", "Settings"], ["members", "Members"], ["queueObjects", "Queue objects"], SHARING_PART]
};
const ORG_PARTS = new Set(["owd", "sharingRules"]); // need the two sides in different orgs

function CompareSide({title, kind, host, onHost, keys, onKeys, total, orgs, current, lists, orgName, children}) {
  const list = Array.isArray(lists[kind + "|" + host]) ? lists[kind + "|" + host] : null;
  const itemOf = k => { const {id} = splitPick(k); return ((list || []).find(p => p.id === id) || {}).name || id; };
  const what = (COMPARE_KINDS.find(x => x[0] === kind) || COMPARE_KINDS[0])[2];
  return h("div", {className: "acc-side"},
    h("div", {className: "acc-side-h"}, title),
    orgs.length > 1
      ? h("div", {className: "acc-side-org"},
        h(SearchSelect, {value: host || (current ? current.host : ""), options: orgOptions(orgs),
          onChange: v => onHost(current && v === current.host ? "" : v), ariaLabel: title + " org", className: "acc-org"}),
        h(OrgTag, {org: host ? orgByHost(host) : current}))
      : h("div", {className: "insp-meta"}, orgName(host)),
    h(SearchSelect, {
      value: "",
      options: (list || []).filter(p => !keys.includes(pickKey(host, p.id))).map(p => ({
        value: pickKey(host, p.id), label: p.name,
        sub: kind === "users" ? p.username : kind === "roles" ? p.dev : undefined,
        tag: kind === "users" ? (p.active ? "" : "Inactive") : (KIND_TAG[p.kind] || [""])[0],
        tagTone: kind === "users" ? "muted" : (KIND_TAG[p.kind] || ["", "info"])[1]
      })),
      onChange: k => { if (k && !keys.includes(k) && total < MAX_COMPARE) onKeys([...keys, k]); },
      placeholder: !list ? "Loading…" : total >= MAX_COMPARE ? `Up to ${MAX_COMPARE} in all` : `Search ${what}…`,
      emptyText: "No match", disabled: !list || total >= MAX_COMPARE,
      ariaLabel: `${title}: ${what}`, className: "acc-pick"
    }),
    h("div", {className: "insp-chips acc-side-chips"},
      keys.length ? keys.map(k => h("button", {key: k, className: "insp-chip", title: "Remove", onClick: () => onKeys(keys.filter(x => x !== k))}, itemOf(k), " ×"))
        : h("span", {className: "insp-meta"}, "Nothing picked yet")),
    children);
}

function CompareCard() {
  const rel = useRelease();
  React.useEffect(() => { if (!rel.orgs && !rel.orgsBusy) loadOrgs(); }, []);
  const orgs = (rel.orgs || []).filter(o => !o.isGit);
  const current = orgs.find(o => o.isCurrent);
  const orgOf = host => host ? orgByHost(host) : current || null;
  const orgName = host => { const o = orgOf(host); return o ? o.name : host || "This org"; };
  const [kind, setKind] = useFfSession("access", "compareKind", "perm");
  const [hostA, setHostA] = useFfSession("access", "orgA", "");
  const [hostB, setHostB] = useFfSession("access", "orgB", "");
  const [pickedA, setPickedA] = useFfSession("access", "pickedA", []);
  const [pickedB, setPickedB] = useFfSession("access", "pickedB", []);
  const [oldPicked, setOldPicked] = useFfSession("access", "picked", []);
  const [partsByKind, setPartsByKind] = useFfSession("access", "partsByKind", {});
  const kindParts = KIND_PARTS[kind] || KIND_PARTS.perm;
  const parts = partsByKind[kind] || kindParts.map(p => p[0]);
  const setParts = p => setPartsByKind({...partsByKind, [kind]: p});
  const [lists, setLists] = React.useState({}); // "kind|host" → items
  const [listErr, setListErr] = React.useState(null);
  const [matrix, setMatrix] = useFfSession("access", "matrix", null);
  const [loading, setLoading] = React.useState("");
  const [error, setError] = React.useState(null);
  const [onlyDiff, setOnlyDiff] = React.useState(true);
  const [term, setTerm] = React.useState("");

  // A selection saved by the one-list version goes on the left.
  React.useEffect(() => {
    if (oldPicked.length && !pickedA.length && !pickedB.length) setPickedA(oldPicked.map(k => k.includes("|") ? k : pickKey("", k)));
    if (oldPicked.length) setOldPicked([]);
  }, []);
  const ensureList = host => {
    const lk = kind + "|" + host;
    if (lists[lk]) return;
    const o = host ? orgByHost(host) : null;
    if (host && !o) return;
    setLists(l => ({...l, [lk]: l[lk] || "loading"}));
    const load = kind === "users" ? loadUserList : kind === "roles" ? loadRoleGroupList : loadPermSetList;
    load(o ? o.conn : undefined)
      .then(list => setLists(l => ({...l, [lk]: list})))
      .catch(e => { setLists(l => ({...l, [lk]: []})); setListErr(`${orgName(host)}: ${e.message}`); });
  };
  React.useEffect(() => { ensureList(hostA); ensureList(hostB); }, [kind, hostA, hostB, rel.orgs]);
  const listOf = host => Array.isArray(lists[kind + "|" + host]) ? lists[kind + "|" + host] : null;
  const keysA = pickedA.filter(k => splitPick(k).host === hostA);
  const keysB = pickedB.filter(k => splitPick(k).host === hostB);
  const keys = [...keysA, ...keysB];
  const total = keys.length;
  const itemFor = key => { const {host, id} = splitPick(key); return (listOf(host) || []).find(p => p.id === id) || null; };
  const itemOf = key => (itemFor(key) || {}).name || splitPick(key).id;
  const colOf = key => {
    const o = orgOf(splitPick(key).host);
    return {item: itemOf(key), org: orgName(splitPick(key).host), kind: o ? (o.isSandbox ? "Sandbox" : "Production") : ""};
  };
  // "Same as left": the left side's items in the right side's org.
  const listB = listOf(hostB);
  const sameAsLeft = listB ? keysA.map(k => {
    const p = itemFor(k);
    if (!p) return null;
    if (kind === "users") return matchUser(p, listB, baseUsername);
    if (kind === "roles") return listB.find(x => x.dev === p.dev && x.kind === p.kind);
    return listB.find(x => x.name === p.name && x.kind === p.kind);
  }).filter(p => p && !keysB.includes(pickKey(hostB, p.id)) && !(hostA === hostB && keysA.includes(pickKey(hostB, p.id))))
    .filter((p, i, a) => a.findIndex(x => x.id === p.id) === i).slice(0, MAX_COMPARE - total) : [];
  const twoOrgs = hostA !== hostB;

  const switchKind = async k => {
    if (k === kind) return;
    if (total && !(await confirmDialog({title: "Switch what you compare?", message: "The items picked on both sides are cleared.", confirmLabel: "Switch"}))) return;
    setPickedA([]); setPickedB([]); setMatrix(null); setError(null); setKind(k);
  };

  const compare = async () => {
    setLoading("Reading permissions…");
    setError(null);
    try {
      const hosts = [...new Set(keys.map(k => splitPick(k).host))];
      const conns = Object.fromEntries(hosts.map(h => [h, h ? orgByHost(h) : null]));
      for (const h of hosts) if (h && !conns[h]) throw new Error(`Log in to ${h} in this browser first (it isn't in your org list).`);
      const idsOf = host => keys.filter(k => splitPick(k).host === host).map(k => splitPick(k).id);
      let sections;
      const origins = {};
      if (kind === "roles") {
        const byKey = {};
        await Promise.all(hosts.map(async host => {
          const items = idsOf(host).map(id => ({id, kind: (itemFor(pickKey(host, id)) || {}).kind || "group"}));
          const got = await loadRoleGroupData(items, conns[host] ? conns[host].conn : undefined);
          for (const id of Object.keys(got)) byKey[pickKey(host, id)] = got[id];
        }));
        sections = buildRoleGroupMatrix(keys.map(k => byKey[k] || {settings: {}, members: [], queueObjects: []}));
      } else {
        const loaded = await Promise.all(hosts.map(async host => {
          const conn = conns[host] ? conns[host].conn : undefined;
          if (kind === "users") {
            const r = await loadUserAccess(idsOf(host), conn, parts);
            for (const id of Object.keys(r.origins)) origins[pickKey(host, id)] = r.origins[id];
            return {host, data: r.data};
          }
          return {host, data: await loadCompareData(idsOf(host), conn, parts)};
        }));
        sections = buildCompareMatrix(mergeCompareData(loaded, keys));
      }
      // Sharing rules: each column's org (only when the sides are in different orgs).
      if (parts.includes("sharingRules") && twoOrgs) {
        setLoading("Reading sharing rules…");
        const rulesByHost = {};
        await Promise.all(hosts.map(async host => {
          const o = orgOf(host);
          rulesByHost[host] = o && o.conn ? await loadSharingRules(o.conn) : {};
        }));
        sections.push(sharingRulesSection(keys.map(k => splitPick(k).host), rulesByHost));
      }
      const cols = keys.map(colOf);
      setMatrix({kind, ids: keys, cols, names: columnLabels(cols), sections, origins: kind === "users" ? origins : null});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading("");
    }
  };
  const visible = matrix ? matrix.sections.filter(s => parts.includes(s.key) || (s.key === "general" && parts.includes("general"))) : [];
  const shown = matrix ? filterMatrix(visible, {onlyDiff, term}) : [];
  // Users: which profile / permission set / group gives each column its access.
  const fromText = (s, r) => {
    if (!matrix.origins) return "";
    const parts2 = r.values.map((v, i) => {
      if (!v || v === "—") return "";
      const o = (matrix.origins[matrix.ids[i]] || {})[`${s.key}|${r.key}`];
      return o && o.length ? `${matrix.names[i]}: from ${o.join(", ")}` : "";
    }).filter(Boolean);
    return parts2.join(" · ");
  };
  const exportCsv = () => {
    const cols = ["Section", "Item", ...matrix.names, "What differs", "Where it comes from"];
    const rows = [];
    for (const s of visible) {
      for (const r of s.rows) {
        const row = {Section: s.title, Item: r.label, "What differs": r.differs ? describeRowDiff(s.key, r.values, matrix.names) : "",
          "Where it comes from": fromText(s, r)};
        matrix.names.forEach((n, i) => { row[n] = r.values[i]; });
        rows.push(row);
      }
    }
    downloadText("access-compare.csv", toCsv(cols, rows));
  };
  const sideProps = {kind, total, orgs, current, lists, orgName};
  const kindLabel = (COMPARE_KINDS.find(x => x[0] === kind) || COMPARE_KINDS[0])[2];

  return h("div", {className: "org-card org-card-wide", "data-tour": "access-compare"},
    h(CardHead, {icon: "⚖️", title: "Compare access"},
      matrix && h("button", {className: "btn btn-secondary btn-sm", onClick: exportCsv}, "Download CSV")),
    h("div", {className: "acc-kinds", role: "group", "aria-label": "What to pick"},
      h("span", {className: "rel-org-l"}, "Compare"),
      COMPARE_KINDS.map(([id, label]) => h("button", {key: id, type: "button", "aria-pressed": kind === id,
        className: "insp-chip rel-chip" + (kind === id ? " on" : ""), onClick: () => switchKind(id)}, label))),
    h("div", {className: "sq3-card-sub"},
      `Pick ${kindLabel} on each side (up to ${MAX_COMPARE} in all). Each side can be in its own org: this one or another you're logged into, such as a sandbox against production.` +
      (kind === "users" ? " A user's access is everything their profile, permission sets and groups give them together." : "")),
    listErr && h("div", {className: "insp-error"}, "Could not list: " + listErr),
    orgs.length < 2 && rel.orgs && h("div", {className: "insp-meta acc-org-hint"},
      "To compare with another org (a sandbox against production), log in to it in another tab of this browser."),
    h("div", {className: "acc-sides"},
      h(CompareSide, {...sideProps, title: "Compare", host: hostA, onHost: setHostA, keys: keysA, onKeys: setPickedA}),
      h("div", {className: "acc-vs", "aria-hidden": "true"}, "vs"),
      h(CompareSide, {...sideProps, title: "With", host: hostB, onHost: setHostB, keys: keysB, onKeys: setPickedB},
        sameAsLeft.length > 0 && h("button", {className: "field-action-btn acc-same", onClick: () => setPickedB([...keysB, ...sameAsLeft.map(p => pickKey(hostB, p.id))])},
          `＋ Same as left${sameAsLeft.length === 1 ? ": " + sameAsLeft[0].name : ` (${sameAsLeft.length})`}${twoOrgs ? " from " + orgName(hostB) : ""}`))),
    h("div", {className: "acc-parts"},
      h("span", {className: "rel-org-l"}, "What to compare"),
      kindParts.map(([id, label]) => h("button", {key: id, type: "button", "aria-pressed": parts.includes(id),
        className: "insp-chip rel-chip" + (parts.includes(id) ? " on" : ""),
        title: ORG_PARTS.has(id) ? "Each side's org settings: only when the two sides are in different orgs" : "",
        onClick: () => setParts(parts.includes(id) ? parts.filter(x => x !== id) : [...parts, id])},
      (parts.includes(id) ? "✓ " : "") + label + (ORG_PARTS.has(id) && !twoOrgs ? " (two orgs)" : "")))),
    h("div", {className: "acc-run"},
      h("span", {className: "insp-meta"}, total < 2 ? "Pick at least one on each side (or two on one side)." : `${keysA.length} vs ${keysB.length}`),
      h("button", {className: "btn btn-primary btn-sm", disabled: total < 2 || !!loading, onClick: compare}, loading ? "Comparing…" : "Compare")),
    loading && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
      h("span", {className: "insp-meta"}, loading)),
    error && h("div", {className: "insp-error"}, error),
    !matrix && !loading && h(EmptyState, {art: kind === "users" ? "users" : "compare",
      title: total < 2 ? "Pick what to compare" : "Ready when you are",
      text: total < 2
        ? `Left: what you start from. Right: what to compare it with, in the same org or another one. Use “＋ Same as left” to pick the same ${kind === "users" ? "person" : kind === "roles" ? "role or group" : "profile"} in the other org.`
        : `Press Compare to see ${total} of them side by side.`}),
    matrix && h("div", {className: "acc-toolbar"},
      h("label", {className: "sq3-check"},
        h("input", {type: "checkbox", checked: onlyDiff, onChange: e => setOnlyDiff(e.target.checked)}),
        h("span", null, "Only differences")),
      h("input", {
        className: "soql-save-input acc-filter",
        value: term,
        placeholder: "filter…",
        "aria-label": "Filter rows",
        onChange: e => setTerm(e.target.value)
      })),
    matrix && h("div", {className: "acc-summary" + (diffSummary(visible).total ? "" : " same")}, diffSummary(visible).text),
    // Sections with nothing to show: one line, not a heading each.
    matrix && shown.some(s => !s.rows.length) && h("div", {className: "insp-meta acc-empty-parts"},
      (onlyDiff || term ? "No differences in: " : "Nothing in: ") + shown.filter(s => !s.rows.length).map(s => s.title.replace(/ \(.*\)$/, "")).join(", ") + "."),
    matrix && shown.filter(s => s.rows.length).map(s => h("details", {key: s.key, className: "acc-section", open: s.rows.length < 60},
      h("summary", null, `${s.title.replace(/ \(R C E D.*\)$/, "")} · ${s.rows.length}`),
      h("div", {className: "insp-table-wrap"},
        h("table", {className: "insp-table acc-matrix"},
          h("thead", null, h("tr", null,
            h("th", null, SECTION_HEAD[s.key] || "Permission"),
            matrix.names.map((n, i) => h("th", {key: i, title: matrix.cols ? `${matrix.cols[i].item} · ${matrix.cols[i].org}${matrix.cols[i].kind ? " (" + matrix.cols[i].kind + ")" : ""}` : n},
              h("div", null, n),
              matrix.cols && matrix.names[i] !== matrix.cols[i].item && h("div", {className: "acc-th-sub"}, matrix.cols[i].item))),
            h("th", {className: "acc-what"}, "What differs"))),
          h("tbody", null, s.rows.slice(0, 1000).map(r => h("tr", {key: r.key, className: r.differs ? "acc-diff" : ""},
            h("td", {title: r.key}, r.label),
            r.values.map((v, i) => h("td", {key: i}, h(AccessCell, {section: s.key, value: v, row: r}))),
            h("td", {className: "acc-what"},
              r.differs ? describeRowDiff(s.key, r.values, matrix.names) : h("span", {className: "insp-meta"}, "Same"),
              r.differs && fromText(s, r) && h("div", {className: "acc-from"}, fromText(s, r)))))))))));
}

// ─── Risky access audit (facts first, AI summary optional) ──────────
const SECURITY_AUDIT_SYSTEM =
  "You are a Salesforce security reviewer helping an admin. From the facts given (active users holding " +
  "powerful system permissions and the profiles/permission sets that grant them), write a short report with " +
  "these sections in CAPITALS: SUMMARY, HIGHEST RISKS, WHO TO REVIEW, NEXT STEPS. Point out over-privileged " +
  "users, permissions granted by profiles that would be safer in permission sets, and quick wins. " +
  "Plain words, short bullet lines, no markdown tables.";

function auditFacts(summary) {
  const lines = ["Active users per risky permission:"];
  for (const p of summary.perms) {
    lines.push(`- ${p.label}: ${p.userCount} user(s); granted by ${p.sources.slice(0, 5).map(s => `${s.name} (${s.count})`).join(", ") || "—"}`);
  }
  lines.push("", "Users holding the most risky permissions:");
  for (const u of summary.users.slice(0, 25)) {
    lines.push(`- ${u.name} (${u.username}): ${u.perms.join(", ")} — via ${u.sources.join(", ")}`);
  }
  return lines.join("\n");
}

function RiskCard() {
  const [summary, setSummary] = useFfSession("access", "risk", null);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [report, setReport] = useFfSession("access", "riskReport", null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const byPerm = await riskyAssignments((done, total) => setProgress(`${done} of ${total} permissions checked`));
      setSummary({...summarizeRiskyAccess(byPerm), at: Date.now()});
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };
  const askAi = async () => {
    setAiErr(null);
    if (!hasValidConfig()) { setAiErr("NO_LLM_CONFIG"); return; }
    setAiBusy(true);
    try {
      setReport({text: await logsAskLlm(SECURITY_AUDIT_SYSTEM, auditFacts(summary), {feature: "Risky access summary"}), at: Date.now()});
    } catch (e) {
      setAiErr(e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message);
    } finally {
      setAiBusy(false);
    }
  };

  return h("div", {className: "org-card org-card-wide", "data-tour": "access-risk"},
    h(CardHead, {icon: "🛡️", title: "Risky Access Audit"},
      summary && h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy, onClick: askAi},
        aiBusy ? "Summarizing…" : "✨ Summarize with AI"),
      h("button", {className: "btn btn-primary btn-sm", disabled: running, onClick: run},
        running ? "Checking…" : summary ? "Run again" : "Run check")),
    !summary && !running && h(EmptyState, {art: "shield", title: "Who holds powerful permissions?",
      text: "Run the check to list active users with Modify All Data, View All Data, Manage Users, Author Apex and similar, and what grants them. Read-only."}),
    running && h("div", {className: "insp-status-info"}, progress || "Checking…"),
    error && h("div", {className: "insp-error"}, error),
    aiErr === "NO_LLM_CONFIG" && h("div", {className: "insp-warn"},
      "AI summary needs a provider + API key. ",
      h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")),
    aiErr && aiErr !== "NO_LLM_CONFIG" && h("div", {className: "insp-error"}, "AI request failed: " + aiErr),
    report && h(AnalysisReport, {
      text: report.text, copied,
      onCopy: () => {
        try { safeCopyText(report.text); } catch (e) { /* ignore */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }
    }),
    summary && h("div", {className: "org-grid acc-risk-grid"},
      h("div", null,
        h("div", {className: "sq3-card-sub"}, "Per permission"),
        h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null, h("tr", null, h("th", null, "Permission"), h("th", null, "Users"), h("th", null, "Granted by"))),
            h("tbody", null, summary.perms.map(p => h("tr", {key: p.field},
              h("td", null, p.label),
              h("td", null, h(FFBadge, {kind: p.userCount > 5 ? "warn" : p.userCount ? "info" : "ok"}, String(p.userCount))),
              h("td", {title: p.sources.map(s => `${s.name} (${s.count})`).join("\n")},
                p.sources.slice(0, 3).map(s => s.name).join(", ") || "—"))))))),
      h("div", null,
        h("div", {className: "sq3-card-sub"}, `Users with the most (${summary.users.length})`),
        h("div", {className: "insp-table-wrap"},
          h("table", {className: "insp-table"},
            h("thead", null, h("tr", null, h("th", null, "User"), h("th", null, "Risky permissions"))),
            h("tbody", null, summary.users.slice(0, 50).map(u => h("tr", {key: u.id},
              h("td", {title: u.username}, u.name),
              h("td", {title: "Via " + u.sources.join(", ")}, `${u.perms.length} · ${u.perms.join(", ")}`)))))))));
}

const ACCESS_VIEWS = [
  {id: "compare", label: "Compare", icon: "⚖️", hint: "Profiles, permission sets and groups side by side"},
  {id: "sharing", label: "Sharing settings", icon: "🔐", hint: "Org-wide defaults and sharing, org against org"},
  {id: "risk", label: "Risky access", icon: "🛡️", hint: "Who holds powerful system permissions"},
  {id: "approvals", label: "Approvals", icon: "✅", hint: "Your approval inbox, approve, reject and submit"},
];

function AccessTab() {
  const [view, setView] = useFfSession("access", "view", "compare");
  const cur = ACCESS_VIEWS.find(v => v.id === view) || ACCESS_VIEWS[0];
  return h("div", {className: "insp-panel"},
    h("div", {className: "x-subnav", role: "tablist", "aria-label": "Access tools"},
      ACCESS_VIEWS.map(v => h("button", {
        key: v.id,
        role: "tab",
        "aria-selected": cur.id === v.id,
        className: "x-subnav-btn" + (cur.id === v.id ? " active" : ""),
        onClick: () => setView(v.id)
      },
        h("span", {className: "x-subnav-ico", "aria-hidden": "true"}, v.icon),
        h("span", {className: "x-subnav-tx"},
          h("span", {className: "x-subnav-label"}, v.label),
          h("span", {className: "x-subnav-hint"}, v.hint))))),
    cur.id === "approvals"
      ? h(ApprovalsView, null)
      : h("div", {className: "org-grid"}, cur.id === "risk" ? h(RiskCard, null) : cur.id === "sharing" ? h(SharingCompareCard, null) : h(CompareCard, null)));
}

// ─── Users tab: "why does this user have access to X?" ─────────────
function UserAccessCheck({userId}) {
  const [kind, setKind] = React.useState("object");
  const [target, setTarget] = React.useState("");
  const [options, setOptions] = React.useState({object: [], system: []});
  const [sources, setSources] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let stale = false;
    setSources(null);
    setResult(null);
    userPermSources(userId).then(s => { if (!stale) setSources(s); })
      .catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [userId]);
  React.useEffect(() => {
    ffGetObjects().then(list => setOptions(o => ({...o, object: list.map(x => x.name)}))).catch(() => {});
    loadPermFieldNames().then(list => setOptions(o => ({...o, system: list}))).catch(() => {});
  }, []);

  const check = async () => {
    const t = target.trim();
    if (!t || !sources) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let rows;
      let flags;
      if (kind === "object") {
        rows = await objectPermRows(sources.ids, t);
        flags = OBJECT_PERM_FLAGS.map(([f, l]) => [f, l]);
      } else if (kind === "field") {
        if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(t)) throw new Error("Use Object.Field, e.g. Account.AnnualRevenue");
        rows = await fieldPermRows(sources.ids, t);
        flags = [["PermissionsRead", "Read"], ["PermissionsEdit", "Edit"]];
      } else {
        const field = t.startsWith("Permissions") ? t : "Permissions" + t.replace(/\s+/g, "");
        rows = await systemPermRows(sources.ids, field);
        flags = [[field, humanizePermission(field)]];
      }
      setResult({target: t, kind, ...effectiveAccess(rows, flags, sources.names)});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const listId = "usr-acc-opts-" + kind;
  const opts = kind === "object" ? options.object : kind === "system" ? options.system : [];
  return h("div", {className: "sq3-card"},
    h("div", {className: "sq3-card-h"}, h("span", {className: "sq3-card-t"}, "Why does this user have access?")),
    h("div", {className: "sq3-card-sub"},
      sources ? `Checks the profile and ${sources.ids.length - 1} permission set(s)/group(s) assigned to this user.` : "Loading assignments…"),
    h("div", {className: "soql-save-row acc-pick-row"},
      h("select", {
        className: "soql-save-input acc-kind",
        value: kind,
        "aria-label": "What to check",
        onChange: e => { setKind(e.target.value); setTarget(""); setResult(null); }
      },
        h("option", {value: "object"}, "Object"),
        h("option", {value: "field"}, "Field"),
        h("option", {value: "system"}, "System permission")),
      h("input", {
        className: "soql-save-input",
        value: target,
        list: listId,
        placeholder: kind === "object" ? "e.g. Account" : kind === "field" ? "e.g. Account.AnnualRevenue" : "e.g. PermissionsModifyAllData",
        "aria-label": "Object, field or permission to check",
        onChange: e => setTarget(e.target.value),
        onKeyDown: e => { if (e.key === "Enter") check(); }
      }),
      h("datalist", {id: listId}, opts.slice(0, 1500).map(o => h("option", {key: o, value: o},
        kind === "system" ? humanizePermission(o) : undefined))),
      h("button", {className: "btn btn-primary btn-sm", disabled: !target.trim() || !sources || busy, onClick: check},
        busy ? "Checking…" : "Check")),
    error && h("div", {className: "insp-error"}, error),
    result && h("div", null,
      h("div", {className: "acc-badges"},
        Object.entries(result.effective).map(([label, on]) =>
          h(FFBadge, {key: label, kind: on ? "ok" : "off"}, `${label} ${on ? "✓" : "✗"}`))),
      result.sources.length
        ? h("div", {className: "usr-kv"}, result.sources.map(s =>
            h("div", {key: s.id, className: "usr-kv-row"},
              h("span", {className: "usr-kv-v"}, s.name),
              h("span", {className: "usr-kv-k"}, s.grants.join(", ")))))
        : h("div", {className: "insp-meta"}, `Nothing this user holds grants access to ${result.target}.`)));
}

export {AccessTab, UserAccessCheck};
