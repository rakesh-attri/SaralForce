import {LLM_PROVIDERS, getSavedConfig, saveConfig, getCelebrateVariant, setCelebrateVariant, getLLMProvider, providerPermissionOrigin, checkProviderNetworkAccess, validateBaseUrl, getModelOptions, setCachedModels, hasValidConfig} from "./llm/llm-service.js";

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

// Provider tiles: short name, one line, where to get a key.
const PROVIDER_SHORT = {openai: "OpenAI", claude: "Anthropic Claude", gemini: "Google Gemini", openrouter: "OpenRouter", openai_compatible: "OpenAI-compatible"};
const PROVIDER_BLURB = {
  openai: "GPT models",
  claude: "Claude models",
  gemini: "Gemini models",
  openrouter: "Many models, one key",
  openai_compatible: "Any compatible endpoint"
};
const PROVIDER_KEY_LINKS = {
  openai: "https://platform.openai.com/api-keys",
  claude: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys"
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
      modelsMessage: "",
      keyCleared: false
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

  // Remove the saved key: AI features switch off, everything else keeps working.
  clearKey() {
    const {provider, model, baseUrl} = this.state;
    saveConfig({provider, apiKey: "", model, baseUrl});
    this.setState({apiKey: "", saved: false, testStatus: null, keyCleared: true});
    setTimeout(() => this.setState({keyCleared: false}), 2500);
  }

  render() {
    const {provider, apiKey, model, baseUrl, celebrate, showApiKey, saved, testStatus, testMessage, modelOptions, modelsStatus, modelsMessage} = this.state;
    const providerDef = this.getProviderDef();
    const aiReady = hasValidConfig();
    const keyLink = PROVIDER_KEY_LINKS[provider];

    return h("div", {className: "opt"},
      // ── Header ──
      h("header", {className: "opt-hero"},
        h("div", {className: "opt-hero-in"},
          h("a", {className: "opt-brand", href: "https://rakesh-attri.github.io/SaralForce/", target: "_blank", rel: "noopener noreferrer", title: "SaralForce website"},
            h("img", {className: "opt-logo", src: "logo-full.png", alt: "SaralForce"})),
          h("div", {className: "opt-hero-text"},
            h("h1", null, "Settings"),
            h("p", null, "Set up the optional AI assistant and a few preferences.")),
          this.state.appVersion && h("span", {className: "opt-version"}, `v${this.state.appVersion}`))),

      h("main", {className: "opt-main"},
        // ── AI is optional ──
        h("section", {className: "opt-note", "aria-labelledby": "opt-note-h"},
          h("div", {className: "opt-note-ico", "aria-hidden": "true"}, "💡"),
          h("div", null,
            h("h2", {id: "opt-note-h"}, "AI is optional — SaralForce works fully without it"),
            h("p", null,
              "Every core tool is ready the moment you open a Salesforce page: Records, SOQL, Run Apex, Export, Import, " +
              "API Explorer, Logs, Users, Access, Metadata, Org Info, App Tab Manager and Code Coverage. They use only your " +
              "Salesforce login — no API key, no extra cost, and nothing is sent anywhere else."),
            h("p", null,
              "AI simply adds helpers on top, marked with ✨: design a custom object from one sentence, write or fix SOQL, " +
              "explain debug logs, flows and failing tests, and draft validation rules, Apex or Lightning components. " +
              "If you want them, add your own key below; if not, you can skip this page."),
            h("ul", {className: "opt-note-points"},
              h("li", null, "Bring your own key — you choose the provider and pay it directly"),
              h("li", null, "Your key stays in this browser and goes only to that provider"),
              h("li", null, "Turn it off any time with Remove key")))),

        // ── AI assistant ──
        h("section", {className: "opt-card"},
          h("div", {className: "opt-card-h"},
            h("div", null,
              h("h2", null, "AI assistant ", h("span", {className: "opt-optional"}, "optional")),
              h("p", null, "Used only by the ✨ features.")),
            h("span", {className: "opt-status " + (aiReady ? "on" : "off")},
              h("span", {className: "opt-dot", "aria-hidden": "true"}),
              aiReady ? "Ready" : "Not set up")),

          h("div", {className: "opt-step"},
            h("div", {className: "opt-step-h"}, h("span", {className: "opt-num"}, "1"), "Choose a provider"),
            h("div", {id: "provider", className: "opt-providers", role: "radiogroup", "aria-label": "AI provider"},
              Object.entries(LLM_PROVIDERS).map(([id, def]) => h("button", {
                key: id,
                type: "button",
                role: "radio",
                "aria-checked": provider === id,
                className: "opt-provider" + (provider === id ? " active" : ""),
                onClick: () => provider !== id && this.onProviderChange({target: {value: id}})
              },
                h("span", {className: "opt-provider-n"}, PROVIDER_SHORT[id] || def.name),
                h("span", {className: "opt-provider-d"}, PROVIDER_BLURB[id] || ""))))),

          h("div", {className: "opt-step"},
            h("div", {className: "opt-step-h"}, h("span", {className: "opt-num"}, "2"), "Add your API key",
              keyLink && h("a", {className: "opt-link", href: keyLink, target: "_blank", rel: "noopener noreferrer"}, "Get a key ↗")),
            h("div", {className: "opt-inline"},
              h("input", {
                id: "apiKey",
                type: showApiKey ? "text" : "password",
                className: "opt-input",
                value: apiKey,
                autoComplete: "off",
                spellCheck: false,
                onChange: (e) => this.onApiKeyChange(e),
                placeholder: providerDef.apiKeyPlaceholder,
                "aria-label": "API key"
              }),
              h("button", {
                className: "opt-btn opt-btn-ghost",
                onClick: () => this.toggleShowApiKey(),
                type: "button",
                "aria-pressed": showApiKey,
                "aria-label": showApiKey ? "Hide API key" : "Show API key"
              }, showApiKey ? "Hide" : "Show")),
            providerDef.requiresBaseUrl && h("div", {className: "opt-field"},
              h("label", {htmlFor: "baseUrl"}, "Base URL"),
              h("input", {
                id: "baseUrl",
                type: "text",
                className: "opt-input",
                value: baseUrl,
                spellCheck: false,
                onChange: (e) => this.onBaseUrlChange(e),
                placeholder: providerDef.baseUrlPlaceholder
              }),
              h("p", {className: "opt-help"}, "The full base URL, e.g. https://api.example.com/v1"))),

          h("div", {className: "opt-step"},
            h("div", {className: "opt-step-h"}, h("span", {className: "opt-num"}, "3"), "Pick a model"),
            h("div", {className: "opt-inline"},
              h("input", {
                id: "model",
                type: "text",
                className: "opt-input",
                list: "model-options",
                autoComplete: "off",
                spellCheck: false,
                value: model,
                onChange: (e) => this.onModelChange(e),
                placeholder: providerDef.defaultModel || "Model ID",
                "aria-label": "Model"
              }),
              h("button", {
                className: "opt-btn opt-btn-ghost",
                type: "button",
                onClick: () => this.refreshModels(),
                disabled: modelsStatus === "loading",
                title: "Load the models your API key can use"
              }, modelsStatus === "loading" ? "Loading…" : "↻ Refresh list")),
            h("datalist", {id: "model-options"},
              modelOptions.map(m => h("option", {key: m, value: m}, MODEL_DESCRIPTIONS[m] || ""))),
            MODEL_DESCRIPTIONS[model] && h("p", {className: "opt-help opt-model-d"}, MODEL_DESCRIPTIONS[model]),
            modelsStatus && modelsStatus !== "loading" && h("p", {
              className: "opt-help " + (modelsStatus === "error" ? "opt-help-err" : "opt-help-ok"),
              role: modelsStatus === "error" ? "alert" : "status"
            }, modelsMessage),
            h("p", {className: "opt-help"},
              provider === "openrouter"
                ? "Use an OpenRouter model ID (vendor/model), e.g. openai/gpt-4o-mini or anthropic/claude-sonnet-5-5."
                : "Pick a suggestion or type any model ID. Refresh list shows the models your key can use.")),

          h("div", {className: "opt-actions", "data-tour": "settings-actions"},
            h("button", {className: "opt-btn opt-btn-primary", onClick: () => this.saveConfig()},
              saved ? "✓ Saved" : "Save settings"),
            h("button", {
              className: "opt-btn opt-btn-secondary",
              onClick: () => this.testConnection(),
              disabled: testStatus === "testing" || !apiKey
            }, testStatus === "testing" ? "Testing…" : "Test connection"),
            (apiKey || aiReady) && h("button", {
              className: "opt-btn opt-btn-text",
              type: "button",
              title: "Delete the saved key — AI features switch off, everything else keeps working",
              onClick: () => this.clearKey()
            }, "Remove key")),

          this.state.keyCleared && h("div", {className: "opt-alert ok", role: "status"},
            "Key removed. AI features are off; every other tool works as before."),
          this.state.saveError && h("div", {className: "opt-alert err", role: "alert"}, this.state.saveError),
          testStatus && h("div", {
            className: "opt-alert " + (testStatus === "success" ? "ok" : testStatus === "error" ? "err" : "info"),
            role: testStatus === "error" ? "alert" : "status"
          }, testStatus === "success" ? "✓ Connected — the AI features are ready to use." : testMessage),
          this.state.permDenied && h("div", {className: "opt-alert warn"},
            h("span", null, `Network access to ${this.state.permHost} was not granted, so AI requests will fail until you allow it.`),
            h("button", {className: "opt-btn opt-btn-small", onClick: () => this.grantPermission()}, "Allow access")),
          this.state.permMissing && !this.state.permDenied && h("div", {className: "opt-alert warn"},
            h("span", null, `To use this provider, SaralForce needs permission to reach ${this.state.permHost}. Chrome asks when you save — or allow it now.`),
            h("button", {className: "opt-btn opt-btn-small", onClick: () => this.grantPermission()}, "Allow access"))),

        // ── Preferences ──
        h("section", {className: "opt-card"},
          h("div", {className: "opt-card-h"},
            h("div", null,
              h("h2", null, "Preferences"),
              h("p", null, "Small touches that apply everywhere."))),
          h("div", {className: "opt-pref"},
            h("div", {className: "opt-pref-t"},
              h("label", {htmlFor: "celebrateVariant"}, "Success celebration"),
              h("p", {className: "opt-help"}, "A short animation after a successful SOQL run or Apex execution.")),
            h("select", {
              id: "celebrateVariant",
              className: "opt-input opt-select",
              value: celebrate,
              onChange: (e) => this.onCelebrateChange(e)
            },
              h("option", {value: "plane"}, "Paper Plane"),
              h("option", {value: "confetti"}, "Confetti"),
              h("option", {value: "thor"}, "Thor Storm"),
              h("option", {value: "spidey"}, "Spider Web"))),
          h("div", {className: "opt-pref"},
            h("div", {className: "opt-pref-t"},
              h("label", {htmlFor: "openInspectorTab"}, "Open the Inspector in a new tab"),
              h("p", {className: "opt-help"}, "A full browser tab instead of the side panel, for more room. ← AI Object Builder brings you back.")),
            h("label", {className: "opt-switch"},
              h("input", {
                id: "openInspectorTab",
                type: "checkbox",
                role: "switch",
                checked: this.state.openInspectorTab,
                onChange: (e) => this.onInspectorTabChange(e)
              }),
              h("span", {className: "opt-switch-track", "aria-hidden": "true"})))),

        // ── About ──
        h("section", {className: "opt-card opt-about"},
          h("div", {className: "opt-card-h"},
            h("div", null,
              h("h2", null, "About SaralForce"),
              h("p", null, "A free Salesforce inspector and admin toolkit."))),
          h("div", {className: "opt-chips"},
            ["Records", "SOQL", "Run Apex", "Export & Import", "API Explorer", "Debug logs", "Users & Access",
              "Metadata", "Org Info", "App tabs", "Code coverage", "✨ AI Object Builder"].map(t =>
              h("span", {key: t, className: "opt-chip" + (t.startsWith("✨") ? " ai" : "")}, t))),
          h("p", null,
            "Privacy: org data travels only between your browser and Salesforce. When you use an ✨ feature, only the " +
            "text you type and the minimal schema it needs go to the AI provider you chose."),
          h("p", {className: "opt-foot"},
            h("a", {href: "https://rakesh-attri.github.io/SaralForce/privacy.html", target: "_blank", rel: "noopener noreferrer"}, "Privacy Policy"),
            " · ",
            h("a", {href: "https://rakesh-attri.github.io/SaralForce/", target: "_blank", rel: "noopener noreferrer"}, "Website"),
            this.state.appVersion ? ` · v${this.state.appVersion}` : "",
            h("br"),
            "Developed by Er.Bhajan Mandali © · Independent project, not affiliated with Salesforce. ",
            h("svg", {className: "ff-flag", width: 16, height: 11, viewBox: "0 0 18 12", "aria-label": "India"},
              h("rect", {width: 18, height: 4, fill: "#FF9933"}),
              h("rect", {y: 4, width: 18, height: 4, fill: "#FFFFFF"}),
              h("rect", {y: 8, width: 18, height: 4, fill: "#138808"}),
              h("circle", {cx: 9, cy: 6, r: 1.7, fill: "none", stroke: "#000080", strokeWidth: 0.6})))))
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
