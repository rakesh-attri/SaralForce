import test from "node:test";
import assert from "node:assert/strict";
import {myDomainLabel, sameOrgDomain} from "../../addon/core/sf-host.js";

test("My Domain label of every Salesforce host shape", () => {
  for (const h of ["acme.my.salesforce.com", "acme.lightning.force.com", "acme--c.vf.force.com", "acme--ns.vf.force.com",
    "acme.my.salesforce-setup.com", "acme--c.documentforce.com", "acme.my.salesforce.com.mcas.ms", ".acme.my.salesforce.com"]) {
    assert.equal(myDomainLabel(h), "acme", h);
  }
  for (const h of ["acme--uat.sandbox.my.salesforce.com", "acme--uat.sandbox.lightning.force.com", "acme--uat--c.sandbox.vf.force.com"]) {
    assert.equal(myDomainLabel(h), "acme--uat", h);
  }
  for (const h of ["na123.salesforce.com", "c.na1.visual.force.com", "login.salesforce.com", "help.salesforce.com", "evil.example.com", "", null]) {
    assert.equal(myDomainLabel(h), null, String(h));
  }
});

test("same org only when the My Domain names match", () => {
  assert.equal(sameOrgDomain("acme.lightning.force.com", "acme.my.salesforce.com"), true);
  assert.equal(sameOrgDomain("acme--c.vf.force.com", "acme.my.salesforce.com"), true);
  assert.equal(sameOrgDomain("acme--uat.sandbox.lightning.force.com", "acme--uat.sandbox.my.salesforce.com"), true);
  // An attacker page on another org's domain never matches the victim's session domain.
  assert.equal(sameOrgDomain("evil--c.vf.force.com", "acme.my.salesforce.com"), false);
  assert.equal(sameOrgDomain("acme--uat.sandbox.my.salesforce.com", "acme.my.salesforce.com"), false);
  assert.equal(sameOrgDomain("na1.salesforce.com", "na1.salesforce.com"), false);
});

test("Markdown exports: AI text cannot add links or HTML", async () => {
  const {guideToMarkdown} = await import("../../addon/core/org-guide.js");
  const md = guideToMarkdown({title: "T", orgName: "Acme", builtAt: Date.now(), business: "We **sell** [click](https://evil.test) <img src=x>",
    maps: null, areas: [], sections: [], glossary: [], notes: ["note [x](y)"]});
  const bs = String.fromCharCode(92);
  assert.ok(md.includes(`We **sell** ${bs}[click${bs}](https://evil.test) ${bs}<img src=x${bs}>`), md);
  assert.ok(md.includes(`> note ${bs}[x${bs}](y)`));
});

test("SOQL string escape handles backslashes before quotes", async () => {
  const {escapeSoqlString} = await import("../../addon/core/soql.js");
  const bs = String.fromCharCode(92);
  // a\' OR Name != '   →   a\\\' OR Name != \'
  assert.equal(escapeSoqlString(`a${bs}' OR Name != '`), `a${bs}${bs}${bs}' OR Name != ${bs}'`);
});
