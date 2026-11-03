import {test} from "node:test";
import assert from "node:assert/strict";
import {
  usageFromOpenAI, usageFromClaude, usageFromGemini, estimateTokens, buildEntry, formatUsage,
  recordAiCall, aiUsageLog, clearAiUsageLog, sessionTotals, addToTotals
} from "../../addon/core/ai-usage.js";

test("provider usage shapes map to input/output/reasoning", () => {
  assert.deepEqual(usageFromOpenAI({prompt_tokens: 120, completion_tokens: 30, completion_tokens_details: {reasoning_tokens: 10}}), {input: 120, output: 30, reasoning: 10});
  assert.deepEqual(usageFromClaude({input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 40}), {input: 120, output: 40, reasoning: 0});
  assert.deepEqual(usageFromGemini({promptTokenCount: 90, candidatesTokenCount: 25, thoughtsTokenCount: 15}), {input: 90, output: 40, reasoning: 15});
  assert.equal(usageFromOpenAI(null), null);
  assert.equal(usageFromClaude({}), null);
});

test("estimate fallback marks the entry as estimated", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens(""), 0);
  const e = buildEntry({feature: "Explain SOQL", messages: [{role: "user", content: "x".repeat(400)}], reply: "y".repeat(80), ms: 2300});
  assert.equal(e.estimated, true);
  assert.equal(e.input, 100);
  assert.equal(e.output, 20);
  assert.equal(formatUsage(e), "Explain SOQL · ≈ 100 in · 20 out · 120 tokens · 2.3 s");
});

test("real usage, errors and the 50-call ring", () => {
  clearAiUsageLog();
  const ok = recordAiCall({feature: "Write SOQL", usage: {input: 1240, output: 380}, messages: [], reply: "ok", ms: 800});
  assert.equal(formatUsage(ok), "Write SOQL · 1,240 in · 380 out · 1,620 tokens · 800 ms");
  const bad = recordAiCall({feature: "Fix SOQL", error: "boom", ms: 10});
  assert.equal(bad.status, "error");
  assert.match(formatUsage(bad), /failed$/);
  for (let i = 0; i < 60; i++) recordAiCall({feature: "x", usage: {input: 1, output: 1}, ms: 1});
  assert.equal(aiUsageLog().length, 50);
  assert.equal(sessionTotals([ok, bad]).calls, 2);
  clearAiUsageLog();
  assert.equal(aiUsageLog().length, 0);
});

test("saved totals reset 'today' on a new day", () => {
  const day1 = Date.parse("2026-11-03T10:00:00Z");
  let t = addToTotals(null, {at: day1, total: 100});
  t = addToTotals(t, {at: day1, total: 50});
  assert.deepEqual(t.today, {calls: 2, total: 150});
  t = addToTotals(t, {at: Date.parse("2026-11-04T10:00:00Z"), total: 10});
  assert.deepEqual(t.today, {calls: 1, total: 10});
  assert.deepEqual(t.all, {calls: 3, total: 160});
});
