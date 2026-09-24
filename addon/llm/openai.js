export class OpenAIProvider {
  constructor() {
    this.name = "OpenAI";
  }

  async sendMessage(messages, apiKey, model, onChunk) {
    const baseUrl = "https://api.openai.com/v1/chat/completions";

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: messages,
        temperature: 0.3,
        max_tokens: 4096,
        stream: !!onChunk
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    if (onChunk) {
      return this._handleStream(response, onChunk);
    }

    const data = await response.json();
    return data.choices[0].message.content;
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
