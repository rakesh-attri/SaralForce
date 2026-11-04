import {test} from "node:test";
import assert from "node:assert/strict";
import {auditDelete, sourceMemberDeletes, buildChanges, changeCounts} from "../../addon/core/changes.js";

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
