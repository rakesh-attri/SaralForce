import {test} from "node:test";
import assert from "node:assert/strict";
import {groupRefs, codeMentions, impactVerdict, impactForPrompt} from "../../addon/core/impact.js";

const used = groupRefs([
  {MetadataComponentId: "1", MetadataComponentName: "InvoiceService", MetadataComponentType: "ApexClass"},
  {MetadataComponentId: "2", MetadataComponentName: "Other", MetadataComponentType: "ApexClass"},
  {MetadataComponentId: "3", MetadataComponentName: "Approve", MetadataComponentType: "Flow"},
  {MetadataComponentId: "1", MetadataComponentName: "InvoiceService", MetadataComponentType: "ApexClass"}
], "usedBy");

test("dependencies group by type, biggest first, without duplicates", () => {
  assert.equal(used[0].type, "ApexClass");
  assert.equal(used[0].items.length, 2);
  assert.equal(used[1].label, "Flow");
});

test("code mentions skip comments and partial names", () => {
  const code = "// Amount__c old\n/* Amount__c */ x.Amount__c = 1; y.Total_Amount__c = 2; z.amount__c++;";
  assert.equal(codeMentions(code, "Amount__c"), 2);
  assert.equal(codeMentions("", "X"), 0);
});

test("verdicts: block on data or active flows, warn on references, safe otherwise", () => {
  assert.equal(impactVerdict({usedBy: used, dataCount: 0, activeFlows: ["Approve"]}).level, "block");
  assert.equal(impactVerdict({usedBy: [], dataCount: 12}).level, "block");
  assert.equal(impactVerdict({usedBy: [], dataCount: 12, forDelete: false}).level, "safe");
  const w = impactVerdict({usedBy: used, codeMatches: [{type: "ApexPage", name: "P"}], dataCount: 0});
  assert.equal(w.level, "warn");
  assert.equal(w.title, "Used in 4 place(s)");
  const s = impactVerdict({usedBy: [], dataCount: 0});
  assert.equal(s.level, "safe");
  assert.match(s.reasons[0], /no data/);
  assert.match(impactForPrompt({type: "CustomField", name: "A.B__c", org: "UAT", usedBy: used, uses: [], codeMatches: [], dataCount: 3, activeFlows: [], verdict: w}), /ApexClass InvoiceService/);
});
