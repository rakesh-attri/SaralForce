// A flow in plain English, for people new to the org: what starts it, a
// numbered story of its steps (with "If … go to step N" branches), a one-line
// summary, and a simple diagram (plain labels, icons, consecutive field
// updates folded into one box). Pure: works on Tooling Flow.Metadata.
import {flowSteps} from "./metadata.js";

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

const ELEMENT_KEYS = ["screens", "decisions", "assignments", "loops", "recordLookups", "recordCreates", "recordUpdates", "recordDeletes",
  "actionCalls", "subflows", "collectionProcessors", "waits", "customErrors", "orchestratedStages", "transforms"];

// "Customer_Tier__c" → "Customer Tier"; "$Record.Account.Name" → "Account Name".
export function plainField(ref, labels = {}) {
  let r = String(ref == null ? "" : ref).trim();
  if (!r) return "";
  r = r.replace(/^\{!|\}$/g, "");
  if (/^\$GlobalConstant\.True$/i.test(r)) return "Yes";
  if (/^\$GlobalConstant\.False$/i.test(r)) return "No";
  if (/^\$GlobalConstant\.EmptyString$/i.test(r)) return "empty";
  if (/^\$Flow\.CurrentDate/i.test(r)) return "today";
  if (/^\$Flow\.CurrentDateTime/i.test(r)) return "now";
  if (/^\$User\./i.test(r)) return "the running user's " + plainField(r.replace(/^\$User\./i, ""));
  if (/^\$Label\./i.test(r)) return `label ${r.replace(/^\$Label\./i, "")}`;
  const parts = r.replace(/^\$Record__Prior\./, "previous ").replace(/^\$Record\./, "").split(".");
  const pretty = s => s.replace(/__(c|r)$/i, "").replace(/__/g, " ").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\bId$/, "").trim();
  if (parts.length > 1 && labels[parts[0]]) return `${pretty(parts.slice(1).join(" "))} (from "${labels[parts[0]]}")`;
  if (parts.length === 1 && labels[parts[0]]) return `"${labels[parts[0]]}"`;
  return parts.map(pretty).filter(Boolean).join(" ") || parts.join(".");
}

function plainValue(v, labels) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if ("stringValue" in v) return v.stringValue === "" || v.stringValue == null ? "empty" : `"${v.stringValue}"`;
  if ("booleanValue" in v) return String(v.booleanValue) === "true" ? "Yes" : "No";
  if ("numberValue" in v) return String(v.numberValue);
  if ("dateValue" in v) return String(v.dateValue);
  if ("elementReference" in v) return plainField(v.elementReference, labels);
  const k = Object.keys(v).find(x => v[x] != null);
  return k ? String(v[k]) : "";
}

const OP = {EqualTo: "is", NotEqualTo: "is not", GreaterThan: "is more than", LessThan: "is less than", GreaterThanOrEqualTo: "is at least",
  LessThanOrEqualTo: "is at most", Contains: "contains", StartsWith: "starts with", EndsWith: "ends with", In: "is one of", NotIn: "is not one of"};

// One condition in words: "Priority is "High"", "Subject is empty", "Status changed".
export function plainCondition(c, labels = {}) {
  const field = plainField(c.leftValueReference || c.field, labels) || "?";
  const val = c.rightValue || c.value;
  const op = c.operator || "EqualTo";
  const yes = plainValue(val, labels) !== "No";
  if (op === "IsNull") return `${field} ${yes ? "is empty" : "is filled in"}`;
  if (op === "IsChanged") return `${field} ${yes ? "changed" : "did not change"}`;
  if (op === "WasSet") return `${field} ${yes ? "was set" : "was not set"}`;
  if (op === "WasSelected" || op === "WasVisited") return `${field} ${yes ? "was chosen" : "was not chosen"}`;
  if (op === "IsBlank") return `${field} ${yes ? "is blank" : "is not blank"}`;
  return `${field} ${OP[op] || op.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${plainValue(val, labels)}`.trim();
}

function joinConditions(list, logic, labels) {
  const parts = asList(list).map(c => plainCondition(c, labels));
  if (parts.length <= 1) return parts.join("");
  const l = String(logic || "and").toLowerCase();
  if (l === "and" || l === "or") return parts.join(l === "and" ? " and " : " or ");
  // Custom logic "1 AND (2 OR 3)": put the conditions in.
  return String(logic).replace(/\d+/g, n => parts[+n - 1] || n).replace(/\bAND\b/gi, "and").replace(/\bOR\b/gi, "or");
}

const RECORD_WHEN = {Create: "created", Update: "updated", CreateAndUpdate: "created or updated", Delete: "deleted"};

// What kind of flow it is, in words.
export function flowKind(meta) {
  const m = meta || {};
  const s = m.start || {};
  if (s.object && s.triggerType && /^Record/.test(s.triggerType)) {
    const when = s.triggerType === "RecordBeforeSave" ? "before save" : s.triggerType === "RecordBeforeDelete" ? "before delete" : "after save";
    return {kind: "record", label: `When a ${s.object} is ${RECORD_WHEN[s.recordTriggerType] || "saved"}`, timing: when, object: s.object};
  }
  if (s.triggerType === "Scheduled" || s.schedule) return {kind: "scheduled", label: "Runs on a schedule", object: s.object || ""};
  if (s.triggerType === "PlatformEvent") return {kind: "event", label: `When a ${s.object || "platform"} event arrives`, object: s.object || ""};
  if (m.processType === "Flow") return {kind: "screen", label: "Screen flow: a person clicks through it", object: ""};
  if (/Orchestrat/.test(m.processType || "")) return {kind: "called", label: "Orchestration", object: ""};
  return {kind: "called", label: "Started by other automation, Apex or a button", object: ""};
}

// "Starts when a Case is created or updated, only if Priority is "High". Runs after the record is saved."
function whenSentence(m, labels) {
  const s = m.start || {};
  const k = flowKind(m);
  const parts = [];
  if (k.kind === "record") {
    parts.push(`Starts when a ${s.object} record is ${RECORD_WHEN[s.recordTriggerType] || "saved"}`);
    const f = joinConditions(s.filters, s.filterLogic, labels);
    if (f) parts[0] += `, only if ${f}`;
    else if (s.filterFormula) parts[0] += ", only when its entry formula is true";
    parts.push(k.timing === "before save" ? "It runs before the record is saved, so it can fill in fields fast."
      : k.timing === "before delete" ? "It runs just before the record is deleted." : "It runs after the record is saved.");
  } else if (k.kind === "scheduled") {
    const sc = s.schedule || {};
    parts.push(`Runs ${String(sc.frequency || "on a schedule").toLowerCase()}${sc.startTime ? ` at ${String(sc.startTime).slice(0, 5)}` : ""}` +
      (s.object ? ` for ${s.object} records${asList(s.filters).length ? ` where ${joinConditions(s.filters, s.filterLogic, labels)}` : ""}` : ""));
  } else if (k.kind === "event") parts.push(`Starts when a ${s.object || "platform"} event arrives`);
  else if (k.kind === "screen") parts.push("A person starts it (from a button, a page or a quick action) and clicks through its screens");
  else parts.push("It is started by other automation, Apex or a button: it does not run on its own");
  return parts.map(p => (/[.!?]$/.test(p) ? p : p + ".")).join(" ");
}

const ICON = {screens: "🖐", decisions: "◆", assignments: "✎", loops: "↻", recordLookups: "🔍", recordCreates: "➕", recordUpdates: "✎",
  recordDeletes: "🗑", subflows: "↳", collectionProcessors: "☰", waits: "⏸", customErrors: "⚠", orchestratedStages: "▣", transforms: "⇄"};

function actionText(e) {
  const t = String(e.actionType || "").toLowerCase();
  const name = e.label || e.actionName || e.name;
  if (t === "apex") return {icon: "⚙", text: `Run Apex code: ${String(e.actionName || name).split(".")[0]}`};
  if (t === "emailalert") return {icon: "✉", text: `Send the email alert "${name}"`};
  if (t === "emailsimple" || t === "email") return {icon: "✉", text: `Send an email: ${name}`};
  if (t === "submit") return {icon: "✔", text: `Submit for approval: ${name}`};
  if (t === "chattterpost" || t === "chatterpost") return {icon: "💬", text: `Post to Chatter: ${name}`};
  if (t === "flow") return {icon: "↳", text: `Run the flow ${e.actionName || name}`};
  if (t === "quickaction") return {icon: "⚡", text: `Run the quick action ${name}`};
  if (t === "externalservice") return {icon: "🌐", text: `Call an outside system: ${name}`};
  return {icon: "⚡", text: `Run the action "${name}"${e.actionType ? ` (${e.actionType})` : ""}`};
}

function setsText(assigns, labels) {
  const a = asList(assigns).map(x => `${plainField(x.field, labels)} = ${plainValue(x.value, labels)}`);
  return a.length ? ` (sets ${a.slice(0, 4).join(", ")}${a.length > 4 ? ", …" : ""})` : "";
}

// One step in words.
function stepText(key, e, m, labels) {
  const startObj = (m.start || {}).object || "record";
  switch (key) {
    case "recordLookups": {
      // "Id = $Record.AccountId" → "the Account linked to this Case".
      const f = asList(e.filters);
      const ref = f.length === 1 && f[0].field === "Id" && (f[0].operator || "EqualTo") === "EqualTo" && f[0].value && f[0].value.elementReference;
      if (ref && /^\$Record\./.test(ref)) return {icon: ICON[key], text: `Find the ${e.object || "record"} linked to this ${startObj}`};
      const where = joinConditions(e.filters, e.filterLogic, labels);
      return {icon: ICON[key], text: `${e.getFirstRecordOnly === false ? "Find all" : "Find the"} ${e.object || "records"}${where ? ` where ${where}` : ""}`};
    }
    case "recordCreates": return {icon: ICON[key], text: `Create a new ${e.object || "record"}${setsText(e.inputAssignments, labels)}`};
    case "recordUpdates":
      if (/^\$Record$/.test(e.inputReference || "")) return {icon: ICON[key], text: `Update this ${startObj}${setsText(e.inputAssignments, labels)}`};
      return {icon: ICON[key], text: `Update ${e.object ? `${e.object} records` : plainField(e.inputReference, labels) || "records"}` +
        `${asList(e.filters).length ? ` where ${joinConditions(e.filters, e.filterLogic, labels)}` : ""}${setsText(e.inputAssignments, labels)}`};
    case "recordDeletes": return {icon: ICON[key], text: `Delete ${e.object ? `${e.object} records` : plainField(e.inputReference, labels) || "records"}` +
      `${asList(e.filters).length ? ` where ${joinConditions(e.filters, e.filterLogic, labels)}` : ""}`};
    case "assignments": {
      const a = asList(e.assignmentItems).map(x => plainField(x.assignToReference, labels)).filter(Boolean);
      return {icon: ICON[key], text: `Fill in ${a.length ? a.slice(0, 4).join(", ") + (a.length > 4 ? ", …" : "") : e.label}`};
    }
    case "decisions": return {icon: ICON[key], text: `Check: ${e.label || e.name}`};
    case "loops": return {icon: ICON[key], text: `For each item in ${plainField(e.collectionReference, labels) || "the list"}`};
    case "screens": {
      const f = asList(e.fields).map(x => (x.fieldText ? x.fieldText.replace(/<[^>]+>/g, "").trim() : x.name)).filter(Boolean).slice(0, 3);
      return {icon: ICON[key], text: `Show the screen "${e.label}"${f.length ? ` (${f.join(", ")})` : ""}`, person: true};
    }
    case "actionCalls": return actionText(e);
    case "subflows": return {icon: ICON[key], text: `Run the flow ${e.flowName}`, subflow: e.flowName};
    case "customErrors": return {icon: ICON[key], text: `Stop and show the error: "${asList(e.customErrorMessages).map(x => x.errorMessage).join(" ")}"`};
    case "waits": return {icon: ICON[key], text: `Wait: ${e.label}`};
    case "collectionProcessors": return {icon: ICON[key], text: `Sort or filter a list: ${e.label}`};
    default: return {icon: "•", text: e.label || e.name};
  }
}

function elementsOf(m) {
  const byName = new Map();
  for (const key of ELEMENT_KEYS) for (const e of asList(m[key])) byName.set(e.name, {key, e});
  return byName;
}

// The story: {when, steps: [{n, name, icon, text, branches: [{label, to}], then, person, fault}], end}.
export function flowStory(meta) {
  const m = meta || {};
  const els = elementsOf(m);
  const labels = {};
  for (const [name, {e}] of els) labels[name] = e.label || name;
  const fs = flowSteps(m);
  const num = new Map(fs.steps.map((s, i) => [s.name, i + 1]));
  const target = t => (t && num.has(t) ? `step ${num.get(t)}` : "the end");
  const steps = fs.steps.map((s, i) => {
    const {key, e} = els.get(s.name) || {key: "", e: {label: s.label}};
    const t = stepText(key, e, m, labels);
    const out = {n: i + 1, name: s.name, key, icon: t.icon, text: t.text, person: !!t.person, subflow: t.subflow || null,
      apex: key === "actionCalls" && String(e.actionType).toLowerCase() === "apex" ? String(e.actionName || "").split(".")[0] : null,
      branches: [], then: null, fault: null};
    if (key === "decisions") {
      for (const r of asList(e.rules)) {
        out.branches.push({label: r.label || r.name, when: joinConditions(r.conditions, r.conditionLogic, labels), to: target(r.connector && r.connector.targetReference)});
      }
      out.branches.push({label: e.defaultConnectorLabel || "Otherwise", when: "", to: target(e.defaultConnector && e.defaultConnector.targetReference)});
    } else if (key === "loops") {
      out.branches.push({label: "For each item", when: "", to: target(e.nextValueConnector && e.nextValueConnector.targetReference)});
      out.branches.push({label: "When done", when: "", to: target(e.noMoreValuesConnector && e.noMoreValuesConnector.targetReference)});
    } else {
      const nx = e.connector && e.connector.targetReference;
      // Only say "then" when it doesn't simply go on to the next step.
      if (!nx) out.then = "the end";
      else if (num.get(nx) !== i + 2) out.then = target(nx);
    }
    if (e.faultConnector && e.faultConnector.targetReference) out.fault = target(e.faultConnector.targetReference);
    return out;
  });
  return {label: m.label || "", kind: flowKind(m), when: whenSentence(m, labels), steps, unreachable: fs.unreachable.length};
}

// "Find the Account" → "finds the Account" (for the one-line summary).
const VERB = [[/^Check: (.*)$/, (m, x) => `checks "${x.replace(/\?$/, "")}?"`], [/^Stop and show the error: /, "stops with the error "],
  [/^Fill in /, "fills in "], [/^For each item in /, "goes through each item in "], [/^Sort or filter a list: /, "sorts or filters "],
  [/^Show the screen /, "shows the screen "], [/^Run Apex code: /, "runs Apex "], [/^Run the /, "runs the "], [/^Run an? /, "runs a "],
  [/^Find /, "finds "], [/^Update /, "updates "], [/^Create /, "creates "], [/^Delete /, "deletes "], [/^Send /, "sends "],
  [/^Submit /, "submits "], [/^Post /, "posts "], [/^Call /, "calls "], [/^Wait: /, "waits for "]];
function thirdPerson(text) {
  for (const [re, to] of VERB) if (re.test(text)) return text.replace(re, to);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// One line for lists: "When a Case is created or updated: finds the Account, checks "Gold customer?", updates this Case."
export function flowSummary(meta) {
  const st = flowStory(meta);
  const verbs = st.steps.slice(0, 4)
    .map(s => thirdPerson(s.text.replace(/ \(sets[^)]*\)$/, "").replace(/ where .*$/, "")));
  const head = st.kind.kind === "record" ? st.kind.label : st.kind.kind === "screen" ? "A screen flow" : st.kind.label;
  return `${head}: ${verbs.join(", ") || "does nothing yet"}${st.steps.length > 4 ? ", …" : ""}.`;
}

// Simple diagram: plain labels and icons, assignments in a row folded into
// one box, decisions with their outcome labels, fault paths in red.
export function simpleFlowDiagram(meta, {linkFor = () => null, maxSteps = 60} = {}) {
  const m = meta || {};
  const story = flowStory(m);
  const els = elementsOf(m);
  const byName = new Map(story.steps.map(s => [s.name, s]));
  // Fold chains of assignments: A → B (B only reached from A) become one box.
  const incoming = new Map();
  const nextOf = name => {
    const x = els.get(name);
    return x && x.e.connector ? x.e.connector.targetReference : null;
  };
  for (const s of story.steps) {
    const x = els.get(s.name);
    const outs = [];
    if (!x) continue;
    const e = x.e;
    if (e.connector) outs.push(e.connector.targetReference);
    if (e.defaultConnector) outs.push(e.defaultConnector.targetReference);
    for (const r of asList(e.rules)) if (r.connector) outs.push(r.connector.targetReference);
    if (e.nextValueConnector) outs.push(e.nextValueConnector.targetReference);
    if (e.noMoreValuesConnector) outs.push(e.noMoreValuesConnector.targetReference);
    if (e.faultConnector) outs.push(e.faultConnector.targetReference);
    for (const o of outs) if (o) incoming.set(o, (incoming.get(o) || 0) + 1);
  }
  const startTarget = (m.start && m.start.connector && m.start.connector.targetReference) || m.startElementReference;
  if (startTarget) incoming.set(startTarget, (incoming.get(startTarget) || 0) + 1);
  const mergedInto = new Map(); // name → head of its folded chain
  const folded = new Map();     // head → [names]
  for (const s of story.steps) {
    if (s.key !== "assignments" || mergedInto.has(s.name)) continue;
    const chain = [s.name];
    let cur = s.name;
    for (;;) {
      const nx = nextOf(cur);
      const ns = nx && byName.get(nx);
      if (!ns || ns.key !== "assignments" || (incoming.get(nx) || 0) !== 1 || mergedInto.has(nx)) break;
      chain.push(nx);
      mergedInto.set(nx, s.name);
      cur = nx;
    }
    if (chain.length > 1) folded.set(s.name, chain);
  }
  const headOf = name => mergedInto.get(name) || name;
  const id = name => "s:" + headOf(name);
  const steps = story.steps.filter(s => !mergedInto.has(s.name)).slice(0, maxSteps);
  const shown = new Set(steps.map(s => s.name));
  const kindOf = s => (s.key === "decisions" || s.key === "loops" ? "decision" : s.person ? "page"
    : /^record/.test(s.key) ? "data" : s.key === "customErrors" ? "error" : s.subflow || s.key === "actionCalls" ? "call" : "step");
  const nodes = [{id: "s:start", label: "▶ " + (story.kind.kind === "record" ? story.kind.label : story.kind.kind === "screen" ? "A person starts it" : story.kind.label),
    sub: story.kind.kind === "record" ? story.kind.timing : "", kind: "start", shape: "pill"}];
  for (const s of steps) {
    const chain = folded.get(s.name);
    let label = `${s.icon} ${s.text}`;
    if (chain) {
      const fields = chain.flatMap(n => (stepText("assignments", els.get(n).e, m, {}).text.replace(/^Fill in /, "").split(", ")));
      label = `✎ Fill in ${[...new Set(fields)].slice(0, 5).join(", ")}`;
    }
    nodes.push({id: id(s.name), label: label.length > 90 ? label.slice(0, 88) + "…" : label, kind: kindOf(s),
      shape: s.key === "decisions" ? "diamond" : s.key === "loops" ? "round" : /^record/.test(s.key) ? "data" : s.person ? "round" : "rect",
      double: !!(s.subflow || s.apex), link: s.subflow ? linkFor("flow", s.subflow) : s.apex ? linkFor("class", s.apex) : null,
      sub: s.person ? "a person does this" : ""});
  }
  const edges = [];
  let needEnd = false;
  const to = t => (t && shown.has(headOf(t)) ? id(t) : (needEnd = true, "s:end"));
  if (startTarget) edges.push({from: "s:start", to: to(startTarget)});
  else needEnd = true, edges.push({from: "s:start", to: "s:end"});
  for (const s of steps) {
    const tail = (folded.get(s.name) || [s.name]).slice(-1)[0];
    const e = (els.get(tail) || {}).e || {};
    if (s.key === "decisions") {
      for (const r of asList(e.rules)) edges.push({from: id(s.name), to: to(r.connector && r.connector.targetReference), label: r.label || r.name});
      edges.push({from: id(s.name), to: to(e.defaultConnector && e.defaultConnector.targetReference), label: e.defaultConnectorLabel || "Otherwise"});
    } else if (s.key === "loops") {
      edges.push({from: id(s.name), to: to(e.nextValueConnector && e.nextValueConnector.targetReference), label: "each item"});
      edges.push({from: id(s.name), to: to(e.noMoreValuesConnector && e.noMoreValuesConnector.targetReference), label: "when done"});
    } else {
      edges.push({from: id(s.name), to: to(e.connector && e.connector.targetReference)});
    }
    const own = (els.get(s.name) || {}).e || {};
    if (own.faultConnector) edges.push({from: id(s.name), to: to(own.faultConnector.targetReference), label: "if it fails", kind: "fault"});
  }
  if (needEnd) nodes.push({id: "s:end", label: "■ Done", kind: "start", shape: "pill"});
  // Same arrow twice (e.g. two outcomes to the end) → one arrow with both labels.
  const merged = [];
  for (const e of edges) {
    const same = merged.find(x => x.from === e.from && x.to === e.to && x.kind === e.kind);
    if (same) same.label = [same.label, e.label].filter(Boolean).join(" / ");
    else merged.push({...e});
  }
  return {dir: "TB", nodes, edges: merged, more: Math.max(0, story.steps.length - mergedInto.size - steps.length)};
}

// The story as plain text (copy, Markdown and the AI's input).
export function storyText(story) {
  const out = [story.when];
  for (const s of story.steps) {
    out.push(`${s.n}. ${s.text}${s.person ? " (a person does this)" : ""}`);
    for (const b of s.branches) out.push(`   - ${b.label}${b.when ? ` (${b.when})` : ""}: go to ${b.to}`);
    if (s.then) out.push(`   - then: ${s.then === "the end" ? "done" : "go to " + s.then}`);
    if (s.fault) out.push(`   - if it fails: go to ${s.fault}`);
  }
  return out.join("\n");
}
