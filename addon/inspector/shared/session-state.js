import {sfConn} from "../../inspector.js";

// ─── Shared: per-org localStorage, cached object/describe lists ──
function ffHostKey() {
  try { return sfConn.instanceHostname || "default"; }
  catch (e) { return "default"; }
}

function ffLoadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key + "_" + ffHostKey());
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}

function ffSaveJson(key, val) {
  try { localStorage.setItem(key + "_" + ffHostKey(), JSON.stringify(val)); }
  catch (e) { /* quota, ignore */ }
}

// ── Sidebar session snapshot ────────────────────────────────────────────────
// Minimizing (main SaralForce button) destroys the sidebar iframe, so live
// React state dies with it. App._saveState serializes this snapshot into
// sessionStorage on `sfoc-save-state` and restores it in the constructor on
// reopen — same round-trip the builder chat already uses. Nothing writes the
// key on page refresh, so a refresh of the host page resets everything.
// Ephemeral state (log bodies, loading flags, lookups) stays plain useState
// and is refetched on demand.
let ffRestored = null;
const ffLive = {};

export function ffApplyRestore(snapshot) {
  ffRestored = snapshot && typeof snapshot === "object" ? snapshot : null;
}

function useFfSession(scope, key, initial) {
  const [val, setVal] = React.useState(() => {
    // Live values from this document session win over the reopen snapshot
    // (tabs unmount when switching Builder ⇄ Inspector mid-session).
    const live = ffLive[scope];
    if (live && Object.prototype.hasOwnProperty.call(live, key)) return live[key];
    const src = ffRestored && ffRestored[scope];
    if (src && Object.prototype.hasOwnProperty.call(src, key)) return src[key];
    return typeof initial === "function" ? initial() : initial;
  });
  React.useEffect(() => {
    if (!ffLive[scope]) ffLive[scope] = {};
    ffLive[scope][key] = val;
  }, [val]);
  return [val, setVal];
}

// Dropped first when the snapshot approaches the sessionStorage quota; every
// one of these is either re-fetchable or re-derivable from its sibling keys.
const FF_TRIM_KEYS = {
  soql: ["result"],
  records: ["rows"],
  import: ["csvText", "records"],
  export: ["preview"],
  logs: ["analyses", "chats", "openLog"],
  apex: ["log"]
};

function ffClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Drops the heavy keys BEFORE cloning, so a 50 MB import is never serialised.
function ffTrim(snapshot) {
  const light = {...snapshot};
  for (const [scope, keys] of Object.entries(FF_TRIM_KEYS)) {
    if (!light[scope] || typeof light[scope] !== "object") continue;
    light[scope] = {...light[scope]};
    keys.forEach(k => delete light[scope][k]);
  }
  return ffClone(light);
}

// True when the JSON of val is certainly at least `budget` characters. Counts
// a lower bound (string lengths, key names, one per value) and stops at the
// budget, so the cost is bounded however big the state is.
function ffAtLeast(val, budget) {
  let n = 0;
  const stack = [val];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") n += v.length + 2;
    else if (v && typeof v === "object") {
      if (typeof v.toJSON === "function") n += 2;
      else if (Array.isArray(v)) {
        n += 1 + v.length;
        if (n >= budget) return true;
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
      }
      else {
        n += 2;
        for (const k of Object.keys(v)) {
          const c = v[k];
          if (c === undefined || typeof c === "function" || typeof c === "symbol") continue;
          n += k.length + 3;
          stack.push(c);
        }
      }
    } else n += 1;
    if (n >= budget) return true;
  }
  return false;
}

export function ffTakeSnapshot() {
  // Live values win; scopes never mounted this session keep their restored data.
  const merged = {};
  for (const src of [ffRestored, ffLive]) {
    if (!src) continue;
    for (const [scope, vals] of Object.entries(src)) {
      merged[scope] = {...(merged[scope] || {}), ...vals};
    }
  }
  try {
    // Certainly over the budget: trim without serialising the whole state first.
    if (ffAtLeast(merged, 2000000)) return ffTrim(merged);
    const full = ffClone(merged);
    // Stay well under the 5MB sessionStorage budget for this key.
    if (JSON.stringify(full).length < 2000000) return full;
    return ffTrim(merged);
  } catch (e) {
    try { return ffTrim(merged); } catch (e2) { return null; }
  }
}

export {ffLoadJson, ffSaveJson, useFfSession};
