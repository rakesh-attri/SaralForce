import {test} from "node:test";
import assert from "node:assert/strict";
import {analyzeFailures, classifyProblem, normalizeProblem, groupText, failuresPromptText} from "../../addon/core/deploy-errors.js";
import {failuresForPrompt} from "../../addon/core/deploy.js";

const fail = (type, fullName, problem, line = null) => ({type, fullName, problem, line});
const APEX = "Unable to find Apex action class referenced as 'NxtPay_AccountPaymentController'.";

// Shaped like the NexTurn validation: one LWC × 100, a site user, a PSG
// whose permission set failed too, an unknown message twice.
const summary = {
  componentFailures: [
    ...Array.from({length: 100}, () => fail("LightningComponentBundle", "nxtPay_TouchNetPaymentPage", APEX)),
    fail("CustomSite", "Student_Portal", "In field: siteAdmin - no User named narendar.r_q3fap8svjx@nexturn.com found"),
    fail("PermissionSet", "Student_Access", "In field: field - no CustomField named Student__c.Grade__c found"),
    fail("PermissionSetGroup", "Student", "Cannot create Permission Set Group Components since the following permission sets are not found: Student_Access"),
    fail("Layout", "Account-Account Layout", "Weird thing 123 happened to 'X'"),
    fail("Layout", "Case-Case Layout", "Weird thing 456 happened to 'Y'")
  ],
  testFailures: [], coverageWarnings: []
};

test("100 identical errors are one root cause, and the class can be added", () => {
  const a = analyzeFailures(summary, {deployKeys: ["LightningComponentBundle:nxtPay_TouchNetPaymentPage"], sourceKeys: ["ApexClass:NxtPay_AccountPaymentController"]});
  assert.equal(a.total, 105);
  const top = a.groups[0];
  assert.equal(top.title, "Missing Apex class NxtPay_AccountPaymentController");
  assert.equal(top.count, 100);
  assert.equal(top.components.length, 1);
  assert.equal(top.components[0].count, 100);
  assert.equal(top.category, "missing");
  assert.equal(top.refStatus, "addable");
  assert.equal(top.addKey, "ApexClass:NxtPay_AccountPaymentController");
});

test("a sandbox username on a site is a missing user, with the field named", () => {
  const c = classifyProblem("In field: siteAdmin - no User named narendar.r_q3fap8svjx@nexturn.com found");
  assert.equal(c.category, "reference");
  assert.deepEqual(c.ref, {type: "User", name: "narendar.r_q3fap8svjx@nexturn.com", field: "siteAdmin"});
  assert.match(c.title, /User narendar\.r_q3fap8svjx@nexturn\.com doesn't exist in the target/);
  assert.match(c.why, /siteAdmin/);
  assert.match(c.fix, /siteAdmin/);
});

test("a permission set group that fails because its permission set failed is a knock-on", () => {
  const a = analyzeFailures(summary);
  const ps = a.groups.find(g => g.components.some(c => c.fullName === "Student_Access"));
  assert.ok(ps, "permission set group is a root");
  assert.equal(ps.children.length, 1);
  assert.equal(ps.children[0].components[0].fullName, "Student");
  assert.ok(!a.groups.some(g => g.components.some(c => c.fullName === "Student")), "not a root itself");
  assert.equal(ps.total, 2);
  assert.match(groupText(ps), /also fails because of this/);
});

test("unknown messages group by their shape", () => {
  assert.equal(normalizeProblem("Weird thing 123 happened to 'X'"), normalizeProblem("Weird thing 456 happened to 'Y'"));
  const a = analyzeFailures(summary);
  const other = a.groups.find(g => g.rule === "other");
  assert.equal(other.count, 2);
  assert.equal(other.components.length, 2);
});

test("compile errors group per class; locks and duplicates are recognised", () => {
  assert.equal(classifyProblem("Unexpected token 'public'.").category, "compile");
  assert.equal(classifyProblem("UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record").id, "locked");
  assert.equal(classifyProblem("An object 'X' of type ApexClass was named in package.xml, but was not found in zipped directory").id, "not-in-zip");
  assert.equal(classifyProblem("Entity of type 'ApexClass' named 'InvoiceTax' cannot be found").ref.name, "InvoiceTax");
  const a = analyzeFailures({componentFailures: [
    fail("ApexClass", "A", "Unexpected token 'x'.", 3), fail("ApexClass", "A", "Missing ';' at 'y'", 9), fail("ApexClass", "B", "Unexpected token 'z'.", 1)
  ]});
  assert.deepEqual(a.groups.map(g => g.count).sort(), [1, 2]);
});

test("the grouped AI prompt is far shorter than the raw list", () => {
  const raw = failuresForPrompt(summary, {max: 200});
  const grouped = failuresPromptText(summary);
  assert.ok(grouped.length < raw.length / 2, `${grouped.length} vs ${raw.length}`);
  assert.match(grouped, /root cause/);
  assert.match(grouped, /Missing Apex class NxtPay_AccountPaymentController · 100 error/);
});

test("Salesforce's 'Page X does not exist' and 'The X External Credential doesn't exist.' are missing items", () => {
  const page = classifyProblem("Page NxtPay_PaymentResult does not exist");
  assert.equal(page.category, "missing");
  assert.deepEqual(page.ref, {type: "ApexPage", name: "NxtPay_PaymentResult"});
  assert.match(page.title, /^Missing .* NxtPay_PaymentResult$/);
  assert.match(page.why, /Visualforce page/);
  const ec = classifyProblem("The NxtPay_Stripe_External_Credential External Credential doesn't exist.");
  assert.equal(ec.category, "missing");
  assert.deepEqual({type: ec.ref.type, name: ec.ref.name}, {type: "ExternalCredential", name: "NxtPay_Stripe_External_Credential"});
  assert.ok(ec.fix);
  // The page is in the source and not selected: it can be added.
  const a = analyzeFailures({componentFailures: Array.from({length: 100}, (_, i) => fail("ApexClass", "C" + i, "Page NxtPay_PaymentResult does not exist"))},
    {sourceKeys: ["ApexPage:NxtPay_PaymentResult"]});
  assert.equal(a.groups.length, 1);
  assert.equal(a.groups[0].addKey, "ApexPage:NxtPay_PaymentResult");
  // Unknown messages still get a why and a fix.
  const other = classifyProblem("Something entirely new happened");
  assert.equal(other.category, "other");
  assert.ok(other.why && other.fix);
});
