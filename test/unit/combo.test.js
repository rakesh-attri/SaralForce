import {test} from "node:test";
import assert from "node:assert/strict";

globalThis.React = {createElement: () => null};
const {filterComboOptions} = await import("../../addon/inspector/shared/combo.js");

test("filterComboOptions matches every word across label, sub and value", () => {
  const opts = [
    {value: "standard__Service", label: "Service", sub: "standard__Service"},
    {value: "Service_Console", label: "Service Console", sub: "Service_Console"},
    {value: "Sales", label: "Sales", sub: "standard__Sales"}
  ];
  assert.equal(filterComboOptions(opts, "").length, 3);
  assert.deepEqual(filterComboOptions(opts, "service con").map(o => o.value), ["Service_Console"]);
  assert.deepEqual(filterComboOptions(opts, "STANDARD__sa").map(o => o.value), ["Sales"]);
  assert.equal(filterComboOptions(opts, "zzz").length, 0);
});
