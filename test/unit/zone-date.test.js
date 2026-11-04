import {test} from "node:test";
import assert from "node:assert/strict";
import {dateInZone, daysAgoInZone, zoneMidnight, whenInZone} from "../../addon/core/zone-date.js";

// 3 Nov 2026, 00:30 in India = 2 Nov 19:00 UTC.
const now = Date.UTC(2026, 10, 2, 19, 0);

test("today is the org zone's date, not UTC's", () => {
  assert.equal(dateInZone(now, "Asia/Kolkata"), "2026-11-03");
  assert.equal(dateInZone(now, "UTC"), "2026-11-02");
  assert.equal(daysAgoInZone(0, "Asia/Kolkata", now), "2026-11-03");
  assert.equal(daysAgoInZone(7, "Asia/Kolkata", now), "2026-10-27");
});

test("midnight in the org zone", () => {
  assert.equal(new Date(zoneMidnight("2026-11-03", "Asia/Kolkata")).toISOString(), "2026-11-02T18:30:00.000Z");
  assert.equal(new Date(zoneMidnight("2026-11-03", "America/Los_Angeles")).toISOString(), "2026-11-03T08:00:00.000Z");
  // Across the US DST change (1 Nov 2026).
  assert.equal(new Date(zoneMidnight("2026-10-31", "America/Los_Angeles")).toISOString(), "2026-10-31T07:00:00.000Z");
  assert.ok(Number.isNaN(zoneMidnight("", "UTC")));
});

test("when: today / yesterday in the org zone", () => {
  assert.match(whenInZone("2026-11-02T18:45:00Z", "Asia/Kolkata", now), /^today 12:15 am$/);
  assert.match(whenInZone("2026-11-02T12:31:00Z", "Asia/Kolkata", now), /^yesterday 06:01 pm$/);
  assert.equal(whenInZone("2025-01-07T10:00:00Z", "Asia/Kolkata", now), "7 Jan 2025");
});
