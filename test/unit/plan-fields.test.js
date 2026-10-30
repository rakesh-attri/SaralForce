import {test} from "node:test";
import assert from "node:assert/strict";
import {fieldDefaults, describeFieldType, describeToProposal, permissionSetNameFor} from "../../addon/core/plan-fields.js";
import {validateProposal} from "../../addon/core/object-builder-rules.js";

test("fieldDefaults fills only missing props for the type", () => {
  assert.deepEqual(fieldDefaults("Currency"), {precision: 18, scale: 2});
  assert.deepEqual(fieldDefaults("Currency", {precision: 10}), {scale: 2});
  assert.deepEqual(fieldDefaults("Formula"), {returnType: "Text", formula: ""});
  assert.deepEqual(fieldDefaults("Picklist", {globalValueSet: "Countries"}), {});
  assert.deepEqual(fieldDefaults("geolocation"), {scale: 5});
  assert.deepEqual(fieldDefaults("Email"), {});
});

test("describeFieldType maps describe types to plan types", () => {
  assert.equal(describeFieldType({type: "string"}), "Text");
  assert.equal(describeFieldType({type: "textarea", length: 32768}), "LongTextArea");
  assert.equal(describeFieldType({type: "textarea", length: 32768, extraTypeInfo: "richtextarea"}), "Html");
  assert.equal(describeFieldType({type: "currency", calculated: true, calculatedFormula: "A__c * 2"}), "Formula");
  assert.equal(describeFieldType({type: "double", calculated: true}), "Summary");
  assert.equal(describeFieldType({type: "string", autoNumber: true}), "AutoNumber");
  assert.equal(describeFieldType({type: "reference", relationshipOrder: 0}), "MasterDetail");
  assert.equal(describeFieldType({type: "reference", relationshipOrder: null}), "Lookup");
  assert.equal(describeFieldType({type: "anyType"}), null);
});

test("describeToProposal lists custom fields as existing and validates", () => {
  const p = describeToProposal({
    name: "Order__c", label: "Order", labelPlural: "Orders",
    fields: [
      {name: "Id", type: "id", custom: false},
      {name: "Name", type: "string", label: "Order Name", nameField: true, custom: false},
      {name: "Status__c", label: "Status", type: "picklist", custom: true, nillable: true, picklistValues: [{value: "New"}, {value: "Done"}]},
      {name: "Account__c", label: "Account", type: "reference", custom: true, nillable: true, referenceTo: ["Account"], relationshipOrder: null},
      {name: "Where__Latitude__s", label: "Lat", type: "double", custom: true, compoundFieldName: "Where__c"}
    ]
  });
  assert.equal(p.object.name, "Order__c");
  assert.equal(p.object.nameField.label, "Order Name");
  assert.deepEqual(p.fields.map(f => f.name), ["Status__c", "Account__c"]);
  assert.ok(p.fields.every(f => f.existing));
  assert.deepEqual(p.fields[0].values, ["New", "Done"]);
  assert.equal(p.fields[1].relatedTo, "Account");
  p.fields.push({label: "Total", name: "Total__c", type: "Formula", returnType: "Currency", formula: "1"});
  assert.deepEqual(validateProposal(p), []);
});

test("permissionSetNameFor builds a valid DeveloperName", () => {
  assert.deepEqual(permissionSetNameFor("IT_Asset__c"), {name: "IT_Asset_Access", label: "IT Asset Access"});
  assert.equal(permissionSetNameFor("ns__Thing__c").name, "ns_Thing_Access");
  assert.ok(permissionSetNameFor("A".repeat(90) + "__c").name.length <= 80);
});

test("fieldDetailSummary describes the settings that matter", async () => {
  const {fieldDetailSummary} = await import("../../addon/core/plan-fields.js");
  assert.equal(fieldDetailSummary({type: "Picklist", values: ["Low", "Medium", "High"]}), "3 values: Low, Medium, High");
  assert.equal(fieldDetailSummary({type: "Picklist", values: []}), "No values yet — add them");
  assert.equal(fieldDetailSummary({type: "Picklist", globalValueSet: "Countries"}), "Global value set: Countries");
  assert.equal(fieldDetailSummary({type: "Formula", returnType: "Currency", formula: "A__c * 2"}), "Currency = A__c * 2");
  assert.equal(fieldDetailSummary({type: "Lookup", relatedTo: "Account"}), "→ Account");
  assert.equal(fieldDetailSummary({type: "Text"}), null);
});
