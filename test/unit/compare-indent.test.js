import {test} from "node:test";
import assert from "node:assert/strict";
import {classifyComponents} from "../../addon/core/deploy.js";

const comp = (type, fullName, path, text) => [`${type}:${fullName}`, {type, fullName, files: {[path]: text}, raw: {}}];
const statusOf = (a, b) => classifyComponents(new Map([a]), new Map([b]))[0].status;

test("compare: XML that differs only in indentation is the same component", () => {
  const repo = "<fields>\n    <fullName>Tier__c</fullName>\n    <type>Text</type>\n</fields>";
  const org = "<fields>\n        <fullName>Tier__c</fullName>\n        <type>Text</type>\n    </fields>";
  assert.equal(statusOf(
    comp("CustomField", "Account.Tier__c", "objects/Account.object#CustomField/Account.Tier__c", repo),
    comp("CustomField", "Account.Tier__c", "objects/Account.object#CustomField/Account.Tier__c", org)), "same");
});

test("compare: a real XML change is still a change", () => {
  assert.equal(statusOf(
    comp("CustomField", "Account.Tier__c", "p", "<fields>\n    <type>Text</type>\n</fields>"),
    comp("CustomField", "Account.Tier__c", "p", "<fields>\n        <type>Number</type>\n</fields>")), "changed");
});

test("compare: code is compared as written, indentation included", () => {
  assert.equal(statusOf(
    comp("ApexClass", "A", "classes/A.cls", "public class A {\n    Integer x;\n}"),
    comp("ApexClass", "A", "classes/A.cls", "public class A {\n  Integer x;\n}")), "changed");
});
