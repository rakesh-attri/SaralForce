import {test} from "node:test";
import assert from "node:assert/strict";
import {readZip, writeZip, writeZipCompressed, textToBytes, bytesToText} from "../../addon/core/zip.js";
import {reidentifyImport} from "../../addon/inspector/shared/release-store.js";

const counter = () => { let n = 0; return prefix => `${prefix}-new${++n}`; };

test("an imported release, its zip and its snapshot get fresh ids", () => {
  const release = {id: "rel-1", zipId: "zip-rel-1", snapshotId: "snap-1", version: "v3", targetHost: "prod.my.salesforce.com", items: ["ApexClass:A"]};
  const snap = {id: "snap-1", orgHost: "prod.my.salesforce.com", kind: "pre-deploy", keys: ["ApexClass:A"]};
  const {release: r, snapshot: s} = reidentifyImport(release, snap, {hasZip: true, makeId: counter(), now: "2026-11-19T00:00:00.000Z"});
  assert.notEqual(r.id, release.id);
  assert.notEqual(r.zipId, release.zipId);
  assert.notEqual(s.id, snap.id);
  // References follow the new ids.
  assert.equal(r.snapshotId, s.id);
  assert.equal(r.zipId, "zip-" + r.id);
  assert.equal(r.imported, true);
  assert.equal(r.importedAt, "2026-11-19T00:00:00.000Z");
  assert.equal(s.imported, true);
  // Everything else is kept; the inputs are not changed.
  assert.equal(r.version, "v3");
  assert.deepEqual(r.items, ["ApexClass:A"]);
  assert.deepEqual(s.keys, ["ApexClass:A"]);
  assert.equal(release.id, "rel-1");
  assert.equal(snap.id, "snap-1");
});

test("an import never points at ids it did not bring", () => {
  // The file names a zip and a snapshot but carries neither: no reference
  // may be left to whatever this browser stores under those ids.
  const {release: r, snapshot: s} = reidentifyImport({id: "rel-1", zipId: "zip-victim", snapshotId: "snap-victim"}, null, {makeId: counter()});
  assert.equal(r.zipId, "");
  assert.equal(r.snapshotId, "");
  assert.equal(s, null);
});

test("each import gets its own ids", () => {
  const make = counter();
  const a = reidentifyImport({id: "rel-1"}, {id: "snap-1"}, {hasZip: true, makeId: make});
  const b = reidentifyImport({id: "rel-1"}, {id: "snap-1"}, {hasZip: true, makeId: make});
  assert.notEqual(a.release.id, b.release.id);
  assert.notEqual(a.release.zipId, b.release.zipId);
  assert.notEqual(a.snapshot.id, b.snapshot.id);
});

// A tiny zip, then its central directory and end record patched to lie.
function craftedZip(patch) {
  const zip = writeZip(new Map([["a.txt", "hello"], ["b.txt", "world"]]));
  const view = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  patch(view, eocd, view.getUint32(eocd + 16, true));
  return zip;
}

test("readZip refuses a zip declaring too many entries", async () => {
  const zip = craftedZip((v, eocd) => { v.setUint16(eocd + 8, 30000, true); v.setUint16(eocd + 10, 30000, true); });
  await assert.rejects(readZip(zip), /too large to open here/);
});

test("readZip refuses a zip declaring too much uncompressed data", async () => {
  // First entry claims 4 GB uncompressed.
  const zip = craftedZip((v, eocd, cd) => v.setUint32(cd + 24, 0xFFFFFFFF, true));
  await assert.rejects(readZip(zip), /too large to open here/);
});

test("readZip stops inflating past the limit even if the sizes lie", async () => {
  const big = new Uint8Array(200000); // compresses to almost nothing
  const zip = await writeZipCompressed(new Map([["big.bin", big]]));
  const view = new DataView(zip.buffer);
  const cd = view.getUint32(zip.length - 22 + 16, true);
  view.setUint32(cd + 24, 10, true); // claims 10 bytes
  await assert.rejects(readZip(zip, {maxBytes: 1000}), /too large to open here/);
});

test("a normal zip still reads, stored and deflated", async () => {
  const files = new Map([["classes/A.cls", "public class A {}"], ["package.xml", "x".repeat(5000)], ["dir/", ""]]);
  for (const zip of [writeZip(files), await writeZipCompressed(files)]) {
    const out = await readZip(zip);
    assert.equal(bytesToText(out.get("classes/A.cls")), "public class A {}");
    assert.equal(bytesToText(out.get("package.xml")), "x".repeat(5000));
    assert.equal(out.has("dir/"), false);
  }
  assert.equal(bytesToText((await readZip(writeZip([["r.json", textToBytes("{}")]]))).get("r.json")), "{}");
});
