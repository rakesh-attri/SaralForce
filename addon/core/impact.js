// Impact analysis ("safe to change or delete?"): verdict and grouping from
// what references a component. Pure.
import {typeLabel} from "./deploy.js";

export const IMPACT_TYPES = ["CustomField", "CustomObject", "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent",
  "LightningComponentBundle", "AuraDefinitionBundle", "Flow", "CustomLabel", "StaticResource", "ValidationRule", "Layout"];

// MetadataComponentDependency rows → [{type, items: [{name, id}]}]
export function groupRefs(rows, side) {
  const by = new Map();
  for (const r of rows) {
    const type = side === "usedBy" ? r.MetadataComponentType : r.RefMetadataComponentType;
    const name = side === "usedBy" ? r.MetadataComponentName : r.RefMetadataComponentName;
    const id = side === "usedBy" ? r.MetadataComponentId : r.RefMetadataComponentId;
    if (!by.has(type)) by.set(type, new Map());
    by.get(type).set(id || name, {name, id});
  }
  return [...by.entries()].map(([type, m]) => ({type, label: typeLabel(type), items: [...m.values()].sort((a, b) => a.name.localeCompare(b.name))}))
    .sort((a, b) => b.items.length - a.items.length);
}

// Word match of an API name in code, skipping comments.
export function codeMentions(code, apiName) {
  const clean = String(code || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const name = String(apiName || "").replace(/[^\w]/g, "");
  if (!name) return 0;
  const re = new RegExp("(^|[^\\w])" + name + "(?![\\w])", "gi");
  return (clean.match(re) || []).length;
}

// {usedBy: groups, codeMatches: [{type, name}], dataCount: n|null, activeFlows: [names]}
// → {level: "safe"|"warn"|"block", title, reasons: []}
export function impactVerdict({usedBy = [], codeMatches = [], dataCount = null, activeFlows = [], forDelete = true, dataUnknown = false}) {
  const refs = usedBy.reduce((n, g) => n + g.items.length, 0);
  const reasons = [];
  if (refs) reasons.push(`${refs} component(s) use it: ${usedBy.map(g => `${g.items.length} ${g.label.toLowerCase()}`).join(", ")}.`);
  if (codeMatches.length) reasons.push(`Named in the code of ${codeMatches.length} class(es), trigger(s) or page(s) (text match; check them).`);
  if (dataCount) reasons.push(`${dataCount.toLocaleString()} record(s) have data${forDelete ? " that a delete removes" : ""}.`);
  if (activeFlows.length) reasons.push(`Used by active flow(s): ${activeFlows.join(", ")}.`);
  if (activeFlows.length || (forDelete && dataCount)) {
    return {level: "block", title: forDelete ? "Not safe to delete yet" : "High impact", reasons};
  }
  if (refs || codeMatches.length) return {level: "warn", title: `Used in ${refs + codeMatches.length} place(s)`, reasons};
  if (dataUnknown) return {level: "warn", title: "Check the data first", reasons: ["No references found, but SaralForce could not count the records that hold data. Check with a report or Export before deleting."]};
  return {level: "safe", title: "No references found", reasons: ["Nothing in the org's dependency data or code refers to it." +
    (dataCount === 0 ? " It has no data." : "")]};
}

// Text for the AI risk summary.
export function impactForPrompt({type, name, org, usedBy, uses, codeMatches, dataCount, activeFlows, verdict}) {
  const lines = [`${type} ${name} in ${org}. Verdict: ${verdict.title}.`];
  lines.push("Used by:", ...usedBy.flatMap(g => g.items.slice(0, 30).map(i => `- ${g.type} ${i.name}`)));
  lines.push("It uses:", ...uses.flatMap(g => g.items.slice(0, 20).map(i => `- ${g.type} ${i.name}`)));
  if (codeMatches.length) lines.push("Named in code:", ...codeMatches.slice(0, 20).map(c => `- ${c.type} ${c.name}`));
  if (dataCount != null) lines.push(`Records with data: ${dataCount}`);
  if (activeFlows.length) lines.push(`Active flows using it: ${activeFlows.join(", ")}`);
  return lines.join("\n");
}

// Why a flow delete fails ("insufficient access rights on cross-reference id"):
// an active version, paused or waiting runs, or metadata that still uses it.
// list: [{name, found, versions: [{number, status}], active, interviews: [{label, status}], interviewsGuessed, usedBy: [{type, name}], notes: []}]
// → {blocked: [names], clear: [names], text}
export function flowDeleteReport(list) {
  const lines = [];
  const blocked = [];
  const clear = [];
  for (const f of list) {
    if (!f.found) { lines.push(`✓ ${f.name}: not in the target, nothing to delete.`); continue; }
    const why = [];
    if (f.active) why.push(`version ${f.active} is active (deactivate it)`);
    if (f.interviews.length) {
      why.push(`${f.interviews.length} ${f.interviewsGuessed ? "possible " : ""}paused or waiting run(s): ` +
        f.interviews.slice(0, 5).map(i => i.label + (i.status ? ` (${i.status})` : "")).join(", ") + (f.interviews.length > 5 ? "…" : "") +
        " (Setup → Paused and Failed Flow Interviews)");
    }
    if (f.usedBy.length) {
      why.push("used by " + f.usedBy.slice(0, 8).map(u => `${typeLabel(u.type)} ${u.name}`).join(", ") + (f.usedBy.length > 8 ? "…" : ""));
    }
    const versions = f.versions.length ? ` [${f.versions.length} version(s): ${f.versions.map(v => `v${v.number} ${v.status}`).join(", ")}]` : "";
    if (why.length) { blocked.push(f.name); lines.push(`✗ ${f.name}${versions}: ` + why.join("; ") + "."); }
    else {
      clear.push(f.name);
      lines.push(`? ${f.name}${versions}: nothing found blocking it. Check queued scheduled-path actions (Setup → Time-Based Workflow), or delete it with the Tooling API.`);
    }
    for (const n of f.notes || []) lines.push(`   · ${n}`);
  }
  return {blocked, clear, text: lines.join("\n")};
}
