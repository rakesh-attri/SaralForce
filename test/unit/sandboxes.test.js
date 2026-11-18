import test from "node:test";
import assert from "node:assert/strict";
import {
  sandboxNameError, mergeSandboxes, statusGroup, ageDays, ageTone, staleRows, nextRefresh, statsOf, myDomainOf, loginUrl,
  sandboxBody, stripInvalid, isInvalidEmail, endpointKind, flowOutsideReasons, restoreOrder, restoreRecord, addIds, licenseOf
} from "../../addon/core/sandboxes.js";

const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString().replace("Z", "+0000");
const now = Date.parse("2026-11-17T12:00:00Z");

const infos = [
  {Id: "0GQ1", SandboxName: "Dev", LicenseType: "PARTIAL", CreatedDate: iso(now - 200 * DAY), AutoActivate: false},
  {Id: "0GQ2", SandboxName: "NxtPayDev", LicenseType: "DEVELOPER", CreatedDate: iso(now - 300 * DAY)},
  {Id: "0GQ3", SandboxName: "UAT", LicenseType: "FULL", CreatedDate: iso(now - 50 * DAY)},
];
const procs = [
  {Id: "0GR1a", SandboxInfoId: "0GQ1", Status: "Completed", StartDate: iso(now - 100 * DAY), ActivatedDate: iso(now - 99 * DAY)},
  {Id: "0GR1b", SandboxInfoId: "0GQ1", Status: "Completed", StartDate: iso(now - 49 * DAY), EndDate: iso(now - 48.5 * DAY), ActivatedDate: iso(now - 48 * DAY)},
  {Id: "0GR2", SandboxInfoId: "0GQ2", Status: "Pending Activation", StartDate: iso(now - 0.5 * DAY), EndDate: iso(now - 0.2 * DAY)},
  {Id: "0GR3", SandboxInfoId: "0GQ3", Status: "Processing", CopyProgress: 42, StartDate: iso(now - 0.1 * DAY)},
];

test("sandbox name rules", () => {
  assert.equal(sandboxNameError("uat2"), null);
  assert.match(sandboxNameError("2uat"), /start with a letter/);
  assert.match(sandboxNameError("my_dev"), /Only letters and digits/);
  assert.match(sandboxNameError("abcdefghijk"), /10 characters/);
  assert.match(sandboxNameError("Dev", ["dev"]), /already exists/);
  assert.match(sandboxNameError(""), /name/);
});

test("rows: latest process, history, status groups, ages, stats", () => {
  const rows = mergeSandboxes(infos, procs);
  assert.deepEqual(rows.map(r => r.name), ["Dev", "NxtPayDev", "UAT"]);
  const dev = rows[0];
  assert.equal(dev.process.id, "0GR1b");
  assert.equal(dev.history.length, 2);
  assert.equal(ageDays(dev, now), 48);
  assert.equal(ageTone(48), "warn");
  assert.equal(ageTone(120), "err");
  assert.equal(rows[1].process.group, "activation");
  assert.equal(rows[2].process.progress, 42);
  assert.equal(statusGroup("Deleting"), "deleted");
  assert.equal(statusGroup("Stopped"), "problem");
  assert.deepEqual(statsOf(rows), {total: 3, DEVELOPER: 1, "DEVELOPER PRO": 0, PARTIAL: 1, FULL: 1, processing: 1, activation: 1});
  assert.deepEqual(staleRows(rows, {now}).map(r => r.name), ["Dev"]);
});

test("next refresh follows Salesforce's interval per license", () => {
  const rows = mergeSandboxes(infos, procs);
  const dev = rows[0];
  assert.equal(nextRefresh(dev, now).allowed, true);
  const full = {...rows[2], process: {...rows[2].process, started: now - 3 * DAY}};
  const n = nextRefresh(full, now);
  assert.equal(n.allowed, false);
  assert.equal(n.days, 29);
  assert.equal(licenseOf("developer pro").refreshDays, 1);
});

test("login URLs: enhanced domain or test.salesforce.com", () => {
  assert.equal(myDomainOf("nexturninc2.my.salesforce.com"), "nexturninc2");
  assert.equal(myDomainOf("acme.lightning.force.com"), "acme");
  assert.equal(loginUrl({name: "NxtPayDev"}, {prodHost: "nexturninc2.my.salesforce.com"}), "https://nexturninc2--nxtpaydev.sandbox.my.salesforce.com");
  assert.equal(loginUrl({name: "Dev"}, {style: "test", prodHost: "x.my.salesforce.com"}), "https://test.salesforce.com");
});

test("create / clone / refresh bodies", () => {
  assert.deepEqual(sandboxBody({name: "QA1", license: "developer", description: "QA", autoActivate: false}),
    {AutoActivate: false, Description: "QA", ApexClassId: null, ActivationUserGroupId: null, SandboxName: "QA1", LicenseType: "DEVELOPER"});
  const full = sandboxBody({name: "UAT", license: "FULL", historyDays: "30", copyChatter: true, templateId: "1ps1", apexClassId: "01p1"});
  assert.equal(full.HistoryDays, 30);
  assert.equal(full.CopyChatter, true);
  assert.equal(full.TemplateId, "1ps1");
  assert.equal(full.ApexClassId, "01p1");
  const clone = sandboxBody({name: "Dev2", sourceId: "0GQ1"}, "clone");
  assert.equal(clone.SourceId, "0GQ1");
  assert.ok(!("LicenseType" in clone));
  const refresh = sandboxBody({license: "PARTIAL", autoActivate: true, templateId: "1ps2"}, "refresh");
  assert.ok(!("SandboxName" in refresh));
  assert.equal(refresh.LicenseType, "PARTIAL");
  assert.equal(refresh.AutoActivate, true);
});

test("post-refresh: .invalid emails, production endpoints, flows that reach out", () => {
  assert.equal(stripInvalid("priya@acme.com.invalid"), "priya@acme.com");
  assert.equal(isInvalidEmail("x@y.com.INVALID"), true);
  assert.equal(endpointKind("https://api.payments.com/v2"), "prod");
  assert.equal(endpointKind("https://sandbox.payments.com"), "sandbox");
  assert.equal(endpointKind("https://acme.my.salesforce.com/services", {prodHost: "acme.my.salesforce.com"}), "prod");
  assert.equal(endpointKind("https://acme--uat.sandbox.my.salesforce.com", {prodHost: "acme.my.salesforce.com"}), "sandbox");
  assert.equal(endpointKind("https://partner.example.com"), "unknown");
  const r = flowOutsideReasons({actionCalls: [{actionType: "emailAlert", label: "Tell owner"}, {actionType: "apex", actionName: "PayGateway"}, {actionType: "assignment"}]});
  assert.deepEqual(r, ["email alert \"Tell owner\"", "runs Apex PayGateway (may call out)"]);
  assert.deepEqual(flowOutsideReasons({recordUpdates: [{}]}), []);
});

test("data restore: parents first, lookups remapped to new ids", () => {
  const order = restoreOrder([
    {name: "Contact", refs: [{field: "AccountId", to: ["Account"]}]},
    {name: "Case", refs: [{field: "AccountId", to: ["Account"]}, {field: "ContactId", to: ["Contact"]}]},
    {name: "Account", refs: [{field: "ParentId", to: ["Account"]}, {field: "OwnerId", to: ["User"]}]},
  ]);
  assert.deepEqual(order, ["Account", "Contact", "Case"]);
  const idMap = new Map();
  addIds(idMap, [{Id: "001A"}, {Id: "001B"}], [{success: true, id: "001X"}, {success: false}]);
  assert.equal(idMap.get("001A"), "001X");
  assert.equal(idMap.has("001B"), false);
  const rec = restoreRecord({Id: "003A", LastName: "Nair", AccountId: "001A", OwnerId: "005Q", Email: ""},
    {fields: ["LastName", "AccountId", "OwnerId", "Email"], refs: [{field: "AccountId", to: ["Account"]}], idMap});
  assert.deepEqual(rec, {LastName: "Nair", AccountId: "001X", OwnerId: "005Q"});
});

test("a sandbox still copying or waiting for activation keeps the age of the copy in use", () => {
  const rows = mergeSandboxes(
    [{Id: "A", SandboxName: "UAT", LicenseType: "FULL", CreatedDate: iso(now - 400 * DAY)}],
    [{Id: "p1", SandboxInfoId: "A", Status: "Completed", StartDate: iso(now - 120 * DAY), ActivatedDate: iso(now - 118 * DAY)},
      {Id: "p2", SandboxInfoId: "A", Status: "Pending Activation", StartDate: iso(now - 2 * DAY), EndDate: iso(now - DAY)}]);
  assert.equal(rows[0].process.group, "activation");
  assert.equal(ageDays(rows[0], now), 118);
});
