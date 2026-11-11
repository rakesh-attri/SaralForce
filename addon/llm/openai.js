import {usageFromOpenAI} from "../core/ai-usage.js";
import {sseData, parseChunk, truncatedError, blockedError, streamError} from "./stream.js";

const API_BASE = "https://api.openai.com/v1";
export const OPENAI_DEFAULT_MODEL = "gpt-5.6-terra";

// GPT-5.x reasoning models reject a custom temperature and the legacy
// max_tokens field; max_completion_tokens covers reasoning plus answer
// tokens, so it needs headroom beyond the visible reply.
const MAX_COMPLETION_TOKENS = 16000;

// /v1/models also lists embeddings, audio, image and moderation models.
const NON_CHAT_MODEL = /embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|davinci|babbage|computer-use/i;

export class OpenAIProvider {
  constructor() {
    this.name = "OpenAI";
  }

  // onUsage({input, output, reasoning}) reports the tokens the API counted.
  async sendMessage(messages, apiKey, model, onChunk, baseUrl, {signal, onUsage} = {}) {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || OPENAI_DEFAULT_MODEL,
        messages: messages,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        stream: !!onChunk,
        // Streams only report usage (in a last chunk) when asked.
        ...(onChunk ? {stream_options: {include_usage: true}} : {})
      }),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    if (onChunk) {
      return this._handleStream(response, onChunk, onUsage);
    }

    const data = await response.json();
    if (onUsage) onUsage(usageFromOpenAI(data.usage));
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new Error(choice.message.refusal);
    }
    if (choice?.finish_reason === "length") throw truncatedError(choice.message?.content);
    if (choice?.finish_reason === "content_filter") throw blockedError("OpenAI", "content filter");
    return choice?.message?.content || "";
  }

  async listModels(apiKey) {
    const response = await fetch(`${API_BASE}/models`, {
      headers: {"Authorization": `Bearer ${apiKey}`}
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }
    const data = await response.json();
    return (data.data || [])
      .map(m => m && m.id)
      .filter(id => id && /^(gpt-|o\d|chatgpt-)/i.test(id) && !NON_CHAT_MODEL.test(id))
      .sort()
      .reverse();
  }

  async _handleStream(response, onChunk, onUsage) {
    let fullText = "";
    let usage = null;
    let finish = null;
    let refusal = "";

    for await (const data of sseData(response)) {
      const parsed = parseChunk(data);
      if (!parsed) continue;   // "[DONE]" and keep-alives
      if (parsed.error) throw streamError("OpenAI", parsed.error);
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta?.refusal) refusal += choice.delta.refusal;
      const content = choice.delta?.content;
      if (content) {
        fullText += content;
        onChunk(fullText);
      }
    }

    if (onUsage) onUsage(usageFromOpenAI(usage));
    if (refusal && !fullText) throw new Error(refusal);
    if (finish === "length") throw truncatedError(fullText);
    if (finish === "content_filter") throw blockedError("OpenAI", "content filter");
    return fullText;
  }
}
