const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-4-argon";

// Thinking tokens count toward maxOutputTokens on current Gemini models, so
// the cap leaves room for them; temperature stays at the model default.
const MAX_OUTPUT_TOKENS = 16384;

function headers(apiKey) {
  // Key in a header, not the URL, so it never lands in logs or history.
  return {"Content-Type": "application/json", "x-goog-api-key": apiKey};
}

// Answer text only: skip thought-summary parts.
function partsText(parts) {
  return (parts || []).filter(p => p && p.text && !p.thought).map(p => p.text).join("");
}

export class GeminiProvider {
  constructor() {
    this.name = "Google Gemini";
  }

  async sendMessage(messages, apiKey, model, onChunk) {
    const modelId = encodeURIComponent(model || GEMINI_DEFAULT_MODEL);

    let systemInstruction = null;
    const contents = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = {
          parts: [{text: msg.content}]
        };
      } else {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{text: msg.content}]
        });
      }
    }

    const body = {
      contents: contents,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS
      }
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (onChunk) {
      return this._handleStream(`${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse`, apiKey, body, onChunk);
    }

    const response = await fetch(`${API_BASE}/models/${modelId}:generateContent`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      const reason = data.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini blocked this request (${reason}).` : "Gemini returned no answer.");
    }
    return partsText(candidate.content?.parts);
  }

  async listModels(apiKey) {
    const ids = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const url = `${API_BASE}/models?pageSize=1000` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const response = await fetch(url, {headers: headers(apiKey)});
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
      }
      const data = await response.json();
      for (const m of data.models || []) {
        if (m && m.name && (m.supportedGenerationMethods || []).includes("generateContent")) {
          ids.push(m.name.replace(/^models\//, ""));
        }
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return ids;
  }

  async _handleStream(url, apiKey, body, onChunk) {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

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
          try {
            const parsed = JSON.parse(line.slice(6));
            const text = partsText(parsed.candidates?.[0]?.content?.parts);
            if (text) {
              fullText += text;
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
