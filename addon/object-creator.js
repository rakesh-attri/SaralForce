import {sfConn, apiVersion, startSalesforceLogin, getMyDomain} from "./inspector.js";
import {hasValidConfig, getSavedConfig, getProviderConfig} from "./llm/llm-service.js";
import {SYSTEM_PROMPT, REFINEMENT_PROMPT, USER_MESSAGE_TEMPLATE, ENHANCE_SYSTEM_PROMPT} from "./prompts/system-prompt.js";
import {createSpinForMethod, UserInfoModel, safeCopyText} from "./utils.js";
import {InspectorPanel, ffApplyRestore, ffTakeSnapshot, ffSetAppTabPrefill} from "./inspector-tools.js";
import {askAi, isAiConfigured} from "./core/llm.js";
import {initSettings} from "./core/storage.js";
import {openInspectorInNewTab} from "./core/preferences.js";
import {showMenu} from "./ui/tour.js";
import {runTour, autoStartPanelTours, autoStartBuilderTour, showReleaseNotes} from "./ui/tour-runner.js";
import {PANEL_TOUR, BUILDER_TOUR, tabTour} from "./ui/tour-content.js";
import {getThemePreference, setThemePreference, applyTheme, resolveTheme, nextThemePreference, themeLabel, watchSystemTheme} from "./core/theme.js";
import {getParentOrigin, isTrustedFrameOrigin, setTrustedParentOrigin, postToParent, isFromTrustedParent, queryHostRecord} from "./core/messaging.js";
import {
  FIELD_TYPES, SHARING_MODELS, normalizeFieldType, escapeSoqlString,
  suggestApiName, nextRetryName, resolveNameField, normalizeProposal, validateProposal,
  parseJSONFromText, isNonTransientDeployError
} from "./core/object-builder-rules.js";
import {
  pickTabMotif, safeRelationshipName, buildObjectXml, buildFieldXml, buildRecordTypeXml,
  buildTabXml, buildTabVisibilityXml, buildRecordTypeVisibilityXml, buildProfileXml, buildLayoutXml
} from "./builder/metadata-xml.js";
import {domLocal, domChildren, domFind, domFindAll, domToMetXml} from "./builder/metadata-dom.js";
import {
  ensureLayoutCustomLinks, removeEmptyLayoutColumns, fixCustomLinksWithFields, layoutNeedsRepair,
  pickLayoutFieldColumn, findLayoutItemTemplate, buildLayoutItem
} from "./builder/layout-repair.js";
import {
  isDuplicateError, isRelationshipCollisionError, relationshipCollisionName, matchProfileFullName
} from "./builder/deploy-helpers.js";
import * as metaSoap from "./builder/metadata-soap.js";
import {
  loadChatHistory, saveChatHistory, buildChatEntry, upsertChat, chatToState, loadPersistedState,
  persistState, restoredDeployState, loadInspectorState, saveInspectorState
} from "./builder/chat-history.js";

let h = React.createElement;

// "Help" in the ? menu: questions, bug reports and feature requests.
const HELP_URL = "https://github.com/rakesh-attri/SaralForce/issues/";


class App extends React.Component {
  constructor(props) {
    super(props);
    const saved = loadPersistedState(props.sfHost);
    const inspectorSaved = loadInspectorState(props.sfHost);
    // Minimize/maximize restores the last opened page, but only within the
    // same host-page boot: after a host reload the snapshot is stale and the
    // app opens fresh on the Inspector.
    const bootOk = !!(inspectorSaved && inspectorSaved.hostBoot &&
      inspectorSaved.hostBoot === urlParams.get("hostBoot"));
    const restoredSnap = bootOk ? inspectorSaved : null;
    ffApplyRestore(restoredSnap && restoredSnap.ff);
    this.state = {
      llmConfig: getSavedConfig(),
      // First open after login (no in-boot snapshot) always lands on the
      // Inspector. Minimize/maximize restores the last opened page: the
      // sidebar content script saves {uiMode} on minimize and the snapshot
      // is consumed here on the next construction.
      uiMode: urlParams.get("view") === "builder" ? "builder"
        : urlParams.get("view") === "inspector" ? "inspector"
        : (restoredSnap && restoredSnap.uiMode === "builder" ? "builder" : "inspector"),
      messages: saved?.messages || [],
      currentProposal: saved?.currentProposal || null,
      isGenerating: false,
      streamingText: "",
      isEnhancing: false,
      enhancedPreview: null,
      lastFailedPrompt: null,
      // deploymentStatus/Step/Progress/Results, deployError, deployedObjectName
      ...restoredDeployState(saved),
      error: null,
      userInput: "",
      chatHistory: loadChatHistory(props.sfHost),
      activeChatId: null,
      selectedFields: saved?.selectedFields || null,
      showHistory: false,
      visibilityMode: saved?.visibilityMode || "all",
      selectedProfiles: saved?.selectedProfiles || [],
      availableProfiles: saved?.availableProfiles || [],
      profilesLoading: false,
      recordTypesDone: saved?.recordTypesDone || false,
      builderMode: saved?.builderMode || "plan",
      colorTheme: getThemePreference(),
      apiNamesOn: false
    };
    this.spinnerCount = 0;
    this.fromTabId = (() => {
      const v = parseInt(urlParams.get("fromTab"), 10);
      return Number.isInteger(v) ? v : null;
    })();
    this.spinFor = createSpinForMethod(this);
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));
    this.messagesEndRef = React.createRef();
    this.chatContainerRef = React.createRef();
  }

  didUpdate() {
    this.forceUpdate();
  }

  // Cycles System -> Light -> Dark. "System" follows the OS setting.
  toggleColorTheme() {
    const next = nextThemePreference(this.state.colorTheme);
    setThemePreference(next);
    this.setState({colorTheme: next});
  }

  helpButtonProps() {
    return {
      className: "header-btn header-btn-icon",
      title: "Help and tours",
      "aria-label": "Help and tours",
      "aria-haspopup": "menu",
      "data-tour": "help",
      onClick: (e) => this.openHelpMenu(e.currentTarget),
      children: "?"
    };
  }

  openHelpMenu(anchor) {
    const inspector = (this.state.uiMode || "inspector") === "inspector";
    const activeTab = document.querySelector(".insp-tabs [role=tab][aria-selected=true]");
    const tabId = activeTab ? activeTab.id.replace(/^insp-tab-/, "") : null;
    const items = [
      {label: "Take the tour", onSelect: () => runTour(inspector ? PANEL_TOUR : BUILDER_TOUR)}
    ];
    if (inspector && tabId && tabTour(tabId)) {
      const label = activeTab.textContent.trim();
      items.push({label: `Tour this tool (${label})`, onSelect: () => runTour(tabTour(tabId))});
    }
    items.push({label: "What's new", onSelect: () => showReleaseNotes()});
    items.push({label: "Open Settings", onSelect: () => chrome.runtime.sendMessage({message: "openOptions", host: this.props.sfHost})});
    items.push({label: "Help", onSelect: () => window.open(HELP_URL, "_blank", "noopener,noreferrer")});
    showMenu(anchor, items);
  }

  themeButtonProps() {
    const pref = this.state.colorTheme;
    const active = resolveTheme(pref);
    const next = nextThemePreference(pref);
    const label = `Theme: ${themeLabel(pref)}${pref === "system" ? ` (${active})` : ""}. Switch to ${themeLabel(next).toLowerCase()}`;
    return {
      className: "header-btn header-btn-icon",
      onClick: () => this.toggleColorTheme(),
      title: label,
      "aria-label": label,
      children: pref === "system" ? "\u25D0" : (pref === "dark" ? "\u263E" : "\u2600")
    };
  }

  closePanel() {
    postToParent({type: "sfoc-close-sidebar"});
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({message: "closeSidebar"});
      }
    } catch (e) { /* ignore */ }
  }

  // The page (content script) owns the API-names state: it answers every
  // toggle with "sfoc-api-names-state", so the button only says "Hide" once
  // names are really on screen (never on non-record pages or failures).
  toggleApiNames() {
    postToParent({type: "sfoc-show-api-names"});
    // Belt and braces: re-ask for the page's state while names load, in
    // case the direct reply is missed.
    (this._apiNamesChecks || []).forEach(clearTimeout);
    this._apiNamesChecks = [1500, 4000, 8000, 15000].map(ms =>
      setTimeout(() => postToParent({type: "sfoc-query-api-names"}), ms));
  }

  async copyProposalValue(text, e) {
    const ok = await safeCopyText(String(text == null ? "" : text));
    try {
      const btn = e && e.currentTarget;
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = ok ? "Copied!" : "Failed";
        setTimeout(() => { btn.textContent = orig; }, 1200);
      }
    } catch (err) { /* ignore */ }
    if (!ok) this.setState({error: "Copy failed in this iframe context."});
  }

  saralSpark() {
    return h("span", {className: "saral-spark", "aria-hidden": "true"},
      h("svg", {width: 13, height: 13, viewBox: "0 0 24 24", fill: "none"},
        h("path", {d: "M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z", fill: "#7dd3fc", opacity: "0.95"}),
        h("circle", {cx: "18.5", cy: "5.5", r: "1.6", fill: "#a78bfa"}),
        h("circle", {cx: "5", cy: "18", r: "1.2", fill: "#38bdf8"})));
  }

  saralAvatarLabel() {
    return h("span", {style: {display: "inline-flex", alignItems: "center", gap: "5px"}}, this.saralSpark(), "SaralAI");
  }

  renderAssistantJson(msg) {
    let proposal = msg && msg.proposal;
    if (!proposal && msg && msg.text) {
      // Only a reply that parses AND validates counts as a proposal card;
      // anything else is shown as plain text.
      const parsed = parseJSONFromText(msg.text);
      const normalized = parsed ? normalizeProposal(parsed) : null;
      proposal = normalized && validateProposal(normalized).length === 0 ? normalized : null;
    }
    const obj = proposal && proposal.object;
    if (!obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj).filter(k => obj[k] != null && obj[k] !== "");
    const fullText = JSON.stringify(proposal, null, 2);
    return h("div", {className: "saral-code-card"},
      h("div", {className: "saral-code-head"},
        this.saralSpark(),
        h("span", null, "SaralAI proposal"),
        h("span", {className: "spacer"}),
        h("button", {
          className: "saral-copy-all",
          title: "Copy full JSON",
          onClick: (e) => this.copyProposalValue(fullText, e)
        }, "⧉ Copy")
      ),
      h("div", {className: "saral-code-inset"},
        h("div", {className: "saral-code-row"},
          h("span", {className: "p"}, "{"),
          h("span", {className: "p"}, '"object": {')
        ),
        keys.map(k =>
          h("div", {key: k, className: "saral-code-row"},
            h("span", {className: "k"}, `  "${k}"`),
            h("span", {className: "p"}, ": "),
            h("span", {className: "s"}, JSON.stringify(obj[k])),
            h("span", {className: "p"}, ","),
            h("button", {
              className: "mini-copy",
              title: `Copy ${k}`,
              onClick: (e) => this.copyProposalValue(typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k]), e)
            }, "⧉")
          )
        ),
        h("div", {className: "saral-code-row"},
          h("span", {className: "p"}, "  }"),
          h("span", {className: "p"}, "}")
        )
      )
    );
  }

  componentDidMount() {
    applyTheme(this.state.colorTheme);
    this._unwatchTheme = watchSystemTheme(() => this.state.colorTheme, () => this.forceUpdate());
    autoStartPanelTours(this.state.uiMode || "inspector");
    postToParent({type: "sfoc-query-api-names"});
    const isWelcome = (m) => m && m.role === "system" &&
      /configure your LLM provider/i.test(m.text || "");
    if (this.state.messages.filter(isWelcome).length > 1) {
      let kept = false;
      this.setState(prev => ({
        messages: prev.messages.filter(m => {
          if (!isWelcome(m)) return true;
          if (kept) return false;
          kept = true;
          return true;
        })
      }));
    } else if (this.state.messages.length === 0) {
      if (!hasValidConfig()) {
        this.addSystemMessage("Welcome! Before we begin, please configure your LLM provider in the Options page.");
      } else {
        const config = getSavedConfig();
        const providerDef = getProviderConfig(config.provider);
        this.addSystemMessage(`Connected to ${providerDef.name} (${config.model}). Describe the Salesforce object you want to create, and I'll design it for you.`);
      }
    }
    this.sendUserCard();
    // No beforeunload save on purpose: the snapshot must die with a refresh
    // of the host page; `sfoc-save-state` (sidebar minimize) is the only
    // write path besides this.
    if (this.state.currentProposal) {
      this.loadProfiles().catch(e => console.warn("[SaralForce] mount loadProfiles:", e.message));
    }
    this._onStorage = (e) => {
      if (e && e.key !== "llmConfig") return;
      this.setState({llmConfig: getSavedConfig()});
    };
    window.addEventListener("storage", this._onStorage);
  }

  componentWillUnmount() {
    if (this._unwatchTheme) this._unwatchTheme();
    (this._apiNamesChecks || []).forEach(clearTimeout);
    window.removeEventListener("storage", this._onStorage);
    saveInspectorState(this.props.sfHost, this.state,
      {hostBoot: urlParams.get("hostBoot"), takeSnapshot: ffTakeSnapshot});
    this._saveState();
  }

  _saveState = () => {
    persistState(this.props.sfHost, this.state);
  }

  async sendUserCard() {
    if (this._userCardSent || !sfConn.sessionId) return;
    this._userCardSent = true;
    try {
      let me = null;
      try {
        me = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/me`);
      } catch (e) { /* fall through to userinfo */ }
      if (!me || (!me.Id && !me.user_id)) {
        try {
          const r = await fetch("https://" + sfConn.instanceHostname + "/services/oauth2/userinfo", {
            headers: {Authorization: "Bearer " + sfConn.sessionId}
          });
          if (r.ok) me = await r.json();
        } catch (e) { /* ignore */ }
      }
      let org = {};
      try {
        const o = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent("SELECT Id,Name,IsSandbox,InstanceName FROM Organization LIMIT 1"),
          {useCache: false});
        org = (o.records && o.records[0]) || {};
      } catch (e) { /* ignore */ }
      const info = {
        name: (me && (me.Name || me.name || me.nickname || me.preferred_username)) || "—",
        username: (me && (me.Username || me.preferred_username)) || "",
        userId: (me && (me.Id || me.user_id)) || "",
        orgName: org.Name || "",
        orgId: org.Id || (me && me.organization_id) || "",
        sandbox: org.IsSandbox === true,
        instanceUrl: "https://" + (sfConn.instanceHostname || "")
      };
      postToParent({type: "sfoc-user-card", info});
    } catch (e) {
      this._userCardSent = false;
    }
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.uiMode !== this.state.uiMode && this.state.uiMode === "builder") autoStartBuilderTour();
    this.sendUserCard();
    if (this.messagesEndRef.current) {
      this.messagesEndRef.current.scrollIntoView({behavior: "smooth"});
    }
    // Auto-save on state changes
    if (prevState.messages !== this.state.messages || prevState.currentProposal !== this.state.currentProposal) {
      this._saveState();
      this._autoSaveChat();
    }
    // Warm the profile picker as soon as a proposal exists (Deployment Targets).
    // NOTE: app assignment lives in Inspector → App Tab Manager now; the builder no
    // longer loads apps or auto-assigns.
    if (this.state.currentProposal && prevState.currentProposal !== this.state.currentProposal) {
      this.loadProfiles().catch(e => console.warn("[SaralForce] proposal loadProfiles:", e.message));
    }
  }

  _autoSaveChat() {
    if (this.state.messages.length <= 1) return;
    const chatEntry = buildChatEntry(this.state);
    // Keeps the last 20 chats.
    const trimmed = upsertChat(this.state.chatHistory, chatEntry);
    this.setState({chatHistory: trimmed, activeChatId: chatEntry.id});
    saveChatHistory(this.props.sfHost, trimmed);
  }

  newChat() {
    this.setState({
      messages: [],
      currentProposal: null,
      deploymentStatus: null,
      deploymentStep: null,
      deploymentProgress: 0,
      deploymentResults: [],
      deployError: null,
      deployedObjectName: null,
      selectedFields: null,
      error: null,
      activeChatId: null,
      visibilityMode: "all",
      selectedProfiles: [],
      recordTypesDone: false,
      builderMode: "plan",
      isEnhancing: false,
      enhancedPreview: null
    }, () => {
      if (!hasValidConfig()) {
        this.addSystemMessage("Welcome! Before we begin, please open Settings (top-right) and configure your LLM provider.");
      } else {
        const config = getSavedConfig();
        const providerDef = getProviderConfig(config.provider);
        this.addSystemMessage(`Connected to ${providerDef.name} (${config.model}). Describe the Salesforce object you want to create.`);
      }
    });
  }

  showUserCard() {
    postToParent({type: "sfoc-show-user-card"});
  }

  openInspector() {
    if (openInspectorInNewTab()) {
      // New tabs have no content-script parent to ask later, so carry the
      // current record context in the open request (background.js turns it
      // into openRecObj/openRecId URL params).
      queryHostRecord().then((rec) => {
        try {
          const msg = {message: "openInspectorTab", host: this.props.sfHost || ""};
          // Id-only contexts (setup/classic record pages) are carried too —
          // background.js emits openRecId alone and the panel resolves it.
          if (rec && (rec.obj || rec.id)) {
            msg.rec = {
              obj: rec.obj ? String(rec.obj) : null,
              id: rec.id ? String(rec.id) : null
            };
          }
          chrome.runtime.sendMessage(msg);
        } catch (e) {
          this.setState({uiMode: "inspector"});
        }
      });
      return;
    }
    this.setState({uiMode: "inspector"});
  }

  // Post-create handoff: offer the freshly created object tab to a
  // Lightning app via Inspector → App Tab Manager. Writes nothing here —
  // the manager shows an approval card and the user picks the app +
  // visibility; no app is modified without that explicit click.
  addToLightningApp() {
    const {deploymentResults} = this.state;
    const objectResult = deploymentResults.find(r => r.type === "object" && r.status === "success");
    const tabResult = deploymentResults.find(r => r.type === "tab" && r.status === "success");
    if (!objectResult && !tabResult) return;
    const objectApiName = objectResult ? objectResult.name : null;
    // Object tabs carry the object's API name as their metadata fullName
    // (see buildTabXml); the tab result's `name` is "<object>_tab".
    const tabApiName = objectApiName ||
      (tabResult && tabResult.name ? String(tabResult.name).replace(/_tab$/, "") : null);
    if (!tabApiName) return;
    ffSetAppTabPrefill(tabApiName, objectApiName);
    this.openInspector();
  }

  goBackFromInspector() {
    const fromTab = this.fromTabId;
    if (fromTab == null) { this.setState({uiMode: "builder"}); return; }
    try {
      chrome.tabs.get(fromTab, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.getCurrent((me) => {
            if (me && me.id != null) { try { chrome.tabs.remove(me.id); } catch (e) {} }
          });
        } else {
          chrome.tabs.update(fromTab, {active: true});
        }
      });
    } catch (e) {
      this.setState({uiMode: "builder"});
    }
  }

  openOptions() {
    const {sfHost} = this.props;
    // Prefer background tab open (works from iframe/sidebar); fall back to
    // direct chrome-extension URL if messaging fails.
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          {message: "openOptions", host: sfHost || ""},
          (res) => {
            if (chrome.runtime.lastError || !res?.ok) {
              window.open(chrome.runtime.getURL(`options.html${sfHost ? `?host=${sfHost}` : ""}`), "_blank");
            }
          }
        );
        return;
      }
    } catch (e) { /* fall through */ }
    const url = chrome?.runtime?.getURL
      ? chrome.runtime.getURL(`options.html${sfHost ? `?host=${sfHost}` : ""}`)
      : "options.html";
    window.open(url, "_blank");
  }

  loadChat(chatId) {
    const chat = this.state.chatHistory.find(c => c.id === chatId);
    if (!chat) return;
    this.setState(chatToState(chat), () => {
      if (chat.currentProposal) {
        this.loadProfiles().catch(() => {});
      }
    });
  }

  deleteChat(chatId) {
    const chatHistory = this.state.chatHistory.filter(c => c.id !== chatId);
    this.setState({chatHistory});
    saveChatHistory(this.props.sfHost, chatHistory);
  }

  addSystemMessage(text) {
    this.setState(prev => ({
      messages: [...prev.messages, {role: "system", text, timestamp: Date.now()}]
    }));
  }

  addUserMessage(text) {
    this.setState(prev => ({
      messages: [...prev.messages, {role: "user", text, timestamp: Date.now()}]
    }));
  }

  addAssistantMessage(text, proposal) {
    this.setState(prev => ({
      messages: [...prev.messages, {role: "assistant", text, proposal, timestamp: Date.now()}]
    }));
  }

  async sendMessage(promptOverride, opts = {}) {
    const {currentProposal} = this.state;
    const userInput = promptOverride != null ? String(promptOverride) : this.state.userInput;
    const echo = !opts || opts.echo !== false;
    if (!userInput.trim() || this.state.isGenerating) return;

    if (!isAiConfigured()) {
      this.setState({error: "Please configure your LLM provider in Options first."});
      return;
    }

    if (echo) this.addUserMessage(userInput);
    this.setState({userInput: "", isGenerating: true, error: null, streamingText: "", enhancedPreview: null, lastFailedPrompt: null});

    try {
      const apiMessages = [
        {role: "system", content: currentProposal ? REFINEMENT_PROMPT : SYSTEM_PROMPT},
        ...this.buildConversationHistory(),
        {role: "user", content: USER_MESSAGE_TEMPLATE(userInput, currentProposal)}
      ];

      const onChunk = (text) => {
        this.setState({streamingText: text});
      };

      const response = await askAi({messages: apiMessages, onChunk});

      this.setState({streamingText: ""});

      const parsed = parseJSONFromText(response);
      const proposal = parsed ? normalizeProposal(parsed) : null;
      if (proposal) {
        const validationErrors = validateProposal(proposal);
        if (validationErrors.length > 0) {
          this.addAssistantMessage(response, null);
          this.setState({error: "Generated proposal has issues: " + validationErrors.join("; "), lastFailedPrompt: userInput});
        } else {
          this.addAssistantMessage(response, proposal);
          this.setState({
            currentProposal: proposal,
            selectedFields: proposal.fields.map(f => f.name),
            deploymentStatus: null,
            deploymentResults: [],
            recordTypesDone: false,
            builderMode: "plan",
            visibilityMode: this.state.visibilityMode || "all"
          }, () => {
            // Ask targets up front: load profiles for Deployment Targets.
            // (App assignment lives in Inspector → App Tab Manager now.)
            this.loadProfiles().catch(() => {});
          });
        }
      } else {
        this.addAssistantMessage(response, null);
        this.setState({
          error: "The AI reply did not contain a valid object proposal (no parseable JSON). Click Retry to ask again.",
          lastFailedPrompt: userInput
        });
      }
    } catch (error) {
      this.setState({
        error: `LLM Error: ${error.message}`,
        isGenerating: false,
        streamingText: "",
        lastFailedPrompt: userInput
      });
    }

    this.setState({isGenerating: false});
  }

  retrySend() {
    const prompt = this.state.lastFailedPrompt;
    if (!prompt || this.state.isGenerating) return;
    // Silent resend: the failed prompt is already in history, so no echo.
    this.sendMessage(prompt, {echo: false});
  }

  async enhancePrompt() {
    const draft = (this.state.userInput || "").trim();
    if (!draft) {
      this.setState({error: "The 'Enhance Prompt' button helps improve your prompt by providing additional context, clarification, or rephrasing. Try typing a prompt in here and clicking the button again to see how it works."});
      return;
    }
    if (this.state.isEnhancing) return;

    if (!isAiConfigured()) {
      this.setState({error: "Please configure your LLM provider in Options first."});
      return;
    }

    this.setState({isEnhancing: true, enhancedPreview: null, error: null});
    try {
      const proposalCtx = this.state.currentProposal
        ? `\nCurrent object draft for context (do not redesign it, only improve the request below): label="${this.state.currentProposal.object?.label || ""}", fields=[${(this.state.currentProposal.fields || []).map(f => f.label || f.name).join(", ")}]`
        : "";
      const apiMessages = [
        {role: "system", content: ENHANCE_SYSTEM_PROMPT},
        {role: "user", content: `Draft request to improve:${proposalCtx}\n\n"${draft}"`}
      ];

      const response = await askAi({messages: apiMessages});

      const enhanced = String(response || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
      if (!enhanced) throw new Error("LLM returned an empty enhancement.");
      this.setState({enhancedPreview: enhanced, isEnhancing: false});
    } catch (error) {
      this.setState({
        error: `LLM Error: ${error.message}`,
        isEnhancing: false
      });
    }
  }

  buildConversationHistory() {
    const {messages} = this.state;
    const apiMessages = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        apiMessages.push({role: "user", content: msg.text});
      } else if (msg.role === "assistant") {
        apiMessages.push({role: "assistant", content: msg.text});
      }
    }
    return apiMessages.slice(-10);
  }

  // opts.resume: the object was created by an earlier attempt in this
  // session (state.deployedObjectName) — skip object creation and deploy
  // only the selected fields the org does not have yet.
  async deployObject(opts = {}) {
    const {selectedFields, deployedObjectName} = this.state;
    if (!this.state.currentProposal) return;
    const currentProposal = normalizeProposal(this.state.currentProposal);
    if (currentProposal !== this.state.currentProposal) this.setState({currentProposal});

    const fieldsToDeploy = selectedFields
      ? currentProposal.fields.filter(f => selectedFields.includes(f.name))
      : currentProposal.fields;

    if (fieldsToDeploy.length === 0) {
      this.setState({error: "No fields selected for deployment. Please select at least one field."});
      return;
    }

    // Names below go into SOQL and Metadata fullNames — refuse to deploy a
    // plan that does not validate rather than escaping our way around it.
    const planErrors = validateProposal(currentProposal);
    if (planErrors.length > 0) {
      this.setState({
        deploymentStatus: "failed",
        deploymentStep: "Deployment failed",
        deploymentResults: [],
        deployError: "Fix the plan before deploying: " + planErrors.slice(0, 4).join("; "),
        error: null
      });
      return;
    }

    const objectName = currentProposal.object.name;
    const resume = !!opts.resume && deployedObjectName === objectName;

    this._deployAborted = false;
    this._abortController = new AbortController();
    this._profileMetadataNames = null;

    this.setState({
      deploymentStatus: "deploying",
      deploymentStep: resume ? "Resuming deployment..." : "Creating object...",
      deploymentProgress: 0,
      deploymentResults: [],
      deployError: null,
      error: null
    });

    const totalSteps = fieldsToDeploy.length + 6;
    let completedSteps = 0;

    try {
      console.log("[SaralForce] Starting deployment. Object:", objectName, "Fields:", fieldsToDeploy.length, resume ? "(resume)" : "");
      const createdFields = [];
      // Selected fields the org already has (resume only): no create call,
      // but they still get FLS + layout in case the earlier run stopped first.
      const existingFieldNames = new Set();

      if (resume) {
        this.setState({deploymentStep: "Checking which fields already exist..."});
        try {
          const existRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlString(objectName)}'`));
          for (const r of existRes.records || []) {
            if (r.QualifiedApiName) existingFieldNames.add(r.QualifiedApiName.toLowerCase());
          }
        } catch (existErr) {
          // Not fatal: creating a field that exists is treated as success below.
          console.warn("[SaralForce] Resume field check failed:", existErr.message);
        }
        completedSteps += 2;
        this.setState(prev => ({
          deploymentResults: [...prev.deploymentResults, {
            type: "object",
            name: objectName,
            label: `${currentProposal.object.label} (already created — resumed)`,
            status: "success"
          }],
          deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
        }));
      } else {
        this.setState({deploymentStep: `Creating object "${currentProposal.object.label}"...`});
        console.log("[SaralForce] Step 1: Creating object...");
        const suggested = nextRetryName(objectName, currentProposal.object.label).name;
        const existsHint = deployedObjectName === objectName
          ? "It was created by an earlier attempt in this session — click \"Resume deploy\" to add the remaining fields."
          : `Suggested rename: ${suggested}. Click "Retry with new name" or edit the API name in Plan mode.`;
        // Fail fast if the object already exists (EntityDefinition query).
        try {
          const dupCheck = await sfConn.rest(
            `/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT DeveloperName FROM EntityDefinition WHERE QualifiedApiName = '${escapeSoqlString(objectName)}' LIMIT 1`));
          if (dupCheck.records && dupCheck.records.length > 0) {
            throw Object.assign(new Error(`Object ${objectName} already exists in this org. ${existsHint}`), {objectExists: true});
          }
        } catch (preErr) {
          if (preErr.objectExists) throw preErr;
          console.warn("[SaralForce] Duplicate pre-check skipped:", preErr.message);
        }
        let objectResult;
        try {
          objectResult = await this.metadataCreate(this.buildObjectXml(currentProposal.object));
        } catch (objErr) {
          if (isDuplicateError(objErr)) {
            throw Object.assign(new Error(`${objErr.message}. Object ${objectName} already exists. ${existsHint}`), {objectExists: true});
          }
          throw objErr;
        }
        console.log("[SaralForce] Object create response:", objectResult);
        completedSteps++;

        this.setState(prev => ({
          deployedObjectName: objectName,
          deploymentResults: [...prev.deploymentResults, {
            type: "object",
            name: objectName,
            label: currentProposal.object.label,
            status: "success",
            id: objectResult.id
          }],
          deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
        }));

        if (this._deployAborted) throw new Error("Deployment cancelled");

        this.setState({deploymentStep: "Waiting for metadata propagation (8s)..."});
        console.log("[SaralForce] Step 2: Waiting 8s for metadata propagation...");
        await this.delay(8000);
        completedSteps++;
        this.setState(prev => ({deploymentProgress: Math.round((completedSteps / totalSteps) * 100)}));
      }

      for (let i = 0; i < fieldsToDeploy.length; i++) {
        if (this._deployAborted) throw new Error("Deployment cancelled");

        const field = fieldsToDeploy[i];
        const fieldNum = i + 1;

        if (existingFieldNames.has(String(field.name).toLowerCase())) {
          createdFields.push(field);
          completedSteps++;
          this.setState(prev => ({
            deploymentResults: [...prev.deploymentResults, {
              type: "field",
              name: field.name,
              label: `${field.label} (already present)`,
              status: "success"
            }],
            deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
          }));
          continue;
        }

        this.setState({deploymentStep: `Creating field ${fieldNum}/${fieldsToDeploy.length}: "${field.label}"...`});
        console.log(`[SaralForce] Step 3.${fieldNum}: Creating field "${field.label}" (${field.type})...`);

        let fieldCreated = false;
        let lastError = null;
        let relCollisionRetries = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (this._deployAborted) throw new Error("Deployment cancelled");
          try {
            let fieldXml;
            try {
              fieldXml = buildFieldXml(objectName, field);
            } catch (buildErr) {
              buildErr.nonTransient = true;
              throw buildErr;
            }
            console.log(`[SaralForce]   Field SOAP XML (attempt ${attempt + 1}):`, fieldXml.substring(0, 200) + "...");
            await this.metadataCreate(fieldXml);
            fieldCreated = true;
            console.log(`[SaralForce]   Field "${field.label}" created successfully`);
            break;
          } catch (fieldErr) {
            lastError = fieldErr;
            console.error(`[SaralForce]   Field "${field.label}" attempt ${attempt + 1} failed:`, fieldErr.message);
            if (this._deployAborted) throw new Error("Deployment cancelled");
            // Soft-deleted relationship keeps the name — retry with a unique suffix.
            if (isRelationshipCollisionError(fieldErr) && relCollisionRetries < 3) {
              relCollisionRetries++;
              const coll = relationshipCollisionName(fieldErr);
              const base = coll && coll.name
                ? coll.name
                : safeRelationshipName(field, objectName);
              const next = `${base.replace(/_+\d+$/, "")}_${1 + relCollisionRetries}`;
              console.warn(`[SaralForce]   Relationship collision on ${coll?.parent || "?"} — retrying as "${next}"`);
              field.relationshipName = next;
              await this.delay(500);
              attempt--; // collision retry does not consume the normal attempt budget
              continue;
            }
            // Field already present from a prior run — treat as success.
            if (isDuplicateError(fieldErr) && /field|CustomField/i.test(`${fieldErr.message || ""} ${fieldErr.statusCode || ""}`)) {
              console.warn(`[SaralForce]   Field "${field.label}" already exists — treating as success`);
              fieldCreated = true;
              break;
            }
            // Validation/build errors fail identically on every attempt.
            if (isNonTransientDeployError(fieldErr)) break;
            if (attempt < 4) {
              const waitTime = 2000 * (attempt + 1);
              console.log(`[SaralForce]   Retrying in ${waitTime}ms...`);
              await this.delay(waitTime);
            }
          }
        }

        if (fieldCreated) createdFields.push(field);
        completedSteps++;
        this.setState(prev => ({
          deploymentResults: [...prev.deploymentResults, {
            type: "field",
            name: field.name,
            label: field.label,
            status: fieldCreated ? "success" : "error",
            error: fieldCreated ? undefined : (lastError?.message || "Unknown error")
          }],
          deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
        }));

        await this.delay(300);
      }

      if (this._deployAborted) throw new Error("Deployment cancelled");

      // Record types are intentionally NOT part of the main deploy.
      // They run later via the "Create record types" button after success.

      // Only FLS/layout fields that actually exist — failed creates (e.g.
      // lookup relationship errors) must not appear on the layout or the
      // whole updateMetadata fails with INVALID_CROSS_REFERENCE_KEY.
      const createdFieldNames = createdFields.map(f => f.name);

      this.setState({deploymentStep: "Granting field-level security..."});
      console.log("[SaralForce] Step 4: Granting FLS for", createdFieldNames.length, "created field(s)...");
      if (createdFieldNames.length) {
        await this.grantFieldPermissions(currentProposal.object.name, createdFieldNames);
      }
      completedSteps++;
      this.setState(prev => ({
        deploymentResults: [...prev.deploymentResults, {
          type: "fls",
          name: "FieldPermissions",
          label: createdFieldNames.length
            ? "Field-Level Security"
            : "Field-Level Security (no new fields)",
          status: "success"
        }],
        deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
      }));

      if (this._deployAborted) throw new Error("Deployment cancelled");

      // Add new fields to the default page layout immediately after FLS —
      // same as Setup's "Add Field" checkbox (append as last field).
      {
        this.setState({deploymentStep: "Adding fields to page layout..."});
        console.log("[SaralForce] Step 4b: Adding fields to default layout...", createdFieldNames);
        let layoutOk;
        if (createdFieldNames.length === 0) {
          layoutOk = {ok: true, method: "noop"};
        } else {
          // Belt-and-braces: drop any name the org doesn't actually have.
          let layoutFieldNames = createdFieldNames;
          try {
            const existRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
              encodeURIComponent(`SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlString(objectName)}'`));
            const exist = new Set((existRes.records || []).map(r => r.QualifiedApiName).filter(Boolean));
            if (exist.size) {
              layoutFieldNames = createdFieldNames.filter(n => exist.has(n));
            }
          } catch (existErr) {
            console.warn("[SaralForce] Field existence check skipped:", existErr.message);
          }
          try {
            layoutOk = await this.addFieldsToDefaultLayout(currentProposal.object.name, layoutFieldNames);
          } catch (layoutErr) {
            if (/cancelled/i.test(layoutErr.message)) throw layoutErr;
            layoutOk = {ok: false, error: layoutErr.message, debug: this.lastSoapDebugText()};
          }
        }
        completedSteps++;
        this.setState(prev => ({
          deploymentResults: [...prev.deploymentResults, {
            type: "layout",
            name: currentProposal.object.name + "_layout",
            label: layoutOk.ok && layoutOk.layoutName
              ? `Page Layout (new: ${layoutOk.layoutName} — assign in Setup)`
              : layoutOk.ok && layoutOk.method === "noop"
                ? "Page Layout (already up to date)"
                : "Page Layout",
            status: layoutOk.ok ? "success" : "error",
            error: layoutOk.ok ? undefined : layoutOk.error,
            debug: layoutOk.ok ? undefined : layoutOk.debug
          }],
          deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
        }));
        await this.delay(300);
      }

      if (this._deployAborted) throw new Error("Deployment cancelled");

      this.setState({deploymentStep: "Creating tab..."});
      console.log("[SaralForce] Step 5: Creating tab...");
      // On resume the tab may already exist from the earlier attempt; a
      // second create would fail with a duplicate error.
      let tabResult = null;
      if (resume) {
        try {
          const tabNames = await this.listMetadataFullNames("CustomTab");
          if (tabNames.includes(objectName)) tabResult = {ok: true, method: "existing"};
        } catch (e) {
          console.warn("[SaralForce] Resume tab check failed:", e.message);
        }
      }
      if (!tabResult) tabResult = await this.createTab(currentProposal.object.name, currentProposal.object.label);
      completedSteps++;
      this.setState(prev => ({
        deploymentResults: [...prev.deploymentResults, {
          type: "tab",
          name: currentProposal.object.name + "_tab",
          label: currentProposal.object.label + " Tab",
          status: tabResult.ok ? "success" : "error",
          error: tabResult.ok ? undefined : (tabResult.error || "Tab creation failed")
        }],
        deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
      }));

      // Tab visibility: all profiles (default) or the user's selected list.
      if (!this._deployAborted && tabResult.ok) {
        try {
          let visLabels = this.getVisibilityLabels();
          // Refresh full list when covering everyone so listMetadata is warm.
          if (this.state.visibilityMode !== "selected") {
            try {
              const pres = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
                encodeURIComponent(`SELECT Name FROM Profile ORDER BY Name`));
              const all = (pres.records || []).map(r => r.Name).filter(Boolean);
              if (all.length) {
                visLabels = all;
                this.setState({availableProfiles: all});
              }
            } catch (e) {
              console.warn("[SaralForce] Profile list query failed:", e.message);
            }
          }
          if (visLabels.length === 0) visLabels = ["System Administrator"];
          const modeLabel = this.state.visibilityMode === "selected"
            ? `${visLabels.length} selected profile${visLabels.length === 1 ? "" : "s"}`
            : `all profiles (${visLabels.length})`;
          this.setState({deploymentStep: `Setting tab visibility (${modeLabel})...`});
          console.log("[SaralForce] Step 6: Setting tab visibility for", modeLabel);
          const visResult = await this.setTabVisibilityForProfiles(
            currentProposal.object.name, visLabels, []);
          // Safety net: the signed-in user must see the tab even if bulk
          // profile matching skipped their label.
          try {
            await this.ensureCurrentUserVisibility(currentProposal.object.name);
          } catch (curErr) {
            console.warn("[SaralForce] ensureCurrentUserVisibility:", curErr.message);
          }
          completedSteps++;
          const visCount = visResult.ok ? (visResult.updated || []).length : 0;
          this.setState(prev => ({
            deploymentResults: [...prev.deploymentResults, {
              type: "visibility",
              name: currentProposal.object.name + "_visibility",
              label: visResult.ok
                ? `Tab Visibility (${visCount} profile${visCount === 1 ? "" : "s"})`
                : "Tab Visibility (all profiles)",
              status: visResult.ok ? "success" : "error",
              error: visResult.ok ? visResult.warning : visResult.error,
              debug: visResult.ok ? undefined : visResult.debug
            }],
            deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
          }));
        } catch (visErr) {
          if (/cancelled/i.test(visErr.message)) throw visErr;
          console.warn("[SaralForce] Tab visibility step failed:", visErr.message);
          completedSteps++;
          this.setState(prev => ({
            deploymentResults: [...prev.deploymentResults, {
              type: "visibility",
              name: currentProposal.object.name + "_visibility",
              label: "Tab Visibility (all profiles)",
              status: "error",
              error: visErr.message,
              debug: this.lastSoapDebugText()
            }],
            deploymentProgress: Math.round((completedSteps / totalSteps) * 100)
          }));
        }
      }

      this.setState({
        deploymentStatus: "complete",
        deploymentStep: "Deployment complete!",
        deploymentProgress: 100
      });
      console.log("[SaralForce] Deployment complete!");

    } catch (err) {
      if (this._deployAborted) {
        console.log("[SaralForce] Deployment cancelled by user");
        this.setState({
          deploymentStatus: "cancelled",
          deploymentStep: "Deployment cancelled",
          error: "Deployment was cancelled."
        });
      } else {
        console.error("[SaralForce] Deployment failed:", err);
        this.setState({
          deploymentStatus: "failed",
          deploymentStep: "Deployment failed",
          deployError: err.message || String(err)
        });
      }
    }
  }

  cancelDeployment() {
    this._deployAborted = true;
    if (this._abortController) {
      this._abortController.abort();
    }
    if (this._delayTimer) {
      clearTimeout(this._delayTimer);
      this._delayTimer = null;
    }
  }

  delay(ms) {
    return new Promise(resolve => {
      if (this._deployAborted) { resolve(); return; }
      this._delayTimer = setTimeout(() => {
        this._delayTimer = null;
        resolve();
      }, ms);
    });
  }

  // Metadata SOAP transport lives in builder/metadata-soap.js; these thin
  // wrappers bind it to the current deploy's abort state and debug sink.
  _soapCtx() {
    return {
      conn: sfConn,
      apiVersion,
      signal: this._abortController ? this._abortController.signal : null,
      isAborted: () => !!this._deployAborted,
      onDebug: (action, requestXml, responseText) => this.noteSoapDebug(action, requestXml, responseText),
      delay: ms => this.delay(ms)
    };
  }

  metaSoapRequest(action, metadataXml) {
    return metaSoap.metaSoapRequest(this._soapCtx(), action, metadataXml);
  }

  // Stash last SOAP request/response (truncated, no session ids — those
  // live only in the envelope header, never in the stored snippets) so a
  // failing step can offer one-click "Copy debug info".
  noteSoapDebug(action, requestXml, responseText) {
    try {
      this._lastSoapDebug = {
        action,
        request: String(requestXml || "").slice(-4000),
        response: String(responseText || "").slice(0, 4000)
      };
    } catch (e) { /* ignore */ }
  }

  lastSoapDebugText() {
    const d = this._lastSoapDebug;
    if (!d) return "";
    return `SOAP action: ${d.action}\n--- request (tail) ---\n${d.request}\n--- response (head) ---\n${d.response}`;
  }

  metadataReadRecords(type, fullName) {
    return metaSoap.metadataReadRecords(this._soapCtx(), type, fullName);
  }

  metadataUpdateRecords(xsiType, fullName, recordsEl) {
    return metaSoap.metadataUpdateRecords(this._soapCtx(), xsiType, fullName, recordsEl);
  }

  metadataCreate(metadataXml) {
    return metaSoap.metadataCreate(this._soapCtx(), metadataXml);
  }

  pollDeployStatus(deployId, maxAttempts = 30) {
    return metaSoap.pollDeployStatus(this._soapCtx(), deployId, maxAttempts);
  }

  buildObjectXml(objectDef) {
    const xml = buildObjectXml(objectDef);
    console.log("[SaralForce] Object XML:", xml);
    return xml;
  }

  async resolveCurrentUserId() {
    // /services/oauth2/userinfo varies by org type; fall back to /id.
    const urls = [
      "https://" + sfConn.instanceHostname + "/services/oauth2/userinfo",
      "https://" + sfConn.instanceHostname + "/id"
    ];
    let lastStatus = 0;
    for (const u of urls) {
      try {
        const res = await fetch(u, {
          headers: {"Authorization": "Bearer " + sfConn.sessionId}
        });
        lastStatus = res.status;
        if (!res.ok) continue;
        const data = await res.json();
        const uid = data?.user_id || data?.userId || (data?.sub ? String(data.sub).split("/").pop() : null);
        if (uid) return uid;
      } catch (e) {
        console.warn("[SaralForce] Identity lookup failed for", u, e.message);
      }
    }
    throw new Error("Could not get user identity (tried userinfo and /id, last status " + lastStatus + ")");
  }

  async grantFieldPermissions(objectName, fieldNames) {
    try {
      // FieldPermissions.ParentId must be a PermissionSet id (0PS…), not a
      // Profile id (00e…). Profiles own a hidden PermissionSet with the same
      // name — resolve that first, else the REST POST fails with
      // "Parent ID of incorrect type".
      const userId = await this.resolveCurrentUserId();
      if (!userId) throw new Error("No user_id in identity response");

      const userRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=SELECT+ProfileId+FROM+User+WHERE+Id=%27${userId}%27`);
      const profileId = userRes.records?.[0]?.ProfileId;
      if (!profileId) {
        console.warn("[SaralForce] Could not determine user profile for FLS");
        return;
      }

      let parentId = null;
      try {
        const psRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Id FROM PermissionSet WHERE ProfileId = '${profileId}' AND IsOwnedByProfile = true LIMIT 1`));
        parentId = psRes.records?.[0]?.Id || null;
      } catch (psErr) {
        console.warn("[SaralForce] PermissionSet lookup failed:", psErr.message);
      }
      if (!parentId) {
        // Fallback: match by profile name (Admin / System Administrator, etc.)
        try {
          const profRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${profileId}'`));
          const profName = profRes.records?.[0]?.Name;
          if (profName) {
            const byName = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
              encodeURIComponent(`SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = true AND Name = '${profName.replace(/'/g, "\\'")}' LIMIT 1`));
            parentId = byName.records?.[0]?.Id || null;
          }
        } catch (e) { /* ignore */ }
      }
      if (!parentId) {
        console.warn("[SaralForce] No PermissionSet for profile", profileId, "- skipping FLS REST (use Setup → field → Set field-level security)");
        return;
      }

      console.log("[SaralForce] Granting FLS via PermissionSet:", parentId, "for profile", profileId);

      for (const fieldName of fieldNames) {
        const fieldFullName = `${objectName}.${fieldName}`;
        try {
          await sfConn.rest(`/services/data/v${apiVersion}/sobjects/FieldPermissions`, {
            method: "POST",
            body: {
              ParentId: parentId,
              Field: fieldFullName,
              SObjectType: objectName,
              PermissionsRead: true,
              PermissionsEdit: true
            }
          });
          console.log("[SaralForce] FLS granted for:", fieldFullName);
        } catch (flsErr) {
          // Already exists is fine; anything else is worth a warning only.
          if (!/duplicate|already exists/i.test(flsErr.message || "")) {
            console.warn("[SaralForce] FLS skip for", fieldFullName, flsErr.message);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (err) {
      console.warn("[SaralForce] Could not grant FLS:", err.message);
    }
  }

  async addFieldsToDefaultLayout(objectName, fieldNames) {
    // Best-effort: put newly created fields on the default page layout.
    // Read-merge-write via sync updateMetadata: read the FULL layout with
    // readMetadata, append <layoutItems> to the last column, write back.
    // (Tooling PATCH of Layout metadata is rejected with
    // FIELD_INTEGRITY_EXCEPTION: Required field is missing: customLink, so
    // it is deliberately not used here.) Never throws — returns {ok, error}.
    try {
      const baseName = objectName.replace(/__c$/, "");
      const q = encodeURIComponent(
        `SELECT Id, FullName FROM Layout WHERE EntityDefinition.DeveloperName = '${escapeSoqlString(baseName)}' LIMIT 5`);
      let fullName = null;
      try {
        const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=${q}`);
        fullName = res.records?.[0]?.FullName || null;
        if (!fullName && res.records?.[0]?.Id) {
          const detail = await sfConn.rest(
            `/services/data/v${apiVersion}/tooling/sobjects/Layout/${res.records[0].Id}`);
          fullName = detail.FullName || null;
        }
      } catch (e) {
        console.warn("[SaralForce] Layout lookup failed:", e.message);
      }
      if (!fullName) {
        return {ok: false, error: "No default layout found (open Setup to add fields manually)"};
      }
      let records;
      try {
        records = await this.metadataReadRecords("Layout", fullName);
      } catch (readErr) {
        return {ok: false,
          error: `readMetadata(Layout, ${fullName}) failed: ${readErr.message}`,
          debug: this.lastSoapDebugText()};
      }
      if (!records) {
        return {ok: false, error: "Could not read layout metadata for " + fullName,
          debug: this.lastSoapDebugText()};
      }
      const doc = records.ownerDocument;

      // Snapshot: does this layout need structural repair before we decide
      // whether a no-op update is safe? (Must run BEFORE fixes apply.)
      const needsRepair = layoutNeedsRepair(records);

      // Repair known-bad shapes from prior runs BEFORE appending/serializing.
      fixCustomLinksWithFields(records);
      removeEmptyLayoutColumns(records);
      ensureLayoutCustomLinks(records);

      const existing = new Set();
      for (const li of domFindAll(records, "layoutItems")) {
        const f = domFind(li, "field");
        if (f && f.textContent) {
          existing.add(f.textContent);
          existing.add(f.textContent.split(".").pop());
        }
      }
      const toAdd = fieldNames.filter(f =>
        !existing.has(f) && !existing.has(`${objectName}.${f}`));
      if (toAdd.length === 0 && !needsRepair) {
        return {ok: true, method: "noop"};
      }
      const target = pickLayoutFieldColumn(records);
      if (!target && toAdd.length > 0) {
        return {ok: false, error: "Layout has no field column to extend (add fields manually in Setup)"};
      }
      const template = findLayoutItemTemplate(records);
      if (target) {
        for (const f of toAdd) {
          target.appendChild(buildLayoutItem(doc, template, f));
        }
      }
      // Final pass on the tree we are about to serialize.
      ensureLayoutCustomLinks(records);
      removeEmptyLayoutColumns(records);
      fixCustomLinksWithFields(records);
      const fnEl = domFind(records, "fullName");
      const realName = (fnEl && fnEl.textContent) || fullName;
      try {
        await this.metadataUpdateRecords("Layout", realName, records);
        console.log("[SaralForce] Layout updated with fields:", toAdd.join(", "));
        return {ok: true, method: "metadata", added: toAdd.length};
      } catch (updErr) {
        const updDebug = this.lastSoapDebugText();
        console.warn("[SaralForce] Layout update failed:", updErr.message, "— trying new-layout fallback...");
        // Fallback: create a FRESH layout via the proven async create() op.
        // We author 100% of this XML (no round-trip), so whatever strictness
        // rejects the update can't bite here.
        const fb = await this.createLayoutWithFields(objectName, records, toAdd);
        if (fb.ok) return fb;
        console.warn("[SaralForce] Layout fallback failed:", fb.error);
        return {
          ok: false,
          error: updErr.message + (fb.error ? " | new-layout fallback: " + fb.error : ""),
          debug: updDebug + "\n\n=== fallback attempt ===\n" + this.lastSoapDebugText()
        };
      }
    } catch (err) {
      console.warn("[SaralForce] Layout update failed:", err.message);
      return {ok: false, error: err.message, debug: this.lastSoapDebugText()};
    }
  }

  // Fallback layout creation: fresh "{Object}-SF Creator Layout" containing
  // Name + the new fields, via async create(). The section style is cloned
  // from the existing layout so it renders correctly. NOTE: a new layout is
  // NOT auto-assigned — the result tells the user to assign it in Setup.
  async createLayoutWithFields(objectName, records, toAdd) {
    try {
      const doc = records.ownerDocument;
      const sections = domFindAll(records, "layoutSections");
      if (sections.length === 0) {
        return {ok: false, error: "no layout sections to clone for fallback"};
      }
      const src = sections[0];
      const section = doc.createElement("layoutSections");
      for (const c of domChildren(src)) {
        if (domLocal(c) === "layoutColumns") continue;
        section.appendChild(c.cloneNode(true));
      }
      const col = doc.createElement("layoutColumns");
      const template = findLayoutItemTemplate(records);
      // LayoutItem.field must be the bare API name for custom fields on this
      // object. A leftover "Object.Field" from a prior read is rejected with
      // "no CustomField named IT_Asset__c.Assigned_To__c found" when the
      // create path rebuilds the item — strip any object prefix first.
      const shortName = n => String(n || "").split(".").pop();
      const fields = ["Name", ...Array.from(new Set(toAdd.map(shortName)))
        .filter(f => f && f !== "Name")];
      for (const f of fields) {
        col.appendChild(buildLayoutItem(doc, template, f));
      }
      section.appendChild(col);
      // fullName for a custom layout is Object.LayoutDeveloperName — a
      // spacey/hyphenated name without the object prefix is rejected and
      // confuses field resolution ("no CustomField named Object.Field").
      const layoutDevName = "ForceForge_Layout";
      const newName = `${objectName}.${layoutDevName}`;
      const xml = buildLayoutXml(newName, domToMetXml(section));
      await this.metadataCreate(xml);
      console.log("[SaralForce] Fallback layout created:", newName);
      return {ok: true, method: "create-fallback", added: toAdd.length, layoutName: newName};
    } catch (e) {
      return {ok: false, error: e.message};
    }
  }

  // Resolve a Profile's metadata fullName via readMetadata (never blindly
  // write: SOQL labels like "System Administrator" differ from fullNames
  // like "Admin", and exotic profiles reject guessed names). When guessed
  // candidates all miss, enumerate real fullNames with listMetadata.
  async resolveProfileFullName(label) {
    const attempts = [];
    // When the org's Profile fullName list is already known (all-profiles
    // visibility loop), match first — avoids a doomed readMetadata per label.
    if (this._profileMetadataNames && this._profileMetadataNames.length) {
      const found = matchProfileFullName(label, this._profileMetadataNames);
      if (found) {
        try {
          const records = await this.metadataReadRecords("Profile", found);
          if (records) return {fullName: found, records};
          attempts.push(`listMetadata→"${found}": read failed or empty`);
        } catch (e) {
          attempts.push(`listMetadata→"${found}": ${e.message}`);
        }
      } else {
        attempts.push(`listMetadata: no match among ${this._profileMetadataNames.length} profiles`);
      }
      console.warn(`[SaralForce] Could not resolve profile "${label}" — ${attempts.join("; ")}`);
      return {error: attempts.join("; ") || "no candidates tried"};
    }
    const candidates = label === "System Administrator"
      ? ["Admin", "System Administrator"]
      : [label];
    for (const cand of candidates) {
      try {
        const records = await this.metadataReadRecords("Profile", cand);
        if (records) {
          const fn = domFind(records, "fullName");
          return {fullName: (fn && fn.textContent) || cand, records};
        }
        attempts.push(`"${cand}": not found`);
      } catch (e) {
        console.warn(`[SaralForce] Profile read failed for "${cand}":`, e.message);
        attempts.push(`"${cand}": ${e.message}`);
      }
    }
    // listMetadata fallback: resolve the real fullName from the org's
    // actual Profile metadata list, then case/alias-match the label.
    // Cached for the deploy — applied across every profile in the org.
    try {
      if (!this._profileMetadataNames) {
        this._profileMetadataNames = await this.listMetadataFullNames("Profile");
      }
      const names = this._profileMetadataNames;
      const found = matchProfileFullName(label, names);
      if (found) {
        const records = await this.metadataReadRecords("Profile", found);
        if (records) return {fullName: found, records};
        attempts.push(`listMetadata→"${found}": read failed or empty`);
      } else {
        attempts.push(`listMetadata: no match among ${names.length} profiles`);
      }
    } catch (e) {
      console.warn("[SaralForce] Profile listMetadata failed:", e.message);
      attempts.push(`listMetadata: ${e.message}`);
    }
    console.warn(`[SaralForce] Could not resolve profile "${label}" — ${attempts.join("; ")}`);
    return {error: attempts.join("; ") || "no candidates tried"};
  }

  listMetadataFullNames(type) {
    return metaSoap.listMetadataFullNames(this._soapCtx(), type);
  }

  async setTabVisibilityForProfiles(objectName, labels, recordTypes = []) {
    // Scoped equivalent of the Setup wizard's profile step: tab visibility
    // Default On (+ record-type visibility when the proposal has record
    // types). TARGETED partial update via sync updateMetadata: send ONLY the
    // new entries. A full-profile write is validated as a whole and fails on
    // stale entries unrelated to us (e.g. "You can't edit tab settings for
    // OmniSupervisor, as it's not a valid tab"). Partial Profile updates
    // merge (same as deploying a partial .profile-meta.xml) — nothing else
    // on the profile is touched. The async update() call rejects Profile
    // content, so it is deliberately not used here.
    const done = [];
    const errors = [];
    // Warm fullName list once when covering many profiles (all-profiles mode).
    if (labels.length > 2 && !this._profileMetadataNames) {
      try {
        this._profileMetadataNames = await this.listMetadataFullNames("Profile");
      } catch (e) {
        console.warn("[SaralForce] Profile listMetadata warm-up failed:", e.message);
      }
    }
    // Bulk mode skips the per-profile readMetadata pre-check (each Profile
    // read is huge). Partial tabVisibilities updates are idempotent, so we
    // can write DefaultOn directly. Selected-profile mode still pre-checks.
    const bulk = labels.length > 20;
    const baseStep = this.state.deploymentStep || "Setting tab visibility...";
    for (let i = 0; i < labels.length; i++) {
      if (this._deployAborted) throw new Error("Deployment cancelled");
      const label = labels[i];
      try {
        let fullName;
        let records = null;
        if (bulk && this._profileMetadataNames?.length) {
          fullName = matchProfileFullName(label, this._profileMetadataNames);
          if (!fullName) {
            // Parenthetical / odd labels still need a full resolve attempt.
            try {
              const resolved = await this.resolveProfileFullName(label);
              if (resolved && !resolved.error) {
                fullName = resolved.fullName;
                records = resolved.records;
              } else {
                errors.push(`${label}: no match among ${this._profileMetadataNames.length} profiles`);
                continue;
              }
            } catch (resolveErr) {
              errors.push(`${label}: no match among ${this._profileMetadataNames.length} profiles (${resolveErr.message})`);
              continue;
            }
          }
        } else {
          const resolved = await this.resolveProfileFullName(label);
          if (!resolved || resolved.error) {
            errors.push(`${label}: ${resolved?.error || "could not resolve profile fullName"}`);
            continue;
          }
          fullName = resolved.fullName;
          records = resolved.records;
        }
        const parts = [];
        if (records) {
          // Skip entries that are already correct (only when we read them).
          let tabOn = false;
          const visibleRTs = new Set();
          for (const k of domChildren(records)) {
            const ln = domLocal(k);
            if (ln === "tabVisibilities") {
              const tabEl = domFind(k, "tab");
              const visEl = domFind(k, "visibility");
              if (tabEl && tabEl.textContent === objectName && visEl &&
                  visEl.textContent === "DefaultOn") {
                tabOn = true;
              }
            } else if (ln === "recordTypeVisibilities") {
              const rtEl = domFind(k, "recordType");
              const visEl = domFind(k, "visible");
              if (rtEl && visEl && visEl.textContent === "true") {
                visibleRTs.add(rtEl.textContent);
              }
            }
          }
          if (!tabOn) {
            parts.push(buildTabVisibilityXml(objectName));
          }
          const missingRTs = recordTypes.filter(rt =>
            !visibleRTs.has(`${objectName}.${rt.name}`));
          for (const rt of missingRTs) {
            parts.push(buildRecordTypeVisibilityXml(objectName, rt.name));
          }
        } else {
          // Bulk / no pre-read: always send the tab visibility entry (idempotent).
          parts.push(buildTabVisibilityXml(objectName));
          for (const rt of recordTypes) {
            parts.push(buildRecordTypeVisibilityXml(objectName, rt.name));
          }
        }
        if (parts.length > 0) {
          const xml = buildProfileXml(fullName, parts);
          const upd = await this.metaSoapRequest("updateMetadata", xml);
          // updateMetadata can run async — poll or visibility isn't applied
          // when the user opens App Launcher right after deploy.
          if (upd && upd.id && (upd.done === "false" || upd.state === "InProgress")) {
            console.log(`[SaralForce] Profile visibility async, polling ${upd.id}...`);
            await this.pollDeployStatus(upd.id);
          }
          console.log(`[SaralForce] Tab/record-type visibility set on profile "${fullName}"`);
        } else {
          console.log(`[SaralForce] Visibility already correct on profile "${fullName}"`);
        }
        done.push(fullName);
      } catch (e) {
        if (/cancelled/i.test(e.message)) throw e;
        errors.push(`${label}: ${e.message}`);
      }
      const n = labels.length;
      this.setState({
        deploymentStep: n > 1
          ? `${baseStep.replace(/\s*\(\d+\/\d+\)\.\.\.$/, "")} (${i + 1}/${n})...`
          : baseStep
      });
      await this.delay(bulk ? 50 : 300);
    }
    if (done.length === 0) {
      return {ok: false,
        error: errors.slice(0, 3).join("; ") || "No profiles updated",
        debug: this.lastSoapDebugText()};
    }
    const result = {ok: true, method: "metadata", updated: done};
    if (errors.length > 0) {
      result.warning = `${errors.length} profile(s) skipped: ` +
        errors.slice(0, 2).join("; ");
    }
    return result;
  }

  retryWithNewName() {
    const {currentProposal} = this.state;
    if (!currentProposal) return;
    const next = nextRetryName(currentProposal.object.name, currentProposal.object.label);
    this.setState(prev => ({
      currentProposal: {
        ...prev.currentProposal,
        object: {
          ...prev.currentProposal.object,
          name: next.name,
          label: next.label,
          pluralLabel: prev.currentProposal.object.pluralLabel
            ? nextRetryName(prev.currentProposal.object.name, prev.currentProposal.object.pluralLabel).label
            : prev.currentProposal.object.pluralLabel
        }
      },
      deploymentStatus: null,
      deploymentStep: null,
      deploymentResults: [],
      deployError: null,
      error: null
    }), () => {
      this._autoSaveChat();
      this.deployObject();
    });
  }

  getSetupLink() {
    const {deploymentResults} = this.state;
    const objectResult = deploymentResults.find(r => r.type === "object" && r.status === "success");
    if (objectResult) {
      const {sfHost} = this.props;
      const objectName = objectResult.name;
      return `https://${sfHost}/lightning/setup/ObjectManager/${objectName}/FieldsAndRelationships/view`;
    }
    return null;
  }

  getTabSetupLink() {
    // Lightning Setup URL for managing tabs (App Manager / Tabs list).
    const {sfHost} = this.props;
    return `https://${sfHost}/lightning/setup/ManageTabs/home`;
  }

  async createTab(objectName, objectLabel) {
    // Strategy: Metadata SOAP first (documented format), then Tooling REST.
    // Returns {ok, method, error} so the UI can show the real failure reason.
    // IMPORTANT: create can run async — poll + verify the tab really exists
    // before reporting success, or visibility/assign run against a tab that
    // isn't there yet (tab missing from App Launcher search).
    const motif = pickTabMotif(objectName);
    const tabDetail = `motif=${motif}`;
    const verifyTab = async () => {
      for (let i = 0; i < 4; i++) {
        try {
          const names = await this.listMetadataFullNames("CustomTab");
          if (names.some(n => n === objectName)) return true;
        } catch (e) {
          console.warn("[SaralForce] Tab verify listMetadata failed:", e.message);
        }
        await this.delay(2000);
      }
      return false;
    };
    try {
      console.log("[SaralForce] Creating tab via Metadata API...", tabDetail);
      await this.metadataCreate(buildTabXml(objectName, objectLabel));
      console.log("[SaralForce] Tab created via Metadata API for:", objectName);
      if (!(await verifyTab())) {
        return {ok: false, error: `Tab creation reported success but "${objectName}" not found in CustomTab metadata after re-reads — wait a minute and retry, or check Setup → Tabs.`};
      }
      return {ok: true, method: "metadata"};
    } catch (soapErr) {
      console.warn("[SaralForce] Metadata tab failed:", soapErr.message, "— trying Tooling API...");
      const firstErr = soapErr.message;
      const developerName = objectName.replace(/__c$/, "");
      const toolingBodies = [
        // Standard Tooling pattern: FullName + Metadata wrapper
        {FullName: objectName, Metadata: {customObject: true, motif}},
        // Flat pattern used by some orgs
        {DeveloperName: developerName, Motif: motif, CustomObjectName: objectName}
      ];
      for (let i = 0; i < toolingBodies.length; i++) {
        try {
          await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/CustomTab`, {
            method: "POST",
            body: toolingBodies[i]
          });
          console.log("[SaralForce] Tab created via Tooling API for:", objectName);
          if (!(await verifyTab())) {
            return {ok: false, error: `Tab creation reported success but "${objectName}" not found in CustomTab metadata after re-reads — wait a minute and retry, or check Setup → Tabs.`};
          }
          return {ok: true, method: "tooling"};
        } catch (toolErr) {
          console.warn(`[SaralForce] Tooling tab attempt ${i + 1} failed:`, toolErr.message);
          if (i === toolingBodies.length - 1) {
            const msg = `Metadata: ${firstErr}; Tooling: ${toolErr.message}`;
            console.warn("[SaralForce] Tab creation failed:", msg);
            return {ok: false, error: msg};
          }
        }
      }
    }
    return {ok: false, error: "Unknown tab error"};
  }

  toggleField(fieldName) {
    const {selectedFields, currentProposal} = this.state;
    if (!currentProposal) return;
    const allFieldNames = currentProposal.fields.map(f => f.name);
    const current = selectedFields || [...allFieldNames];
    const next = current.includes(fieldName)
      ? current.filter(n => n !== fieldName)
      : [...current, fieldName];
    this.setState({selectedFields: next});
  }

  selectAllFields() {
    const {currentProposal} = this.state;
    if (!currentProposal) return;
    this.setState({selectedFields: currentProposal.fields.map(f => f.name)});
  }

  deselectAllFields() {
    this.setState({selectedFields: []});
  }

  // ── Plan-mode editing (proposal stays a draft until Build) ──
  planEditErrors() {
    const {currentProposal} = this.state;
    if (!currentProposal) return [];
    return validateProposal(currentProposal);
  }

  // Apply a mutator to a draft copy of the proposal, then re-validate
  // and auto-save the chat. selectedFields remapping is handled by the
  // individual edit helpers (positional remap would break on splice).
  updatePlan(mutator, after) {
    const {currentProposal} = this.state;
    if (!currentProposal || this.state.builderMode !== "plan") return;
    const draft = JSON.parse(JSON.stringify(currentProposal));
    mutator(draft);
    // Keep the sharing model consistent with Master-Detail fields.
    const normalized = normalizeProposal(draft);
    this.setState({currentProposal: normalized, error: null}, () => {
      if (after) after(normalized);
      this._autoSaveChat();
    });
  }

  updatePlanObject(patch) {
    this.updatePlan(draft => {
      draft.object = {...draft.object, ...patch};
    });
  }

  updatePlanField(index, patch) {
    const {currentProposal, selectedFields} = this.state;
    if (!currentProposal || !currentProposal.fields[index]) return;
    const oldName = currentProposal.fields[index].name;
    this.updatePlan(draft => {
      draft.fields[index] = {...draft.fields[index], ...patch};
    }, (draft) => {
      const newName = draft.fields[index] ? draft.fields[index].name : oldName;
      if (selectedFields && newName !== oldName) {
        this.setState({
          selectedFields: selectedFields.map(n => n === oldName ? newName : n)
        });
      }
    });
  }

  deletePlanField(index) {
    const {currentProposal, selectedFields} = this.state;
    if (!currentProposal || !currentProposal.fields[index]) return;
    const removedName = currentProposal.fields[index].name;
    this.updatePlan(draft => {
      draft.fields.splice(index, 1);
    }, () => {
      if (selectedFields) {
        this.setState({selectedFields: selectedFields.filter(n => n !== removedName)});
      }
    });
  }

  deletePlanRecordType(index) {
    this.updatePlan(draft => {
      if (Array.isArray(draft.recordTypes)) draft.recordTypes.splice(index, 1);
    });
  }

  suggestApiName(label) {
    const taken = (this.state.currentProposal?.fields || []).map(f => f.name);
    return suggestApiName(label, taken);
  }

  addPlanField() {
    const {newFieldLabel, newFieldType} = this.state;
    const label = String(newFieldLabel || "").trim();
    if (!label) {
      this.setState({error: "Enter a field label to add it to the plan."});
      return;
    }
    const type = newFieldType || "Text";
    const field = {
      label,
      name: this.suggestApiName(label),
      type,
      required: false,
      description: ""
    };
    if (type === "Picklist" || type === "MultiselectPicklist") {
      field.values = ["Option 1", "Option 2"];
    }
    if (type === "Lookup" || type === "MasterDetail") {
      field.relatedTo = "Account";
    }
    this.updatePlan(draft => {
      draft.fields.push(field);
    });
    this.setState(prev => ({
      newFieldLabel: "",
      selectedFields: prev.selectedFields ? [...prev.selectedFields, field.name] : null
    }));
  }

  async loadProfiles() {
    if (this.state.profilesLoading || this._profilesLoading ||
        (this.state.availableProfiles && this.state.availableProfiles.length)) {
      return;
    }
    this._profilesLoading = true;
    this.setState({profilesLoading: true});
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(`SELECT Name FROM Profile ORDER BY Name`));
      const names = (res.records || []).map(r => r.Name).filter(Boolean);
      this._profilesLoading = false;
      this.setState({availableProfiles: names, profilesLoading: false});
    } catch (e) {
      console.warn("[SaralForce] Could not load profiles:", e.message);
      this._profilesLoading = false;
      this.setState({profilesLoading: false});
    }
  }

  setVisibilityMode(mode) {
    this.setState({visibilityMode: mode}, () => {
      if (mode === "selected") this.loadProfiles();
    });
  }

  toggleProfile(name) {
    this.setState(prev => {
      const set = new Set(prev.selectedProfiles || []);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      return {selectedProfiles: Array.from(set)};
    });
  }

  getVisibilityLabels() {
    const {visibilityMode, selectedProfiles, availableProfiles} = this.state;
    if (visibilityMode === "selected" && selectedProfiles && selectedProfiles.length > 0) {
      return [...selectedProfiles];
    }
    return availableProfiles && availableProfiles.length
      ? [...availableProfiles]
      : ["System Administrator"];
  }

  // Always include the running user's profile so the tab is usable even when
  // bulk listMetadata skips an exotic label (non-API / parenthetical names).
  async ensureCurrentUserVisibility(objectName) {
    try {
      const userId = await this.resolveCurrentUserId();
      const ures = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(`SELECT ProfileId FROM User WHERE Id = '${userId}'`));
      const pid = ures?.records?.[0]?.ProfileId;
      if (!pid) return null;
      const pres = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${pid}'`));
      const name = pres?.records?.[0]?.Name;
      if (!name) return null;
      console.log(`[SaralForce] Ensuring tab DefaultOn on current user profile "${name}"`);
      const res = await this.setTabVisibilityForProfiles(objectName, [name], []);
      return res;
    } catch (e) {
      console.warn("[SaralForce] Current-user tab visibility failed:", e.message);
      return null;
    }
  }

  // Record types only need the object itself: allow them once a deploy run
  // finished and its object step succeeded (field/layout errors don't block).
  objectDeploySucceeded() {
    const {deploymentStatus, deploymentResults, currentProposal} = this.state;
    return deploymentStatus === "complete" && !!currentProposal &&
      (deploymentResults || []).some(r => r.type === "object" && r.status === "success" &&
        r.name === currentProposal.object.name);
  }

  // Post-deploy: create record types (and RT visibility) when the proposal has them.
  async createRecordTypes() {
    const {currentProposal} = this.state;
    if (!currentProposal || !(currentProposal.recordTypes || []).length) return;
    if (!this.objectDeploySucceeded()) {
      this.setState({error: "Deploy the object successfully first, then create record types."});
      return;
    }
    const rts = currentProposal.recordTypes;
    this._deployAborted = false;
    this._abortController = new AbortController();
    this.setState({
      deploymentStatus: "deploying",
      deploymentStep: "Creating record types...",
      error: null
    });
    let okCount = 0;
    for (let i = 0; i < rts.length; i++) {
      if (this._deployAborted) break;
      const rt = rts[i];
      this.setState({deploymentStep: `Creating record type ${i + 1}/${rts.length}: "${rt.label}"...`});
      try {
        const rtResult = await this.metadataCreate(buildRecordTypeXml(currentProposal.object.name, rt));
        okCount++;
        this.setState(prev => ({
          deploymentResults: [...prev.deploymentResults, {
            type: "recordtype",
            name: rt.name,
            label: rt.label,
            status: "success",
            id: rtResult.id
          }]
        }));
      } catch (rtErr) {
        this.setState(prev => ({
          deploymentResults: [...prev.deploymentResults, {
            type: "recordtype",
            name: rt.name,
            label: rt.label,
            status: "error",
            error: rtErr.message,
            debug: this.lastSoapDebugText()
          }]
        }));
      }
      await this.delay(300);
    }
    // Make new RTs visible on the profiles used for tab visibility.
    try {
      const visLabels = this.getVisibilityLabels();
      await this.setTabVisibilityForProfiles(currentProposal.object.name, visLabels, rts);
    } catch (e) {
      console.warn("[SaralForce] Record type visibility update failed:", e.message);
    }
    this.setState({
      deploymentStatus: "complete",
      deploymentStep: okCount === rts.length ? "Record types created" : "Record types finished with errors",
      recordTypesDone: true
    });
  }

  render() {
    const {
      messages, currentProposal, isGenerating, streamingText, isEnhancing, enhancedPreview,
      deploymentStatus, deploymentStep, deploymentProgress, deploymentResults, error, userInput, lastFailedPrompt,
      selectedFields, visibilityMode, selectedProfiles, availableProfiles, profilesLoading, recordTypesDone
    } = this.state;

    const setupLink = this.getSetupLink();
    const hasConfig = hasValidConfig();
    // The object exists from an earlier attempt in this session, so a plain
    // deploy would stop at the duplicate check — offer Resume instead.
    const canResume = !!(currentProposal && this.state.deployedObjectName &&
      this.state.deployedObjectName === currentProposal.object.name);
    const deployError = this.state.deployError;
    const uiMode = this.state.uiMode || "inspector";
    // Chat and preview are mutually exclusive: the chat panel renders only
    // before the first proposal; Plan/Build pages are preview-only.

    if (uiMode === "inspector") {
      return h("div", {className: "app-container"},
        h("div", {className: "app-header"},
          h("div", {className: "header-left"},
            h("img", {className: "logo-chip", src: "logo-mark.png", alt: ""}),
            h("h1", {className: "app-title"}, "SaralForce | AI Object Builder & Org Toolkit")
          ),
          h("div", {className: "header-right"},
            h("button", {
              className: "header-btn",
              onClick: () => this.goBackFromInspector(),
              title: "Back to AI Object Builder",
              "data-tour": "builder-btn"
            }, "← AI Object Builder"),
            h("button", {
              className: `header-btn${this.state.apiNamesOn ? " active" : ""}`,
              onClick: () => this.toggleApiNames(),
              title: "Show API names on this Salesforce page (click again to hide)",
              "data-tour": "api-names"
            }, this.state.apiNamesOn ? "Hide API Names" : "Show API Names"),
            !sfConn.sessionId && h("button", {
              className: "header-btn",
              onClick: () => startSalesforceLogin(this.props.sfHost).catch(e => this.setState({error: "Login failed: " + e.message})),
              title: "Log in with Salesforce OAuth"
            }, "Connect"),
            h("button", this.themeButtonProps()),
            h("button", this.helpButtonProps()),
            h("span", {
              className: "user-info",
              title: `${this.userInfoModel.userFullName || "User"} — click for profile details`,
              style: {cursor: "pointer"},
              onClick: () => this.showUserCard()
            },
              this.userInfoModel.userInitials || "R"
            )
          )
        ),
        h(InspectorPanel),
        h("div", {className: "app-footer"},
          h("a", {
            href: "https://rakesh-attri.github.io/ErBhajanMandali/",
            target: "_blank",
            rel: "noopener noreferrer"
          },
            "Developed by Er.Bhajan Mandali © ",
            h("svg", {className: "ff-flag", width: 16, height: 11, viewBox: "0 0 18 12", "aria-label": "India"},
              h("rect", {width: 18, height: 4, fill: "#FF9933"}),
              h("rect", {y: 4, width: 18, height: 4, fill: "#FFFFFF"}),
              h("rect", {y: 8, width: 18, height: 4, fill: "#138808"}),
              h("circle", {cx: 9, cy: 6, r: 1.7, fill: "none", stroke: "#000080", strokeWidth: 0.6})
            )
          )
        )
      );
    }

    return h("div", {className: "app-container"},
      h("div", {className: "app-header"},
        h("div", {className: "header-left"},
          h("img", {className: "logo-chip", src: "logo-mark.png", alt: ""}),
          h("h1", {className: "app-title"}, "SaralForce | AI Object Builder & Org Toolkit")
        ),
        h("div", {className: "header-right"},
          h("button", {
            className: "header-btn",
            onClick: () => this.openInspector(),
            title: "SOQL, Data Import/Export, Org Info",
            "data-tour": "inspector-btn"
          }, "Inspector"),
          h("button", {
            className: `header-btn${this.state.apiNamesOn ? " active" : ""}`,
            onClick: () => this.toggleApiNames(),
            title: "Show API names on this Salesforce page (click again to hide)",
            "data-tour": "api-names"
          }, this.state.apiNamesOn ? "Hide API Names" : "Show API Names"),
          !sfConn.sessionId && h("button", {
            className: "header-btn",
            onClick: () => startSalesforceLogin(this.props.sfHost).catch(e => this.setState({error: "Login failed: " + e.message})),
            title: "Log in with Salesforce OAuth"
          }, "Connect"),
          h("button", {
            className: "header-btn header-btn-new",
            onClick: () => this.newChat(),
            title: "New Chat"
          }, "\u2795 New"),
          h("button", {
            className: `header-btn${this.state.showHistory ? " active" : ""}`,
            onClick: () => this.setState({showHistory: !this.state.showHistory}),
            title: "Chat History",
            "data-tour": "history"
          }, `\u23f3 ${this.state.chatHistory.length}`),
          h("button", this.themeButtonProps()),
          h("button", this.helpButtonProps()),
          h("span", {
            className: "user-info",
            title: `${this.userInfoModel.userFullName || "User"} — click for profile details`,
            style: {cursor: "pointer"},
            onClick: () => this.showUserCard()
          },
            this.userInfoModel.userInitials || "R"
          )
        )
      ),

      this.state.showHistory && h("div", {className: "history-panel"},
        h("div", {className: "history-header"},
          h("span", null, "Chat History"),
          h("button", {className: "history-close", onClick: () => this.setState({showHistory: false})}, "\u00d7")
        ),
        this.state.chatHistory.length === 0 && h("div", {className: "history-empty"}, "No previous chats"),
        this.state.chatHistory.map(chat => {
          const firstUserMsg = chat.messages?.find(m => m.role === "user");
          const preview = firstUserMsg?.text?.substring(0, 60) || "Empty chat";
          const date = new Date(chat.timestamp);
          const timeStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
          return h("div", {
            key: chat.id,
            className: `history-item ${chat.id === this.state.activeChatId ? "active" : ""}`,
            onClick: () => { this.loadChat(chat.id); this.setState({showHistory: false}); }
          },
            h("div", {className: "history-item-preview"}, preview + (firstUserMsg?.text?.length > 60 ? "..." : "")),
            h("div", {className: "history-item-meta"},
              h("span", null, timeStr),
              h("button", {
                className: "history-delete",
                onClick: (e) => { e.stopPropagation(); this.deleteChat(chat.id); }
              }, "\u2715")
            )
          );
        })
      ),

      h("div", {className: "app-body"},
        !currentProposal && h("div", {className: "chat-panel"},
          h("div", {className: "chat-messages", ref: this.chatContainerRef},
            messages.map((msg, i) =>
              h("div", {key: i, className: `message message-${msg.role}`},
                msg.role === "system" && h("div", {className: "message-system"},
                  msg.text,
                  /configure your LLM provider/i.test(msg.text || "") && !hasConfig &&
                    h("div", {style: {marginTop: "10px"}},
                      h("button", {
                        className: "btn btn-primary btn-sm",
                        onClick: () => this.openOptions()
                      }, "Open Settings"))
                ),
                msg.role === "user" && h("div", {className: "message-user"},
                  h("div", {className: "message-avatar user-avatar"}, "You"),
                  h("div", {className: "message-bubble"}, msg.text)
                ),
                msg.role === "assistant" && h("div", {className: "message-assistant"},
                  h("div", {className: "message-avatar assistant-avatar"}, this.saralAvatarLabel()),
                  (this.renderAssistantJson(msg) || h("div", {className: "message-bubble"}, msg.text))
                )
              )
            ),
            isGenerating && streamingText && h("div", {className: "message message-assistant"},
              h("div", {className: "message-avatar assistant-avatar"}, this.saralAvatarLabel()),
              h("div", {className: "message-bubble streaming"}, streamingText)
            ),
            isGenerating && !streamingText && h("div", {className: "message message-assistant"},
              h("div", {className: "message-avatar assistant-avatar"}, this.saralAvatarLabel()),
              h("div", {className: "message-bubble typing-indicator"},
                h("span", {className: "dot"}),
                h("span", {className: "dot"}),
                h("span", {className: "dot"})
              )
            ),
            h("div", {ref: this.messagesEndRef})
          ),

          error && h("div", {className: "error-banner"},
            h("span", null, error),
            (/already exists|Suggested rename/i.test(error) && currentProposal) && h("button", {
              className: "btn btn-primary btn-sm",
              style: {marginLeft: "8px"},
              onClick: () => this.retryWithNewName()
            }, "Retry with new name"),
            lastFailedPrompt && h("button", {
              className: "btn btn-primary btn-sm",
              style: {marginLeft: "8px"},
              disabled: isGenerating,
              onClick: () => this.retrySend()
            }, isGenerating ? "..." : "↻ Retry"),
            h("button", {className: "error-close", onClick: () => this.setState({error: null})}, "\u00d7")
          ),

          h("div", {className: "chat-input-area"},
            enhancedPreview && h("div", {className: "enhance-preview"},
              h("div", {className: "enhance-preview-label"}, "Enhanced prompt"),
              h("div", {className: "enhance-preview-text"}, enhancedPreview),
              h("div", {className: "enhance-preview-actions"},
                h("button", {
                  className: "btn btn-primary btn-sm",
                  onClick: () => this.setState({userInput: enhancedPreview, enhancedPreview: null})
                }, "Accept"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => this.setState({enhancedPreview: null})
                }, "Discard")
              )
            ),
            h("div", {className: "chat-input-row"},
              h("div", {className: "chat-input-wrap", "data-tour": "chat-input"},
                h("textarea", {
                className: "chat-input",
                value: userInput,
                onChange: (e) => this.setState({userInput: e.target.value}),
                onKeyDown: (e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                  }
                },
                placeholder: hasConfig
                  ? "Describe the object you want to create... (e.g., 'I need a payment transaction object with amount, status, and customer info')"
                  : "Configure your LLM provider first...",
                disabled: !hasConfig || isGenerating,
                rows: 2
              }),
                h("button", {
                  className: "enhance-btn-inside",
                  "data-tour": "enhance",
                  onClick: () => this.enhancePrompt(),
                  disabled: isEnhancing,
                  title: "Enhance prompt"
                }, isEnhancing ? "..." : "🪄")
              ),
              h("button", {
                className: "send-btn",
                title: "Send",
                onClick: () => this.sendMessage(),
                disabled: !hasConfig || isGenerating || !userInput.trim()
              }, isGenerating
                ? "…"
                : h("svg", {width: 17, height: 17, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true"},
                    h("path", {d: "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"})))
            )
          )
        ),

        currentProposal && h("div", {className: "preview-panel"},
          h("div", {className: "preview-header"},
            h("h2", null, "Object Preview"),
            h("div", {className: "mode-toggle", title: "Plan: draft and edit. Build: locked, deploy only."},
              h("button", {
                className: `mode-btn ${(this.state.builderMode || "plan") === "plan" ? "active" : ""}`,
                onClick: () => this.setState({builderMode: "plan"}, () => this._autoSaveChat())
              }, "Plan"),
              h("button", {
                className: `mode-btn ${(this.state.builderMode || "plan") === "build" ? "active" : ""}`,
                onClick: () => this.setState({builderMode: "build"}, () => this._autoSaveChat())
              }, "Build")
            ),
            h("div", {className: "preview-actions"},
              deploymentStatus !== "deploying" && (this.state.builderMode || "plan") === "build" && (() => {
                const errs = this.planEditErrors();
                const deployCount = (selectedFields || currentProposal.fields.map(f => f.name)).length;
                return h("button", {
                  className: "btn btn-primary btn-sm",
                  onClick: () => this.deployObject({resume: canResume}),
                  disabled: !currentProposal.fields?.length || errs.length > 0,
                  title: errs.length > 0
                    ? "Fix plan issues first: " + errs.slice(0, 2).join("; ")
                    : canResume
                      ? `${currentProposal.object.name} was created by an earlier attempt — deploy only the missing fields and steps`
                      : `Deploy ${currentProposal.object.label} to Salesforce`
                }, canResume ? `Resume deploy (${deployCount} fields)` : `Deploy (${deployCount} fields)`);
              })(),
              deploymentStatus !== "deploying" && (this.state.builderMode || "plan") === "build" &&
                this.planEditErrors().length > 0 && h("span", {className: "plan-error-hint"},
                  `${this.planEditErrors().length} plan issue(s) — switch to Plan to fix`),
              deploymentStatus === "deploying" && h("button", {
                className: "btn btn-danger btn-sm",
                onClick: () => this.cancelDeployment()
              }, "Cancel"),
              h("button", {
                className: "btn btn-secondary btn-sm",
                onClick: async (e) => {
                  const ok = await safeCopyText(JSON.stringify(currentProposal, null, 2));
                  const btn = e.currentTarget;
                  const orig = btn.textContent;
                  btn.textContent = ok ? "Copied!" : "Copy failed";
                  setTimeout(() => { btn.textContent = orig; }, 1500);
                  if (!ok) this.setState({error: "Copy failed in this iframe context."});
                }
              }, "Copy JSON")
            )
          ),
          (this.state.builderMode || "plan") === "plan" && (() => {
            const errs = this.planEditErrors();
            return h("div", {className: "plan-hint"},
              "Plan mode — refine inline below. Switch to Build when the plan is final.",
              errs.length > 0 && h("div", {className: "plan-error-list"},
                errs.slice(0, 4).map((e, i) => h("div", {key: i}, "• " + e)),
                errs.length > 4 && h("div", null, `…+${errs.length - 4} more`))
            );
          })(),

          // The chat panel (and its error banner) is hidden once a proposal
          // exists, so errors must also surface here.
          error && h("div", {className: "error-banner"},
            h("span", null, error),
            lastFailedPrompt && h("button", {
              className: "btn btn-primary btn-sm",
              style: {marginLeft: "8px"},
              disabled: isGenerating,
              onClick: () => this.retrySend()
            }, isGenerating ? "..." : "↻ Retry"),
            h("button", {className: "error-close", onClick: () => this.setState({error: null})}, "\u00d7")
          ),

          h("div", {className: "preview-content"},
            (this.state.builderMode || "plan") === "plan"
              ? h("div", {className: "object-card plan-edit"},
                  h("div", {className: "plan-edit-grid"},
                    h("label", {className: "insp-field"},
                      h("span", null, "Object Label *"),
                      h("input", {
                        value: currentProposal.object.label || "",
                        onChange: e => this.updatePlanObject({label: e.target.value})
                      })
                    ),
                    h("label", {className: "insp-field"},
                      h("span", null, "API Name * (…__c)"),
                      h("input", {
                        value: currentProposal.object.name || "",
                        spellCheck: false,
                        onChange: e => this.updatePlanObject({name: e.target.value})
                      })
                    )
                  ),
                  h("label", {className: "insp-field"},
                    h("span", null, "Description"),
                    h("input", {
                      value: currentProposal.object.description || "",
                      onChange: e => this.updatePlanObject({description: e.target.value})
                    })
                  ),
                  h("div", {className: "plan-edit-grid"},
                    h("label", {className: "insp-field"},
                      h("span", null, "Sharing Model"),
                      h("select", {
                        value: currentProposal.object.sharingModel || "ReadWrite",
                        title: (currentProposal.fields || []).some(f => normalizeFieldType(f.type) === "MasterDetail")
                          ? "Objects with a Master-Detail field are always ControlledByParent"
                          : undefined,
                        onChange: e => this.updatePlanObject({sharingModel: e.target.value})
                      },
                        // Keep an invalid AI-supplied value visible so the
                        // validation error above makes sense.
                        (SHARING_MODELS.includes(currentProposal.object.sharingModel || "ReadWrite")
                          ? SHARING_MODELS
                          : [...SHARING_MODELS, currentProposal.object.sharingModel]).map(s =>
                          h("option", {key: s, value: s}, SHARING_MODELS.includes(s) ? s : `${s} (invalid)`))
                      )
                    ),
                    h("label", {className: "insp-field"},
                      h("span", null, "Name Field Label"),
                      h("input", {
                        value: currentProposal.object.nameField?.label || "",
                        onChange: e => this.updatePlanObject({
                          nameField: {...currentProposal.object.nameField, label: e.target.value}
                        })
                      })
                    ),
                    h("label", {className: "insp-field"},
                      h("span", null, "Name Field Type"),
                      h("select", {
                        value: currentProposal.object.nameField?.type || "Text",
                        onChange: e => this.updatePlanObject({
                          nameField: {...currentProposal.object.nameField, type: e.target.value}
                        })
                      },
                        ["Text", "AutoNumber"].map(t => h("option", {key: t, value: t}, t))
                      )
                    ),
                    resolveNameField(currentProposal.object).type === "AutoNumber" && h("label", {className: "insp-field"},
                      h("span", null, "Display Format"),
                      h("input", {
                        value: currentProposal.object.nameField?.format || "",
                        placeholder: "e.g. INV-{0000}",
                        spellCheck: false,
                        onChange: e => this.updatePlanObject({
                          nameField: {...currentProposal.object.nameField, format: e.target.value}
                        })
                      })
                    )
                  )
                )
              : h("div", {className: "object-card"},
                  h("div", {className: "object-card-header"},
                    h("h3", {className: "object-label"}, currentProposal.object.label),
                    h("span", {className: "object-api-name"}, currentProposal.object.name)
                  ),
                  currentProposal.object.description && h("p", {className: "object-description"}, currentProposal.object.description),
                  h("div", {className: "object-meta"},
                    h("span", {className: "meta-item"}, (() => {
                      const nf = resolveNameField(currentProposal.object);
                      return `Name Field: ${nf.label} (${nf.type}${nf.displayFormat ? ", " + nf.displayFormat : ""})`;
                    })()),
                    currentProposal.object.sharingModel && h("span", {className: "meta-item"}, `Sharing: ${currentProposal.object.sharingModel}`)
                  )
                ),

            currentProposal && h("div", {className: "visibility-section targets-section"},
              h("div", {className: "fields-header"},
                h("h4", null, "Deployment Targets")
              ),
              h("p", {className: "app-section-hint"},
                "Choose profiles for tab visibility and an app to pin the tab to — used automatically when you deploy."
              ),
              h("div", {className: "targets-block"},
                h("div", {className: "targets-label"}, "Tab visibility profiles"),
                h("div", {className: "visibility-options"},
                  h("label", {className: "visibility-option"},
                    h("input", {
                      type: "radio",
                      name: "visibilityMode",
                      checked: visibilityMode === "all",
                      onChange: () => this.setVisibilityMode("all")
                    }),
                    " All profiles"
                  ),
                  h("label", {className: "visibility-option"},
                    h("input", {
                      type: "radio",
                      name: "visibilityMode",
                      checked: visibilityMode === "selected",
                      onChange: () => this.setVisibilityMode("selected")
                    }),
                    " Choose profiles"
                  )
                ),
                visibilityMode === "selected" && h("div", {className: "profile-picker"},
                  profilesLoading && h("div", {className: "profile-loading"}, "Loading profiles..."),
                  !profilesLoading && availableProfiles.length === 0 && h("button", {
                    className: "btn btn-secondary btn-sm",
                    onClick: () => this.loadProfiles()
                  }, "Load profiles"),
                  availableProfiles.length > 0 && h("div", {className: "profile-list"},
                    h("div", {className: "profile-list-actions"},
                      h("button", {
                        className: "field-action-btn",
                        onClick: () => this.setState({selectedProfiles: [...availableProfiles]})
                      }, "All"),
                      h("button", {
                        className: "field-action-btn",
                        onClick: () => this.setState({selectedProfiles: []})
                      }, "None"),
                      h("span", {className: "profile-count"}, `${selectedProfiles.length} selected`)
                    ),
                    availableProfiles.map(name =>
                      h("label", {key: name, className: "profile-option"},
                        h("input", {
                          type: "checkbox",
                          checked: (selectedProfiles || []).includes(name),
                          onChange: () => this.toggleProfile(name)
                        }),
                        h("span", null, name)
                      )
                    )
                  )
                ),
                visibilityMode === "selected" && !(selectedProfiles || []).length &&
                  h("div", {className: "app-empty-msg"}, "Select at least one profile (or switch to All profiles).")
              )
            ),

            h("div", {className: "fields-section"},
              h("div", {className: "fields-header"},
                h("h4", null, `Fields (${currentProposal.fields.length})`),
                h("div", {className: "field-select-actions"},
                  h("button", {
                    className: "field-action-btn",
                    onClick: () => this.selectAllFields()
                  }, "All"),
                  h("button", {
                    className: "field-action-btn",
                    onClick: () => this.deselectAllFields()
                  }, "None")
                )
              ),
              h("table", {className: "fields-table"},
                h("thead", null,
                  h("tr", null,
                    h("th", {className: "field-checkbox-col"}, ""),
                    h("th", null, "Label"),
                    h("th", null, "API Name"),
                    h("th", null, "Type"),
                    h("th", null, "Req'd"),
                    h("th", null, "Description"),
                    (this.state.builderMode || "plan") === "plan" && h("th", {className: "field-checkbox-col"}, "")
                  )
                ),
                h("tbody", null,
                  currentProposal.fields.map((field, i) => {
                    const isChecked = !selectedFields || selectedFields.includes(field.name);
                    const isPlan = (this.state.builderMode || "plan") === "plan";
                    return h("tr", {key: i, className: isChecked ? "" : "field-deselected"},
                      h("td", {className: "field-checkbox-col"},
                        h("input", {
                          type: "checkbox",
                          checked: isChecked,
                          onChange: () => this.toggleField(field.name),
                          className: "field-checkbox"
                        })
                      ),
                      isPlan
                        ? h("td", null,
                            h("input", {
                              className: "plan-cell-input",
                              value: field.label || "",
                              onChange: e => this.updatePlanField(i, {label: e.target.value})
                            }))
                        : h("td", null, field.label),
                      isPlan
                        ? h("td", {className: "api-name-cell"},
                            h("input", {
                              className: "plan-cell-input plan-cell-mono",
                              value: field.name || "",
                              spellCheck: false,
                              onChange: e => this.updatePlanField(i, {name: e.target.value})
                            }))
                        : h("td", {className: "api-name-cell"}, field.name),
                      isPlan
                        ? h("td", null,
                            h("select", {
                              className: "plan-cell-input",
                              value: field.type,
                              onChange: e => this.updatePlanField(i, {type: e.target.value})
                            },
                              FIELD_TYPES.map(ft =>
                                h("option", {key: ft.value, value: ft.value}, ft.label))
                            ))
                        : h("td", null, this.getFieldTypeLabel(field.type)),
                      isPlan
                        ? h("td", {className: "req-cell"},
                            h("input", {
                              type: "checkbox",
                              checked: !!field.required,
                              onChange: e => this.updatePlanField(i, {required: e.target.checked}),
                              className: "field-checkbox"
                            }))
                        : h("td", {className: "req-cell"}, field.required ? "\u2713" : ""),
                      isPlan
                        ? h("td", {className: "desc-cell"},
                            h("input", {
                              className: "plan-cell-input",
                              value: field.description || "",
                              onChange: e => this.updatePlanField(i, {description: e.target.value})
                            }))
                        : h("td", {className: "desc-cell"}, field.description || ""),
                      isPlan && h("td", {className: "field-checkbox-col"},
                        h("button", {
                          className: "plan-del-btn",
                          title: `Delete field "${field.label}" from the plan`,
                          onClick: () => this.deletePlanField(i)
                        }, "\u2715")
                      )
                    );
                  })
                )
              ),
              (this.state.builderMode || "plan") === "plan" && h("div", {className: "plan-add-row"},
                h("input", {
                  className: "plan-cell-input",
                  placeholder: "New field label…",
                  value: this.state.newFieldLabel || "",
                  onChange: e => this.setState({newFieldLabel: e.target.value}),
                  onKeyDown: e => { if (e.key === "Enter") this.addPlanField(); }
                }),
                h("select", {
                  className: "plan-cell-input",
                  value: this.state.newFieldType || "Text",
                  onChange: e => this.setState({newFieldType: e.target.value})
                },
                  FIELD_TYPES.map(ft =>
                    h("option", {key: ft.value, value: ft.value}, ft.label))
                ),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => this.addPlanField()
                }, "+ Add field")
              ),
              h("div", {className: "fields-footer"},
                `${selectedFields
                  ? currentProposal.fields.filter(f => selectedFields.includes(f.name)).length
                  : currentProposal.fields.length} of ${currentProposal.fields.length} fields selected`
              )
            ),

            currentProposal.recordTypes && currentProposal.recordTypes.length > 0 && h("div", {className: "fields-section"},
              h("div", {className: "fields-header"},
                h("h4", null, `Record Types (${currentProposal.recordTypes.length})`),
                h("div", {className: "field-select-actions"},
                  h("button", {
                    className: "btn btn-secondary btn-sm",
                    disabled: !this.objectDeploySucceeded() || recordTypesDone,
                    title: !this.objectDeploySucceeded()
                      ? "Deploy the object successfully first, then create record types"
                      : undefined,
                    onClick: () => this.createRecordTypes()
                  }, recordTypesDone ? "Created ✓" : "Create after deploy")
                )
              ),
              h("table", {className: "fields-table"},
                h("thead", null,
                  h("tr", null,
                    h("th", null, "Label"),
                    h("th", null, "Developer Name"),
                    h("th", null, "Active"),
                    h("th", null, "Description"),
                    (this.state.builderMode || "plan") === "plan" && h("th", {className: "field-checkbox-col"}, "")
                  )
                ),
                h("tbody", null,
                  currentProposal.recordTypes.map((rt, i) =>
                    h("tr", {key: "rt-" + i},
                      h("td", null, rt.label),
                      h("td", {className: "api-name-cell"}, rt.name),
                      h("td", {className: "req-cell"}, rt.active === false ? "" : "\u2713"),
                      h("td", {className: "desc-cell"}, rt.description || ""),
                      (this.state.builderMode || "plan") === "plan" && h("td", {className: "field-checkbox-col"},
                        h("button", {
                          className: "plan-del-btn",
                          title: `Remove record type "${rt.label}" from the plan`,
                          onClick: () => this.deletePlanRecordType(i)
                        }, "\u2715")
                      )
                    )
                  )
                )
              )
            ),

            deploymentStatus && h("div", {className: "deployment-section"},
              h("h4", null, "Deployment Progress"),

              deploymentStatus === "deploying" && h("div", {className: "deploy-progress-bar-container"},
                h("div", {className: "deploy-progress-bar", style: {width: `${deploymentProgress || 0}%`}}),
                h("div", {className: "deploy-progress-text"}, `${deploymentProgress || 0}%`)
              ),

              deploymentStep && deploymentStatus === "deploying" && h("div", {className: "deploy-current-step"},
                h("span", {className: "deploy-spinner"}),
                h("span", null, deploymentStep)
              ),

              deploymentStatus === "complete" && !deploymentResults.some(r => r.status === "error") && h("div", {className: "deploy-success-banner"},
                "\u2713 Deployment Successful"
              ),

              deploymentStatus === "complete" && deploymentResults.some(r => r.status === "error") && h("div", {className: "deploy-partial-banner"},
                "\u26a0 Deployment completed with errors",
                canResume && " — fix the plan if needed, then use Resume deploy to retry the failed steps."
              ),

              deploymentStatus === "failed" && h("div", {className: "error-banner", role: "alert"},
                h("span", null, "\u2717 Deployment failed: " + (deployError || "Unknown error")),
                canResume && h("button", {
                  className: "btn btn-primary btn-sm",
                  style: {marginLeft: "8px"},
                  onClick: () => this.deployObject({resume: true})
                }, "Resume deploy"),
                !canResume && /already exists/i.test(deployError || "") && h("button", {
                  className: "btn btn-primary btn-sm",
                  style: {marginLeft: "8px"},
                  onClick: () => this.retryWithNewName()
                }, `Retry with new name (${nextRetryName(currentProposal.object.name, currentProposal.object.label).name})`),
                h("button", {
                  className: "deploy-copy-error",
                  onClick: async (e) => {
                    const btn = e.currentTarget;
                    const ok = await safeCopyText(deployError || "");
                    btn.textContent = ok ? "Copied!" : "Failed";
                    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
                  }
                }, "Copy")
              ),

              deploymentResults.map((result, i) =>
                h("div", {key: i, className: `deploy-result deploy-${result.status}`},
                  h("span", {className: "deploy-icon"}, result.status === "success" ? "\u2713" : result.status === "error" ? "\u2717" : "\u25cb"),
                  h("span", {className: "deploy-type"}, result.type === "object" ? "Object" : result.type === "fls" ? "Security" : result.type === "tab" ? "Tab" : result.type === "visibility" ? "Visibility" : result.type === "layout" ? "Layout" : result.type === "recordtype" ? "RecType" : result.type === "app" ? "App" : "Field"),
                  h("span", {className: "deploy-name"}, result.label || result.name),
                    result.status === "error" && h("div", {className: "deploy-error-detail"},
                      h("span", {className: "deploy-error-msg"}, result.error),
                      h("button", {
                        className: "deploy-copy-error",
                        onClick: async (e) => {
                          const btn = e.currentTarget;
                          const ok = await safeCopyText(result.error || "");
                          btn.textContent = ok ? "Copied!" : "Failed";
                          setTimeout(() => { btn.textContent = "Copy"; }, 1500);
                        }
                      }, "Copy"),
                      result.debug && h("button", {
                        className: "deploy-copy-error",
                        title: "Copy SOAP request/response for diagnosis (no session ids included)",
                        onClick: async (e) => {
                          const btn = e.currentTarget;
                          const ok = await safeCopyText(
                            `Error: ${result.error || ""}\n\n${result.debug || ""}`);
                          btn.textContent = ok ? "Copied!" : "Failed";
                          setTimeout(() => { btn.textContent = "Debug"; }, 1500);
                        }
                      }, "Debug")
                    )
                )
              ),

              deploymentStatus === "complete" && deploymentResults.some(r => r.type === "tab" && r.status === "success") && h("div", {className: "deploy-hint"},
                visibilityMode === "selected"
                  ? `Tab visibility is Default On for ${selectedProfiles?.length || 0} selected profile(s). The tab is ready — open it from App Launcher search, Setup → Tabs, or the object's Salesforce URL. To pin it onto a Lightning app's navigation bar (and set visibility per profile / permission set), use the button below.`
                  : "Tab visibility is Default On on all profiles. The tab is ready — open it from App Launcher search, Setup → Tabs, or the object's Salesforce URL. To pin it onto a Lightning app's navigation bar (and set visibility per profile / permission set), use the button below."
              ),

              deploymentStatus === "complete" && deploymentResults.some(r => r.type === "tab" && r.status === "success") && h("button", {
                className: "setup-link",
                style: {display: "block", cursor: "pointer", border: "none", fontFamily: "inherit"},
                title: "Open the App Tab Manager with this object's tab preselected — you pick the app and approve the change",
                onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.addToLightningApp(); }
              }, "＋ Add to Lightning App →"),

              deploymentStatus === "complete" && setupLink && h("a", {
                className: "setup-link",
                href: setupLink,
                target: "_blank"
              }, "Open in Salesforce Setup \u2197"),

              deploymentStatus === "complete" && deploymentResults.some(r => r.type === "tab" && r.status === "success") && h("a", {
                className: "setup-link",
                href: this.getTabSetupLink(),
                target: "_blank",
                style: {marginLeft: "8px"}
              }, "Manage Tabs / App Manager \u2197")
            )
          )
        )
      ),

      h("div", {className: "app-footer"},
        h("a", {
          href: "https://rakesh-attri.github.io/ErBhajanMandali/",
          target: "_blank",
          rel: "noopener noreferrer"
        },
          "Developed by Er.Bhajan Mandali © ",
          h("svg", {className: "ff-flag", width: 16, height: 11, viewBox: "0 0 18 12", "aria-label": "India"},
            h("rect", {width: 18, height: 4, fill: "#FF9933"}),
            h("rect", {y: 4, width: 18, height: 4, fill: "#FFFFFF"}),
            h("rect", {y: 8, width: 18, height: 4, fill: "#138808"}),
            h("circle", {cx: 9, cy: 6, r: 1.7, fill: "none", stroke: "#000080", strokeWidth: 0.6})
          )
        )
      )
    );
  }

  getFieldTypeLabel(type) {
    const found = FIELD_TYPES.find(ft => ft.value === type);
    return found ? found.label : type;
  }
}

const urlParams = new URLSearchParams(window.location.search);
let sfHost = urlParams.get("host");
// OAuth return carries ?code=&state= but no ?host=: recover it from state
// so getSession() can exchange the code (it rewrites a clean URL after).
if (!sfHost) {
  try {
    const oauthState = JSON.parse(decodeURIComponent(urlParams.get("state") || "null"));
    if (oauthState && oauthState.sfHost) sfHost = oauthState.sfHost;
  } catch (e) { /* ignore */ }
}

if (!sfHost) {
  document.getElementById("root").innerHTML = "<p style='padding:20px;color:red;'>Error: No Salesforce host specified. Please open this page from the extension popup.</p>";
} else {
  let appStarted = false;
  function initApp() {
    if (appStarted) return;
    appStarted = true;
    // Requests from the sidebar content script (verified parent page only).
    window.addEventListener("message", (e) => {
      if (!isFromTrustedParent(e)) return;
      if (e.data.type === "sfoc-save-state") {
        if (window.__sfocApp) {
          window.__sfocApp._saveState();
          saveInspectorState(sfHost, window.__sfocApp.state);
        }
      }
      if (e.data.type === "sfoc-api-names-state" && window.__sfocApp) {
        window.__sfocApp.setState({apiNamesOn: !!e.data.on});
      }
    });

    ReactDOM.render(
      h(App, {sfHost}),
      document.getElementById("root"),
      function() { window.__sfocApp = this; }
    );
  }

  function showFatal(message) {
    const p = document.createElement("p");
    p.style.cssText = "padding:20px;color:#c23934;font-family:sans-serif;";
    p.textContent = message;
    const root = document.getElementById("root");
    root.textContent = "";
    root.appendChild(p);
  }

  // When framed, the parent must be a Salesforce page of the same org as
  // ?host= (the background resolves the page's session domain the same way
  // the content script did). Any other framing page is refused, so a site
  // cannot embed an authenticated panel for someone else's org.
  async function verifyParent() {
    const parentOrigin = getParentOrigin();
    if (window.parent === window) return true;
    if (!parentOrigin || !isTrustedFrameOrigin(parentOrigin)) return false;
    const parentHost = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({message: "getSfHost", url: parentOrigin + "/"}, res => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
    if (!parentHost || getMyDomain(parentHost) !== getMyDomain(sfHost)) return false;
    setTrustedParentOrigin(parentOrigin);
    return true;
  }

  // Settings (AI config, preferences) load from chrome.storage before render.
  Promise.all([verifyParent(), initSettings()]).then(([ok]) => {
    if (!ok) {
      showFatal("SaralForce can only be opened from a page of the Salesforce org it works with.");
      return;
    }
    // The session always comes from the extension's own cookie lookup (or
    // the OAuth token), never from the host page.
    sfConn.getSession(sfHost).then(initApp, err => {
      console.error("[SaralForce] Session lookup failed:", err);
      initApp();
    });
  });
}
