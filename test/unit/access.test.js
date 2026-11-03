import {test} from "node:test";
import assert from "node:assert/strict";
import {
  humanizePermission, permSetDisplayName, objectPermLetters, buildCompareMatrix,
  filterMatrix, effectiveAccess, summarizeRiskyAccess, soqlIdList, OBJECT_PERM_FLAGS
} from "../../addon/core/access.js";

const A = "0PS000000000001AAA";
const B = "0PS000000000002AAA";

test("humanizePermission", () => {
  assert.equal(humanizePermission("PermissionsModifyAllData"), "Modify All Data");
  assert.equal(humanizePermission("PermissionsApiEnabled"), "Api Enabled");
  assert.equal(humanizePermission("PermissionsViewAllUsers"), "View All Users");
});

test("permSetDisplayName marks profiles and groups", () => {
  assert.equal(permSetDisplayName({IsOwnedByProfile: true, Profile: {Name: "System Administrator"}}), "System Administrator (profile)");
  assert.equal(permSetDisplayName({Type: "Group", Label: "Sales Bundle"}), "Sales Bundle (group)");
  assert.equal(permSetDisplayName({Label: "Sales Ops"}), "Sales Ops");
});

test("objectPermLetters", () => {
  assert.equal(objectPermLetters({PermissionsRead: true, PermissionsEdit: true}), "RE");
  assert.equal(objectPermLetters({}), "—");
  assert.equal(objectPermLetters(null), "—");
});

test("buildCompareMatrix marks differences per section", () => {
  const sections = buildCompareMatrix({
    sets: [
      {Id: A, PermissionsApiEnabled: true, PermissionsModifyAllData: true, PermissionsRunReports: false},
      {Id: B, PermissionsApiEnabled: true, PermissionsModifyAllData: false, PermissionsRunReports: false},
    ],
    objectPerms: [
      {ParentId: A, SobjectType: "Account", PermissionsRead: true, PermissionsEdit: true},
      {ParentId: B, SobjectType: "Account", PermissionsRead: true, PermissionsEdit: true},
      {ParentId: A, SobjectType: "Case", PermissionsRead: true},
      {ParentId: "0PS000000000009AAA", SobjectType: "Lead", PermissionsRead: true},
    ],
    tabSettings: [{ParentId: A, Name: "standard-Account", Visibility: "DefaultOn"}],
    appAccess: [{ParentId: B, app: "Sales"}],
  });
  const sys = sections.find(s => s.key === "system");
  assert.deepEqual(sys.rows.map(r => [r.label, r.values, r.differs]), [
    ["Api Enabled", ["✓", "✓"], false],
    ["Modify All Data", ["✓", ""], true],
  ]);
  const obj = sections.find(s => s.key === "objects");
  assert.deepEqual(obj.rows.map(r => [r.key, r.values, r.differs]), [
    ["Account", ["RE", "RE"], false],
    ["Case", ["R", "—"], true],
  ]);
  assert.deepEqual(sections.find(s => s.key === "tabs").rows[0].values, ["Visible", ""]);
  assert.deepEqual(sections.find(s => s.key === "apps").rows[0].values, ["", "✓"]);
  const diffOnly = filterMatrix(sections, {onlyDiff: true});
  assert.equal(diffOnly.find(s => s.key === "objects").rows.length, 1);
  assert.equal(filterMatrix(sections, {term: "acc"}).find(s => s.key === "objects").rows.length, 1);
});

test("effectiveAccess ORs sources and lists who grants what", () => {
  const r = effectiveAccess([
    {ParentId: A, PermissionsRead: true},
    {ParentId: B, PermissionsRead: true, PermissionsEdit: true},
  ], OBJECT_PERM_FLAGS, {[A]: "Profile", [B]: "Sales Ops"});
  assert.equal(r.effective.Read, true);
  assert.equal(r.effective.Edit, true);
  assert.equal(r.effective.Delete, false);
  assert.deepEqual(r.sources.map(s => [s.name, s.grants]), [["Sales Ops", ["Read", "Edit"]], ["Profile", ["Read"]]]);
});

test("summarizeRiskyAccess ranks users by risky permission count", () => {
  const admin = {Id: "005000000000001AAA", Name: "Ada", Username: "ada@x"};
  const dev = {Id: "005000000000002AAA", Name: "Dev", Username: "dev@x"};
  const prof = {IsOwnedByProfile: true, Profile: {Name: "System Administrator"}};
  const r = summarizeRiskyAccess({
    PermissionsModifyAllData: [{Assignee: admin, PermissionSet: prof}],
    PermissionsAuthorApex: [{Assignee: admin, PermissionSet: prof}, {Assignee: dev, PermissionSet: {Label: "Dev Tools"}}],
  });
  assert.deepEqual(r.users.map(u => [u.name, u.perms.length]), [["Ada", 2], ["Dev", 1]]);
  const apex = r.perms.find(p => p.field === "PermissionsAuthorApex");
  assert.equal(apex.userCount, 2);
  assert.equal(r.perms.length, 2);
});

test("soqlIdList drops anything that is not an id", () => {
  assert.equal(soqlIdList([A, "x' OR 1=1", B]), `'${A}','${B}'`);
});
