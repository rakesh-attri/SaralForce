// Calendar dates in a given IANA time zone (the Salesforce user's zone),
// independent of the browser's own zone. Pure; uses Intl only.

function parts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// Offset of `tz` from UTC at instant `ms`, in milliseconds.
function offsetAt(ms, tz) {
  const o = parts(ms, tz);
  const asUtc = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour), Number(o.minute), Number(o.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "YYYY-MM-DD" of instant `ms` in `tz`.
export function dateInZone(ms, tz) {
  const o = parts(ms, tz);
  return `${o.year}-${o.month}-${o.day}`;
}

// Today minus `days`, as "YYYY-MM-DD" in `tz`.
export function daysAgoInZone(days, tz, now = Date.now()) {
  const today = dateInZone(now, tz);
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return t.toISOString().slice(0, 10);
}

// Epoch ms of 00:00 on "YYYY-MM-DD" in `tz` (DST-safe).
export function zoneMidnight(dateStr, tz) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - offsetAt(guess, tz);
  ms = guess - offsetAt(ms, tz);
  return ms;
}

// "today 06:01 pm" / "2 Nov 11:40 am" / "12 Mar 2025" in `tz`.
export function whenInZone(iso, tz, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const day = dateInZone(ms, tz);
  const time = new Intl.DateTimeFormat("en-GB", {timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true}).format(new Date(ms)).toLowerCase();
  if (day === dateInZone(now, tz)) return "today " + time;
  if (day === daysAgoInZone(1, tz, now)) return "yesterday " + time;
  const old = now - ms > 300 * 86400e3;
  const date = new Intl.DateTimeFormat("en-GB", {timeZone: tz, day: "numeric", month: "short", ...(old ? {year: "numeric"} : {})}).format(new Date(ms));
  return old ? date : `${date} ${time}`;
}
