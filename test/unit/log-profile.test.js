import {test} from "node:test";
import assert from "node:assert/strict";
import {parseProfile, normalizeQuery, profileForPrompt} from "../../addon/core/log-profile.js";

const t = (ns, rest) => `12:00:00.0 (${ns})|${rest}`;
function sampleLog() {
  const lines = ["67.0 APEX_CODE,DEBUG", t(0, "EXECUTION_STARTED"), t(100, "CODE_UNIT_STARTED|[EXTERNAL]|01p|InvoiceService.run"),
    t(200, "METHOD_ENTRY|[3]|01p|InvoiceService.total(List<Invoice__c>)")];
  let ns = 300;
  for (let i = 0; i < 5; i++) {
    lines.push(t(ns, `SOQL_EXECUTE_BEGIN|[7]|Aggregations:0|SELECT Id FROM Account WHERE Name = 'A${i}'`));
    lines.push(t(ns + 1000000, "SOQL_EXECUTE_END|[7]|Rows:2"));
    lines.push(t(ns + 1000100, "DML_BEGIN|[9]|Op:Update|Type:Account|Rows:1"));
    lines.push(t(ns + 3000100, "DML_END|[9]"));
    ns += 4000000;
  }
  lines.push(t(ns, "METHOD_EXIT|[3]|01p|InvoiceService.total(List<Invoice__c>)"));
  lines.push(t(ns + 100, "CALLOUT_REQUEST|[20]|System.HttpRequest[Endpoint=https://erp.example.com/tax, Method=GET]"));
  lines.push(t(ns + 2500000100, "CALLOUT_RESPONSE|[20]|System.HttpResponse[Status=OK, StatusCode=200]"));
  lines.push(t(ns + 2500000200, "USER_DEBUG|[25]|DEBUG|done"));
  lines.push(t(ns + 2500000300, "CODE_UNIT_FINISHED|InvoiceService.run"));
  lines.push(t(ns + 2500000400, "CUMULATIVE_LIMIT_USAGE"));
  lines.push(t(ns + 2500000400, "LIMIT_USAGE_FOR_NS|(default)|"));
  lines.push("  Number of SOQL queries: 95 out of 100 ******* CLOSE TO LIMIT");
  lines.push("  Maximum CPU time: 1200 out of 10000");
  lines.push(t(ns + 2500000500, "EXECUTION_FINISHED"));
  return lines.join("\n");
}

test("profile: tree times, repeated queries and DML in loops", () => {
  const p = parseProfile(sampleLog());
  assert.equal(p.counts.soql, 5);
  assert.equal(p.counts.dml, 5);
  assert.equal(p.counts.callouts, 1);
  assert.equal(p.soql.length, 1);
  assert.equal(p.soql[0].times, 5);
  assert.equal(p.soql[0].rows, 10);
  assert.equal(p.soql[0].caller, "InvoiceService.total(List<Invoice__c>)");
  assert.equal(p.dml[0].times, 5);
  const texts = p.insights.map(i => i.text).join("\n");
  assert.match(texts, /same query ran 5 times from line 7/);
  assert.match(texts, /Update Account ran 5 times/);
  assert.match(texts, /Callout to https:\/\/erp.example.com\/tax took 2.5 s/);
  assert.match(texts, /Number of SOQL queries: 95 of 100/);
  assert.equal(p.insights[0].level, "err");
  const total = p.topTotal.find(m => m.name === "InvoiceService.run");
  assert.ok(total.total > 2500);
  const tot = p.topTotal.find(m => m.name.startsWith("InvoiceService.total"));
  assert.ok(Math.abs(tot.total - 20) < 0.1);
  assert.ok(Math.abs(tot.self - 5) < 0.1);
  assert.ok(p.timeline.some(r => r.kind === "callout" && r.width > 90));
  assert.deepEqual(p.debug, ["done"]);
  assert.match(profileForPrompt(p), /5× 10 rows/);
});

test("profile: missing exits and empty logs don't break", () => {
  const p = parseProfile([t(0, "CODE_UNIT_STARTED|[EXTERNAL]|x|A"), t(10, "METHOD_ENTRY|[1]|x|A.b()"), t(50, "EXCEPTION_THROWN|[1]|System.NullPointerException: boom")].join("\n"));
  assert.equal(p.errors[0].message, "System.NullPointerException: boom");
  assert.ok(p.insights.some(i => /boom/.test(i.text)));
  assert.equal(parseProfile("").counts.soql, 0);
  assert.equal(normalizeQuery("SELECT Id FROM A WHERE N = 'x' AND C > 5"), "SELECT Id FROM A WHERE N = ? AND C > ?");
});
