import {test} from "node:test";
import assert from "node:assert/strict";
import {friendlyError, cleanDetail} from "../../addon/core/friendly-error.js";

test("raw Salesforce errors become plain titles with next steps", () => {
  const e = friendlyError("NOT_FOUND: The requested resource does not exist | Tooling API: NOT_FOUND: The requested resource does not exist");
  assert.equal(e.title, "Not found in this org");
  assert.match(e.hint, /Open a record/);
  assert.equal(e.detail, "NOT_FOUND: The requested resource does not exist");
  assert.equal(friendlyError(new Error("INVALID_SESSION_ID: Session expired or invalid")).title, "Your Salesforce session has expired");
  assert.equal(friendlyError("Network error, offline or timeout").title, "Couldn't reach Salesforce");
  assert.equal(friendlyError("weird").title, "Something went wrong");
  assert.equal(cleanDetail("A | Tooling API: B"), "A · B");
});

test("a validation message that mentions 'offline' stays a validation error", () => {
  assert.equal(friendlyError("FIELD_CUSTOM_VALIDATION_EXCEPTION: Offline orders need a PO").title, "A validation rule blocked the save");
  assert.equal(friendlyError("INVALID_TYPE: sObject type 'Foo' is not supported.").title, "This object can't be used here");
});

test("quick deploy of a validation without tests is explained", () => {
  assert.equal(friendlyError("INVALID_ID_FIELD: Source validate did not run tests in the org").title, "This validation can't be quick deployed");
});

test("cross-reference errors are not blamed on admin rights", () => {
  assert.match(friendlyError("insufficient access rights on cross-reference id").title, /not your admin rights/);
});
