import test from "node:test";
import assert from "node:assert/strict";
import {
  apexFacts, flowFacts, buildGuideGraph, selectArea, runOrder, describeComponent, flowDiagram,
  buildGuide, eli5Batches, toMermaid, guideToMarkdown, guideToHtml, areaRanking
} from "../../addon/core/org-guide.js";
import {layoutGraph, noOverlap, wrapText} from "../../addon/core/diagram-layout.js";
import {diagramSvg} from "../../addon/core/diagram-svg.js";

const items = () => ({
  objects: [{name: "Case", label: "Case", lookups: [{field: "AccountId", label: "Account", to: "Account"}]}, {name: "Account", label: "Account", lookups: []},
    {name: "Lead", label: "Lead", lookups: [], labelOnly: true}],
  triggers: [{name: "CaseTrigger", object: "Case", body: "trigger CaseTrigger on Case (before insert, after update) {\n  CaseTriggerHandler.handle(Trigger.new);\n}"},
    {name: "AccountTrigger", object: "Account", body: "trigger AccountTrigger on Account (after update) { }"}],
  classes: [
    {name: "CaseTriggerHandler", body: "public with sharing class CaseTriggerHandler {\n  public static void handle(List<Case> cases) { CaseService.assignPriority(cases); }\n}"},
    {name: "CaseService", body: "public without sharing class CaseService {\n  @AuraEnabled public static String getSummary(Id i) { return [SELECT Subject FROM Case WHERE Id = :i].Subject; }\n" +
      "  @InvocableMethod public static void assignPriority(List<Case> cases) {\n    List<Account> a = [SELECT Id FROM Account];\n    update cases;\n    insert new Task(Subject = 'x');\n  }\n}"},
    {name: "CaseServiceTest", body: "@IsTest private class CaseServiceTest { @IsTest static void t() { CaseService.assignPriority(null); } }"}],
  flows: [
    {name: "Case_Route", label: "Route Cases", meta: {label: "Route Cases", processType: "AutoLaunchedFlow",
      start: {object: "Case", recordTriggerType: "Update", triggerType: "RecordAfterSave", connector: {targetReference: "Get_Account"}},
      recordLookups: [{name: "Get_Account", label: "Get the account", object: "Account", connector: {targetReference: "Is_Gold"}}],
      decisions: [{name: "Is_Gold", label: "Gold?", defaultConnector: {targetReference: "Notify"}, defaultConnectorLabel: "Other",
        rules: [{name: "Gold", label: "Gold", conditions: [{leftValueReference: "Tier", operator: "EqualTo", rightValue: {stringValue: "Gold"}}], connector: {targetReference: "Move"}}]}],
      recordUpdates: [{name: "Move", label: "Move <to> VIP", inputReference: "$Record", connector: {targetReference: "Notify"}, faultConnector: {targetReference: "Err"}}],
      subflows: [{name: "Notify", label: "Notify the team", flowName: "Notify_Team"}],
      customErrors: [{name: "Err", label: "Show an error", customErrorMessages: [{errorMessage: "Failed"}]}]}},
    {name: "Case_Defaults", label: "Case Defaults", meta: {label: "Case Defaults", start: {object: "Case", recordTriggerType: "Create", triggerType: "RecordBeforeSave"}}},
    {name: "Notify_Team", label: "Notify Team", meta: {label: "Notify Team", startElementReference: "Run",
      actionCalls: [{name: "Run", label: "Recalculate", actionType: "apex", actionName: "CaseService"}]}}],
  lwc: [{name: "caseSummary", label: "Case Summary", files: [{path: "lwc/caseSummary/caseSummary.js", source: "import getSummary from '@salesforce/apex/CaseService.getSummary';"}],
    meta: {targets: {target: ["lightning__RecordPage"]}}}],
  aura: [],
  rules: [{name: "Needs_Resolution", object: "Case", active: true, formula: "ISBLANK(Resolution__c)", message: "Add a resolution."}],
});

const edge = (g, from, kind, to) => g.edges.some(e => e.from === from && e.kind === kind && e.to === to);

test("Apex facts: SOQL reads, DML writes (typed variables and new X), known classes called", () => {
  const f = apexFacts("public class S { void m(List<Case> cs) { Account a = [SELECT Id FROM Account LIMIT 1]; update cs; insert new Task(); Helper.go(); } }",
    {classNames: ["Helper", "S"], self: "S"});
  assert.deepEqual(f.reads, ["Account"]);
  assert.deepEqual(f.writes.sort(), ["Case", "Task"]);
  assert.deepEqual(f.calls, ["Helper"]);
  // Inside comments and strings nothing counts.
  assert.deepEqual(apexFacts("// update cases;\nString s = '[SELECT Id FROM Lead]';", {}).reads, []);
});

test("flow facts: object, timing, record steps, subflows and Apex actions", () => {
  const f = flowFacts(items().flows[0].meta);
  assert.equal(f.object, "Case");
  assert.equal(f.triggerType, "RecordAfterSave");
  assert.deepEqual(f.reads, ["Account"]);
  assert.deepEqual(f.writes, ["Case"]);
  assert.deepEqual(f.subflows, ["Notify_Team"]);
  assert.deepEqual(flowFacts(items().flows[2].meta).apex, ["CaseService"]);
});

test("the graph links triggers, classes, flows, LWC and rules; test classes and label-only objects stay out", () => {
  const g = buildGuideGraph(items());
  assert.ok(edge(g, "object:case", "fires", "trigger:casetrigger"));
  assert.ok(edge(g, "trigger:casetrigger", "calls", "class:casetriggerhandler"));
  assert.ok(edge(g, "class:casetriggerhandler", "calls", "class:caseservice"));
  assert.ok(edge(g, "class:caseservice", "writes", "object:case"));
  assert.ok(edge(g, "class:caseservice", "reads", "object:account"));
  assert.ok(edge(g, "object:case", "fires", "flow:case_route"));
  assert.ok(edge(g, "flow:case_route", "subflow", "flow:notify_team"));
  assert.ok(edge(g, "flow:notify_team", "apex-action", "class:caseservice"));
  assert.ok(edge(g, "lwc:casesummary", "uses", "class:caseservice"));
  assert.ok(edge(g, "object:case", "checks", "rule:case.needs_resolution"));
  assert.ok(edge(g, "object:case", "lookup", "object:account"));
  assert.ok(!g.nodes.some(n => n.id === "class:caseservicetest"));
  assert.ok(!g.nodes.some(n => n.id === "object:lead"));
});

test("an area keeps what runs on its object and leaves other objects' automation out", () => {
  const g = buildGuideGraph(items());
  const area = selectArea(g, "Case");
  const ids = area.nodes.map(n => n.id);
  for (const id of ["trigger:casetrigger", "class:caseservice", "flow:notify_team", "lwc:casesummary", "rule:case.needs_resolution", "object:account"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(!ids.includes("trigger:accounttrigger"));
  assert.equal(selectArea(g, "Nope").nodes.length, 0);
  assert.equal(selectArea(g, "Case", {maxComponents: 2}).more > 0, true);
});

test("run order follows a save: before-save flow, before trigger, rules, after-save flow, then code", () => {
  const area = selectArea(buildGuideGraph(items()), "Case");
  const order = runOrder(area).map(o => o.id);
  const at = id => order.indexOf(id);
  assert.ok(at("flow:case_defaults") < at("trigger:casetrigger"));
  assert.ok(at("trigger:casetrigger") < at("rule:case.needs_resolution"));
  assert.ok(at("rule:case.needs_resolution") < at("flow:case_route"));
  assert.ok(at("flow:case_route") < at("class:casetriggerhandler"));
  assert.ok(at("class:casetriggerhandler") < at("class:caseservice"));
  assert.ok(at("class:caseservice") < at("lwc:casesummary"));
});

test("plain words, related components and risks without AI", () => {
  const g = buildGuideGraph(items());
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const svc = describeComponent(byId.get("class:caseservice"), g);
  assert.ok(svc.plain.some(p => /without sharing/.test(p)));
  assert.ok(svc.plain.some(p => /Used by CaseTriggerHandler, Notify Team and Case Summary/.test(p)));
  assert.ok(svc.risks.some(r => /without sharing/.test(r)));
  const trg = describeComponent(byId.get("trigger:casetrigger"), g);
  assert.match(trg.plain[0], /before insert and after update/);
  assert.ok(trg.related.some(r => r.id === "flow:case_route" && /also runs when Case is saved/.test(r.reason)));
  const flow = describeComponent(byId.get("flow:case_route"), g);
  assert.ok(flow.plain.some(p => /runs the subflow Notify_Team/.test(p)));
});

test("flowchart: start, diamond with labelled branches, fault path, end, linked subflow", () => {
  const d = flowDiagram(items().flows[0].meta, {linkFor: (t, n) => (t === "flow" ? `flow:${n.toLowerCase()}` : null)});
  const node = id => d.nodes.find(n => n.id === id);
  assert.equal(node("f:start").shape, "pill");
  assert.equal(node("f:Is_Gold").shape, "diamond");
  assert.equal(node("f:Notify").link, "flow:notify_team");
  assert.ok(d.edges.some(e => e.from === "f:Is_Gold" && e.to === "f:Move" && /Gold/.test(e.label)));
  assert.ok(d.edges.some(e => e.from === "f:Is_Gold" && e.to === "f:Notify" && e.label === "Other"));
  assert.ok(d.edges.some(e => e.from === "f:Move" && e.to === "f:Err" && e.kind === "fault"));
  assert.ok(d.nodes.some(n => n.id === "f:end"));
});

test("layout: no overlapping boxes, every edge drawn, loops go round the side, stable output", () => {
  const g = {nodes: ["a", "b", "c", "d", "e"].map(id => ({id, label: "Step " + id})),
    edges: [{from: "a", to: "b"}, {from: "a", to: "c"}, {from: "b", to: "d"}, {from: "c", to: "d"}, {from: "a", to: "d"}, {from: "d", to: "e"}, {from: "e", to: "b", label: "again"}]};
  for (const dir of ["TB", "LR"]) {
    const L = layoutGraph(g, {dir});
    assert.ok(noOverlap(L), dir);
    assert.equal(L.edges.length, g.edges.length);
    assert.ok(L.edges.every(e => e.points.length >= 2));
    assert.equal(L.edges.find(e => e.from === "e").back, true);
    assert.deepEqual(layoutGraph(g, {dir}), L);
  }
  assert.deepEqual(wrapText("Supercalifragilistic expialidocious word", 60, 2).length, 2);
});

test("SVG escapes labels from the org", () => {
  const L = layoutGraph({nodes: [{id: "x", label: "<img src=x onerror=alert(1)>"}], edges: []});
  const svg = diagramSvg(L);
  assert.ok(!svg.includes("<img"));
  assert.ok(svg.includes("&lt;img"));
});

test("guide sections, ELI5 batches, Mermaid and HTML exports", () => {
  const g = buildGuide(items(), {kind: "area", object: "Case"}, {orgName: "Demo"});
  assert.equal(g.title, "Case");
  assert.ok(g.sections.length >= 7);
  assert.ok(g.sections.every(s => s.diagram.nodes.length && s.aiInput.startsWith("ID: ")));
  assert.ok(!g.sections.some(s => /SELECT|update cases/.test(s.aiInput)), "no code bodies go to the AI");
  const batches = eli5Batches(g.sections, {size: 3});
  assert.equal(batches.reduce((n, b) => n + b.ids.length, 0), g.sections.length);
  assert.ok(batches.every(b => b.ids.length <= 3));
  const mm = toMermaid(g.sections.find(s => s.id === "flow:case_route").diagram);
  assert.match(mm, /^flowchart TD/);
  assert.match(mm, /\{"Gold\?/);
  assert.match(mm, /-\.->\|"If it fails"\|/);
  assert.ok(!/Move <to>/.test(mm), "labels are escaped for Mermaid");
  const md = guideToMarkdown(g);
  assert.match(md, /```mermaid/);
  assert.match(md, /## Before-save flows/);
  const html = guideToHtml(g);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok((html.match(/<svg/g) || []).length > g.sections.length);
  assert.ok(!html.includes("Move <to> VIP"));
});

test("whole-org overview ranks the busiest objects", () => {
  const g = buildGuideGraph(items());
  const r = areaRanking(g);
  assert.equal(r[0].name, "Case");
  assert.equal(r[0].flows, 2);
  const org = buildGuide(items(), {kind: "org"});
  assert.equal(org.sections.length, 0);
  assert.ok(org.maps.business.nodes.some(n => n.id === "object:case"));
});
