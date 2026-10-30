// Anonymous Apex over the Apex SOAP API (executeAnonymous). Unlike the REST
// Tooling GET it takes the script in the request body (no URL length limit)
// and returns this run's own debug log in the response header, at the
// requested level — no TraceFlag, no polling, never another transaction's
// log. Pure functions so they can be unit-tested with `node --test`.

export const APEX_LOG_LEVELS = ["Error", "Warn", "Info", "Debug", "Fine", "Finer", "Finest"];

// Log categories sent in the DebuggingHeader. Apex_profiling stays at INFO
// or above so the cumulative limit usage block is always in the log.
const CATEGORIES = ["Apex_code", "Apex_profiling", "Callout", "Db", "System", "Validation", "Visualforce", "Workflow"];
const LEVEL_ORDER = ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"];

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function xmlUnescape(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function categoryLevel(category, level) {
  const want = String(level || "Debug").toUpperCase();
  if (category !== "Apex_profiling") return want;
  return LEVEL_ORDER.indexOf(want) < LEVEL_ORDER.indexOf("INFO") ? "INFO" : want;
}

// SOAP envelope for executeAnonymous. level null = no debug log requested.
export function buildExecuteAnonymousEnvelope(sessionId, code, level) {
  const debugging = level
    ? `    <apex:DebuggingHeader>\n${CATEGORIES.map(c =>
      `      <apex:categories><apex:category>${c}</apex:category><apex:level>${categoryLevel(c, level)}</apex:level></apex:categories>`).join("\n")}\n` +
      "      <apex:debugLevel>DETAIL</apex:debugLevel>\n    </apex:DebuggingHeader>\n"
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
  <soapenv:Header>
${debugging}    <apex:SessionHeader><apex:sessionId>${xmlEscape(sessionId)}</apex:sessionId></apex:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <apex:executeAnonymous><apex:String>${xmlEscape(code)}</apex:String></apex:executeAnonymous>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function tag(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  if (m) return xmlUnescape(m[1]);
  return new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?/>`).test(xml) ? "" : null;
}

function nilOrText(v) {
  return v == null || v === "" ? null : v;
}

// Response XML → the same shape as the REST executeAnonymous result, plus
// debugLog. A SOAP fault becomes {fault: message}.
export function parseExecuteAnonymousResponse(xml) {
  const text = String(xml || "");
  const fault = tag(text, "faultstring");
  if (fault != null) return {fault: fault.trim() || "SOAP fault"};
  const result = /<(?:\w+:)?result\b[\s\S]*?<\/(?:\w+:)?result>/.exec(text);
  const body = result ? result[0] : text;
  const num = v => (v == null || v === "" || Number(v) < 0 ? null : Number(v));
  return {
    compiled: tag(body, "compiled") === "true",
    success: tag(body, "success") === "true",
    compileProblem: nilOrText(tag(body, "compileProblem")),
    exceptionMessage: nilOrText(tag(body, "exceptionMessage")),
    exceptionStackTrace: nilOrText(tag(body, "exceptionStackTrace")),
    line: num(tag(body, "line")),
    column: num(tag(body, "column")),
    debugLog: tag(text, "debugLog"),
  };
}

// True when Salesforce cut the log off at its size limit.
export function isLogTruncated(log) {
  return /MAXIMUM DEBUG LOG SIZE REACHED/i.test(String(log || ""));
}

// Governor limit usage of the default namespace, from the last
// LIMIT_USAGE_FOR_NS (default) block: [{name, used, max, pct}].
export function parseLimitUsage(log) {
  const lines = String(log || "").replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\|LIMIT_USAGE_FOR_NS\|\(default\)\|/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s+(.+?):\s*(\d+)\s+out of\s+(\d+)/.exec(lines[i]);
    if (!m) {
      if (out.length || /\|/.test(lines[i])) break;
      continue;
    }
    const used = Number(m[2]);
    const max = Number(m[3]);
    out.push({name: m[1].trim(), used, max, pct: max > 0 ? Math.round(used / max * 100) : 0});
  }
  return out;
}

// Line numbers of an error inside a selection → editor line numbers.
export function editorLine(snippetLine, lineOffset) {
  return snippetLine == null ? null : snippetLine + (lineOffset || 0);
}

// Remove up to `width` leading spaces from each line touched by [start, end).
// Returns {text, start, end} with the selection adjusted.
export function outdent(text, start, end, width = 2) {
  const s = String(text || "");
  const lineStart = s.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const stop = end > start && s[end - 1] === "\n" ? end - 1 : end;
  let lineEnd = s.indexOf("\n", stop);
  if (lineEnd === -1) lineEnd = s.length;
  const block = s.slice(lineStart, lineEnd).split("\n");
  let removedFirst = 0;
  let removedTotal = 0;
  const next = block.map((ln, i) => {
    const n = Math.min(width, (/^ */.exec(ln) || [""])[0].length);
    if (i === 0) removedFirst = n;
    removedTotal += n;
    return ln.slice(n);
  }).join("\n");
  return {
    text: s.slice(0, lineStart) + next + s.slice(lineEnd),
    start: Math.max(lineStart, start - removedFirst),
    end: Math.max(lineStart, end - removedTotal),
  };
}
