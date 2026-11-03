import {test} from "node:test";
import assert from "node:assert/strict";
import {explainTabAccess, bestTabSetting, tabAccessReport} from "../../addon/core/tab-access.js";

const ok = {
  tab: {exists: true, label: "Home Pages"},
  tabSettings: [{visibility: "DefaultOn", parent: "X00ex", ownedByProfile: true}],
  objectPerms: [{read: true, parent: "System Administrator"}],
  viewAllData: false,
  inLauncher: true
};
const byKey = (r, k) => r.items.find(i => i.key === k);

test("all good", () => {
  const r = explainTabAccess(ok);
  assert.equal(r.ok, true);
  assert.match(byKey(r, "visible").detail, /your profile/);
});

test("no tab", () => {
  const r = explainTabAccess({...ok, tab: {exists: false}, inLauncher: false});
  assert.equal(byKey(r, "tab").fix, "create-tab");
  assert.equal(r.ok, false);
});

test("tab hidden on profile", () => {
  const r = explainTabAccess({...ok, tabSettings: [{visibility: "Hidden", parent: "X00ex", ownedByProfile: true}], inLauncher: false});
  assert.equal(byKey(r, "visible").ok, false);
  assert.equal(byKey(r, "visible").fix, "make-visible");
  assert.match(byKey(r, "launcher").detail, /Fix the items above/);
});

test("no tab setting at all counts as hidden", () => {
  const r = explainTabAccess({...ok, tabSettings: [], inLauncher: false});
  assert.match(byKey(r, "visible").detail, /No tab setting/);
});

test("visible only via a permission set", () => {
  const r = explainTabAccess({...ok, tabSettings: [{visibility: "Hidden", parent: "X00ex", ownedByProfile: true}, {visibility: "DefaultOn", parent: "Home_Page_Access", ownedByProfile: false}]});
  assert.equal(byKey(r, "visible").ok, true);
  assert.match(byKey(r, "visible").detail, /permission set Home_Page_Access/);
  assert.equal(bestTabSetting([{visibility: "DefaultOff"}, {visibility: "DefaultOn"}]).visibility, "DefaultOn");
});

test("no object access, unless View All Data", () => {
  const none = explainTabAccess({...ok, objectPerms: []});
  assert.equal(byKey(none, "object").fix, "grant-object");
  const admin = explainTabAccess({...ok, objectPerms: [], viewAllData: true});
  assert.equal(byKey(admin, "object").ok, true);
  assert.equal(byKey(admin, "object").detail, "View All Data");
});

test("everything set but not in the launcher yet asks for a refresh", () => {
  const r = explainTabAccess({...ok, inLauncher: false});
  assert.match(byKey(r, "launcher").detail, /Save in Setup/);
  assert.equal(byKey(r, "launcher").fix, "resave-tab");
  assert.equal(explainTabAccess({...ok, inLauncher: null}).items.some(i => i.key === "launcher"), false);
});

test("app membership and report", () => {
  const r = explainTabAccess({...ok, app: {label: "Sales", onApp: false}});
  assert.equal(byKey(r, "app").fix, "add-to-app");
  assert.match(tabAccessReport("Home_Page__c", ok), /OK  Tab visible to you/);
});

test("app line explains why an app tab is not in the nav bar yet", () => {
  const notYet = explainTabAccess({...ok, inLauncher: false, app: {label: "Service", onApp: true}});
  assert.match(byKey(notYet, "app").detail, /once the tab is available/);
  const ready = explainTabAccess({...ok, app: {label: "Service", onApp: true}});
  assert.match(byKey(ready, "app").detail, /personalized/);
});
