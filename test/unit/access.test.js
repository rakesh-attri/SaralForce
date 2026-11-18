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

test("compare across orgs: same profile in sandbox and production", async () => {
  const {pickKey, splitPick, mergeCompareData, buildCompareMatrix} = await import("../../addon/core/access.js");
  assert.deepEqual(splitPick("uat.sandbox.my.salesforce.com|0PS1"), {host: "uat.sandbox.my.salesforce.com", id: "0PS1"});
  assert.deepEqual(splitPick("0PS1"), {host: "", id: "0PS1"});
  // Both orgs happen to use the same Id: keys keep them apart.
  const sb = {sets: [{Id: "0PS1", Name: "Admin", PermissionsModifyAllData: true, PermissionsApiEnabled: true}],
    objectPerms: [{ParentId: "0PS1", SobjectType: "Invoice__c", PermissionsRead: true, PermissionsEdit: true}]};
  const prod = {sets: [{Id: "0PS1", Name: "Admin", PermissionsModifyAllData: false, PermissionsApiEnabled: true}],
    objectPerms: [{ParentId: "0PS1", SobjectType: "Invoice__c", PermissionsRead: true}]};
  const order = [pickKey("", "0PS1"), pickKey("prod.my.salesforce.com", "0PS1")];
  const merged = mergeCompareData([{host: "", data: sb}, {host: "prod.my.salesforce.com", data: prod}], order);
  assert.deepEqual(merged.sets.map(s => s.Id), order);
  const m = buildCompareMatrix(merged);
  const modify = m.find(s => s.key === "system").rows.find(r => r.key === "PermissionsModifyAllData");
  assert.deepEqual(modify.values, ["✓", ""]);
  assert.equal(modify.differs, true);
  const inv = m.find(s => s.key === "objects").rows.find(r => r.key === "Invoice__c");
  assert.equal(inv.differs, true);
});

test("readable compare: labels, row differences and the summary", async () => {
  const {columnLabels, describeRowDiff, diffSummary} = await import("../../addon/core/access.js");
  // Same group in two orgs whose names differ only in case: org + kind.
  const cols = [{item: "Student (group)", org: "NexTurn Inc", kind: "Production"}, {item: "Student (group)", org: "Nexturn Inc", kind: "Sandbox"}];
  assert.deepEqual(columnLabels(cols), ["NexTurn Inc (Production)", "Nexturn Inc (Sandbox)"]);
  assert.deepEqual(columnLabels([{item: "A", org: "X"}, {item: "B", org: "X"}]), ["A", "B"]);
  assert.deepEqual(columnLabels([{item: "A", org: "X"}, {item: "B", org: "Y"}]), ["A · X", "B · Y"]);
  const L = ["Prod", "UAT"];
  assert.equal(describeRowDiff("objects", ["RCED", "R"], L), "Create, Edit, Delete: only in Prod");
  assert.equal(describeRowDiff("objects", ["R", "—"], L), "No access in UAT");
  assert.equal(describeRowDiff("objects", ["RCE", "R", "—"], ["A", "B", "C"]), "No access in C · Create, Edit: only in A");
  assert.equal(describeRowDiff("objects", ["RV", "RCE"], L), "Create, Edit: only in UAT · View All: only in Prod");
  assert.equal(describeRowDiff("system", ["✓", ""], L), "Only in Prod");
  assert.equal(describeRowDiff("apps", ["", "✓", "✓"], ["A", "B", "C"]), "Not in A");
  assert.equal(describeRowDiff("tabs", ["Visible", ""], L), "Prod: Visible · UAT: Not set");
  const sum = diffSummary([{key: "system", rows: []}, {key: "objects", rows: [{differs: true}, {differs: true}]}, {key: "tabs", rows: [{differs: true}, {differs: false}]}]);
  assert.equal(sum.text, "3 differences: 2 object permissions, 1 tab setting");
  assert.equal(diffSummary([{key: "system", rows: [{differs: false}]}]).total, 0);
});

test("compare: Apex, field, license and sharing-default sections", async () => {
  const {buildCompareMatrix, mergeCompareData, pickKey, describeRowDiff, diffSummary} = await import("../../addon/core/access.js");
  const a = {sets: [{Id: "1", License: {Name: "Salesforce"}, IsOwnedByProfile: true}],
    setupAccess: [{ParentId: "1", type: "ApexClass", name: "InvoiceService"}, {ParentId: "1", type: "CustomPermission", name: "Bypass_Rules"}],
    fieldPerms: [{ParentId: "1", Field: "Account.Rating", PermissionsRead: true, PermissionsEdit: true}],
    owd: {Account: "Private / Private"}};
  const b = {sets: [{Id: "1", License: {Name: "Salesforce Platform"}, IsOwnedByProfile: true}],
    setupAccess: [{ParentId: "1", type: "CustomPermission", name: "Bypass_Rules"}],
    fieldPerms: [{ParentId: "1", Field: "Account.Rating", PermissionsRead: true, PermissionsEdit: false}],
    owd: {Account: "Public Read Only / Private"}};
  const order = [pickKey("", "1"), pickKey("prod", "1")];
  const m = buildCompareMatrix(mergeCompareData([{host: "", data: a}, {host: "prod", data: b}], order));
  const sec = k => m.find(s => s.key === k);
  assert.equal(m[0].key, "general");
  assert.deepEqual(sec("general").rows.find(r => r.key === "license").values, ["Salesforce", "Salesforce Platform"]);
  assert.deepEqual(sec("apex").rows[0].values, ["✓", ""]);
  assert.equal(sec("customPerms").rows[0].differs, false);
  assert.deepEqual(sec("fields").rows[0].values, ["Read · Edit", "Read"]);
  assert.deepEqual(sec("owd").rows[0].values, ["Private / Private", "Public Read Only / Private"]);
  const L = ["Sandbox", "Prod"];
  assert.equal(describeRowDiff("fields", ["Read · Edit", ""], L), "Sandbox: Read · Edit · Prod: No access");
  assert.equal(describeRowDiff("apex", ["✓", ""], L), "Only in Sandbox");
  assert.match(diffSummary(m).text, /1 Apex class/);
  // Sharing defaults need two orgs: one org alone shows none.
  const one = mergeCompareData([{host: "", data: {...a, sets: [{Id: "1"}, {Id: "2"}]}}], [pickKey("", "1"), pickKey("", "2")]);
  assert.equal(one.owd, null);
});

test("users: effective access merges profile, sets and groups and keeps where it comes from", async () => {
  const {combineAccess, buildCompareMatrix, mergeCompareData, pickKey} = await import("../../addon/core/access.js");
  const data = {
    sets: [{Id: "P", PermissionsModifyAllData: true, PermissionsApiEnabled: false}, {Id: "S", PermissionsApiEnabled: true, PermissionsModifyAllData: false}, {Id: "X", PermissionsAuthorApex: true}],
    objectPerms: [{ParentId: "P", SobjectType: "Invoice__c", PermissionsRead: true}, {ParentId: "S", SobjectType: "Invoice__c", PermissionsEdit: true}],
    tabSettings: [{ParentId: "P", Name: "Invoice", Visibility: "DefaultOff"}, {ParentId: "S", Name: "Invoice", Visibility: "DefaultOn"}],
    setupAccess: [{ParentId: "S", type: "ApexClass", name: "InvoiceService"}], fieldPerms: [], appAccess: []
  };
  const {data: one, origins} = combineAccess(data, ["P", "S"], "U1", {P: "Profile: System Administrator", S: "Perm set: Dev Tools"}, {"Profile": "System Administrator"});
  assert.equal(one.sets[0].PermissionsModifyAllData, true);
  assert.equal(one.sets[0].PermissionsApiEnabled, true);
  assert.equal(one.sets[0].PermissionsAuthorApex, undefined, "X is not this user's");
  assert.deepEqual({r: one.objectPerms[0].PermissionsRead, e: one.objectPerms[0].PermissionsEdit}, {r: true, e: true});
  assert.equal(one.tabSettings[0].Visibility, "DefaultOn");
  assert.deepEqual(origins["system|PermissionsModifyAllData"], ["Profile: System Administrator"]);
  assert.deepEqual(origins["apex|InvoiceService"], ["Perm set: Dev Tools"]);
  const m = buildCompareMatrix(mergeCompareData([{host: "", data: one}], [pickKey("", "U1")]));
  assert.equal(m.find(s => s.key === "general").rows[0].label, "Profile");
});

test("users: the same person in another org", async () => {
  const {matchUser} = await import("../../addon/core/access.js");
  const {baseUsername} = await import("../../addon/core/manual-steps.js");
  const prod = [{id: "1", username: "rakesh@nexturn.com", email: "rakesh@nexturn.com"}, {id: "2", username: "priya@nexturn.com", email: "priya@nexturn.com"}];
  assert.equal(matchUser({username: "rakesh@nexturn.com.uat", email: "rakesh@nexturn.com"}, prod, baseUsername).id, "1");
  assert.equal(matchUser({username: "priya@nexturn.com.uat", email: "priya@nexturn.com.invalid"}, prod, baseUsername).id, "2");
  assert.equal(matchUser({username: "nobody@x.com", email: ""}, prod, baseUsername), null);
});

test("roles & groups: settings, members and queue objects side by side", async () => {
  const {buildRoleGroupMatrix, describeRowDiff} = await import("../../addon/core/access.js");
  const m = buildRoleGroupMatrix([
    {kind: "queue", settings: {"Type": "Queue", "Email": "q@x.com"}, members: [{type: "User", name: "rakesh@x.com"}, {type: "Role", name: "CEO"}], queueObjects: ["Case", "Lead"]},
    {kind: "queue", settings: {"Type": "Queue", "Email": ""}, members: [{type: "User", name: "rakesh@x.com"}], queueObjects: ["Case"]}
  ]);
  const sec = k => m.find(s => s.key === k);
  assert.equal(sec("rgSettings").rows.find(r => r.key === "Email").differs, true);
  assert.deepEqual(sec("members").rows.map(r => [r.key, r.differs]), [["Role: CEO", true], ["User: rakesh@x.com", false]]);
  assert.deepEqual(sec("queueObjects").rows.find(r => r.key === "Lead").values, ["✓", ""]);
  assert.equal(describeRowDiff("members", ["✓", ""], ["Prod", "UAT"]), "Only in Prod");
});

test("sharing rules read as one line each", async () => {
  const {summarizeSharingRule, sharingRulesSection} = await import("../../addon/core/access.js");
  const crit = "<sharingCriteriaRules><fullName>Open_Cases</fullName><accessLevel>Edit</accessLevel><label>Open</label>" +
    "<sharedTo><roleAndSubordinates>Sales_Manager</roleAndSubordinates></sharedTo>" +
    "<criteriaItems><field>Status</field><operation>equals</operation><value>Open</value></criteriaItems></sharingCriteriaRules>";
  assert.equal(summarizeSharingRule("SharingCriteriaRule", crit), "Criteria · Status equals Open → Role & subordinates Sales_Manager · Read/Write");
  const owner = "<sharingOwnerRules><accessLevel>Read</accessLevel><sharedFrom><group>Sales</group></sharedFrom><sharedTo><allInternalUsers></allInternalUsers></sharedTo></sharingOwnerRules>";
  assert.equal(summarizeSharingRule("SharingOwnerRule", owner), "Owner · Group Sales → All internal users · Read Only");
  const sec = sharingRulesSection(["", "prod"], {"": {"Case.Open_Cases": "a"}, prod: {"Case.Open_Cases": "b", "Lead.X": "c"}});
  assert.deepEqual(sec.rows.map(r => [r.key, r.values]), [["Case.Open_Cases", ["a", "b"]], ["Lead.X", ["", "c"]]]);
});

test("sharing rule differences say only what changed", async () => {
  const {describeRowDiff} = await import("../../addon/core/access.js");
  const L = ["Demo", "UAT"];
  assert.equal(describeRowDiff("sharingRules", ["Criteria · Status equals Open → Role X · Read/Write", ""], L), "Only in Demo");
  assert.equal(describeRowDiff("sharingRules", ["Owner · Group A → All internal users · Read Only", "Owner · Group A → All internal users · Read/Write"], L),
    "Demo: Read Only · UAT: Read/Write");
});

test("column labels are always unique: production and its sandbox share a name", async () => {
  const {columnLabels} = await import("../../addon/core/access.js");
  // Same item, two orgs both called "Admin": the host says they differ, the kind tells them apart.
  assert.deepEqual(columnLabels([{item: "Sales (profile)", org: "Admin", kind: "Production", host: "acme.my.salesforce.com"},
    {item: "Sales (profile)", org: "Admin", kind: "Sandbox", host: "acme--uat.sandbox.my.salesforce.com"}]), ["Admin (Production)", "Admin (Sandbox)"]);
  // Two sandboxes with one name: the host.
  assert.deepEqual(columnLabels([{item: "P", org: "Admin", kind: "Sandbox", host: "a.sandbox"}, {item: "P", org: "Admin", kind: "Sandbox", host: "b.sandbox"}]),
    ["Admin (Sandbox) · a.sandbox", "Admin (Sandbox) · b.sandbox"]);
  // Two permission sets with one label in one org: "#2".
  assert.deepEqual(columnLabels([{item: "Ops", org: "X", host: ""}, {item: "Ops", org: "X", host: ""}]), ["Ops", "Ops #2"]);
});

test("a pick that no longer exists is reported, not shifted into another column", async () => {
  const {mergeCompareData, pickKey, buildCompareMatrix} = await import("../../addon/core/access.js");
  const order = [pickKey("", "A"), pickKey("", "GONE"), pickKey("", "B")];
  const merged = mergeCompareData([{host: "", data: {sets: [{Id: "A", PermissionsApiEnabled: true}, {Id: "B"}]}}], order);
  assert.deepEqual(merged.missing, [pickKey("", "GONE")]);
  assert.deepEqual(merged.sets.map(s => s.Id), [pickKey("", "A"), pickKey("", "B")]);
  assert.equal(buildCompareMatrix(merged).find(s => s.key === "system").rows[0].values.length, 2);
});

test("sections an org could not read are not compared", async () => {
  const {markUnreadSections, diffSummary} = await import("../../addon/core/access.js");
  const sections = [{key: "tabs", title: "Tab settings", rows: [{differs: true}]}, {key: "objects", title: "Objects", rows: [{differs: true}]}];
  const m = markUnreadSections(sections, {tabs: ["UAT"]});
  assert.deepEqual(m[0].rows, []);
  assert.deepEqual(m[0].unread, ["UAT"]);
  assert.equal(m[1].unread, undefined);
  assert.equal(diffSummary(m).total, 1);
});

test("same as left: permission sets match on API name and namespace, labels only when unique", async () => {
  const {matchPermSet} = await import("../../addon/core/access.js");
  const right = [{id: "1", kind: "set", api: "Sales_Ops", ns: "", name: "Sales Ops"}, {id: "2", kind: "set", api: "Sales_Ops_Old", ns: "", name: "Sales Ops"},
    {id: "3", kind: "set", api: "Sales_Ops", ns: "pkg", name: "Sales Ops (pkg)"}, {id: "4", kind: "profile", api: "Admin", ns: "", name: "Admin (profile)"}];
  assert.equal(matchPermSet({kind: "set", api: "Sales_Ops", ns: "", name: "Sales Ops"}, right).id, "1");
  assert.equal(matchPermSet({kind: "set", api: "Sales_Ops", ns: "pkg", name: "x"}, right).id, "3");
  assert.equal(matchPermSet({kind: "set", api: "Renamed", ns: "", name: "Sales Ops"}, right), null, "label shared by two");
  assert.equal(matchPermSet({kind: "profile", api: "Other", ns: "", name: "Admin (profile)"}, right).id, "4");
  assert.equal(matchPermSet({kind: "set", api: "Admin", name: "Admin (profile)"}, right), null, "kind must match");
});

test("users: username first, email only when exactly one has it", async () => {
  const {matchUser} = await import("../../addon/core/access.js");
  const {baseUsername} = await import("../../addon/core/manual-steps.js");
  const prod = [{id: "1", username: "ops@acme.com", email: "team@acme.com"}, {id: "2", username: "ana@acme.com", email: "team@acme.com"}];
  // A shared mailbox email must not decide: the username does.
  assert.equal(matchUser({username: "ana@acme.com.uat", email: "team@acme.com"}, prod, baseUsername).id, "2");
  assert.equal(matchUser({username: "new@acme.com.uat", email: "team@acme.com"}, prod, baseUsername), null);
  assert.equal(matchUser({username: "x@y.com", email: "ANA@acme.com"}, [{id: "9", username: "z@y.com", email: "ana@acme.com"}], baseUsername).id, "9");
});

test("users: a tab comes from the sources giving the winning visibility only", async () => {
  const {combineAccess} = await import("../../addon/core/access.js");
  const data = {sets: [{Id: "P"}, {Id: "S"}], tabSettings: [{ParentId: "P", Name: "Invoice", Visibility: "DefaultOff"}, {ParentId: "S", Name: "Invoice", Visibility: "DefaultOn"}]};
  const {origins} = combineAccess(data, ["P", "S"], "U", {P: "Profile: Std", S: "Perm set: Inv"});
  assert.deepEqual(origins["tabs|Invoice"], ["Perm set: Inv"]);
});

test("sharing rules: account access, included owners and XML entities", async () => {
  const {summarizeSharingRule, describeRowDiff} = await import("../../addon/core/access.js");
  const acct = level => "<sharingCriteriaRules><accessLevel>Read</accessLevel>" +
    `<accountSettings><caseAccessLevel>Edit</caseAccessLevel><contactAccessLevel>Read</contactAccessLevel><opportunityAccessLevel>${level}</opportunityAccessLevel></accountSettings>` +
    "<sharedTo><group>R&amp;D</group></sharedTo><criteriaItems><field>Name</field><operation>equals</operation><value>A &lt;&amp;&gt; &quot;B&quot; &apos;C&apos;</value></criteriaItems>" +
    "<includeRecordsOwnedByAll>true</includeRecordsOwnedByAll></sharingCriteriaRules>";
  const a = summarizeSharingRule("SharingCriteriaRule", acct("None"));
  assert.equal(a, "Criteria · Name equals A <&> \"B\" 'C' → Group R&D · Read Only · Case: Read/Write · Contact: Read Only · Opportunity: Private · Includes records owned by all users");
  const b = summarizeSharingRule("SharingCriteriaRule", acct("Read"));
  assert.equal(describeRowDiff("sharingRules", [a, b], ["Prod", "UAT"]), "Prod: Opportunity: Private · UAT: Opportunity: Read Only");
  const owner = "<sharingOwnerRules><accessLevel>Edit</accessLevel><sharedFrom><group>A</group></sharedFrom><sharedTo><group>B</group></sharedTo>" +
    "<includeHVUOwnedRecords>true</includeHVUOwnedRecords></sharingOwnerRules>";
  assert.equal(summarizeSharingRule("SharingOwnerRule", owner), "Owner · Group A → Group B · Read/Write · Includes high-volume users' records");
});
