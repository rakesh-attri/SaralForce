import test from "node:test";
import assert from "node:assert/strict";
import {failoverReason, endpointOrder, allFailedMessage} from "../../addon/core/ai-fallback.js";
import {FreeTestProvider, resetFreeState} from "../../addon/llm/free-test.js";
import {LLM_PROVIDERS, FREE_ENDPOINTS, providerPermissionOrigins, providerPermissionOrigin} from "../../addon/llm/llm-service.js";

const err = (message, extra = {}) => Object.assign(new Error(message), extra);
const EPS = [
  {id: "a", name: "A", baseUrl: "https://a.test/v1", apiKey: "x", model: "m1"},
  {id: "b", name: "B", baseUrl: "https://b.test/v1", apiKey: "", model: "m2"},
  {id: "c", name: "C", baseUrl: "https://c.test/v1", apiKey: "", model: "m3"},
];

// A transport that answers per base URL: a string reply, an Error to throw, or
// {chunks, then} to stream some text and then fail.
function fakeTransport(plan) {
  const calls = [];
  return {
    calls,
    async sendMessage(messages, apiKey, model, onChunk, baseUrl) {
      calls.push({baseUrl, apiKey, model});
      const p = plan[baseUrl];
      if (p instanceof Error) throw p;
      if (p && p.chunks) { onChunk(p.chunks); throw p.then; }
      if (onChunk) onChunk(p);
      return p;
    }
  };
}

test("which errors move to the next endpoint", () => {
  assert.equal(failoverReason(err("Too many requests", {status: 429})), "rate limited");
  assert.equal(failoverReason(err("Rate limit exceeded for this IP")), "rate limited");
  assert.equal(failoverReason(err("Bad gateway", {status: 502})), "HTTP 502");
  assert.equal(failoverReason(err("nope", {status: 401})), "HTTP 401");
  assert.equal(failoverReason(err("Cannot reach https://x/v1/chat/completions. Reload…")), "unreachable");
  assert.equal(failoverReason(err("No reply from https://x. The request was sent once…")), "timed out");
  assert.equal(failoverReason(err("The AI returned an empty reply")), "empty or broken reply");
  assert.equal(failoverReason(err("cancelled", {name: "AbortError"})), null);
  assert.equal(failoverReason(err("cut off", {code: "AI_TRUNCATED"})), null);
  assert.equal(failoverReason(err("blocked", {code: "AI_BLOCKED"})), null);
});

test("order: last good first, resting endpoints last", () => {
  const now = 1000;
  assert.deepEqual(endpointOrder(EPS, null, {}, now).map(e => e.id), ["a", "b", "c"]);
  assert.deepEqual(endpointOrder(EPS, "c", {}, now).map(e => e.id), ["c", "a", "b"]);
  assert.deepEqual(endpointOrder(EPS, null, {a: now + 5}, now).map(e => e.id), ["b", "c", "a"]);
  assert.deepEqual(endpointOrder(EPS, null, {a: now - 1}, now).map(e => e.id), ["a", "b", "c"]);
  assert.match(allFailedMessage([{name: "A", reason: "rate limited"}, {name: "B", reason: "HTTP 502"}]), /A: rate limited · B: HTTP 502/);
});

test("a rate-limited endpoint hands over to the next, which is then tried first", async () => {
  resetFreeState();
  const t = fakeTransport({"https://a.test/v1": err("slow down", {status: 429}), "https://b.test/v1": "hello"});
  const p = new FreeTestProvider(EPS, {transport: t});
  assert.equal(await p.sendMessage([{role: "user", content: "hi"}], "", "auto", null, ""), "hello");
  assert.equal(p.name, "Free (B)");
  assert.deepEqual(t.calls.map(c => [c.baseUrl, c.apiKey, c.model]), [["https://a.test/v1", "x", "m1"], ["https://b.test/v1", "", "m2"]]);
  t.calls.length = 0;
  await p.sendMessage([{role: "user", content: "again"}], "", "auto", null, "");
  assert.deepEqual(t.calls.map(c => c.baseUrl), ["https://b.test/v1"]);
});

test("cancel, cut-off and a half-streamed reply never switch", async () => {
  resetFreeState();
  const abort = new FreeTestProvider(EPS, {transport: fakeTransport({"https://a.test/v1": err("stop", {name: "AbortError"}), "https://b.test/v1": "x"})});
  await assert.rejects(abort.sendMessage([], "", "", null, ""), {name: "AbortError"});
  resetFreeState();
  const t = fakeTransport({"https://a.test/v1": {chunks: "partial", then: err("Bad gateway", {status: 502})}, "https://b.test/v1": "x"});
  const streaming = new FreeTestProvider(EPS, {transport: t});
  const seen = [];
  await assert.rejects(streaming.sendMessage([], "", "", (s) => seen.push(s), ""), /Bad gateway/);
  assert.deepEqual(seen, ["partial"]);
  assert.equal(t.calls.length, 1);
});

test("all failing gives one message naming each endpoint; no access is skipped", async () => {
  resetFreeState();
  const t = fakeTransport({"https://a.test/v1": err("x", {status: 503}), "https://c.test/v1": err("Too many requests", {status: 429})});
  const p = new FreeTestProvider(EPS, {transport: t, hasAccess: async (ep) => ep.id !== "b"});
  await assert.rejects(p.sendMessage([], "", "", null, ""), /A: HTTP 503 · B: no network access.* · C: rate limited/);
  assert.equal(t.calls.length, 2);
});

test("Test connection reports every endpoint", async () => {
  const t = fakeTransport({"https://a.test/v1": "OK", "https://b.test/v1": err("x", {status: 500}), "https://c.test/v1": ""});
  const res = await new FreeTestProvider(EPS, {transport: t}).testEach([]);
  assert.deepEqual(res.map(r => [r.name, r.ok, r.error || null]), [["A", true, null], ["B", false, "HTTP 500"], ["C", false, "empty or broken reply"]]);
});

test("Free (test) needs no key and asks for every endpoint host", () => {
  const def = LLM_PROVIDERS.free_test;
  assert.equal(def.requiresApiKey, false);
  assert.ok(FREE_ENDPOINTS.length >= 2);
  for (const ep of FREE_ENDPOINTS) assert.match(ep.baseUrl, /^https:\/\//);
  assert.deepEqual(providerPermissionOrigins("free_test", ""), FREE_ENDPOINTS.map(ep => new URL(ep.baseUrl).origin + "/*"));
  assert.equal(providerPermissionOrigin("openai", ""), "https://api.openai.com/*");
  assert.deepEqual(providerPermissionOrigins("openai_compatible", "http://localhost:1234/v1"), []);
});
