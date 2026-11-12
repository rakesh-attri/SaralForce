import {test} from "node:test";
import assert from "node:assert/strict";
import {groupRefs, codeMentions, impactVerdict, impactForPrompt, flowDeleteReport} from "../../addon/core/impact.js";

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

test("flow delete report: what blocks it and what is clear", () => {
  const base = {found: true, versions: [{number: 1, status: "Obsolete"}], active: 0, interviews: [], interviewsGuessed: false, usedBy: [], notes: []};
  const r = flowDeleteReport([
    {...base, name: "Gone", found: false, versions: []},
    {...base, name: "Paused", interviews: [{label: "Paused 10/11", status: "Paused"}]},
    {...base, name: "Called", usedBy: [{type: "Flow", name: "Parent_Flow"}]},
    {...base, name: "Active", active: 2},
    {...base, name: "Old_Routing", notes: ["Could not check what uses it: x"]}
  ]);
  assert.deepEqual(r.blocked, ["Paused", "Called", "Active"]);
  assert.deepEqual(r.clear, ["Old_Routing"]);
  assert.match(r.text, /Gone: not in the target/);
  assert.match(r.text, /Paused \[1 version\(s\): v1 Obsolete\]: 1 paused or waiting run/);
  assert.match(r.text, /used by Flow Parent_Flow/);
  assert.match(r.text, /version 2 is active/);
  assert.match(r.text, /Old_Routing.*nothing found blocking it[\s\S]*Could not check what uses it/);
});

test("a failed or capped search is never a clean pass", () => {
  const partial = impactVerdict({unchecked: ["Could not search Apex classes (boom)."]});
  assert.equal(partial.level, "warn");
  assert.match(partial.title, /Partial result/);
  assert.match(partial.reasons.join(" "), /Could not search Apex classes/);
  assert.equal(impactVerdict({unchecked: []}).level, "safe");
  const blocked = impactVerdict({activeFlows: ["F"], unchecked: ["Only the first 2,000 Apex classes were searched; the org has more."]});
  assert.equal(blocked.level, "block");
  assert.match(blocked.reasons.join(" "), /Partial result: Only the first 2,000/);
});
