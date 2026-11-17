import test from "node:test";
import assert from "node:assert/strict";
import {
  words, retrieve, askContext, parseCitations, suggestedQuestions, buildChecklist, checklistProgress,
  accessSummary, explainFlexiPage, changesSince
} from "../../addon/core/handbook-plus.js";
import {buildHandbook} from "../../addon/core/handbook.js";

const ROUTE = {label: "Route VIP Cases", start: {object: "Case", recordTriggerType: "Update", triggerType: "RecordAfterSave", connector: {targetReference: "Esc"}},
  recordUpdates: [{name: "Esc", label: "Escalate", inputReference: "$Record", inputAssignments: [{field: "Status", value: {stringValue: "Escalated"}}],
    connector: {targetReference: "Mail"}}],
  actionCalls: [{name: "Mail", label: "Email the owner", actionType: "emailAlert", actionName: "Case.Owner_Alert"}]};
const WIZ = {label: "New Case Wizard", processType: "Flow", startElementReference: "S", screens: [{name: "S", label: "Describe it"}]};
const ago = d => new Date(Date.now() - d * 86400e3).toISOString().replace("Z", "+0000");
const items = () => ({
  objects: [],
  triggers: [{name: "CaseTrigger", object: "Case", body: "trigger CaseTrigger on Case (before update) { CaseService.run(); }", stamp: {created: ago(90), modified: ago(1), by: "Priya"}}],
  classes: [{name: "CaseService", body: "public class CaseService { public static void run() {} }", stamp: {created: ago(2), modified: ago(2), by: "Priya"}}],
  flows: [{name: "Route_VIP", label: "Route VIP Cases", meta: ROUTE, stamp: {created: ago(200), modified: ago(200), by: "Rakesh"}},
    {name: "New_Case_Wizard", label: "New Case Wizard", meta: WIZ, stamp: {created: ago(5), modified: ago(5), by: "Anita"}}],
  lwc: [], aura: [],
  rules: [{name: "Closed_Needs_Resolution", object: "Case", active: true, formula: "AND(ISPICKVAL(Status, \"Closed\"), ISBLANK(Resolution__c))",
    message: "Add a resolution before closing the case.", stamp: {created: ago(10), modified: ago(10), by: "Rakesh"}}],
});
const extras = {apps: [], objectInfo: {Case: {label: "Case", picklists: [{name: "Status", label: "Status", values: ["New", "Escalated", "Closed"]}], recordTypes: []}}};
const hb = () => buildHandbook(items(), extras);

test("question words: stop words out, light stemming on both sides", () => {
  assert.deepEqual(words("Why can't I close the cases?"), ["clos", "cas"]);
  assert.ok(words("Which flows send emails?").includes("email"));
  assert.deepEqual(words("Closed"), words("closing"));
});

test("retrieval finds the flows, process and rule a question is about", () => {
  const r = retrieve(hb(), items(), "What happens when a case is escalated?");
  assert.equal(r.flows[0].f.name, "Route_VIP");
  assert.equal(r.processes[0].p.object, "Case");
  const why = retrieve(hb(), items(), "Why can't I close a case?");
  assert.ok(why.rules.some(x => x.r.name === "Closed_Needs_Resolution"));
});

test("the AI context is tagged with the references it must cite, and never has code", () => {
  const {text} = askContext(hb(), items(), "What happens when a case is escalated?");
  assert.match(text, /\[process:Case\] Life of a Case \(stages by Status: New → Escalated → Closed\)/);
  assert.match(text, /\[flow:route_vip\] Flow "Route VIP Cases"/);
  assert.match(text, /Update this Case \(sets Status = "Escalated"\)/);
  assert.ok(!/public class|{ CaseService.run(); }/.test(text), "no code bodies");
});

test("citations become links; unknown ones stay text", () => {
  const segs = parseCitations("See [flow:route_vip] and [Flow:nope] or [rule:case.closed_needs_resolution].", ref =>
    ({"flow:route_vip": "Route VIP Cases", "rule:case.closed_needs_resolution": "Closed_Needs_Resolution"})[ref]);
  assert.deepEqual(segs.filter(s => s.ref).map(s => s.label), ["Route VIP Cases", "Closed_Needs_Resolution"]);
  assert.ok(segs.some(s => s.text === "[Flow:nope]"));
});

test("suggested questions come from this org", () => {
  const q = suggestedQuestions(hb());
  assert.ok(q.some(x => /becomes Closed/.test(x)));
  assert.ok(q.some(x => /send emails/.test(x)));
  assert.ok(q.some(x => /Why can't I save a Case/.test(x)));
});

test("onboarding checklist and progress", () => {
  const list = buildChecklist(hb());
  const ids = list.map(i => i.id);
  assert.ok(ids.includes("process:Case"));
  assert.ok(ids.includes("flow:route_vip"));
  assert.ok(ids.includes("try:flow:new_case_wizard"));
  assert.ok(list.find(i => i.id === "try:flow:new_case_wizard").manual);
  assert.deepEqual(checklistProgress(list, {"process:Case": true, home: true}), {done: 2, total: list.length, pct: Math.round(200 / list.length)});
});

test("who works on a record: access words and active users, profiles without users dropped", () => {
  const rows = [
    {ParentId: "A", Parent: {IsOwnedByProfile: true, Profile: {Name: "System Administrator"}}, PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true,
      PermissionsDelete: true, PermissionsViewAllRecords: true, PermissionsModifyAllRecords: true},
    {ParentId: "B", Parent: {IsOwnedByProfile: false, Label: "Support Agent"}, PermissionsRead: true, PermissionsEdit: true},
    {ParentId: "C", Parent: {IsOwnedByProfile: true, Profile: {Name: "Unused Profile"}}, PermissionsRead: true},
    {ParentId: "D", Parent: {IsOwnedByProfile: false, Label: "No read"}, PermissionsRead: false}];
  const s = accessSummary(rows, {A: 2, B: 5});
  assert.deepEqual(s.map(x => `${x.name}:${x.users}`), ["Support Agent:5", "System Administrator:2"]);
  assert.deepEqual(s[1].access, ["Read", "Create", "Edit", "Delete", "View all", "Modify all"]);
});

test("record page explained: standard parts in words, flows and own components linked", () => {
  const meta = {masterLabel: "Case Page", type: "RecordPage", sobjectType: "Case", flexiPageRegions: [
    {name: "header", type: "Region", itemInstances: [{componentInstance: {componentName: "force:highlightsPanel"}}]},
    {name: "side", type: "Region", itemInstances: [{componentInstance: {componentName: "c:caseSummary"}},
      {componentInstance: {componentName: "flowruntime:interview", componentInstanceProperties: [{name: "flowName", value: "Route_VIP"}]}},
      {fieldInstance: {fieldItem: "Subject"}}]},
    {name: "facet-1", type: "Facet", itemInstances: [{componentInstance: {componentName: "flexipage:tab"}}]}]};
  const x = explainFlexiPage(meta, {flowIds: new Set(["flow:route_vip"]), lwcNames: new Set(["casesummary"])});
  assert.equal(x.regions.length, 2);
  assert.match(x.regions[0].components[0].label, /^Highlights/);
  assert.deepEqual(x.regions[1].components.map(c => c.ref), ["lwc:casesummary", "flow:route_vip"]);
});

test("what changed: new vs changed, newest first, older ones left out", () => {
  const c = changesSince(items(), Date.now() - 30 * 86400e3);
  assert.deepEqual(c.map(x => `${x.label}:${x.change}`), ["CaseTrigger:changed", "CaseService:new", "New Case Wizard:new", "Closed_Needs_Resolution:new"]);
  assert.equal(c[0].by, "Priya");
  assert.ok(!c.some(x => x.label === "Route VIP Cases"));
});

test("the whole handbook exports as Markdown (Mermaid) and one HTML page (SVG), escaped", async () => {
  const {handbookToMarkdown, handbookToHtml} = await import("../../addon/core/handbook-export.js");
  const book = {...hb(), business: "WHAT THIS BUSINESS DOES\n- Support <cases>", orgName: "Demo"};
  const eli5 = {"flow:route_vip": {eli5: "Like a mail sorter."}};
  const md = handbookToMarkdown(book, items(), {eli5});
  assert.match(md, /^# Org Handbook: Demo/);
  assert.match(md, /### The life of a Case/);
  assert.match(md, /\| When \| Any change \| New \| Escalated \| Closed \|/);
  assert.match(md, /### Route VIP Cases/);
  assert.match(md, /```mermaid\nflowchart TD/);
  assert.match(md, /1\. ✎ Update this Case/);
  assert.match(md, /> 🧸 Like a mail sorter\./);
  const html = handbookToHtml(book, items(), {eli5});
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok((html.match(/<svg/g) || []).length >= 2, "a diagram per flow");
  assert.ok(html.includes("Support &lt;cases&gt;"));
  assert.ok(!html.includes("<cases>"));
  assert.match(html, /set by Route VIP Cases/);
});
