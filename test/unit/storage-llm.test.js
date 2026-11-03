import {test, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {initSettings, getSetting, setSetting, _resetSettingsForTests} from "../../addon/core/storage.js";
import {getSavedConfig, saveConfig, hasValidConfig} from "../../addon/llm/llm-service.js";
import {askAi, askAiJson, excerptLog, NO_LLM_CONFIG} from "../../addon/core/llm.js";

// Minimal chrome.storage.local + legacy localStorage fakes.
function installFakes({stored = {}, legacy = {}} = {}) {
  const area = {...stored};
  const listeners = [];
  const ls = new Map(Object.entries(legacy));
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k)
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries(keys.filter(k => k in area).map(k => [k, area[k]]))),
        set: (items, cb) => { Object.assign(area, items); if (cb) cb(); },
        remove: (k) => { delete area[k]; }
      },
      onChanged: {addListener: (fn) => listeners.push(fn)}
    }
  };
  return {area, ls, emit: (changes) => listeners.forEach(fn => fn(changes, "local"))};
}

beforeEach(() => {
  _resetSettingsForTests();
  delete globalThis.chrome;
  delete globalThis.localStorage;
});

test("legacy localStorage settings migrate to chrome.storage and are removed", async () => {
  const cfg = {provider: "claude", apiKey: "k", model: "claude-sonnet-5-5"};
  const {area, ls} = installFakes({legacy: {llmConfig: JSON.stringify(cfg), sfoc_celebrate: "thor", sfoc_open_inspector_tab: "true"}});
  await initSettings();
  assert.deepEqual(area.llmConfig, cfg);
  assert.equal(area.sfoc_celebrate, "thor");
  assert.equal(area.sfoc_open_inspector_tab, true);
  assert.equal(ls.has("llmConfig"), false);
  assert.deepEqual(getSavedConfig(), cfg);
  assert.equal(hasValidConfig(), true);
});

test("chrome.storage wins over leftover legacy values", async () => {
  installFakes({stored: {llmConfig: {provider: "openai", apiKey: "new"}}, legacy: {llmConfig: JSON.stringify({provider: "openai", apiKey: "old"})}});
  await initSettings();
  assert.equal(getSavedConfig().apiKey, "new");
});

test("saves write through and changes from other pages update the cache", async () => {
  const {area, emit} = installFakes();
  await initSettings();
  saveConfig({provider: "gemini", apiKey: "g"});
  assert.equal(area.llmConfig.apiKey, "g");
  emit({llmConfig: {newValue: {provider: "gemini", apiKey: "changed"}}});
  assert.equal(getSavedConfig().apiKey, "changed");
  emit({llmConfig: {newValue: undefined}});
  assert.equal(getSavedConfig(), null);
});

test("before init, reads fall back to not-yet-migrated legacy values", () => {
  installFakes({legacy: {sfoc_celebrate: "spidey"}});
  assert.equal(getSetting("sfoc_celebrate", "plane"), "spidey");
});

test("without chrome.storage the store keeps using localStorage", async () => {
  globalThis.localStorage = (() => {
    const m = new Map();
    return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)};
  })();
  await initSettings();
  setSetting("llmConfig", {provider: "openai", apiKey: "x"});
  assert.equal(globalThis.localStorage.getItem("llmConfig"), '{"provider":"openai","apiKey":"x"}');
});

function fakeProvider(replies) {
  const calls = [];
  return {
    calls,
    async sendMessage(messages, apiKey, model, onChunk, baseUrl, opts) {
      calls.push({messages, apiKey, model, baseUrl, opts});
      return replies[calls.length - 1];
    }
  };
}

test("askAi needs a configured provider", async () => {
  installFakes();
  await initSettings();
  await assert.rejects(askAi({user: "hi"}), {message: NO_LLM_CONFIG});
});

test("askAi sends system + user with the saved config", async () => {
  installFakes({stored: {llmConfig: {provider: "openrouter", apiKey: "k", model: "m"}}});
  await initSettings();
  const provider = fakeProvider(["  hello  "]);
  assert.equal(await askAi({system: "S", user: "U", provider}), "hello");
  assert.deepEqual(provider.calls[0].messages, [{role: "system", content: "S"}, {role: "user", content: "U"}]);
  assert.equal(provider.calls[0].model, "m");
});

test("askAi rejects an empty reply and honours an aborted signal", async () => {
  installFakes({stored: {llmConfig: {provider: "openai", apiKey: "k"}}});
  await initSettings();
  await assert.rejects(askAi({user: "x", provider: fakeProvider([""])}), /empty reply/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askAi({user: "x", signal: controller.signal, provider: fakeProvider(["y"])}), {name: "AbortError"});
});

test("askAiJson repairs a non-JSON reply once", async () => {
  installFakes({stored: {llmConfig: {provider: "openai", apiKey: "k"}}});
  await initSettings();
  const provider = fakeProvider(["Sure! Here you go", '```json\n{"fixedQuery": "SELECT Id FROM Account"}\n```']);
  const out = await askAiJson({system: "S", user: "U", provider, validate: o => (o.fixedQuery ? null : "fixedQuery is missing.")});
  assert.equal(out.fixedQuery, "SELECT Id FROM Account");
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].messages.at(-1).role, "user");
  assert.match(provider.calls[1].messages.at(-1).content, /not valid JSON/);
});

test("askAiJson gives up after the repair attempt", async () => {
  installFakes({stored: {llmConfig: {provider: "openai", apiKey: "k"}}});
  await initSettings();
  const provider = fakeProvider(['{"other": 1}', '{"other": 2}']);
  await assert.rejects(askAiJson({user: "U", provider, validate: o => (o.ok === undefined ? "ok is missing." : null)}), /ok is missing/);
});

test("excerptLog keeps short logs whole", () => {
  assert.equal(excerptLog("a\nb", 100), "a\nb");
});

test("excerptLog keeps a FATAL_ERROR near the end of a huge log", () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`12:00:00.0 (${i})|STATEMENT_EXECUTE|[${i}]`);
  lines[4900] = "12:00:01.0 (4900)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object";
  const out = excerptLog(lines.join("\n"), 4000);
  assert.ok(out.length <= 4000 + 200, "stays near the budget");
  assert.match(out, /System\.NullPointerException/);
  assert.match(out, /lines omitted/);
  assert.match(out, /\(0\)\|STATEMENT_EXECUTE/, "keeps the head");
  assert.match(out, /\(4999\)\|STATEMENT_EXECUTE/, "keeps the tail");
});
