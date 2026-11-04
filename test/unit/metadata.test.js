import {test} from "node:test";
import assert from "node:assert/strict";
import {buildPackageXml, packageCount, togglePackageMember, erLayout, relationshipsFromDescribe} from "../../addon/core/metadata.js";

test("buildPackageXml sorts, de-duplicates and escapes", () => {
  const xml = buildPackageXml({ApexClass: ["B", "A", "A"], CustomObject: ["Acc&Co__c"], Flow: []}, "67.0");
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    "    <types>",
    "        <members>A</members>",
    "        <members>B</members>",
    "        <name>ApexClass</name>",
    "    </types>",
    "    <types>",
    "        <members>Acc&amp;Co__c</members>",
    "        <name>CustomObject</name>",
    "    </types>",
    "    <version>67.0</version>",
    "</Package>",
    "",
  ].join("\n"));
});

test("togglePackageMember adds, removes and counts", () => {
  let m = togglePackageMember({}, "ApexClass", "A");
  m = togglePackageMember(m, "ApexClass", "B");
  m = togglePackageMember(m, "Flow", "F");
  assert.equal(packageCount(m), 3);
  m = togglePackageMember(m, "Flow", "F");
  assert.deepEqual(Object.keys(m), ["ApexClass"]);
});

test("erLayout centres the object and connects both sides", () => {
  const l = erLayout("Account", [{name: "User", via: "OwnerId"}], [{name: "Contact", via: "Contacts"}, {name: "Case", via: "Cases"}]);
  const center = l.boxes.find(b => b.role === "center");
  assert.equal(center.name, "Account");
  assert.equal(l.boxes.length, 4);
  assert.equal(l.edges.length, 3);
  const parentEdge = l.edges.find(e => e.role === "parent");
  assert.equal(parentEdge.x2, center.x);
  const childEdge = l.edges.find(e => e.role === "child");
  assert.equal(childEdge.x1, center.x + center.w);
  assert.ok(l.boxes.every(b => b.y >= 0 && b.y + b.h <= l.height));
});

test("erLayout caps each side", () => {
  const many = Array.from({length: 20}, (_, i) => ({name: "C" + i, via: "R" + i}));
  const l = erLayout("X", [], many, {max: 5});
  assert.equal(l.boxes.length, 6);
  assert.equal(l.hiddenChildren, 15);
});

test("relationshipsFromDescribe skips system children", () => {
  const r = relationshipsFromDescribe({
    fields: [{name: "OwnerId", type: "reference", referenceTo: ["Group", "User"]}, {name: "Name", type: "string"}],
    childRelationships: [
      {relationshipName: "Contacts", childSObject: "Contact"},
      {relationshipName: "Histories", childSObject: "AccountHistory"},
      {relationshipName: null, childSObject: "Task"},
    ],
  });
  assert.deepEqual(r.parents, [{name: "Group", via: "OwnerId"}, {name: "User", via: "OwnerId"}]);
  assert.deepEqual(r.children, [{name: "Contact", via: "Contacts"}]);
});

test("summarizeFlow outlines start and elements", async () => {
  const {summarizeFlow} = await import("../../addon/core/metadata.js");
  const s = summarizeFlow({
    label: "Case Escalation", processType: "AutoLaunchedFlow", status: "Active",
    start: {object: "Case", recordTriggerType: "Update", triggerType: "RecordAfterSave",
      filters: [{field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}]},
    decisions: {name: "Is_VIP", label: "Is VIP?"},
    recordUpdates: [{label: "Escalate"}, {name: "Notify"}],
  });
  assert.equal(s, [
    "Label: Case Escalation",
    "Type: AutoLaunchedFlow · Active",
    "Starts: Case record (Update, RecordAfterSave)",
    "Entry conditions: Priority EqualTo High",
    "Decisions (1): Is VIP?",
    "Update Records (2): Escalate, Notify",
  ].join("\n"));
});

test("flowSteps walks the flow in order with branches", async () => {
  const {flowSteps} = await import("../../addon/core/metadata.js");
  const r = flowSteps({
    label: "Case Escalation", processType: "AutoLaunchedFlow",
    start: {object: "Case", recordTriggerType: "Update", triggerType: "RecordAfterSave", connector: {targetReference: "Is_VIP"},
      filters: [{field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}]},
    decisions: [{name: "Is_VIP", label: "Is VIP?", rules: [{name: "Yes", label: "VIP",
      conditions: [{leftValueReference: "$Record.Account.VIP__c", operator: "EqualTo", rightValue: {booleanValue: true}}],
      connector: {targetReference: "Escalate"}}],
    defaultConnector: {targetReference: "Notify"}, defaultConnectorLabel: "Regular"}],
    recordUpdates: [{name: "Escalate", label: "Escalate case", inputReference: "$Record",
      inputAssignments: [{field: "Status", value: {stringValue: "Escalated"}}], connector: {targetReference: "Notify"}}],
    actionCalls: [{name: "Notify", label: "Email owner", actionType: "emailSimple", actionName: "emailSimple"}, {name: "Orphan", label: "Unused"}],
  });
  assert.deepEqual(r.start.details, ["When a Case record is updated", "After the record is saved", "Only if Priority EqualTo High"]);
  assert.equal(r.start.next, "1. Is VIP?");
  assert.deepEqual(r.steps.map(s => s.label), ["Is VIP?", "Escalate case", "Email owner"]);
  assert.deepEqual(r.steps[0].next.map(n => [n.label, n.targetLabel]), [
    ["VIP: $Record.Account.VIP__c EqualTo true", "2. Escalate case"], ["Regular", "3. Email owner"]]);
  assert.deepEqual(r.steps[1].details, ["Record: {!$Record}", "Set Status = Escalated"]);
  assert.deepEqual(r.steps[2].next, []);
  assert.deepEqual(r.unreachable.map(s => s.name), ["Orphan"]);
});
