// Org Handbook, phase 2 (pure): answer questions from the handbook, an
// onboarding checklist, who works on a record, record pages explained and
// what changed lately. The org reads live in inspector/shared/org-guide-data.js.
import {flowStory, storyText} from "./flow-story.js";
import {triggerOutline} from "./code-outline.js";
import {an} from "./handbook.js";

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lc = s => String(s || "").toLowerCase();

// ── Ask the org ────────────────────────────────────────────────────────
const STOP = new Set(("a an the of to in on for and or is are was were be been when what which who whom why how does do did can could " +
  "it its this that these those my our your i we you they them with from by at as if then than so not no yes get gets happen happens " +
  "about there here any all some each every into out up down over under after before while where record records").split(" "));

export function words(text) {
  return [...new Set(lc(text).replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/)
    .map(w => w.replace(/__c$/, "").replace(/_/g, " ").trim()).flatMap(w => w.split(" "))
    // Light stemming, the same on both sides: close / closed / closing → clos.
    .filter(w => w.length > 2 && !STOP.has(w)).map(w => (w.length > 4 ? w.replace(/(ies|ing|ed|es|e|s)$/, "") : w.replace(/s$/, ""))))];
}

const score = (qw, text) => {
  const tw = new Set(words(text));
  return qw.reduce((s, w) => s + (tw.has(w) ? 1 : 0), 0);
};

// The handbook parts that best match a question (flows, processes, rules, triggers).
export function retrieve(hb, items, question, {maxFlows = 8} = {}) {
  const qw = words(question);
  const flowsById = new Map(asList(items && items.flows).map(f => [`flow:${lc(f.name)}`, f]));
  const flows = hb.flows.map(f => {
    const meta = (flowsById.get(f.id) || {}).meta;
    const story = meta ? storyText(flowStory(meta)) : f.summary;
    return {f, story, s: score(qw, `${f.label} ${f.name} ${f.object} ${f.summary}`) * 3 + score(qw, story)};
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, maxFlows);
  const processes = hb.processes.map(p => ({p, s: score(qw, `${p.label} ${p.object} ${p.columns.map(c => c.label).join(" ")}`)}))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  // Objects the question names pull in their rules and triggers too.
  const objects = new Set(processes.map(x => lc(x.p.object)));
  for (const x of flows) if (x.f.object) objects.add(lc(x.f.object));
  const rules = asList(items && items.rules).filter(r => r.active !== false)
    .map(r => ({r, s: score(qw, `${r.name} ${r.message} ${r.formula} ${r.object}`) + (objects.has(lc(r.object)) ? 1 : 0)}))
    .filter(x => x.s > 1 || (x.s > 0 && objects.has(lc(x.r.object)))).sort((a, b) => b.s - a.s).slice(0, 8);
  const triggers = asList(items && items.triggers).filter(t => objects.has(lc(t.object)) || score(qw, t.name) > 0).slice(0, 5);
  return {flows, processes, rules, triggers, words: qw};
}

// Context text for the AI: only what the handbook knows, each part tagged
// with the reference the answer must cite.
export function askContext(hb, items, question) {
  const r = retrieve(hb, items, question);
  const out = [];
  if (hb.business) out.push("BUSINESS SUMMARY", hb.business.slice(0, 2000), "");
  const procs = r.processes.length ? r.processes.map(x => x.p) : hb.processes.slice(0, 2);
  for (const p of procs) {
    out.push(`[process:${p.object}] Life of ${an(p.label)} ${p.label}${p.stageField ? ` (stages by ${p.stageField.label}: ${p.columns.filter(c => !c.id.startsWith("@")).map(c => c.label).join(" → ")})` : ""}`);
    for (const l of p.lanes) {
      for (const [col, chips] of Object.entries(l.cells)) {
        out.push(`  - ${l.label} at "${col === "@any" ? "any change" : col === "@create" ? "created" : col}": ${chips.map(c => `[${c.ref}] ${c.label}`).join(", ")}`);
      }
    }
    for (const m of p.moves) out.push(`  - [${m.by.ref}] ${m.by.label} moves it to "${m.to}"`);
  }
  for (const x of r.flows) out.push("", `[${x.f.id}] Flow "${x.f.label}"`, x.story.slice(0, 1800));
  for (const x of r.rules) out.push("", `[rule:${lc(x.r.object)}.${lc(x.r.name)}] Validation rule ${x.r.name} on ${x.r.object}: blocks saving when ${x.r.formula || "(formula not read)"}. Message: "${x.r.message}"`);
  for (const t of r.triggers) {
    const o = triggerOutline(t.body);
    out.push("", `[trigger:${lc(t.name)}] Apex trigger ${t.name} on ${t.object} (${o.events.join(", ")}); hands work to ${o.calls.join(", ") || "its own code"}`);
  }
  if (!r.flows.length && !r.rules.length) {
    out.push("", "Other flows in the org:", ...hb.flows.slice(0, 30).map(f => `[${f.id}] ${f.label}: ${f.summary}`));
  }
  return {text: out.join("\n").slice(0, 14000), found: r};
}

// "… see [flow:route_vip]" → [{text}, {ref, label}, {text}]; unknown refs stay text.
export function parseCitations(text, labelOf) {
  const out = [];
  const re = /\[((?:flow|rule|trigger|class|process|lwc|aura):[^\]\s]+)\]/gi;
  let last = 0;
  let m;
  const src = String(text || "");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({text: src.slice(last, m.index)});
    const ref = m[1].replace(/^(\w+):/, (x, t) => t.toLowerCase() + ":");
    const label = labelOf(ref);
    out.push(label ? {ref, label} : {text: m[0]});
    last = re.lastIndex;
  }
  if (last < src.length) out.push({text: src.slice(last)});
  return out;
}

// Questions a new joiner could start with, from this org.
export function suggestedQuestions(hb) {
  const q = [];
  const p = hb.processes[0];
  if (p) {
    const stages = p.columns.filter(c => !c.id.startsWith("@"));
    if (stages.length) q.push(`What happens when ${an(p.label)} ${p.label} becomes ${stages[stages.length - 1].label}?`);
    q.push(`What runs when a new ${p.label} is created?`);
  }
  const email = hb.flows.find(f => /email|notify|alert/i.test(f.summary));
  if (email) q.push("Which flows send emails?");
  const rule = hb.processes.find(x => x.lanes.some(l => l.id === "checks"));
  if (rule) q.push(`Why can't I save ${an(rule.label)} ${rule.label}?`);
  q.push("Where should a new developer start?");
  return q.slice(0, 5);
}

// ── Onboarding checklist ─────────────────────────────────────────────
export function buildChecklist(hb) {
  const items = [];
  items.push({id: "home", text: "Read “How the business works” and the departments", why: "The big picture: who does what.", go: {tab: "home"}});
  for (const p of hb.processes.slice(0, 3)) {
    items.push({id: `process:${p.object}`, text: `Learn the life of ${an(p.label)} ${p.label}`, why: `${p.counts.flows} flows, ${p.counts.triggers} triggers and ${p.counts.rules} rules act on it.`,
      go: {tab: "processes", ref: p.object}});
  }
  const key = hb.flows.filter(f => f.kind === "record").sort((a, b) => b.steps - a.steps).slice(0, 4);
  for (const f of key) items.push({id: f.id, text: `Read the flow “${f.label}”`, why: f.summary, go: {tab: "flows", ref: f.id}});
  for (const f of hb.flows.filter(x => x.kind === "screen").slice(0, 2)) {
    items.push({id: `try:${f.id}`, text: `Try the screen flow “${f.label}” in a sandbox`, why: "See what users click through.", go: {tab: "flows", ref: f.id}, manual: true});
  }
  items.push({id: "glossary", text: "Learn the words: stages, options and record types", why: "The org's own vocabulary.", go: {tab: "home", ref: "glossary"}});
  items.push({id: "ask", text: "Ask the org one question you still have", why: "Answers come from this handbook, with links.", go: {tab: "ask"}});
  items.push({id: "changes", text: "See what changed recently", why: "Know what's new before you touch it.", go: {tab: "changes"}});
  return items;
}

export function checklistProgress(list, done) {
  const d = list.filter(i => done && done[i.id]).length;
  return {done: d, total: list.length, pct: list.length ? Math.round((d / list.length) * 100) : 0};
}

// ── Who works on a record ────────────────────────────────────────────
// rows: ObjectPermissions with Parent{Label, IsOwnedByProfile, Profile{Name}};
// users: {permissionSetId: active users}. → [{name, kind, access, users}]
export function accessSummary(rows, users = {}) {
  const ACCESS = [["PermissionsRead", "Read"], ["PermissionsCreate", "Create"], ["PermissionsEdit", "Edit"], ["PermissionsDelete", "Delete"],
    ["PermissionsViewAllRecords", "View all"], ["PermissionsModifyAllRecords", "Modify all"]];
  return asList(rows).filter(r => r.PermissionsRead).map(r => {
    const p = r.Parent || {};
    const profile = p.IsOwnedByProfile;
    return {
      id: r.ParentId, name: profile ? ((p.Profile && p.Profile.Name) || p.Label) : (p.Label || p.Name), kind: profile ? "Profile" : "Permission set",
      access: ACCESS.filter(([f]) => r[f]).map(([, l]) => l), users: users[r.ParentId] || 0,
    };
  }).filter(x => x.users > 0 || x.kind === "Permission set")
    .sort((a, b) => b.users - a.users || b.access.length - a.access.length || a.name.localeCompare(b.name));
}

// ── Record pages explained ───────────────────────────────────────────
const STD_COMPONENTS = {
  "force:highlightsPanel": "Highlights: the key fields and the main buttons", "force:detailPanel": "Record details (the page layout's fields)",
  "force:recordDetailPanelMobile": "Record details (phone)", "force:relatedListContainer": "Related lists",
  "force:relatedListSingleContainer": "One related list", "runtime_sales_activities:activityPanel": "Activity: tasks, calls, emails and events",
  "forceChatter:recordFeedContainer": "Chatter feed", "forceChatter:exposedFeed": "Chatter feed", "force:recordPathAssistant": "Path: the stage bar with guidance",
  "runtime_sales_pathassistant:pathAssistant": "Path: the stage bar with guidance", "flexipage:tabset": "Tabs", "flexipage:tab": "Tab",
  "flexipage:richText": "Rich text / instructions", "flexipage:reportChart": "Report chart", "flexipage:filterListCard": "List view",
  "force:relatedRecordContainer": "Related record", "runtime_service_einstein:case_classification": "Einstein case classification",
  "lst:dynamicRelatedList": "Dynamic related list", "flexipage:fieldSection": "Field section", "record_flexipage:dynamicHighlights": "Dynamic highlights",
  "flexipage:visualforcePage": "Visualforce page", "flexipage:aura": "Aura component", "knowledge_one:knowledgeArticleSearch": "Knowledge articles",
};
const propOf = (inst, name) => (asList(inst.componentInstanceProperties).find(p => p.name === name) || {}).value;

// FlexiPage Metadata → {label, type, object, regions: [{name, components: [{name, label, kind, ref}]}]}.
export function explainFlexiPage(meta, {flowIds = new Set(), lwcNames = new Set()} = {}) {
  const m = meta || {};
  const regions = asList(m.flexiPageRegions).map(r => {
    const components = [];
    for (const it of asList(r.itemInstances)) {
      const ci = it.componentInstance;
      if (it.fieldInstance) continue;
      if (!ci || !ci.componentName) continue;
      const n = ci.componentName;
      if (n === "flowruntime:interview") {
        const flow = propOf(ci, "flowName");
        const ref = flow && flowIds.has(`flow:${lc(flow)}`) ? `flow:${lc(flow)}` : null;
        components.push({name: n, label: `Flow on the page: ${flow || "?"}`, kind: "flow", ref});
      } else if (/^c:/.test(n) || !n.includes(":")) {
        const name = n.replace(/^c:/, "");
        components.push({name: n, label: `Custom component: ${name}`, kind: lwcNames.has(lc(name)) ? "lwc" : "custom", ref: lwcNames.has(lc(name)) ? `lwc:${lc(name)}` : null});
      } else {
        components.push({name: n, label: STD_COMPONENTS[n] || n.split(":").pop().replace(/([a-z])([A-Z])/g, "$1 $2"), kind: "std", ref: null});
      }
    }
    return {name: r.name, type: r.type, components};
  }).filter(r => r.components.length && !/^(Facet|Background)/i.test(r.type || ""));
  return {label: m.masterLabel || "", type: m.type || "", object: m.sobjectType || "", regions};
}

// ── What changed lately ──────────────────────────────────────────────
const t = s => (s ? Date.parse(String(s).replace(/\+0000$/, "Z")) || 0 : 0);
export function changesSince(items, sinceMs) {
  const out = [];
  const add = (type, name, label, stamp, ref, extra = {}) => {
    if (!stamp) return;
    const created = t(stamp.created);
    const modified = t(stamp.modified);
    if (Math.max(created, modified) < sinceMs) return;
    out.push({type, name, label: label || name, ref, change: created >= sinceMs ? "new" : "changed",
      when: created >= sinceMs && (!modified || modified - created < 60000) ? created : modified, by: stamp.by || "", ...extra});
  };
  for (const f of asList(items.flows)) add("flow", f.name, f.label, f.stamp, `flow:${lc(f.name)}`);
  for (const x of asList(items.triggers)) add("trigger", x.name, x.name, x.stamp, `trigger:${lc(x.name)}`, {object: x.object});
  for (const x of asList(items.classes)) add("class", x.name, x.name, x.stamp, `class:${lc(x.name)}`);
  for (const x of asList(items.lwc)) add("lwc", x.name, x.label, x.stamp, `lwc:${lc(x.name)}`);
  for (const x of asList(items.aura)) add("aura", x.name, x.label, x.stamp, `aura:${lc(x.name)}`);
  for (const x of asList(items.rules)) add("rule", `${x.object}.${x.name}`, x.name, x.stamp, `rule:${lc(x.object)}.${lc(x.name)}`, {object: x.object});
  return out.sort((a, b) => b.when - a.when);
}
