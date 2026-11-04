// Line diff (Myers, O(ND)) for the Release compare view. Pure, no DOM.

// a, b: strings → [{type: "same"|"del"|"add", text, a, b}] where a / b are
// 1-based line numbers in each side (null on the side the line is missing).
export function diffLines(aText, bText, {maxEdits = 4000} = {}) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midOps = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push("same");
  ops.push(...midOps);
  for (let i = endA; i < a.length; i++) ops.push("same");
  const out = [];
  let ia = 0;
  let ib = 0;
  for (const op of ops) {
    if (op === "same") { out.push({type: "same", text: a[ia], a: ia + 1, b: ib + 1}); ia++; ib++; }
    else if (op === "del") { out.push({type: "del", text: a[ia], a: ia + 1, b: null}); ia++; }
    else { out.push({type: "add", text: b[ib], a: null, b: ib + 1}); ib++; }
  }
  return out;
}

export function splitLines(text) {
  const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Edit script for a → b. Falls back to "delete all, add all" when the
// files differ in more than maxEdits lines (keeps huge diffs fast).
function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(() => "add");
  if (m === 0) return a.map(() => "del");
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return [...a.map(() => "del"), ...b.map(() => "add")];
}

function backtrack(trace, a, b, offset, dFinal) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("same"); x--; y--; }
    if (x === prevX) { ops.push("add"); y--; } else { ops.push("del"); x--; }
  }
  while (x > 0 && y > 0) { ops.push("same"); x--; y--; }
  return ops.reverse();
}

export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return {added, removed};
}

// Side-by-side rows with long unchanged runs folded:
// [{left, right, kind}] or {fold: n} placeholders. left/right = {n, text} | null.
export function sideBySide(rows, {context = 3} = {}) {
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === "same") {
      pairs.push({kind: "same", left: {n: r.a, text: r.text}, right: {n: r.b, text: r.text}});
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].type === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === "add") adds.push(rows[i++]);
    const len = Math.max(dels.length, adds.length);
    for (let j = 0; j < len; j++) {
      const d = dels[j];
      const ad = adds[j];
      pairs.push({
        kind: d && ad ? "change" : d ? "del" : "add",
        left: d ? {n: d.a, text: d.text} : null,
        right: ad ? {n: ad.b, text: ad.text} : null
      });
    }
  }
  const keep = pairs.map(p => p.kind !== "same");
  const near = keep.map((_, idx) => {
    for (let j = Math.max(0, idx - context); j <= Math.min(pairs.length - 1, idx + context); j++) {
      if (keep[j]) return true;
    }
    return false;
  });
  const out = [];
  let fold = 0;
  pairs.forEach((p, idx) => {
    if (near[idx]) {
      if (fold) { out.push({fold}); fold = 0; }
      out.push(p);
    } else fold++;
  });
  if (fold) out.push({fold});
  return out;
}
