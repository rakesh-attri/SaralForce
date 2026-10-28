const API_BASE = "https://api.anthropic.com/v1";
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";

// Current Claude models reject sampling parameters (temperature/top_p/top_k)
// and think by default, so requests send neither, and max_tokens leaves room
// for thinking before the visible answer.
const MAX_TOKENS = 16000;

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
}

function stopReasonError(stopReason) {
  if (stopReason === "refusal") {
    return new Error("Claude declined this request. Rephrase it or try a different model.");
  }
  return null;
}

export class ClaudeProvider {
  constructor() {
    this.name = "Anthropic Claude";
  }

  async sendMessage(messages, apiKey, model, onChunk, baseUrl, {signal} = {}) {
    // Claude takes the system prompt separately from user/assistant turns.
    let systemMessage = "";
    const claudeMessages = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessage = msg.content;
      } else {
        claudeMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model: model || CLAUDE_DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      messages: claudeMessages
    };
    if (systemMessage) {
      body.system = systemMessage;
    }
    if (onChunk) {
      body.stream = true;
    }

    const response = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }

    if (onChunk) {
      return this._handleStream(response, onChunk);
    }

    const data = await response.json();
    const refusal = stopReasonError(data.stop_reason);
    if (refusal) throw refusal;
    // Thinking blocks come before the answer; join only the text blocks.
    return (data.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
  }

  async listModels(apiKey) {
    const ids = [];
    let afterId = null;
    for (let page = 0; page < 10; page++) {
      const url = `${API_BASE}/models?limit=1000` + (afterId ? `&after_id=${encodeURIComponent(afterId)}` : "");
      const response = await fetch(url, {headers: headers(apiKey)});
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
      }
      const data = await response.json();
      for (const m of data.data || []) {
        if (m && m.id) ids.push(m.id);
      }
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
    return ids;
  }

  async _handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";
    let stopReason = null;

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let parsed;
        try {
          parsed = JSON.parse(line.slice(6));
        } catch (e) {
          continue; // Skip malformed chunks
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          fullText += parsed.delta.text || "";
          onChunk(fullText);
        } else if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        } else if (parsed.type === "error") {
          throw new Error(parsed.error?.message || "Claude stream error");
        }
      }
    }

    const refusal = stopReasonError(stopReason);
    if (refusal && !fullText) throw refusal;
    return fullText;
  }
}
