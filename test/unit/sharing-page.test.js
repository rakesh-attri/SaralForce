import test from "node:test";
import assert from "node:assert/strict";
import {
  settingsFromXml, settingLabel, summarizeSharingSet, summarizeRestrictionRule,
  buildSharingPageMatrix, sharingPageObjects, describeSharingDiff, sharingPageSummary, shareModel
} from "../../addon/core/sharing-page.js";

const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSettings xmlns="http://soap.sforce.com/2006/04/metadata">
    <enableManagerGroups>true</enableManagerGroups>
    <enableSecureGuestAccess>false</enableSecureGuestAccess>
    <enableBrandNewThing>true</enableBrandNewThing>
</SharingSettings>`;

const SET = `<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <accessMappings><accessLevel>Edit</accessLevel><object>Case</object><objectField>Contact.Id</objectField><userField>Contact.Id</userField></accessMappings>
    <accessMappings><accessLevel>Read</accessLevel><object>Account</object><objectField>Id</objectField><userField>Account.Id</userField></accessMappings>
    <profiles>Customer Community User</profiles>
</SharingSet>`;

const RULE = `<RestrictionRule><active>true</active><enforcementType>Scoping</enforcementType><masterLabel>My Tasks</masterLabel>
<recordFilter>OwnerId = $User.Id</recordFilter><targetEntity>Task</targetEntity><userCriteria>$User.IsActive = true</userCriteria></RestrictionRule>`;

test("Sharing settings XML becomes On / Off rows with Setup's labels", () => {
  const s = settingsFromXml(SETTINGS);
  assert.deepEqual(s, {enableManagerGroups: "On", enableSecureGuestAccess: "Off", enableBrandNewThing: "On"});
  assert.equal(settingLabel("enableManagerGroups"), "Manager groups");
  assert.equal(settingLabel("enableBrandNewThing"), "Brand new thing");
});

test("a sharing set is summarized per object it grants", () => {
  const s = summarizeSharingSet(SET);
  assert.equal(s.Case, "Profiles: Customer Community User · User Contact.Id = Case Contact.Id · Read/Write");
  assert.match(s.Account, /Read Only$/);
});

test("a restriction or scoping rule in a line", () => {
  assert.deepEqual(summarizeRestrictionRule(RULE),
    {object: "Task", label: "My Tasks", text: "Scoping · Active · Users: $User.IsActive = true · Records: OwnerId = $User.Id"});
});

const left = {
  owd: {Account: {label: "Account", internal: "Private", external: "Private"}, Case: {label: "Case", internal: "Public Read/Write", external: "Private"},
    Old__c: {label: "Old", internal: "Private", external: "Private"}},
  settings: {enableManagerGroups: "On"},
  rules: {"Case.Support": "Owner · Group A → All internal users · Read Only", "Case.Open": "Criteria · Status equals Open → Role X · Read/Write"},
  sharingSets: {Cust: {Case: "Profiles: A · User Contact.Id = Case Contact.Id · Read/Write"}},
  restrictionRules: {}
};
const right = {
  owd: {Account: {label: "Account", internal: "Public Read Only", external: "Private"}, Case: {label: "Case", internal: "Public Read/Write", external: "Public Read Only"}},
  settings: {enableManagerGroups: "Off"},
  rules: {"Case.Support": "Owner · Group A → All internal users · Read/Write"},
  sharingSets: {Cust: {Case: "Profiles: A · User Contact.Id = Case Contact.Id · Read Only"}},
  restrictionRules: {Mine: {object: "Task", label: "Mine", text: "Restriction · Active · Users: all · Records: OwnerId = $User.Id"}}
};
const L = ["Dev", "Prod"];

test("the page matrix has every section and flags differences", () => {
  const m = buildSharingPageMatrix([left, right]);
  const by = Object.fromEntries(m.map(s => [s.key, s]));
  assert.deepEqual(by.owd.rows.map(r => [r.key, r.differs]), [["Account", true], ["Case", true], ["Old__c", true]]);
  assert.equal(by.owd.rows.find(r => r.key === "Old__c").sub, "Old__c");
  assert.equal(by.settings.rows[0].label, "Manager groups");
  assert.deepEqual(by.rules.rows.map(r => [r.label, r.group]), [["Open", "Case"], ["Support", "Case"]]);
  assert.equal(by.sharingSets.rows[0].key, "Case · Cust");
  assert.equal(by.restrictionRules.rows[0].group, "Task");
  assert.equal(sharingPageSummary(m).text,
    "8 differences: 3 org-wide defaults, 1 other setting, 2 sharing rules, 1 sharing set, 1 restriction or scoping rule");
});

test("picking an object narrows every section; org-wide settings drop out", () => {
  const m = buildSharingPageMatrix([left, right], "Case");
  const by = Object.fromEntries(m.map(s => [s.key, s]));
  assert.deepEqual(by.owd.rows.map(r => r.key), ["Case"]);
  assert.equal(by.settings.rows.length, 0);
  assert.equal(by.rules.rows.length, 2);
  assert.equal(by.sharingSets.rows.length, 1);
  assert.equal(by.restrictionRules.rows.length, 0);
  assert.deepEqual(sharingPageObjects([left, right]).map(o => o.value), ["Account", "Case", "Old__c", "Task"]);
});

test("what differs, in plain words, left → right", () => {
  assert.equal(describeSharingDiff("owd", [["Private", "Private"], ["Public Read Only", "Private"]], L), "Internal: Private → Public Read Only");
  assert.equal(describeSharingDiff("owd", [["Public Read/Write", "Private"], ["Public Read/Write", "Public Read Only"]], L), "External: Private → Public Read Only");
  assert.equal(describeSharingDiff("owd", [["Private", "Private"], null], L), "Only in Dev");
  assert.equal(describeSharingDiff("settings", ["On", "Off"], L), "On → Off");
  assert.equal(describeSharingDiff("rules", [null, "x"], L), "Only in Prod");
  assert.equal(describeSharingDiff("rules", ["Owner · Group A → All · Read Only", "Owner · Group A → All · Read/Write"], L), "Read Only → Read/Write");
});

test("sharing models read like Setup", () => {
  assert.equal(shareModel("ReadWriteTransfer"), "Public Read/Write/Transfer");
  assert.equal(shareModel("ControlledByParent"), "Controlled by Parent");
  assert.equal(shareModel(""), "");
});
