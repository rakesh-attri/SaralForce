import {test} from "node:test";
import assert from "node:assert/strict";
import {qualityFields, qualityQuery, profileFields, duplicateGroups, qualityIssues, qualityForPrompt} from "../../addon/core/data-quality.js";

const describe = {
  name: "Lead",
  fields: [
    {name: "Id", type: "id"},
    {name: "Name", label: "Name", type: "string", nillable: false},
    {name: "Email", label: "Email", type: "email"},
    {name: "Score__c", label: "Score", type: "double", custom: true},
    {name: "Unused__c", label: "Unused", type: "string", custom: true},
    {name: "Stage__c", label: "Stage", type: "picklist", custom: true, picklistValues: [{value: "New", active: true}, {value: "Old", active: false}]},
    {name: "Address", type: "address"},
    {name: "CreatedDate", label: "Created", type: "datetime"},
    {name: "SystemModstamp", type: "datetime"}
  ]
};

const records = Array.from({length: 12}, (_, i) => ({
  Id: "00Q" + i, Name: i < 3 ? "Acme Corp" : "Lead " + i, Email: i % 2 ? `l${i}@x.test` : null,
  Score__c: i === 11 ? 100000 : 10 + i, Unused__c: null, Stage__c: i === 0 ? "Old" : "New", CreatedDate: "2026-01-01"
}));

test("qualityFields skips compound and audit fields, custom first", () => {
  const f = qualityFields(describe);
  assert.equal(f[0], "Id");
  assert.ok(!f.includes("Address") && !f.includes("SystemModstamp"));
  assert.deepEqual(f.slice(1, 4), ["Score__c", "Unused__c", "Stage__c"]);
  assert.match(qualityQuery(describe, f, 500), /FROM Lead ORDER BY CreatedDate DESC LIMIT 500$/);
});

test("profileFields measures fill, outliers and invalid picklist values", () => {
  const p = profileFields(records, describe, ["Id", "Email", "Score__c", "Unused__c", "Stage__c"]);
  const by = Object.fromEntries(p.map(x => [x.name, x]));
  assert.equal(by.Email.fillPct, 50);
  assert.equal(by.Unused__c.filled, 0);
  assert.equal(by.Score__c.outliers, 1);
  assert.equal(by.Stage__c.invalid, 1);
  assert.equal(by.Stage__c.top.value, "New");
});

test("duplicateGroups and qualityIssues flag problems worst first", () => {
  const dups = duplicateGroups(records, ["Id", "Name", "Email"]);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].ids.length, 3);
  const p = profileFields(records, describe, ["Id", "Name", "Email", "Score__c", "Unused__c", "Stage__c"]);
  const res = qualityIssues(p, dups, records.length);
  assert.equal(res.issues[0].level, "warn");
  assert.ok(res.issues.some(i => /Unused is never filled/.test(i.text)));
  assert.ok(res.issues.some(i => /3 records share Name/.test(i.text)));
  assert.ok(res.score > 0 && res.score < 100);
  assert.match(qualityForPrompt("Lead", 12, p, dups, res), /Records sampled: 12[\s\S]*Possible duplicates/);
});
