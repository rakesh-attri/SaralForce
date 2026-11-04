import {test} from "node:test";
import assert from "node:assert/strict";
import {validateBaseUrl, effectiveBaseUrl, providerPermissionOrigin, LLM_PROVIDERS} from "../../addon/llm/llm-service.js";

test("validateBaseUrl requires https except for loopback", () => {
  assert.equal(validateBaseUrl("openai_compatible", "https://opencode.ai/zen/v1"), null);
  assert.equal(validateBaseUrl("openai_compatible", "http://localhost:11434/v1"), null);
  assert.equal(validateBaseUrl("openai_compatible", "http://127.0.0.1:8080/v1"), null);
  assert.match(validateBaseUrl("openai_compatible", "http://api.example.com/v1"), /https/);
  assert.match(validateBaseUrl("openai_compatible", "not a url"), /valid URL/);
  assert.match(validateBaseUrl("openai_compatible", ""), /required/);
});

test("providers without a base URL skip validation", () => {
  assert.equal(validateBaseUrl("openai", ""), null);
  assert.equal(validateBaseUrl("claude", "http://ignored"), null);
});

test("OpenRouter falls back to its default base URL", () => {
  assert.equal(effectiveBaseUrl("openrouter", ""), "https://openrouter.ai/api/v1");
  assert.equal(effectiveBaseUrl("openrouter", " https://proxy.example/v1 "), "https://proxy.example/v1");
  assert.equal(validateBaseUrl("openrouter", ""), null);
  assert.equal(providerPermissionOrigin("openrouter", ""), "https://openrouter.ai/*");
});

test("every provider default model is in its curated list when it has one", () => {
  for (const [id, def] of Object.entries(LLM_PROVIDERS)) {
    if (def.models.length) assert.ok(def.models.includes(def.defaultModel), id);
  }
});
