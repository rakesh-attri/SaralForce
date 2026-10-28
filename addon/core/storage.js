// Extension settings (AI provider config, model cache, preferences) kept in
// chrome.storage.local, shared by every extension page and kept in sync when
// another page (e.g. Settings) saves. Reads are synchronous from an in-memory
// cache, so each page awaits initSettings() once before rendering.
//
// Values that older versions stored in the extension's localStorage are
// moved here on first run and then removed from localStorage.

export const SETTING_KEYS = ["llmConfig", "llmModelCache", "sfoc_celebrate", "sfoc_open_inspector_tab", "sfoc_tours"];

const cache = new Map();
let ready = false;
let initPromise = null;

function storageArea() {
  const area = globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
  return area && typeof area.get === "function" ? area : null;
}

function legacyStore() {
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  } catch (e) {
    return null; // storage disabled
  }
}

// localStorage held JSON for objects and plain strings for the rest.
function parseLegacy(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

function readLegacy(key) {
  const ls = legacyStore();
  const raw = ls ? ls.getItem(key) : null;
  return raw == null ? undefined : parseLegacy(raw);
}

export function initSettings() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const area = storageArea();
    if (!area) {
      // Dev harness / unit tests: no chrome.storage, keep using localStorage.
      for (const key of SETTING_KEYS) {
        const v = readLegacy(key);
        if (v !== undefined) cache.set(key, v);
      }
      ready = true;
      return;
    }
    const stored = await new Promise(resolve => area.get(SETTING_KEYS, items => resolve(items || {})));
    const migrate = {};
    for (const key of SETTING_KEYS) {
      if (stored[key] !== undefined) {
        cache.set(key, stored[key]);
      } else {
        const legacy = readLegacy(key);
        if (legacy !== undefined) {
          cache.set(key, legacy);
          migrate[key] = legacy;
        }
      }
    }
    if (Object.keys(migrate).length) {
      await new Promise(resolve => area.set(migrate, resolve));
      const ls = legacyStore();
      if (ls) for (const key of Object.keys(migrate)) ls.removeItem(key);
    }
    if (globalThis.chrome.storage.onChanged) {
      globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        for (const [key, change] of Object.entries(changes)) {
          if (!SETTING_KEYS.includes(key)) continue;
          if (change.newValue === undefined) cache.delete(key);
          else cache.set(key, change.newValue);
        }
      });
    }
    ready = true;
  })();
  return initPromise;
}

export function getSetting(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  // Before init finishes (or if a page forgot to await it) fall back to a
  // value not yet migrated, rather than reporting "not configured".
  if (!ready) {
    const legacy = readLegacy(key);
    if (legacy !== undefined) return legacy;
  }
  return fallback;
}

export function setSetting(key, value) {
  cache.set(key, value);
  const area = storageArea();
  if (area) {
    area.set({[key]: value});
    return;
  }
  const ls = legacyStore();
  if (ls) {
    try {
      ls.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch (e) { /* quota: the in-memory value still applies this session */ }
  }
}

// Test hook: forget cached state so initSettings() runs again.
export function _resetSettingsForTests() {
  cache.clear();
  ready = false;
  initPromise = null;
}
