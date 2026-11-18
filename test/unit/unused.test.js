import {test} from "node:test";
import assert from "node:assert/strict";
import {unusedVerdict, rankUnused, unusedCounts} from "../../addon/core/unused.js";

const f = (name, o) => ({kind: "field", name, refs: 0, code: 0, filled: 0, total: 50, ...o});

test("a field nothing uses and nobody filled in is unused", () => {
  assert.equal(unusedVerdict(f("Old__c")).level, "unused");
});

test("a reference or a mention in code makes it used", () => {
  assert.equal(unusedVerdict(f("A__c", {refs: 2})).level, "used");
  const v = unusedVerdict(f("B__c", {code: 1}));
  assert.equal(v.level, "used");
  assert.match(v.reasons[0], /code of 1/);
});

test("data with no references needs review, with the share filled", () => {
  const v = unusedVerdict(f("C__c", {filled: 10}));
  assert.equal(v.level, "review");
  assert.match(v.reasons[0], /10 record\(s\) have a value \(20%\)/);
  assert.match(unusedVerdict({kind: "object", name: "X__c", refs: 0, code: 0, filled: 3}).reasons[0], /3 record/);
});

test("anything not checked is never called unused", () => {
  assert.equal(unusedVerdict(f("D__c", {refs: null})).level, "unknown");
  assert.equal(unusedVerdict(f("E__c", {code: null})).level, "unknown");
  assert.equal(unusedVerdict(f("F__c", {filled: null})).level, "unknown");
});

test("ranking puts removable items first and counts each level", () => {
  const rows = rankUnused([f("Z__c", {refs: 1}), f("B__c", {filled: 5}), f("A__c"), f("C__c", {refs: null})]);
  assert.deepEqual(rows.map(r => r.name), ["A__c", "B__c", "C__c", "Z__c"]);
  assert.deepEqual(unusedCounts(rows), {unused: 1, review: 1, unknown: 1, used: 1});
});
