import {hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {
  buildCompareMatrix, filterMatrix, effectiveAccess, summarizeRiskyAccess,
  humanizePermission, OBJECT_PERM_FLAGS
} from "../../core/access.js";
import {
  loadPermSetList, loadPermFieldNames, loadCompareData, userPermSources,
  objectPermRows, fieldPermRows, systemPermRows, riskyAssignments
} from "../shared/access-data.js";
import {ffGetObjects} from "../shared/describe.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {logsAskLlm} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {FFBadge} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {ApprovalsView} from "./approvals.js";

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
function CompareCard() {
  const [list, setList] = React.useState(null);
  const [listErr, setListErr] = React.useState(null);
  const [picked, setPicked] = useFfSession("access", "picked", []);
  const [choice, setChoice] = React.useState("");
  const [matrix, setMatrix] = useFfSession("access", "matrix", null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [onlyDiff, setOnlyDiff] = React.useState(true);
  const [term, setTerm] = React.useState("");

  React.useEffect(() => {
    loadPermSetList().then(setList).catch(e => setListErr(e.message));
  }, []);

  const nameOf = id => (list && (list.find(p => p.id === id) || {}).name) || id;
  const add = () => {
    if (!choice || picked.includes(choice) || picked.length >= MAX_COMPARE) return;
    setPicked([...picked, choice]);
    setChoice("");
  };
  const compare = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadCompareData(picked);
      setMatrix({ids: picked, names: picked.map(nameOf), sections: buildCompareMatrix(data)});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  const shown = matrix ? filterMatrix(matrix.sections, {onlyDiff, term}) : [];
  const exportCsv = () => {
    const cols = ["Section", "Permission", ...matrix.names];
    const rows = [];
    for (const s of matrix.sections) {
      for (const r of s.rows) {
        const row = {Section: s.title, Permission: r.label};
        matrix.names.forEach((n, i) => { row[n] = r.values[i]; });
        rows.push(row);
      }
    }
    downloadText("permission-compare.csv", toCsv(cols, rows));
  };
  const groups = [["profile", "Profiles"], ["set", "Permission sets"], ["group", "Permission set groups"]];

  return h("div", {className: "org-card org-card-wide", "data-tour": "access-compare"},
    h(CardHead, {icon: "⚖️", title: "Compare Profiles & Permission Sets"},
      matrix && h("button", {className: "btn btn-secondary btn-sm", onClick: exportCsv}, "Download CSV")),
    h("div", {className: "sq3-card-sub"},
      `Pick 2–${MAX_COMPARE} profiles, permission sets or groups to see system, object, tab and app permissions side by side.`),
    listErr && h("div", {className: "insp-error"}, "Could not list permission sets: " + listErr),
    h("div", {className: "soql-save-row acc-pick-row"},
      h("select", {
        className: "soql-save-input",
        value: choice,
        "aria-label": "Profile or permission set to compare",
        disabled: !list || picked.length >= MAX_COMPARE,
        onChange: e => setChoice(e.target.value)
      },
        h("option", {value: ""}, !list ? "Loading…" : picked.length >= MAX_COMPARE ? `Up to ${MAX_COMPARE} at a time` : "Choose a profile or permission set"),
        list && groups.map(([kind, label]) => h("optgroup", {key: kind, label},
          list.filter(p => p.kind === kind && !picked.includes(p.id))
            .map(p => h("option", {key: p.id, value: p.id}, p.name))))),
      h("button", {className: "btn btn-secondary btn-sm", disabled: !choice, onClick: add}, "Add"),
      h("button", {
        className: "btn btn-primary btn-sm",
        disabled: picked.length < 2 || loading,
        onClick: compare
      }, loading ? "Comparing…" : "Compare")),
    picked.length > 0 && h("div", {className: "insp-chips"},
      picked.map(id => h("button", {
        key: id,
        className: "insp-chip",
        title: "Remove from comparison",
        onClick: () => setPicked(picked.filter(x => x !== id))
      }, nameOf(id), " ×"))),
    error && h("div", {className: "insp-error"}, error),
    matrix && h("div", {className: "acc-toolbar"},
      h("label", {className: "sq3-check"},
        h("input", {type: "checkbox", checked: onlyDiff, onChange: e => setOnlyDiff(e.target.checked)}),
        h("span", null, "Only differences")),
      h("input", {
        className: "soql-save-input acc-filter",
        value: term,
        placeholder: "filter permissions…",
        "aria-label": "Filter permissions",
        onChange: e => setTerm(e.target.value)
      })),
    matrix && shown.map(s => h("details", {key: s.key, className: "acc-section", open: s.key !== "tabs"},
      h("summary", null, `${s.title} · ${s.rows.length}`),
      s.rows.length
        ? h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table acc-matrix"},
              h("thead", null, h("tr", null,
                h("th", null, "Permission"),
                matrix.names.map((n, i) => h("th", {key: i}, n)))),
              h("tbody", null, s.rows.map(r => h("tr", {key: r.key, className: r.differs ? "acc-diff" : ""},
                h("td", {title: r.key}, r.label),
                r.values.map((v, i) => h("td", {key: i}, v)))))))
        : h("div", {className: "insp-meta"}, onlyDiff ? "No differences." : "Nothing granted."))));
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
      setReport({text: await logsAskLlm(SECURITY_AUDIT_SYSTEM, auditFacts(summary)), at: Date.now()});
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
    !summary && !running && h("div", {className: "insp-hint-strip"},
      "Lists active users who hold powerful system permissions (Modify All Data, View All Data, Manage Users, " +
      "Author Apex …) and what grants them. Read-only."),
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
      : h("div", {className: "org-grid"}, cur.id === "risk" ? h(RiskCard, null) : h(CompareCard, null)));
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
