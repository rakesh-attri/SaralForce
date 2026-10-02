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
          reject(new Error("Background llmFetch timed out — reload the extension"));
        }
      }, 70000);
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(
              "Background error: " + chrome.runtime.lastError.message +
              " — reload the extension on chrome://extensions"));
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

  async _post(endpoint, headers, body, stream) {
    // Non-stream: always go through background (host_permissions, no page CORS).
    if (!stream) {
      let res;
      try {
        res = await this._bgPost({
          message: "llmFetch",
          url: endpoint,
          method: "POST",
          headers,
          body
        });
      } catch (e) {
        // Fall back to direct fetch if messaging failed.
        console.warn("[sfMetaMind] background llmFetch failed, direct fetch:", e.message);
        res = null;
        try {
          const response = await fetch(endpoint, {method: "POST", headers, body});
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API error: ${response.status}`);
          }
          return await response.text();
        } catch (e2) {
          throw new Error(
            `Cannot reach ${endpoint}. Reload the extension (⚙ → reload) and verify Base URL ` +
            `https://opencode.ai/zen/v1 — ${e2.message}`
          );
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
      response = await fetch(endpoint, {method: "POST", headers, body});
    } catch (e) {
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

  async sendMessage(messages, apiKey, model, onChunk, baseUrl) {
    const endpoint = this._endpoint(baseUrl);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
    const body = JSON.stringify({
      model: model || "default",
      messages: messages,
      temperature: 0.3,
      max_tokens: 4096,
      stream: !!onChunk
    });

    if (onChunk) {
      const response = await this._post(endpoint, headers, body, true);
      return this._handleStream(response, onChunk);
    }

    const text = await this._post(endpoint, headers, body, false);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("Invalid JSON from API: " + String(text).slice(0, 200));
    }
    const content = data.choices?.[0]?.message?.content;
    if (content == null) {
      throw new Error("API response missing choices[0].message.content: " +
        JSON.stringify(data).slice(0, 300));
    }
    return content;
  }

  async _handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              fullText += content;
              onChunk(fullText);
            }
          } catch (e) {
            // Skip malformed chunks
          }
        }
      }
    }

    return fullText;
  }
}
