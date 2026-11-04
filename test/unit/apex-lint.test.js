import {test} from "node:test";
import assert from "node:assert/strict";
import {lintApex, lintLwcJs, lintFiles} from "../../addon/core/apex-lint.js";

test("the four errors from the screenshots are caught before deploy", () => {
  const email = lintApex(`@isTest private class EmailServiceTest {
    @isTest static void sends() {
      Test.startTest(); EmailService.send(); Test.stopTest();
      System.assertEquals(1, Test.getSentEmailMessages().size());
    }
  }`);
  assert.match(email[0].message, /Limits\.getEmailInvocations/);
  assert.equal(email[0].line, 4);
  const order = lintApex("List<Account> a = [SELECT Id FROM Account WHERE Name != null ORDER BY Name LIMIT 10 WITH USER_MODE];");
  assert.match(order[0].message, /right after WHERE/);
  assert.deepEqual(lintApex("List<Account> a = [SELECT Id FROM Account WHERE Name != null WITH USER_MODE ORDER BY Name LIMIT 10];"), []);
  const strip = lintApex("List<Account> rows = Security.stripInaccessible(AccessType.READABLE, accs);");
  assert.match(strip[0].message, /getRecords/);
  assert.deepEqual(lintApex("List<Account> rows = Security.stripInaccessible(AccessType.READABLE, accs).getRecords();"), []);
  assert.match(lintApex("x = [SELECT Id FROM A WITH USER_MODE];", {apiVersion: "52.0"})[0].message, /56\.0/);
});

test("cacheable DML, tests without asserts, comments ignored", () => {
  assert.match(lintApex("@AuraEnabled(cacheable=true)\npublic static void save(Account a) { update a; }")[0].message, /cacheable/);
  assert.match(lintApex("@isTest class T { @isTest static void t() { Integer x = 1; } }")[0].message, /no assert/);
  assert.deepEqual(lintApex("// Test.getSentEmailMessages() is not real\nclass A {}"), []);
});

test("LWC JS checks and file routing", () => {
  assert.match(lintLwcJs("this.dispatchEvent(new ShowToastEvent({title: 'x'}));")[0].message, /not imported/);
  assert.deepEqual(lintLwcJs("import { ShowToastEvent } from 'lightning/platformShowToastEvent';\nthis.dispatchEvent(new ShowToastEvent({}));"), []);
  const out = lintFiles([{path: "classes/A.cls", content: "Test.getSentEmailMessages();"}, {path: "lwc/c/c.js-meta.xml", content: "", generated: true}]);
  assert.equal(out[0].path, "classes/A.cls");
});
