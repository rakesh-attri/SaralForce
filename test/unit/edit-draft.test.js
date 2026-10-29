import {test} from "node:test";
import assert from "node:assert/strict";
import {
  editDraftFromSource, changedFiles, newApexClasses, readCompileResult, containerName, auraPath, SANDBOX_ONLY_NOTE
} from "../../addon/core/edit-draft.js";
import {mergeRevision} from "../../addon/core/lwc-ai.js";
import {checkCodeBundle} from "../../addon/core/code-ai.js";

const ROW = {Id: "01p000000000001AAA", Name: "InvoiceService", ApiVersion: 67, LastModifiedDate: "2026-10-01T10:00:00.000+0000"};

test("editDraftFromSource builds an edit draft that remembers the org copy", () => {
  const d = editDraftFromSource("apex", ROW, [{path: "classes/InvoiceService.cls", content: "public class InvoiceService {}\n"}]);
  assert.equal(d.mode, "edit");
  assert.equal(d.title, "InvoiceService.cls");
  assert.deepEqual(d.existing, {id: ROW.Id, lastModified: ROW.LastModifiedDate});
  assert.equal(d.files[0].original, d.files[0].content);
  assert.equal(d.files[0].lang, "apex");
  assert.equal(d.form.apiVersion, "67");
  assert.deepEqual(changedFiles(d), []);
});

test("changedFiles and newApexClasses see edits and AI additions only", () => {
  const d = editDraftFromSource("triggers", {...ROW, Name: "CaseTrigger", TableEnumOrId: "Case"},
    [{path: "triggers/CaseTrigger.trigger", content: "trigger CaseTrigger on Case (before insert) { }\n"}]);
  assert.equal(d.form.object, "Case");
  const merged = mergeRevision(d, {
    "triggers/CaseTrigger.trigger": "trigger CaseTrigger on Case (before insert) {\n    CaseHandler.run();\n}",
    "classes/CaseHandler.cls": "public with sharing class CaseHandler { public static void run() {} }",
  });
  assert.deepEqual(changedFiles(merged).map(f => f.path), ["triggers/CaseTrigger.trigger", "classes/CaseHandler.cls"]);
  assert.deepEqual(newApexClasses(merged).map(f => f.path), ["classes/CaseHandler.cls"]);
  assert.deepEqual(checkCodeBundle("triggers", merged.files, "CaseTrigger", {object: "Case"}), []);
});

test("read-only files never count as changed", () => {
  const d = editDraftFromSource("lwc", {Id: "0Rb000000000001AAA", DeveloperName: "openCases"}, [
    {path: "lwc/openCases/openCases.js", content: "a", resourceId: "0Rd1"},
    {path: "lwc/openCases/openCases.js-meta.xml", content: "<x/>", resourceId: "0Rd2", readOnly: true},
  ]);
  d.files[1].content = "<changed/>";
  assert.deepEqual(changedFiles(d), []);
});

test("auraPath maps definition types", () => {
  assert.equal(auraPath("card", "COMPONENT"), "aura/card/card.cmp");
  assert.equal(auraPath("card", "CONTROLLER"), "aura/card/cardController.js");
  assert.equal(auraPath("card", "STYLE"), "aura/card/card.css");
});

test("readCompileResult reads queued, completed and failed saves", () => {
  assert.deepEqual(readCompileResult({State: "Queued"}), {done: false, ok: false, errors: []});
  assert.deepEqual(readCompileResult({State: "Completed"}), {done: true, ok: true, errors: []});
  const failed = readCompileResult({State: "Failed", DeployDetails: {componentFailures: [
    {fileName: "classes/InvoiceService.cls", lineNumber: 4, columnNumber: 9, problem: "Missing ';' at 'return'", problemType: "Error"}]}});
  assert.deepEqual(failed, {done: true, ok: false, errors: ["classes/InvoiceService.cls line 4:9: Missing ';' at 'return'"]});
  assert.deepEqual(readCompileResult({State: "Error", ErrorMsg: "Container busy"}).errors, ["Container busy"]);
});

test("containerName is unique-ish and fits 32 characters", () => {
  const a = containerName(1);
  assert.ok(a.length <= 32 && a.startsWith("SaralForce_"));
  assert.match(SANDBOX_ONLY_NOTE, /sandboxes and developer orgs/);
});
