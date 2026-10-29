import {test} from "node:test";
import assert from "node:assert/strict";
import {toApiName, cmdtTypeXml, cmdtRecordXml, createMetadataBody, parseCreateResult} from "../../addon/core/cmdt.js";

test("toApiName", () => {
  assert.equal(toApiName("Feature Flag"), "Feature_Flag");
  assert.equal(toApiName("  Max # of Items! "), "Max_of_Items");
  assert.equal(toApiName("2FA Setting"), "X2FA_Setting");
});

test("cmdtTypeXml builds the type with fields", () => {
  const xml = cmdtTypeXml({name: "Feature_Flag", label: "Feature Flag", pluralLabel: "Feature Flags", description: "A & B",
    fields: [{label: "Enabled", name: "Enabled", type: "Checkbox"}, {label: "Limit", name: "Limit", type: "Number", required: true}]});
  assert.match(xml, /<met:fullName>Feature_Flag__mdt<\/met:fullName>/);
  assert.match(xml, /<met:visibility>Public<\/met:visibility>/);
  assert.match(xml, /<met:description>A &amp; B<\/met:description>/);
  assert.match(xml, /<met:fullName>Enabled__c<\/met:fullName>[\s\S]*<met:defaultValue>false<\/met:defaultValue>/);
  assert.match(xml, /<met:fullName>Limit__c<\/met:fullName>[\s\S]*<met:required>true<\/met:required>[\s\S]*<met:precision>18/);
});

test("cmdtRecordXml types values and nils empties", () => {
  const xml = cmdtRecordXml("Feature_Flag__mdt", {label: "Checkout v2", name: "Checkout_v2",
    values: {Enabled__c: true, Limit__c: "5", Note__c: ""}}, {Enabled__c: "boolean", Limit__c: "double", Note__c: "string"});
  assert.match(xml, /<met:fullName>Feature_Flag\.Checkout_v2<\/met:fullName>/);
  assert.match(xml, /<met:value xsi:type="xsd:boolean">true<\/met:value>/);
  assert.match(xml, /<met:value xsi:type="xsd:double">5<\/met:value>/);
  assert.match(xml, /<met:field>Note__c<\/met:field>\n {4}<met:value xsi:nil="true"\/>/);
  assert.match(createMetadataBody(xml), /^<met:createMetadata>/);
});

test("update helpers: merge, upsert and delete bodies", async () => {
  const {mergedRecord, upsertMetadataBody, deleteMetadataBody} = await import("../../addon/core/cmdt.js");
  const fields = [{name: "Enabled__c"}, {name: "Limit__c"}];
  const rec = mergedRecord({DeveloperName: "A", MasterLabel: "A", Enabled__c: true, Limit__c: 5}, {Limit__c: "9"}, fields);
  assert.deepEqual(rec, {label: "A", name: "A", values: {Enabled__c: true, Limit__c: "9"}});
  const xml = cmdtRecordXml("T__mdt", rec, {Enabled__c: "boolean", Limit__c: "double"});
  assert.doesNotMatch(xml, /protected/);
  assert.match(upsertMetadataBody(xml), /^<met:upsertMetadata>/);
  assert.equal(deleteMetadataBody("CustomMetadata", ["T.A"]),
    "<met:deleteMetadata>\n  <met:type>CustomMetadata</met:type>\n  <met:fullNames>T.A</met:fullNames>\n</met:deleteMetadata>");
});

test("parseCreateResult", () => {
  assert.deepEqual(parseCreateResult("<result><fullName>X__mdt</fullName><success>true</success></result>"),
    {success: true, fullName: "X__mdt", errors: []});
  const bad = parseCreateResult("<result><errors><message>Duplicate name</message></errors><fullName>X</fullName><success>false</success></result>");
  assert.equal(bad.success, false);
  assert.deepEqual(bad.errors, ["Duplicate name"]);
  assert.deepEqual(parseCreateResult("<soapenv:Fault><faultstring>INVALID_SESSION_ID</faultstring></soapenv:Fault>").errors, ["INVALID_SESSION_ID"]);
});
