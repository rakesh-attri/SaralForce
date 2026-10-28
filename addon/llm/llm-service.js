import {OpenAIProvider} from "./openai.js";
import {ClaudeProvider} from "./claude.js";
import {GeminiProvider} from "./gemini.js";
import {OpenAICompatibleProvider} from "./openai-compatible.js";
import {getSetting, setSetting} from "../core/storage.js";

export const LLM_PROVIDERS = {
  openai: {
    name: "OpenAI",
    models: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5-instant",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-4o",
      "gpt-4o-mini"
    ],
    defaultModel: "gpt-5.6-terra",
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-..."
  },
  claude: {
    name: "Anthropic Claude",
    models: [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-haiku-4-5"
    ],
    defaultModel: "claude-sonnet-5-5",
    requiresApiKey: true,
    apiKeyPlaceholder: "sk-ant-..."
  },
  gemini: {
    name: "Google Gemini",
    models: [
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite"
    ],
    defaultModel: "gemini-4-argon",
    requiresApiKey: true,
    apiKeyPlaceholder: "AIza..."
  },
  openai_compatible: {
    name: "OpenAI Compatible (OpenCodeZen, etc.)",
    models: [],
    defaultModel: "",
    requiresApiKey: true,
    requiresBaseUrl: true,
    apiKeyPlaceholder: "Your OpenCode Zen API key",
    baseUrlPlaceholder: "https://opencode.ai/zen/v1"
  },
  openrouter: {
    name: "OpenRouter",
    models: [],
    defaultModel: "openai/gpt-4o-mini",
    requiresApiKey: true,
    requiresBaseUrl: true,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyPlaceholder: "sk-or-v1-...",
    baseUrlPlaceholder: "https://openrouter.ai/api/v1"
  }
};

export function getProviderConfig(providerId) {
  return LLM_PROVIDERS[providerId] || null;
}

// ── Optional AI host permissions ──────────────────────────────
// AI provider endpoints are OPTIONAL host permissions (v1.4.22): the
// exact origin is requested from the user at Settings-save time, inside
// the Save click's user gesture. Loopback URLs (localhost proxies, the
// dev fixture) need no permission; pages without chrome.permissions
// (the fixture harness) always pass.
const FIXED_PROVIDER_ORIGINS = {
  openai: "https://api.openai.com/*",
  claude: "https://api.anthropic.com/*",
  gemini: "https://generativelanguage.googleapis.com/*"
};

export function effectiveBaseUrl(providerId, baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (raw) return raw;
  const def = LLM_PROVIDERS[providerId];
  return (def && def.defaultBaseUrl) || "";
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// Error text for an unusable base URL, or null when it is fine. API keys
// must never travel over plain http except to a local proxy.
export function validateBaseUrl(providerId, baseUrl) {
  const def = LLM_PROVIDERS[providerId];
  if (!def || !def.requiresBaseUrl) return null;
  const raw = effectiveBaseUrl(providerId, baseUrl);
  if (!raw) return "Base URL is required for this provider.";
  let u;
  try { u = new URL(raw); } catch (e) { return "Base URL is not a valid URL."; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return null;
  return "Base URL must start with https:// (plain http is only allowed for localhost).";
}

// Match pattern for the origin a provider will call, or null when no
// permission is needed (loopback / unparseable / not configured).
export function providerPermissionOrigin(providerId, baseUrl) {
  const fixed = FIXED_PROVIDER_ORIGINS[providerId];
  if (fixed) return fixed;
  const raw = effectiveBaseUrl(providerId, baseUrl);
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (isLoopbackHost(u.hostname)) return null;
  if (u.protocol !== "https:") return null;
  return u.origin + "/*";
}

export function checkProviderNetworkAccess(providerId, baseUrl) {
  const origin = providerPermissionOrigin(providerId, baseUrl);
  if (!origin) return Promise.resolve(true);
  if (typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.contains) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({origins: [origin]}, (ok) => resolve(!!ok));
    } catch (e) {
      resolve(true);
    }
  });
}

// Without the grant a cross-origin AI call fails as an opaque "Failed to
// fetch" (CORS). Check the permission first and explain the fix.
async function ensureProviderAccess(providerId, baseUrl) {
  const urlError = validateBaseUrl(providerId, baseUrl);
  if (urlError) throw new Error(urlError + " Fix it in SaralForce Settings.");
  const allowed = await checkProviderNetworkAccess(providerId, baseUrl);
  if (!allowed) {
    throw new Error("SaralForce needs network access to this AI provider. Open Settings and click Save Settings to grant access, then try again.");
  }
}

function wrapProviderAccess(providerId, impl) {
  const origSend = impl.sendMessage.bind(impl);
  impl.sendMessage = async (messages, apiKey, model, onChunk, baseUrl, options) => {
    const url = effectiveBaseUrl(providerId, baseUrl);
    await ensureProviderAccess(providerId, url);
    return origSend(messages, apiKey, model, onChunk, url, options || {});
  };
  if (impl.listModels) {
    const origList = impl.listModels.bind(impl);
    impl.listModels = async (apiKey, baseUrl) => {
      const url = effectiveBaseUrl(providerId, baseUrl);
      await ensureProviderAccess(providerId, url);
      return origList(apiKey, url);
    };
  }
  return impl;
}

export function getLLMProvider(providerId) {
  switch (providerId) {
    case "openai":
      return wrapProviderAccess(providerId, new OpenAIProvider());
    case "claude":
      return wrapProviderAccess(providerId, new ClaudeProvider());
    case "gemini":
      return wrapProviderAccess(providerId, new GeminiProvider());
    case "openai_compatible":
      return wrapProviderAccess(providerId, new OpenAICompatibleProvider());
    case "openrouter":
      return wrapProviderAccess(providerId, new OpenAICompatibleProvider());
    default:
      throw new Error(`Unknown LLM provider: ${providerId}`);
  }
}

// Settings live in chrome.storage via core/storage.js; pages await
// initSettings() before rendering so these reads are synchronous.
export function getSavedConfig() {
  const config = getSetting("llmConfig", null);
  return config && typeof config === "object" ? config : null;
}

export function saveConfig(config) {
  setSetting("llmConfig", config);
}

export function hasValidConfig() {
  const config = getSavedConfig();
  if (!config) return false;
  if (!config.provider) return false;
  const providerDef = LLM_PROVIDERS[config.provider];
  if (!providerDef) return false;
  if (providerDef.requiresApiKey && !config.apiKey) return false;
  if (validateBaseUrl(config.provider, config.baseUrl)) return false;
  return true;
}

// Model IDs last fetched from the provider's models endpoint, per provider.
const MODEL_CACHE_KEY = "llmModelCache";

function modelCache() {
  const cache = getSetting(MODEL_CACHE_KEY, {});
  return cache && typeof cache === "object" ? cache : {};
}

export function getCachedModels(providerId) {
  const list = modelCache()[providerId];
  return Array.isArray(list) ? list : [];
}

export function setCachedModels(providerId, models) {
  setSetting(MODEL_CACHE_KEY, {...modelCache(), [providerId]: models});
}

// Models to offer for a provider: fetched ones first, then the curated list.
export function getModelOptions(providerId) {
  const def = LLM_PROVIDERS[providerId];
  const curated = def ? def.models : [];
  return Array.from(new Set([...getCachedModels(providerId), ...curated]));
}

// Editor success celebration: "plane" (default), "confetti", "thor" or
// "spidey". A shared setting because it is changed from options.html.
export const CELEBRATE_VARIANT_KEY = "sfoc_celebrate";
export const CELEBRATE_VARIANTS = ["plane", "confetti", "thor", "spidey"];

export function getCelebrateVariant() {
  const v = getSetting(CELEBRATE_VARIANT_KEY, "plane");
  return CELEBRATE_VARIANTS.includes(v) ? v : "plane";
}

export function setCelebrateVariant(variant) {
  setSetting(CELEBRATE_VARIANT_KEY, CELEBRATE_VARIANTS.includes(variant) ? variant : "plane");
}
