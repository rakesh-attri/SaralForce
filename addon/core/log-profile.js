// Debug log profiler: turns an Apex debug log into a call tree with times,
// top methods, SOQL / DML / callout tables and plain-language hot spots
// (queries in loops, DML in loops, slow callouts, limits near the edge).
// Pure: no DOM, unit-tested.
import {parseLimitUsage} from "./apex-anon.js";

// "12:00:00.123 (1234567)|EVENT|a|b" — the number in brackets is nanoseconds.
const LINE = /^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*\((\d+)\)\|([A-Z][A-Z0-9_]*)(?:\|(.*))?$/;

const PAIRS = {
  CODE_UNIT_STARTED: ["CODE_UNIT_FINISHED", "unit"],
  METHOD_ENTRY: ["METHOD_EXIT", "method"],
  CONSTRUCTOR_ENTRY: ["CONSTRUCTOR_EXIT", "method"],
  SOQL_EXECUTE_BEGIN: ["SOQL_EXECUTE_END", "soql"],
  SOSL_EXECUTE_BEGIN: ["SOSL_EXECUTE_END", "soql"],
  DML_BEGIN: ["DML_END", "dml"],
  CALLOUT_REQUEST: ["CALLOUT_RESPONSE", "callout"],
  FLOW_START_INTERVIEW_BEGIN: ["FLOW_START_INTERVIEW_END", "flow"]
};
const ENDS = Object.fromEntries(Object.entries(PAIRS).map(([b, [e]]) => [e, b]));

function lineNo(field) {
  const m = /^\[(\d+)\]$/.exec(field || "");
  return m ? Number(m[1]) : null;
}

function describe(event, parts) {
  const line = lineNo(parts[0]);
  switch (event) {
    case "CODE_UNIT_STARTED": return {name: parts[parts.length - 1] || "Code unit", line: null};
    case "METHOD_ENTRY":
    case "CONSTRUCTOR_ENTRY": return {name: parts[parts.length - 1] || "method", line};
    case "SOQL_EXECUTE_BEGIN":
    case "SOSL_EXECUTE_BEGIN": return {name: parts[parts.length - 1] || "query", line};
    case "DML_BEGIN": {
      const op = (/Op:(\w+)/.exec(parts.join("|")) || [])[1] || "DML";
      const type = (/Type:([\w]+)/.exec(parts.join("|")) || [])[1] || "";
      const rows = Number((/Rows:(\d+)/.exec(parts.join("|")) || [])[1] || 0);
      return {name: `${op} ${type}`.trim(), line, op, type, rows};
    }
    case "CALLOUT_REQUEST": {
      const ep = (/Endpoint=([^,\]]+)/.exec(parts.join("|")) || [])[1] || parts[parts.length - 1] || "callout";
      return {name: ep, line};
    }
    case "FLOW_START_INTERVIEW_BEGIN": return {name: parts[parts.length - 1] || "Flow", line: null};
    default: return {name: event, line};
  }
}

export function parseProfile(text) {
  const root = {kind: "root", name: "Log", start: null, end: null, children: [], line: null};
  const stack = [root];
  let first = null;
  let last = null;
  const debug = [];
  const errors = [];
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const ns = Number(m[2]);
    const event = m[3];
    const parts = m[4] != null ? m[4].split("|") : [];
    if (first === null) first = ns;
    last = ns;
    if (PAIRS[event]) {
      const info = describe(event, parts);
      const node = {kind: PAIRS[event][1], event, start: ns, end: null, children: [], ...info};
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    if (ENDS[event]) {
      // Pop to the matching open frame (logs can drop an exit line).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].event === ENDS[event]) {
          if (event === "SOQL_EXECUTE_END") stack[i].rows = Number((/Rows:(\d+)/.exec(m[4] || "") || [])[1] || 0);
          if (event === "CALLOUT_RESPONSE") stack[i].status = (/StatusCode=(\d+)/.exec(m[4] || "") || [])[1] || "";
          for (let j = stack.length - 1; j >= i; j--) stack[j].end = ns;
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (event === "USER_DEBUG") debug.push(parts[parts.length - 1] || "");
    if (event === "EXCEPTION_THROWN" || event === "FATAL_ERROR") errors.push({line: lineNo(parts[0]), message: parts[parts.length - 1] || event});
  }
  for (let j = stack.length - 1; j > 0; j--) if (stack[j].end == null) stack[j].end = last;
  root.start = first || 0;
  root.end = last || 0;
  finish(root);
  return summarize(root, text, {debug, errors});
}

function finish(node) {
  node.dur = Math.max(0, (node.end || 0) - (node.start || 0));
  let kids = 0;
  for (const c of node.children) {
    finish(c);
    kids += c.dur;
  }
  node.self = Math.max(0, node.dur - kids);
}

function walk(node, fn, depth = 0, path = []) {
  fn(node, depth, path);
  for (const c of node.children) walk(c, fn, depth + 1, node.kind === "root" ? path : [...path, node]);
}

const ms = ns => Math.round(ns / 1e4) / 100;

// Same query with different literal values counts as one.
export function normalizeQuery(q) {
  return String(q || "").replace(/'(?:[^'\\]|\\.)*'/g, "?").replace(/\b\d+(\.\d+)?\b/g, "?").replace(/\s+/g, " ").trim();
}

function summarize(root, text, {debug, errors}) {
  const total = root.dur;
  const methods = new Map();
  const soql = [];
  const dml = [];
  const callouts = [];
  const timeline = [];
  walk(root, (n, depth, path) => {
    if (n.kind === "root") return;
    const inLoopOf = path.filter(p => p.kind === "method" || p.kind === "unit").pop();
    if (n.kind === "method" || n.kind === "unit") {
      const m = methods.get(n.name) || {name: n.name, calls: 0, total: 0, self: 0};
      m.calls++;
      m.self += n.self;
      // Count total once for recursive calls.
      if (!path.some(p => p.name === n.name)) m.total += n.dur;
      methods.set(n.name, m);
    }
    if (n.kind === "soql") soql.push({query: n.name, line: n.line, rows: n.rows || 0, ms: ms(n.dur), caller: inLoopOf ? inLoopOf.name : ""});
    if (n.kind === "dml") dml.push({op: n.op, type: n.type, rows: n.rows || 0, line: n.line, ms: ms(n.dur), caller: inLoopOf ? inLoopOf.name : ""});
    if (n.kind === "callout") callouts.push({endpoint: n.name, line: n.line, status: n.status || "", ms: ms(n.dur)});
    if (timeline.length < 400 && depth <= 8 && (n.dur >= total * 0.01 || ["soql", "dml", "callout", "unit", "flow"].includes(n.kind))) {
      timeline.push({depth: depth - 1, kind: n.kind, name: n.name, line: n.line,
        left: total ? ((n.start - root.start) / total) * 100 : 0, width: total ? Math.max(0.3, (n.dur / total) * 100) : 0, ms: ms(n.dur)});
    }
  });
  const soqlGroups = groupBy(soql, s => normalizeQuery(s.query) + "@" + (s.line || ""))
    .map(g => ({query: g.items[0].query, line: g.items[0].line, times: g.items.length, rows: sum(g.items, "rows"), ms: round(sum(g.items, "ms")), caller: g.items[0].caller}))
    .sort((a, b) => b.times - a.times || b.ms - a.ms);
  const dmlGroups = groupBy(dml, d => `${d.op}|${d.type}|${d.line || ""}`)
    .map(g => ({op: g.items[0].op, type: g.items[0].type, line: g.items[0].line, times: g.items.length, rows: sum(g.items, "rows"), ms: round(sum(g.items, "ms")), caller: g.items[0].caller}))
    .sort((a, b) => b.times - a.times || b.ms - a.ms);
  const limits = parseLimitUsage(text);
  const methodList = [...methods.values()].map(m => ({...m, total: ms(m.total), self: ms(m.self)}));
  const profile = {
    totalMs: ms(total),
    counts: {soql: soql.length, dml: dml.length, callouts: callouts.length, methods: methodList.reduce((n, m) => n + m.calls, 0)},
    topSelf: methodList.slice().sort((a, b) => b.self - a.self).slice(0, 15),
    topTotal: methodList.slice().sort((a, b) => b.total - a.total).slice(0, 15),
    soql: soqlGroups, dml: dmlGroups, callouts, timeline, limits, debug: debug.slice(0, 50), errors
  };
  profile.insights = insights(profile);
  return profile;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const it of list) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, {key: k, items: []});
    map.get(k).items.push(it);
  }
  return [...map.values()];
}

const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0);
const round = n => Math.round(n * 100) / 100;

// Plain hot spots, worst first: {level: "err"|"warn"|"info", text}.
export function insights(p) {
  const out = [];
  for (const q of p.soql.filter(x => x.times >= 3)) {
    out.push({level: q.times >= 20 ? "err" : "warn", text: `The same query ran ${q.times} times${q.line ? ` from line ${q.line}` : ""}${q.caller ? ` in ${q.caller}` : ""}: likely a query inside a loop. Query once before the loop and use a Map.`, query: q.query});
  }
  for (const d of p.dml.filter(x => x.times >= 3)) {
    out.push({level: d.times >= 20 ? "err" : "warn", text: `${d.op} ${d.type} ran ${d.times} times${d.line ? ` from line ${d.line}` : ""}: DML inside a loop. Collect records in a list and do one ${d.op}.`});
  }
  for (const q of p.soql.filter(x => x.rows >= 10000)) out.push({level: "warn", text: `A query returned ${q.rows} rows${q.line ? ` (line ${q.line})` : ""}. Add filters or use a selective field.`});
  for (const c of p.callouts.filter(x => x.ms >= 2000)) out.push({level: "warn", text: `Callout to ${c.endpoint} took ${(c.ms / 1000).toFixed(1)} s. Consider async (Queueable) or a shorter timeout.`});
  for (const l of p.limits.filter(x => x.pct >= 70)) out.push({level: l.pct >= 90 ? "err" : "warn", text: `${l.name}: ${l.used} of ${l.max} (${l.pct}%).`});
  const top = p.topSelf[0];
  if (top && p.totalMs > 0 && top.self / p.totalMs >= 0.4 && top.self >= 50) out.push({level: "info", text: `${top.name} uses ${Math.round(top.self / p.totalMs * 100)}% of the time on its own code.`});
  // EXCEPTION_THROWN and FATAL_ERROR usually repeat the same message.
  const seen = new Set();
  for (const e of p.errors) {
    if (seen.has(e.message) || seen.size >= 3) continue;
    seen.add(e.message);
    out.push({level: "err", text: `Error${e.line ? ` at line ${e.line}` : ""}: ${e.message}`});
  }
  const rank = {err: 0, warn: 1, info: 2};
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// Short summary for AI (never the raw log).
export function profileForPrompt(p) {
  const lines = [`Total ${p.totalMs} ms · ${p.counts.soql} SOQL · ${p.counts.dml} DML · ${p.counts.callouts} callouts`];
  lines.push("Hot spots:", ...p.insights.slice(0, 10).map(i => "- " + i.text));
  lines.push("Slowest methods (self ms / total ms / calls):", ...p.topSelf.slice(0, 10).map(m => `- ${m.name}: ${m.self} / ${m.total} / ${m.calls}`));
  lines.push("Queries (times, rows, ms, line):", ...p.soql.slice(0, 10).map(q => `- ${q.times}× ${q.rows} rows ${q.ms} ms line ${q.line || "?"}: ${String(q.query).slice(0, 200)}`));
  lines.push("DML:", ...p.dml.slice(0, 10).map(d => `- ${d.times}× ${d.op} ${d.type} ${d.rows} rows line ${d.line || "?"}`));
  if (p.limits.length) lines.push("Limits:", ...p.limits.filter(l => l.used > 0).map(l => `- ${l.name}: ${l.used}/${l.max}`));
  return lines.join("\n");
}
