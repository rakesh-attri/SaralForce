import {test} from "node:test";
import assert from "node:assert/strict";
import {deflateRawSync} from "node:zlib";
import {readZip, writeZip, textToBytes, bytesToText, base64ToBytes, bytesToBase64, crc32} from "../../addon/core/zip.js";
import {diffLines, diffStats, sideBySide} from "../../addon/core/text-diff.js";
import {
  pathToComponent, splitParentFile, componentsFromZip, classifyComponents, compareCounts,
  membersFromKeys, parsePackageXml, mergeMembers, dependencyGaps, allowedTestLevels, defaultTestLevel,
  summarizeDeployResult, normalizeForCompare, chunkMembers, keepListRow, suggestTests, compKey, deployExtraFiles
} from "../../addon/core/deploy.js";

test("zip: write then read round-trips text and binary", async () => {
  const bin = new Uint8Array([0, 1, 2, 250, 255]);
  const zip = writeZip([["package.xml", "<Package/>"], ["classes/Foo.cls", "public class Foo {}"], ["staticresources/x.resource", bin]]);
  const files = await readZip(zip);
  assert.equal(bytesToText(files.get("classes/Foo.cls")), "public class Foo {}");
  assert.deepEqual([...files.get("staticresources/x.resource")], [...bin]);
  assert.equal(files.size, 3);
});

test("zip: reads deflated entries (as Salesforce sends them)", async () => {
  // Hand-built one-entry zip with method 8.
  const data = textToBytes("trigger T on Account (before insert) {}\n".repeat(20));
  const comp = deflateRawSync(data);
  const name = textToBytes("triggers/T.trigger");
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true);
  lv.setUint32(14, crc32(data), true); lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true); local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(data), true); cv.setUint32(20, comp.length, true); cv.setUint32(24, data.length, true);
  cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + comp.length, true);
  const zip = new Uint8Array([...local, ...comp, ...central, ...end]);
  const files = await readZip(zip);
  assert.equal(bytesToText(files.get("triggers/T.trigger")), bytesToText(data));
});

test("base64 round trip", () => {
  const b = new Uint8Array(70000).map((_, i) => i % 256);
  assert.deepEqual([...base64ToBytes(bytesToBase64(b))], [...b]);
});

test("diff: finds changed lines and folds context", () => {
  const rows = diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk");
  assert.deepEqual(diffStats(rows), {added: 2, removed: 1});
  const sbs = sideBySide(rows, {context: 1});
  assert.ok(sbs.some(r => r.fold));
  assert.ok(sbs.some(r => r.kind === "change" && r.left.text === "e" && r.right.text === "E"));
});

test("paths map to components", () => {
  assert.deepEqual(pathToComponent("classes/Foo.cls-meta.xml"), {type: "ApexClass", fullName: "Foo"});
  assert.deepEqual(pathToComponent("lwc/card/card.js"), {type: "LightningComponentBundle", fullName: "card"});
  assert.deepEqual(pathToComponent("email/Sales/Welcome.email"), {type: "EmailTemplate", fullName: "Sales/Welcome"});
  assert.deepEqual(pathToComponent("layouts/Account-Account Layout.layout"), {type: "Layout", fullName: "Account-Account Layout"});
  assert.equal(pathToComponent("package.xml"), null);
});

const OBJ = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <compactLayouts>
        <fullName>Mini</fullName>
        <fields>Name</fields>
    </compactLayouts>
    <fields>
        <fullName>Amount__c</fullName>
        <type>Currency</type>
    </fields>
    <label>Invoice</label>
    <validationRules>
        <fullName>Positive</fullName>
        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
    </validationRules>
</CustomObject>`;

test("object file splits into object, fields and rules", () => {
  const {parentText, children} = splitParentFile("CustomObject", "Invoice__c", OBJ);
  assert.deepEqual(children.map(c => c.type + " " + c.fullName),
    ["CompactLayout Invoice__c.Mini", "CustomField Invoice__c.Amount__c", "ValidationRule Invoice__c.Positive"]);
  assert.match(parentText, /<label>Invoice<\/label>/);
  assert.doesNotMatch(parentText, /Amount__c/);
});

test("compare classifies new, changed, deleted and same", () => {
  const enc = s => textToBytes(s);
  const src = componentsFromZip(new Map([
    ["classes/A.cls", enc("class A {}\n")], ["classes/B.cls", enc("class B { int x; }")],
    ["classes/C.cls", enc("class C {}\r\n")], ["objects/Invoice__c.object", enc(OBJ)]
  ]), bytesToText);
  const tgt = componentsFromZip(new Map([
    ["classes/B.cls", enc("class B { }")], ["classes/C.cls", enc("class C {}\n\n")], ["classes/D.cls", enc("class D {}")]
  ]), bytesToText);
  const rows = classifyComponents(src, tgt);
  const st = Object.fromEntries(rows.map(r => [r.key, r.status]));
  assert.equal(st["ApexClass:A"], "new");
  assert.equal(st["ApexClass:B"], "changed");
  assert.equal(st["ApexClass:C"], "same");
  assert.equal(st["ApexClass:D"], "deleted");
  assert.equal(st["CustomField:Invoice__c.Amount__c"], "new");
  assert.deepEqual(compareCounts(rows), {new: 5, changed: 1, deleted: 1, same: 1});
});

test("normalize ignores package versions and blank lines", () => {
  assert.equal(normalizeForCompare("<a>\n\n  <packageVersions><x/></packageVersions>\n<b/>  \r\n"), "<a>\n  <b/>");
});

test("package.xml parse, merge, members", () => {
  const xml = `<Package><types><members>A</members><members>B</members><name>ApexClass</name></types>
    <types><members>X__c.F__c</members><name>CustomField</name></types><version>67.0</version></Package>`;
  const m = parsePackageXml(xml);
  assert.deepEqual(m, {ApexClass: ["A", "B"], CustomField: ["X__c.F__c"]});
  assert.deepEqual(mergeMembers(m, {ApexClass: ["C", "A"]}).ApexClass, ["A", "B", "C"]);
  assert.deepEqual(membersFromKeys(["ApexClass:Z", "Flow:F", "ApexClass:Y"]), {ApexClass: ["Y", "Z"], Flow: ["F"]});
  assert.equal(chunkMembers({ApexClass: ["a", "b", "c"]}, 2).length, 2);
  assert.ok(deployExtraFiles({ApexClass: ["Old"]}, "67.0")["destructiveChangesPost.xml"].includes("<members>Old</members>"));
  assert.deepEqual(deployExtraFiles({}, "67.0"), {});
});

test("managed components are skipped", () => {
  assert.equal(keepListRow({fullName: "a", manageableState: "installed"}), false);
  assert.equal(keepListRow({fullName: "a", namespacePrefix: "ns"}), false);
  assert.equal(keepListRow({fullName: "a", manageableState: "unmanaged"}), true);
});

test("dependency gaps: object, layout fields, apex references", () => {
  const rows = [
    {key: compKey("CustomObject", "Invoice__c"), type: "CustomObject", fullName: "Invoice__c", status: "new", sourceText: ""},
    {key: compKey("CustomField", "Invoice__c.Amount__c"), type: "CustomField", fullName: "Invoice__c.Amount__c", status: "new", sourceText: ""},
    {key: compKey("Layout", "Invoice__c-Invoice Layout"), type: "Layout", fullName: "Invoice__c-Invoice Layout", status: "new", sourceText: "<field>Amount__c</field>"},
    {key: compKey("ApexClass", "InvoiceService"), type: "ApexClass", fullName: "InvoiceService", status: "changed",
      sourceText: "List<Invoice__c> x = [SELECT Amount__c FROM Invoice__c]; // Old__c"}
  ];
  const gaps = dependencyGaps(rows, new Set([compKey("Layout", "Invoice__c-Invoice Layout"), compKey("ApexClass", "InvoiceService")]));
  assert.deepEqual(gaps.map(g => g.key).sort(), ["CustomField:Invoice__c.Amount__c", "CustomObject:Invoice__c"]);
  assert.deepEqual(dependencyGaps(rows, new Set(rows.map(r => r.key))), []);
});

test("test levels: production never allows NoTestRun", () => {
  assert.ok(!allowedTestLevels(true).some(l => l.id === "NoTestRun"));
  assert.ok(allowedTestLevels(false).some(l => l.id === "NoTestRun"));
  assert.equal(defaultTestLevel(true, true), "RunLocalTests");
  assert.equal(defaultTestLevel(false, true), "NoTestRun");
  assert.deepEqual(suggestTests(["InvoiceService"], [{name: "InvoiceServiceTest", body: "InvoiceService.run();"}, {name: "Other", body: "x"}]), ["InvoiceServiceTest"]);
});

test("deploy result summary: failures, tests, coverage, quick deploy", () => {
  const s = summarizeDeployResult({
    id: "0Af1", done: "true", success: "false", status: "Failed", checkOnly: "true",
    numberComponentsTotal: "3", numberComponentsDeployed: "2", numberComponentErrors: "1",
    numberTestsTotal: "4", numberTestsCompleted: "3", numberTestErrors: "1",
    details: {
      componentFailures: {componentType: "ApexClass", fullName: "A", lineNumber: "4", problem: "Unexpected token"},
      runTestResult: {
        failures: [{name: "ATest", methodName: "t1", message: "Assert failed", stackTrace: "Class.ATest.t1: line 9"}],
        codeCoverage: [{name: "A", numLocations: "10", numLocationsNotCovered: "6"}],
        codeCoverageWarnings: {name: "A", message: "Test coverage of selected Apex Class is 40%"}
      }
    }
  });
  assert.equal(s.componentFailures[0].line, 4);
  assert.equal(s.testFailures[0].className, "ATest");
  assert.equal(s.lowCoverage[0].percent, 40);
  assert.equal(s.coverageWarnings.length, 1);
  assert.equal(s.progress, 100);
  assert.equal(s.canQuickDeploy, false);
  assert.equal(summarizeDeployResult({done: "true", success: "true", status: "Succeeded", checkOnly: "true"}).canQuickDeploy, true);
});

test("deploy entries: only the chosen fields go into the object file", async () => {
  const {buildDeployEntries} = await import("../../addon/core/deploy.js");
  const comps = componentsFromZip(new Map([
    ["objects/Invoice__c.object", textToBytes(OBJ)],
    ["classes/A.cls", textToBytes("class A {}")], ["classes/A.cls-meta.xml", textToBytes("<ApexClass/>")]
  ]), bytesToText);
  const {entries, included} = buildDeployEntries(
    [compKey("CustomField", "Invoice__c.Amount__c"), compKey("ApexClass", "A"), compKey("Flow", "Missing")],
    comps, "67.0", {destructive: {ApexClass: ["Old"]}});
  const files = new Map(entries);
  assert.deepEqual(included, ["CustomField:Invoice__c.Amount__c", "ApexClass:A"]);
  const obj = files.get("objects/Invoice__c.object");
  assert.match(obj, /<fields>[\s\S]*Amount__c[\s\S]*<\/fields>/);
  assert.doesNotMatch(obj, /validationRules|compactLayouts|<label>/);
  assert.match(files.get("package.xml"), /<members>Invoice__c.Amount__c<\/members>\s*<name>CustomField<\/name>/);
  assert.ok(files.has("classes/A.cls-meta.xml"));
  assert.ok(files.get("destructiveChangesPost.xml").includes("Old"));
  // Parent + a child: elements come back in tag order.
  const both = new Map(buildDeployEntries([compKey("CustomObject", "Invoice__c"), compKey("ValidationRule", "Invoice__c.Positive")], comps, "67.0").entries);
  const o = both.get("objects/Invoice__c.object");
  assert.ok(o.indexOf("<label>") < o.indexOf("<validationRules>"));
});
