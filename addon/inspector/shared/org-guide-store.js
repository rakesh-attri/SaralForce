// Org Handbook kept in this browser per org (IndexedDB: no extra permission,
// and room for an org's flows and code, which are too big for localStorage).
// Value: {hb, items, notes, eli5, savedAt}. Failures are quiet: the
// handbook then simply has to be built again.
const DB = "saralforce-org-handbook";
const STORE = "books";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("No IndexedDB")); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

export function loadBook(host) {
  return tx("readonly", s => s.get(String(host || ""))).catch(() => null);
}

export function saveBook(host, value) {
  return tx("readwrite", s => s.put({...value, savedAt: Date.now()}, String(host || ""))).catch(() => null);
}

export function forgetBook(host) {
  return tx("readwrite", s => s.delete(String(host || ""))).catch(() => null);
}
