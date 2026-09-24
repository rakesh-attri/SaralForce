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
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash"
    ],
    defaultModel: "gemini-3.8-flash",
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
  }
};

export function getProviderConfig(providerId) {
  return LLM_PROVIDERS[providerId] || null;
}

export function getLLMProvider(providerId) {
  switch (providerId) {
    case "openai":
      return new OpenAIProvider();
    case "claude":
      return new ClaudeProvider();
    case "gemini":
      return new GeminiProvider();
    case "openai_compatible":
      return new OpenAICompatibleProvider();
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
