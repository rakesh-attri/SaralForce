import test from "node:test";
import assert from "node:assert/strict";
import {plainField, plainCondition, flowKind, flowStory, flowSummary, simpleFlowDiagram, storyText} from "../../addon/core/flow-story.js";
import {buildHandbook, lifecycle, stageFieldOf, flowLibrary} from "../../addon/core/handbook.js";
import {buildGuideGraph} from "../../addon/core/org-guide.js";
import {layoutGraph, noOverlap} from "../../addon/core/diagram-layout.js";

const ROUTE = {label: "Route VIP Cases", processType: "AutoLaunchedFlow",
  start: {object: "Case", recordTriggerType: "CreateAndUpdate", triggerType: "RecordAfterSave", connector: {targetReference: "Get_Account"},
    filters: [{field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}]},
  recordLookups: [{name: "Get_Account", label: "Get the account", object: "Account",
    filters: [{field: "Id", operator: "EqualTo", value: {elementReference: "$Record.AccountId"}}], connector: {targetReference: "Is_Gold"}}],
  decisions: [{name: "Is_Gold", label: "Gold customer?", defaultConnector: {targetReference: "Notify"}, defaultConnectorLabel: "Other tiers",
    rules: [{name: "Gold", label: "Gold", conditions: [{leftValueReference: "Get_Account.Customer_Tier__c", operator: "EqualTo", rightValue: {stringValue: "Gold"}}],
      connector: {targetReference: "Move"}}]}],
  recordUpdates: [{name: "Move", label: "Move", inputReference: "$Record", connector: {targetReference: "Notify"}, faultConnector: {targetReference: "Err"},
    inputAssignments: [{field: "Status", value: {stringValue: "Escalated"}}]}],
  subflows: [{name: "Notify", label: "Notify", flowName: "Notify_Team"}],
  customErrors: [{name: "Err", label: "Err", customErrorMessages: [{errorMessage: "Could not move it."}]}]};

const DEFAULTS = {label: "Case Defaults", start: {object: "Case", recordTriggerType: "Create", triggerType: "RecordBeforeSave", connector: {targetReference: "A1"}},
  assignments: [
    {name: "A1", label: "Set subject", assignmentItems: [{assignToReference: "$Record.Subject", operator: "Assign", value: {stringValue: "New case"}}], connector: {targetReference: "A2"}},
    {name: "A2", label: "Set SLA", assignmentItems: [{assignToReference: "$Record.SLA_Date__c", operator: "Assign", value: {elementReference: "$Flow.CurrentDate"}}]}]};

const SCREEN = {label: "New Case Wizard", processType: "Flow", startElementReference: "S1",
  screens: [{name: "S1", label: "Describe the problem", fields: [{name: "Problem"}], connector: {targetReference: "C1"}}],
  recordCreates: [{name: "C1", label: "Create case", object: "Case", inputAssignments: [{field: "Subject", value: {elementReference: "Problem"}}]}]};

test("plain words for fields and conditions", () => {
  assert.equal(plainField("$Record.Customer_Tier__c"), "Customer Tier");
  assert.equal(plainField("$GlobalConstant.True"), "Yes");
  assert.equal(plainField("Get_Account.Customer_Tier__c", {Get_Account: "Get the account"}), "Customer Tier (from \"Get the account\")");
  assert.equal(plainCondition({field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}), "Priority is \"High\"");
  assert.equal(plainCondition({leftValueReference: "$Record.Subject", operator: "IsNull", rightValue: {booleanValue: true}}), "Subject is empty");
  assert.equal(plainCondition({leftValueReference: "$Record.Subject", operator: "IsNull", rightValue: {booleanValue: false}}), "Subject is filled in");
  assert.equal(plainCondition({leftValueReference: "$Record.Status", operator: "IsChanged", rightValue: {booleanValue: true}}), "Status changed");
});

test("what kind of flow it is", () => {
  assert.equal(flowKind(ROUTE).kind, "record");
  assert.equal(flowKind(ROUTE).timing, "after save");
  assert.equal(flowKind(DEFAULTS).timing, "before save");
  assert.equal(flowKind(SCREEN).kind, "screen");
  assert.equal(flowKind({processType: "AutoLaunchedFlow"}).kind, "called");
  assert.equal(flowKind({start: {triggerType: "Scheduled", schedule: {frequency: "Daily"}}}).kind, "scheduled");
});

test("the story: when it starts, numbered steps, branches, fault path", () => {
  const s = flowStory(ROUTE);
  assert.match(s.when, /^Starts when a Case record is created or updated, only if Priority is "High"\. It runs after the record is saved\.$/);
  assert.equal(s.steps[0].text, "Find the Account linked to this Case");
  assert.equal(s.steps[1].text, "Check: Gold customer?");
  assert.deepEqual(s.steps[1].branches.map(b => `${b.label} → ${b.to}`), ["Gold → step 3", "Other tiers → step 4"]);
  assert.match(s.steps[1].branches[0].when, /Customer Tier .* is "Gold"/);
  assert.equal(s.steps[2].text, "Update this Case (sets Status = \"Escalated\")");
  assert.equal(s.steps[2].fault, "step 5");
  assert.equal(s.steps[3].subflow, "Notify_Team");
  const text = storyText(s);
  assert.match(text, /1\. Find the Account/);
  assert.match(text, /if it fails: go to step 5/);
  const scr = flowStory(SCREEN);
  assert.equal(scr.steps[0].person, true);
  assert.match(scr.when, /A person starts it/);
});

test("one-line summary reads naturally", () => {
  assert.equal(flowSummary(ROUTE), "When a Case is created or updated: finds the Account linked to this Case, checks \"Gold customer?\", updates this Case, runs the flow Notify_Team, ….");
  assert.match(flowSummary(SCREEN), /^A screen flow: shows the screen "Describe the problem"/);
});

test("simple diagram: plain labels, folded field updates, outcome labels, fault path, links", () => {
  const d = simpleFlowDiagram(DEFAULTS);
  const labels = d.nodes.map(n => n.label);
  assert.ok(labels.some(l => /^✎ Fill in Subject, SLA Date$/.test(l)), labels.join(" | "));
  assert.equal(d.nodes.filter(n => n.label.startsWith("✎")).length, 1, "two assignments in a row become one box");
  const r = simpleFlowDiagram(ROUTE, {linkFor: (t, n) => `${t}:${n.toLowerCase()}`});
  assert.ok(r.edges.some(e => e.label === "Gold"));
  assert.ok(r.edges.some(e => e.label === "if it fails" && e.kind === "fault"));
  assert.equal(r.nodes.find(n => /Notify_Team/.test(n.label)).link, "flow:notify_team");
  assert.ok(noOverlap(layoutGraph(r, {dir: "TB"})));
  assert.equal(simpleFlowDiagram(SCREEN).nodes.find(n => /screen/.test(n.label)).kind, "page");
});

const items = () => ({
  objects: [],
  triggers: [{name: "CaseTrigger", object: "Case", body: "trigger CaseTrigger on Case (before insert, after update) { CaseService.run(Trigger.new); }"}],
  classes: [{name: "CaseService", body: "public class CaseService { public static void run(List<Case> c) {} }"}],
  flows: [{name: "Case_Route", label: "Route VIP Cases", meta: ROUTE}, {name: "Case_Defaults", label: "Case Defaults", meta: DEFAULTS},
    {name: "Notify_Team", label: "Notify Team", meta: {label: "Notify Team", startElementReference: "X", actionCalls: [{name: "X", label: "x", actionType: "apex", actionName: "CaseService"}]}},
    {name: "New_Case_Wizard", label: "New Case Wizard", meta: SCREEN}],
  lwc: [], aura: [],
  rules: [{name: "Closed_Needs_Resolution", object: "Case", active: true, formula: "AND(ISPICKVAL(Status, \"Closed\"), ISBLANK(Resolution__c))", message: "x"}],
});
const extras = {
  apps: [{name: "Service", label: "Service Console", tabs: [{label: "Cases", object: "Case"}, {label: "Home", object: ""}]}],
  objectInfo: {Case: {label: "Case", picklists: [{name: "Priority", label: "Priority", values: ["High", "Low"]}, {name: "Status", label: "Status", values: ["New", "Working", "Escalated", "Closed"]}], recordTypes: ["Support"]}},
};

test("the stage field: StageName, Status, then *Status*/*Stage* picklists", () => {
  assert.equal(stageFieldOf(extras.objectInfo.Case).name, "Status");
  assert.equal(stageFieldOf({picklists: [{name: "StageName", values: []}, {name: "Status", values: []}]}).name, "StageName");
  assert.equal(stageFieldOf({picklists: [{name: "Approval_Status__c", values: []}]}).name, "Approval_Status__c");
  assert.equal(stageFieldOf({picklists: [{name: "Industry", values: []}]}), null);
});

test("life of a record: stages across, when automation runs down, moves to a stage", () => {
  const l = lifecycle("Case", items(), extras.objectInfo.Case);
  assert.deepEqual(l.columns.map(c => c.label), ["Created", "Any change", "New", "Working", "Escalated", "Closed"]);
  const lane = id => l.lanes.find(x => x.id === id);
  assert.deepEqual(lane("before").cells["@create"].map(c => c.label), ["Case Defaults"]);
  assert.deepEqual(lane("before").cells["@any"].map(c => c.label), ["CaseTrigger"]);
  assert.deepEqual(lane("checks").cells.Closed.map(c => c.label), ["Closed_Needs_Resolution"]);
  assert.deepEqual(lane("after").cells["@any"].map(c => c.label).sort(), ["CaseTrigger", "Route VIP Cases"]);
  assert.deepEqual(l.moves.map(m => `${m.by.label} → ${m.to}`), ["Route VIP Cases → Escalated"]);
});

test("the handbook: departments, processes, flow library, glossary and a reading order", () => {
  const hb = buildHandbook(items(), extras, {orgName: "Demo"});
  assert.equal(hb.departments.length, 1);
  assert.deepEqual(hb.departments[0].objects.map(o => o.name), ["Case"]);
  assert.equal(hb.processes[0].object, "Case");
  assert.equal(hb.flows.length, 4);
  const notify = hb.flows.find(f => f.name === "Notify_Team");
  assert.deepEqual(notify.calledBy, ["flow:case_route"]);
  assert.deepEqual(notify.calls, ["class:caseservice"]);
  assert.equal(hb.flows.find(f => f.name === "New_Case_Wizard").screens, 1);
  assert.equal(hb.glossary[0].recordTypes[0], "Support");
  assert.ok(hb.startHere[0].text.includes("Case"));
  assert.ok(hb.startHere.some(s => s.go.tab === "flows" && s.go.ref === "flow:case_route"));
  assert.ok(hb.startHere.some(s => /screen flow "New Case Wizard"/.test(s.text)));
  assert.equal(flowLibrary(items(), buildGuideGraph(items())).length, 4);
});
