// Which onboarding tours a user has seen, and the "what's new" check. Stored
// in the shared settings store so the panel and Settings page agree.
import {getSetting, setSetting} from "./storage.js";

const KEY = "sfoc_tours";

function state() {
  const s = getSetting(KEY, null);
  return {
    done: (s && typeof s.done === "object" && s.done) || {},
    disabled: !!(s && s.disabled),
    lastSeenVersion: (s && s.lastSeenVersion) || null
  };
}

function save(next) {
  setSetting(KEY, next);
}

export function isTourDone(id) {
  return !!state().done[id];
}

export function markTourDone(id) {
  const s = state();
  save({...s, done: {...s.done, [id]: Date.now()}});
}

export function toursDisabled() {
  return state().disabled;
}

// "Don't show tips again": stops automatic tours; replay from "?" still works.
export function setToursDisabled(disabled) {
  save({...state(), disabled: !!disabled});
}

// Automatic tours run only when not done and not switched off.
export function shouldAutoStart(id) {
  const s = state();
  return !s.disabled && !s.done[id];
}

export function resetTours() {
  save({...state(), done: {}, disabled: false});
}

// Numeric dotted-version comparison: -1, 0 or 1.
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Release notes to show after an update from lastSeenVersion to current:
// every entry newer than lastSeen and not newer than current, newest first.
// A first install (no lastSeen) shows nothing — the welcome tour covers it.
export function pendingReleaseNotes(notes, currentVersion) {
  const last = state().lastSeenVersion;
  if (!last || compareVersions(currentVersion, last) <= 0) return [];
  return notes
    .filter(n => compareVersions(n.version, last) > 0 && compareVersions(n.version, currentVersion) <= 0)
    .sort((x, y) => compareVersions(y.version, x.version));
}

export function markVersionSeen(version) {
  save({...state(), lastSeenVersion: version});
}

export function lastSeenVersion() {
  return state().lastSeenVersion;
}
