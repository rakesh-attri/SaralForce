// Release history logic: versions, rollback plans, drift labels, sizes.
// Pure: storage lives in inspector/shared/release-store.js.
import {splitKey} from "./deploy.js";

// Next version label for a target org: v1, v2… (real deploys only).
export function nextVersion(releases, targetHost) {
  const n = releases.filter(r => r.targetHost === targetHost && r.kind !== "validation").length;
  return "v" + (n + 1);
}

// What a rollback must do, from the release and the snapshot taken just
// before it. snapshotKeys: Set of keys with content in the snapshot;
// missing: keys that did not exist in the target before the release.
//  restore: put the old version back (changed or deleted by the release)
//  remove:  delete what the release added
//  unknown: no record of the old state (cannot be rolled back)
export function rollbackPlan(release, snapshotKeys, missing) {
  const has = k => snapshotKeys.has(k);
  const wasMissing = new Set(missing || []);
  const restore = [];
  const remove = [];
  const unknown = [];
  for (const k of release.items || []) {
    if (has(k)) restore.push(k);
    else if (wasMissing.has(k)) remove.push(k);
    else unknown.push(k);
  }
  for (const k of release.deletes || []) {
    if (has(k)) restore.push(k);
    else unknown.push(k);
  }
  // A field removed with its new object goes with the object.
  const removedObjects = new Set(remove.filter(k => k.startsWith("CustomObject:")).map(k => splitKey(k).fullName));
  const removeFinal = remove.filter(k => {
    const {type, fullName} = splitKey(k);
    return type === "CustomObject" || !removedObjects.has(fullName.split(".")[0]);
  });
  return {restore: [...new Set(restore)], remove: removeFinal, unknown};
}

// Drift: snapshot (then) as "source", live org (now) as "target".
export const DRIFT_LABELS = {
  new: {kind: "err", label: "Removed since"},
  deleted: {kind: "ok", label: "Added since"},
  changed: {kind: "warn", label: "Changed since"},
  same: {kind: "off", label: "Same"}
};

// Restoring selected drift rows: put back removed / changed ones, delete added ones.
export function restoreFromDrift(rows, selected) {
  const restore = [];
  const remove = [];
  for (const r of rows) {
    if (!selected.has(r.key)) continue;
    if (r.status === "deleted") remove.push(r.key); else if (r.status !== "same") restore.push(r.key);
  }
  return {restore, remove};
}

// Small, storable deploy result (no stack traces beyond 2 KB).
export function trimSummary(s) {
  if (!s) return null;
  return {
    status: s.status, success: s.success, checkOnly: s.checkOnly,
    components: s.components, tests: s.tests, errorMessage: s.errorMessage || "",
    componentFailures: (s.componentFailures || []).slice(0, 50),
    testFailures: (s.testFailures || []).slice(0, 30).map(t => ({...t, stackTrace: String(t.stackTrace || "").slice(0, 2000)})),
    coverageWarnings: (s.coverageWarnings || []).slice(0, 30)
  };
}

export function formatBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// The newest release time from an org (for "Changed since last release").
export function lastReleaseAt(releases, sourceHost) {
  const own = releases.filter(r => r.sourceHost === sourceHost && r.kind !== "validation" && r.success);
  if (!own.length) return "";
  return own.map(r => r.at).sort().pop();
}

export function keyLabel(key) {
  const {type, fullName} = splitKey(key);
  return `${type} ${fullName}`;
}
