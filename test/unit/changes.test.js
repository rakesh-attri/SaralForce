import {test} from "node:test";
import assert from "node:assert/strict";
import {auditDelete, inRange, trustedDate, auditPermissionEdits, sourceMemberDeletes, buildChanges, changeCounts} from "../../addon/core/changes.js";

test("audit trail deletes are recognised", () => {
  const a = auditDelete({Display: "Deleted Apex Class NxtPay_OldHelper", Section: "Apex Class", CreatedDate: "2026-11-03T10:00:00Z", CreatedBy: {Name: "Shivam Ojha"}});
  assert.deepEqual([a.type, a.fullName, a.by], ["ApexClass", "NxtPay_OldHelper", "Shivam Ojha"]);
  assert.equal(auditDelete({Display: "Deleted trigger InvoiceTrigger"}).type, "ApexTrigger");
  assert.equal(auditDelete({Display: "Deleted static resource \"logo\""}).fullName, "logo");
  assert.equal(auditDelete({Display: "Changed Apex Class NxtPay_X"}), null);
  assert.equal(auditDelete({Display: "Deleted a user from group Sales"}), null);
});

test("source tracking deletes carry the user name", () => {
  const d = sourceMemberDeletes([{MemberType: "ApexClass", MemberName: "Gone", IsNameObsolete: true, LastModifiedById: "005A", LastModifiedDate: "2026-11-03T09:00:00Z"},
    {MemberType: "ApexClass", MemberName: "Kept", IsNameObsolete: false}], {"005A": "Narendar R"});
  assert.deepEqual(d.map(x => [x.fullName, x.by]), [["Gone", "Narendar R"]]);
});

test("changes: new vs updated by creation date, deletes merged, newest first", () => {
  const since = Date.parse("2026-11-02T18:30:00Z");
  const listed = [
    {type: "ApexClass", fullName: "Brand_New", createdDate: "2026-11-03T05:00:00Z", lastModifiedDate: "2026-11-03T06:00:00Z", lastModifiedByName: "A"},
    {type: "ApexClass", fullName: "Edited", createdDate: "2025-01-01T00:00:00Z", lastModifiedDate: "2026-11-03T07:00:00Z", lastModifiedByName: "B"},
    {type: "ApexClass", fullName: "Yesterday", createdDate: "2025-01-01T00:00:00Z", lastModifiedDate: "2026-11-02T12:00:00Z"}
  ];
  const deleted = [
    {type: "ApexClass", fullName: "Gone", at: "2026-11-03T08:00:00Z", by: "C", from: "tracking"},
    {type: "ApexClass", fullName: "Gone", at: "2026-11-03T08:00:00Z", by: "C", from: "audit"},
    {type: "ApexClass", fullName: "Edited", at: "2026-11-03T01:00:00Z", from: "audit"},
    {type: "Flow", fullName: "Not_Picked", at: "2026-11-03T08:00:00Z"}
  ];
  const rows = buildChanges(listed, deleted, since, ["ApexClass"]);
  assert.deepEqual(rows.map(r => `${r.fullName}:${r.status}`), ["Gone:deleted", "Edited:updated", "Brand_New:new"]);
  assert.deepEqual(changeCounts(rows), {new: 1, updated: 1, deleted: 1});
  assert.equal(rows[0].deployable, true);
});

test("audit trail: only exact phrases become deletes", () => {
  assert.equal(auditDelete({Display: "Deleted page layout Account Layout"}), null);
  assert.equal(auditDelete({Display: "Deleted Lightning page Account_Record_Page"}), null);
  assert.equal(auditDelete({Display: "Deleted Flow Version #2 of flow My_Flow"}), null);
  assert.equal(auditDelete({Display: "Deleted Apex Class Gone_One"}).fullName, "Gone_One");
});

test("audit trail profile and permission set edits", () => {
  const rows = auditPermissionEdits([
    {Display: "Changed profile Sales User: field-level security for Account: Rating was changed from No Access to Read/Write", CreatedBy: {Name: "Priya"}, CreatedDate: "2026-11-09T10:00:00Z"},
    {Display: "Changed permission set Invoice Manager: object permissions for Invoice", CreatedBy: {Name: "Rakesh"}, CreatedDate: "2026-11-09T11:00:00Z"},
    {Display: "Changed permission set group Ops Bundle: added Invoice Manager"},
    {Display: "Logged in"}
  ]);
  assert.deepEqual(rows.map(r => [r.type, r.label, r.by]), [["Profile", "Sales User", "Priya"], ["PermissionSet", "Invoice Manager", "Rakesh"]]);
});

test("buildChanges adds edits that listMetadata's date misses", () => {
  const since = Date.parse("2026-11-01T00:00:00Z");
  const listed = [{type: "Profile", fullName: "Admin", lastModifiedDate: "2026-01-01T00:00:00Z", createdDate: "2020-01-01T00:00:00Z"}];
  const out = buildChanges(listed, [], since, ["Profile"], [
    {type: "Profile", fullName: "Admin", by: "Priya", at: "2026-11-05T00:00:00Z"},
    {type: "Profile", fullName: "Old", by: "x", at: "2026-10-01T00:00:00Z"}
  ]);
  assert.deepEqual(out.map(r => [r.fullName, r.status, r.by]), [["Admin", "updated", "Priya"]]);
});

test("date range keeps undated items and honours from / to", () => {
  const from = Date.parse("2026-11-03T00:00:00Z");
  const to = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(inRange("", from, to), true);
  assert.equal(inRange("1970-01-01T00:00:00.000Z", from, to), true);
  assert.ok(Number.isNaN(trustedDate("1970-01-01T00:00:00.000Z")));
  assert.equal(inRange("2026-11-05T10:00:00Z", from, to), true);
  assert.equal(inRange("2026-11-01T10:00:00Z", from, to), false);
  assert.equal(inRange("2026-11-11T00:00:00Z", from, to), false);
  assert.equal(inRange("2026-11-01T10:00:00Z", 0, to), true);
});

test("buildChanges stops at the end of the period", () => {
  const since = Date.parse("2026-11-01T00:00:00Z");
  const until = Date.parse("2026-11-05T00:00:00Z");
  const listed = [
    {type: "ApexClass", fullName: "A", lastModifiedDate: "2026-11-02T00:00:00Z"},
    {type: "ApexClass", fullName: "B", lastModifiedDate: "2026-11-07T00:00:00Z"}
  ];
  assert.deepEqual(buildChanges(listed, [], since, null, [], until).map(r => r.fullName), ["A"]);
  assert.deepEqual(buildChanges(listed, [], since, null).map(r => r.fullName), ["B", "A"]);
});
