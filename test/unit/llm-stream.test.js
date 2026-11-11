import {test} from "node:test";
import assert from "node:assert/strict";
import {sseData, parseChunk} from "../../addon/llm/stream.js";
import {ClaudeProvider} from "../../addon/llm/claude.js";
import {OpenAIProvider} from "../../addon/llm/openai.js";
import {GeminiProvider} from "../../addon/llm/gemini.js";
import {OpenAICompatibleProvider} from "../../addon/llm/openai-compatible.js";

// A Response whose body arrives in the given pieces (strings or bytes).
function streamOf(...pieces) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(ctrl) {
      for (const p of pieces) ctrl.enqueue(typeof p === "string" ? enc.encode(p) : p);
      ctrl.close();
    }
  }));
}
const sse = (...events) => events.map(e => "data: " + (typeof e === "string" ? e : JSON.stringify(e)) + "\n\n").join("");
const collect = async (response) => { const out = []; for await (const d of sseData(response)) out.push(d); return out; };

test("sseData: joins lines split across chunks, strips CR, and flushes an unterminated last line", async () => {
  assert.deepEqual(await collect(streamOf("data: {\"a\":", "1}\r\n\r\nda", "ta: two\n", ": comment\n", "data: last")),
    ['{"a":1}', "two", "last"]);
});

test("sseData: a multi-byte character split across chunks is decoded whole", async () => {
  const bytes = new TextEncoder().encode("data: né\n");
  const at = bytes.indexOf(0xC3) + 1;
  assert.deepEqual(await collect(streamOf(bytes.slice(0, at), bytes.slice(at))), ["né"]);
});

test("parseChunk: non-JSON payloads are skipped", () => {
  assert.equal(parseChunk("[DONE]"), null);
  assert.deepEqual(parseChunk('{"x":1}'), {x: 1});
});

const oaiChunk = (content, finish = null) => ({choices: [{delta: content == null ? {} : {content}, finish_reason: finish}]});

test("OpenAI stream: returns the text, and an unterminated final chunk still counts", async () => {
  const seen = [];
  const body = sse(oaiChunk("Hel")) + "data: " + JSON.stringify(oaiChunk("lo", "stop"));
  const text = await new OpenAIProvider()._handleStream(streamOf(body), t => seen.push(t));
  assert.equal(text, "Hello");
  assert.deepEqual(seen, ["Hel", "Hello"]);
});

test("OpenAI stream: finish_reason length is reported as cut off, with the partial text", async () => {
  await assert.rejects(
    new OpenAIProvider()._handleStream(streamOf(sse(oaiChunk("half"), oaiChunk(null, "length"), "[DONE]")), () => {}),
    e => e.code === "AI_TRUNCATED" && e.partial === "half");
});

test("OpenAI stream: an error chunk and a refusal are thrown, not swallowed", async () => {
  await assert.rejects(new OpenAIProvider()._handleStream(streamOf(sse({error: {message: "overloaded"}})), () => {}), /overloaded/);
  await assert.rejects(new OpenAIProvider()._handleStream(streamOf(sse({choices: [{delta: {refusal: "I cannot help"}}]})), () => {}), /I cannot help/);
});

test("OpenAI-compatible stream: length and error chunks are reported", async () => {
  const p = new OpenAICompatibleProvider();
  assert.equal(await p._handleStream(streamOf(sse(oaiChunk("ok", "stop"), "[DONE]")), () => {}), "ok");
  await assert.rejects(p._handleStream(streamOf(sse(oaiChunk("x"), oaiChunk(null, "length"))), () => {}), e => e.code === "AI_TRUNCATED");
  await assert.rejects(p._handleStream(streamOf(sse({error: {message: "rate limited"}})), () => {}), /rate limited/);
});

test("Claude stream: max_tokens is reported as cut off, and an error event is thrown", async () => {
  const delta = text => ({type: "content_block_delta", delta: {type: "text_delta", text}});
  const stop = reason => ({type: "message_delta", delta: {stop_reason: reason}, usage: {output_tokens: 5}});
  const p = new ClaudeProvider();
  assert.equal(await p._handleStream(streamOf(sse(delta("Hi"), stop("end_turn"))), () => {}), "Hi");
  await assert.rejects(p._handleStream(streamOf(sse(delta("Hi"), stop("max_tokens"))), () => {}),
    e => e.code === "AI_TRUNCATED" && e.partial === "Hi");
  await assert.rejects(p._handleStream(streamOf(sse({type: "error", error: {message: "Overloaded"}})), () => {}), /Overloaded/);
});

test("Gemini stream: MAX_TOKENS, safety stops and blocked prompts are reported", async () => {
  const chunk = (text, finishReason) => ({candidates: [{content: {parts: [{text}]}, finishReason}]});
  const realFetch = globalThis.fetch;
  const run = async (body) => {
    globalThis.fetch = async () => streamOf(body);
    try { return await new GeminiProvider()._handleStream("https://example.test", "k", {}, () => {}); }
    finally { globalThis.fetch = realFetch; }
  };
  assert.equal(await run(sse(chunk("A"), chunk("B", "STOP"))), "AB");
  await assert.rejects(run(sse(chunk("A", "MAX_TOKENS"))), e => e.code === "AI_TRUNCATED" && e.partial === "A");
  await assert.rejects(run(sse(chunk("", "SAFETY"))), e => e.code === "AI_BLOCKED");
  await assert.rejects(run(sse({promptFeedback: {blockReason: "PROHIBITED_CONTENT"}})), /PROHIBITED_CONTENT/);
});
