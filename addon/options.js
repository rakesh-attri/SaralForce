import {LLM_PROVIDERS, getProviderConfig, getSavedConfig, saveConfig, getCelebrateVariant, setCelebrateVariant} from "./llm/llm-service.js";

let h = React.createElement;

const INSPECTOR_TAB_KEY = "sfoc_open_inspector_tab";
function openInspectorInNewTab() {
  try { return localStorage.getItem(INSPECTOR_TAB_KEY) === "true"; } catch (e) { return false; }
}
function setOpenInspectorTab(on) {
  try { localStorage.setItem(INSPECTOR_TAB_KEY, on ? "true" : "false"); } catch (e) { /* ignore */ }
}

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
  "gemini-4-argon": "Flagship reasoning - 1M context, deep multi-step work",
  "gemini-3.8-flash": "Workhorse Flash - Long-horizon coding and agents",
  "gemini-3.7-flash": "Everyday driver - Strong software engineering",
  "gemini-3.6-flash": "Balanced Flash - Coding and multimodal, efficient",
  "gemini-3.5-flash": "Fast Flash - Speed and price-performance",
  "gemini-3.5-flash-lite": "Cost-effective - High-throughput, low-latency",
  "gemini-3.1-pro-preview": "Pro tier - Software engineering, agentic workflows",
  "gemini-3.1-flash-lite": "Budget Flash - Most cost-efficient Gemini model"
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
      celebrate: getCelebrateVariant(),
      openInspectorTab: openInspectorInNewTab(),
      showApiKey: false,
      saved: false,
      testStatus: null,
      testMessage: "",
      appVersion: ""
    };
  }

  componentDidMount() {
    this.loadAppVersion();
  }

  // Manifest version shown next to Privacy Policy. Prefers the extension
  // API; falls back to reading manifest.json (harness shim has no
  // getManifest).
  loadAppVersion = async () => {
    try {
      const m = chrome?.runtime?.getManifest?.call(chrome.runtime);
      if (m && (m.version_name || m.version)) {
        this.setState({appVersion: m.version_name || m.version});
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      const r = await fetch("manifest.json");
      if (r.ok) {
        const m = await r.json();
        if (m && (m.version_name || m.version)) {
          this.setState({appVersion: m.version_name || m.version});
        }
      }
    } catch (e) { /* leave blank */ }
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

  onCelebrateChange(e) {
    setCelebrateVariant(e.target.value);
    this.setState({celebrate: getCelebrateVariant()});
  }

  onInspectorTabChange(e) {
    const on = e.target.checked;
    setOpenInspectorTab(on);
    this.setState({openInspectorTab: on});
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
        case "openrouter":
          const openrouterMod = await import("./llm/openai-compatible.js");
          providerImpl = new openrouterMod.OpenAICompatibleProvider();
          break;
      }

      const testMessages = [
        {role: "system", content: "Reply with exactly: OK"},
        {role: "user", content: "Test"}
      ];

      let result;
      if (provider === "openai_compatible" || provider === "openrouter") {
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
    const {provider, apiKey, model, baseUrl, celebrate, showApiKey, saved, testStatus, testMessage} = this.state;
    const providerDef = this.getProviderDef();

    return h("div", {className: "options-container"},
      h("div", {className: "options-header"},
        h("a", {href: "https://rakesh-attri.github.io/SaralForce/", target: "_blank", rel: "noopener noreferrer", title: "SaralForce home"},
          h("img", {className: "options-logo", src: "logo-full.png", alt: "SaralForce"})),
        h("h1", null, "Settings"),
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
                placeholder: "e.g., gpt-4o, claude-sonnet-5, gemini-4-argon"
              }),
          h("p", {className: "help-text"},
            provider === "openrouter"
              ? "Use an OpenRouter model ID (vendor/model), e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-5, google/gemini-3.5-flash, meta-llama/llama-3.3-70b-instruct"
              : "Recommended: GPT-5.6 Terra, Claude Sonnet 5, or Gemini 3.8 Flash")
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
        h("h2", null, "Preferences"),
        h("div", {className: "form-group"},
          h("label", {htmlFor: "celebrateVariant"}, "Success celebration"),
          h("select", {
            id: "celebrateVariant",
            className: "form-control",
            value: celebrate,
            onChange: (e) => this.onCelebrateChange(e)
          },
            h("option", {value: "plane"}, "Paper Plane"),
            h("option", {value: "confetti"}, "Confetti"),
            h("option", {value: "thor"}, "Thor Storm"),
            h("option", {value: "spidey"}, "Spider Web")
          ),
          h("p", {className: "help-text"},
            "Celebrate successful SOQL runs and Apex executions with an animation. Applies to both editors and takes effect on the next run.")
        ),
        h("div", {className: "form-group"},
          h("label", {className: "form-check", htmlFor: "openInspectorTab"},
            h("input", {
              id: "openInspectorTab",
              type: "checkbox",
              checked: this.state.openInspectorTab,
              onChange: (e) => this.onInspectorTabChange(e)
            }),
            h("span", null, "Open Inspector in new tab")),
          h("p", {className: "help-text"},
            "Open the Inspector panel in a full-page browser tab for better visibility. The ← AI Object Builder button jumps back to your Salesforce tab.")
        )
      ),

      h("div", {className: "options-section"},
        h("h2", null, "About"),
        h("p", null, "SaralForce is an AI Object Builder & Org Toolkit for Salesforce. Describe the data you want to capture in plain language and it drafts a complete custom object with fields — refine it in chat, improve prompts with one click, then deploy straight to your org."),
        h("p", null, "The built-in Inspector adds a SOQL runner with AI error fixes, Apex execution, record browser, CSV export and import, user management, debug-log viewer with AI analysis, org info, and app-tab assignment. Works with OpenAI, Anthropic Claude, Google Gemini, OpenRouter, or any OpenAI-compatible endpoint using your own API key."),
        h("p", null, "Your API key is stored locally in your browser and never shared. Org data stays between your browser and Salesforce — only the text you type reaches your chosen AI provider."),
        h("p", {style: {fontSize: "12px", color: "#706e6b"}},
          "Developed by Er.Bhajan Mandali © · Independent project, not affiliated with Salesforce. ",
          h("svg", {className: "ff-flag", width: 16, height: 11, viewBox: "0 0 18 12", "aria-label": "India"},
            h("rect", {width: 18, height: 4, fill: "#FF9933"}),
            h("rect", {y: 4, width: 18, height: 4, fill: "#FFFFFF"}),
            h("rect", {y: 8, width: 18, height: 4, fill: "#138808"}),
            h("circle", {cx: 9, cy: 6, r: 1.7, fill: "none", stroke: "#000080", strokeWidth: 0.6})
          )
        ),
        h("p", {style: {fontSize: "12px"}},
          h("a", {
            href: "https://rakesh-attri.github.io/SaralForce/privacy.html",
            target: "_blank",
            rel: "noopener noreferrer"
          }, "Privacy Policy"),
          this.state.appVersion ? ` · v${this.state.appVersion}` : "")
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
