// Apex test runs followed by their job id: progress from ApexTestQueueItem,
// per-method results from ApexTestResult, and line-level coverage. Pure
// helpers so they can be unit-tested with `node --test`.

const PENDING = new Set(["Queued", "Holding", "Preparing", "Processing"]);

// Queue items of one run → progress. finished when nothing is still pending.
export function summarizeQueue(items) {
  const list = items || [];
  const pending = list.filter(i => PENDING.has(i.Status)).length;
  return {
    total: list.length,
    done: list.length - pending,
    pending,
    failed: list.filter(i => i.Status === "Failed").length,
    aborted: list.filter(i => i.Status === "Aborted").length,
    finished: list.length > 0 && pending === 0,
  };
}

// Polling a run gives up after this many failed queue queries in a row, and
// calls a run empty after this many polls in a row that returned no items.
export const POLL_MAX_FAILURES = 3;
export const POLL_MAX_EMPTY = 5;

// One poll of the queue → the next poll state. `outcome` is {items} or
// {error}. `stop` is null (keep polling), "finished", "empty" or "error".
export function nextPoll(prev, outcome) {
  const s = prev || {failures: 0, empties: 0, progress: null};
  if (outcome && outcome.error) {
    const failures = s.failures + 1;
    const message = outcome.error.message || String(outcome.error);
    return {...s, failures, error: message, stop: failures >= POLL_MAX_FAILURES ? "error" : null};
  }
  const progress = summarizeQueue(outcome && outcome.items);
  const empties = progress.total === 0 ? s.empties + 1 : 0;
  const stop = progress.finished ? "finished" : empties >= POLL_MAX_EMPTY ? "empty" : null;
  return {failures: 0, empties, progress, error: null, stop};
}

// ApexCodeCoverage rows → the distinct test classes that cover a class or
// trigger, sorted by name: [{classId, name}].
export function coveringTestClasses(rows) {
  const byId = new Map();
  for (const r of rows || []) {
    const id = r.ApexTestClassId;
    if (!id || byId.has(id)) continue;
    byId.set(id, {classId: id, name: (r.ApexTestClass && r.ApexTestClass.Name) || id});
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A 15- or 18-character Salesforce id (safe to put in a SOQL literal).
export function isSfId(id) {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(id || ""));
}

// Queue items that can still be aborted.
export function abortableItems(items) {
  return (items || []).filter(i => PENDING.has(i.Status));
}

// ApexTestResult rows → classes (failures first) with their methods.
export function groupTestResults(results) {
  const byClass = new Map();
  for (const r of results || []) {
    const cls = (r.ApexClass && r.ApexClass.Name) || r.ApexClassId || "(unknown class)";
    if (!byClass.has(cls)) byClass.set(cls, {className: cls, classId: r.ApexClassId || null, methods: []});
    byClass.get(cls).methods.push({
      id: r.Id, name: r.MethodName, outcome: r.Outcome,
      message: r.Message || "", stackTrace: r.StackTrace || "", ms: r.RunTime == null ? null : Number(r.RunTime),
    });
  }
  const classes = [...byClass.values()].map(c => {
    c.methods.sort((a, b) => (a.outcome === "Pass") - (b.outcome === "Pass") || String(a.name).localeCompare(String(b.name)));
    c.passed = c.methods.filter(m => m.outcome === "Pass").length;
    c.failed = c.methods.filter(m => m.outcome === "Fail" || m.outcome === "CompileFail").length;
    c.skipped = c.methods.filter(m => m.outcome === "Skip").length;
    return c;
  });
  classes.sort((a, b) => (b.failed > 0) - (a.failed > 0) || a.className.localeCompare(b.className));
  return {
    classes,
    passed: classes.reduce((n, c) => n + c.passed, 0),
    failed: classes.reduce((n, c) => n + c.failed, 0),
    skipped: classes.reduce((n, c) => n + c.skipped, 0),
  };
}

// ApexCodeCoverageAggregate.Coverage → {line: "covered" | "uncovered"}.
export function coverageLineMap(coverage) {
  const out = {};
  for (const n of (coverage && coverage.coveredLines) || []) out[n] = "covered";
  for (const n of (coverage && coverage.uncoveredLines) || []) out[n] = "uncovered";
  return out;
}

// The source of one method (from its declaration to the matching closing
// brace), for AI context. Returns "" when the method isn't found.
export function extractMethodSource(body, methodName, maxLines = 80) {
  const src = String(body || "");
  const re = new RegExp(`\\b${String(methodName).replace(/[^\w]/g, "")}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return "";
  const lineStart = src.lastIndexOf("\n", m.index) + 1;
  let depth = 0;
  let end = src.length;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return src.slice(lineStart, end).split("\n").slice(0, maxLines).join("\n");
}

// "Class.TestClass.method: line 12, column 1" → [{cls, method, line}].
export function parseStackTrace(stack) {
  const out = [];
  for (const m of String(stack || "").matchAll(/Class\.([\w.]+?)\.(\w+): line (\d+)/g)) {
    out.push({cls: m[1], method: m[2], line: Number(m[3])});
  }
  return out;
}
