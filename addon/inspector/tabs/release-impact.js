// Release Center → Impact: is it safe to change or delete a component?
// MetadataComponentDependency both ways, a code text search, a data check
// for fields and objects, active flows, then a verdict.
import {compKey, typeLabel, mergeMembers, keepListRow} from "../../core/deploy.js";
import {IMPACT_TYPES, groupRefs, codeMentions, impactVerdict, impactForPrompt} from "../../core/impact.js";
import {listComponents, queryAll} from "../shared/deploy-api.js";
import {explainImpact} from "../shared/ai.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {FFBadge} from "../shared/ui.js";
import {useRelease, setRelease, orgByHost, loadOrgs} from "./release-state.js";
import {CardHead, orgOptions, AiAnswer, AiError, OrgTag} from "./release-ui.js";

const h = React.createElement;
const TYPE_OPTIONS = IMPACT_TYPES.map(t => ({value: t, label: typeLabel(t), sub: t}));
const q = s => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

async function dependencies(conn, id) {
  const fields = "MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType";
  const [usedBy, uses] = await Promise.all([
    queryAll(conn, `SELECT ${fields} FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${q(id)}`, {tooling: true}),
    queryAll(conn, `SELECT ${fields} FROM MetadataComponentDependency WHERE MetadataComponentId = ${q(id)}`, {tooling: true})
  ]);
  return {usedBy: groupRefs(usedBy, "usedBy"), uses: groupRefs(uses, "uses"), capped: !!usedBy.truncated};
}

// Classes, triggers and VF pages whose code names the component.
// unchecked collects what could not be searched (a failed or capped query),
// so "nothing found" is never mistaken for "nothing there".
async function codeSearch(conn, type, fullName, onStatus, unchecked = []) {
  const name = type === "CustomField" ? fullName.split(".")[1] : fullName;
  onStatus("Searching Apex and Visualforce code…");
  const search = (what, soql) => queryAll(conn, soql, {tooling: true}).then(list => {
    if (list.truncated) unchecked.push(`Only the first ${list.length.toLocaleString()} ${what} were searched; the org has more.`);
    return list;
  }).catch(e => {
    unchecked.push(`Could not search ${what} (${e.message || e}).`);
    return [];
  });
  const [classes, triggers, pages] = await Promise.all([
    search("Apex classes", "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null"),
    search("Apex triggers", "SELECT Id, Name, Body FROM ApexTrigger WHERE NamespacePrefix = null"),
    search("Visualforce pages", "SELECT Id, Name, Markup FROM ApexPage WHERE NamespacePrefix = null")
  ]);
  const self = type === "ApexClass" || type === "ApexTrigger" || type === "ApexPage" ? fullName : "";
  const out = [];
  for (const [list, t, field] of [[classes, "ApexClass", "Body"], [triggers, "ApexTrigger", "Body"], [pages, "ApexPage", "Markup"]]) {
    for (const r of list) {
      if (r.Name === self) continue;
      const n = codeMentions(r[field], name);
      if (n) out.push({type: t, name: r.Name, count: n});
    }
  }
  return out;
}

async function dataCount(conn, type, fullName) {
  try {
    if (type === "CustomObject") {
      const r = await conn.client.query(`SELECT COUNT() FROM ${fullName}`);
      return r.totalSize;
    }
    if (type === "CustomField") {
      const [obj, field] = fullName.split(".");
      try {
        const r = await conn.client.query(`SELECT COUNT() FROM ${obj} WHERE ${field} != null`);
        return r.totalSize;
      } catch (e) {
        // Long text and some types can't be filtered: a sample can only prove data exists.
        const r = await conn.client.query(`SELECT ${field} FROM ${obj} ORDER BY CreatedDate DESC LIMIT 200`);
        const n = (r.records || []).filter(x => x[field] != null && x[field] !== false && x[field] !== "").length;
        return n > 0 ? n : null;
      }
    }
  } catch (e) { return null; }
  return null;
}

async function activeFlows(conn, groups, unchecked = []) {
  const flows = (groups.find(g => g.type === "Flow") || {items: []}).items.map(i => i.name);
  if (!flows.length) return [];
  const rows = await queryAll(conn, `SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName IN (${flows.map(q).join(",")})`).catch(e => {
    unchecked.push(`Could not check which of the ${flows.length} flow(s) using it are active (${e.message || e}).`);
    return [];
  });
  return rows.filter(r => r.IsActive).map(r => r.ApiName);
}

export async function analyzeImpact(org, type, fullName, onStatus) {
  onStatus(`Finding ${typeLabel(type)} ${fullName}…`);
  const listed = await listComponents(org.conn, [type]);
  const row = listed.get(compKey(type, fullName));
  if (!row && (listed.skipped || []).includes(type)) throw new Error(`Salesforce could not list ${typeLabel(type)} in ${org.name}, so ${fullName} could not be checked.`);
  if (!row || !row.id) throw new Error(`${typeLabel(type)} ${fullName} was not found in ${org.name} (or it is standard or from a package).`);
  onStatus("Reading the dependency data…");
  let deps = {usedBy: [], uses: []};
  let depNote = "";
  const unchecked = [];
  try {
    deps = await dependencies(org.conn, row.id);
    if (deps.capped) unchecked.push("The dependency data lists more than 2,000 references; only the first 2,000 are shown.");
  } catch (e) {
    depNote = "Salesforce's dependency data is not available here (" + e.message + "). Only the code search and data check were used.";
    unchecked.push("The dependency data could not be read, so components that use it may be missing.");
  }
  const code = ["CustomField", "CustomObject", "ApexClass", "CustomLabel"].includes(type)
    ? (await codeSearch(org.conn, type, fullName, onStatus, unchecked)).filter(c => !deps.usedBy.some(g => g.type === c.type && g.items.some(i => i.name === c.name)))
    : [];
  onStatus("Checking data and active flows…");
  const count = await dataCount(org.conn, type, fullName);
  const flows = await activeFlows(org.conn, deps.usedBy, unchecked);
  const verdict = impactVerdict({usedBy: deps.usedBy, codeMatches: code, dataCount: count, activeFlows: flows,
    dataUnknown: count == null && (type === "CustomField" || type === "CustomObject"), unchecked});
  return {org, type, fullName, id: row.id, ...deps, codeMatches: code, dataCount: count, activeFlows: flows, verdict, depNote, unchecked};
}

function RefGroups({groups, empty}) {
  if (!groups.length) return h("div", {className: "insp-meta"}, empty);
  return h("div", {className: "rel-members rel-refs"}, groups.map(g => h("div", {key: g.type, className: "rel-mtype"},
    h("div", {className: "rel-mtype-h"}, g.label, h("span", {className: "insp-meta"}, ` · ${g.items.length}`)),
    h("div", {className: "insp-chips"}, g.items.slice(0, 80).map(i => h("span", {key: i.id || i.name, className: "insp-chip rel-target"}, i.name))))));
}

const VERDICT_BADGE = {safe: "ok", warn: "warn", block: "err"};

export function ImpactView() {
  const st = useRelease();
  React.useEffect(() => { if (!st.orgs && !st.orgsBusy) loadOrgs(); }, []);
  const [host, setHost] = useFfSession("release", "impactHost", "");
  const [type, setType] = useFfSession("release", "impactType", "CustomField");
  const [name, setName] = useFfSession("release", "impactName", "");
  const [names, setNames] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [err, setErr] = React.useState("");
  const [result, setResult] = React.useState(null);
  const [destructive, setDestructive] = useFfSession("release", "destructive", {});
  const [added, setAdded] = React.useState(false);
  const [ai, setAi] = React.useState("");
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState("");
  const orgs = st.orgs || [];
  const org = orgByHost(host) || orgs.find(o => o.isCurrent) || null;

  // Handed over from Compare ("Check impact" on a delete).
  React.useEffect(() => {
    const t = st.impactTarget;
    if (!t) return;
    setHost(t.host); setType(t.type); setName(t.fullName);
    setRelease({impactTarget: null});
    run(t);
  }, [st.impactTarget]);

  React.useEffect(() => {
    if (!org) return;
    let stale = false;
    listComponents(org.conn, [type]).then(list => {
      if (!stale) setNames([...list.values()].filter(keepListRow).map(r => r.fullName).sort());
    }).catch(() => { if (!stale) setNames([]); });
    return () => { stale = true; };
  }, [org && org.host, type]);

  async function run(t) {
    const o = t ? orgByHost(t.host) : org;
    const ty = t ? t.type : type;
    const n = t ? t.fullName : name.trim();
    if (!o || !n) return;
    setBusy(true); setErr(""); setResult(null); setAi(""); setAiErr(""); setAdded(false);
    try {
      setResult(await analyzeImpact(o, ty, n, setStatus));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false); setStatus("");
    }
  }

  const addDelete = () => {
    setDestructive(mergeMembers(destructive, {[result.type]: [result.fullName]}));
    setAdded(true);
  };
  const askAi = async () => {
    setAiBusy(true); setAiErr("");
    try {
      setAi(await explainImpact(impactForPrompt({...result, name: result.fullName, org: result.org.name})));
    } catch (e) {
      setAiErr(e.message || String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const r = result;
  return h("div", {className: "org-grid"},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🎯", title: "Impact analysis"}),
      h("div", {className: "sq3-card-sub"}, "Before you change or delete something: what uses it, what it uses, whether it has data, and whether active flows depend on it."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Org"),
          h(SearchSelect, {value: org ? org.host : "", options: orgOptions(orgs), onChange: setHost, disabled: busy, ariaLabel: "Org"}),
          h(OrgTag, {org})),
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Type"),
          h(SearchSelect, {value: type, options: TYPE_OPTIONS, onChange: v => { setType(v); setName(""); }, disabled: busy, ariaLabel: "Type"})),
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Name"),
          h(SearchSelect, {value: name, options: names.map(n => ({value: n, label: n})), onChange: setName, allowFree: true, disabled: busy,
            ariaLabel: "Component name", placeholder: type === "CustomField" ? "Object__c.Field__c" : "API name", emptyText: "Type the API name"})),
        h("button", {className: "btn btn-primary btn-sm", disabled: busy || !org || !name.trim(), onClick: () => run()}, busy ? "Checking…" : "Check impact")),
      busy && h("div", {className: "tr-progress"},
        h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
        h("span", {className: "insp-meta"}, status)),
      err && h("div", {className: "insp-error"}, err)),

    r && h("div", {className: "org-card org-card-wide", "data-release-impact": ""},
      h(CardHead, {icon: r.verdict.level === "safe" ? "✅" : r.verdict.level === "warn" ? "⚠️" : "⛔", title: `${typeLabel(r.type)} ${r.fullName} · ${r.org.name}`},
        h("button", {className: "btn btn-secondary btn-sm", disabled: aiBusy, onClick: askAi}, aiBusy ? "Thinking…" : "✨ Risk summary")),
      h("div", {className: "rel-verdict rel-verdict-" + r.verdict.level},
        h(FFBadge, {kind: VERDICT_BADGE[r.verdict.level]}, r.verdict.title),
        h("ul", null, r.verdict.reasons.map((x, i) => h("li", {key: i}, x)))),
      r.depNote && h("div", {className: "insp-warn"}, r.depNote),
      ai && h(AiAnswer, {title: "Risk summary", text: ai, onClose: () => setAi("")}),
      h(AiError, {error: aiErr}),
      h("div", {className: "rel-label"}, "Used by"),
      h(RefGroups, {groups: r.usedBy, empty: "Nothing in the dependency data uses it."}),
      r.codeMatches.length > 0 && h("div", {className: "rel-label"}, "Named in code (text search)"),
      r.codeMatches.length > 0 && h("div", {className: "insp-chips"}, r.codeMatches.map(c => h("span", {key: c.type + c.name, className: "insp-chip rel-target"},
        `${typeLabel(c.type)} ${c.name}${c.count > 1 ? ` ×${c.count}` : ""}`))),
      h("div", {className: "rel-label"}, "It uses"),
      h(RefGroups, {groups: r.uses, empty: "It doesn't depend on other components."}),
      h("div", {className: "insp-meta rel-note"}, "The dependency data doesn't cover everything (for example reports, dynamic SOQL and some formula references). Check the most important places by hand."),
      h("div", {className: "rel-actionbar"},
        added && h("span", {className: "insp-status-ok"}, "Added to the delete list in Package."),
        h("button", {className: "btn btn-secondary btn-sm", disabled: added, onClick: addDelete,
          title: r.verdict.level === "safe" ? "" : "It is still used: delete those references first"},
          r.verdict.level === "safe" ? "Add to delete list" : "Add to delete list anyway"))));
}
