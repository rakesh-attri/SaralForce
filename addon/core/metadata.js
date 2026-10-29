// Pure helpers for the Metadata tab: package.xml, ER diagram layout.
// No chrome/window/DOM access so they can be unit-tested.

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// members: {MetadataType: [fullName, …]} → package.xml text. Types and
// members are sorted and de-duplicated, as the Metadata API expects.
export function buildPackageXml(members, apiVersion) {
  const types = Object.keys(members || {}).filter(t => (members[t] || []).length).sort();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
  ];
  for (const t of types) {
    lines.push("    <types>");
    for (const m of [...new Set(members[t])].sort()) lines.push(`        <members>${xmlEscape(m)}</members>`);
    lines.push(`        <name>${xmlEscape(t)}</name>`);
    lines.push("    </types>");
  }
  lines.push(`    <version>${xmlEscape(apiVersion)}</version>`);
  lines.push("</Package>");
  return lines.join("\n") + "\n";
}

export function packageCount(members) {
  return Object.values(members || {}).reduce((n, list) => n + new Set(list).size, 0);
}

// Add or remove one member; returns a new members object.
export function togglePackageMember(members, type, name) {
  const next = {...(members || {})};
  const list = new Set(next[type] || []);
  if (list.has(name)) list.delete(name); else list.add(name);
  if (list.size) next[type] = [...list]; else delete next[type];
  return next;
}

// ER diagram: the object in the middle, parents (lookups) on the left and
// children on the right. Returns boxes and edges in SVG coordinates.
//   parents:  [{name, via}]  via = lookup field name
//   children: [{name, via}]  via = child relationship name
export function erLayout(center, parents, children, {max = 12, boxW = 170, boxH = 30, gapY = 12, colGap = 90} = {}) {
  const left = parents.slice(0, max);
  const right = children.slice(0, max);
  const rows = Math.max(left.length, right.length, 1);
  const height = Math.max(rows * (boxH + gapY) + gapY, boxH + 2 * gapY + 40);
  const width = boxW * 3 + colGap * 2 + 20;
  const cx = boxW + colGap + 10;
  const cy = Math.round(height / 2 - boxH / 2);
  const boxes = [{name: center, x: cx, y: cy, w: boxW, h: boxH, role: "center"}];
  const edges = [];
  const column = (list, x, role) => {
    const total = list.length * (boxH + gapY) - gapY;
    let y = Math.round((height - total) / 2);
    for (const item of list) {
      boxes.push({name: item.name, via: item.via, x, y, w: boxW, h: boxH, role});
      const fromLeft = role === "parent";
      edges.push({
        x1: fromLeft ? x + boxW : cx + boxW, y1: fromLeft ? y + boxH / 2 : cy + boxH / 2,
        x2: fromLeft ? cx : x, y2: fromLeft ? cy + boxH / 2 : y + boxH / 2,
        label: item.via, role,
      });
      y += boxH + gapY;
    }
  };
  column(left, 10, "parent");
  column(right, cx + boxW + colGap, "child");
  return {width, height, boxes, edges, hiddenParents: parents.length - left.length, hiddenChildren: children.length - right.length};
}

// Parents and children for erLayout from a describe result. Children skip
// system companions (History, Share, Feed, ChangeEvent) unless asked.
export function relationshipsFromDescribe(d, {includeSystem = false} = {}) {
  const parents = [];
  const seen = new Set();
  for (const f of d.fields || []) {
    if (f.type !== "reference" || !f.referenceTo || !f.referenceTo.length) continue;
    for (const target of f.referenceTo) {
      const key = target + ":" + f.name;
      if (seen.has(key)) continue;
      seen.add(key);
      parents.push({name: target, via: f.name});
    }
  }
  const system = /(History|Share|Feed|ChangeEvent|__hd|__Share|__Feed|__History)$/;
  const children = (d.childRelationships || [])
    .filter(r => r.relationshipName && (includeSystem || !system.test(r.childSObject)))
    .map(r => ({name: r.childSObject, via: r.relationshipName}));
  return {parents, children};
}

const FLOW_ELEMENT_TYPES = [
  ["screens", "Screens"], ["decisions", "Decisions"], ["assignments", "Assignments"], ["loops", "Loops"],
  ["recordLookups", "Get Records"], ["recordCreates", "Create Records"], ["recordUpdates", "Update Records"],
  ["recordDeletes", "Delete Records"], ["actionCalls", "Actions"], ["subflows", "Subflows"],
  ["collectionProcessors", "Collection processors"], ["waits", "Waits"],
];

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Readable outline of Flow metadata (Tooling API Flow.Metadata): what
// starts it and which elements it has. Used for display and as AI context.
export function summarizeFlow(meta) {
  const m = meta || {};
  const lines = [];
  lines.push(`Label: ${m.label || "?"}`);
  lines.push(`Type: ${m.processType || "?"}${m.status ? ` · ${m.status}` : ""}`);
  const s = m.start || {};
  if (s.object || s.triggerType || s.recordTriggerType) {
    const when = [s.recordTriggerType, s.triggerType].filter(Boolean).join(", ");
    lines.push(`Starts: ${s.object ? `${s.object} record` : "trigger"}${when ? ` (${when})` : ""}`);
    const filters = asList(s.filters).map(f => `${f.field} ${f.operator} ${f.value && Object.values(f.value)[0]}`);
    if (filters.length) lines.push(`Entry conditions: ${filters.join(` ${s.filterLogic || "AND"} `)}`);
  }
  if (s.schedule) lines.push(`Schedule: ${s.schedule.frequency || ""} ${s.schedule.startDate || ""} ${s.schedule.startTime || ""}`.trim());
  for (const [key, label] of FLOW_ELEMENT_TYPES) {
    const els = asList(m[key]);
    if (!els.length) continue;
    const names = els.map(e => e.label || e.name).filter(Boolean);
    lines.push(`${label} (${els.length}): ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`);
  }
  const vars = asList(m.variables);
  if (vars.length) lines.push(`Variables: ${vars.map(v => v.name).slice(0, 15).join(", ")}${vars.length > 15 ? ", …" : ""}`);
  return lines.join("\n");
}

const FLOW_TYPES = {
  screens: ["Screen", "🖥️"], decisions: ["Decision", "◆"], assignments: ["Assignment", "＝"], loops: ["Loop", "↻"],
  recordLookups: ["Get Records", "🔍"], recordCreates: ["Create Records", "➕"], recordUpdates: ["Update Records", "✎"],
  recordDeletes: ["Delete Records", "🗑️"], actionCalls: ["Action", "⚡"], subflows: ["Subflow", "↳"],
  collectionProcessors: ["Collection", "☰"], waits: ["Wait", "⏸"], customErrors: ["Custom Error", "⚠️"],
};

function flowValue(v) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  const k = Object.keys(v).find(x => v[x] != null);
  return k ? (k === "elementReference" ? `{!${v[k]}}` : String(v[k])) : "";
}

function conditionText(c) {
  return `${c.leftValueReference || c.field || "?"} ${c.operator || "="} ${flowValue(c.rightValue || c.value)}`.trim();
}

function elementDetails(type, e) {
  const d = [];
  if (e.object) d.push(`Object: ${e.object}`);
  if (type === "recordLookups" || type === "recordUpdates" || type === "recordDeletes") {
    const f = asList(e.filters).map(conditionText);
    if (f.length) d.push(`Where ${f.join(` ${e.filterLogic || "AND"} `)}`);
    if (e.inputReference) d.push(`Record: {!${e.inputReference}}`);
  }
  if (type === "recordCreates" || type === "recordUpdates") {
    const a = asList(e.inputAssignments).map(x => `${x.field} = ${flowValue(x.value)}`);
    if (a.length) d.push(`Set ${a.slice(0, 6).join(", ")}${a.length > 6 ? ", …" : ""}`);
  }
  if (type === "assignments") {
    const a = asList(e.assignmentItems).map(x => `${x.assignToReference} ${x.operator === "Add" ? "+=" : "="} ${flowValue(x.value)}`);
    if (a.length) d.push(a.slice(0, 6).join(", ") + (a.length > 6 ? ", …" : ""));
  }
  if (type === "actionCalls") d.push(`${e.actionType || "action"}: ${e.actionName || ""}`.trim());
  if (type === "subflows" && e.flowName) d.push(`Runs flow ${e.flowName}`);
  if (type === "loops" && e.collectionReference) d.push(`Each item in {!${e.collectionReference}}`);
  if (type === "screens") {
    const f = asList(e.fields).map(x => (x.fieldText ? x.fieldText.replace(/<[^>]+>/g, "").slice(0, 40) : x.name)).filter(Boolean);
    if (f.length) d.push(`Shows ${f.slice(0, 5).join(", ")}${f.length > 5 ? ", …" : ""}`);
  }
  if (type === "customErrors") d.push(asList(e.customErrorMessages).map(x => x.errorMessage).join("; "));
  return d.filter(Boolean);
}

function elementNext(type, e) {
  const out = [];
  const add = (label, c) => { if (c && c.targetReference) out.push({label, target: c.targetReference}); };
  if (type === "decisions") {
    for (const r of asList(e.rules)) {
      const logic = r.conditionLogic && r.conditionLogic !== "and" ? r.conditionLogic : "AND";
      out.push({
        label: `${r.label || r.name}: ${asList(r.conditions).map(conditionText).join(` ${logic} `)}`,
        target: r.connector && r.connector.targetReference,
      });
    }
    add(e.defaultConnectorLabel || "Otherwise", e.defaultConnector);
  } else if (type === "loops") {
    add("For each item", e.nextValueConnector);
    add("After last item", e.noMoreValuesConnector);
  } else {
    add("", e.connector);
  }
  add("If it fails", e.faultConnector);
  return out;
}

const RECORD_WHEN = {Create: "created", Update: "updated", CreateAndUpdate: "created or updated", Delete: "deleted"};
const TRIGGER_WHEN = {
  RecordBeforeSave: "Before the record is saved (fast field updates)", RecordAfterSave: "After the record is saved",
  RecordBeforeDelete: "Before the record is deleted", Scheduled: "On a schedule", PlatformEvent: "When a platform event arrives",
};

// Flow as an ordered path: a start summary, then elements in the order the
// flow reaches them (breadth-first from the start), each with plain-words
// details and where it goes next. Unreachable elements are listed last.
export function flowSteps(meta) {
  const m = meta || {};
  const byName = new Map();
  for (const type of Object.keys(FLOW_TYPES)) {
    for (const e of asList(m[type])) {
      const [typeLabel, icon] = FLOW_TYPES[type];
      byName.set(e.name, {name: e.name, label: e.label || e.name, type, typeLabel, icon,
        details: elementDetails(type, e), next: elementNext(type, e)});
    }
  }
  const s = m.start || {};
  const startTarget = (s.connector && s.connector.targetReference) || m.startElementReference || null;
  const startDetails = [];
  if (s.object) startDetails.push(`When a ${s.object} record is ${RECORD_WHEN[s.recordTriggerType] || "changed"}`);
  if (s.triggerType) startDetails.push(TRIGGER_WHEN[s.triggerType] || s.triggerType);
  const filters = asList(s.filters).map(conditionText);
  if (filters.length) startDetails.push(`Only if ${filters.join(` ${s.filterLogic || "AND"} `)}`);
  if (s.schedule) startDetails.push(`Runs ${String(s.schedule.frequency || "").toLowerCase()} from ${s.schedule.startDate || "?"} ${s.schedule.startTime || ""}`.trim());
  if (!s.object && !s.triggerType && !s.schedule) {
    startDetails.push(m.processType === "Flow" ? "Started by a user (screen flow)" : "Started by another process, Apex or a button");
  }
  const order = [];
  const seen = new Set();
  const queue = startTarget ? [startTarget] : [];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n) || !byName.has(n)) continue;
    seen.add(n);
    const el = byName.get(n);
    order.push(el);
    for (const x of el.next) if (x.target) queue.push(x.target);
  }
  const index = new Map(order.map((e, i) => [e.name, i + 1]));
  const labelOf = name => (byName.has(name) ? `${index.get(name) ? index.get(name) + ". " : ""}${byName.get(name).label}` : name);
  const decorate = el => ({...el, next: el.next.map(x => ({...x, targetLabel: x.target ? labelOf(x.target) : "End"}))});
  return {
    label: m.label || "",
    processType: m.processType || "",
    status: m.status || "",
    start: {details: startDetails, next: startTarget ? labelOf(startTarget) : "End"},
    steps: order.map(decorate),
    unreachable: [...byName.values()].filter(e => !seen.has(e.name)).map(decorate),
  };
}
