import {test} from "node:test";
import assert from "node:assert/strict";
import {nextVersion, rollbackPlan, restoreFromDrift, trimSummary, formatBytes, lastReleaseAt} from "../../addon/core/release-history.js";

test("versions count real deploys per target org", () => {
  const list = [
    {targetHost: "uat", kind: "deploy", version: "v1"}, {targetHost: "uat", kind: "validation"},
    {targetHost: "uat", kind: "rollback", version: "v2"}, {targetHost: "prod", kind: "quick", version: "v1"}
  ];
  // A deleted v2 never makes the next one repeat v3.
  assert.equal(nextVersion([{targetHost: "x", kind: "deploy", version: "v1"}, {targetHost: "x", kind: "deploy", version: "v3"}], "x"), "v4");
  assert.equal(nextVersion(list, "uat"), "v3");
  assert.equal(nextVersion(list, "prod"), "v2");
  assert.equal(nextVersion([], "dev"), "v1");
});

test("rollback restores changed items, deletes added ones, keeps unknowns", () => {
  const release = {
    items: ["ApexClass:Changed", "ApexClass:Added", "CustomObject:New__c", "CustomField:New__c.F__c", "CustomField:Old__c.G__c", "Flow:Ghost"],
    deletes: ["ApexClass:Removed", "ApexClass:Lost"]
  };
  const snapshotKeys = new Set(["ApexClass:Changed", "ApexClass:Removed"]);
  const missing = ["ApexClass:Added", "CustomObject:New__c", "CustomField:New__c.F__c", "CustomField:Old__c.G__c"];
  const plan = rollbackPlan(release, snapshotKeys, missing);
  assert.deepEqual(plan.restore, ["ApexClass:Changed", "ApexClass:Removed"]);
  // The field on the new object goes with the object.
  assert.deepEqual(plan.remove, ["ApexClass:Added", "CustomObject:New__c", "CustomField:Old__c.G__c"]);
  assert.deepEqual(plan.unknown, ["Flow:Ghost", "ApexClass:Lost"]);
});

test("restore from drift: put back removed and changed, delete added", () => {
  const rows = [{key: "a", status: "changed"}, {key: "b", status: "new"}, {key: "c", status: "deleted"}, {key: "d", status: "same"}, {key: "e", status: "changed"}];
  assert.deepEqual(restoreFromDrift(rows, new Set(["a", "b", "c", "d"])), {restore: ["a", "b"], remove: ["c"]});
});

test("summary is trimmed for storage", () => {
  const t = trimSummary({status: "Failed", success: false, components: {total: 1}, tests: {total: 0},
    testFailures: [{className: "T", stackTrace: "x".repeat(5000)}], componentFailures: [], coverageWarnings: []});
  assert.equal(t.testFailures[0].stackTrace.length, 2000);
  assert.equal(trimSummary(null), null);
});

test("sizes and last release", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  const list = [{sourceHost: "dev", kind: "deploy", success: true, at: "2026-10-01"}, {sourceHost: "dev", kind: "quick", success: true, at: "2026-10-20"},
    {sourceHost: "dev", kind: "validation", success: true, at: "2026-11-01"}, {sourceHost: "dev", kind: "deploy", success: false, at: "2026-11-02"}];
  assert.equal(lastReleaseAt(list, "dev"), "2026-10-20");
  assert.equal(lastReleaseAt(list, "x"), "");
});

test("rollback brings an object's children and ignores case", () => {
  const plan = rollbackPlan({items: ["CustomObject:Inv__c", "ApexClass:MyClass"], deletes: []},
    new Set(["CustomObject:Inv__c", "CustomField:Inv__c.A__c", "ValidationRule:Inv__c.R", "ApexClass:myClass"]), []);
  assert.deepEqual(plan.restore.sort(), ["ApexClass:myClass", "CustomField:Inv__c.A__c", "CustomObject:Inv__c", "ValidationRule:Inv__c.R"]);
  assert.deepEqual(plan.unknown, []);
});
