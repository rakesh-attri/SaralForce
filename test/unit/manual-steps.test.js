import {test} from "node:test";
import assert from "node:assert/strict";
import {detectSteps, mergeRunbook, runbookProgress, baseUsername, stepsFromAi, stepsForPrompt, pendingPreSteps, sortRunbook} from "../../addon/core/manual-steps.js";

const ctx = (items, texts = {}, extra = {}) => ({items, deletes: [], texts: new Map(Object.entries(texts)), before: new Map(), ...extra});

test("detects the steps a release needs", () => {
  const steps = detectSteps(ctx(
    ["CustomTab:Invoice__c", "Flow:Approve", "PermissionSet:Invoice_Manager", "ApexClass:Job", "ApexClass:Plain", "CustomObject:Rates__c", "NamedCredential:Erp", "FlexiPage:Invoice_Page"],
    {"ApexClass:Job": "public class Job implements Database.Batchable<SObject>, Schedulable {}", "ApexClass:Plain": "public class Plain {}",
      "CustomObject:Rates__c": "<CustomObject><customSettingsType>Hierarchy</customSettingsType></CustomObject>"}));
  const by = Object.fromEntries(steps.map(s => [s.id, s.targets]));
  assert.deepEqual(by["tab-launcher"], ["Invoice__c"]);
  assert.deepEqual(by["flow-activate"], ["Approve"]);
  assert.deepEqual(by["permset-assign"], ["Invoice_Manager"]);
  assert.deepEqual(by["schedule-jobs"], ["Job"]);
  assert.deepEqual(by["custom-settings"], ["Rates__c"]);
  assert.deepEqual(by["secrets"], ["Named credential Erp"]);
  assert.deepEqual(by["flexipage-activate"], ["Invoice_Page"]);
  assert.equal(steps.find(s => s.id === "tab-launcher").auto, true);
});

test("pre-deploy steps: data backup, features, sharing change", () => {
  const steps = detectSteps(ctx(["ApexClass:Fx", "CustomObject:Deal__c"],
    {"ApexClass:Fx": "Decimal x = o.CurrencyIsoCode == 'USD' ? 1 : 2;", "CustomObject:Deal__c": "<sharingModel>Private</sharingModel>"},
    {deletes: ["CustomField:Deal__c.Old__c"], before: new Map([["CustomObject:Deal__c", "<sharingModel>ReadWrite</sharingModel>"]])}));
  const by = Object.fromEntries(steps.map(s => [s.id, s]));
  assert.deepEqual(by["backup-data"].targets, ["Deal__c.Old__c"]);
  assert.equal(by["backup-data"].phase, "pre");
  assert.match(by["enable-features"].targets[0], /Multiple currencies/);
  assert.deepEqual(by["sharing-recalc"].targets, ["Deal__c"]);
  assert.deepEqual(detectSteps(ctx([])), []);
});

test("runbook keeps progress and custom steps", () => {
  const detected = detectSteps(ctx(["Flow:A", "CustomTab:T__c"]));
  const saved = [{key: "flow-activate", status: "done", log: "ok"}, {key: "own-1", id: "own", custom: true, phase: "post", title: "Tell support", status: "todo"},
    {key: "secrets", status: "done"}];
  const merged = mergeRunbook(saved, detected);
  assert.equal(merged.find(s => s.key === "flow-activate").status, "done");
  assert.ok(merged.some(s => s.key === "own-1"));
  assert.ok(!merged.some(s => s.key === "secrets"));
  assert.deepEqual(runbookProgress(merged), {done: 1, total: 3});
});

test("usernames match across sandboxes", () => {
  assert.equal(baseUsername("Priya@Acme.com.uat"), "priya@acme.com");
  assert.equal(baseUsername("priya@acme.com"), "priya@acme.com");
  assert.equal(baseUsername("ops@acme.co.in.qa2"), "ops@acme.co.in");
  assert.equal(baseUsername("rakesh@demo.saralforce.uat"), baseUsername("rakesh@demo.saralforce"));
});

test("AI steps become guided custom steps", () => {
  const s = stepsFromAi([{phase: "pre", title: "Freeze users", detail: "Tell users", setupPath: "/lightning/setup/Users/home"}, {title: ""}, {title: "x", setupPath: "javascript:alert(1)"}]);
  assert.equal(s.length, 2);
  assert.equal(s[0].phase, "pre");
  assert.equal(s[0].setup, "/lightning/setup/Users/home");
  assert.equal(s[1].setup, "");
  assert.match(stepsForPrompt([{phase: "post", title: "T", targets: ["a"]}], ["x"]), /audit trail/);
});

test("pre-deployment steps: scheduled classes, deleted flows, rules with queues", () => {
  const texts = new Map([
    ["ApexClass:NightlyJob", "public class NightlyJob implements Schedulable { public void execute(SchedulableContext c) {} }"],
    ["AssignmentRules:Case", "<AssignmentRules><assignedTo>Support_Queue</assignedTo></AssignmentRules>"]
  ]);
  const steps = detectSteps({items: ["ApexClass:NightlyJob", "AssignmentRules:Case"], deletes: ["Flow:Old_Flow"], texts, before: new Map()});
  const pre = steps.filter(s => s.phase === "pre").map(s => s.id);
  assert.ok(pre.includes("pause-jobs"));
  assert.ok(pre.includes("flow-deactivate"));
  assert.ok(pre.includes("rule-users"));
  // Before steps come first, and only unfinished ones are pending.
  const book = sortRunbook(steps);
  assert.equal(book[0].phase, "pre");
  const done = book.map(s => s.id === "pause-jobs" ? {...s, status: "done"} : s.id === "flow-deactivate" ? {...s, status: "skipped"} : s);
  assert.deepEqual(pendingPreSteps(done).map(s => s.id), ["rule-users"]);
});
