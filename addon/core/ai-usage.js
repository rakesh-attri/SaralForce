// AI usage: tokens, time, input and output of every AI request. The full text
// stays in memory for this panel session only; the token totals (numbers, no
// text) are saved so "today" and "all time" survive a reload.
import {getSetting, setSetting} from "./storage.js";

export const USAGE_TOTALS_KEY = "sfoc_ai_usage_totals";
export const USAGE_TOAST_KEY = "sfoc_ai_usage_toast";
export const USAGE_EVENT = "ff-ai-usage";
const RING = 50;

// ── Provider usage shapes → {input, output, reasoning} ─────────────────────

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// OpenAI and OpenAI-compatible: usage.{prompt_tokens, completion_tokens}.
export function usageFromOpenAI(u) {
  if (!u || typeof u !== "object") return null;
  const input = n(u.prompt_tokens ?? u.input_tokens);
  const output = n(u.completion_tokens ?? u.output_tokens);
  const reasoning = n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens);
  return input || output ? {input, output, reasoning} : null;
}

// Claude: usage.{input_tokens, output_tokens} (+ cache reads count as input).
export function usageFromClaude(u) {
  if (!u || typeof u !== "object") return null;
  const input = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  const output = n(u.output_tokens);
  return input || output ? {input, output, reasoning: 0} : null;
}

// Gemini: usageMetadata.{promptTokenCount, candidatesTokenCount, thoughtsTokenCount}.
export function usageFromGemini(u) {
  if (!u || typeof u !== "object") return null;
  const input = n(u.promptTokenCount);
  const reasoning = n(u.thoughtsTokenCount);
  const output = n(u.candidatesTokenCount) + reasoning;
  return input || output ? {input, output, reasoning} : null;
}

// Rough token count when the provider reports none: about 4 characters a token.
export function estimateTokens(text) {
  const s = String(text || "");
  return s ? Math.max(1, Math.round(s.length / 4)) : 0;
}

// ── One recorded call ───────────────────────────────────────────────────────

export function buildEntry({feature, provider, model, messages, reply, usage, ms, error, cancelled}, at = Date.now(), id = at) {
  const inputText = (messages || []).map(m => m && m.content).join("\n");
  const estimated = !usage;
  const input = usage ? usage.input : estimateTokens(inputText);
  const output = usage ? usage.output : estimateTokens(reply);
  return {
    id, at,
    feature: feature || "AI request",
    provider: provider || "", model: model || "",
    input, output, reasoning: usage ? usage.reasoning || 0 : 0,
    total: input + output, estimated,
    ms: Math.max(0, Math.round(ms || 0)),
    status: cancelled ? "cancelled" : error ? "error" : "ok",
    error: error ? String(error).slice(0, 500) : null,
    messages: (messages || []).map(m => ({role: m.role, content: String(m.content || "")})),
    reply: String(reply || "")
  };
}

const fmt = v => Number(v || 0).toLocaleString("en-US");

// "Explain SOQL · 1,240 in · 380 out · 1,620 tokens · 2.3 s"
export function formatUsage(e) {
  const secs = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`;
  const tokens = `${e.estimated ? "≈ " : ""}${fmt(e.input)} in · ${fmt(e.output)} out · ${fmt(e.total)} tokens`;
  const tail = e.status === "error" ? " · failed" : e.status === "cancelled" ? " · cancelled" : "";
  return `${e.feature} · ${tokens} · ${secs}${tail}`;
}

// ── Session log (memory) + saved totals (numbers only) ─────────────────────

const log = [];
let seq = 0;

export function aiUsageLog() {
  return log.slice();
}

export function clearAiUsageLog() {
  log.length = 0;
  emit(null);
}

export function sessionTotals(list = log) {
  return list.reduce((t, e) => ({calls: t.calls + 1, input: t.input + e.input, output: t.output + e.output, total: t.total + e.total}),
    {calls: 0, input: 0, output: 0, total: 0});
}

// Local calendar day, so "today" turns over at the user's midnight, not UTC's.
export function dayKey(at) {
  const d = new Date(at);
  const p = v => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Saved totals: {day, today:{calls,total}, all:{calls,total}}; a new day resets "today".
export function addToTotals(totals, entry) {
  const t = totals && typeof totals === "object" ? totals : {};
  const day = dayKey(entry.at);
  const today = t.day === day ? t.today || {calls: 0, total: 0} : {calls: 0, total: 0};
  const all = t.all || {calls: 0, total: 0};
  return {
    day,
    today: {calls: today.calls + 1, total: today.total + entry.total},
    all: {calls: all.calls + 1, total: all.total + entry.total}
  };
}

export function savedTotals(now = Date.now()) {
  const t = getSetting(USAGE_TOTALS_KEY, null) || {};
  const today = t.day === dayKey(now) ? t.today || {calls: 0, total: 0} : {calls: 0, total: 0};
  return {today, all: t.all || {calls: 0, total: 0}};
}

export function showUsageToast() {
  return getSetting(USAGE_TOAST_KEY, true) !== false;
}

export function setShowUsageToast(on) {
  setSetting(USAGE_TOAST_KEY, !!on);
}

function emit(entry) {
  try {
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent(USAGE_EVENT, {detail: entry}));
    }
  } catch (e) { /* no window (tests) */ }
}

export function recordAiCall(call) {
  const at = Date.now();
  const entry = buildEntry(call, at, `${at}-${++seq}`);
  log.unshift(entry);
  if (log.length > RING) log.length = RING;
  try { setSetting(USAGE_TOTALS_KEY, addToTotals(getSetting(USAGE_TOTALS_KEY, null), entry)); } catch (e) { /* ignore */ }
  emit(entry);
  return entry;
}
