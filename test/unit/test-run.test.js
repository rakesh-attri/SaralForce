import {test} from "node:test";
import assert from "node:assert/strict";
import {
  summarizeQueue, abortableItems, groupTestResults, coverageLineMap, extractMethodSource, parseStackTrace
} from "../../addon/core/test-run.js";

test("summarizeQueue tracks progress and completion", () => {
  const running = summarizeQueue([{Status: "Completed"}, {Status: "Processing"}, {Status: "Queued"}]);
  assert.deepEqual([running.done, running.total, running.finished], [1, 3, false]);
  const done = summarizeQueue([{Status: "Completed"}, {Status: "Failed"}, {Status: "Aborted"}]);
  assert.deepEqual([done.finished, done.failed, done.aborted], [true, 1, 1]);
  assert.equal(summarizeQueue([]).finished, false);
  assert.equal(abortableItems([{Id: "a", Status: "Queued"}, {Id: "b", Status: "Completed"}]).length, 1);
});

test("groupTestResults puts failing classes and methods first", () => {
  const g = groupTestResults([
    {Id: "1", ApexClass: {Name: "BTest"}, MethodName: "ok", Outcome: "Pass", RunTime: 12},
    {Id: "2", ApexClass: {Name: "ATest"}, MethodName: "works", Outcome: "Pass", RunTime: 5},
    {Id: "3", ApexClass: {Name: "BTest"}, MethodName: "breaks", Outcome: "Fail", Message: "System.AssertException", StackTrace: "Class.BTest.breaks: line 9, column 1"},
    {Id: "4", ApexClass: {Name: "BTest"}, MethodName: "later", Outcome: "Skip"},
  ]);
  assert.deepEqual(g.classes.map(c => c.className), ["BTest", "ATest"]);
  assert.deepEqual(g.classes[0].methods.map(m => m.name), ["breaks", "later", "ok"]);
  assert.deepEqual([g.passed, g.failed, g.skipped], [2, 1, 1]);
  assert.equal(g.classes[0].methods[0].message, "System.AssertException");
});

test("coverageLineMap", () => {
  assert.deepEqual(coverageLineMap({coveredLines: [1, 2], uncoveredLines: [5]}), {1: "covered", 2: "covered", 5: "uncovered"});
  assert.deepEqual(coverageLineMap(null), {});
});

test("extractMethodSource returns the whole method", () => {
  const body = "@IsTest\nprivate class T {\n  @IsTest static void a() {\n    if (x) { y(); }\n  }\n  static void b() { }\n}";
  assert.equal(extractMethodSource(body, "a"), "  @IsTest static void a() {\n    if (x) { y(); }\n  }");
  assert.equal(extractMethodSource(body, "missing"), "");
});

test("parseStackTrace", () => {
  assert.deepEqual(parseStackTrace("Class.InvoiceService.markOverdue: line 12, column 1\nClass.InvoiceServiceTest.itWorks: line 7, column 1"),
    [{cls: "InvoiceService", method: "markOverdue", line: 12}, {cls: "InvoiceServiceTest", method: "itWorks", line: 7}]);
});
