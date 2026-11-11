// Shared by the AI providers: reading a server-sent event stream, and how a
// reply that did not finish normally is reported. Pure apart from the
// Response body it is handed, so it is unit-tested.

// Yields the payload of every "data:" line. The last line is yielded even
// when the server closes the stream without a trailing newline.
export async function* sseData(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payloads = function* (lines) {
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.startsWith("data:")) yield line.slice(5).replace(/^ /, "");
    }
  };
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split("\n");
    buffer = lines.pop();
    yield* payloads(lines);
  }
  buffer += decoder.decode();
  if (buffer) yield* payloads([buffer]);
}

// A chunk that is not JSON (keep-alive comment, "[DONE]") is skipped.
export function parseChunk(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

// The model stopped at its output limit: the text so far is incomplete, and
// treating it as the full answer would save or deploy half a file.
export function truncatedError(partial) {
  const err = new Error("The AI reply was cut off at the model's output limit, so it is incomplete. " +
    "Ask for something shorter, or pick a model with a larger output limit.");
  err.code = "AI_TRUNCATED";
  err.partial = partial || "";
  return err;
}

export function blockedError(provider, reason) {
  const err = new Error(`${provider} blocked this reply${reason ? ` (${reason})` : ""}. Rephrase the request or try a different model.`);
  err.code = "AI_BLOCKED";
  return err;
}

// Error object some providers send inside a 200 stream.
export function streamError(provider, error) {
  const msg = error && (error.message || error.code || (typeof error === "string" ? error : ""));
  return new Error(msg ? String(msg) : `${provider} reported an error while streaming.`);
}
