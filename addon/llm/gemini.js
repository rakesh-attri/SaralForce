export class GeminiProvider {
  constructor() {
    this.name = "Google Gemini";
  }

  async sendMessage(messages, apiKey, model, onChunk) {
    const modelId = model || "gemini-2.0-flash";
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    // Convert messages to Gemini format
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
        temperature: 0.3,
        maxOutputTokens: 4096
      }
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (onChunk) {
      const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;
      return this._handleStream(streamUrl, body, onChunk);
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }

  async _handleStream(url, body, onChunk) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
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
