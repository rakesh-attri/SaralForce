import {usageFromOpenAI} from "../core/ai-usage.js";
import {sseData, parseChunk, truncatedError, blockedError, streamError} from "./stream.js";

export class OpenAICompatibleProvider {
  constructor() {
    this.name = "OpenAI Compatible";
  }

  _endpoint(baseUrl) {
    let endpoint = String(baseUrl || "").trim();
    if (!endpoint) {
      throw new Error("Base URL is required for OpenAI-compatible providers");
    }
    endpoint = endpoint.replace(/\/+$/, "");
    if (!endpoint.endsWith("/chat/completions")) {
      endpoint = endpoint + "/chat/completions";
    }
    return endpoint;
  }

  // Callback-style messaging is more reliable than promise sendMessage in MV3.
  _bgPost(payload) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        reject(new Error("chrome.runtime unavailable"));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const err = new Error("Background llmFetch timed out — reload the extension");
          err.sent = true;
          reject(err);
        }
      }, 70000);
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const err = new Error(
              "Background error: " + chrome.runtime.lastError.message +
              " — reload the extension on chrome://extensions");
            // The worker took the message and died mid-request: it may have
            // reached the provider already.
            err.sent = /message (port|channel) closed/i.test(chrome.runtime.lastError.message || "");
            reject(err);
            return;
          }
          resolve(res);
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  }

  async _post(endpoint, headers, body, stream, signal) {
    // Non-stream: always go through background (host_permissions, no page CORS).
    if (!stream) {
      let res;
      try {
        const sent = this._bgPost({
          message: "llmFetch",
          url: endpoint,
          method: "POST",
          headers,
          body
        });
        // Cancel stops waiting at once (the background request cannot be recalled).
        res = await (signal ? Promise.race([sent, new Promise((_, reject) => {
          const stop = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) stop(); else signal.addEventListener("abort", stop, {once: true});
        })]) : sent);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // A timeout means the request was sent and may still be answered (and
        // billed): sending it again would pay for the same reply twice.
        if (e.sent) {
          throw new Error(`No reply from ${endpoint}. The request was sent once and not repeated, so it is not billed twice; try again, or pick a faster model.`);
        }
        // Messaging itself failed, so nothing was sent: fetch directly.
        console.warn("[SaralForce] background llmFetch failed, direct fetch:", e.message);
        res = null;
        try {
          const response = await fetch(endpoint, {method: "POST", headers, body, signal});
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API error: ${response.status}`);
          }
          return await response.text();
        } catch (e2) {
          if (signal && signal.aborted) throw e2;
          throw new Error(`Cannot reach ${endpoint}. Reload the extension and check the Base URL in AI settings. (${e2.message})`);
        }
      }
      if (!res || res.error) {
        throw new Error(
          `Network error calling ${endpoint}: ${res?.error || "empty background response"}. ` +
          `Reload the extension on chrome://extensions, then retry.`
        );
      }
      if (!res.ok) {
        let msg = `API error: ${res.status}`;
        try {
          const data = JSON.parse(res.text || "{}");
          msg = data.error?.message || data.message || msg;
        } catch (e) { /* keep status */ }
        throw new Error(msg);
      }
      return res.text;
    }

    // Streaming still uses page fetch (needs host_permissions for opencode.ai).
    let response;
    try {
      response = await fetch(endpoint, {method: "POST", headers, body, signal});
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new Error(
        `Stream fetch failed for ${endpoint} — reload the extension and check Base URL. (${e.message})`
      );
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }
    return response;
  }

  // onUsage({input, output, reasoning}) reports tokens when the endpoint
  // returns them (stream_options is not sent: some endpoints reject it).
  async sendMessage(messages, apiKey, model, onChunk, baseUrl, {signal, onUsage} = {}) {
    const endpoint = this._endpoint(baseUrl);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
    // No temperature and no token cap: reasoning models behind these endpoints
    // reject both (or need max_completion_tokens instead), and a fixed cap cut
    // long code replies short. The endpoint's own defaults apply.
    const body = JSON.stringify({
      model: model || "default",
      messages: messages,
      stream: !!onChunk
    });

    if (onChunk) {
      const response = await this._post(endpoint, headers, body, true, signal);
      return this._handleStream(response, onChunk, onUsage);
    }

    const text = await this._post(endpoint, headers, body, false, signal);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("Invalid JSON from API: " + String(text).slice(0, 200));
    }
    if (data.error && !data.choices) throw streamError("The AI endpoint", data.error);
    if (onUsage) onUsage(usageFromOpenAI(data.usage));
    const finish = data.choices?.[0]?.finish_reason;
    if (finish === "length") throw truncatedError(data.choices[0].message?.content);
    if (finish === "content_filter") throw blockedError("The AI endpoint", "content filter");
    const content = data.choices?.[0]?.message?.content;
    if (content == null) {
      throw new Error("API response missing choices[0].message.content: " +
        JSON.stringify(data).slice(0, 300));
    }
    return content;
  }

  async listModels(apiKey, baseUrl) {
    const modelsUrl = this._endpoint(baseUrl).replace(/\/chat\/completions$/, "/models");
    const res = await this._bgPost({
      message: "llmFetch",
      url: modelsUrl,
      method: "GET",
      headers: {"Authorization": `Bearer ${apiKey}`}
    });
    if (!res || res.error || !res.ok) {
      throw new Error(`Could not list models from ${modelsUrl}: ${res?.error || "HTTP " + (res?.status ?? "?")}`);
    }
    let data;
    try {
      data = JSON.parse(res.text || "{}");
    } catch (e) {
      throw new Error("Invalid JSON from " + modelsUrl);
    }
    return (data.data || data.models || []).map(m => (typeof m === "string" ? m : m && m.id)).filter(Boolean).sort();
  }

  async _handleStream(response, onChunk, onUsage) {
    let fullText = "";
    let usage = null;
    let finish = null;

    for await (const data of sseData(response)) {
      const parsed = parseChunk(data);
      if (!parsed) continue;   // "[DONE]" and keep-alives
      if (parsed.error) throw streamError("The AI endpoint", parsed.error);
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const content = choice.delta?.content;
      if (content) {
        fullText += content;
        onChunk(fullText);
      }
    }

    if (onUsage) onUsage(usageFromOpenAI(usage));
    if (finish === "length") throw truncatedError(fullText);
    if (finish === "content_filter") throw blockedError("The AI endpoint", "content filter");
    return fullText;
  }
}
