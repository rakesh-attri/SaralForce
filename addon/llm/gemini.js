import {usageFromGemini} from "../core/ai-usage.js";
import {sseData, parseChunk, truncatedError, blockedError, streamError} from "./stream.js";

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

// Gemini ends a normal reply with STOP; anything else means it is partial or withheld.
const GEMINI_BLOCKED = /^(SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|LANGUAGE|IMAGE_SAFETY)$/;
function finishCheck(finish, text) {
  if (finish === "MAX_TOKENS") throw truncatedError(text);
  if (finish && GEMINI_BLOCKED.test(finish)) throw blockedError("Gemini", finish);
}

export class GeminiProvider {
  constructor() {
    this.name = "Google Gemini";
  }

  // onUsage({input, output, reasoning}) reports the tokens the API counted.
  async sendMessage(messages, apiKey, model, onChunk, baseUrl, {signal, onUsage} = {}) {
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
      return this._handleStream(`${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse`, apiKey, body, onChunk, signal, onUsage);
    }

    const response = await fetch(`${API_BASE}/models/${modelId}:generateContent`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    if (onUsage) onUsage(usageFromGemini(data.usageMetadata));
    const candidate = data.candidates?.[0];
    if (!candidate) {
      const reason = data.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini blocked this request (${reason}).` : "Gemini returned no answer.");
    }
    const text = partsText(candidate.content?.parts);
    finishCheck(candidate.finishReason, text);
    return text;
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

  async _handleStream(url, apiKey, body, onChunk, signal, onUsage) {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    let fullText = "";
    let usage = null;   // each chunk repeats usageMetadata; the last is final
    let finish = null;

    for await (const data of sseData(response)) {
      const parsed = parseChunk(data);
      if (!parsed) continue;
      if (parsed.error) throw streamError("Gemini", parsed.error);
      if (parsed.usageMetadata) usage = parsed.usageMetadata;
      const blocked = parsed.promptFeedback?.blockReason;
      if (blocked) throw blockedError("Gemini", blocked);
      const candidate = parsed.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      const text = partsText(candidate?.content?.parts);
      if (text) {
        fullText += text;
        onChunk(fullText);
      }
    }

    if (onUsage) onUsage(usageFromGemini(usage));
    finishCheck(finish, fullText);
    return fullText;
  }
}
