// Minimal zip reader / writer for Metadata API retrieve and deploy zips.
// Reading uses the zip central directory and the built-in
// DecompressionStream("deflate-raw"); writing stores entries uncompressed
// (method 0), which the Metadata API accepts. No DOM, works in Node 18+.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

export function textToBytes(s) {
  return enc.encode(String(s));
}

export function bytesToText(b) {
  return dec.decode(b);
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Limits for opening a zip: past these it is a zip bomb or not ours.
export const ZIP_MAX_BYTES = 300 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20000;
const TOO_LARGE = "This zip is too large to open here.";

// Inflates at most `limit` bytes: the sizes a zip declares can lie.
async function inflateRaw(bytes, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new Error(TOO_LARGE); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// bytes → Map(path → Uint8Array). Directory entries are skipped. Throws
// before inflating anything when the central directory declares more than
// ZIP_MAX_ENTRIES entries or ZIP_MAX_BYTES uncompressed, and while
// inflating if the real output passes ZIP_MAX_BYTES.
export async function readZip(bytes, {maxBytes = ZIP_MAX_BYTES, maxEntries = ZIP_MAX_ENTRIES} = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end of central directory)");
  const count = view.getUint16(eocd + 10, true);
  if (count > maxEntries) throw new Error(TOO_LARGE);
  const cdStart = view.getUint32(eocd + 16, true);
  // First pass: the central directory alone (sizes as declared).
  const entries = [];
  let declared = 0;
  let p = cdStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = bytesToText(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    declared += size;
    if (declared > maxBytes) throw new Error(TOO_LARGE);
    entries.push({name, method, compSize, localOff});
  }
  const files = new Map();
  let total = 0;
  for (const {name, method, compSize, localOff} of entries) {
    if (localOff + 30 > bytes.length) throw new Error("Corrupt zip entry " + name);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw, maxBytes - total);
    else throw new Error(`Unsupported zip compression (method ${method}) for ${name}`);
    total += data.length;
    if (total > maxBytes) throw new Error(TOO_LARGE);
    files.set(name, data);
  }
  return files;
}

// entries: Map or [[path, Uint8Array|string]] → zip bytes (stored, UTF-8 names).
export function writeZip(entries) {
  const list = [...(entries instanceof Map ? entries.entries() : entries)]
    .map(([path, data]) => [path, typeof data === "string" ? textToBytes(data) : data]);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, data] of list) {
    const name = textToBytes(path);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, list.length, true);
  ev.setUint16(10, list.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Like writeZip, but each entry is deflated when that makes it smaller
// (deploy zips: the API takes at most 39 MB, base64 included).
export async function writeZipCompressed(entries) {
  const list = [...(entries instanceof Map ? entries.entries() : entries)]
    .map(([path, data]) => [path, typeof data === "string" ? textToBytes(data) : data]);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, data] of list) {
    const name = textToBytes(path);
    const crc = crc32(data);
    const packed = data.length > 64 ? await deflateRaw(data) : data;
    const deflated = packed !== data && packed.length < data.length;
    const body = deflated ? packed : data;
    const method = deflated ? 8 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, list.length, true);
  ev.setUint16(10, list.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}
