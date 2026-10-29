import {test} from "node:test";
import assert from "node:assert/strict";
import {
  validateName, pascalCase, apexClassSource, APEX_TEMPLATES, apexTriggerSource, triggerHandlerSource,
  visualforceSource, lwcFiles, lwcMetaXml, auraFiles, flowMetadata, validationRuleMetadata
} from "../../addon/core/metadata-templates.js";

test("validateName per kind", () => {
  assert.equal(validateName("accountCard", "lwc"), null);
  assert.match(validateName("AccountCard", "lwc"), /camelCase/);
  assert.match(validateName("account_card", "lwc"), /camelCase/);
  assert.equal(validateName("InvoiceService", "apex"), null);
  assert.match(validateName("Invoice__Service", "apex"), /double underscores/);
  assert.match(validateName("1Invoice", "apex"), /Start with a letter/);
  assert.match(validateName("Trigger", "trigger"), /reserved/);
  assert.match(validateName("", "flow"), /required/);
});

test("pascalCase", () => {
  assert.equal(pascalCase("invoiceList"), "InvoiceList");
  assert.equal(pascalCase("invoice list"), "InvoiceList");
});

test("every Apex template declares the class name and balances braces", () => {
  for (const [id] of APEX_TEMPLATES) {
    const src = apexClassSource("MyThing", id);
    assert.match(src, /class MyThing\b/, id);
    assert.equal((src.match(/\{/g) || []).length, (src.match(/\}/g) || []).length, id);
  }
  assert.match(apexClassSource("T", "test"), /^@IsTest/);
});

test("trigger with and without handler", () => {
  assert.match(apexTriggerSource("AccTrig", "Account", ["before insert", "after update"], false),
    /^trigger AccTrig on Account \(before insert, after update\)/);
  const withHandler = apexTriggerSource("InvTrig", "Invoice__c", ["after insert"], true);
  assert.match(withHandler, /InvoiceTriggerHandler\.run\(/);
  assert.match(triggerHandlerSource("Invoice__c"), /class InvoiceTriggerHandler[\s\S]*List<Invoice__c>/);
});

test("visualforce escapes the label", () => {
  assert.match(visualforceSource({label: "A & B", controller: "Account"}), /standardController="Account"[\s\S]*A &amp; B/);
});

test("lwcFiles builds html, js, optional css/svg and meta xml", () => {
  const files = lwcFiles({name: "accountCard", label: "Account Card", exposed: true,
    targets: ["lightning__RecordPage"], css: true, svg: false, apiVersion: "68.0"});
  assert.deepEqual(files.map(f => f.path), [
    "lwc/accountCard/accountCard.html", "lwc/accountCard/accountCard.js",
    "lwc/accountCard/accountCard.css", "lwc/accountCard/accountCard.js-meta.xml"]);
  const js = files[1].content;
  assert.match(js, /export default class AccountCard extends LightningElement/);
  assert.match(js, /@api title/);
  assert.match(files[3].content, /<isExposed>true<\/isExposed>[\s\S]*<target>lightning__RecordPage<\/target>/);
  assert.equal(files[3].generated, true);
});

test("LWC templates are real starters", async () => {
  const {fieldList, fieldLabel} = await import("../../addon/core/metadata-templates.js");
  assert.deepEqual(fieldList("Name, Industry ,Phone;Bad-Field"), ["Name", "Industry", "Phone"]);
  assert.equal(fieldLabel("Annual_Revenue__c"), "Annual Revenue");
  const rec = lwcFiles({name: "accDetails", template: "record", object: "Account", fields: "Name, Industry", apiVersion: "68.0"});
  assert.match(rec[0].content, /<lightning-record-view-form record-id=\{recordId\}/);
  assert.match(rec[0].content, /field-name="Industry"/);
  assert.match(rec[1].content, /@api recordId/);
  const form = lwcFiles({name: "accForm", template: "form", object: "Account", fields: "Name", apiVersion: "68.0"});
  assert.match(form[0].content, /lightning-record-edit-form object-api-name="Account"/);
  assert.match(form[1].content, /ShowToastEvent/);
  const table = lwcFiles({name: "accTable", template: "datatable", object: "Account", fields: "Name, Phone", apiVersion: "68.0"});
  assert.deepEqual(table.filter(f => f.role === "apex").map(f => f.name), ["AccTableController", "AccTableControllerTest"]);
  assert.match(table[1].content, /import getRecords from '@salesforce\/apex\/AccTableController\.getRecords'/);
  assert.match(table[1].content, /fieldName: 'Phone'/);
  assert.match(table.find(f => f.name === "AccTableController").content, /SELECT Id, Name, Phone\s+FROM Account\s+WHERE Name LIKE :key/);
  const action = lwcFiles({name: "quickFix", template: "action", object: "Case", fields: "Status", apiVersion: "68.0"});
  assert.match(action[1].content, /CloseActionScreenEvent/);
});

test("Aura templates add the interfaces and Apex they need", () => {
  const rec = auraFiles({name: "accView", template: "record", object: "Account", fields: "Name"});
  assert.match(rec[0].content, /implements="force:hasRecordId,flexipage:availableForRecordHome"/);
  const apex = auraFiles({name: "accList", template: "apex", object: "Account", fields: "Name"});
  assert.deepEqual(apex.map(f => f.defType || f.role), ["COMPONENT", "CONTROLLER", "HELPER", "apex", "apex"]);
  assert.match(apex[0].content, /controller="AccListController"/);
});

test("lwcMetaXml omits targets when not exposed", () => {
  const xml = lwcMetaXml({apiVersion: "68.0", exposed: false, targets: ["lightning__AppPage"]});
  assert.doesNotMatch(xml, /targets/);
  assert.match(xml, /<isExposed>false<\/isExposed>/);
});

test("auraFiles adds optional definitions", () => {
  const f = auraFiles({name: "myCmp", interfaces: ["force:hasRecordId"], controller: true, style: true});
  assert.deepEqual(f.map(x => x.defType), ["COMPONENT", "CONTROLLER", "STYLE"]);
  assert.match(f[0].content, /implements="force:hasRecordId"/);
});

test("flowMetadata variants", () => {
  const rec = flowMetadata({label: "Case Sync", kind: "record", object: "Case", when: "Update", timing: "RecordBeforeSave", apiVersion: "68.0"});
  assert.equal(rec.status, "Draft");
  assert.deepEqual([rec.start.object, rec.start.recordTriggerType, rec.start.triggerType], ["Case", "Update", "RecordBeforeSave"]);
  const screen = flowMetadata({label: "Intake", kind: "screen"});
  assert.equal(screen.processType, "Flow");
  assert.equal(screen.start.connector.targetReference, screen.screens[0].name);
  assert.equal(flowMetadata({kind: "scheduled"}).start.triggerType, "Scheduled");
});

test("validateForm flags missing pieces per kind", async () => {
  const {validateForm} = await import("../../addon/core/metadata-templates.js");
  assert.deepEqual(validateForm("apex", {name: "Good"}), {});
  assert.deepEqual(Object.keys(validateForm("triggers", {name: "T1"})).sort(), ["events", "object"]);
  assert.deepEqual(Object.keys(validateForm("rules", {name: "R", object: "Account"})).sort(), ["formula", "message"]);
  assert.ok(validateForm("lwc", {name: "card", exposed: true, targets: []}).targets);
  assert.ok(validateForm("flows", {name: "F", flowKind: "record", label: "x"}).object);
});

test("buildDraft produces deployable files", async () => {
  const {buildDraft} = await import("../../addon/core/metadata-templates.js");
  const trig = buildDraft("triggers", {name: "InvoiceTrigger", object: "Invoice__c", events: ["after insert"], handler: true});
  assert.deepEqual(trig.files.map(f => [f.path, f.role || ""]), [
    ["triggers/InvoiceTrigger.trigger", ""], ["classes/InvoiceTriggerHandler.cls", "handler"]]);
  const lwc = buildDraft("lwc", {name: "testLWC", exposed: true, targets: ["lightning__AppPage"], css: true, apiVersion: "68.0"});
  assert.deepEqual(lwc.files.map(f => f.path.split("/").pop()), ["testLWC.html", "testLWC.js", "testLWC.css", "testLWC.js-meta.xml"]);
  assert.equal(lwc.files[3].readOnly, true);
  const flow = buildDraft("flows", {name: "Case_Sync", label: "Case Sync", flowKind: "record", object: "Case", when: "Update", timing: "RecordAfterSave"});
  assert.equal(JSON.parse(flow.files[0].content).start.object, "Case");
  const rule = buildDraft("rules", {name: "No_Negative", object: "Account", formula: "AnnualRevenue < 0", message: "No"});
  assert.equal(rule.title, "Account.No_Negative");
});

test("custom metadata type draft and validation", async () => {
  const {buildDraft, validateForm} = await import("../../addon/core/metadata-templates.js");
  const form = {name: "Feature_Flag", label: "Feature Flag",
    fields: [{label: "Enabled", name: "Enabled", type: "Checkbox"}, {label: "", name: ""}]};
  assert.deepEqual(validateForm("cmdt", form), {});
  assert.match(validateForm("cmdt", {...form, fields: [{label: "A", name: "A"}, {label: "a", name: "a"}]}).fields, /same API name/);
  const d = buildDraft("cmdt", form);
  assert.equal(d.title, "Feature_Flag__mdt");
  assert.deepEqual(JSON.parse(d.files[0].content).fields, [{label: "Enabled", name: "Enabled", type: "Checkbox", required: false}]);
});

test("validationRuleMetadata", () => {
  assert.deepEqual(validationRuleMetadata({formula: "X < 0", message: "No", field: "X__c", active: false}),
    {active: false, errorConditionFormula: "X < 0", errorMessage: "No", errorDisplayField: "X__c"});
});
