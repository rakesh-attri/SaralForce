import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  nextPoll, POLL_MAX_FAILURES, POLL_MAX_EMPTY, coveringTestClasses, isSfId
} from "../../addon/core/test-run.js";

const src = p => readFileSync(new URL("../../addon/" + p, import.meta.url), "utf8");

test("nextPoll stops with an error after repeated query failures", () => {
  let s = null;
  for (let i = 1; i < POLL_MAX_FAILURES; i++) {
    s = nextPoll(s, {error: new Error("INVALID_SESSION_ID")});
    assert.equal(s.stop, null);
  }
  s = nextPoll(s, {error: new Error("INVALID_SESSION_ID")});
  assert.equal(s.stop, "error");
  assert.equal(s.error, "INVALID_SESSION_ID");
});

test("nextPoll resets the failure count after a good poll", () => {
  let s = nextPoll(null, {error: new Error("x")});
  s = nextPoll(s, {error: new Error("x")});
  s = nextPoll(s, {items: [{Status: "Processing"}]});
  assert.equal(s.failures, 0);
  s = nextPoll(s, {error: new Error("x")});
  assert.equal(s.stop, null);
});

test("nextPoll calls a run empty after several polls with no queue items", () => {
  let s = null;
  for (let i = 1; i < POLL_MAX_EMPTY; i++) {
    s = nextPoll(s, {items: []});
    assert.equal(s.stop, null);
  }
  assert.equal(nextPoll(s, {items: []}).stop, "empty");
  // Items showing up resets the empty count.
  s = nextPoll(s, {items: [{Status: "Queued"}]});
  assert.equal(s.empties, 0);
});

test("nextPoll finishes when nothing is pending", () => {
  const s = nextPoll(null, {items: [{Status: "Completed"}, {Status: "Failed"}]});
  assert.equal(s.stop, "finished");
  assert.equal(s.progress.total, 2);
});

test("coveringTestClasses dedupes and sorts the test classes", () => {
  const out = coveringTestClasses([
    {ApexTestClassId: "01p000000000002AAA", ApexTestClass: {Name: "ZTest"}},
    {ApexTestClassId: "01p000000000001AAA", ApexTestClass: {Name: "ATest"}},
    {ApexTestClassId: "01p000000000002AAA", ApexTestClass: {Name: "ZTest"}},
    {ApexTestClassId: null},
  ]);
  assert.deepEqual(out.map(t => t.name), ["ATest", "ZTest"]);
  assert.equal(out[0].classId, "01p000000000001AAA");
  assert.deepEqual(coveringTestClasses([]), []);
});

test("isSfId accepts 15/18-char ids only", () => {
  assert.ok(isSfId("01p000000000001"));
  assert.ok(isSfId("01p000000000001AAA"));
  assert.ok(!isSfId("01p000000000001AA"));
  assert.ok(!isSfId("01p' OR Id != '"));
  assert.ok(!isSfId(null));
});

test("coverage tab runs covering tests, confirms Run All and pages rows", () => {
  const s = src("inspector/tabs/coverage.js");
  assert.match(s, /FROM ApexCodeCoverage WHERE ApexClassOrTriggerId/);
  assert.match(s, /No test class covers \$\{name\} yet/);
  assert.match(s, /confirmDialog\(/);
  assert.match(s, /every local test in PRODUCTION/);
  assert.match(s, /queryAll\(soql/);
  assert.doesNotMatch(s, /newest 200 rows/);
  assert.doesNotMatch(s, /runTests\(\{tests: \[\{classId: r\.ApexClassOrTriggerId\}\]\}/);
});

test("polling no longer swallows queue errors", () => {
  assert.doesNotMatch(src("inspector/tabs/coverage-run.js"), /queueItems\(jobId\)\.catch\(\(\) => \[\]\)\)/);
});

test("import validation CSV guards formulas; org limit aliases stop at first match", () => {
  assert.match(src("inspector/tabs/import.js"), /import-validation-errors\.csv", toCsvEx\(cols, rows, \{delimiter: ",", guardFormulas: true\}\)/);
  const org = src("inspector/tabs/org.js");
  assert.match(org, /\["DailyBulkApiBatches", "DailyBulkApiRequests", "DailyBulkBatches"\]/);
  assert.match(org, /matchedKey = k; break; \}/);
});
