import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeCodeReply, checkCodeBundle, expectedPaths, classRole} from "../../addon/core/code-ai.js";
import {buildDraft} from "../../addon/core/metadata-templates.js";
import {mergeRevision} from "../../addon/core/lwc-ai.js";

const CLASS = "public with sharing class InvoiceService {\n    public static Integer count() { return [SELECT COUNT() FROM Account]; }\n}";
const TEST = "@IsTest\nprivate class InvoiceServiceTest {\n    @IsTest static void works() { System.assert(InvoiceService.count() >= 0); }\n}";

test("normalizeCodeReply keeps allowed paths and assigns roles", () => {
  const files = normalizeCodeReply("apex", {files: [
    {path: "classes/InvoiceServiceTest.cls", content: TEST},
    {path: "classes/InvoiceService.cls", content: CLASS},
    {path: "../../etc/passwd", content: "x"},
    {path: "classes/Empty.cls", content: "  "},
  ]}, "InvoiceService");
  assert.deepEqual(files.map(f => [f.path, f.role || ""]), [
    ["classes/InvoiceService.cls", ""], ["classes/InvoiceServiceTest.cls", "extra"]]);
  assert.ok(files.every(f => f.content.endsWith("\n")));
});

test("normalizeCodeReply accepts a path map and maps Aura definitions", () => {
  const files = normalizeCodeReply("aura", {files: {
    "aura/acctSummary/acctSummary.cmp": "<aura:component></aura:component>",
    "aura/acctSummary/acctSummaryController.js": "({ init: function () {} })",
    "aura/acctSummary/acctSummary.css": ".THIS {}",
    "aura/acctSummary/other.js": "x",
    "classes/AcctSummaryController.cls": "public with sharing class AcctSummaryController {}",
  }}, "acctSummary");
  assert.deepEqual(files.map(f => [f.path.split("/").pop(), f.defType || f.role]), [
    ["acctSummary.cmp", "COMPONENT"], ["acctSummaryController.js", "CONTROLLER"], ["acctSummary.css", "STYLE"],
    ["AcctSummaryController.cls", "apex"]]);
  assert.equal(classRole("triggers"), "handler");
  assert.match(expectedPaths("pages", "InvoicePdf")[0], /pages\/InvoicePdf\.page/);
});

test("checkCodeBundle passes good code and flags common mistakes", () => {
  const good = normalizeCodeReply("apex", {files: {"classes/InvoiceService.cls": CLASS, "classes/InvoiceServiceTest.cls": TEST}}, "InvoiceService");
  assert.deepEqual(checkCodeBundle("apex", good, "InvoiceService"), []);
  const bad = normalizeCodeReply("apex", {files: {"classes/InvoiceService.cls": "public class Wrong { void a() { if (x) { }"}}, "InvoiceService");
  const p = checkCodeBundle("apex", bad, "InvoiceService").join(" | ");
  assert.match(p, /must declare class InvoiceService/);
  assert.match(p, /unbalanced braces/);
  assert.match(checkCodeBundle("apex", [], "InvoiceService").join(), /Missing classes\/InvoiceService\.cls/);
});

test("braces inside strings and comments do not count", () => {
  const src = "public class A {\n  // }}}\n  String s = '{{{';\n  /* { */\n}";
  assert.deepEqual(checkCodeBundle("apex", normalizeCodeReply("apex", {files: {"classes/A.cls": src}}, "A"), "A"), []);
});

test("checkCodeBundle checks trigger name and object", () => {
  const files = normalizeCodeReply("triggers", {files: {"triggers/CaseTrigger.trigger": "trigger CaseTrigger on Account (before insert) { }"}}, "CaseTrigger");
  assert.match(checkCodeBundle("triggers", files, "CaseTrigger", {object: "Case"}).join(), /must be on Case/);
  const ok = normalizeCodeReply("triggers", {files: {"triggers/CaseTrigger.trigger": "trigger CaseTrigger on Case (before insert, after update) {\n  CaseHandler.run();\n}",
    "classes/CaseHandler.cls": "public with sharing class CaseHandler { public static void run() {} }"}}, "CaseTrigger");
  assert.deepEqual(checkCodeBundle("triggers", ok, "CaseTrigger", {object: "Case"}), []);
  assert.equal(ok[1].role, "handler");
});

test("checkCodeBundle checks Visualforce and Aura shapes", () => {
  const page = normalizeCodeReply("pages", {files: {"pages/P.page": "<div>no</div>"}}, "P");
  assert.match(checkCodeBundle("pages", page, "P").join(), /<apex:page>/);
  const aura = normalizeCodeReply("aura", {files: {"aura/c/c.cmp": "<aura:component controller=\"MissingCtrl\"></aura:component>",
    "aura/c/cController.js": "function () {}"}}, "c");
  const p = checkCodeBundle("aura", aura, "c", {knownClasses: []}).join(" | ");
  assert.match(p, /controller="MissingCtrl"/);
  assert.match(p, /wrapped in \(\{/);
});

test("buildDraft uses AI files for code kinds", () => {
  const aiFiles = normalizeCodeReply("apex", {files: {"classes/InvoiceService.cls": CLASS, "classes/InvoiceServiceTest.cls": TEST}}, "InvoiceService");
  const d = buildDraft("apex", {name: "InvoiceService", template: "batch", apiVersion: "68.0", aiFiles});
  assert.deepEqual(d.files.map(f => f.path), ["classes/InvoiceService.cls", "classes/InvoiceServiceTest.cls"]);
  assert.match(d.files[0].content, /InvoiceService/);
  assert.equal(d.form.aiFiles, undefined);
});

test("mergeRevision may add classes to non-LWC drafts with the kind's role", () => {
  const d = buildDraft("triggers", {name: "CaseTrigger", object: "Case", events: ["after insert"], handler: false});
  const merged = mergeRevision(d, {"classes/CaseHandler.cls": "public class CaseHandler {}", "aura/x/x.cmp": "<aura:component/>"});
  const added = merged.files.find(f => f.path === "classes/CaseHandler.cls");
  assert.equal(added.role, "handler");
  assert.ok(!merged.files.some(f => f.path.startsWith("aura/")));
});
