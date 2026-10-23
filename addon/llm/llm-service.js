import {OpenAIProvider} from "./openai.js";
import {ClaudeProvider} from "./claude.js";
import {GeminiProvider} from "./gemini.js";
import {OpenAICompatibleProvider} from "./openai-compatible.js";

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
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-20250514"
    ],
    defaultModel: "claude-sonnet-5",
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

// Match pattern for the origin a provider will call, or null when no
// permission is needed (loopback / unparseable / not configured).
export function providerPermissionOrigin(providerId, baseUrl) {
  const fixed = FIXED_PROVIDER_ORIGINS[providerId];
  if (fixed) return fixed;
  let raw = String(baseUrl || "").trim();
  if (!raw && providerId === "openrouter") raw = "https://openrouter.ai/api/v1";
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1") return null;
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
function wrapProviderAccess(providerId, impl) {
  const origSend = impl.sendMessage.bind(impl);
  impl.sendMessage = async (messages, apiKey, model, onChunk, baseUrl) => {
    const allowed = await checkProviderNetworkAccess(providerId, baseUrl);
    if (!allowed) {
      throw new Error("SaralForce needs network access to this AI provider. Open Settings and click Save Settings to grant access, then try again.");
    }
    return origSend(messages, apiKey, model, onChunk, baseUrl);
  };
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

export function getSavedConfig() {
  const config = localStorage.getItem("llmConfig");
  if (config) {
    try {
      return JSON.parse(config);
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function saveConfig(config) {
  localStorage.setItem("llmConfig", JSON.stringify(config));
}

export function hasValidConfig() {
  const config = getSavedConfig();
  if (!config) return false;
  if (!config.provider) return false;
  const providerDef = LLM_PROVIDERS[config.provider];
  if (!providerDef) return false;
  if (providerDef.requiresApiKey && !config.apiKey) return false;
  if (providerDef.requiresBaseUrl && !config.baseUrl) return false;
  return true;
}

// Editor success celebration: "plane" (default), "confetti", "thor" or
// "spidey". Lives in localStorage (shared across the options page and the
// panel like llmConfig) instead of ffUseSession, because the setting is
// changed from options.html.
export const CELEBRATE_VARIANT_KEY = "sfoc_celebrate";
export const CELEBRATE_VARIANTS = ["plane", "confetti", "thor", "spidey"];

export function getCelebrateVariant() {
  try {
    const v = localStorage.getItem(CELEBRATE_VARIANT_KEY);
    return CELEBRATE_VARIANTS.includes(v) ? v : "plane";
  } catch (e) {
    return "plane";
  }
}

export function setCelebrateVariant(variant) {
  try {
    localStorage.setItem(CELEBRATE_VARIANT_KEY, CELEBRATE_VARIANTS.includes(variant) ? variant : "plane");
  } catch (e) { /* ignore */ }
}
