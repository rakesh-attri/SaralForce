import {test} from "node:test";
import assert from "node:assert/strict";
import {apexLoopIssues, hardcodedIds, analyzePlan, sizeProblems, overwriteRisks} from "../../addon/core/analyzers.js";

const LOOPY = `public class A {
  public void run(List<Account> accs) {
    for (Account a : accs) {
      Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id LIMIT 1];
      update a;
    }
    List<Contact> ok = [SELECT Id FROM Contact];
    // for (x) { [SELECT Id FROM X] }
    insert ok;
    for (Integer i = 0; i < 3; i++) Database.insert(new Account(Name = 'x'));
  }
}`;

test("finds SOQL and DML inside loops only", () => {
  const hits = apexLoopIssues(LOOPY);
  assert.deepEqual(hits.map(h => `${h.kind}@${h.line}`), ["soql@4", "dml@5", "dml@10"]);
});

test("finds hard-coded Ids, not ordinary words", () => {
  assert.deepEqual(hardcodedIds("Id x = '001dN00000ABCdeQAA'; String s = 'HelloWorldAbcde';"), ["001dN00000ABCdeQAA"]);
});

test("plan analyzers", () => {
  const plan = {
    members: {ApexClass: ["A", "ATest"], CustomField: ["Inv__c.New__c"], Profile: ["Admin"]},
    destructive: {Flow: ["Old_Flow"], CustomField: ["Inv__c.Gone__c"], ApexClass: ["A"]},
    texts: [{key: "ApexClass:A", text: LOOPY + "\n// ── classes/A.cls-meta.xml ──\n<apiVersion>68.0</apiVersion>"},
      {key: "ApexClass:ATest", text: "@isTest class ATest {}"}],
    statuses: new Map([["CustomField:Inv__c.New__c", "new"]])
  };
  const ids = analyzePlan(plan, {targetApi: 67, isProd: true}).map(p => p.id);
  for (const id of ["api-version", "flow-delete", "data-loss", "deploy-and-delete", "apex-loops", "profiles"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("fls"), "a profile grants access");
  assert.ok(!ids.includes("no-tests"), "a test is included");
  const ids2 = analyzePlan({members: {ApexClass: ["A"], CustomField: ["Inv__c.New__c"]}, destructive: {},
    texts: [{key: "ApexClass:A", text: "public class A {}"}], statuses: new Map([["CustomField:Inv__c.New__c", "new"]])}, {isProd: true}).map(p => p.id);
  assert.ok(ids2.includes("fls") && ids2.includes("no-tests"));
});

test("size limits and overwrite risks", () => {
  assert.equal(sizeProblems(new Array(10001), 10)[0].id, "too-many-files");
  assert.equal(sizeProblems([], 30 * 1024 * 1024)[0].id, "too-big");
  assert.deepEqual(sizeProblems([1], 1000), []);
  const listed = new Map([["ApexClass:A", {lastModifiedDate: "2026-11-04T10:00:00Z", lastModifiedByName: "Priya"}],
    ["ApexClass:B", {lastModifiedDate: "2026-11-01T10:00:00Z"}]]);
  assert.deepEqual(overwriteRisks(["ApexClass:A", "ApexClass:B", "ApexClass:C"], listed, "2026-11-03T00:00:00Z").map(r => r.by), ["Priya"]);
});

test("a SOQL for-loop header is not a query in a loop", () => {
  const code = `for (Invoice__c r : [SELECT Id FROM Invoice__c WHERE Id IN :rows]) {
    sum += r.Amount__c;
  }
  for (Account a : accs) { update a; }`;
  assert.deepEqual(apexLoopIssues(code).map(h => `${h.kind}@${h.line}`), ["dml@4"]);
});
