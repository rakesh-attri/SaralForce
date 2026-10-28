// Pure helpers for Bulk API 2.0 result handling. No chrome/window/DOM access
// so they can be unit-tested with `node --test`.

// Salesforce returns the literal string "null" in Sforce-Locator when no
// more result chunks remain.
export function normalizeLocator(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === "null") return null;
  return s;
}

// Index just past the first record terminator (LF, CRLF or lone CR) that is
// outside double quotes, or -1 if the text holds a single unterminated record.
function endOfFirstRecord(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A doubled quote inside a quoted field toggles twice, which is a no-op.
      inQuotes = !inQuotes;
    } else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") return i + 2;
      return i + 1;
    }
  }
  return -1;
}

// Merge Bulk 2.0 result chunks: every chunk repeats the header row, so keep
// the first header and drop it from each later chunk.
export function mergeCsvChunks(chunks) {
  let out = "";
  let haveHeader = false;
  for (const raw of chunks || []) {
    const chunk = raw == null ? "" : String(raw);
    if (!chunk) continue;
    if (!haveHeader) {
      out = chunk;
      haveHeader = true;
      continue;
    }
    const cut = endOfFirstRecord(chunk);
    if (cut === -1) continue; // header only, no terminator
    const body = chunk.slice(cut);
    if (!body) continue;
    if (out && !/[\r\n]$/.test(out)) out += /\r\n/.test(out) ? "\r\n" : "\n";
    out += body;
  }
  return out;
}

// Number of data records (excluding the header) in a CSV text, honouring
// quoted fields that contain line breaks. Blank lines are not counted.
export function countCsvRecords(text) {
  const s = text == null ? "" : String(text);
  let records = 0;
  let inQuotes = false;
  let lineHasContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      lineHasContent = true;
    } else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && s[i + 1] === "\n") i++;
      if (lineHasContent) records++;
      lineHasContent = false;
    } else {
      lineHasContent = true;
    }
  }
  if (lineHasContent) records++;
  return Math.max(0, records - 1);
}
