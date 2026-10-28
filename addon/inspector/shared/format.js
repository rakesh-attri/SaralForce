import {sfConn, apiVersion} from "../../inspector.js";
import {isDateOnlyString, looksLikeSfDateTime, parseSfInstant, formatSfDateTime, formatSfDate, ensureSfTimeZone, getEffectiveTimeZone} from "../../sf-time.js";

// ─── Salesforce time zone + presentational helpers ─────────
// Salesforce REST returns UTC ISO (`...+0000`); Salesforce UI renders in the
// authenticated user's TimeZoneSidKey. All on-screen datetimes go through
// formatSfDateTime (SF zone), date-only values pass through untouched, and
// CSV/export keeps raw ISO. No hardcoded offsets anywhere.
let _sfTzKick = false;
function kickSfTzFetch() {
  if (_sfTzKick) return;
  _sfTzKick = true;
  try {
    ensureSfTimeZone(sfConn, apiVersion).then(() => {
      try {
        if (typeof window !== "undefined" && window.dispatchEvent) {
          window.dispatchEvent(new Event("sf-tz-ready"));
        }
      } catch (e) { /* ignore */ }
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}
// Re-render hook: refreshes once the SF zone arrives so the first paint
// (browser-zone fallback) corrects itself without user action.
function useSfTimeZoneTick() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    kickSfTzFetch();
    const onReady = () => setTick(t => t + 1);
    try { window.addEventListener("sf-tz-ready", onReady); } catch (e) { /* ignore */ }
    return () => { try { window.removeEventListener("sf-tz-ready", onReady); } catch (e) {} };
  }, []);
}

// ─── Presentational helpers (visual only) ────────────────
function fmtDateTime(value) {
  if (value == null || value === "") return "";
  kickSfTzFetch();
  // Date-only must never shift days.
  if (isDateOnlyString(String(value))) return String(value).slice(0, 10);
  const d = parseSfInstant(value);
  if (!d) return String(value);
  return formatSfDateTime(d);
}

// Relative "Last refreshed / Last updated" stamp shared by the Records
// summary headers and the Show-all-data info strip.
// Relative part is TZ-agnostic; absolute fallback uses the SF zone.
function ffFmtRelative(ts) {
  if (!ts) return "—";
  kickSfTzFetch();
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  try {
    const tz = getEffectiveTimeZone();
    const dayFmt = new Intl.DateTimeFormat(undefined, {timeZone: tz, month: "short", day: "numeric"});
    const todayStr = new Intl.DateTimeFormat("en-CA", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
    const dStr = new Intl.DateTimeFormat("en-CA", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"}).format(d);
    const timeFmt = new Intl.DateTimeFormat(undefined, {timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true});
    const day = dStr === todayStr ? "Today" : dayFmt.format(d);
    return `${day}, ${timeFmt.format(d)}`;
  } catch (e) {
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    let hh = d.getHours();
    const ap = hh >= 12 ? "PM" : "AM";
    hh = hh % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, "0");
    const day = sameDay ? "Today"
      : d.toLocaleDateString(undefined, {month: "short", day: "numeric"});
    return `${day}, ${hh}:${mm} ${ap}`;
  }
}

function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}

// Format one SOQL/Export cell for display. Datetimes -> SF zone UI style,
// dates -> verbatim, everything else -> raw. Export/CSV path keeps raw ISO.
function fmtSfCell(value, fieldType) {
  if (value == null || value === "") return "";
  const t = String(fieldType || "").toLowerCase();
  if (t === "date") return formatSfDate(value);
  if (t === "datetime") {
    kickSfTzFetch();
    if (isDateOnlyString(String(value))) return String(value).slice(0, 10);
    return formatSfDateTime(value);
  }
  // No describe info: heuristically format only clear datetime strings so
  // date-only values never shift.
  if (!t && looksLikeSfDateTime(value)) {
    kickSfTzFetch();
    return formatSfDateTime(value);
  }
  if (!t && isDateOnlyString(String(value))) return String(value).slice(0, 10);
  return String(value);
}

export {kickSfTzFetch, useSfTimeZoneTick, fmtDateTime, ffFmtRelative, fmtNum, fmtSfCell};
