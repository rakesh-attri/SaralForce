// Release history storage in IndexedDB (this browser only): releases,
// snapshots and their zips. Zips live in a separate store so lists stay
// light; everything can be exported and imported as a .zip.
import {writeZip, readZip, textToBytes, bytesToText} from "../../core/zip.js";
import {componentsFromZip} from "../../core/deploy.js";

const DB = "saralforce-release";
const VERSION = 3;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("releases")) db.createObjectStore("releases", {keyPath: "id"});
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", {keyPath: "id"});
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", {keyPath: "id"});
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", {keyPath: "id"});
      if (!db.objectStoreNames.contains("session")) db.createObjectStore("session", {keyPath: "id"});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error || new Error("Could not open release history")); };
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage full or blocked"));
  });
}

export function newId(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

const byNewest = list => (list || []).sort((a, b) => String(b.at).localeCompare(String(a.at)));

export async function listReleases() {
  return byNewest(await tx("releases", "readonly", s => s.getAll()));
}

export function putRelease(r) {
  return tx("releases", "readwrite", s => s.put(r));
}

export async function deleteRelease(id, {withBlobs = true} = {}) {
  const r = await tx("releases", "readonly", s => s.get(id));
  await tx("releases", "readwrite", s => s.delete(id));
  if (withBlobs && r && r.zipId) await tx("blobs", "readwrite", s => s.delete(r.zipId));
}

export async function listSnapshots() {
  return byNewest(await tx("snapshots", "readonly", s => s.getAll()));
}

export async function getSnapshot(id) {
  return tx("snapshots", "readonly", s => s.get(id));
}

export async function deleteSnapshot(id) {
  await tx("snapshots", "readwrite", s => s.delete(id));
  await tx("blobs", "readwrite", s => s.delete(id));
}

export async function saveBytes(id, bytes) {
  await tx("blobs", "readwrite", s => s.put({id, data: new Blob([bytes], {type: "application/zip"})}));
}

export async function loadBytes(id) {
  const row = await tx("blobs", "readonly", s => s.get(id));
  if (!row || !row.data) return null;
  return new Uint8Array(await row.data.arrayBuffer());
}

// files: Map(path → bytes). meta: {orgHost, orgName, label, kind, keys, missing, types}
export async function saveSnapshot(meta, files) {
  const zip = writeZip(files);
  const snap = {...meta, id: meta.id || newId("snap"), at: meta.at || new Date().toISOString(), size: zip.length, files: files.size};
  await saveBytes(snap.id, zip);
  await tx("snapshots", "readwrite", s => s.put(snap));
  return snap;
}

// Snapshot zip → components (componentsFromZip shape).
export async function snapshotComponents(id) {
  const bytes = await loadBytes(id);
  if (!bytes) throw new Error("The snapshot files are missing from this browser.");
  return componentsFromZip(await readZip(bytes), bytesToText);
}

export async function usage() {
  try {
    const e = await navigator.storage.estimate();
    return {used: e.usage || 0, quota: e.quota || 0};
  } catch (err) {
    return {used: 0, quota: 0};
  }
}

// One release (and its rollback snapshot) as a portable zip.
export async function exportRelease(release) {
  const files = new Map([["release.json", textToBytes(JSON.stringify(release, null, 2))]]);
  if (release.zipId) {
    const b = await loadBytes(release.zipId);
    if (b) files.set("deployed.zip", b);
  }
  if (release.snapshotId) {
    const snap = await getSnapshot(release.snapshotId);
    const b = await loadBytes(release.snapshotId);
    if (snap && b) {
      files.set("snapshot.json", textToBytes(JSON.stringify(snap, null, 2)));
      files.set("snapshot.zip", b);
    }
  }
  return writeZip(files);
}

export async function importRelease(bytes) {
  const files = await readZip(bytes);
  const json = files.get("release.json");
  if (!json) throw new Error("Not a SaralForce release file (no release.json).");
  const release = JSON.parse(bytesToText(json));
  if (!release || !release.id) throw new Error("The release file is damaged.");
  if (files.get("deployed.zip") && release.zipId) await saveBytes(release.zipId, files.get("deployed.zip"));
  if (files.get("snapshot.json") && files.get("snapshot.zip")) {
    const snap = JSON.parse(bytesToText(files.get("snapshot.json")));
    await saveBytes(snap.id, files.get("snapshot.zip"));
    await tx("snapshots", "readwrite", s => s.put(snap));
  }
  await putRelease({...release, imported: true});
  return release;
}

// Draft deployments: a saved selection to reuse ({id, name, at, members, destructive, sourceName}).
export async function listDrafts() {
  return byNewest(await tx("drafts", "readonly", st => st.getAll()));
}

export function putDraft(d) {
  return tx("drafts", "readwrite", st => st.put({...d, id: d.id || newId("draft"), at: d.at || new Date().toISOString()}));
}

export function deleteDraft(id) {
  return tx("drafts", "readwrite", st => st.delete(id));
}

// The Release tab's working state (compare results, selection, running
// deploy…) for one page load, so minimize / maximize brings it back.
export function putSession(id, value) {
  return tx("session", "readwrite", st => st.put({id, value, at: Date.now()}));
}

export async function getSession(id) {
  const row = await tx("session", "readonly", st => st.get(id));
  return row ? row.value : null;
}

// Old page loads' state is useless: keep only the newest few. A page load
// can have several records ("id" and "id#compare"); they go together.
export async function pruneSessions(keep = 3) {
  const all = await tx("session", "readonly", st => st.getAll());
  const base = id => String(id).split("#")[0];
  const newest = new Map();
  for (const r of all || []) newest.set(base(r.id), Math.max(newest.get(base(r.id)) || 0, r.at));
  const keepIds = new Set([...newest.entries()].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([id]) => id));
  for (const r of all || []) if (!keepIds.has(base(r.id))) await tx("session", "readwrite", st => st.delete(r.id));
}
