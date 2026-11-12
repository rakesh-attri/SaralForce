import {test} from "node:test";
import assert from "node:assert/strict";
import {componentsFromZip, compKey, componentText} from "../../addon/core/deploy.js";
import {textToBytes, bytesToText} from "../../addon/core/zip.js";
import {toSourceFiles, componentsFromSource, sourceToMdapi} from "../../addon/core/source-format.js";

const OBJ = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fields>
        <fullName>Amount__c</fullName>
        <type>Currency</type>
    </fields>
    <label>Invoice</label>
    <validationRules>
        <fullName>Positive</fullName>
        <active>true</active>
    </validationRules>
</CustomObject>`;

const zipFiles = new Map([
  ["objects/Invoice__c.object", textToBytes(OBJ)],
  ["classes/A.cls", textToBytes("public class A {}")], ["classes/A.cls-meta.xml", textToBytes("<ApexClass/>")],
  ["layouts/Invoice__c-Main.layout", textToBytes("<Layout><x/></Layout>")],
  ["lwc/card/card.js", textToBytes("export default class {}")], ["lwc/card/card.js-meta.xml", textToBytes("<LightningComponentBundle/>")],
  ["staticresources/logo.resource", new Uint8Array([1, 2, 3, 250])], ["staticresources/logo.resource-meta.xml", textToBytes("<StaticResource/>")],
  ["labels/CustomLabels.labels", textToBytes("<CustomLabels><labels><fullName>Hello</fullName><value>Hi</value></labels></CustomLabels>")]
]);

test("mdapi → source format paths", () => {
  const src = toSourceFiles(componentsFromZip(zipFiles, bytesToText), "force-app/main/default");
  const paths = [...src.keys()].sort();
  for (const p of [
    "force-app/main/default/classes/A.cls", "force-app/main/default/classes/A.cls-meta.xml",
    "force-app/main/default/layouts/Invoice__c-Main.layout-meta.xml",
    "force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml",
    "force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml",
    "force-app/main/default/objects/Invoice__c/validationRules/Positive.validationRule-meta.xml",
    "force-app/main/default/lwc/card/card.js", "force-app/main/default/staticresources/logo.resource",
    "force-app/main/default/labels/CustomLabels.labels-meta.xml"
  ]) assert.ok(paths.includes(p), p);
  assert.match(src.get("force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml"), /^<\?xml[\s\S]*<CustomField xmlns=[\s\S]*<type>Currency<\/type>[\s\S]*<\/CustomField>/);
  assert.deepEqual([...src.get("force-app/main/default/staticresources/logo.resource")], [1, 2, 3, 250]);
});

test("source → components round-trips content", () => {
  const before = componentsFromZip(zipFiles, bytesToText);
  const src = toSourceFiles(before, "");
  const bytes = new Map([...src.entries()].map(([p, v]) => [p, typeof v === "string" ? textToBytes(v) : v]));
  const after = componentsFromSource(bytes, bytesToText);
  for (const key of [compKey("ApexClass", "A"), compKey("CustomField", "Invoice__c.Amount__c"), compKey("ValidationRule", "Invoice__c.Positive"),
    compKey("CustomObject", "Invoice__c"), compKey("Layout", "Invoice__c-Main"), compKey("LightningComponentBundle", "card"), compKey("CustomLabel", "Hello")]) {
    assert.ok(after.has(key), key);
    assert.equal(componentText(after.get(key)).replace(/\s+/g, ""), componentText(before.get(key)).replace(/\s+/g, ""), key);
  }
  assert.ok(sourceToMdapi(bytes, bytesToText).has("layouts/Invoice__c-Main.layout"));
});

test("DX static resources and folders map back to the Metadata API", async () => {
  const {readZip} = await import("../../addon/core/zip.js");
  const {sourcePathType} = await import("../../addon/core/source-format.js");
  const files = new Map([
    ["staticresources/logo.png", new Uint8Array([9, 9])],
    ["staticresources/logo.resource-meta.xml", textToBytes("<StaticResource/>")],
    ["staticresources/lib/js/a.js", textToBytes("var a;")],
    ["staticresources/lib.resource-meta.xml", textToBytes("<StaticResource/>")],
    ["reports/Sales.reportFolder-meta.xml", textToBytes("<ReportFolder/>")]
  ]);
  const md = sourceToMdapi(files, bytesToText);
  assert.deepEqual([...md.get("staticresources/logo.resource")], [9, 9]);
  const inner = await readZip(md.get("staticresources/lib.resource"));
  assert.equal(bytesToText(inner.get("js/a.js")), "var a;");
  assert.ok(md.has("reports/Sales-meta.xml"));
  const comps = componentsFromSource(files, bytesToText);
  assert.ok(comps.has("StaticResource:logo") && comps.has("StaticResource:lib") && comps.has("Report:Sales"));
  // And back to DX for a folder.
  assert.ok([...toSourceFiles(comps, "").keys()].includes("reports/Sales.reportFolder-meta.xml"));
  assert.deepEqual(sourcePathType("objects/Inv__c/fields/A__c.field-meta.xml"), {type: "CustomField", fullName: "Inv__c.A__c"});
  assert.deepEqual(sourcePathType("classes/A.cls"), {type: "ApexClass", fullName: "A"});
  assert.deepEqual(sourcePathType("layouts/Inv__c-Main.layout-meta.xml"), {type: "Layout", fullName: "Inv__c-Main"});
});

test("Jest tests and editor config are left out of bundles from Git", async () => {
  const {isLocalOnlyFile} = await import("../../addon/core/source-format.js");
  const files = new Map([
    ["lwc/card/card.js", textToBytes("export default class {}")],
    ["lwc/card/card.js-meta.xml", textToBytes("<LightningComponentBundle/>")],
    ["lwc/card/__tests__/card.test.js", textToBytes("test()")],
    ["lwc/card/__tests__/data/mock.json", textToBytes("{}")],
    ["lwc/jsconfig.json", textToBytes("{}")],
    ["lwc/.eslintrc.json", textToBytes("{}")],
    ["aura/.eslintrc.json", textToBytes("{}")],
    ["staticresources/lib/__tests__/a.js", textToBytes("var a;")],
    ["staticresources/lib.resource-meta.xml", textToBytes("<StaticResource/>")]
  ]);
  const md = sourceToMdapi(files, bytesToText);
  assert.deepEqual([...md.keys()].filter(p => p.startsWith("lwc/") || p.startsWith("aura/")).sort(), ["lwc/card/card.js", "lwc/card/card.js-meta.xml"]);
  const comps = componentsFromSource(files, bytesToText);
  assert.deepEqual([...comps.keys()].filter(k => k.startsWith("LightningComponentBundle")), ["LightningComponentBundle:card"]);
  // A static resource may hold any file.
  assert.ok(!isLocalOnlyFile("staticresources/lib/__tests__/a.js"));
  assert.ok(md.has("staticresources/lib.resource"));
});
