// One entry point for every AI feature (SOQL fix, Apex check, log analysis,
// org audit, object builder). Reads the configured provider, sends the
// request, supports cancellation, and parses JSON replies with one repair
// attempt. Pure apart from the provider modules it calls.
import {getSavedConfig, hasValidConfig, getLLMProvider} from "../llm/llm-service.js";
import {parseJSONFromText} from "./object-builder-rules.js";

// Thrown (as message) when no provider is configured; callers already check
// for this exact string to show the "Set up AI" hint.
export const NO_LLM_CONFIG = "NO_LLM_CONFIG";

export function isAiConfigured() {
  return hasValidConfig();
}

function abortError() {
  const err = new Error("The AI request was cancelled");
  err.name = "AbortError";
  return err;
}

// Resolves with the provider's reply text. messages: [{role, content}], or
// pass system + user. onChunk(fullTextSoFar) streams when the provider can.
export async function askAi({system, user, messages, onChunk, signal, provider: providerOverride} = {}) {
  const config = getSavedConfig();
  if (!config || !hasValidConfig()) throw new Error(NO_LLM_CONFIG);
  const list = messages ? messages.slice() : [];
  if (!messages) {
    if (system) list.push({role: "system", content: system});
    list.push({role: "user", content: String(user || "")});
  }
  if (signal && signal.aborted) throw abortError();
  const provider = providerOverride || getLLMProvider(config.provider);
  const call = provider.sendMessage(list, config.apiKey, config.model, onChunk || null, config.baseUrl, {signal});
  // Providers that cannot abort their transport still stop the caller here.
  const raw = await (signal ? Promise.race([call, new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), {once: true});
  })]) : call);
  const text = String(raw || "").trim();
  if (!text) throw new Error("The AI returned an empty reply");
  return text;
}

// Like askAi but returns a parsed JSON object. When the reply is not valid
// JSON (or validate(obj) returns an error string), asks once more with the
// problem spelled out before giving up.
export async function askAiJson({system, user, validate, signal, provider} = {}) {
  const first = await askAi({system, user, signal, provider});
  let parsed = parseJSONFromText(first);
  let problem = parsed ? (validate ? validate(parsed) : null) : "The reply was not valid JSON.";
  if (!problem) return parsed;

  const retry = await askAi({
    messages: [
      ...(system ? [{role: "system", content: system}] : []),
      {role: "user", content: String(user || "")},
      {role: "assistant", content: first},
      {role: "user", content: `${problem} Reply again with ONLY the JSON object, no other text.`}
    ],
    signal,
    provider
  });
  parsed = parseJSONFromText(retry);
  problem = parsed ? (validate ? validate(parsed) : null) : "The reply was not valid JSON.";
  if (problem) {
    throw new Error("The AI did not return a usable answer (" + problem + "). Raw reply: " + retry.slice(0, 300));
  }
  return parsed;
}

const LOG_SIGNAL = /FATAL_ERROR|EXCEPTION_THROWN|System\.\w*Exception|VALIDATION_FAIL|FLOW_ELEMENT_ERROR|DML_EXCEPTION|LIMIT_USAGE_FOR_NS|USER_DEBUG/;
const LOG_ERROR = /FATAL_ERROR|EXCEPTION_THROWN|System\.\w*Exception|VALIDATION_FAIL|FLOW_ELEMENT_ERROR|DML_EXCEPTION/;

// Fits a debug log into maxChars for the AI without losing what matters:
// the head (context), every error/exception window (±context lines, errors
// first, then USER_DEBUG lines), and the tail (how it ended). Omitted spans
// are marked so the model knows the excerpt is partial.
export function excerptLog(body, maxChars = 12000, {context = 6} = {}) {
  const text = String(body || "");
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const keep = new Set();
  const budget = {used: 0};
  const take = (i) => {
    if (i < 0 || i >= lines.length || keep.has(i)) return true;
    const cost = lines[i].length + 1;
    if (budget.used + cost > maxChars * 0.92) return false;
    keep.add(i);
    budget.used += cost;
    return true;
  };

  const headLines = Math.min(40, lines.length);
  for (let i = 0; i < headLines && budget.used < maxChars * 0.15; i++) take(i);
  const tailStart = Math.max(headLines, lines.length - 40);
  for (let i = lines.length - 1; i >= tailStart && budget.used < maxChars * 0.3; i--) take(i);

  const errors = [];
  const debugs = [];
  lines.forEach((l, i) => {
    if (LOG_ERROR.test(l)) errors.push(i);
    else if (LOG_SIGNAL.test(l)) debugs.push(i);
  });
  outer:
  for (const group of [errors, debugs]) {
    for (const i of group) {
      const span = group === errors ? context : 1;
      for (let j = i - span; j <= i + span; j++) {
        if (!take(j)) break outer;
      }
    }
  }

  const out = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (skipped) out.push(`... [${skipped} line${skipped === 1 ? "" : "s"} omitted] ...`);
      skipped = 0;
      out.push(lines[i]);
    } else {
      skipped++;
    }
  }
  if (skipped) out.push(`... [${skipped} line${skipped === 1 ? "" : "s"} omitted] ...`);
  return out.join("\n");
}
