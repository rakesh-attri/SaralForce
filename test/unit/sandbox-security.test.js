// Sandbox Studio must act only on the sandbox org it was asked about, and a
// backup goes back only into the org it was taken from.
import test from "node:test";
import assert from "node:assert/strict";
import {matchSandboxOrg, backupMatchesOrg} from "../../addon/core/sandboxes.js";

const PROD = "acme.my.salesforce.com";
const uat = {name: "UAT", process: {orgId: "00D000000000AAA"}};
const acmeUat = {host: "acme--uat.sandbox.my.salesforce.com", orgId: "00D000000000AAAEA2", isSandbox: true, name: "Acme UAT"};
const clientbUat = {host: "clientb--uat.sandbox.my.salesforce.com", orgId: "00D000000000BBBEA2", isSandbox: true, name: "ClientB UAT"};

test("matchSandboxOrg matches by org id (first 15 characters)", () => {
  const byId = {...acmeUat, host: "something-else.sandbox.my.salesforce.com"};
  assert.equal(matchSandboxOrg([clientbUat, byId], uat, PROD), byId);
});

test("matchSandboxOrg matches by the exact sandbox host", () => {
  const noId = {name: "UAT", process: null};
  assert.equal(matchSandboxOrg([clientbUat, {...acmeUat, orgId: ""}], noId, PROD).host, acmeUat.host);
});

test("matchSandboxOrg never matches another production's same-named sandbox", () => {
  assert.equal(matchSandboxOrg([clientbUat], uat, PROD), null);
  assert.equal(matchSandboxOrg([clientbUat], {name: "UAT", process: null}, PROD), null);
  assert.equal(matchSandboxOrg([{...clientbUat, host: "clientb--uat.sandbox.my.salesforce.com.evil"}], {name: "uat"}, PROD), null);
});

test("matchSandboxOrg returns null when nothing matches", () => {
  assert.equal(matchSandboxOrg([], uat, PROD), null);
  assert.equal(matchSandboxOrg(null, uat, PROD), null);
  assert.equal(matchSandboxOrg([{...acmeUat, isSandbox: false}], uat, PROD), null); // production, not a sandbox
  assert.equal(matchSandboxOrg([{...acmeUat, isGit: true}], uat, PROD), null);
  assert.equal(matchSandboxOrg([acmeUat], {name: "UAT"}, ""), null); // no production host, no org id
});

test("backupMatchesOrg compares org ids, else hosts for older backups", () => {
  assert.equal(backupMatchesOrg({orgId: "00D000000000AAA", orgHost: "x"}, acmeUat), true);
  assert.equal(backupMatchesOrg({orgId: "00D000000000AAAEA2", orgHost: acmeUat.host}, clientbUat), false);
  assert.equal(backupMatchesOrg({orgId: "00D000000000AAA"}, {...acmeUat, orgId: ""}), false);
  assert.equal(backupMatchesOrg({orgHost: acmeUat.host}, acmeUat), true);
  assert.equal(backupMatchesOrg({orgHost: acmeUat.host}, clientbUat), false);
  assert.equal(backupMatchesOrg({}, acmeUat), false);
  assert.equal(backupMatchesOrg(null, acmeUat), false);
});
