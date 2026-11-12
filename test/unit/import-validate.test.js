import {test} from "node:test";
import assert from "node:assert/strict";
import {ffValidateImport, ffNormalizeImportValue, ffBuildBulkCsv} from "../../addon/inspector/shared/import-map.js";

const fields = [
  {name: "Id", type: "id", nillable: false, defaultedOnCreate: true},
  {name: "Name", type: "string", nillable: false, createable: true},
  {name: "Active__c", type: "boolean"},
  {name: "Amount__c", type: "currency"},
  {name: "When__c", type: "datetime"}
];
const errors = v => v.issues.filter(x => x.severity === "error");

test("values the validator accepts are normalised to what Salesforce accepts", () => {
  for (const v of ["yes", "Y", "on", "1", "TRUE"]) assert.equal(ffNormalizeImportValue(v, "boolean"), "true");
  for (const v of ["no", "n", "OFF", "0", "false"]) assert.equal(ffNormalizeImportValue(v, "boolean"), "false");
  assert.equal(ffNormalizeImportValue("1,234.56", "currency"), "1234.56");
  assert.equal(ffNormalizeImportValue("1,000", "int"), "1000");
  assert.equal(ffNormalizeImportValue("42", "double"), "42");
  assert.equal(ffNormalizeImportValue("2026-01-31 10:00", "datetime"), "2026-01-31T10:00:00");
  assert.equal(ffNormalizeImportValue("2026-01-31 9:05:07Z", "datetime"), "2026-01-31T09:05:07Z");
  assert.equal(ffNormalizeImportValue("2026-01-31T10:00:00.000+05:30", "datetime"), "2026-01-31T10:00:00.000+05:30");
});

test("normalisation leaves other types and invalid values alone", () => {
  assert.equal(ffNormalizeImportValue("1,234", "string"), "1,234");
  assert.equal(ffNormalizeImportValue("yes", "picklist"), "yes");
  assert.equal(ffNormalizeImportValue("maybe", "boolean"), "maybe");
  assert.equal(ffNormalizeImportValue("12,x", "int"), "12,x");
  assert.equal(ffNormalizeImportValue("tomorrow", "datetime"), "tomorrow");
  assert.equal(ffNormalizeImportValue("0015g00000ABCDE", "id"), "0015g00000ABCDE");
});

test("every lenient value that passes validation normalises to a strict one", () => {
  const records = [{N: "x", A: "yes", M: "1,234.56", W: "2026-01-31 10:00"}];
  const fieldMap = {N: "Name", A: "Active__c", M: "Amount__c", W: "When__c"};
  const v = ffValidateImport({headers: ["N", "A", "M", "W"], records, fieldMap, fields, operation: "insert"});
  assert.equal(v.hardErrors, 0);
  assert.match(ffNormalizeImportValue("yes", "boolean"), /^(true|false)$/);
  assert.ok(!isNaN(Number(ffNormalizeImportValue("1,234.56", "currency"))));
});

test("update, delete and hardDelete all require an Id mapping", () => {
  for (const operation of ["update", "delete", "hardDelete"]) {
    const v = ffValidateImport({headers: ["N"], records: [{N: "x"}], fieldMap: {N: "Name"}, fields, operation});
    assert.ok(errors(v).some(x => x.field === "Id"), operation);
  }
  const v = ffValidateImport({headers: ["I"], records: [{I: "001000000000001"}], fieldMap: {I: "Id"}, fields, operation: "hardDelete"});
  assert.equal(v.hardErrors, 0);
  assert.match(ffValidateImport({headers: [], records: [], fieldMap: {}, fields, operation: "hardDelete"}).issues[0].problem, /^Hard Delete requires/);
});

test("a non-createable field is not required on insert (person-account Name)", () => {
  const personFields = [
    {name: "Name", type: "string", nillable: false, createable: false},
    {name: "LastName", type: "string", nillable: true, createable: true}
  ];
  const v = ffValidateImport({headers: ["L"], records: [{L: "Doe"}], fieldMap: {L: "LastName"}, fields: personFields, operation: "insert"});
  assert.equal(v.issues.length, 0);
});

test("missing required fields block insert but only warn on upsert", () => {
  const base = {headers: ["A"], records: [{A: "true"}], fieldMap: {A: "Active__c"}, fields};
  const ins = ffValidateImport({...base, operation: "insert"});
  assert.ok(errors(ins).some(x => x.field === "Name"));
  const ups = ffValidateImport({...base, operation: "upsert", externalId: "Id"});
  assert.equal(ups.hardErrors, 0);
  assert.ok(ups.issues.some(x => x.field === "Name" && x.severity === "warn"));
});

test("a blank required cell is an error on insert and a warning on upsert", () => {
  const base = {headers: ["N"], records: [{N: " "}], fieldMap: {N: "Name"}, fields};
  const ins = ffValidateImport({...base, operation: "insert"});
  assert.equal(ins.errorRows, 1);
  const ups = ffValidateImport({...base, operation: "upsert", externalId: "Id"});
  assert.equal(ups.errorRows, 0);
  assert.equal(ups.warnRows, 1);
});

const row = (index, body, idVal = null) => ({index, body, idVal, extVal: null, hasValue: true});

test("Bulk CSV for delete and hardDelete carries the Id column only", () => {
  const rows = [row(0, {Id: "001A", Name: "Acme"}, "001A"), row(1, {Name: "no id"}), row(2, {Id: "001B"}, "001B")];
  for (const operation of ["delete", "hardDelete"]) {
    assert.equal(ffBuildBulkCsv(rows, ["Id", "Name"], {operation, lineEnding: "\n"}), "Id\n001A\n001B");
  }
});

test("Bulk CSV writes #N/A for explicitly blanked cells and leaves skipped cells empty", () => {
  const rows = [
    row(0, {Id: "001A", Name: "Acme, Inc", Phone: null}, "001A"),
    row(1, {Id: "001B", Name: 'Say "hi"'}, "001B"),
    row(2, {Id: null, Name: null})
  ];
  assert.equal(ffBuildBulkCsv(rows, ["Id", "Name", "Phone"], {operation: "update"}),
    'Id,Name,Phone\r\n001A,"Acme, Inc",#N/A\r\n001B,"Say ""hi""",\r\n,#N/A,');
});
