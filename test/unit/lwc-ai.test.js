import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeBundleReply, checkLwcBundle, bundleForPrompt, mergeRevision} from "../../addon/core/lwc-ai.js";
import {buildDraft} from "../../addon/core/metadata-templates.js";

const GOOD = {
  files: {
    html: "<template>\n  <lightning-card title=\"Open Cases\"></lightning-card>\n</template>",
    js: "import { LightningElement, api, wire } from 'lwc';\nimport getCases from '@salesforce/apex/OpenCasesController.getCases';\n" +
      "export default class OpenCases extends LightningElement {\n  @api recordId;\n  @wire(getCases, { accountId: '$recordId' }) cases;\n}",
    css: ":host { display: block; }",
  },
  apex: {name: "OpenCasesController", body: "public with sharing class OpenCasesController {\n" +
    "    @AuraEnabled(cacheable=true)\n    public static List<Case> getCases(Id accountId) {\n        return [SELECT Id FROM Case WHERE AccountId = :accountId];\n    }\n}"},
};

test("normalizeBundleReply maps files and Apex like lwcFiles", () => {
  const files = normalizeBundleReply(GOOD, "openCases");
  assert.deepEqual(files.map(f => [f.path, f.format, f.role || ""]), [
    ["lwc/openCases/openCases.html", "html", ""],
    ["lwc/openCases/openCases.js", "js", ""],
    ["lwc/openCases/openCases.css", "css", ""],
    ["classes/OpenCasesController.cls", "apex", "apex"],
  ]);
  assert.ok(files.every(f => f.content.endsWith("\n")));
  assert.equal(files[3].name, "OpenCasesController");
});

test("normalizeBundleReply drops empty files and bad Apex names", () => {
  const files = normalizeBundleReply({files: {html: "<template></template>", js: "x", css: "  "}, apex: [{name: "bad name", body: "x"}]}, "c");
  assert.deepEqual(files.map(f => f.path), ["lwc/c/c.html", "lwc/c/c.js"]);
});

test("checkLwcBundle accepts a valid bundle", () => {
  assert.deepEqual(checkLwcBundle(normalizeBundleReply(GOOD, "openCases"), "openCases"), []);
});

test("checkLwcBundle catches common mistakes", () => {
  const bad = normalizeBundleReply({
    files: {html: "<div>no template</div>", js: "import { LightningElement } from 'lwc';\nimport go from '@salesforce/apex/Missing.go';\n" +
      "export default class Wrong extends LightningElement { connectedCallback() { this.template.querySelector('div').innerHTML = 'x'; } }"},
  }, "openCases");
  const p = checkLwcBundle(bad, "openCases").join(" | ");
  assert.match(p, /<template> root/);
  assert.match(p, /export default class OpenCases/);
  assert.match(p, /no Apex class Missing/);
  assert.match(p, /innerHTML/);
});

test("checkLwcBundle wants the imported Apex method", () => {
  const reply = {...GOOD, apex: {name: "OpenCasesController", body: "public with sharing class OpenCasesController {}"}};
  assert.match(checkLwcBundle(normalizeBundleReply(reply, "openCases"), "openCases").join(), /no @AuraEnabled static method getCases/);
});

test("buildDraft uses AI files and still generates the meta XML", () => {
  const aiFiles = normalizeBundleReply(GOOD, "openCases");
  const d = buildDraft("lwc", {name: "openCases", label: "Open Cases", exposed: true, targets: ["lightning__RecordPage"],
    apiVersion: "68.0", template: "datatable", aiFiles});
  assert.deepEqual(d.files.map(f => f.path.split("/").pop()), [
    "openCases.html", "openCases.js", "openCases.css", "openCases.js-meta.xml", "OpenCasesController.cls"]);
  const meta = d.files[3];
  assert.equal(meta.readOnly, true);
  assert.match(meta.content, /<target>lightning__RecordPage<\/target>/);
  assert.equal(d.form.aiFiles, undefined);
});

test("bundleForPrompt skips generated files; mergeRevision updates and adds", () => {
  const draft = buildDraft("lwc", {name: "openCases", exposed: false, targets: [], apiVersion: "68.0", aiFiles: normalizeBundleReply(GOOD, "openCases")});
  const prompt = bundleForPrompt(draft.files);
  assert.match(prompt, /=== lwc\/openCases\/openCases\.html ===/);
  assert.doesNotMatch(prompt, /js-meta\.xml/);
  const merged = mergeRevision(draft, {
    "lwc/openCases/openCases.css": ".x { color: red; }",
    "lwc/openCases/openCases.js-meta.xml": "<hacked/>",
    "lwc/openCases/openCases.svg": "<svg/>",
    "classes/Helper.cls": "public class Helper {}",
    "../evil.js": "x",
  });
  const byName = n => merged.files.find(f => f.path.endsWith(n));
  assert.equal(byName("openCases.css").content, ".x { color: red; }\n");
  assert.doesNotMatch(byName("openCases.js-meta.xml").content, /hacked/);
  assert.ok(byName("openCases.svg"));
  assert.equal(byName("Helper.cls").role, "apex");
  assert.ok(!merged.files.some(f => f.path.includes("evil")));
  const svgAt = merged.files.findIndex(f => f.path.endsWith(".svg"));
  assert.ok(svgAt < merged.files.findIndex(f => f.generated));
});
