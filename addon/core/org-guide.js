// Org Guide: onboarding notes for a Salesforce org, built from its metadata.
// Turns triggers, Apex classes, flows, LWC, Aura and validation rules into a
// graph of "what runs what", picks one business area (an object and
// everything around it), orders it the way Salesforce runs a save, writes a
// plain-words note per component and builds the diagrams. Pure: the org
// reads live in inspector/shared/org-guide-data.js, AI in shared/ai.js.
import {maskCode, apexOutline, triggerOutline, lwcOutline, auraOutline} from "./code-outline.js";
import {flowSteps} from "./metadata.js";
import {layoutGraph} from "./diagram-layout.js";
import {diagramSvg, legendKinds} from "./diagram-svg.js";

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lc = s => String(s || "").toLowerCase();
const uniq = a => [...new Set(a)];

// Standard objects worth recognising in code (custom ones end in __c etc.).
const STD_OBJECTS = new Set(["Account", "Contact", "Lead", "Opportunity", "OpportunityLineItem", "Case", "CaseComment", "Task", "Event",
  "User", "Contract", "Order", "OrderItem", "Product2", "Pricebook2", "PricebookEntry", "Quote", "QuoteLineItem", "Campaign", "CampaignMember",
  "Asset", "EmailMessage", "ContentVersion", "ContentDocumentLink", "Attachment", "Note", "Entitlement", "WorkOrder", "ServiceAppointment",
  "Individual", "Group", "GroupMember", "PermissionSetAssignment", "FeedItem", "Profile", "UserRole", "RecordType"]);
const isObjectName = n => STD_OBJECTS.has(n) || /__(c|mdt|e|x|b)$/.test(n);

export const GUIDE_TYPES = {
  object: {label: "Object", plural: "Objects", icon: "▦"},
  trigger: {label: "Trigger", plural: "Triggers", icon: "⚡"},
  flow: {label: "Flow", plural: "Flows", icon: "⇢"},
  class: {label: "Apex class", plural: "Apex classes", icon: "</>"},
  lwc: {label: "Lightning web component", plural: "LWC", icon: "⚛"},
  aura: {label: "Aura component", plural: "Aura", icon: "✦"},
  rule: {label: "Validation rule", plural: "Validation rules", icon: "✓"},
};

const RECORD_WHEN = {Create: "created", Update: "updated", CreateAndUpdate: "created or updated", Delete: "deleted"};
const FLOW_WHEN = {RecordBeforeSave: "before save", RecordAfterSave: "after save", RecordBeforeDelete: "before delete",
  Scheduled: "on a schedule", PlatformEvent: "on a platform event"};

// ── Reading code ───────────────────────────────────────────────────────
// Objects an Apex body reads (SOQL) and writes (DML), and known classes it uses.
export function apexFacts(body, {classNames = [], objectNames = [], self = ""} = {}) {
  const m = maskCode(body).slice(0, 400000);
  const known = new Set(objectNames);
  const objectish = n => known.has(n) || isObjectName(n);
  const reads = [];
  const fromRe = /\[\s*SELECT\b[^\]]{0,3000}?\bFROM\s+(\w+)/gi;
  let x;
  while ((x = fromRe.exec(m))) reads.push(x[1]);
  // Variable → type from declarations and parameters: "List<Case> cases", "Case c".
  const typeOf = v => {
    const re1 = new RegExp(`(?:List|Set)\\s*<\\s*(\\w+)\\s*>\\s+${v}\\b`);
    const re2 = new RegExp(`\\b(\\w+)\\s*(?:\\[\\s*\\])?\\s+${v}\\s*[=;,)]`);
    const a = re1.exec(m) || re2.exec(m);
    return a ? a[1] : "";
  };
  const writes = [];
  const dml = /\b(insert|update|upsert|delete|undelete)\s+(new\s+)?(\w+)/gi;
  while ((x = dml.exec(m))) {
    if (/^(into|set)$/i.test(x[3])) continue;
    const t = x[2] ? x[3] : typeOf(x[3]);
    if (t && objectish(t)) writes.push(t);
  }
  const dbDml = /Database\.(insert|update|upsert|delete|undelete)\s*\(\s*(new\s+)?(\w+)/gi;
  while ((x = dbDml.exec(m))) {
    const t = x[2] ? x[3] : typeOf(x[3]);
    if (t && objectish(t)) writes.push(t);
  }
  const calls = classNames.filter(c => c !== self && new RegExp(`\\b${c}\\b\\s*(\\.|\\(|\\s+\\w)`).test(m));
  return {reads: uniq(reads.filter(objectish)), writes: uniq(writes), calls};
}

// What a flow's metadata touches: start object and timing, objects read and
// written, subflows and Apex actions.
export function flowFacts(meta) {
  const m = meta || {};
  const s = m.start || {};
  const reads = asList(m.recordLookups).map(e => e.object).filter(Boolean);
  const writes = [];
  for (const k of ["recordCreates", "recordUpdates", "recordDeletes"]) {
    for (const e of asList(m[k])) {
      if (e.object) writes.push(e.object);
      else if (/^\$Record\b/.test(e.inputReference || "") && s.object) writes.push(s.object);
    }
  }
  const apex = asList(m.actionCalls).filter(a => lc(a.actionType) === "apex").map(a => String(a.actionName || "").split(".")[0]).filter(Boolean);
  const subflows = asList(m.subflows).map(e => e.flowName).filter(Boolean);
  const actions = asList(m.actionCalls).filter(a => lc(a.actionType) !== "apex").map(a => `${a.actionType || "action"}: ${a.actionName || a.label || ""}`);
  return {
    object: s.object || "", triggerType: s.triggerType || "", recordTriggerType: s.recordTriggerType || "",
    processType: m.processType || "", reads: uniq(reads), writes: uniq(writes), apex: uniq(apex), subflows: uniq(subflows), actions: uniq(actions),
  };
}

// ── The graph ──────────────────────────────────────────────────────────
// items: {objects: [{name, label, lookups: [{field, label, to, master}]}],
//   triggers: [{name, object, body}], classes: [{name, body}],
//   flows: [{name, label, meta}], lwc: [{name, label, files, meta}],
//   aura: [{name, label, defs}], rules: [{name, object, active, formula, message}],
//   deps: [{fromType, from, toType, to}]}
export function buildGuideGraph(items) {
  const nodes = [];
  const byId = new Map();
  const edges = [];
  const edgeKey = new Set();
  const objLabel = new Map(asList(items.objects).map(o => [lc(o.name), o.label || o.name]));
  const add = (type, name, extra = {}) => {
    const id = `${type}:${lc(name)}`;
    if (!byId.has(id)) {
      const n = {id, type, name, label: extra.label || (type === "object" ? objLabel.get(lc(name)) || name : name), ...extra};
      byId.set(id, n);
      nodes.push(n);
    }
    return byId.get(id);
  };
  const link = (from, to, kind, label = "") => {
    if (!from || !to || from.id === to.id) return;
    const k = `${from.id}>${to.id}>${kind}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    edges.push({from: from.id, to: to.id, kind, label});
  };
  const classNames = asList(items.classes).map(c => c.name);
  const classByLc = new Map(classNames.map(n => [lc(n), n]));
  const objectNames = uniq([...asList(items.objects).map(o => o.name), ...asList(items.triggers).map(t => t.object),
    ...asList(items.flows).map(f => (f.meta && f.meta.start && f.meta.start.object) || "")].filter(Boolean));
  const obj = name => add("object", name);

  // labelOnly objects just name things; they become boxes only when used.
  for (const o of asList(items.objects)) if (!o.labelOnly) obj(o.name);
  for (const t of asList(items.triggers)) {
    const out = triggerOutline(t.body);
    const object = t.object || out.object;
    const n = add("trigger", t.name, {object, facts: {outline: out}});
    const facts = apexFacts(t.body, {classNames, objectNames, self: ""});
    const called = uniq([...out.calls.map(c => c.split(".")[0]).filter(c => classByLc.has(lc(c))).map(c => classByLc.get(lc(c))), ...facts.calls]);
    n.facts = {...n.facts, ...facts, calls: called};
    if (object) link(obj(object), n, "fires", out.events.join(", "));
  }
  for (const c of asList(items.classes)) {
    const out = apexOutline(c.body);
    if (out.isTest) continue;
    add("class", c.name, {facts: {outline: out, ...apexFacts(c.body, {classNames, objectNames, self: c.name})}});
  }
  for (const f of asList(items.flows)) {
    const facts = flowFacts(f.meta);
    const n = add("flow", f.name, {label: f.label || f.name, object: facts.object, facts, meta: f.meta});
    if (facts.object && facts.triggerType) {
      link(obj(facts.object), n, "fires", [FLOW_WHEN[facts.triggerType] || "", RECORD_WHEN[facts.recordTriggerType] || ""].filter(Boolean).join(", "));
    }
  }
  for (const b of asList(items.lwc)) {
    const out = lwcOutline(asList(b.files), b.meta);
    add("lwc", b.name, {label: b.label || b.name, facts: {outline: out}});
  }
  for (const b of asList(items.aura)) {
    const out = auraOutline(asList(b.defs));
    add("aura", b.name, {label: b.label || b.name, facts: {outline: out}});
  }
  for (const r of asList(items.rules)) {
    const n = add("rule", `${r.object}.${r.name}`, {label: r.name, object: r.object, facts: {active: r.active !== false, formula: r.formula || "", message: r.message || ""}});
    if (r.object) link(obj(r.object), n, "checks", r.active === false ? "inactive" : "");
  }

  // Links that need every node to exist first.
  const nodeOf = (type, name) => byId.get(`${type}:${lc(name)}`);
  for (const n of [...nodes]) {
    const f = n.facts || {};
    if (n.type === "trigger" || n.type === "class") {
      for (const c of f.calls || []) link(n, nodeOf("class", c), "calls", "calls");
      for (const o of f.reads || []) link(n, obj(o), "reads", "reads");
      for (const o of f.writes || []) link(n, obj(o), "writes", "changes");
    }
    if (n.type === "flow") {
      for (const sf of f.subflows) link(n, nodeOf("flow", sf), "subflow", "runs subflow");
      for (const a of f.apex) link(n, nodeOf("class", a), "apex-action", "Apex action");
      for (const o of f.reads) link(n, obj(o), "reads", "gets records");
      for (const o of f.writes) link(n, obj(o), "writes", "changes records");
    }
    if (n.type === "lwc") {
      for (const a of f.outline.apex) link(n, nodeOf("class", a.method.split(".")[0]), "uses", a.method.split(".").pop());
    }
    if (n.type === "aura" && f.outline.controller) link(n, nodeOf("class", f.outline.controller.split(".").pop()), "uses", "controller");
  }
  // Salesforce's dependency data fills links the code scan missed.
  const TYPE_OF = {ApexClass: "class", ApexTrigger: "trigger", Flow: "flow", LightningComponentBundle: "lwc", AuraDefinitionBundle: "aura"};
  for (const d of asList(items.deps)) {
    const a = TYPE_OF[d.fromType] && nodeOf(TYPE_OF[d.fromType], d.from);
    const b = TYPE_OF[d.toType] && nodeOf(TYPE_OF[d.toType], d.to);
    if (a && b && !edges.some(e => e.from === a.id && e.to === b.id)) {
      link(a, b, a.type === "flow" && b.type === "class" ? "apex-action" : a.type === "flow" ? "subflow" : (a.type === "lwc" || a.type === "aura") ? "uses" : "calls",
        "uses");
    }
  }
  // Business map: lookups between the described objects.
  for (const o of asList(items.objects)) {
    for (const l of asList(o.lookups)) {
      if (byId.has(`object:${lc(l.to)}`)) link(obj(o.name), obj(l.to), "lookup", `${l.label || l.field}${l.master ? " (master)" : ""}`);
    }
  }
  return {nodes, edges};
}

const nodeMap = g => new Map(g.nodes.map(n => [n.id, n]));

// One business area: the object, what runs on it, and what that calls (to
// `hops`), plus components that call into it. Objects are leaves (except the
// area's own), so a shared object like Account doesn't pull in everything.
export function selectArea(graph, objectName, {maxComponents = 60, hops = 2} = {}) {
  const byId = nodeMap(graph);
  const root = `object:${lc(objectName)}`;
  if (!byId.has(root)) return {nodes: [], edges: [], root, more: 0};
  const keep = new Map([[root, 0]]);
  const queue = [];
  const push = (id, d) => { if (!keep.has(id)) { keep.set(id, d); queue.push(id); } };
  for (const e of graph.edges) if (e.from === root && (e.kind === "fires" || e.kind === "checks")) push(e.to, 0);
  // Code and flows that change this object also belong to the area.
  for (const e of graph.edges) if (e.to === root && e.kind === "writes") push(e.from, 1);
  while (queue.length) {
    const id = queue.shift();
    const d = keep.get(id);
    if (d >= hops) continue;
    for (const e of graph.edges) {
      if (e.from === id && ["calls", "apex-action", "subflow"].includes(e.kind)) push(e.to, d + 1);
      if (e.to === id && e.kind === "uses") push(e.from, d + 1);
      if (e.to === id && (e.kind === "calls" || e.kind === "apex-action" || e.kind === "subflow") && d < 1) push(e.from, d + 1);
    }
  }
  const comps = [...keep.keys()].filter(id => id !== root && byId.get(id).type !== "object");
  const ordered = comps.sort((a, b) => keep.get(a) - keep.get(b));
  const kept = new Set([root, ...ordered.slice(0, maxComponents)]);
  // Objects the kept components read or write, as leaves.
  for (const e of graph.edges) {
    if (kept.has(e.from) && (e.kind === "reads" || e.kind === "writes")) kept.add(e.to);
  }
  const nodes = graph.nodes.filter(n => kept.has(n.id));
  const edges = graph.edges.filter(e => kept.has(e.from) && kept.has(e.to) && e.kind !== "lookup");
  return {nodes, edges, root, more: Math.max(0, ordered.length - maxComponents)};
}

// Order components the way Salesforce runs a save of the area's object.
const PHASES = [
  [1, "Before-save flows"], [2, "Before triggers"], [3, "Validation rules"], [4, "After triggers"], [5, "After-save flows"],
  [6, "Apex classes"], [7, "Other flows"], [8, "Lightning web components"], [9, "Aura components"]];
export const PHASE_LABEL = Object.fromEntries(PHASES);

export function runOrder(area) {
  const order = [];
  const seen = new Set();
  // Classes in the order the automation reaches them.
  const reach = [];
  const q = area.nodes.filter(n => n.type === "trigger" || n.type === "flow").map(n => n.id);
  const seenQ = new Set(q);
  while (q.length) {
    const id = q.shift();
    for (const e of area.edges) {
      if (e.from === id && !seenQ.has(e.to)) { seenQ.add(e.to); q.push(e.to); reach.push(e.to); }
    }
  }
  const rank = id => { const i = reach.indexOf(id); return i < 0 ? 1e6 : i; };
  for (const n of area.nodes) {
    if (n.type === "object") continue;
    let phase = 6;
    if (n.type === "trigger") {
      const ev = (n.facts && n.facts.outline && n.facts.outline.events) || [];
      phase = ev.some(e => e.startsWith("before")) ? 2 : 4;
    } else if (n.type === "flow") {
      const t = n.facts.triggerType;
      phase = t === "RecordBeforeSave" || t === "RecordBeforeDelete" ? 1 : t === "RecordAfterSave" ? 5 : 7;
    } else if (n.type === "rule") phase = 3;
    else if (n.type === "lwc") phase = 8;
    else if (n.type === "aura") phase = 9;
    order.push({id: n.id, phase});
    seen.add(n.id);
  }
  return order.sort((a, b) => a.phase - b.phase || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
    .map(o => ({...o, phaseLabel: PHASE_LABEL[o.phase]}));
}

// ── Plain words ────────────────────────────────────────────────────────
const list = a => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
const nameOf = (byId, id) => (byId.get(id) || {}).label || id.split(":")[1];

const EDGE_REASON_OUT = {calls: "calls it", "apex-action": "runs it as an Apex action", subflow: "runs it as a subflow",
  uses: "gets data from it", reads: "reads these records", writes: "changes these records"};
const EDGE_REASON_IN = {calls: "calls this", "apex-action": "runs this as an Apex action", subflow: "runs this as a subflow",
  uses: "gets data from this", fires: "starts this when its records are saved", checks: "is checked by this"};

// What a component does and how it connects, without AI.
export function describeComponent(node, graph) {
  const byId = nodeMap(graph);
  const outE = graph.edges.filter(e => e.from === node.id);
  const inE = graph.edges.filter(e => e.to === node.id);
  const names = (edges, side, kinds) => uniq(edges.filter(e => kinds.includes(e.kind)).map(e => nameOf(byId, side === "to" ? e.to : e.from)));
  const reads = names(outE, "to", ["reads"]);
  const writes = names(outE, "to", ["writes"]);
  const calls = names(outE, "to", ["calls", "apex-action", "subflow"]);
  const callers = names(inE, "from", ["calls", "apex-action", "subflow", "uses"]);
  const plain = [];
  const risks = [];
  const f = node.facts || {};
  if (node.type === "trigger") {
    const o = f.outline || {};
    plain.push(`Runs automatically when ${node.object} records are saved: ${list(o.events || []) || "on save"}.`);
    plain.push(calls.length ? `It hands the work to ${list(calls)}.` : "It does its work inside the trigger itself (no handler class).");
    if (!calls.length) risks.push("Logic lives in the trigger body; a handler class is easier to test and reuse.");
    if ((o.stats || {}).soql || (o.stats || {}).dml) risks.push(`The trigger body itself has ${o.stats.soql} SOQL quer${o.stats.soql === 1 ? "y" : "ies"} and ${o.stats.dml} DML statement(s).`);
    const siblings = graph.edges.filter(e => e.kind === "fires" && e.from === `object:${lc(node.object)}` && e.to !== node.id && byId.get(e.to) && byId.get(e.to).type === "trigger");
    if (siblings.length) risks.push(`${node.object} has ${siblings.length + 1} triggers; Salesforce does not promise which runs first.`);
  } else if (node.type === "flow") {
    const steps = flowSteps(node.meta);
    plain.push(...steps.start.details.map(d => d + "."));
    const counts = {};
    for (const s of steps.steps) counts[s.typeLabel] = (counts[s.typeLabel] || 0) + 1;
    const c = Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}${v > 1 ? "s" : ""}`);
    if (c.length) plain.push(`It has ${steps.steps.length} step${steps.steps.length === 1 ? "" : "s"}: ${list(c)}.`);
    if (f.subflows.length) plain.push(`It runs the subflow${f.subflows.length > 1 ? "s" : ""} ${list(f.subflows)}.`);
    if (f.apex.length) plain.push(`It runs Apex: ${list(f.apex)}.`);
    if (f.actions.length) plain.push(`Other actions: ${list(f.actions.slice(0, 4))}.`);
    const unguarded = steps.steps.filter(s => /Records$/.test(s.typeLabel) && s.typeLabel !== "Get Records" && !s.next.some(x => x.label === "If it fails"));
    if (unguarded.length) risks.push(`No fault path on: ${list(unguarded.map(s => s.label).slice(0, 4))}. An error there stops the save with a generic message.`);
    if (steps.unreachable.length) risks.push(`${steps.unreachable.length} step(s) are never reached.`);
  } else if (node.type === "class") {
    const o = f.outline || {};
    const pub = (o.methods || []).filter(m => m.access === "public" || m.access === "global").map(m => m.name);
    plain.push(`An Apex class with ${(o.methods || []).length} method${(o.methods || []).length === 1 ? "" : "s"}${pub.length ? ` (the main ones: ${list(uniq(pub).slice(0, 5))})` : ""}.`);
    if (o.sharing === "without sharing") { plain.push("It runs \"without sharing\": it can see every record, whatever the user's access."); risks.push("Runs without sharing: check it can't show or change records the user shouldn't."); }
    else if (o.sharing === "with sharing") plain.push("It runs \"with sharing\": it only sees records the user can see.");
    if ((o.stats || {}).auraEnabled) plain.push(`${o.stats.auraEnabled} method(s) can be called from Lightning components.`);
    if ((o.stats || {}).invocable) plain.push("It can be used as an action in flows.");
    if ((o.stats || {}).callouts) { plain.push(`It calls an outside system (${o.stats.callouts} HTTP callout${o.stats.callouts > 1 ? "s" : ""}).`); risks.push("Makes HTTP callouts: needs a Named Credential or Remote Site, and can't run inside a trigger's transaction directly."); }
  } else if (node.type === "lwc" || node.type === "aura") {
    const o = f.outline || {};
    const where = asList(o.targets).map(t => String(t).replace(/^lightning(Community)?__/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
    plain.push(`A ${node.type === "lwc" ? "Lightning web component" : "Aura component"}${node.label && node.label !== node.name ? ` called "${node.label}"` : ""} that people see on screen.`);
    if (where.length) plain.push(`It can be placed on: ${list(uniq(where))}.`);
    if (node.type === "aura" && o.implements && o.implements.length) plain.push(`It plugs into: ${list(o.implements.slice(0, 4))}.`);
  } else if (node.type === "rule") {
    plain.push(`Stops a ${node.object} record from being saved when this is true: ${f.formula || "(formula not read)"}.`);
    if (f.message) plain.push(`The user sees: "${f.message}"`);
    if (!f.active) plain.push("It is switched off right now.");
  }
  if (reads.length) plain.push(`Reads ${list(reads)} records.`);
  if (writes.length) plain.push(`Changes ${list(writes)} records.`);
  if (node.type === "class" && callers.length) plain.push(`Used by ${list(callers)}.`);
  if (node.type !== "trigger" && node.type !== "flow" && calls.length) plain.push(`Calls ${list(calls)}.`);

  const related = [];
  for (const e of inE) {
    const other = byId.get(e.from);
    if (!other || other.type === "object" && e.kind !== "fires" && e.kind !== "checks") continue;
    related.push({id: other.id, type: other.type, label: other.label, reason: EDGE_REASON_IN[e.kind] || "linked"});
  }
  for (const e of outE) {
    const other = byId.get(e.to);
    if (!other) continue;
    related.push({id: other.id, type: other.type, label: other.label, reason: EDGE_REASON_OUT[e.kind] || "linked"});
  }
  // Other automation on the same object.
  if (node.object && (node.type === "trigger" || node.type === "flow" || node.type === "rule")) {
    for (const e of graph.edges) {
      if (e.from === `object:${lc(node.object)}` && (e.kind === "fires" || e.kind === "checks") && e.to !== node.id) {
        const other = byId.get(e.to);
        if (other && !related.some(r => r.id === other.id)) related.push({id: other.id, type: other.type, label: other.label, reason: `also runs when ${node.object} is saved`});
      }
    }
  }
  return {plain, related, risks};
}

// ── Diagrams (graphs for layoutGraph) ──────────────────────────────────
const SHAPE = {object: "cylinder", trigger: "rect", flow: "round", class: "rect", lwc: "round", aura: "round", rule: "rect"};
const subOf = n => (n.type === "trigger" ? `on ${n.object}` : n.type === "flow" ? (FLOW_WHEN[n.facts.triggerType] || (n.facts.processType === "Flow" ? "screen flow" : "flow")) : n.type === "object" ? n.name !== n.label ? n.name : "object" : GUIDE_TYPES[n.type].label);
const toDiagramNode = (n, extra = {}) => ({id: n.id, label: n.label, sub: subOf(n), kind: n.type, shape: SHAPE[n.type], ...extra});

// The area at a glance: records saved → automation → code → other objects.
export function systemMap(area) {
  return {
    dir: "LR",
    nodes: area.nodes.map(n => toDiagramNode(n, {emphasis: n.id === area.root})),
    edges: area.edges.map(e => ({from: e.from, to: e.to, label: e.label === "calls" ? "" : e.label, kind: e.kind === "reads" ? "dashed" : ""})),
  };
}

// One component and its neighbours (one hop in, one or two hops out).
export function neighbourhood(graph, id) {
  const byId = nodeMap(graph);
  const keep = new Set([id]);
  const edges = [];
  for (const e of graph.edges) {
    if (e.to === id && e.kind !== "lookup") { keep.add(e.from); edges.push(e); }
    if (e.from === id) { keep.add(e.to); edges.push(e); }
  }
  // Second hop out for code: what the called classes touch.
  for (const e of graph.edges) {
    const via = byId.get(e.from);
    if (e.from !== id && keep.has(e.from) && via && via.type === "class" && graph.edges.some(x => x.from === id && x.to === e.from) &&
        ["reads", "writes", "calls"].includes(e.kind) && keep.size < 16) {
      keep.add(e.to); edges.push(e);
    }
  }
  return {
    dir: "LR",
    nodes: [...keep].map(k => byId.get(k)).filter(Boolean).map(n => toDiagramNode(n, {emphasis: n.id === id})),
    edges: edges.map(e => ({from: e.from, to: e.to, label: e.label === "calls" ? "" : e.label, kind: e.kind === "reads" ? "dashed" : ""})),
  };
}

const STEP_SHAPE = {decisions: ["diamond", "decision"], loops: ["round", "decision"], recordLookups: ["data", "data"], recordCreates: ["data", "data"],
  recordUpdates: ["data", "data"], recordDeletes: ["data", "data"], subflows: ["rect", "call", true], actionCalls: ["rect", "call", true],
  customErrors: ["rect", "error"], screens: ["round", "step"], assignments: ["rect", "step"], collectionProcessors: ["rect", "step"], waits: ["round", "step"]};

// A real flowchart of a flow: start → steps (decisions as diamonds with
// labelled branches, loops, fault paths) → end. Subflow / Apex steps link
// to their own section when it is in the guide.
export function flowDiagram(meta, {maxSteps = 60, linkFor = () => null} = {}) {
  const fs = flowSteps(meta);
  const m = meta || {};
  const raw = {};
  for (const k of Object.keys(STEP_SHAPE)) for (const e of asList(m[k])) raw[e.name] = {key: k, el: e};
  const steps = fs.steps.slice(0, maxSteps);
  const ids = new Set(steps.map(s => s.name));
  const nodes = [{id: "f:start", label: "Start", sub: fs.start.details.slice(0, 2).join(" · "), kind: "start", shape: "pill"}];
  const edges = [];
  let needEnd = false;
  const startTarget = (m.start && m.start.connector && m.start.connector.targetReference) || m.startElementReference;
  if (startTarget && ids.has(startTarget)) edges.push({from: "f:start", to: "f:" + startTarget});
  else needEnd = true;
  for (const s of steps) {
    const r = raw[s.name] || {};
    const [shape, kind, double] = STEP_SHAPE[r.key] || ["rect", "step"];
    let link = null;
    if (r.key === "subflows") link = linkFor("flow", r.el.flowName);
    if (r.key === "actionCalls" && lc(r.el.actionType) === "apex") link = linkFor("class", String(r.el.actionName || "").split(".")[0]);
    nodes.push({id: "f:" + s.name, label: s.label, sub: [s.typeLabel, s.details[0]].filter(Boolean).join(" · "), kind, shape, double: !!double, link});
    if (!s.next.length) { edges.push({from: "f:" + s.name, to: "f:end"}); needEnd = true; }
    for (const x of s.next) {
      const fault = x.label === "If it fails";
      if (x.target && ids.has(x.target)) edges.push({from: "f:" + s.name, to: "f:" + x.target, label: x.label, kind: fault ? "fault" : ""});
      else { edges.push({from: "f:" + s.name, to: "f:end", label: x.label, kind: fault ? "fault" : ""}); needEnd = true; }
    }
  }
  if (needEnd || !steps.length) nodes.push({id: "f:end", label: "End", kind: "start", shape: "pill"});
  return {dir: "TB", nodes, edges, more: Math.max(0, fs.steps.length - steps.length), unreachable: fs.unreachable.length};
}

// Objects and how they link (lookups / master-detail), with automation counts.
export function businessMap(graph, {objects = null, max = 24} = {}) {
  const count = new Map();
  for (const e of graph.edges) if (e.kind === "fires" || e.kind === "checks") count.set(e.from, (count.get(e.from) || 0) + 1);
  let objs = graph.nodes.filter(n => n.type === "object");
  if (objects) objs = objs.filter(n => objects.includes(lc(n.name)));
  objs = objs.sort((a, b) => (count.get(b.id) || 0) - (count.get(a.id) || 0) || a.label.localeCompare(b.label)).slice(0, max);
  const keep = new Set(objs.map(o => o.id));
  return {
    dir: "LR",
    nodes: objs.map(o => ({id: o.id, label: o.label, sub: `${o.name} · ${count.get(o.id) || 0} automation${count.get(o.id) === 1 ? "" : "s"}`,
      kind: "object", shape: "cylinder", emphasis: (count.get(o.id) || 0) > 0})),
    edges: graph.edges.filter(e => e.kind === "lookup" && keep.has(e.from) && keep.has(e.to))
      .map(e => ({from: e.from, to: e.to, label: e.label, kind: /master/.test(e.label) ? "" : "dashed"})),
  };
}

// Objects ranked by how much automation runs on them (for the org overview).
export function areaRanking(graph) {
  const byId = nodeMap(graph);
  const per = new Map();
  for (const e of graph.edges) {
    if (e.kind !== "fires" && e.kind !== "checks") continue;
    const p = per.get(e.from) || {triggers: 0, flows: 0, rules: 0};
    const t = byId.get(e.to).type;
    if (t === "trigger") p.triggers++; else if (t === "flow") p.flows++; else if (t === "rule") p.rules++;
    per.set(e.from, p);
  }
  return [...per].map(([id, p]) => ({id, name: byId.get(id).name, label: byId.get(id).label, ...p, total: p.triggers + p.flows + p.rules}))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ── The guide ──────────────────────────────────────────────────────────
// scope: {kind: "area", object} or {kind: "org"}.
export function buildGuide(items, scope, {orgName = "", maxComponents = 60} = {}) {
  const graph = buildGuideGraph(items);
  const counts = {};
  for (const n of graph.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  const guide = {scope, orgName, builtAt: Date.now(), counts, notes: [], sections: [], areas: [], business: null};
  if (scope.kind === "org") {
    guide.areas = areaRanking(graph).slice(0, 15);
    guide.maps = {business: businessMap(graph)};
    guide.title = "How this org works";
    return guide;
  }
  const area = selectArea(graph, scope.object, {maxComponents});
  if (!area.nodes.length) {
    guide.title = scope.object;
    guide.notes.push(`Nothing runs on ${scope.object}: no triggers, record-triggered flows or validation rules were found.`);
    return guide;
  }
  if (area.more) guide.notes.push(`${area.more} more connected component(s) were left out to keep the guide readable.`);
  const rootNode = area.nodes.find(n => n.id === area.root);
  guide.title = rootNode.label === rootNode.name ? rootNode.name : `${rootNode.label} (${rootNode.name})`;
  guide.maps = {system: systemMap(area), business: businessMap(graph, {objects: area.nodes.filter(n => n.type === "object").map(n => lc(n.name))})};
  const inGuide = new Set(area.nodes.map(n => n.id));
  const linkFor = (type, name) => (inGuide.has(`${type}:${lc(name)}`) ? `${type}:${lc(name)}` : null);
  const byId = nodeMap(area);
  for (const o of runOrder(area)) {
    const n = byId.get(o.id);
    const d = describeComponent(n, area);
    guide.sections.push({
      id: n.id, type: n.type, name: n.name, label: n.label, object: n.object || "", phase: o.phase, phaseLabel: o.phaseLabel,
      diagram: n.type === "flow" ? flowDiagram(n.meta, {linkFor}) : neighbourhood(area, n.id),
      context: n.type === "flow" ? neighbourhood(area, n.id) : null,
      plain: d.plain, related: d.related, risks: d.risks,
      aiInput: aiInputFor(n, d),
      eli5: null, aiPlain: null,
    });
  }
  guide.glossary = area.nodes.filter(n => n.type === "object").map(n => ({name: n.name, label: n.label}))
    .sort((a, b) => a.label.localeCompare(b.label));
  return guide;
}

// Short, code-free description of a component for the AI (never full bodies).
function aiInputFor(n, d) {
  const lines = [`ID: ${n.id}`, `Type: ${GUIDE_TYPES[n.type].label}`, `Name: ${n.name}`];
  if (n.type === "flow") {
    const fs = flowSteps(n.meta);
    lines.push(`Starts: ${fs.start.details.join("; ")}`);
    lines.push("Steps:", ...fs.steps.slice(0, 25).map((s, i) => `${i + 1}. ${s.typeLabel}: ${s.label}${s.details.length ? ` (${s.details.slice(0, 2).join("; ")})` : ""}` +
      (s.next.length > 1 ? ` → ${s.next.map(x => `${x.label || "next"}: ${x.targetLabel}`).join(" | ")}` : "")));
  } else if (n.type === "class") {
    const o = n.facts.outline;
    lines.push(`Methods: ${o.methods.slice(0, 15).map(m => `${m.name}(${m.params})`).join(", ")}`);
  } else if (n.type === "rule") {
    lines.push(`Formula: ${String(n.facts.formula).slice(0, 600)}`, `Message: ${n.facts.message}`);
  }
  lines.push("Facts:", ...d.plain.map(p => `- ${p}`));
  return lines.join("\n").slice(0, 2400);
}

// Components in groups for one AI call each (JSON reply per group).
export function eli5Batches(sections, {size = 8, maxChars = 14000} = {}) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const s of sections) {
    const t = s.aiInput || "";
    if (cur.length && (cur.length >= size || chars + t.length > maxChars)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(s);
    chars += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches.map(b => ({ids: b.map(s => s.id), text: b.map(s => s.aiInput).join("\n\n---\n\n")}));
}

// Facts about the org for the business summary (names and counts, no data).
export function businessPrompt(guide) {
  const lines = [`Org: ${guide.orgName || "?"}`, `Scope: ${guide.scope.kind === "org" ? "whole org" : `area ${guide.title}`}`];
  lines.push(`Counts: ${Object.entries(guide.counts).map(([k, v]) => `${v} ${GUIDE_TYPES[k] ? GUIDE_TYPES[k].plural : k}`).join(", ")}`);
  if (guide.areas.length) lines.push("Busiest objects:", ...guide.areas.map(a => `- ${a.label} (${a.name}): ${a.triggers} triggers, ${a.flows} flows, ${a.rules} validation rules`));
  const bm = guide.maps && guide.maps.business;
  if (bm) {
    const lab = new Map(bm.nodes.map(n => [n.id, n.label]));
    lines.push("Object links:", ...bm.edges.slice(0, 40).map(e => `- ${lab.get(e.from)} → ${lab.get(e.to)} (${e.label})`));
  }
  for (const s of guide.sections.slice(0, 30)) lines.push(`- ${s.phaseLabel}: ${GUIDE_TYPES[s.type].label} ${s.name}: ${s.plain.slice(0, 2).join(" ")}`);
  return lines.join("\n").slice(0, 12000);
}

// ── Exports ────────────────────────────────────────────────────────────
const mdEsc = s => String(s == null ? "" : s).replace(/[|*_`[\]<>]/g, c => "\\" + c);
const mmLabel = s => String(s == null ? "" : s).replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\n/g, " ");

export function toMermaid(g) {
  const ids = new Map(g.nodes.map((n, i) => [n.id, "n" + i]));
  const lines = [`flowchart ${g.dir === "LR" ? "LR" : "TD"}`];
  for (const n of g.nodes) {
    const text = mmLabel(n.sub ? `${n.label}<br/><small>${n.sub}</small>` : n.label).replace(/#lt;br\/#gt;/g, "<br/>").replace(/#lt;small#gt;|#lt;\/small#gt;/g, "");
    const id = ids.get(n.id);
    const shaped = n.shape === "diamond" ? `{"${text}"}` : n.shape === "pill" ? `(["${text}"])` : n.shape === "data" ? `[/"${text}"/]`
      : n.shape === "cylinder" ? `[("${text}")]` : n.double ? `[["${text}"]]` : n.shape === "round" ? `("${text}")` : `["${text}"]`;
    lines.push(`  ${id}${shaped}`);
  }
  for (const e of g.edges) {
    const arrow = e.kind === "fault" || e.kind === "dashed" ? "-.->" : "-->";
    lines.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|"${mmLabel(e.label)}"|` : ""} ${ids.get(e.to)}`);
  }
  return lines.join("\n");
}

// AI- and org-written prose: keep its bold and lists, but no links or HTML.
const mdProse = s => String(s == null ? "" : s).replace(/[<>[\]]/g, c => "\\" + c);

export function guideToMarkdown(guide) {
  const out = [`# Org Guide: ${mdEsc(guide.title)}`, "", `_${guide.orgName ? mdEsc(guide.orgName) + " · " : ""}generated by SaralForce on ${new Date(guide.builtAt).toISOString().slice(0, 10)}_`, ""];
  if (guide.business) out.push("## How the business works", "", mdProse(guide.business), "");
  if (guide.maps && guide.maps.business && guide.maps.business.nodes.length) out.push("### Business map", "", "```mermaid", toMermaid(guide.maps.business), "```", "");
  if (guide.areas.length) {
    out.push("## Main business areas", "", "| Object | Triggers | Flows | Validation rules |", "|---|---|---|---|");
    for (const a of guide.areas) out.push(`| ${mdEsc(a.label)} (\`${a.name}\`) | ${a.triggers} | ${a.flows} | ${a.rules} |`);
    out.push("");
  }
  if (guide.maps && guide.maps.system) out.push("## The big picture", "", "```mermaid", toMermaid(guide.maps.system), "```", "");
  let phase = null;
  for (const s of guide.sections) {
    if (s.phaseLabel !== phase) { phase = s.phaseLabel; out.push(`## ${phase}`, ""); }
    out.push(`### ${GUIDE_TYPES[s.type].label}: ${mdEsc(s.label)}`, "");
    out.push("**Flow**", "", "```mermaid", toMermaid(s.diagram), "```", "");
    out.push("**What this shows**", "", ...(s.aiPlain ? [mdProse(s.aiPlain)] : s.plain.map(p => `- ${mdProse(p)}`)), "");
    if (s.related.length) out.push("**Related flows and components**", "", ...s.related.map(r => `- ${GUIDE_TYPES[r.type] ? GUIDE_TYPES[r.type].label : r.type} **${mdEsc(r.label)}**: ${mdProse(r.reason)}`), "");
    if (s.eli5) out.push("**ELI5**", "", `> ${mdProse(s.eli5)}`, "");
    if (s.risks.length) out.push("**Good to know**", "", ...s.risks.map(r => `- ${mdProse(r)}`), "");
  }
  if (guide.glossary && guide.glossary.length) {
    out.push("## Glossary", "", "| Label | API name |", "|---|---|", ...guide.glossary.map(g => `| ${mdEsc(g.label)} | \`${g.name}\` |`), "");
  }
  for (const n of guide.notes) out.push(`> ${mdProse(n)}`);
  return out.join("\n");
}

const hEsc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const anchor = id => "s-" + String(id).replace(/[^a-z0-9]+/gi, "-");

function svgBlock(g, title) {
  if (!g || !g.nodes.length) return "";
  const layout = layoutGraph(g, {dir: g.dir || "TB"});
  const legend = legendKinds(layout).map(k => `<span class="lg"><i style="background:${k.colors.light[0]};border-color:${k.colors.light[1]}"></i>${hEsc(k.label)}</span>`).join("");
  return `<div class="dg">${diagramSvg(layout, {title})}</div><div class="legend">${legend}</div>`;
}

// One self-contained HTML page (inline SVG + styles), for sharing or printing.
export function guideToHtml(guide) {
  const parts = [];
  parts.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Org Guide: ${hEsc(guide.title)}</title><style>
body{font:14px/1.55 "Segoe UI",Helvetica,Arial,sans-serif;color:#1f2532;margin:0;background:#f6f7f9}
main{max-width:1100px;margin:0 auto;padding:28px 24px;background:#fff}
h1{margin:0 0 4px}h2{margin:34px 0 10px;border-bottom:2px solid #e3e6ec;padding-bottom:6px}h3{margin:26px 0 8px}
.meta{color:#6b7385}.dg{overflow:auto;border:1px solid #e3e6ec;border-radius:8px;padding:8px;background:#fff}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:#4b5466;margin:6px 0 10px}.lg i{display:inline-block;width:12px;height:12px;border:1.5px solid;border-radius:3px;margin-right:4px;vertical-align:-2px}
.box{border-radius:8px;padding:10px 14px;margin:8px 0}.eli5{background:#fff7e0;border:1px solid #f0d78c}.risk{background:#fdecef;border:1px solid #f3b8c3}
.tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7385}
table{border-collapse:collapse}td,th{border:1px solid #e3e6ec;padding:4px 10px;text-align:left}
nav ol{columns:2}pre{white-space:pre-wrap;background:#f6f7f9;padding:10px;border-radius:6px}
@media print{body{background:#fff}main{padding:0}.dg{border:0}}
</style></head><body><main>`);
  parts.push(`<h1>Org Guide: ${hEsc(guide.title)}</h1><div class="meta">${hEsc(guide.orgName)} · generated by SaralForce on ${hEsc(new Date(guide.builtAt).toISOString().slice(0, 10))}</div>`);
  if (guide.sections.length) {
    parts.push(`<nav><h2>Contents</h2><ol>${guide.sections.map(s => `<li><a href="#${anchor(s.id)}">${hEsc(s.label)}</a> <span class="meta">${hEsc(GUIDE_TYPES[s.type].label)}</span></li>`).join("")}</ol></nav>`);
  }
  if (guide.business) parts.push(`<h2>How the business works</h2><pre>${hEsc(guide.business)}</pre>`);
  if (guide.maps && guide.maps.business && guide.maps.business.nodes.length) parts.push(`<h3>Business map</h3>${svgBlock(guide.maps.business, "Business map")}`);
  if (guide.areas.length) {
    parts.push(`<h2>Main business areas</h2><table><tr><th>Object</th><th>Triggers</th><th>Flows</th><th>Validation rules</th></tr>${guide.areas.map(a =>
      `<tr><td>${hEsc(a.label)} <span class="meta">${hEsc(a.name)}</span></td><td>${a.triggers}</td><td>${a.flows}</td><td>${a.rules}</td></tr>`).join("")}</table>`);
  }
  if (guide.maps && guide.maps.system) parts.push(`<h2>The big picture</h2>${svgBlock(guide.maps.system, "System map")}`);
  let phase = null;
  for (const s of guide.sections) {
    if (s.phaseLabel !== phase) { phase = s.phaseLabel; parts.push(`<h2>${hEsc(phase)}</h2>`); }
    parts.push(`<section id="${anchor(s.id)}"><h3>${hEsc(GUIDE_TYPES[s.type].label)}: ${hEsc(s.label)}</h3>`);
    parts.push(`<div class="tag">Flow</div>${svgBlock(s.diagram, s.label)}`);
    parts.push(`<div class="tag">What this shows</div>${s.aiPlain ? `<p>${hEsc(s.aiPlain)}</p>` : `<ul>${s.plain.map(p => `<li>${hEsc(p)}</li>`).join("")}</ul>`}`);
    if (s.related.length) parts.push(`<div class="tag">Related flows and components</div><ul>${s.related.map(r => `<li><a href="#${anchor(r.id)}">${hEsc(r.label)}</a> <span class="meta">${hEsc(GUIDE_TYPES[r.type] ? GUIDE_TYPES[r.type].label : r.type)}</span>: ${hEsc(r.reason)}</li>`).join("")}</ul>`);
    if (s.eli5) parts.push(`<div class="box eli5"><div class="tag">ELI5</div>${hEsc(s.eli5)}</div>`);
    if (s.risks.length) parts.push(`<div class="box risk"><div class="tag">Good to know</div><ul>${s.risks.map(r => `<li>${hEsc(r)}</li>`).join("")}</ul></div>`);
    parts.push("</section>");
  }
  if (guide.glossary && guide.glossary.length) parts.push(`<h2>Glossary</h2><table><tr><th>Label</th><th>API name</th></tr>${guide.glossary.map(g => `<tr><td>${hEsc(g.label)}</td><td>${hEsc(g.name)}</td></tr>`).join("")}</table>`);
  for (const n of guide.notes) parts.push(`<p class="meta">${hEsc(n)}</p>`);
  parts.push("</main></body></html>");
  return parts.join("\n");
}
