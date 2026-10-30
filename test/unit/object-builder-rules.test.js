import {test} from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_TYPE_VALUES, normalizeFieldType, supportsRequired, validateApiName,
  suggestApiName, uniqueApiName, nextRetryName, resolveNameField,
  normalizeProposal, validateProposal, resolveSharingModel, validateSharingModel,
  parseJSONFromText, stripTrailingCommas, escapeSoqlString, isNonTransientDeployError
} from "../../addon/core/object-builder-rules.js";

const baseProposal = () => ({
  object: {label: "Invoice", name: "Invoice__c", sharingModel: "ReadWrite", nameField: {label: "Invoice Name", type: "Text"}},
  fields: [{label: "Amount", name: "Amount__c", type: "Currency"}]
});

test("normalizeFieldType maps common variants onto FIELD_TYPES values", () => {
  const cases = {
    "Master-Detail": "MasterDetail",
    "master detail": "MasterDetail",
    "Master-Detail Relationship": "MasterDetail",
    "MASTERDETAIL": "MasterDetail",
    "Lookup Relationship": "Lookup",
    "Date/Time": "DateTime",
    "Text Area (Long)": "LongTextArea",
    "Long Text Area": "LongTextArea",
    "Picklist (Multi-Select)": "MultiselectPicklist",
    "Multi-Select Picklist": "MultiselectPicklist",
    "URL": "Url",
    "checkbox": "Checkbox"
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeFieldType(input), expected, input);
  }
  for (const v of FIELD_TYPE_VALUES) assert.equal(normalizeFieldType(v), v);
});

test("normalizeFieldType rejects unknown types", () => {
  assert.equal(normalizeFieldType("Hologram"), null);
  assert.equal(normalizeFieldType("Geolocation"), "Location");
  assert.equal(normalizeFieldType("richtext"), "Html");
  assert.equal(normalizeFieldType(""), null);
  assert.equal(normalizeFieldType(null), null);
});

test("supportsRequired excludes Checkbox and MasterDetail", () => {
  assert.equal(supportsRequired("Text"), true);
  assert.equal(supportsRequired("Date/Time"), true);
  assert.equal(supportsRequired("Picklist"), true);
  assert.equal(supportsRequired("Checkbox"), false);
  assert.equal(supportsRequired("Master-Detail"), false);
  assert.equal(supportsRequired("Formula"), false);
});

test("validateApiName accepts valid names", () => {
  assert.equal(validateApiName("Invoice__c"), null);
  assert.equal(validateApiName("Invoice_Line_2__c"), null);
  assert.equal(validateApiName("A".repeat(40) + "__c"), null);
});

test("validateApiName rejects malformed names", () => {
  assert.match(validateApiName("Invoice"), /__c/);
  assert.match(validateApiName("1Invoice__c"), /start with a letter/);
  assert.match(validateApiName("Inv oice__c"), /letters, numbers/);
  assert.match(validateApiName("Inv__oice__c"), /"__"/);
  assert.match(validateApiName("Invoice___c"), /"_"|"__"/);
  assert.match(validateApiName("Invoice_' OR 1=1__c"), /letters, numbers/);
  assert.match(validateApiName("A".repeat(41) + "__c"), /41 characters/);
  assert.match(validateApiName(""), /missing/);
  assert.match(validateApiName(undefined), /missing/);
});

test("suggestApiName folds diacritics and keeps ASCII words", () => {
  assert.equal(suggestApiName("Café Owner"), "Cafe_Owner__c");
  assert.equal(suggestApiName("Número de cuenta"), "Numero_De_Cuenta__c");
  assert.equal(suggestApiName("due date (UTC)"), "Due_Date_UTC__c");
});

test("suggestApiName gives numbered names for non-Latin labels", () => {
  const a = suggestApiName("金額", []);
  assert.equal(a, "Field_1__c");
  const b = suggestApiName("Сумма", [a]);
  assert.notEqual(b, a);
  assert.equal(validateApiName(b), null);
});

test("suggestApiName truncates to 40 and stays unique", () => {
  const long = "This is a very long label that exceeds the forty character limit";
  const first = suggestApiName(long);
  assert.equal(validateApiName(first), null);
  assert.ok(first.length - 3 <= 40);
  const second = suggestApiName(long, [first]);
  assert.notEqual(second, first);
  assert.equal(validateApiName(second), null);
  assert.match(second, /_2__c$/);
  assert.equal(suggestApiName("Amount", ["amount__c"]), "Amount_2__c");
});

test("suggestApiName prefixes labels that start with a digit", () => {
  const name = suggestApiName("2nd Contact");
  assert.equal(validateApiName(name), null);
});

test("uniqueApiName skips taken suffixes", () => {
  assert.equal(uniqueApiName("Foo", ["Foo__c", "Foo_2__c"]), "Foo_3__c");
});

test("nextRetryName increments suffix without stacking labels", () => {
  const r1 = nextRetryName("Invoice__c", "Invoice");
  assert.deepEqual(r1, {name: "Invoice_2__c", label: "Invoice 2"});
  const r2 = nextRetryName(r1.name, r1.label);
  assert.deepEqual(r2, {name: "Invoice_3__c", label: "Invoice 3"});
  const r3 = nextRetryName("Sales_2024__c", "Sales 2024");
  assert.equal(r3.name, "Sales_2025__c");
  const r4 = nextRetryName("Invoice_2__c", "Invoice 2", ["invoice_3__c"]);
  assert.equal(r4.name, "Invoice_4__c");
  const r5 = nextRetryName("A".repeat(40) + "__c", "Long");
  assert.equal(validateApiName(r5.name), null);
});

test("resolveNameField reads nameField.* with flat-key fallback", () => {
  assert.deepEqual(resolveNameField({label: "Pay", nameField: {label: "Pay #", type: "AutoNumber", format: "PT-{00000}"}}),
    {type: "AutoNumber", label: "Pay #", displayFormat: "PT-{00000}"});
  assert.deepEqual(resolveNameField({label: "Pay", nameFieldType: "AutoNumber", nameFieldLabel: "No", displayFormat: "X-{0}"}),
    {type: "AutoNumber", label: "No", displayFormat: "X-{0}"});
  assert.equal(resolveNameField({label: "Pay", nameField: {type: "Auto Number"}}).displayFormat, "{0000}");
  assert.deepEqual(resolveNameField({label: "Pay"}), {type: "Text", label: "Pay Name"});
});

test("validateProposal accepts a good proposal", () => {
  assert.deepEqual(validateProposal(baseProposal()), []);
});

test("validateProposal reports unknown types and duplicate names", () => {
  const p = baseProposal();
  p.fields.push({label: "Total", name: "amount__c", type: "Currency"});
  p.fields.push({label: "Calc", name: "Calc__c", type: "Hologram"});
  const errs = validateProposal(p);
  assert.ok(errs.some(e => /duplicates field 1/.test(e)), errs.join("|"));
  assert.ok(errs.some(e => /unsupported type "Hologram"/.test(e)), errs.join("|"));
});

test("validateProposal enforces relatedTo for Master-Detail variants", () => {
  const p = baseProposal();
  p.fields.push({label: "Account", name: "Account__c", type: "Master-Detail"});
  p.object.sharingModel = "ControlledByParent";
  const errs = validateProposal(p);
  assert.ok(errs.some(e => /MasterDetail requires 'relatedTo'/.test(e)), errs.join("|"));
});

test("validateProposal rejects long and malformed API names", () => {
  const p = baseProposal();
  p.object.name = "X".repeat(41) + "__c";
  p.fields[0].name = "Bad__Name__c";
  const errs = validateProposal(p);
  assert.ok(errs.some(e => /Object API name is 41 characters/.test(e)), errs.join("|"));
  assert.ok(errs.some(e => /Field 1 API name must not contain "__"/.test(e)), errs.join("|"));
});

test("validateProposal checks AutoNumber format placeholder", () => {
  const p = baseProposal();
  p.object.nameField = {label: "No", type: "AutoNumber", format: "INV-"};
  assert.ok(validateProposal(p).some(e => /placeholder/.test(e)));
  p.object.nameField.format = "INV-{0000}";
  assert.deepEqual(validateProposal(p), []);
});

test("sharing model rules", () => {
  const p = baseProposal();
  p.object.sharingModel = "FullAccess";
  assert.ok(validateSharingModel(p).length === 1);
  p.object.sharingModel = "ReadWriteTransfer";
  assert.ok(validateSharingModel(p).length === 1);
  p.object.sharingModel = "Private";
  assert.deepEqual(validateSharingModel(p), []);
  p.fields.push({label: "Acc", name: "Acc__c", type: "MasterDetail", relatedTo: "Account"});
  assert.ok(validateSharingModel(p).some(e => /ControlledByParent/.test(e)));
  assert.equal(resolveSharingModel(p), "ControlledByParent");
  p.fields.pop();
  p.object.sharingModel = "ControlledByParent";
  assert.ok(validateSharingModel(p).some(e => /requires a Master-Detail/.test(e)));
  assert.equal(resolveSharingModel(p), "ReadWrite");
});

test("normalizeProposal canonicalizes types and forces ControlledByParent", () => {
  const p = baseProposal();
  p.fields.push({label: "Acc", name: "Acc__c", type: "Master-Detail", relatedTo: "Account"});
  p.fields.push({label: "When", name: "When__c", type: "Date/Time"});
  const n = normalizeProposal(p);
  assert.equal(n.fields[1].type, "MasterDetail");
  assert.equal(n.fields[2].type, "DateTime");
  assert.equal(n.object.sharingModel, "ControlledByParent");
  assert.equal(p.fields[1].type, "Master-Detail", "input not mutated");
  assert.deepEqual(validateProposal(n), []);
  const bad = normalizeProposal({...baseProposal(), object: {...baseProposal().object, sharingModel: "FullAccess"}});
  assert.equal(bad.object.sharingModel, "FullAccess");
  const pub = normalizeProposal({...baseProposal(), object: {...baseProposal().object, sharingModel: "Public Read/Write"}});
  assert.equal(pub.object.sharingModel, "ReadWrite");
});

test("parseJSONFromText handles plain, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(parseJSONFromText("{\"a\":1}"), {a: 1});
  assert.deepEqual(parseJSONFromText("```json\n{\"a\":1}\n```"), {a: 1});
  assert.deepEqual(parseJSONFromText("```\n{\"a\":1}\n```"), {a: 1});
  assert.deepEqual(parseJSONFromText("Here you go:\n{\"a\": {\"b\": 2}}\nHope this helps {not json}"), {a: {b: 2}});
});

test("parseJSONFromText takes the first balanced object, not first-to-last brace", () => {
  const text = "{\"a\":1} and also {\"b\":2}";
  assert.deepEqual(parseJSONFromText(text), {a: 1});
});

test("parseJSONFromText ignores braces inside strings", () => {
  const text = "Result: {\"format\": \"PT-{00000}\", \"note\": \"close } brace and \\\" quote {\"} trailing }";
  assert.deepEqual(parseJSONFromText(text), {format: "PT-{00000}", note: "close } brace and \" quote {"});
});

test("parseJSONFromText tolerates trailing commas", () => {
  const text = "{\"fields\": [{\"name\": \"A__c\",}, {\"name\": \"B, ]__c\",},],}";
  assert.deepEqual(parseJSONFromText(text), {fields: [{name: "A__c"}, {name: "B, ]__c"}]});
  assert.equal(stripTrailingCommas("{\"a\": \"x,}\",}"), "{\"a\": \"x,}\"}");
});

test("parseJSONFromText skips a broken leading object", () => {
  assert.deepEqual(parseJSONFromText("{oops} then {\"ok\": true}"), {ok: true});
});

test("parseJSONFromText returns null for invalid input", () => {
  assert.equal(parseJSONFromText("no json here"), null);
  assert.equal(parseJSONFromText("{\"a\": 1"), null);
  assert.equal(parseJSONFromText("[1,2,3]"), null);
  assert.equal(parseJSONFromText(""), null);
  assert.equal(parseJSONFromText(null), null);
});

test("escapeSoqlString escapes quotes and backslashes", () => {
  assert.equal(escapeSoqlString("O'Brien\\x"), "O\\'Brien\\\\x");
});

test("isNonTransientDeployError classifies errors", () => {
  assert.equal(isNonTransientDeployError(new Error("Unsupported field type: Formula")), true);
  assert.equal(isNonTransientDeployError(Object.assign(new Error("bad"), {statusCode: "FIELD_INTEGRITY_EXCEPTION"})), true);
  assert.equal(isNonTransientDeployError(Object.assign(new Error("x"), {nonTransient: true})), true);
  assert.equal(isNonTransientDeployError(new Error("Request timed out after 60s (createMetadata)")), false);
  assert.equal(isNonTransientDeployError(new Error("no CustomObject named Foo__c found")), false);
});
