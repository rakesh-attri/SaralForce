import {LLM_PROVIDERS, getSavedConfig, saveConfig, getCelebrateVariant, setCelebrateVariant, getLLMProvider, providerPermissionOrigin, checkProviderNetworkAccess, validateBaseUrl, getModelOptions, setCachedModels} from "./llm/llm-service.js";

import {initSettings} from "./core/storage.js";
import {openInspectorInNewTab, setOpenInspectorInNewTab} from "./core/preferences.js";
import {startTour} from "./ui/tour.js";
import {SETTINGS_TOUR} from "./ui/tour-content.js";
import {shouldAutoStart, markTourDone} from "./core/tours.js";

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
  "claude-sonnet-5-5": "Recommended - Speed and intelligence for everyday work",
  "claude-opus-5-5": "Most capable Opus - Complex reasoning and coding",
  "claude-haiku-5-5": "Fastest and lowest cost",
  "claude-fable-5-1": "Most capable tier - Demanding, long-horizon work",
  "claude-sonnet-5": "Previous Sonnet",
  "claude-opus-5": "Previous Opus",
  "claude-opus-4-8": "Older Opus",
  "claude-haiku-4-5": "Older Haiku",
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
      appVersion: "",
      permMissing: false,
      permDenied: false,
      permHost: "",
      saveError: "",
      modelOptions: getModelOptions(saved.provider || "openai"),
      modelsStatus: null,
      modelsMessage: ""
    };
  }

  componentDidMount() {
    // First visit (normally right after install): a short setup tour.
    if (shouldAutoStart(SETTINGS_TOUR.id)) {
      setTimeout(() => startTour(SETTINGS_TOUR).then(() => markTourDone(SETTINGS_TOUR.id)), 500);
    }
    this.loadAppVersion();
    this.refreshPermStatus();
  }

  // Permission state for the selected provider's host (optional host
  // permissions, v1.4.22). No-op in the fixture harness (no chrome.permissions).
  refreshPermStatus = async () => {
    const {provider, baseUrl} = this.state;
    const origin = providerPermissionOrigin(provider, baseUrl);
    const allowed = await checkProviderNetworkAccess(provider, baseUrl);
    this.setState({
      permMissing: !allowed,
      permDenied: false,
      permHost: origin ? origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "") : ""
    });
  };

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
    // Keep the typed key/URL, but always switch to the new provider's default
    // model: a model id from another provider would only fail.
    this.setState({
      provider,
      model: providerDef.defaultModel,
      modelOptions: getModelOptions(provider),
      modelsStatus: null,
      saveError: "",
      saved: false,
      testStatus: null
    }, () => this.refreshPermStatus());
  }

  onApiKeyChange(e) {
    this.setState({apiKey: e.target.value, saved: false, testStatus: null});
  }

  onModelChange(e) {
    this.setState({model: e.target.value, saved: false});
  }

  onBaseUrlChange(e) {
    this.setState({baseUrl: e.target.value, saved: false, saveError: "", testStatus: null},
      () => this.refreshPermStatus());
  }

  onCelebrateChange(e) {
    setCelebrateVariant(e.target.value);
    this.setState({celebrate: getCelebrateVariant()});
  }

  onInspectorTabChange(e) {
    const on = e.target.checked;
    setOpenInspectorInNewTab(on);
    this.setState({openInspectorTab: on});
  }

  toggleShowApiKey() {
    this.setState(prev => ({showApiKey: !prev.showApiKey}));
  }

  saveConfig() {
    const {provider, apiKey, model, baseUrl} = this.state;
    const urlError = validateBaseUrl(provider, baseUrl);
    if (urlError) {
      this.setState({saveError: urlError, saved: false});
      return;
    }
    this.setState({saveError: ""});
    const origin = providerPermissionOrigin(provider, baseUrl);
    // chrome.permissions.request must be kicked off synchronously inside
    // the Save click (user gesture). It is a silent no-op when the origin
    // is already granted or needs no permission (loopback / fixture).
    const request = (origin && typeof chrome !== "undefined" &&
      chrome.permissions && chrome.permissions.request)
      ? new Promise((resolve) => {
          try { chrome.permissions.request({origins: [origin]}, (ok) => resolve(!!ok)); }
          catch (e) { resolve(false); }
        })
      : Promise.resolve(true);
    request.then((granted) => {
      saveConfig({provider, apiKey, model, baseUrl});
      this.setState({
        saved: true,
        permDenied: !granted,
        permMissing: false,
        permHost: origin ? origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "") : ""
      });
      setTimeout(() => this.setState({saved: false}), 2000);
    });
  }

  grantPermission() {
    const origin = providerPermissionOrigin(this.state.provider, this.state.baseUrl);
    if (!origin || typeof chrome === "undefined" || !chrome.permissions || !chrome.permissions.request) return;
    const host = origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
    try {
      chrome.permissions.request({origins: [origin]}, (ok) => {
        this.setState({permDenied: !ok, permMissing: !ok, permHost: host});
      });
    } catch (e) { /* ignore */ }
  }

  async testConnection() {
    const {provider, apiKey, model, baseUrl} = this.state;
    this.setState({testStatus: "testing", testMessage: "Testing connection..."});

    try {
      const providerImpl = getLLMProvider(provider);

      const testMessages = [
        {role: "system", content: "Reply with exactly: OK"},
        {role: "user", content: "Test"}
      ];

      const result = await providerImpl.sendMessage(testMessages, apiKey, model, null, baseUrl);
      if (!String(result || "").trim()) {
        throw new Error("The provider answered with an empty reply. Check the model name.");
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

  async refreshModels() {
    const {provider, apiKey, baseUrl} = this.state;
    if (!apiKey) {
      this.setState({modelsStatus: "error", modelsMessage: "Enter your API key first."});
      return;
    }
    this.setState({modelsStatus: "loading", modelsMessage: "Loading models..."});
    try {
      const providerImpl = getLLMProvider(provider);
      const models = await providerImpl.listModels(apiKey, baseUrl);
      if (!models.length) throw new Error("The provider returned no models.");
      setCachedModels(provider, models);
      this.setState({
        modelOptions: getModelOptions(provider),
        modelsStatus: "success",
        modelsMessage: `${models.length} models available.`
      });
    } catch (error) {
      this.setState({modelsStatus: "error", modelsMessage: error && error.message ? error.message : String(error)});
    }
  }

  render() {
    const {provider, apiKey, model, baseUrl, celebrate, showApiKey, saved, testStatus, testMessage, modelOptions, modelsStatus, modelsMessage} = this.state;
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
              type: "button",
              "aria-pressed": showApiKey,
              "aria-label": showApiKey ? "Hide API key" : "Show API key"
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
          h("div", {className: "input-with-toggle"},
            h("input", {
              id: "model",
              type: "text",
              className: "form-control",
              list: "model-options",
              autoComplete: "off",
              spellCheck: false,
              value: model,
              onChange: (e) => this.onModelChange(e),
              placeholder: providerDef.defaultModel || "Model ID"
            }),
            h("button", {
              className: "toggle-btn",
              type: "button",
              onClick: () => this.refreshModels(),
              disabled: modelsStatus === "loading",
              title: "Load the models your API key can use"
            }, modelsStatus === "loading" ? "Loading..." : "Refresh list")
          ),
          h("datalist", {id: "model-options"},
            modelOptions.map(m =>
              h("option", {key: m, value: m}, MODEL_DESCRIPTIONS[m] || "")
            )
          ),
          modelsStatus && modelsStatus !== "loading" && h("p", {
            className: `help-text ${modelsStatus === "error" ? "help-error" : ""}`,
            role: modelsStatus === "error" ? "alert" : "status"
          }, modelsMessage),
          h("p", {className: "help-text"},
            provider === "openrouter"
              ? "Use an OpenRouter model ID (vendor/model), e.g. openai/gpt-4o-mini or anthropic/claude-sonnet-5-5. Pick from the list or type any model ID."
              : "Pick a suggested model or type any model ID. Refresh list loads the models your API key can use.")
        ),

        h("div", {className: "button-group", "data-tour": "settings-actions"},
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

        this.state.saveError && h("div", {className: "test-result test-error", role: "alert"}, this.state.saveError),

        testStatus && h("div", {
          className: `test-result test-${testStatus}`,
          role: testStatus === "error" ? "alert" : "status"
        }, testMessage),

        this.state.permDenied && h("div", {className: "test-result test-error"},
          `Network access to ${this.state.permHost} was not granted — AI calls to this provider will fail until access is granted. `,
          h("button", {className: "btn btn-secondary btn-grant", onClick: () => this.grantPermission()}, "Grant access")),

        this.state.permMissing && !this.state.permDenied && h("div", {className: "test-result test-error"},
          `SaralForce needs your permission to reach ${this.state.permHost}. It is requested when you click Save Settings. `,
          h("button", {className: "btn btn-secondary btn-grant", onClick: () => this.grantPermission()}, "Grant access"))
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
        h("p", null, "Your API key is stored locally in your browser and is sent only to the AI provider you choose. Org data stays between your browser and Salesforce — only the text you type (plus the minimal schema context a task needs) reaches your chosen AI provider."),
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

initSettings().then(() => {
  ReactDOM.render(
    h(OptionsApp, {sfHost}),
    document.getElementById("root")
  );
});
