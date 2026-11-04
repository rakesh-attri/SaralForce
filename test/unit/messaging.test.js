import {test} from "node:test";
import assert from "node:assert/strict";
import {isSalesforceOrigin, isLoopbackOrigin, sanitizeRecordContext} from "../../addon/core/messaging.js";

test("isSalesforceOrigin accepts https Salesforce domains", () => {
  for (const origin of [
    "https://acme.lightning.force.com",
    "https://acme.my.salesforce.com",
    "https://acme--dev.sandbox.my.salesforce-setup.com",
    "https://acme--c.vf.force.com",
    "https://acme.lightning.force.com.mcas.ms",
    "https://acme.my.salesforce.mil"
  ]) {
    assert.equal(isSalesforceOrigin(origin), true, origin);
  }
});

test("isSalesforceOrigin rejects lookalikes, http and junk", () => {
  for (const origin of [
    "http://acme.lightning.force.com",
    "https://force.com.evil.example",
    "https://evilsalesforce.com",
    "https://example.com",
    "null",
    "",
    "not a url"
  ]) {
    assert.equal(isSalesforceOrigin(origin), false, origin);
  }
});

test("isLoopbackOrigin only matches http loopback", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:8321"), true);
  assert.equal(isLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackOrigin("https://127.0.0.1"), false);
  assert.equal(isLoopbackOrigin("http://127.0.0.1.evil.example"), false);
});

test("sanitizeRecordContext keeps valid object names and ids", () => {
  assert.deepEqual(sanitizeRecordContext({obj: "Account", id: "001000000000001AAA"}),
    {obj: "Account", id: "001000000000001AAA"});
  assert.deepEqual(sanitizeRecordContext({obj: "Invoice__c", id: null}), {obj: "Invoice__c", id: null});
  assert.deepEqual(sanitizeRecordContext({id: "001000000000001"}), {obj: null, id: "001000000000001"});
});

test("sanitizeRecordContext drops injection attempts", () => {
  assert.equal(sanitizeRecordContext({obj: "Account WHERE Name != null", id: "x"}), null);
  assert.deepEqual(sanitizeRecordContext({obj: "Account", id: "001' OR Id != '"}), {obj: "Account", id: null});
  assert.equal(sanitizeRecordContext("Account"), null);
  assert.equal(sanitizeRecordContext(null), null);
});
