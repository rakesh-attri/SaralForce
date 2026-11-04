// Pure helpers for Run Apex's AI fix: describe the Salesforce error for the
// model and summarise what a suggested fix changes, so a fix that drops code
// is visible before anyone applies it. No chrome/window/DOM access.

// What Salesforce reported, or null when the run was a clean success (the
// AI is never consulted then). exec: the executeAnonymous result.
export function apexErrorForAi(exec) {
  if (!exec || (exec.compiled && exec.success)) return null;
  if (exec.compiled === false || exec.compileProblem) {
    const where = exec.line ? ` (line ${exec.line}${exec.column ? ", column " + exec.column : ""})` : "";
    return {stage: "compile", text: `Compile error${where}: ${exec.compileProblem || "the code did not compile"}`};
  }
  const stack = exec.exceptionStackTrace ? `\nStack: ${String(exec.exceptionStackTrace).slice(0, 1500)}` : "";
  return {stage: "runtime", text: `Runtime exception: ${exec.exceptionMessage || "the code failed while running"}${stack}`};
}

const norm = s => String(s || "").replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);

// Line-level change summary between the user's script and the AI fix:
// {same, changed: bool, kept, removed: [lines], added: [lines]} using an LCS
// on trimmed, non-blank lines (scripts are small).
export function fixSummary(original, fixed) {
  const a = norm(original);
  const b = norm(fixed);
  if (a.length * b.length > 4e6) return {changed: a.join("\n") !== b.join("\n"), kept: 0, removed: a, added: b};
  const dp = Array.from({length: a.length + 1}, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return {changed: removed.length > 0 || added.length > 0, kept: dp[0][0], removed, added};
}

// A fix that throws away a noticeable share of the script deserves a warning.
export function fixDropsCode(summary) {
  return summary.removed.length >= 3 && summary.removed.length > summary.added.length + 1;
}
