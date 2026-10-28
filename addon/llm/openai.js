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

  async sendMessage(messages, apiKey, model, onChunk, baseUrl, {signal} = {}) {
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
        stream: !!onChunk
      }),
      signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    if (onChunk) {
      return this._handleStream(response, onChunk);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new Error(choice.message.refusal);
    }
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
