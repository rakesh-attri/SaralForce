export class ClaudeProvider {
  constructor() {
    this.name = "Anthropic Claude";
  }

  async sendMessage(messages, apiKey, model, onChunk) {
    const baseUrl = "https://api.anthropic.com/v1/messages";

    // Claude uses a different format: system message separate, user/assistant messages
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
      model: model || "claude-sonnet-4-20250514",
      max_tokens: 4096,
      temperature: 0.3,
      messages: claudeMessages
    };

    if (systemMessage) {
      body.system = systemMessage;
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }

    if (onChunk) {
      return this._handleStream(response, onChunk);
    }

    const data = await response.json();
    return data.content[0].text;
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
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta") {
              const text = parsed.delta?.text;
              if (text) {
                fullText += text;
                onChunk(fullText);
              }
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
