import {test} from "node:test";
import assert from "node:assert/strict";
import {
  buildExecuteAnonymousEnvelope, parseExecuteAnonymousResponse, parseLimitUsage,
  isLogTruncated, editorLine, outdent, xmlUnescape
} from "../../addon/core/apex-anon.js";

test("envelope escapes the code and sets every category level", () => {
  const xml = buildExecuteAnonymousEnvelope("SID!x", "if (a < b && c) System.debug('hi');", "Finest");
  assert.match(xml, /<apex:sessionId>SID!x<\/apex:sessionId>/);
  assert.match(xml, /<apex:String>if \(a &lt; b &amp;&amp; c\) System\.debug\(&apos;hi&apos;\);<\/apex:String>/);
  assert.match(xml, /<apex:category>Apex_code<\/apex:category><apex:level>FINEST<\/apex:level>/);
  assert.equal((xml.match(/<apex:categories>/g) || []).length, 8);
});

test("Apex_profiling never drops below INFO so limits are logged", () => {
  const xml = buildExecuteAnonymousEnvelope("S", "x", "Error");
  assert.match(xml, /Apex_code<\/apex:category><apex:level>ERROR/);
  assert.match(xml, /Apex_profiling<\/apex:category><apex:level>INFO/);
});

test("no level means no DebuggingHeader", () => {
  assert.doesNotMatch(buildExecuteAnonymousEnvelope("S", "x", null), /DebuggingHeader/);
});

test("parses a successful response with its debug log", () => {
  const r = parseExecuteAnonymousResponse(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="x" xmlns="http://soap.sforce.com/2006/08/apex"><soapenv:Header><DebuggingInfo><debugLog>59.0 APEX_CODE,DEBUG
12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|a &lt; b</debugLog></DebuggingInfo></soapenv:Header><soapenv:Body><executeAnonymousResponse><result><column>-1</column><compileProblem xsi:nil="true"/><compiled>true</compiled><exceptionMessage xsi:nil="true"/><exceptionStackTrace xsi:nil="true"/><line>-1</line><success>true</success></result></executeAnonymousResponse></soapenv:Body></soapenv:Envelope>`);
  assert.equal(r.compiled, true);
  assert.equal(r.success, true);
  assert.equal(r.line, null);
  assert.equal(r.compileProblem, null);
  assert.match(r.debugLog, /USER_DEBUG\|\[1\]\|DEBUG\|a < b$/);
});

test("parses compile errors and faults", () => {
  const c = parseExecuteAnonymousResponse("<result><column>5</column><compileProblem>Unexpected token &apos;;&apos;.</compileProblem><compiled>false</compiled><line>3</line><success>false</success></result>");
  assert.deepEqual([c.compiled, c.line, c.column, c.compileProblem], [false, 3, 5, "Unexpected token ';'."]);
  assert.deepEqual(parseExecuteAnonymousResponse("<soapenv:Fault><faultstring>INVALID_SESSION_ID: Session expired</faultstring></soapenv:Fault>"),
    {fault: "INVALID_SESSION_ID: Session expired"});
});

test("parseLimitUsage reads the last default-namespace block", () => {
  const log = [
    "12:00:00.0 (5)|LIMIT_USAGE_FOR_NS|(default)|",
    "  Number of SOQL queries: 1 out of 100",
    "12:00:00.0 (9)|CUMULATIVE_LIMIT_USAGE",
    "12:00:00.0 (10)|LIMIT_USAGE_FOR_NS|(default)|",
    "  Number of SOQL queries: 2 out of 100",
    "  Number of query rows: 5 out of 50000",
    "  Maximum CPU time: 9000 out of 10000",
    "",
    "12:00:00.0 (11)|CUMULATIVE_LIMIT_USAGE_END",
  ].join("\n");
  assert.deepEqual(parseLimitUsage(log), [
    {name: "Number of SOQL queries", used: 2, max: 100, pct: 2},
    {name: "Number of query rows", used: 5, max: 50000, pct: 0},
    {name: "Maximum CPU time", used: 9000, max: 10000, pct: 90},
  ]);
  assert.deepEqual(parseLimitUsage("no limits here"), []);
});

test("truncation, line offset, unescape", () => {
  assert.equal(isLogTruncated("...\n*********** MAXIMUM DEBUG LOG SIZE REACHED ***********"), true);
  assert.equal(isLogTruncated("fine"), false);
  assert.equal(editorLine(2, 10), 12);
  assert.equal(editorLine(null, 10), null);
  assert.equal(xmlUnescape("&#39;&#x41;&amp;lt;"), "'A&lt;");
});

test("outdent removes up to two spaces per selected line", () => {
  const t = "a\n    b\n c\nd";
  const r = outdent(t, 2, 10);
  assert.equal(r.text, "a\n  b\nc\nd");
  assert.deepEqual([r.start, r.end], [2, 7]);
  assert.equal(outdent("x", 0, 0).text, "x");
});
