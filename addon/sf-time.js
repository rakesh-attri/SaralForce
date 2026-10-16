// Central Salesforce date-time helper for SaralForce.
// Salesforce REST returns datetimes in UTC ISO like `2026-10-16T06:00:59.000+0000`
// and dates as `YYYY-MM-DD`. Salesforce UI displays datetimes in the
// *authenticated user's* TimeZoneSidKey (e.g. Asia/Kolkata), not in UTC and
// not necessarily in the browser's local zone.
//
// Rules enforced here:
// - Parse each timestamp exactly once (normalize `+0000` -> `+00:00` first).
// - Never apply manual hour offsets and never hardcode `+05:30`.
// - Date-only values are returned verbatim, never shifted.
// - Formatting uses `Intl.DateTimeFormat` with the Salesforce IANA zone so
//   UTC, IST, other zones and DST are all handled by the platform.
// - CSV/export keeps raw ISO; only on-screen display is localized.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

let _cachedTimeZone = null;
let _cachedLocale = null;
let _fetchPromise = null;

function browserTimeZoneFallback() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch (e) { /* ignore */ }
  return "UTC";
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: tz});
    return true;
  } catch (e) {
    return false;
  }
}

export function isDateOnlyString(v) {
  return typeof v === "string" && DATE_ONLY_RE.test(v.trim());
}

export function looksLikeSfDateTime(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s || isDateOnlyString(s)) return false;
  return DATETIME_RE.test(s);
}

// Salesforce uses `+0000` (no colon) which `Date.parse` rejects in some
// browsers. Normalize to `+00:00` / `Z` before the single parse.
export function normalizeSfInstantString(s) {
  if (s == null) return s;
  let str = String(s).trim();
  // `2026-10-16T06:00:59.000+0000` -> `2026-10-16T06:00:59.000+00:00`
  str = str.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3");
  return str;
}

// Parse exactly once. Returns a Date instant or null.
export function parseSfInstant(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (isDateOnlyString(s)) return null; // date-only must not go through instant path
  const normalized = normalizeSfInstantString(s);
  const t = Date.parse(normalized);
  if (isNaN(t)) return null;
  return new Date(t);
}

export function getCachedTimeZone() {
  return _cachedTimeZone || null;
}

export function getCachedLocale() {
  return _cachedLocale || null;
}

export function setCachedTimeZone(timeZone, locale) {
  if (timeZone && isValidTimeZone(timeZone)) _cachedTimeZone = timeZone;
  if (locale && typeof locale === "string" && locale.trim()) _cachedLocale = locale.trim();
}

export function getEffectiveTimeZone() {
  return _cachedTimeZone && isValidTimeZone(_cachedTimeZone)
    ? _cachedTimeZone
    : browserTimeZoneFallback();
}

export function getEffectiveLocale() {
  if (!_cachedLocale) return undefined;
  // `en_US` -> `en-US` for Intl.
  const mapped = String(_cachedLocale).replace(/_/g, "-");
  try {
    new Intl.DateTimeFormat(mapped);
    return mapped;
  } catch (e) {
    return undefined;
  }
}

function sfHostKey(sfConn) {
  try {
    return (sfConn && sfConn.instanceHostname) || "default";
  } catch (e) {
    return "default";
  }
}

function readCache(hostKey) {
  try {
    const raw = localStorage.getItem(hostKey + "_sf_timeZone");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.timeZone && isValidTimeZone(obj.timeZone)) return obj;
  } catch (e) { /* ignore */ }
  return null;
}

function writeCache(hostKey, timeZone, locale) {
  try {
    localStorage.setItem(hostKey + "_sf_timeZone", JSON.stringify({timeZone, locale, ts: Date.now()}));
  } catch (e) { /* quota, ignore */ }
}

// Fetch the authenticated Salesforce user's TimeZoneSidKey.
// Priority: User.TimeZoneSidKey -> Organization TimeZone -> browser TZ.
// Never hardcodes an offset. Result is cached per org.
export async function ensureSfTimeZone(sfConn, apiVersion) {
  if (_cachedTimeZone && isValidTimeZone(_cachedTimeZone)) {
    return {timeZone: _cachedTimeZone, locale: _cachedLocale};
  }
  const hostKey = sfHostKey(sfConn);
  const cached = readCache(hostKey);
  if (cached) {
    _cachedTimeZone = cached.timeZone;
    _cachedLocale = cached.locale || null;
    return {timeZone: _cachedTimeZone, locale: _cachedLocale};
  }
  if (_fetchPromise) {
    try { await _fetchPromise; } catch (e) { /* ignore */ }
    if (_cachedTimeZone) return {timeZone: _cachedTimeZone, locale: _cachedLocale};
  }
  _fetchPromise = (async () => {
    // 1. Resolve user id.
    let userId = null;
    let userRecord = null;
    try {
      const me = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/me`, {useCache: false});
      userId = (me && (me.Id || me.user_id)) || null;
      if (me && (me.TimeZoneSidKey || me.LocaleSidKey)) userRecord = me;
    } catch (e) { /* fall through to userinfo */ }
    if (!userId) {
      try {
        const r = await fetch("https://" + sfConn.instanceHostname + "/services/oauth2/userinfo", {
          headers: {Authorization: "Bearer " + sfConn.sessionId}
        });
        if (r.ok) {
          const info = await r.json();
          userId = info.user_id || info.userId || null;
          if (!userId && info.sub) userId = String(info.sub).split("/").pop();
        }
      } catch (e) { /* ignore */ }
    }
    // 2. User's configured time zone (source of truth, not org default).
    if (userId && /^[a-zA-Z0-9]{15,18}$/.test(String(userId))) {
      try {
        const u = await sfConn.rest(
          `/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT TimeZoneSidKey, LocaleSidKey FROM User WHERE Id = '${userId}' LIMIT 1`),
          {useCache: false});
        const row = u.records && u.records[0];
        if (row && row.TimeZoneSidKey && isValidTimeZone(row.TimeZoneSidKey)) {
          _cachedTimeZone = row.TimeZoneSidKey;
          _cachedLocale = row.LocaleSidKey || _cachedLocale;
          writeCache(hostKey, _cachedTimeZone, _cachedLocale);
          return;
        }
      } catch (e) { /* fall through to org default */ }
    } else if (userRecord) {
      if (userRecord.TimeZoneSidKey && isValidTimeZone(userRecord.TimeZoneSidKey)) {
        _cachedTimeZone = userRecord.TimeZoneSidKey;
        _cachedLocale = userRecord.LocaleSidKey || _cachedLocale;
        writeCache(hostKey, _cachedTimeZone, _cachedLocale);
        return;
      }
    }
    // 3. Org default time zone (fallback only, per requirements).
    try {
      const o = await sfConn.rest(
        `/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent("SELECT TimeZoneSidKey, DefaultLocaleSidKey FROM Organization LIMIT 1"),
        {useCache: false});
      const org = o.records && o.records[0];
      if (org && org.TimeZoneSidKey && isValidTimeZone(org.TimeZoneSidKey)) {
        _cachedTimeZone = org.TimeZoneSidKey;
        _cachedLocale = _cachedLocale || org.DefaultLocaleSidKey || null;
        writeCache(hostKey, _cachedTimeZone, _cachedLocale);
        return;
      }
    } catch (e) { /* ignore, use browser */ }
    // 4. Browser zone as last resort (never UTC-hardcoded blindly).
    _cachedTimeZone = browserTimeZoneFallback();
    writeCache(hostKey, _cachedTimeZone, _cachedLocale);
  })();
  try { await _fetchPromise; } finally { _fetchPromise = null; }
  return {timeZone: _cachedTimeZone, locale: _cachedLocale};
}

// Display an SF datetime in Salesforce-UI style in the user's SF time zone:
// `10/16/2026, 11:30 AM`. Date-only values pass through untouched.
export function formatSfDateTime(value, opts) {
  if (value == null || value === "") return "";
  const s = String(value);
  if (isDateOnlyString(s)) return s.slice(0, 10);
  const d = value instanceof Date ? value : parseSfInstant(s);
  if (!d) return s;
  const o = opts || {};
  const timeZone = (o.timeZone && isValidTimeZone(o.timeZone)) ? o.timeZone : getEffectiveTimeZone();
  const locale = o.locale || getEffectiveLocale();
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    }).format(d);
  } catch (e) {
    return d.toLocaleString(locale, {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }
}

// Date-only display: never convert, never shift days.
export function formatSfDate(value) {
  if (value == null || value === "") return "";
  return String(value).slice(0, 10);
}

// IANA zone offset (ms) at an instant: positive east of UTC.
export function getTimeZoneOffsetMs(timeZone, date) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    const parts = dtf.formatToParts(date);
    const get = (t) => {
      const p = parts.find(x => x.type === t);
      return p ? parseInt(p.value, 10) : 0;
    };
    const wallAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return wallAsUTC - date.getTime();
  } catch (e) {
    return -date.getTimezoneOffset() * 60000;
  }
}

function partsInTimeZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = dtf.formatToParts(date);
  const get = (t) => (parts.find(x => x.type === t) || {}).value;
  return {y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute")};
}

// Render an instant as `YYYY-MM-DDTHH:mm` wall time in the SF time zone for
// `datetime-local` inputs. Single conversion, no browser-local shift.
export function formatSfInstantForInput(value, opts) {
  const d = value instanceof Date ? value : parseSfInstant(value);
  if (!d) return String(value == null ? "" : value).slice(0, 16);
  const o = opts || {};
  const timeZone = (o.timeZone && isValidTimeZone(o.timeZone)) ? o.timeZone : getEffectiveTimeZone();
  try {
    const p = partsInTimeZone(d, timeZone);
    const hh = String(p.hh) === "24" ? "00" : String(p.hh).padStart(2, "0");
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T${hh}:${String(p.mm).padStart(2, "0")}`;
  } catch (e) {
    const q = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())}T${q(d.getHours())}:${q(d.getMinutes())}`;
  }
}

// Interpret a `datetime-local` wall string as SF-zone wall time and return
// UTC ISO. This inverts formatSfInstantForInput without double conversion.
export function parseSfWallInputToIso(wall, opts) {
  const s = String(wall == null ? "" : wall).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    if (isNaN(t)) throw new Error(`"${s}" is not a valid date/time.`);
    return new Date(t).toISOString();
  }
  const o = opts || {};
  const timeZone = (o.timeZone && isValidTimeZone(o.timeZone)) ? o.timeZone : getEffectiveTimeZone();
  const y = +m[1], mo = +m[2], day = +m[3], hh = +m[4], mm = +m[5], ss = +(m[6] || 0);
  // Treat wall as UTC, then subtract the SF-zone offset at that guess.
  // One refinement pass handles DST transitions robustly.
  let guess = Date.UTC(y, mo - 1, day, hh, mm, ss);
  for (let i = 0; i < 2; i++) {
    const off = getTimeZoneOffsetMs(timeZone, new Date(guess));
    guess = Date.UTC(y, mo - 1, day, hh, mm, ss) - off;
  }
  if (isNaN(guess)) throw new Error(`"${s}" is not a valid date/time.`);
  return new Date(guess).toISOString();
}
