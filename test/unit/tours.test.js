import {test, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {initSettings, _resetSettingsForTests} from "../../addon/core/storage.js";
import {
  compareVersions, pendingReleaseNotes, markVersionSeen, shouldAutoStart, markTourDone,
  isTourDone, setToursDisabled, resetTours
} from "../../addon/core/tours.js";
import {placeCard} from "../../addon/ui/tour.js";
import {PANEL_TOUR, BUILDER_TOUR, SETTINGS_TOUR, RELEASE_NOTES, tabTour} from "../../addon/ui/tour-content.js";

beforeEach(async () => {
  _resetSettingsForTests();
  delete globalThis.chrome;
  const m = new Map();
  globalThis.localStorage = {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
  await initSettings();
});

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.7.0", "1.7.1"), -1);
});

test("tours auto-start once, and not when switched off", () => {
  assert.equal(shouldAutoStart("panel"), true);
  markTourDone("panel");
  assert.equal(isTourDone("panel"), true);
  assert.equal(shouldAutoStart("panel"), false);
  setToursDisabled(true);
  assert.equal(shouldAutoStart("builder"), false);
  resetTours();
  assert.equal(shouldAutoStart("panel"), true);
});

test("release notes show only after an update, for versions in between", () => {
  const notes = [{version: "1.7.0"}, {version: "1.8.0"}, {version: "2.0.0"}];
  assert.deepEqual(pendingReleaseNotes(notes, "1.8.0"), [], "first install shows nothing");
  markVersionSeen("1.7.0");
  assert.deepEqual(pendingReleaseNotes(notes, "1.7.0"), [], "same version shows nothing");
  assert.deepEqual(pendingReleaseNotes(notes, "2.0.0").map(n => n.version), ["2.0.0", "1.8.0"]);
});

test("placeCard centres untargeted steps and keeps cards on screen", () => {
  const vp = {width: 1000, height: 800};
  const card = {width: 300, height: 150};
  assert.deepEqual(placeCard(null, card, null, vp), {left: 350, top: 325});
  const below = placeCard({left: 100, top: 10, right: 200, bottom: 40, width: 100, height: 30}, card, "bottom", vp);
  assert.equal(below.side, "bottom");
  assert.ok(below.top > 40);
  const nearRight = placeCard({left: 950, top: 10, right: 990, bottom: 40, width: 40, height: 30}, card, "bottom", vp);
  assert.ok(nearRight.left + card.width <= vp.width - 12, "clamped inside the viewport");
  const atBottom = placeCard({left: 400, top: 760, right: 500, bottom: 790, width: 100, height: 30}, card, "bottom", vp);
  assert.equal(atBottom.side, "top", "flips above when there is no room below");
});

test("tour content is well formed", () => {
  for (const tour of [PANEL_TOUR, BUILDER_TOUR, SETTINGS_TOUR]) {
    assert.ok(tour.id && tour.steps.length > 0);
    for (const s of tour.steps) assert.ok(s.title && s.body, `${tour.id}: every step has a title and body`);
  }
  for (const id of ["records", "soql", "apex", "export", "import", "users", "logs", "org", "apptabs", "coverage"]) {
    assert.ok(tabTour(id), `tab tour for ${id}`);
  }
  assert.equal(tabTour("nope"), null);
  assert.ok(RELEASE_NOTES.every(n => n.version && n.items.length));
});
