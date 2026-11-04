import {test} from "node:test";
import assert from "node:assert/strict";
import {draftPackage, draftTestOptions, compileErrorText} from "../../addon/core/draft-package.js";

test("an Apex draft with its test becomes one package", () => {
  const p = draftPackage({kind: "apex", name: "EmailService", form: {apiVersion: "66"}, files: [
    {path: "classes/EmailService.cls", content: "public class EmailService {}"},
    {path: "classes/EmailServiceTest.cls", role: "extra", name: "EmailServiceTest", content: "@isTest class EmailServiceTest {}"}]}, "67.0");
  const paths = p.entries.map(e => e[0]);
  assert.deepEqual(paths, ["classes/EmailService.cls", "classes/EmailService.cls-meta.xml", "classes/EmailServiceTest.cls", "classes/EmailServiceTest.cls-meta.xml", "package.xml"]);
  assert.match(p.entries[1][1], /<apiVersion>66\.0<\/apiVersion>/);
  assert.deepEqual(p.tests, ["EmailServiceTest"]);
  assert.match(p.entries.at(-1)[1], /<members>EmailService<\/members>[\s\S]*<members>EmailServiceTest<\/members>/);
});

test("trigger, page, LWC and Aura packages", () => {
  const t = draftPackage({kind: "triggers", name: "AccTrg", form: {object: "Account"}, files: [
    {path: "triggers/AccTrg.trigger", content: "trigger AccTrg on Account (before insert) {}"},
    {path: "classes/AccHandler.cls", role: "handler", name: "AccHandler", content: "public class AccHandler {}"}]}, "67.0");
  assert.ok(t.entries.some(e => e[0] === "triggers/AccTrg.trigger-meta.xml"));
  assert.deepEqual(Object.keys(t.members).sort(), ["ApexClass", "ApexTrigger"]);
  const pg = draftPackage({kind: "pages", name: "Pg", form: {label: "My <Page>"}, files: [{path: "pages/Pg.page", content: "<apex:page/>"}]}, "67.0");
  assert.match(pg.entries.find(e => e[0] === "pages/Pg.page-meta.xml")[1], /My &lt;Page&gt;/);
  const lwc = draftPackage({kind: "lwc", name: "card", form: {}, files: [
    {path: "lwc/card/card.js", content: "x"}, {path: "lwc/card/card.html", content: "<template></template>"},
    {path: "lwc/card/card.js-meta.xml", content: "<LightningComponentBundle/>", generated: true},
    {path: "classes/CardCtrl.cls", role: "apex", name: "CardCtrl", content: "public class CardCtrl {}"}]}, "67.0");
  assert.equal(lwc.entries.filter(e => e[0].startsWith("lwc/card/")).length, 3);
  assert.deepEqual(lwc.members.LightningComponentBundle, ["card"]);
  const aura = draftPackage({kind: "aura", name: "Sum", form: {description: "d"}, files: [
    {path: "aura/Sum/Sum.cmp", content: "<aura:component/>"}, {path: "aura/Sum/SumController.js", content: "({})"}]}, "67.0");
  assert.ok(aura.entries.some(e => e[0] === "aura/Sum/Sum.cmp-meta.xml"));
});

test("test options and error text", () => {
  assert.deepEqual(draftTestOptions({isSandbox: true, hasApex: true, tests: ["T"]}), {testLevel: "NoTestRun", runTests: []});
  assert.deepEqual(draftTestOptions({isSandbox: false, hasApex: true, tests: ["T"]}), {testLevel: "RunSpecifiedTests", runTests: ["T"]});
  assert.equal(draftTestOptions({isSandbox: false, hasApex: true, tests: []}).testLevel, "RunLocalTests");
  const text = compileErrorText({componentFailures: [{fileName: "classes/EmailServiceTest.cls", line: 12, column: 5, problem: "Method does not exist"}],
    testFailures: [{className: "T", method: "m", message: "boom"}]});
  assert.equal(text, "EmailServiceTest.cls line 12:5: Method does not exist\nTest T.m failed: boom");
});
