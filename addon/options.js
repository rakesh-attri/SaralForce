import {LLM_PROVIDERS, getProviderConfig, getSavedConfig, saveConfig} from "./llm/llm-service.js";

let h = React.createElement;

const MODEL_DESCRIPTIONS = {
  // OpenAI
  "gpt-5.6-sol": "Flagship - Best for complex workflows, coding, science",
  "gpt-5.6-terra": "Balanced - Everyday work, intelligence + cost efficient",
  "gpt-5.6-luna": "Cost-efficient - Fast responses, high-volume workloads",
  "gpt-5.5-instant": "Default ChatGPT model - Everyday tasks, writing",
  "gpt-5.5-pro": "High-end reasoning - Deep analysis, complex programming",
  "gpt-5.4": "Advanced reasoning - Precise problem solving",
  "gpt-5.4-mini": "Efficiency - Coding, subagents, task assistance",
  "gpt-5.4-nano": "Ultra-efficient - Classification, data extraction",
  "gpt-4o": "Previous gen multimodal - Text, image, audio",
  "gpt-4o-mini": "Previous gen efficient - Budget-friendly",
  // Claude
  "claude-fable-5-1": "Mythos-class - Demanding reasoning, long-horizon agents",
  "claude-opus-5": "Opus tier - Complex agentic coding, enterprise",
  "claude-sonnet-5": "Best speed+intelligence balance - Everyday coding",
  "claude-haiku-4-5-20251001": "Fastest - Near-frontier intelligence, low cost",
  "claude-opus-4-8": "Previous Opus gen - Still capable, fast mode support",
  "claude-sonnet-4-20250514": "Previous Sonnet gen - Solid general purpose",
  // Gemini
  "gemini-3.8-flash": "Latest Flash - Best reasoning & coding, agentic tasks",
  "gemini-3.7-flash": "Previous Flash - Good balance of speed and capability",
  "gemini-3.5-flash": "GA Flash - Intelligent, sustained frontier performance",
  "gemini-3.5-flash-lite": "Cost-effective - High-throughput, low-latency",
  "gemini-3.1-pro-preview": "Pro tier - Software engineering, agentic workflows",
  "gemini-3.1-flash-lite": "Budget Flash - Most cost-efficient Gemini model",
  "gemini-2.5-pro": "Previous Pro gen - Strong reasoning, large context",
  "gemini-2.5-flash": "Previous Flash gen - Fast, efficient"
};

class OptionsApp extends React.Component {
  constructor(props) {
    super(props);
    const saved = getSavedConfig() || {};
    this.state = {
      provider: saved.provider || "openai",
      apiKey: saved.apiKey || "",
      model: saved.model || "",
      baseUrl: saved.baseUrl || "",
      showApiKey: false,
      saved: false,
      testStatus: null,
      testMessage: ""
    };
  }

  getProviderDef() {
    return LLM_PROVIDERS[this.state.provider];
  }

  onProviderChange(e) {
    const provider = e.target.value;
    const providerDef = LLM_PROVIDERS[provider];
    // Preserve typed key/URL — wiping them silently is why saved details
    // "disappear". Only refresh the model default when it is still empty
    // or still the previous provider's default.
    const prevDef = LLM_PROVIDERS[this.state.provider];
    this.setState(prev => ({
      provider,
      model: (!prev.model || (prevDef && prev.model === prevDef.defaultModel))
        ? providerDef.defaultModel
        : prev.model,
      saved: false,
      testStatus: null
    }));
  }

  onApiKeyChange(e) {
    this.setState({apiKey: e.target.value, saved: false, testStatus: null});
  }

  onModelChange(e) {
    this.setState({model: e.target.value, saved: false});
  }

  onBaseUrlChange(e) {
    this.setState({baseUrl: e.target.value, saved: false, testStatus: null});
  }

  toggleShowApiKey() {
    this.setState(prev => ({showApiKey: !prev.showApiKey}));
  }

  saveConfig() {
    const {provider, apiKey, model, baseUrl} = this.state;
    saveConfig({provider, apiKey, model, baseUrl});
    this.setState({saved: true});
    setTimeout(() => this.setState({saved: false}), 2000);
  }

  async testConnection() {
    const {provider, apiKey, model, baseUrl} = this.state;
    this.setState({testStatus: "testing", testMessage: "Testing connection..."});

    try {
      let providerImpl;
      switch (provider) {
        case "openai":
          const {OpenAIProvider} = await import("./llm/openai.js");
          providerImpl = new OpenAIProvider();
          break;
        case "claude":
          const {ClaudeProvider} = await import("./llm/claude.js");
          providerImpl = new ClaudeProvider();
          break;
        case "gemini":
          const {GeminiProvider} = await import("./llm/gemini.js");
          providerImpl = new GeminiProvider();
          break;
        case "openai_compatible":
          const {OpenAICompatibleProvider} = await import("./llm/openai-compatible.js");
          providerImpl = new OpenAICompatibleProvider();
          break;
      }

      const testMessages = [
        {role: "system", content: "Reply with exactly: OK"},
        {role: "user", content: "Test"}
      ];

      let result;
      if (provider === "openai_compatible") {
        result = await providerImpl.sendMessage(testMessages, apiKey, model, null, baseUrl);
      } else {
        result = await providerImpl.sendMessage(testMessages, apiKey, model);
      }

      this.setState({testStatus: "success", testMessage: "Connection successful!"});
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      const hint = /Failed to fetch|Network error|Background/i.test(msg)
        ? " — Go to chrome://extensions → refresh this extension, then Test again."
        : "";
      this.setState({testStatus: "error", testMessage: msg + hint});
    }
  }

  render() {
    const {provider, apiKey, model, baseUrl, showApiKey, saved, testStatus, testMessage} = this.state;
    const providerDef = this.getProviderDef();

    return h("div", {className: "options-container"},
      h("div", {className: "options-header"},
        h("h1", null, "ForceForge - Settings"),
        h("p", {className: "subtitle"}, "Configure your AI provider for generating Salesforce objects and fields")
      ),

      h("div", {className: "options-section"},
        h("h2", null, "LLM Provider"),
        h("div", {className: "form-group"},
          h("label", {htmlFor: "provider"}, "Provider"),
          h("select", {
            id: "provider",
            className: "form-control",
            value: provider,
            onChange: (e) => this.onProviderChange(e)
          },
            Object.entries(LLM_PROVIDERS).map(([id, def]) =>
              h("option", {key: id, value: id}, def.name)
            )
          )
        ),

        h("div", {className: "form-group"},
          h("label", {htmlFor: "apiKey"}, "API Key"),
          h("div", {className: "input-with-toggle"},
            h("input", {
              id: "apiKey",
              type: showApiKey ? "text" : "password",
              className: "form-control",
              value: apiKey,
              onChange: (e) => this.onApiKeyChange(e),
              placeholder: providerDef.apiKeyPlaceholder
            }),
            h("button", {
              className: "toggle-btn",
              onClick: () => this.toggleShowApiKey(),
              type: "button"
            }, showApiKey ? "Hide" : "Show")
          )
        ),

        providerDef.requiresBaseUrl && h("div", {className: "form-group"},
          h("label", {htmlFor: "baseUrl"}, "Base URL"),
          h("input", {
            id: "baseUrl",
            type: "text",
            className: "form-control",
            value: baseUrl,
            onChange: (e) => this.onBaseUrlChange(e),
            placeholder: providerDef.baseUrlPlaceholder
          }),
          h("p", {className: "help-text"}, "Include the full base URL (e.g., https://api.example.com/v1)")
        ),

        h("div", {className: "form-group"},
          h("label", {htmlFor: "model"}, "Model"),
          providerDef.models.length > 0
            ? h("select", {
                id: "model",
                className: "form-control",
                value: model,
                onChange: (e) => this.onModelChange(e)
              },
                providerDef.models.map(m =>
                  h("option", {key: m, value: m}, MODEL_DESCRIPTIONS[m] ? `${m} - ${MODEL_DESCRIPTIONS[m]}` : m)
                )
              )
            : h("input", {
                id: "model",
                type: "text",
                className: "form-control",
                value: model,
                onChange: (e) => this.onModelChange(e),
                placeholder: "e.g., gpt-4o, claude-sonnet-5, gemini-3.8-flash"
              }),
          h("p", {className: "help-text"}, "Recommended: GPT-5.6 Terra, Claude Sonnet 5, or Gemini 3.8 Flash")
        ),

        h("div", {className: "button-group"},
          h("button", {
            className: "btn btn-primary",
            onClick: () => this.saveConfig()
          }, saved ? "Saved!" : "Save Settings"),
          h("button", {
            className: "btn btn-secondary",
            onClick: () => this.testConnection(),
            disabled: testStatus === "testing"
          }, testStatus === "testing" ? "Testing..." : "Test Connection")
        ),

        testStatus && h("div", {
          className: `test-result test-${testStatus}`
        }, testMessage)
      ),

      h("div", {className: "options-section"},
        h("h2", null, "About"),
        h("p", null, "ForceForge is an AI Object Builder & Org Toolkit for Salesforce. Describe the data you want to capture in plain language and it drafts a complete custom object with fields — refine it in chat, improve prompts with one click, then deploy straight to your org."),
        h("p", null, "The built-in Inspector adds a SOQL runner with AI error fixes, Apex execution, record browser, CSV export and import, user management, debug-log viewer with AI analysis, org info, and app-tab assignment. Works with OpenAI, Anthropic Claude, Google Gemini, or any OpenAI-compatible endpoint using your own API key."),
        h("p", null, "Your API key is stored locally in your browser and never shared. Org data stays between your browser and Salesforce — only the text you type reaches your chosen AI provider."),
        h("p", {style: {fontSize: "12px", color: "#706e6b"}}, "Developed by ©Bhajan Mandali · Independent project, not affiliated with Salesforce.")
      )
    );
  }
}

const urlParams = new URLSearchParams(window.location.search);
const sfHost = urlParams.get("host");

ReactDOM.render(
  h(OptionsApp, {sfHost}),
  document.getElementById("root")
);
