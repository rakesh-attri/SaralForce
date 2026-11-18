// Fallback between free AI endpoints: which one to try first, and whether an
// error means "try the next one". Pure, so it is unit-tested.

// How long an endpoint that failed or hit a rate limit is skipped.
export const COOLDOWN_MS = 60 * 1000;

// A short reason when the next endpoint should be tried, or null when the
// error would happen anywhere (cancelled, cut off, blocked) and switching
// would not help.
export function failoverReason(error) {
  if (!error) return null;
  if (error.name === "AbortError") return null;
  if (error.code === "AI_TRUNCATED" || error.code === "AI_BLOCKED") return null;
  const status = Number(error.status) || 0;
  const msg = String(error.message || error);
  if (status === 429 || /rate.?limit|too many requests|quota/i.test(msg)) return "rate limited";
  if (status === 401 || status === 403) return `HTTP ${status}`;
  if (status >= 500) return `HTTP ${status}`;
  if (status === 402 || status === 404 || status === 408) return `HTTP ${status}`;
  if (/empty reply|missing choices|invalid json/i.test(msg)) return "empty or broken reply";
  if (/no reply from|timed out|timeout/i.test(msg)) return "timed out";
  if (/cannot reach|network error|failed to fetch|stream fetch failed|background/i.test(msg)) return "unreachable";
  if (/needs network access/i.test(msg)) return "no network access";
  const api = msg.match(/API error: (\d{3})/);
  if (api) return `HTTP ${api[1]}`;
  // Anything else from the endpoint (a 400 the other endpoints may not give):
  // still worth one try elsewhere.
  return msg.slice(0, 80) || "error";
}

// Endpoints in the order to try: the last one that worked first, then the
// rest in their listed order. Ones cooling down go to the back rather than
// being dropped, so a request still has somewhere to go when all of them
// failed recently.
export function endpointOrder(list, lastGood, cooldowns, now = Date.now()) {
  const cool = cooldowns || {};
  const ready = [];
  const resting = [];
  list.forEach((ep, i) => {
    const until = cool[ep.id] || 0;
    (until > now ? resting : ready).push({ep, i, first: ep.id === lastGood ? 0 : 1, until});
  });
  ready.sort((a, b) => a.first - b.first || a.i - b.i);
  resting.sort((a, b) => a.until - b.until || a.i - b.i);
  return [...ready, ...resting].map(x => x.ep);
}

// One message for when every endpoint failed.
export function allFailedMessage(failures) {
  return "All free AI endpoints failed: " + failures.map(f => `${f.name}: ${f.reason}`).join(" · ") +
    ". Try again in a minute, or add your own key in Settings.";
}
