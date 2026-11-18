// Org Handbook: the onboarding view of an org for someone who just joined.
// Departments (apps and their objects), business processes ("the life of a
// Case": its stages × when automation runs), a library of every flow with a
// plain-English summary, a glossary and a "start here" reading list.
// Pure: builds on core/org-guide.js (graph) and core/flow-story.js (flows).
import {buildGuideGraph, areaRanking, GUIDE_TYPES} from "./org-guide.js";
import {flowKind, flowSummary, flowStory} from "./flow-story.js";
import {triggerOutline} from "./code-outline.js";

// "a Case" / "an Account".
export const an = w => (/^[aeiou]/i.test(String(w || "")) ? "an" : "a");
export const An = w => (an(w) === "an" ? "An" : "A");

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lc = s => String(s || "").toLowerCase();

// The field that holds a record's stage: StageName, Status, Status__c, …
export function stageFieldOf(info) {
  const picks = asList(info && info.picklists);
  return picks.find(p => p.name === "StageName") || picks.find(p => p.name === "Status") ||
    picks.find(p => /^(Status|Stage)__c$/i.test(p.name)) || picks.find(p => /(Status|Stage)/i.test(p.name)) || null;
}

// Stage values a flow / rule mentions: filters, decisions, ISPICKVAL / TEXT().
function flowStageValues(meta, field) {
  const vals = new Set();
  const isField = ref => new RegExp(`(^|\\.)${field}$`, "i").test(String(ref || ""));
  const valOf = v => (v && v.stringValue != null ? v.stringValue : null);
  const s = (meta && meta.start) || {};
  for (const f of asList(s.filters)) if (isField(f.field) && /EqualTo|IsChanged/.test(f.operator || "EqualTo")) { const v = valOf(f.value); if (v) vals.add(v); }
  for (const d of asList(meta && meta.decisions)) {
    for (const r of asList(d.rules)) for (const c of asList(r.conditions)) if (isField(c.leftValueReference) && valOf(c.rightValue)) vals.add(valOf(c.rightValue));
  }
  return [...vals];
}
function formulaStageValues(formula, field) {
  const vals = new Set();
  const f = String(formula || "");
  for (const m of f.matchAll(new RegExp(`ISPICKVAL\\s*\\(\\s*${field}\\s*,\\s*"([^"]+)"\\s*\\)`, "gi"))) vals.add(m[1]);
  for (const m of f.matchAll(new RegExp(`TEXT\\s*\\(\\s*${field}\\s*\\)\\s*=\\s*"([^"]+)"`, "gi"))) vals.add(m[1]);
  return [...vals];
}
// Stage values a flow sets on the record ("moves it to Escalated").
function flowSetsStage(meta, field) {
  const out = [];
  for (const u of asList(meta && meta.recordUpdates)) {
    if (!/^\$Record$/.test(u.inputReference || "")) continue;
    for (const a of asList(u.inputAssignments)) if (a.field === field && a.value && a.value.stringValue) out.push(a.value.stringValue);
  }
  for (const a of asList(meta && meta.assignments)) {
    for (const it of asList(a.assignmentItems)) {
      if (new RegExp(`^\\$Record\\.${field}$`).test(it.assignToReference || "") && it.value && it.value.stringValue) out.push(it.value.stringValue);
    }
  }
  return [...new Set(out)];
}

export const LANES = [
  {id: "before", label: "Before save", hint: "fills in or fixes fields before the record is stored"},
  {id: "checks", label: "Checks", hint: "validation rules: can stop the save"},
  {id: "after", label: "After save", hint: "follow-up work once the record is stored"},
  {id: "later", label: "Later / scheduled", hint: "runs on a schedule or after a delay"},
];

// The life of one object's records: columns are "Created", "Any change" and
// each stage value; lanes are when the automation runs.
export function lifecycle(objectName, items, info) {
  const sf = stageFieldOf(info);
  const stages = sf ? asList(sf.values).slice(0, 10) : [];
  const columns = [{id: "@create", label: "Created"}, {id: "@any", label: "Any change"},
    ...stages.map(v => ({id: v, label: v}))];
  const known = new Set(columns.map(c => c.id));
  const cells = {}; // lane → col → [chips]
  const add = (lane, col, chip) => {
    const c = known.has(col) ? col : "@any";
    ((cells[lane] = cells[lane] || {})[c] = cells[lane][c] || []).push(chip);
  };
  const moves = [];
  const obj = lc(objectName);
  for (const f of asList(items.flows)) {
    const s = (f.meta && f.meta.start) || {};
    if (lc(s.object) !== obj) continue;
    const k = flowKind(f.meta);
    const lane = k.kind === "scheduled" || asList(s.scheduledPaths).length ? "later" : s.triggerType === "RecordBeforeSave" ? "before" : "after";
    const chip = {ref: `flow:${lc(f.name)}`, type: "flow", label: f.label || f.name};
    const vals = sf ? flowStageValues(f.meta, sf.name) : [];
    if (vals.length) vals.forEach(v => add(lane, v, chip));
    else add(lane, s.recordTriggerType === "Create" ? "@create" : "@any", chip);
    if (sf) for (const v of flowSetsStage(f.meta, sf.name)) moves.push({to: v, by: chip});
  }
  for (const t of asList(items.triggers)) {
    if (lc(t.object) !== obj) continue;
    const ev = triggerOutline(t.body).events;
    const onlyInsert = ev.length && ev.every(e => /insert/.test(e));
    const chip = {ref: `trigger:${lc(t.name)}`, type: "trigger", label: t.name};
    if (ev.some(e => e.startsWith("before"))) add("before", onlyInsert ? "@create" : "@any", chip);
    if (ev.some(e => e.startsWith("after"))) add("after", onlyInsert ? "@create" : "@any", chip);
  }
  for (const r of asList(items.rules)) {
    if (lc(r.object) !== obj || r.active === false) continue;
    const chip = {ref: `rule:${lc(r.object)}.${lc(r.name)}`, type: "rule", label: r.name};
    const vals = sf ? formulaStageValues(r.formula, sf.name) : [];
    if (vals.length) vals.forEach(v => add("checks", v, chip));
    else add("checks", "@any", chip);
  }
  const lanes = LANES.filter(l => cells[l.id]).map(l => ({...l, cells: cells[l.id]}));
  return {object: objectName, label: (info && info.label) || objectName, stageField: sf ? {name: sf.name, label: sf.label} : null,
    columns: columns.filter(c => c.id !== "@create" || lanes.some(l => l.cells["@create"])), lanes, moves};
}

// Every flow, for the library.
export function flowLibrary(items, graph) {
  const calledBy = new Map();
  for (const e of graph.edges) {
    if (e.kind === "subflow" || e.kind === "apex-action") {
      const k = e.to;
      (calledBy.get(k) || calledBy.set(k, []).get(k)).push(e.from);
    }
  }
  return asList(items.flows).map(f => {
    const id = `flow:${lc(f.name)}`;
    const k = flowKind(f.meta);
    const st = flowStory(f.meta);
    return {
      id, name: f.name, label: f.label || f.name, kind: k.kind, kindLabel: k.label, timing: k.timing || "",
      object: k.object || "", summary: flowSummary(f.meta), steps: st.steps.length,
      screens: st.steps.filter(s => s.person).length,
      calledBy: calledBy.get(id) || [],
      calls: graph.edges.filter(e => e.from === id && (e.kind === "subflow" || e.kind === "apex-action")).map(e => e.to),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export const FLOW_KIND_LABEL = {
  record: "Runs when a record is saved", screen: "Screen flows (a person clicks through)", scheduled: "Scheduled",
  event: "Platform events", called: "Called by other automation",
};

// extras: {apps: [{name, label, tabs: [{label, object}]}], objectInfo: {Case: {label, picklists, recordTypes, description}}}
export function buildHandbook(items, extras = {}, {orgName = "", maxProcesses = 8} = {}) {
  const graph = buildGuideGraph(items);
  const counts = {};
  for (const n of graph.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  counts.flow = asList(items.flows).length;
  const ranking = areaRanking(graph);
  const info = extras.objectInfo || {};
  const infoOf = name => info[name] || info[Object.keys(info).find(k => lc(k) === lc(name))] || null;
  const busy = new Map(ranking.map(r => [lc(r.name), r]));

  const departments = asList(extras.apps).map(a => ({
    name: a.name, label: a.label, description: a.description || "",
    objects: asList(a.tabs).filter(t => t.object).map(t => ({name: t.object, label: t.label,
      automations: (busy.get(lc(t.object)) || {}).total || 0})),
  })).filter(d => d.objects.length).sort((a, b) =>
    b.objects.reduce((s, o) => s + o.automations, 0) - a.objects.reduce((s, o) => s + o.automations, 0) || a.label.localeCompare(b.label));

  const processes = ranking.slice(0, maxProcesses).map(r => {
    const life = lifecycle(r.name, items, infoOf(r.name));
    return {...life, label: (infoOf(r.name) || {}).label || r.label, counts: {triggers: r.triggers, flows: r.flows, rules: r.rules}, total: r.total};
  });

  const flows = flowLibrary(items, graph);

  const glossary = processes.map(p => {
    const i = infoOf(p.object) || {};
    return {name: p.object, label: p.label, description: i.description || "",
      picklists: asList(i.picklists).slice(0, 6), recordTypes: asList(i.recordTypes)};
  });

  // A reading order for day one.
  const startHere = [];
  if (processes[0]) startHere.push({text: `Read how ${an(processes[0].label)} ${processes[0].label} moves through its life`, go: {tab: "processes", ref: processes[0].object}});
  const keyFlows = flows.filter(f => f.kind === "record" && processes.slice(0, 3).some(p => lc(p.object) === lc(f.object)))
    .sort((a, b) => b.steps - a.steps).slice(0, 3);
  for (const f of keyFlows) startHere.push({text: `Open the flow "${f.label}": ${f.summary}`, go: {tab: "flows", ref: f.id}});
  const screens = flows.filter(f => f.kind === "screen").slice(0, 2);
  for (const f of screens) startHere.push({text: `Try the screen flow "${f.label}" in a sandbox to see what users see`, go: {tab: "flows", ref: f.id}});
  const hubs = graph.nodes.filter(n => n.type === "class")
    .map(n => ({n, callers: graph.edges.filter(e => e.to === n.id && ["calls", "apex-action", "uses"].includes(e.kind)).length}))
    .filter(x => x.callers > 1).sort((a, b) => b.callers - a.callers).slice(0, 2);
  for (const x of hubs) startHere.push({text: `Skim the Apex class ${x.n.name}: ${x.callers} other parts use it`, go: {tab: "technical", ref: x.n.id}});

  return {kind: "handbook", orgName, builtAt: Date.now(), counts, departments, processes, flows, glossary, startHere,
    business: null, notes: [], typeLabels: GUIDE_TYPES};
}

// Facts for the AI business summary (names, counts and stages only).
export function handbookPrompt(hb) {
  const lines = [`Org: ${hb.orgName || "?"}`];
  lines.push(`Counts: ${Object.entries(hb.counts).filter(([k]) => GUIDE_TYPES[k]).map(([k, v]) => `${v} ${GUIDE_TYPES[k].plural}`).join(", ")}`);
  if (hb.departments.length) lines.push("Apps (departments):", ...hb.departments.slice(0, 12).map(d => `- ${d.label}: ${d.objects.map(o => o.label).slice(0, 10).join(", ")}`));
  if (hb.processes.length) {
    lines.push("Busiest objects and their stages:", ...hb.processes.map(p =>
      `- ${p.label} (${p.object}): ${p.counts.flows} flows, ${p.counts.triggers} triggers, ${p.counts.rules} rules${p.stageField ? `; ${p.stageField.label}: ${p.columns.filter(c => !c.id.startsWith("@")).map(c => c.label).join(" → ")}` : ""}`));
  }
  lines.push("Some flows:", ...hb.flows.slice(0, 40).map(f => `- ${f.label}: ${f.summary}`));
  return lines.join("\n").slice(0, 12000);
}
