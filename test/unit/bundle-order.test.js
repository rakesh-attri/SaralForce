import {test} from "node:test";
import assert from "node:assert/strict";
import {bundleCreateOrder, hasSecurityEnforced, securityEnforcedToUserMode, isSecurityEnforcedError} from "../../addon/core/bundle-order.js";
import {lwcFiles, buildDraft} from "../../addon/core/metadata-templates.js";

test("LWC base .js is created before the template", () => {
  const files = [{path: "lwc/card/card.html"}, {path: "lwc/card/card.css"}, {path: "lwc/card/card.js"}, {path: "lwc/card/utils.js"}];
  assert.deepEqual(bundleCreateOrder(files, "lwc", "card").map(f => f.path),
    ["lwc/card/card.js", "lwc/card/card.html", "lwc/card/utils.js", "lwc/card/card.css"]);
});

test("Aura base definition comes first", () => {
  const files = [{defType: "CONTROLLER"}, {defType: "STYLE"}, {defType: "COMPONENT"}, {defType: "HELPER"}];
  assert.deepEqual(bundleCreateOrder(files, "aura", "x").map(f => f.defType), ["COMPONENT", "CONTROLLER", "HELPER", "STYLE"]);
});

test("WITH SECURITY_ENFORCED is detected and replaced", () => {
  const code = "SELECT Id FROM Account WITH SECURITY_ENFORCED LIMIT 5; [select id from contact with  security_enforced]";
  assert.equal(hasSecurityEnforced(code), true);
  assert.equal(hasSecurityEnforced(code), true);   // no regex state leaks between calls
  const r = securityEnforcedToUserMode(code);
  assert.equal(r.count, 2);
  assert.equal(hasSecurityEnforced(r.code), false);
  assert.match(r.code, /WITH USER_MODE LIMIT 5/);
  assert.equal(isSecurityEnforcedError("INVALID_FIELD_FOR_INSERT_UPDATE: WITH SECURITY_ENFORCED is no longer supported, use WITH USER_MODE instead."), true);
});

test("starter templates no longer use WITH SECURITY_ENFORCED", () => {
  for (const template of ["card", "record", "form", "datatable", "action"]) {
    for (const f of lwcFiles("demoCmp", {template, object: "Account", apiVersion: 62})) {
      assert.equal(hasSecurityEnforced(f.content), false, f.path);
    }
  }
  assert.ok(buildDraft);
});
