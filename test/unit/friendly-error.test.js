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
