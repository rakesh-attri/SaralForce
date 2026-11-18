// "Free (test)": no key, no model to pick. Sends each request to a list of
// free OpenAI-compatible endpoints and moves to the next one when an endpoint
// errors or hits its rate limit. For trying SaralForce's AI features only.
import {OpenAICompatibleProvider} from "./openai-compatible.js";
import {failoverReason, endpointOrder, allFailedMessage, COOLDOWN_MS} from "../core/ai-fallback.js";

// Shared by every FreeTestProvider in this page, so a rate limit seen by one
// feature is remembered by the next.
const state = {lastGood: null, cooldowns: {}};

export function resetFreeState() {
  state.lastGood = null;
  state.cooldowns = {};
}

export class FreeTestProvider {
  // endpoints: [{id, name, baseUrl, apiKey, model}]. hasAccess(ep) resolves
  // false for an endpoint whose host this browser has not allowed.
  constructor(endpoints, {transport, hasAccess} = {}) {
    this.endpoints = endpoints;
    this.transport = transport || new OpenAICompatibleProvider();
    this.hasAccess = hasAccess || (() => Promise.resolve(true));
    this.name = "Free (test)";
  }

  async sendMessage(messages, _apiKey, _model, onChunk, _baseUrl, options = {}) {
    const {signal, onUsage} = options;
    const failures = [];
    for (const ep of endpointOrder(this.endpoints, state.lastGood, state.cooldowns)) {
      if (signal && signal.aborted) throw abortError();
      if (!(await this.hasAccess(ep))) {
        failures.push({name: ep.name, reason: "no network access (click Save settings)"});
        continue;
      }
      let streamed = false;
      try {
        const reply = await this.transport.sendMessage(messages, ep.apiKey || "", ep.model,
          onChunk ? (t) => { streamed = true; onChunk(t); } : null, ep.baseUrl, {signal, onUsage});
        if (!String(reply || "").trim()) {
          const err = new Error("The AI returned an empty reply");
          throw err;
        }
        state.lastGood = ep.id;
        delete state.cooldowns[ep.id];
        this.name = `Free (${ep.name})`;
        return reply;
      } catch (e) {
        const reason = failoverReason(e);
        // Text already on screen: a second answer would be pasted after it.
        if (!reason || streamed) throw e;
        state.cooldowns[ep.id] = Date.now() + COOLDOWN_MS;
        if (state.lastGood === ep.id) state.lastGood = null;
        failures.push({name: ep.name, reason});
      }
    }
    throw new Error(allFailedMessage(failures));
  }

  // Each endpoint once, in listed order, for Settings → Test connection.
  async testEach(messages) {
    const out = [];
    for (const ep of this.endpoints) {
      const started = Date.now();
      let tokens = null;
      try {
        if (!(await this.hasAccess(ep))) throw new Error("no network access (click Save settings)");
        const reply = await this.transport.sendMessage(messages, ep.apiKey || "", ep.model, null, ep.baseUrl,
          {onUsage: (u) => { if (u) tokens = (u.input || 0) + (u.output || 0); }});
        if (!String(reply || "").trim()) throw new Error("empty reply");
        out.push({name: ep.name, ok: true, tokens, ms: Date.now() - started});
      } catch (e) {
        out.push({name: ep.name, ok: false, error: failoverReason(e) || (e && e.message) || String(e), ms: Date.now() - started});
      }
    }
    return out;
  }

  async listModels() {
    return this.endpoints.map(ep => `${ep.name}: ${ep.model}`);
  }
}

function abortError() {
  const err = new Error("The AI request was cancelled");
  err.name = "AbortError";
  return err;
}
