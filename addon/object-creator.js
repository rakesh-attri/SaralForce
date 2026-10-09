import {sfConn, apiVersion, XML, startSalesforceLogin} from "./inspector.js";
import {hasValidConfig, getSavedConfig, getLLMProvider, getProviderConfig} from "./llm/llm-service.js";
import {SYSTEM_PROMPT, REFINEMENT_PROMPT, USER_MESSAGE_TEMPLATE, ENHANCE_SYSTEM_PROMPT} from "./prompts/system-prompt.js";
import {createSpinForMethod, UserInfoModel, Constants, safeCopyText} from "./utils.js";
import {InspectorPanel, ffApplyRestore, ffTakeSnapshot} from "./inspector-tools.js";

let h = React.createElement;

function openInspectorInNewTab() {
  try { return localStorage.getItem("sfoc_open_inspector_tab") === "true"; } catch (e) { return false; }
}

function escXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 15/18-char Salesforce Id — AppMenu sometimes returns Id in `name`;
// updateMetadata needs a metadata fullName (developer name), never an Id.
function isSfId(value) {
  const v = String(value || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(v) || /^[a-zA-Z0-9]{18}$/.test(v);
}

const FIELD_TYPES = [
  {value: "Text", label: "Text"},
  {value: "TextArea", label: "Text Area"},
  {value: "LongTextArea", label: "Text Area (Long)"},
  {value: "Number", label: "Number"},
  {value: "Currency", label: "Currency"},
  {value: "Percent", label: "Percent"},
  {value: "Date", label: "Date"},
  {value: "DateTime", label: "Date / Time"},
  {value: "Checkbox", label: "Checkbox"},
  {value: "Picklist", label: "Picklist"},
  {value: "MultiselectPicklist", label: "Picklist (Multi-Select)"},
  {value: "Email", label: "Email"},
  {value: "Phone", label: "Phone"},
  {value: "Url", label: "URL"},
  {value: "Lookup", label: "Lookup"},
  {value: "MasterDetail", label: "Master-Detail"}
];

const RELATIONSHIP_OBJECTS = [
  "Account", "Contact", "Opportunity", "Case", "Lead", "Campaign",
  "Product2", "Contract", "Asset", "Activity", "User"
];

// Valid CustomTab motifs: format MUST be "CustomNN: IconName" (bare "CustomNN"
// is rejected). Object tabs allow ONLY customObject + motif (+ optional
// description) — <label> on object tabs causes a deployment error.
const TAB_MOTIFS = [
  "Custom1: Heart", "Custom2: Fan", "Custom3: Sun", "Custom4: Hexagon",
  "Custom5: Leaf", "Custom6: Triangle", "Custom7: Square", "Custom8: Diamond",
  "Custom9: Lightbulb", "Custom10: Cup", "Custom11: Star", "Custom12: Music",
  "Custom13: Phone", "Custom14: Flag", "Custom15: Airplane", "Custom16: Trophy",
  "Custom17: Envelope", "Custom18: Umbrella", "Custom19: Bell", "Custom20: Book",
  "Custom21: Camera", "Custom22: Clock", "Custom23: Cloud", "Custom24: Compass",
  "Custom25: Computer", "Custom26: CreditCard", "Custom27: Desk", "Custom28: Globe",
  "Custom29: Keys", "Custom30: Map", "Custom31: Pencil", "Custom32: People",
  "Custom33: Puzzle", "Custom34: Truck", "Custom35: Wrench", "Custom36: Briefcase",
  "Custom37: Calculator", "Custom38: Car", "Custom39: Telescope", "Custom40: Factory",
  "Custom41: Building", "Custom42: Bank", "Custom43: Bridge", "Custom44: Castle",
  "Custom45: Medal", "Custom46: Computer", "Custom47: Chip", "Custom48: Trophy",
  "Custom49: CD/DVD", "Custom50: Bigtop", "Custom51: Apple", "Custom52: Balls",
  "Custom53: Bell", "Custom54: Boat", "Custom55: Books", "Custom56: Bottle",
  "Custom57: Desert", "Custom58: Caduceus", "Custom59: Can", "Custom60: Umbrella",
  "Custom61: Castle", "Custom62: Chalkboard", "Custom63: Chip", "Custom64: Compass",
  "Custom65: Cup", "Custom66: Dice", "Custom67: Gears", "Custom68: Globe",
  "Custom69: Guitar", "Custom70: Handsaw", "Custom71: Headset", "Custom72: Helicopter",
  "Custom73: HighwaySign", "Custom74: HotAirBalloon", "Custom75: IPPhone",
  "Custom76: Keys", "Custom77: Locked", "Custom78: Map", "Custom79: MeasuringTape",
  "Custom80: Motorcycle", "Custom81: MusicalNote", "Custom82: Whistle",
  "Custom83: Pencil", "Custom84: Presenter", "Custom85: RealEstateSign",
  "Custom86: RedCross", "Custom87: Safe", "Custom88: Sailboat", "Custom89: Saxophone",
  "Custom90: Scales", "Custom91: Shield", "Custom92: Ship", "Custom93: ShoppingCart",
  "Custom94: Stethoscope", "Custom95: Stopwatch", "Custom96: StreetSign",
  "Custom97: Thermometer", "Custom98: Truck", "Custom99: TVCRT",
  "Custom100: TVWidescreen"
];

function pickTabMotif(objectName) {
  let hash = 0;
  for (let i = 0; i < objectName.length; i++) {
    hash = ((hash << 5) - hash + objectName.charCodeAt(i)) | 0;
  }
  return TAB_MOTIFS[Math.abs(hash) % TAB_MOTIFS.length];
}

function isDuplicateError(err) {
  const msg = (err?.message || "") + " " + (err?.detail ? JSON.stringify(err.detail) : "");
  return /DUPLICATE_DEVELOPER_NAME|DUPLICATE_VALUE|already exists|duplicate value|DUPLICATE_CUSTOM_FIELD/i.test(msg);
}

// Soft-deleted fields keep their child-relationship name for ~15 days.
// "There is already a Child Relationship named IT_Asset_Assigned_To on User."
function isRelationshipCollisionError(err) {
  return /already a Child Relationship named/i.test(err?.message || "");
}

function relationshipCollisionName(err) {
  const m = (err?.message || "").match(/already a Child Relationship named\s+(\S+)\s+on\s+(\S+)/i);
  return m ? {name: m[1], parent: m[2].replace(/[.,;]+$/, "")} : null;
}

// CustomApplication child order matters for updateMetadata XSD. `tabs` sits
// after these and before the later ones — used when the app has no tabs yet.
const CUSTOM_APP_AFTER_TABS = new Set([
  "uiType", "workspace", "actionOverrides", "profileActionOverrides",
  "objectTabs", "listViews", "navType", "formFactors", "brand", "brandColor",
  "customTab", "logo", "palette", "platform", "urlTarget", "type",
  "showInAppLauncher", "showInMobileSearch", "showLightningRuntime",
  "ssoAttemptLogin", "headerColor", "dataServiceUrl", "scriptLocs",
  "oAuthCustomScope", "platformActionOverrides", "microsite"
]);

// safeCopyText lives in utils.js (shared with inspector-tools.js).

// Namespace-agnostic DOM helpers for Metadata SOAP responses. Server
// responses mix prefixes (met:/sf:/unprefixed), so match on localName.
function domLocal(el) {
  if (!el) return "";
  return el.localName || String(el.tagName || "").split(":").pop();
}

function domChildren(el) {
  if (!el || !el.childNodes) return [];
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}

function domFind(root, local) {
  if (!root) return null;
  if (domLocal(root) === local) return root;
  const stack = domChildren(root);
  while (stack.length > 0) {
    const el = stack.shift();
    if (domLocal(el) === local) return el;
    stack.unshift(...domChildren(el));
  }
  return null;
}

function domFindAll(root, local, out = []) {
  if (!root) return out;
  if (domLocal(root) === local) out.push(root);
  for (const c of domChildren(root)) domFindAll(c, local, out);
  return out;
}

function domMakeEl(doc, tag, text) {
  const el = doc.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// Layout metadata requires every layoutItems to carry a customLink child
// (valued or xsi:nil). Some readMetadata responses omit it on untouched
// rows; updateMetadata validates the whole layout, so one bare row fails
// the entire write with "Required field is missing: customLink".
function ensureLayoutCustomLinks(root) {
  const XSI = "http://www.w3.org/2001/XMLSchema-instance";
  for (const li of domFindAll(root, "layoutItems")) {
    let has = false;
    const fieldEl = domFind(li, "field");
    const hasField = !!(fieldEl && fieldEl.textContent);
    for (const c of domChildren(li)) {
      if (domLocal(c) === "customLink") {
        has = true;
        // Field rows: customLink must be nil. Link rows (no field): keep value.
        if (hasField) {
          c.textContent = "";
          c.setAttributeNS(XSI, "xsi:nil", "true");
        }
      }
    }
    if (!has) {
      const cl = li.ownerDocument.createElement("customLink");
      cl.setAttributeNS(XSI, "xsi:nil", "true");
      const fieldNode = domFind(li, "field");
      const beh = domFind(li, "behavior");
      if (fieldNode) li.insertBefore(cl, fieldNode);
      else if (beh) li.insertBefore(cl, beh.nextSibling);
      else li.appendChild(cl);
    }
  }
}

// Drop empty layoutColumns (updateMetadata rejects / mis-validates them).
function removeEmptyLayoutColumns(root) {
  for (const sec of domFindAll(root, "layoutSections")) {
    for (const col of domChildren(sec)) {
      if (domLocal(col) !== "layoutColumns") continue;
      if (domChildren(col).length === 0) sec.removeChild(col);
    }
  }
}

// A CustomLinks section must only hold link items. Prior runs appended
// field rows into the trailing CustomLinks column — that combination fails
// updateMetadata with "Required field is missing: customLink". Rewrite the
// style so field rows validate as a normal detail section.
function fixCustomLinksWithFields(root) {
  for (const sec of domFindAll(root, "layoutSections")) {
    const styleEl = domFind(sec, "style");
    if (!styleEl || styleEl.textContent !== "CustomLinks") continue;
    const fieldItems = domFindAll(sec, "layoutItems").filter(li => {
      const f = domFind(li, "field");
      return f && f.textContent;
    });
    if (fieldItems.length > 0) {
      styleEl.textContent = "TwoColumnsTopToBottom";
      // Ensure section has a label (some CustomLinks sections omit it).
      if (!domFind(sec, "label")) {
        const label = sec.ownerDocument.createElement("label");
        label.textContent = "Fields";
        const heading = domFind(sec, "editHeading") || domFind(sec, "detailHeading");
        if (heading && heading.nextSibling) sec.insertBefore(label, heading.nextSibling);
        else sec.insertBefore(label, sec.firstChild);
      }
    }
  }
}

// Pick a column in a section that actually holds field items — never a
// pure CustomLinks section (field rows there fail customLink validation).
function pickLayoutFieldColumn(records) {
  const sections = domFindAll(records, "layoutSections");
  let fallback = null;
  for (const sec of sections) {
    const styleEl = domFind(sec, "style");
    const style = styleEl ? styleEl.textContent : "";
    const cols = domChildren(sec).filter(n => domLocal(n) === "layoutColumns");
    if (!cols.length) continue;
    const hasFieldItem = cols.some(col =>
      domFindAll(col, "layoutItems").some(li => {
        const f = domFind(li, "field");
        return f && f.textContent;
      }));
    if (style === "CustomLinks" && !hasFieldItem) continue;
    if (hasFieldItem) {
      for (let i = cols.length - 1; i >= 0; i--) {
        if (domChildren(cols[i]).length > 0) return cols[i];
      }
      return cols[cols.length - 1];
    }
    if (!fallback) fallback = cols[cols.length - 1];
  }
  if (fallback) return fallback;
  const all = domFindAll(records, "layoutColumns").filter(c => domChildren(c).length > 0);
  return all.length ? all[all.length - 1] : null;
}

// Metadata API relationshipName is the child-relationship developer name on
// the PARENT (relatedTo) object — it must be unique across that parent.
// "Assigned_To" already exists on User for many orgs → always prefix the
// child object name: IT_Asset__c.Assigned_To__c → IT_Asset_Assigned_To.
function safeRelationshipName(fieldDef, objectName) {
  const sanitize = s => String(s || "")
    .replace(/__(?:c|r)$/i, "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  let rel = sanitize(fieldDef.relationshipName);
  if (!rel || !/^[A-Za-z]/.test(rel)) {
    rel = sanitize(fieldDef.name);
  }
  if (!rel) rel = "Rel";
  const objBase = sanitize(objectName);
  if (objBase) {
    const lower = rel.toLowerCase();
    const objLower = objBase.toLowerCase();
    if (lower !== objLower && !lower.startsWith(objLower + "_")) {
      rel = objBase + "_" + rel;
    }
  }
  // relationshipName max length is 40 in Metadata API.
  if (rel.length > 40) {
    if (objBase && objBase.length < 30) {
      const tailLen = Math.max(8, 40 - objBase.length - 1);
      rel = objBase + "_" + rel.slice(-tailLen);
      rel = rel.replace(/_+$/g, "").replace(/^_+/g, "");
      if (rel.length > 40) rel = rel.slice(0, 40).replace(/_+$/g, "");
    } else {
      rel = rel.slice(0, 40).replace(/_+$/g, "");
    }
  }
  if (!rel || !/^[A-Za-z]/.test(rel)) rel = "Rel" + rel.replace(/[^A-Za-z0-9]/g, "");
  if (!rel) rel = "RelField";
  return rel;
}

// Serialize a response DOM element to met:-prefixed Metadata XML. Operates
// on the raw readMetadata records so a full round-trip preserves every
// field byte-for-byte (no wipe risk on Profile/Layout updates).
function domToMetXml(el) {
  const tag = domLocal(el);
  let attrs = "";
  if (el.attributes) {
    for (const a of Array.from(el.attributes)) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      attrs += ` ${a.name}="${escXml(a.value)}"`;
    }
  }
  const kids = domChildren(el);
  let text = "";
  for (const n of Array.from(el.childNodes || [])) {
    if (n.nodeType === 3 || n.nodeType === 4) text += n.data;
  }
  if (kids.length > 0) {
    if (text.trim() === "") text = "";
    else text = escXml(text);
    return `<met:${tag}${attrs}>${text}${kids.map(domToMetXml).join("")}</met:${tag}>`;
  }
  if (text === "") return `<met:${tag}${attrs}/>`;
  return `<met:${tag}${attrs}>${escXml(text)}</met:${tag}>`;
}

function parseJSONFromText(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function validateProposal(proposal) {
  const errors = [];
  if (!proposal.object) {
    errors.push("Missing 'object' definition");
  } else {
    if (!proposal.object.label) errors.push("Object missing 'label'");
    if (!proposal.object.name) errors.push("Object missing 'name'");
    if (!proposal.object.name?.endsWith("__c")) errors.push("Object API name must end with __c");
  }
  if (proposal.recordTypes !== undefined) {
    if (!Array.isArray(proposal.recordTypes)) {
      errors.push("'recordTypes' must be an array");
    } else {
      proposal.recordTypes.forEach((rt, i) => {
        if (!rt.label) errors.push(`Record type ${i + 1} missing 'label'`);
        if (!rt.name) errors.push(`Record type ${i + 1} missing 'name'`);
        else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(rt.name)) {
          errors.push(`Record type ${i + 1} name must be a DeveloperName (letters, numbers, underscores, no __c): ${rt.name}`);
        } else if (rt.name.endsWith("__c")) {
          errors.push(`Record type ${i + 1} name must NOT end with __c (${rt.name})`);
        }
        if (!rt.description) errors.push(`Record type ${i + 1} missing 'description'`);
      });
    }
  }
  if (!proposal.fields || !Array.isArray(proposal.fields) || proposal.fields.length === 0) {
    errors.push("Missing or empty 'fields' array");
  } else {
    proposal.fields.forEach((f, i) => {
      if (!f.label) errors.push(`Field ${i + 1} missing 'label'`);
      if (!f.name) errors.push(`Field ${i + 1} missing 'name'`);
      if (!f.name?.endsWith("__c")) errors.push(`Field ${i + 1} API name must end with __c (${f.name})`);
      if (f.name?.endsWith("__r")) errors.push(`Field ${i + 1} API name must not end with __r — use __c for the field (${f.name})`);
      if (!f.type) errors.push(`Field ${i + 1} missing 'type'`);
      if ((f.type === "Picklist" || f.type === "MultiselectPicklist")) {
        const vals = Array.isArray(f.values) ? f.values.filter(v => String(v == null ? "" : v).trim()) : [];
        if (vals.length < 1) {
          errors.push(`Field ${i + 1} (${f.name}) ${f.type} requires a non-empty 'values' array`);
        }
        if (f.defaultValue != null && String(f.defaultValue).trim() &&
            !vals.some(v => String(v).trim().toLowerCase() === String(f.defaultValue).trim().toLowerCase())) {
          errors.push(`Field ${i + 1} (${f.name}) defaultValue "${f.defaultValue}" is not in values`);
        }
      }
      if ((f.type === "Lookup" || f.type === "MasterDetail") && !f.relatedTo) {
        errors.push(`Field ${i + 1} (${f.name}) ${f.type} requires 'relatedTo'`);
      }
    });
  }
  return errors;
}

const CHAT_HISTORY_KEY = "sfoc_chat_history";

function loadChatHistory(sfHost) {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY + "_" + sfHost);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveChatHistory(sfHost, chats) {
  try {
    localStorage.setItem(CHAT_HISTORY_KEY + "_" + sfHost, JSON.stringify(chats));
  } catch (e) { /* quota exceeded, ignore */ }
}

function loadPersistedState(sfHost) {
  try {
    const raw = sessionStorage.getItem(sfHost + "_sidebar_state");
    if (raw) {
      sessionStorage.removeItem(sfHost + "_sidebar_state");
      return JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function persistState(sfHost, state) {
  try {
    const toSave = {
      messages: state.messages,
      currentProposal: state.currentProposal,
      deploymentStatus: state.deploymentStatus,
      deploymentStep: state.deploymentStep,
      deploymentProgress: state.deploymentProgress,
      deploymentResults: state.deploymentResults,
      selectedFields: state.selectedFields,
      visibilityMode: state.visibilityMode,
      selectedProfiles: state.selectedProfiles,
      availableProfiles: state.availableProfiles,
      selectedApp: state.selectedApp && !isSfId(state.selectedApp) ? state.selectedApp : null,
      availableApps: (state.availableApps || []).filter(a =>
        a && a.developerName && !isSfId(a.developerName)),
      recordTypesDone: state.recordTypesDone,
      builderMode: state.builderMode || "plan"
    };
    sessionStorage.setItem(sfHost + "_sidebar_state", JSON.stringify(toSave));
  } catch (e) { /* ignore */ }
}

// Inspector page + loaded data, saved only when the sidebar minimizes so a
// refresh of the host page resets it (key is consumed on read). Parsed once
// per document — initApp can construct App twice (session fallback race), and
// the second construction must see the same snapshot.
let _inspectorStateCache;
function loadInspectorState(sfHost) {
  if (_inspectorStateCache !== undefined) return _inspectorStateCache;
  _inspectorStateCache = null;
  try {
    const raw = sessionStorage.getItem(sfHost + "_inspector_state");
    if (raw) {
      sessionStorage.removeItem(sfHost + "_inspector_state");
      _inspectorStateCache = JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return _inspectorStateCache;
}

function saveInspectorState(sfHost, state) {
  const payload = {uiMode: state.uiMode || "builder", ff: null};
  try { payload.ff = ffTakeSnapshot(); } catch (e) { /* ignore */ }
  // Quota: retry without the snapshot rather than lose the current page too.
  const attempts = [payload, {...payload, ff: null}];
  for (const attempt of attempts) {
    try {
      sessionStorage.setItem(sfHost + "_inspector_state", JSON.stringify(attempt));
      return;
    } catch (e) { /* try next */ }
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    const saved = loadPersistedState(props.sfHost);
    const inspectorSaved = loadInspectorState(props.sfHost);
    ffApplyRestore(inspectorSaved && inspectorSaved.ff);
    this.state = {
      llmConfig: getSavedConfig(),
      uiMode: urlParams.get("view") === "inspector" ? "inspector" : (inspectorSaved?.uiMode || "builder"),
      messages: saved?.messages || [],
      currentProposal: saved?.currentProposal || null,
      isGenerating: false,
      streamingText: "",
      isEnhancing: false,
      enhancedPreview: null,
      lastFailedPrompt: null,
      deploymentStatus: saved?.deploymentStatus === "deploying" ? "complete" : (saved?.deploymentStatus || null),
      deploymentStep: saved?.deploymentStatus === "deploying" ? "Deployment complete!" : (saved?.deploymentStep || null),
      deploymentProgress: saved?.deploymentProgress || 0,
      deploymentResults: saved?.deploymentResults || [],
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
      availableApps: (saved?.availableApps || []).filter(a =>
        a && a.developerName && !isSfId(a.developerName)),
      appsLoading: false,
      selectedApp: saved?.selectedApp && !isSfId(saved.selectedApp) ? saved.selectedApp : null,
      appAssigned: false,
      appLoadError: null,
      _appsTried: false,
      builderMode: saved?.builderMode || "plan",
      colorTheme: (typeof localStorage !== "undefined" && localStorage.getItem("sfoc_theme")) || "dark",
      apiNamesOn: false
    };
    this._appsLoading = false;
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

  applyColorTheme(theme) {
    const t = theme || this.state.colorTheme || "dark";
    try {
      const root = document.documentElement;
      root.classList.toggle("dark", t === "dark");
      if (t === "dark") root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
      if (typeof localStorage !== "undefined") localStorage.setItem("sfoc_theme", t);
    } catch (e) { /* ignore */ }
  }

  toggleColorTheme() {
    const next = (this.state.colorTheme || "dark") === "dark" ? "light" : "dark";
    this.setState({colorTheme: next}, () => this.applyColorTheme(next));
  }

  closePanel() {
    try { window.parent.postMessage({type: "sfoc-close-sidebar"}, "*"); } catch (e) { /* not embedded */ }
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({message: "closeSidebar"});
      }
    } catch (e) { /* ignore */ }
  }

  toggleApiNames() {
    try { window.parent.postMessage({type: "sfoc-show-api-names"}, "*"); } catch (e) { /* not embedded */ }
    this.setState(prev => ({apiNamesOn: !prev.apiNamesOn}));
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
      try { proposal = parseJSONFromText(msg.text); } catch (e) { proposal = null; }
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
    this.applyColorTheme(this.state.colorTheme || "dark");
    try { window.parent.postMessage({type: "sfoc-query-api-names"}, "*"); } catch (e) { /* not embedded */ }
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
    window.removeEventListener("storage", this._onStorage);
    saveInspectorState(this.props.sfHost, this.state);
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
      try { window.parent.postMessage({type: "sfoc-user-card", info}, "*"); } catch (e) { /* not embedded */ }
    } catch (e) {
      this._userCardSent = false;
    }
  }

  componentDidUpdate(prevProps, prevState) {
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
    // NOTE: app assignment lives in Inspector → App Tabs now; the builder no
    // longer loads apps or auto-assigns.
    if (this.state.currentProposal && prevState.currentProposal !== this.state.currentProposal) {
      this.loadProfiles().catch(e => console.warn("[SaralForce] proposal loadProfiles:", e.message));
    }
  }

  _tabWasCreated(results) {
    return (results || []).some(r => r.type === "tab" && r.status === "success");
  }

  _autoSaveChat() {
    const {messages, currentProposal, deploymentResults, deploymentStatus, activeChatId, selectedFields,
      visibilityMode, selectedProfiles, selectedApp, builderMode} = this.state;
    if (messages.length <= 1) return;
    const chatHistory = [...this.state.chatHistory];
    const chatEntry = {
      id: activeChatId || Date.now().toString(),
      timestamp: Date.now(),
      messages,
      currentProposal,
      deploymentResults,
      deploymentStatus,
      selectedFields,
      visibilityMode,
      selectedProfiles,
      builderMode: builderMode || "plan",
      selectedApp: selectedApp && !isSfId(selectedApp) ? selectedApp : null
    };
    const existingIdx = chatHistory.findIndex(c => c.id === chatEntry.id);
    if (existingIdx >= 0) {
      chatHistory[existingIdx] = chatEntry;
    } else {
      chatHistory.unshift(chatEntry);
    }
    // Keep last 20 chats
    const trimmed = chatHistory.slice(0, 20);
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
      selectedFields: null,
      error: null,
      activeChatId: null,
      visibilityMode: "all",
      selectedProfiles: [],
      recordTypesDone: false,
      availableApps: [],
      appsLoading: false,
      selectedApp: null,
      appAssigned: false,
      appLoadError: null,
      _appsTried: false,
      builderMode: "plan",
      isEnhancing: false,
      enhancedPreview: null
    }, () => {
      this._appsLoading = false;
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
    try { window.parent.postMessage({type: "sfoc-show-user-card"}, "*"); } catch (e) { /* not embedded */ }
  }

  openInspector() {
    if (openInspectorInNewTab()) {
      try {
        chrome.runtime.sendMessage({message: "openInspectorTab", host: this.props.sfHost || ""});
      } catch (e) {
        this.setState({uiMode: "inspector"});
      }
      return;
    }
    this.setState({uiMode: "inspector"});
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
    // Never restore a mid-deploy flag — the previous run is gone.
    const st = chat.deploymentStatus === "deploying" ? "complete" : (chat.deploymentStatus || null);
    this.setState({
      messages: chat.messages || [],
      currentProposal: chat.currentProposal || null,
      deploymentStatus: st,
      deploymentStep: st === "complete" ? (chat.deploymentStep || "Deployment complete!") : (chat.deploymentStep || null),
      deploymentProgress: chat.deploymentProgress || 0,
      deploymentResults: chat.deploymentResults || [],
      selectedFields: chat.selectedFields || (chat.currentProposal?.fields || []).map(f => f.name),
      visibilityMode: chat.visibilityMode || "all",
      selectedProfiles: chat.selectedProfiles || [],
      recordTypesDone: false,
      availableApps: [],
      appsLoading: false,
      selectedApp: chat.selectedApp && !isSfId(chat.selectedApp) ? chat.selectedApp : null,
      appAssigned: false,
      appLoadError: null,
      _appsTried: false,
      builderMode: chat.builderMode || "plan",
      error: null,
      activeChatId: chat.id
    }, () => {
      this._appsLoading = false;
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
    const {currentProposal, messages} = this.state;
    const userInput = promptOverride != null ? String(promptOverride) : this.state.userInput;
    const echo = !opts || opts.echo !== false;
    if (!userInput.trim() || this.state.isGenerating) return;

    const config = getSavedConfig();
    if (!config || !hasValidConfig()) {
      this.setState({error: "Please configure your LLM provider in Options first."});
      return;
    }

    if (echo) this.addUserMessage(userInput);
    this.setState({userInput: "", isGenerating: true, error: null, streamingText: "", enhancedPreview: null, lastFailedPrompt: null});

    try {
      const provider = getLLMProvider(config.provider);

      const apiMessages = [
        {role: "system", content: currentProposal ? REFINEMENT_PROMPT : SYSTEM_PROMPT},
        ...this.buildConversationHistory(),
        {role: "user", content: USER_MESSAGE_TEMPLATE(userInput, currentProposal)}
      ];

      const onChunk = (text) => {
        this.setState({streamingText: text});
      };

      let response;
      if (config.provider === "openai_compatible") {
        response = await provider.sendMessage(apiMessages, config.apiKey, config.model, onChunk, config.baseUrl);
      } else {
        response = await provider.sendMessage(apiMessages, config.apiKey, config.model, onChunk);
      }

      this.setState({streamingText: ""});

      const proposal = parseJSONFromText(response);
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
            // (App assignment lives in Inspector → App Tabs now.)
            this.loadProfiles().catch(() => {});
          });
        }
      } else {
        this.addAssistantMessage(response, null);
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

    const config = getSavedConfig();
    if (!config || !hasValidConfig()) {
      this.setState({error: "Please configure your LLM provider in Options first."});
      return;
    }

    this.setState({isEnhancing: true, enhancedPreview: null, error: null});
    try {
      const provider = getLLMProvider(config.provider);
      const proposalCtx = this.state.currentProposal
        ? `\nCurrent object draft for context (do not redesign it, only improve the request below): label="${this.state.currentProposal.object?.label || ""}", fields=[${(this.state.currentProposal.fields || []).map(f => f.label || f.name).join(", ")}]`
        : "";
      const apiMessages = [
        {role: "system", content: ENHANCE_SYSTEM_PROMPT},
        {role: "user", content: `Draft request to improve:${proposalCtx}\n\n"${draft}"`}
      ];

      let response;
      if (config.provider === "openai_compatible") {
        response = await provider.sendMessage(apiMessages, config.apiKey, config.model, null, config.baseUrl);
      } else {
        response = await provider.sendMessage(apiMessages, config.apiKey, config.model, null);
      }

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

  async deployObject() {
    const {currentProposal, selectedFields} = this.state;
    if (!currentProposal) return;

    const fieldsToDeploy = selectedFields
      ? currentProposal.fields.filter(f => selectedFields.includes(f.name))
      : currentProposal.fields;

    if (fieldsToDeploy.length === 0) {
      this.setState({error: "No fields selected for deployment. Please select at least one field."});
      return;
    }

    this._deployAborted = false;
    this._abortController = new AbortController();
    this._profileMetadataNames = null;

    this.setState({
      deploymentStatus: "deploying",
      deploymentStep: "Creating object...",
      deploymentProgress: 0,
      deploymentResults: [],
      error: null
    });

    const recordTypesToDeployCount = 0; // record types are a separate, later step
    const totalSteps = fieldsToDeploy.length + 6;
    let completedSteps = 0;

    try {
      console.log("[SaralForce] Starting deployment. Object:", currentProposal.object.name, "Fields:", fieldsToDeploy.length);
      const createdFields = [];

      this.setState({deploymentStep: `Creating object "${currentProposal.object.label}"...`});
      console.log("[SaralForce] Step 1: Creating object...");
      // Fail fast if the object already exists (EntityDefinition query).
      try {
        const baseName = currentProposal.object.name.replace(/__c$/, "");
        const dupCheck = await sfConn.rest(
          `/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT DeveloperName FROM EntityDefinition WHERE DeveloperName = '${baseName}' LIMIT 1`));
        if (dupCheck.records && dupCheck.records.length > 0) {
          throw new Error(
            `Object ${currentProposal.object.name} already exists. ` +
            `Suggested rename: ${baseName}_2__c. ` +
            `Click "Retry with new name" below or describe a different name in chat.`);
        }
      } catch (preErr) {
        if (/already exists|Suggested rename/i.test(preErr.message)) throw preErr;
        console.warn("[SaralForce] Duplicate pre-check skipped:", preErr.message);
      }
      let objectResult;
      try {
        objectResult = await this.metaSoapRequest("create", this.buildObjectXml(currentProposal.object));
      } catch (objErr) {
        if (isDuplicateError(objErr)) {
          const baseName = currentProposal.object.name.replace(/__c$/, "");
          throw new Error(
            `${objErr.message}. Object already exists — suggested rename: ${baseName}_2__c. ` +
            `Click "Retry with new name" below or describe a different name in chat.`);
        }
        throw objErr;
      }
      console.log("[SaralForce] Object create response:", objectResult);
      completedSteps++;

      if (objectResult.id && (objectResult.done === "false" || objectResult.state === "InProgress")) {
        console.log("[SaralForce] Object creation is async, polling status with id:", objectResult.id);
        this.setState({deploymentStep: `Creating object "${currentProposal.object.label}" (async)...`});
        await this.pollDeployStatus(objectResult.id);
        console.log("[SaralForce] Object creation confirmed complete");
      }

      this.setState(prev => ({
        deploymentResults: [...prev.deploymentResults, {
          type: "object",
          name: currentProposal.object.name,
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

      for (let i = 0; i < fieldsToDeploy.length; i++) {
        if (this._deployAborted) throw new Error("Deployment cancelled");

        const field = fieldsToDeploy[i];
        const fieldNum = i + 1;
        this.setState({deploymentStep: `Creating field ${fieldNum}/${fieldsToDeploy.length}: "${field.label}"...`});
        console.log(`[SaralForce] Step 3.${fieldNum}: Creating field "${field.label}" (${field.type})...`);

        let fieldCreated = false;
        let lastError = null;
        let relCollisionRetries = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (this._deployAborted) throw new Error("Deployment cancelled");
          try {
            const fieldXml = this.buildFieldXml(currentProposal.object.name, field);
            console.log(`[SaralForce]   Field SOAP XML (attempt ${attempt + 1}):`, fieldXml.substring(0, 200) + "...");
            const fieldResult = await this.metaSoapRequest("create", fieldXml);
            if (fieldResult.id && (fieldResult.done === "false" || fieldResult.state === "InProgress")) {
              console.log(`[SaralForce]   Field "${field.label}" async, polling...`, fieldResult.id);
              await this.pollDeployStatus(fieldResult.id);
            }
            fieldCreated = true;
            console.log(`[SaralForce]   Field "${field.label}" created successfully`);
            break;
          } catch (fieldErr) {
            lastError = fieldErr;
            console.error(`[SaralForce]   Field "${field.label}" attempt ${attempt + 1} failed:`, fieldErr.message);
            // Soft-deleted relationship keeps the name — retry with a unique suffix.
            if (isRelationshipCollisionError(fieldErr) && relCollisionRetries < 3) {
              relCollisionRetries++;
              const coll = relationshipCollisionName(fieldErr);
              const base = coll && coll.name
                ? coll.name
                : safeRelationshipName(field, currentProposal.object.name);
              const next = `${base.replace(/_+\d+$/, "")}_${1 + relCollisionRetries}`;
              console.warn(`[SaralForce]   Relationship collision on ${coll?.parent || "?"} — retrying as "${next}"`);
              field.relationshipName = next;
              await this.delay(500);
              attempt--; // collision retry does not consume the normal attempt budget
              continue;
            }
            // Field already present from a prior run — treat as success.
            if (isDuplicateError(fieldErr) && /field|CustomField/i.test(fieldErr.message || "")) {
              console.warn(`[SaralForce]   Field "${field.label}" already exists — treating as success`);
              fieldCreated = true;
              break;
            }
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
              encodeURIComponent(`SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.DeveloperName = '${currentProposal.object.name.replace(/__c$/, "")}'`));
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
      const tabResult = await this.createTab(currentProposal.object.name, currentProposal.object.label);
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
          deploymentStatus: "complete",
          deploymentStep: "Deployment failed",
          error: `Deployment failed: ${err.message}`
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

  async metaSoapRequest(action, metadataXml) {
    const url = "https://" + sfConn.instanceHostname + "/services/Soap/m/" + apiVersion;
    console.log("[SaralForce] SOAP request to:", url, "Action:", action);

    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <met:SessionHeader>
      <met:sessionId>${sfConn.sessionId}</met:sessionId>
    </met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:${action}>
      ${metadataXml}
    </met:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log("[SaralForce] SOAP envelope length:", envelope.length);

    // Per-request AbortController: timeout must NOT abort the shared deploy
    // controller (that permanently kills every later SOAP call). Listen to
    // the shared cancel signal instead so "Cancel" still works.
    const local = new AbortController();
    let onSharedAbort = null;
    if (this._abortController) {
      if (this._abortController.signal.aborted) local.abort();
      else {
        onSharedAbort = () => local.abort();
        this._abortController.signal.addEventListener("abort", onSharedAbort, {once: true});
      }
    }
    const timeoutId = setTimeout(() => local.abort(), 60000);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          "SOAPAction": '""'
        },
        body: envelope,
        signal: local.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        if (this._deployAborted) throw new Error("Deployment cancelled");
        this.noteSoapDebug(action, metadataXml, "TIMED OUT after 60s (no response body)");
        throw new Error(`Request timed out after 60s (${action})`);
      }
      throw new Error("Network error: " + fetchErr.message);
    } finally {
      clearTimeout(timeoutId);
      if (onSharedAbort && this._abortController) {
        this._abortController.signal.removeEventListener("abort", onSharedAbort);
      }
    }

    console.log("[SaralForce] SOAP response status:", response.status);

    const responseText = await response.text();
    console.log("[SaralForce] SOAP response (first 500 chars):", responseText.substring(0, 500));

    if (response.status !== 200) {
      const faultMatch = responseText.match(/<faultstring[^>]*>([^<]*)<\/faultstring>/);
      const faultMsg = faultMatch ? faultMatch[1] : "HTTP " + response.status;
      this.noteSoapDebug(action, metadataXml, responseText);
      throw new Error(faultMsg);
    }

    // Parse as XML DOM to handle namespace prefixes like met:id, met:done etc.
    const parser = new DOMParser();
    const doc = parser.parseFromString(responseText, "text/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      console.error("[SaralForce] XML parse error:", parseError.textContent);
      this.noteSoapDebug(action, metadataXml, responseText);
      throw new Error("Failed to parse Metadata API response XML");
    }

    if (action === "checkDeployStatus") {
      const doneEl = doc.querySelector("done");
      const successEl = doc.querySelector("success");
      const errorMessageEl = doc.querySelector("errorMessage");
      const problemEl = doc.querySelector("problem");
      const done = doneEl ? doneEl.textContent : "true";
      const status = successEl ? (successEl.textContent === "true" ? "Succeeded" : "Failed") : "Failed";
      const errorMsg = errorMessageEl ? errorMessageEl.textContent : (problemEl ? problemEl.textContent : null);
      return {done, status, errorMessage: errorMsg};
    }

    // For create/createResponse - find the result element
    const resultEl = doc.querySelector("result");
    if (resultEl) {
      const idEl = resultEl.querySelector("id");
      const doneEl = resultEl.querySelector("done");
      const stateEl = resultEl.querySelector("state");
      const successEl = resultEl.querySelector("success");
      const errorsEl = resultEl.querySelector("errors");
      const messageEl = resultEl.querySelector("message");
      const statusCodeEl = resultEl.querySelector("statusCode");

      const id = idEl ? idEl.textContent : null;
      const done = doneEl ? doneEl.textContent : "true";
      const state = stateEl ? stateEl.textContent : "Completed";
      const success = successEl ? successEl.textContent : "true";
      const message = messageEl ? messageEl.textContent : null;
      const statusCode = statusCodeEl ? statusCodeEl.textContent : null;

      console.log("[SaralForce] Parsed result:", {id, done, state, success, message, statusCode});

      if (success === "false" && errorsEl) {
        const msgEl = errorsEl.querySelector("message");
        const errMsg = msgEl ? msgEl.textContent : "Metadata API returned error";
        this.noteSoapDebug(action, metadataXml, responseText);
        throw new Error(errMsg);
      }

      return {id, done, state, success, message, statusCode};
    }

    // Check for SOAP fault
    const faultEl = doc.querySelector("faultstring");
    if (faultEl) {
      this.noteSoapDebug(action, metadataXml, responseText);
      throw new Error(faultEl.textContent);
    }

    this.noteSoapDebug(action, metadataXml, responseText);
    throw new Error("Could not parse Metadata API response: " + responseText.substring(0, 300));
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

  // Raw SOAP POST returning a parsed DOM. Used for readMetadata (whose
  // records response doesn't fit metaSoapRequest's create-style parser).
  async soapPostDom(bodyInnerXml) {
    const url = "https://" + sfConn.instanceHostname + "/services/Soap/m/" + apiVersion;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <met:SessionHeader>
      <met:sessionId>${sfConn.sessionId}</met:sessionId>
    </met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    ${bodyInnerXml}
  </soapenv:Body>
</soapenv:Envelope>`;
    // Same per-request abort pattern as metaSoapRequest (see above).
    const local = new AbortController();
    let onSharedAbort = null;
    if (this._abortController) {
      if (this._abortController.signal.aborted) local.abort();
      else {
        onSharedAbort = () => local.abort();
        this._abortController.signal.addEventListener("abort", onSharedAbort, {once: true});
      }
    }
    const timeoutId = setTimeout(() => local.abort(), 60000);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "text/xml", "SOAPAction": '""'},
        body: envelope,
        signal: local.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        if (this._deployAborted) throw new Error("Deployment cancelled");
        this.noteSoapDebug("soapPostDom", bodyInnerXml, "TIMED OUT after 60s (no response body)");
        throw new Error("Request timed out after 60s (soapPostDom)");
      }
      throw new Error("Network error: " + fetchErr.message);
    } finally {
      clearTimeout(timeoutId);
      if (onSharedAbort && this._abortController) {
        this._abortController.signal.removeEventListener("abort", onSharedAbort);
      }
    }
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) {
      this.noteSoapDebug("raw", bodyInnerXml, text);
      throw new Error("Failed to parse Metadata API response XML");
    }
    const fault = domFind(doc.documentElement, "Fault");
    if (fault) {
      const fs = domFind(fault, "faultstring");
      const msg = fs ? fs.textContent : "Metadata API SOAP fault";
      this.noteSoapDebug("raw", bodyInnerXml, text);
      throw new Error(msg);
    }
    return doc;
  }

  // Read one metadata component, returning its <records> DOM element (or
  // null when the fullName doesn't exist). Namespace-agnostic.
  async metadataReadRecords(type, fullName) {
    const body = `<met:readMetadata><met:type>${escXml(type)}</met:type>` +
      `<met:fullNames>${escXml(fullName)}</met:fullNames></met:readMetadata>`;
    const doc = await this.soapPostDom(body);
    return domFind(doc.documentElement, "records") || null;
  }

  // Write back a records element previously obtained via metadataReadRecords
  // (optionally mutated) using the SYNC updateMetadata call, which supports
  // every metadata type (unlike async update()). Full round-trip: nothing
  // outside the mutation is lost, so Profile/Layout updates can't wipe data.
  async metadataUpdateRecords(xsiType, fullName, recordsEl) {
    // CustomApplication (and others) must use metadata fullName, never a record Id.
    if (isSfId(fullName)) {
      throw new Error(
        `Refusing updateMetadata: fullName "${fullName}" is a Salesforce Id, not a metadata name`
      );
    }
    const parts = [];
    for (const child of domChildren(recordsEl)) {
      if (domLocal(child) === "fullName") continue;
      parts.push(domToMetXml(child));
    }
    const xml = `<met:metadata xsi:type="met:${xsiType}">` +
      `<met:fullName>${escXml(fullName)}</met:fullName>${parts.join("")}</met:metadata>`;
    const result = await this.metaSoapRequest("updateMetadata", xml);
    // updateMetadata can run async — poll or the caller verifies too early.
    if (result && result.id && (result.done === "false" || result.state === "InProgress")) {
      console.log(`[SaralForce] updateMetadata(${xsiType}) async, polling ${result.id}...`);
      await this.pollDeployStatus(result.id);
    }
    return result;
  }

  async pollDeployStatus(deployId, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      if (this._deployAborted) throw new Error("Deployment cancelled");
      await this.delay(3000);
      console.log(`[SaralForce] Polling create status (${i + 1}/${maxAttempts})...`);

      const checkXml = `<met:id>${deployId}</met:id>`;

      let result;
      try {
        result = await this.metaSoapRequest("checkStatus", checkXml);
      } catch (netErr) {
        console.warn("[SaralForce] Poll network error:", netErr.message);
        if (i === maxAttempts - 1) throw netErr;
        continue;
      }

      console.log("[SaralForce] Create status:", result);

      if (result.state === "Failed" || result.state === "Error") {
        throw new Error(result.message || result.errorMessage || "Metadata creation failed");
      }
      if (result.done === "true" || result.state === "Completed") {
        console.log("[SaralForce] Create completed successfully");
        return;
      }
    }
    throw new Error("Deployment timed out waiting for completion");
  }

  buildObjectXml(objectDef) {
    const nameFieldType = objectDef.nameFieldType || "Text";
    const nameFieldLabel = objectDef.nameFieldLabel || objectDef.label + " Name";
    const displayFormat = objectDef.displayFormat || "{0}";

    const nameFieldXml = nameFieldType === "AutoNumber"
      ? `<met:nameField><met:label>${escXml(nameFieldLabel)}</met:label><met:type>AutoNumber</met:type><met:displayFormat>${escXml(displayFormat)}</met:displayFormat></met:nameField>`
      : `<met:nameField><met:label>${escXml(nameFieldLabel)}</met:label><met:type>Text</met:type></met:nameField>`;

    const parts = [
      `<met:metadata xsi:type="met:CustomObject">`,
      `  <met:fullName>${escXml(objectDef.name)}</met:fullName>`,
      `  <met:label>${escXml(objectDef.label)}</met:label>`,
      `  <met:pluralLabel>${escXml(objectDef.pluralLabel || objectDef.label + "s")}</met:pluralLabel>`,
      `  <met:deploymentStatus>Deployed</met:deploymentStatus>`,
      `  <met:sharingModel>${escXml(objectDef.sharingModel || "ReadWrite")}</met:sharingModel>`,
    ];
    if (objectDef.description) {
      parts.push(`  <met:description>${escXml(objectDef.description)}</met:description>`);
    }
    parts.push(`  ${nameFieldXml}`);
    parts.push(`</met:metadata>`);

    console.log("[SaralForce] Object XML:", parts.join("\n"));
    return parts.join("\n");
  }

  buildFieldXml(objectName, fieldDef) {
    const fullName = `${objectName}.${fieldDef.name}`;
    const parts = [
      `<met:metadata xsi:type="met:CustomField">`,
      `  <met:fullName>${escXml(fullName)}</met:fullName>`,
      `  <met:label>${escXml(fieldDef.label)}</met:label>`,
      `  <met:type>${fieldDef.type}</met:type>`,
    ];

    if (fieldDef.description) {
      parts.push(`  <met:description>${escXml(fieldDef.description)}</met:description>`);
    }

    switch (fieldDef.type) {
      case "Text":
        parts.push(`  <met:length>${fieldDef.length || 255}</met:length>`);
        if (fieldDef.required) parts.push(`  <met:required>true</met:required>`);
        if (fieldDef.unique) parts.push(`  <met:unique>true</met:unique>`);
        if (fieldDef.externalId) parts.push(`  <met:externalId>true</met:externalId>`);
        break;
      case "TextArea":
        break;
      case "LongTextArea":
        parts.push(`  <met:length>${fieldDef.length || 32768}</met:length>`);
        parts.push(`  <met:visibleLines>${fieldDef.visibleLines || 6}</met:visibleLines>`);
        break;
      case "Number":
      case "Currency":
      case "Percent":
        parts.push(`  <met:precision>${parseInt(fieldDef.precision) || 18}</met:precision>`);
        parts.push(`  <met:scale>${parseInt(fieldDef.scale) || 0}</met:scale>`);
        if (fieldDef.type === "Number") {
          if (fieldDef.unique) parts.push(`  <met:unique>true</met:unique>`);
          if (fieldDef.externalId) parts.push(`  <met:externalId>true</met:externalId>`);
        }
        break;
      case "Date":
      case "DateTime":
      case "Email":
      case "Phone":
      case "Url":
        break;
      case "Checkbox":
        parts.push(`  <met:defaultValue>${fieldDef.defaultValue === true || fieldDef.defaultValue === "true" ? "true" : "false"}</met:defaultValue>`);
        break;
      case "Picklist":
      case "MultiselectPicklist": {
        // Empty/null values or a defaultValue outside the set →
        // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST on create.
        const raw = Array.isArray(fieldDef.values) ? fieldDef.values : [];
        const values = [];
        const seen = new Set();
        for (const v of raw) {
          const s = String(v == null ? "" : v).trim();
          if (!s) continue;
          const key = s.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          values.push(s);
        }
        if (!values.length) {
          throw new Error(
            `Picklist field "${fieldDef.name}" has no values — provide 2-5 options`
          );
        }
        let defVal = String(fieldDef.defaultValue == null ? "" : fieldDef.defaultValue).trim();
        if (defVal && !values.some(v => v.toLowerCase() === defVal.toLowerCase())) {
          defVal = "";
        }
        if (!defVal) defVal = values[0];
        parts.push(`  <met:valueSet>`);
        parts.push(`    <met:valueSetDefinition>`);
        parts.push(`      <met:sorted>${fieldDef.sortValues ? "true" : "false"}</met:sorted>`);
        for (const v of values) {
          const isDefault = v.toLowerCase() === defVal.toLowerCase();
          parts.push(`      <met:value>`);
          parts.push(`        <met:fullName>${escXml(v)}</met:fullName>`);
          parts.push(`        <met:default>${isDefault ? "true" : "false"}</met:default>`);
          parts.push(`        <met:label>${escXml(v)}</met:label>`);
          parts.push(`      </met:value>`);
        }
        parts.push(`    </met:valueSetDefinition>`);
        parts.push(`  </met:valueSet>`);
        if (fieldDef.type === "MultiselectPicklist") {
          parts.push(`  <met:visibleLines>${parseInt(fieldDef.visibleLines) || 4}</met:visibleLines>`);
        }
        break;
      }
      case "Lookup":
      case "MasterDetail": {
        const relName = safeRelationshipName(fieldDef, objectName);
        parts.push(`  <met:relationshipLabel>${escXml(fieldDef.label)}</met:relationshipLabel>`);
        parts.push(`  <met:relationshipName>${escXml(relName)}</met:relationshipName>`);
        parts.push(`  <met:referenceTo>${escXml(fieldDef.relatedTo)}</met:referenceTo>`);
        break;
      }
      default:
        throw new Error(`Unsupported field type: ${fieldDef.type}`);
    }

    parts.push(`</met:metadata>`);
    return parts.join("\n");
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

  buildRecordTypeXml(objectName, rt) {
    // Standalone RecordType create: fullName is ObjectApi.DeveloperName
    // (DeveloperName has NO __c suffix). Omit businessProcess — custom
    // objects have none. Deployed via the proven async create() op.
    const parts = [
      `<met:metadata xsi:type="met:RecordType">`,
      `  <met:fullName>${escXml(objectName)}.${escXml(rt.name)}</met:fullName>`,
      `  <met:label>${escXml(rt.label)}</met:label>`,
      `  <met:active>${rt.active === false ? "false" : "true"}</met:active>`,
    ];
    if (rt.description) {
      parts.push(`  <met:description>${escXml(rt.description)}</met:description>`);
    }
    parts.push(`</met:metadata>`);
    return parts.join("\n");
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
        `SELECT Id, FullName FROM Layout WHERE EntityDefinition.DeveloperName = '${baseName}' LIMIT 5`);
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
      let needsRepair = false;
      for (const sec of domFindAll(records, "layoutSections")) {
        const st = domFind(sec, "style");
        if (st && st.textContent === "CustomLinks" &&
            domFindAll(sec, "layoutItems").some(li => {
              const f = domFind(li, "field");
              return f && f.textContent;
            })) {
          needsRepair = true;
        }
      }
      if (domFindAll(records, "layoutColumns").some(c => domChildren(c).length === 0)) {
        needsRepair = true;
      }
      for (const li of domFindAll(records, "layoutItems")) {
        const f = domFind(li, "field");
        if (f && f.textContent && !domFind(li, "customLink")) {
          needsRepair = true;
          break;
        }
      }

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
      const template = this.findLayoutItemTemplate(records);
      if (target) {
        for (const f of toAdd) {
          target.appendChild(this.buildLayoutItem(doc, template, f));
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

  // Template = first existing field item. Cloning its exact shape preserves
  // schema order and required elements: reads carry
  // <customLink xsi:nil="true"/> (required-but-nullable), so a hand-built
  // (behavior, field) item is rejected with "Required field is missing:
  // customLink". A valued customLink is reset to nil so we never duplicate
  // another row's link.
  findLayoutItemTemplate(records) {
    for (const li of domFindAll(records, "layoutItems")) {
      const f = domFind(li, "field");
      if (f && f.textContent) return li;
    }
    return null;
  }

  buildLayoutItem(doc, template, fieldName) {
    const XSI = "http://www.w3.org/2001/XMLSchema-instance";
    // Never emit "Object.Field" in layoutItems — Metadata API wants the bare
    // API name here (qualified names fail with "no CustomField named …").
    const short = String(fieldName || "").split(".").pop();
    fieldName = short;
    // Metadata API rejects layoutItems without a valued-or-nil customLink
    // ("Required field is missing: customLink"). The Name field must also be
    // behavior=Required when authoring a fresh layout ("Field Name must be
    // Required"). Clone templates still force both so round-trips are safe.
    const behavior = fieldName === "Name" ? "Required" : "Edit";
    let item;
    if (template) {
      item = template.cloneNode(true);
      let hasCustomLink = false;
      for (const c of domChildren(item)) {
        const ln = domLocal(c);
        if (ln === "field") c.textContent = fieldName;
        else if (ln === "behavior") c.textContent = behavior;
        else if (ln === "customLink") {
          hasCustomLink = true;
          c.textContent = "";
          c.setAttributeNS(XSI, "xsi:nil", "true");
        }
      }
      if (!hasCustomLink) {
        const cl = doc.createElement("customLink");
        cl.setAttributeNS(XSI, "xsi:nil", "true");
        const beh = domFind(item, "behavior");
        if (beh && beh.nextSibling) item.insertBefore(cl, beh.nextSibling);
        else item.appendChild(cl);
      }
    } else {
      item = domMakeEl(doc, "layoutItems");
      item.appendChild(domMakeEl(doc, "behavior", behavior));
      const cl = doc.createElement("customLink");
      cl.setAttributeNS(XSI, "xsi:nil", "true");
      item.appendChild(cl);
      item.appendChild(domMakeEl(doc, "field", fieldName));
    }
    return item;
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
      const template = this.findLayoutItemTemplate(records);
      // LayoutItem.field must be the bare API name for custom fields on this
      // object. A leftover "Object.Field" from a prior read is rejected with
      // "no CustomField named IT_Asset__c.Assigned_To__c found" when the
      // create path rebuilds the item — strip any object prefix first.
      const shortName = n => String(n || "").split(".").pop();
      const fields = ["Name", ...Array.from(new Set(toAdd.map(shortName)))
        .filter(f => f && f !== "Name")];
      for (const f of fields) {
        col.appendChild(this.buildLayoutItem(doc, template, f));
      }
      section.appendChild(col);
      // fullName for a custom layout is Object.LayoutDeveloperName — a
      // spacey/hyphenated name without the object prefix is rejected and
      // confuses field resolution ("no CustomField named Object.Field").
      const layoutDevName = "ForceForge_Layout";
      const newName = `${objectName}.${layoutDevName}`;
      const xml = `<met:metadata xsi:type="met:Layout">` +
        `<met:fullName>${escXml(newName)}</met:fullName>` +
        `${domToMetXml(section)}</met:metadata>`;
      const res = await this.metaSoapRequest("create", xml);
      if (res.id && (res.done === "false" || res.state === "InProgress")) {
        await this.pollDeployStatus(res.id);
      }
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
      const found = this.matchProfileFullName(label, this._profileMetadataNames);
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
      const found = this.matchProfileFullName(label, names);
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

  // listMetadata → array of fullNames for a metadata type.
  async listMetadataFullNames(type) {
    const body = `<met:listMetadata><met:queries><met:type>${escXml(type)}</met:type></met:queries></met:listMetadata>`;
    const doc = await this.soapPostDom(body);
    const names = [];
    for (const fp of domFindAll(doc.documentElement, "fileProperties")) {
      const fn = domFind(fp, "fullName");
      if (fn && fn.textContent) names.push(fn.textContent);
    }
    if (names.length === 0) {
      // Some orgs return fullNames without a fileProperties wrapper.
      for (const fn of domFindAll(doc.documentElement, "fullName")) {
        if (fn.textContent) names.push(fn.textContent);
      }
    }
    return names;
  }

  // Case-insensitive / punctuation-insensitive match of a profile label
  // against metadata fullNames (e.g. "System Administrator" → "Admin").
  matchProfileFullName(label, names) {
    const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // "System Administrator (non-API user)" → also try the base before "(".
    const baseLabel = String(label || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    const targets = [norm(label), norm(baseLabel)].filter(Boolean);
    if (targets.includes("systemadministrator")) {
      const aliases = ["admin", "systemadministrator"];
      for (const a of aliases) {
        const hit = names.find(n => norm(n) === a);
        if (hit) return hit;
      }
    }
    for (const target of targets) {
      const exact = names.find(n => norm(n) === target);
      if (exact) return exact;
      const loose = names.find(n => {
        const nn = norm(n);
        return nn && (nn.startsWith(target) || target.startsWith(nn));
      });
      if (loose) return loose;
    }
    // Base label only (drop qualifier): "Marketing User (API)" → "Marketing User".
    if (baseLabel && baseLabel !== label) {
      const base = norm(baseLabel);
      const exact = names.find(n => norm(n) === base);
      if (exact) return exact;
      const loose = names.find(n => {
        const nn = norm(n);
        return nn && (nn.startsWith(base) || base.startsWith(nn));
      });
      if (loose) return loose;
    }
    return null;
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
          fullName = this.matchProfileFullName(label, this._profileMetadataNames);
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
            parts.push(`<met:tabVisibilities><met:tab>${escXml(objectName)}</met:tab>` +
              `<met:visibility>DefaultOn</met:visibility></met:tabVisibilities>`);
          }
          const missingRTs = recordTypes.filter(rt =>
            !visibleRTs.has(`${objectName}.${rt.name}`));
          for (const rt of missingRTs) {
            parts.push(`<met:recordTypeVisibilities>` +
              `<met:default>false</met:default>` +
              `<met:recordType>${escXml(objectName)}.${escXml(rt.name)}</met:recordType>` +
              `<met:visible>true</met:visible></met:recordTypeVisibilities>`);
          }
        } else {
          // Bulk / no pre-read: always send the tab visibility entry (idempotent).
          parts.push(`<met:tabVisibilities><met:tab>${escXml(objectName)}</met:tab>` +
            `<met:visibility>DefaultOn</met:visibility></met:tabVisibilities>`);
          for (const rt of recordTypes) {
            parts.push(`<met:recordTypeVisibilities>` +
              `<met:default>false</met:default>` +
              `<met:recordType>${escXml(objectName)}.${escXml(rt.name)}</met:recordType>` +
              `<met:visible>true</met:visible></met:recordTypeVisibilities>`);
          }
        }
        if (parts.length > 0) {
          const xml = `<met:metadata xsi:type="met:Profile">` +
            `<met:fullName>${escXml(fullName)}</met:fullName>` +
            `${parts.join("")}</met:metadata>`;
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
    const base = currentProposal.object.name.replace(/__c$/, "").replace(/_2$/, "");
    const nextName = `${base}_2__c`;
    const nextLabel = `${currentProposal.object.label} 2`;
    this.setState(prev => ({
      currentProposal: {
        ...prev.currentProposal,
        object: {...prev.currentProposal.object, name: nextName, label: nextLabel}
      },
      deploymentStatus: null,
      deploymentStep: null,
      deploymentResults: [],
      error: null
    }), () => this.deployObject());
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

  buildTabXml(objectName, objectLabel) {
    const motif = pickTabMotif(objectName);
    // NOTE: object tabs must NOT include <met:label> — only customObject +
    // motif (+ optional description). Label causes deployment errors.
    // fullName for an object tab is the object API name.
    return `<met:metadata xsi:type="met:CustomTab">\n` +
      `  <met:fullName>${escXml(objectName)}</met:fullName>\n` +
      `  <met:customObject>true</met:customObject>\n` +
      `  <met:motif>${escXml(motif)}</met:motif>\n` +
      `  <met:description>${escXml("Tab for " + objectLabel)}</met:description>\n` +
      `</met:metadata>`;
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
      const res = await this.metaSoapRequest("create", this.buildTabXml(objectName, objectLabel));
      if (res && res.id && (res.done === "false" || res.state === "InProgress")) {
        console.log("[SaralForce] Tab creation async, polling...", res.id);
        await this.pollDeployStatus(res.id);
      }
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
    this.setState({currentProposal: draft, error: null}, () => {
      if (after) after(draft);
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
    const base = String(label || "")
      .replace(/[^A-Za-z0-9 ]/g, "")
      .trim()
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join("_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    const clean = base || "Custom_Field";
    return (/^[A-Za-z]/.test(clean) ? clean : "Custom_" + clean) + "__c";
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

  // After deploy: pin the tab to the app chosen in Deployment Targets.
  async _autoAssignSelectedApp() {
    if (this._autoAssignRunning) return;
    if (!this.state.selectedApp || this.state.appAssigned || this.state.appsLoading ||
        this.state.deploymentStatus === "deploying") {
      return;
    }
    this._autoAssignRunning = true;
    try {
      if (!this.state.availableApps.length) {
        await this.loadApps();
      }
      if (!this.state.selectedApp || !this.state.availableApps.length) return;
      console.log("[SaralForce] Auto-assigning tab to pre-selected app:", this.state.selectedApp);
      await this.assignTabToApp();
    } catch (e) {
      console.warn("[SaralForce] Auto-assign failed:", e.message);
    } finally {
      this._autoAssignRunning = false;
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

  tabWasCreated() {
    return (this.state.deploymentResults || [])
      .some(r => r.type === "tab" && r.status === "success");
  }

  // CustomApplication record Id → metadata fullName (developer name).
  async resolveCustomAppFullNameById(appId) {
    if (!isSfId(appId)) return null;
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(
          `SELECT Id, DeveloperName, Name FROM CustomApplication WHERE Id = '${appId}'`));
      const row = res && res.records && res.records[0];
      if (!row) return null;
      return String(row.DeveloperName || row.Name || "").trim() || null;
    } catch (e) {
      console.warn("[SaralForce] resolveCustomAppFullNameById failed:", e.message);
      return null;
    }
  }

  // Normalize for loose label ↔ developerName matching.
  _normAppName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Build map: normalized(label|developerName) → real metadata fullName.
  // AppMenu only returns the display label; readMetadata needs DeveloperName.
  async fetchCustomAppDeveloperMap() {
    if (this._appDevMap && this._appDevMap.size) return this._appDevMap;
    const map = new Map();
    const put = (keys, fullName) => {
      const fn = String(fullName || "").trim();
      if (!fn || isSfId(fn)) return;
      for (const k of keys) {
        const nk = this._normAppName(k);
        if (nk && !map.has(nk)) map.set(nk, fn);
      }
    };
    // Tooling: Name is the label, DeveloperName is metadata fullName.
    for (const soql of [
      `SELECT Id, DeveloperName, Name FROM CustomApplication ORDER BY Name`,
      `SELECT Id, DeveloperName, MasterLabel FROM CustomApplication ORDER BY MasterLabel`,
      `SELECT Id, DeveloperName FROM CustomApplication ORDER BY DeveloperName`
    ]) {
      try {
        const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
          encodeURIComponent(soql));
        const rows = res.records || [];
        if (!rows.length) continue;
        for (const a of rows) {
          const dn = a.DeveloperName || a.Name || a.MasterLabel;
          put([a.DeveloperName, a.Name, a.MasterLabel, dn], dn);
        }
        console.log(`[SaralForce] CustomApp developer map Tooling: ${map.size} (${soql})`);
        if (map.size) break;
      } catch (e) {
        console.warn("[SaralForce] Tooling CustomApplication map failed:", e.message);
      }
    }
    // listMetadata fullNames (metadata truth).
    try {
      const names = await this.listMetadataFullNames("CustomApplication");
      for (const n of names) put([n, n.replace(/_/g, " ")], n);
      if (names.length) console.log(`[SaralForce] CustomApp map +listMetadata: ${map.size}`);
    } catch (e) {
      console.warn("[SaralForce] listMetadata CustomApplication map failed:", e.message);
    }
    // AppMenuItem: Label ↔ Name for TabSet apps.
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(`SELECT Name, Label FROM AppMenuItem WHERE Type = 'TabSet'`));
      for (const a of (res.records || [])) {
        // Prefer existing Tooling fullNames; only seed if we don't have a better hit.
        put([a.Label, a.Name], a.Name);
      }
    } catch (e) {
      console.warn("[SaralForce] AppMenuItem map failed:", e.message);
    }
    this._appDevMap = map;
    return map;
  }

  // Label/name candidates → ordered real fullNames (DeveloperName first).
  async resolveAppFullNameCandidates(names, label) {
    const out = [];
    const seen = new Set();
    const add = n => {
      const s = String(n || "").trim();
      if (s && !isSfId(s) && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        out.push(s);
      }
    };
    let map = null;
    try {
      map = await this.fetchCustomAppDeveloperMap();
    } catch (e) {
      console.warn("[SaralForce] resolveAppFullNameCandidates map:", e.message);
    }
    const probes = [...(names || []), label].filter(Boolean);
    if (map && map.size) {
      for (const p of probes) {
        const hit = map.get(this._normAppName(p));
        if (hit) add(hit);
      }
      // Label "Shivam App" → try developer-style variants against the map.
      for (const p of probes) {
        const variants = [
          String(p).replace(/\s+/g, "_"),
          String(p).replace(/\s+/g, ""),
          String(p).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")
        ];
        for (const v of variants) {
          const hit = map.get(this._normAppName(v));
          if (hit) add(hit);
        }
      }
    }
    for (const p of probes) add(p);
    return out;
  }

  // Post-deploy: list Lightning apps so the user can pin the new tab.
  // Prefer AppMenu + AppMenuItem (user-visible, includes standard apps like
  // Sales). CustomApplication Tooling/SOQL/listMetadata are fallbacks —
  // listMetadata often omits standard apps; plain SOQL has no Name column.
  async loadApps() {
    if (this.state.appsLoading || this._appsLoading) return;
    this._appsLoading = true;
    this._appsTried = true;
    this.setState({appsLoading: true, error: null, appLoadError: null});
    const apps = [];
    const seen = new Set();
    const attempts = [];
    const push = (candidates, displayName) => {
      // Metadata fullName must never be a Salesforce Id.
      const names = (Array.isArray(candidates) ? candidates : [candidates])
        .map(s => String(s || "").trim())
        .filter(Boolean)
        .filter(s => !isSfId(s));
      if (!names.length) return;
      const primary = names[0];
      const key = primary.toLowerCase();
      if (seen.has(key)) {
        const existing = apps.find(a => a.id.toLowerCase() === key);
        if (existing) {
          for (const n of names) {
            if (n && !existing.candidates.some(c => c.toLowerCase() === n.toLowerCase())) {
              existing.candidates.push(n);
            }
          }
        }
        return;
      }
      seen.add(key);
      const disp = String(displayName || primary).trim();
      apps.push({
        id: primary,
        name: isSfId(disp) ? primary : (disp || primary),
        developerName: primary,
        candidates: [...names]
      });
    };
    const note = (label, err) => {
      const msg = err && err.message ? err.message : String(err || "empty");
      attempts.push(`${label}: ${msg}`);
      console.warn(`[SaralForce] loadApps ${label} failed:`, msg);
    };

    try {
      // 1) App Menu REST — what the user actually sees in the App Launcher.
      try {
        const res = await sfConn.rest(`/services/data/v${apiVersion}/appMenu/AppSwitcher/`);
        let items = [];
        if (Array.isArray(res)) items = res;
        else if (res && Array.isArray(res.items)) items = res.items;
        else if (res && Array.isArray(res.records)) items = res.records;
        else if (res && typeof res === "object") {
          // Some orgs nest under menu keys or return a single object map.
          for (const v of Object.values(res)) {
            if (Array.isArray(v) && v.length && (v[0].label || v[0].name)) {
              items = v;
              break;
            }
          }
          if (!items.length && (res.label || res.name)) items = [res];
        }
        if (!items.length) throw new Error("no items in response: " + JSON.stringify(res).slice(0, 200));
        for (const it of items) {
          const label = it.label || it.Name || it.title || "";
          const rawName = it.name || it.Name || it.apiName || it.DeveloperName || "";
          const rawId = it.id || it.Id || (isSfId(rawName) ? rawName : "") || (isSfId(label) ? label : "");
          // Prefer developer-name-ish fields; AppMenu may put record Id in `name`.
          let ordered = [it.DeveloperName, it.apiName, rawName, label]
            .map(s => String(s || "").trim())
            .filter(s => s && !isSfId(s));
          // Id-only item: resolve CustomApplication.DeveloperName via Tooling.
          if (!ordered.length && rawId) {
            const resolved = await this.resolveCustomAppFullNameById(rawId);
            if (resolved && !isSfId(resolved)) ordered = [resolved];
            if (resolved && label && !isSfId(label)) ordered.push(label);
          }
          const deduped = ordered.filter((s, i) =>
            ordered.findIndex(t => t.toLowerCase() === s.toLowerCase()) === i);
          if (!deduped.length) continue;
          const disp = String(label && !isSfId(label) ? label : deduped[0]).trim();
          push(deduped, isSfId(disp) ? deduped[0] : disp);
        }
        if (!apps.length) throw new Error("parsed 0 apps from AppMenu");
        console.log(`[SaralForce] loadApps AppMenu: ${apps.length} apps`);
      } catch (e) {
        note("AppMenu AppSwitcher", e);
      }

      // 2) AppMenuItem SOQL — Type=TabSet is the app list; Name ≈ developer name.
      if (!apps.length) {
        try {
          const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT Name, Label, Type FROM AppMenuItem WHERE Type = 'TabSet' ORDER BY Label`));
          const rows = res.records || [];
          if (!rows.length) throw new Error("0 rows");
          for (const a of rows) {
            const label = a.Label || a.Name;
            push([a.Name, a.Label, a.DeveloperName], label);
          }
          if (!apps.length) throw new Error("parsed 0 apps from AppMenuItem");
          console.log(`[SaralForce] loadApps AppMenuItem: ${apps.length} apps`);
        } catch (e) {
          note("AppMenuItem SOQL", e);
        }
      }

      // 3) Tooling CustomApplication (MasterLabel + DeveloperName).
      if (!apps.length) {
        try {
          const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
            encodeURIComponent(`SELECT Id, MasterLabel, DeveloperName FROM CustomApplication ORDER BY MasterLabel`));
          for (const a of (res.records || [])) push([a.DeveloperName, a.MasterLabel], a.MasterLabel || a.DeveloperName);
          console.log(`[SaralForce] loadApps Tooling: ${apps.length} apps`);
        } catch (e) {
          note("Tooling CustomApplication", e);
        }
      }

      // 4) Plain SOQL (DeveloperName only — no Name column on this object).
      if (!apps.length) {
        try {
          const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT Id, DeveloperName FROM CustomApplication ORDER BY DeveloperName`));
          for (const a of (res.records || [])) push(a.DeveloperName, a.DeveloperName);
          console.log(`[SaralForce] loadApps SOQL: ${apps.length} apps`);
        } catch (e) {
          note("CustomApplication SOQL", e);
        }
      }

      // 5) Metadata listMetadata fullNames (often custom-only; last resort).
      if (!apps.length) {
        try {
          const names = await this.listMetadataFullNames("CustomApplication");
          if (!names.length) throw new Error("0 fullNames");
          for (const n of names) push(n, n.replace(/_/g, " "));
          console.log(`[SaralForce] loadApps listMetadata: ${apps.length} apps`);
        } catch (e) {
          note("listMetadata CustomApplication", e);
        }
      }

      // Always map labels → real CustomApplication DeveloperNames so
      // readMetadata(update) never gets "Shivam" when fullName is "Shivam_App".
      try {
        const map = await this.fetchCustomAppDeveloperMap();
        for (const app of apps) {
          const keys = [app.name, app.developerName, ...(app.candidates || [])];
          for (const k of keys) {
            const hit = map.get(this._normAppName(k));
            if (hit && !app.candidates.some(c => c.toLowerCase() === hit.toLowerCase())) {
              app.candidates.unshift(hit);
            }
            if (hit) app.developerName = hit;
          }
          // Prefer real DeveloperName as the radio value / primary id.
          const primaryHit = map.get(this._normAppName(app.name)) ||
            map.get(this._normAppName(app.developerName));
          if (primaryHit) {
            app.developerName = primaryHit;
            app.id = primaryHit;
            if (!app.candidates.some(c => c.toLowerCase() === primaryHit.toLowerCase())) {
              app.candidates.unshift(primaryHit);
            } else {
              app.candidates = [
                primaryHit,
                ...app.candidates.filter(c => c.toLowerCase() !== primaryHit.toLowerCase())
              ];
            }
          }
        }
        console.log(`[SaralForce] loadApps enriched with developer map (${map.size} entries)`);
      } catch (e) {
        console.warn("[SaralForce] loadApps developer-map enrich failed:", e.message);
      }

      const loadError = apps.length
        ? null
        : (attempts.length
            ? "No apps returned — " + attempts.join(" | ")
            : "No Lightning apps found.");
      this._appsLoading = false;
      this.setState({
        availableApps: apps,
        appsLoading: false,
        appLoadError: loadError,
        error: apps.length ? null : loadError
      });
    } catch (e) {
      const extra = attempts.length ? " (" + attempts.join(" | ") + ")" : "";
      const msg = "Could not load apps: " + e.message + extra;
      this._appsLoading = false;
      this.setState({appsLoading: false, appLoadError: msg, error: msg});
    }
  }

  toggleApp(developerName) {
    this.setState(prev => ({
      selectedApp: prev.selectedApp === developerName ? null : developerName
    }));
  }

  // Append the object tab to the chosen app's navigation (CustomApplication.tabs).
  async assignTabToApp() {
    const {currentProposal, selectedApp, deploymentStatus, availableApps} = this.state;
    if (!currentProposal || deploymentStatus === "deploying") return;
    if (!this.tabWasCreated()) {
      this.setState({error: "Deploy the object first (tab must exist), then assign it to an app."});
      return;
    }
    if (!selectedApp) {
      this.setState({error: "Select an app to assign the tab to."});
      return;
    }
    const tabName = currentProposal.object.name;
    const app = availableApps.find(a => a.developerName === selectedApp || a.name === selectedApp || a.id === selectedApp);
    const appLabel = app ? app.name : selectedApp;
    // CustomApplication fullName may be DeveloperName, Label, or a known alias
    // (standard apps: AppMenuItem.Name often differs from metadata fullName).
    const candidateNames = [];
    const seenFn = new Set();
    const addFn = n => {
      const s = String(n || "").trim();
      if (s && !seenFn.has(s.toLowerCase())) {
        seenFn.add(s.toLowerCase());
        candidateNames.push(s);
      }
    };
    if (app && Array.isArray(app.candidates)) app.candidates.forEach(addFn);
    addFn(selectedApp);
    if (app) addFn(app.name);
    if (app && app.developerName) addFn(app.developerName);
    // Common standard-app metadata fullNames when list only had labels.
    if (app && /^sales$/i.test(app.name || "")) {
      ["LightningSales", "Sales", "SalesCloud"].forEach(addFn);
    }
    if (app && /^service$/i.test(app.name || "")) {
      ["LightningService", "Service", "ServiceCloud"].forEach(addFn);
    }
    // Resolve label → real DeveloperName (AppMenu only returns the label).
    try {
      const resolved = await this.resolveAppFullNameCandidates(
        candidateNames, appLabel);
      for (const r of resolved) addFn(r);
      // Put resolved fullNames first so readMetadata tries the real name first.
      const resolvedSet = new Set(resolved.map(s => s.toLowerCase()));
      candidateNames.sort((a, b) => {
        const ar = resolvedSet.has(a.toLowerCase()) ? 0 : 1;
        const br = resolvedSet.has(b.toLowerCase()) ? 0 : 1;
        return ar - br;
      });
      console.log(`[SaralForce] assign candidates for "${appLabel}":`, candidateNames);
    } catch (e) {
      console.warn("[SaralForce] resolveAppFullNameCandidates:", e.message);
    }
    // Never send a Salesforce Id as CustomApplication fullName.
    const usableNames = candidateNames.filter(n => !isSfId(n));
    if (!usableNames.length) {
      this.setState({
        deploymentStatus: "complete",
        deploymentStep: "App assignment failed",
        error: `"${appLabel}" has no metadata developer name (got Salesforce Id only). ` +
          `Reload apps or pick a different app.`,
        deploymentResults: [...this.state.deploymentResults.filter(r => r.type !== "app"), {
          type: "app",
          name: currentProposal.object.name + "_app",
          label: `App (${appLabel})`,
          status: "error",
          error: "No usable CustomApplication fullName (Salesforce Id filtered out)"
        }]
      });
      return;
    }
    candidateNames.length = 0;
    usableNames.forEach(addFn);
    this._deployAborted = false;
    this._abortController = new AbortController();
    this.setState({
      deploymentStatus: "deploying",
      deploymentStep: `Assigning tab to "${appLabel}"...`,
      error: null
    });
    try {
      let records = null;
      let fullName = null;
      const readErrors = [];
      for (const name of candidateNames) {
        try {
          const rec = await this.metadataReadRecords("CustomApplication", name);
          if (rec) {
            records = rec;
            fullName = name;
            break;
          }
          readErrors.push(`${name}: not found`);
        } catch (e) {
          readErrors.push(`${name}: ${e.message}`);
        }
      }
      if (!records) {
        // Last resort: fuzzy-match label against listMetadata fullNames.
        try {
          const names = await this.listMetadataFullNames("CustomApplication");
          const norm = s => this._normAppName(s);
          const probes = [appLabel, selectedApp, app && app.name, app && app.developerName]
            .map(norm).filter(Boolean);
          let hit = null;
          for (const n of names) {
            const nn = norm(n);
            if (probes.some(p => nn === p || nn.startsWith(p) || p.startsWith(nn))) {
              hit = n;
              break;
            }
          }
          if (hit) {
            const rec = await this.metadataReadRecords("CustomApplication", hit);
            if (rec) {
              records = rec;
              fullName = hit;
              console.log(`[SaralForce] assign fuzzy-resolved "${appLabel}" → "${hit}"`);
            }
          }
        } catch (e2) {
          readErrors.push(`listMetadata fuzzy: ${e2.message}`);
        }
      }
      if (!records) {
        throw new Error(
          `Could not read CustomApplication metadata for "${appLabel}"` +
          (readErrors.length ? ` — tried ${readErrors.join("; ")}` : "") +
          `. Open Setup → App Manager → edit the app and check its Developer Name, ` +
          `or reload apps and pick it again.`
        );
      }
      const existingTabs = [];
      let lastTabsEl = null;
      for (const child of domChildren(records)) {
        if (domLocal(child) === "tabs") {
          if (child.textContent) existingTabs.push(child.textContent.trim());
          lastTabsEl = child;
        }
      }
      const fnBefore = domFind(records, "fullName");
      if (fnBefore && fnBefore.textContent && !isSfId(fnBefore.textContent)) {
        fullName = fnBefore.textContent;
      }
      if (isSfId(fullName)) {
        throw new Error(
          `Read "${appLabel}" but got Salesforce Id "${fullName}" as fullName — ` +
          `CustomApplication metadata fullName must be a developer name, not an Id.`
        );
      }
      console.log(`[SaralForce] assignTabToApp read "${fullName}": tabs=[${existingTabs.join(", ")}]`);
      if (existingTabs.includes(tabName)) {
        this.setState({
          deploymentStatus: "complete",
          deploymentStep: `Tab already on "${appLabel}"`,
          appAssigned: true,
          deploymentResults: [...this.state.deploymentResults.filter(r => r.type !== "app"), {
            type: "app",
            name: currentProposal.object.name + "_app",
            label: `App (${appLabel} — already included)`,
            status: "success"
          }]
        });
        return;
      }
      // Empty nav is already broken ("No Items") — seed Home + new tab so the
      // app is usable instead of writing a single unknown entry into a void.
      const desiredTabs = existingTabs.length
        ? [...existingTabs, tabName]
        : ["standard-home", tabName];
      const doc = records.ownerDocument;
      // Capture insert position BEFORE removing tabs (removed nodes lose parent).
      // XSD order: insert <tabs> before the first sibling that must follow it;
      // if none, append at the end. Never insert after <label> blindly.
      let insertParent = null;
      let insertRef = null;
      if (lastTabsEl && lastTabsEl.parentNode) {
        insertParent = lastTabsEl.parentNode;
        insertRef = lastTabsEl.nextSibling;
      } else {
        insertParent = records;
        insertRef = null;
        for (const child of domChildren(records)) {
          const ln = domLocal(child);
          if (ln === "tabs" || ln === "fullName") continue;
          if (CUSTOM_APP_AFTER_TABS.has(ln)) {
            insertRef = child;
            break;
          }
        }
      }
      // Remove every existing tabs element, then re-insert the full desired list.
      for (const child of [...domChildren(records)]) {
        if (domLocal(child) === "tabs") child.remove();
      }
      const tabEls = desiredTabs.map(t => {
        const el = doc.createElement("tabs");
        el.textContent = t;
        return el;
      });
      if (insertParent) {
        // Advance past the just-inserted node, otherwise each insert lands
        // BEFORE the previous one and the whole nav order gets reversed.
        let cursor = insertRef;
        for (const el of tabEls) {
          insertParent.insertBefore(el, cursor);
          cursor = el.nextSibling;
        }
      } else {
        for (const el of tabEls) records.appendChild(el);
      }
      const fnEl = domFind(records, "fullName");
      if (fnEl && fnEl.textContent && !isSfId(fnEl.textContent)) fullName = fnEl.textContent;
      if (isSfId(fullName)) {
        throw new Error(`Refusing updateMetadata with Salesforce Id as fullName: ${fullName}`);
      }
      const preCount = existingTabs.length;
      await this.metadataUpdateRecords("CustomApplication", fullName, records);
      // Metadata writes can lag — brief settle before verify.
      await this.delay(1500);
      // Verify: re-read and ensure we didn't lose navigation items.
      try {
        const verify = await this.metadataReadRecords("CustomApplication", fullName);
        const postTabs = [];
        if (verify) {
          for (const child of domChildren(verify)) {
            if (domLocal(child) === "tabs" && child.textContent) postTabs.push(child.textContent.trim());
          }
        }
        console.log(`[SaralForce] assignTabToApp verify "${fullName}" tabs=[${postTabs.join(", ")}] (was ${preCount})`);
        if (!postTabs.includes(tabName)) {
          // Cross-check via Tooling so we don't false-fail on a flaky read.
          let toolingHas = false;
          try {
            const tRes = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
              encodeURIComponent(
                `SELECT Id, DeveloperName, Name FROM CustomApplication WHERE DeveloperName = '${fullName.replace(/'/g, "\\'")}' OR Name = '${appLabel.replace(/'/g, "\\'")}' LIMIT 1`));
            toolingHas = !!(tRes.records && tRes.records.length);
          } catch (te) {
            console.warn("[SaralForce] Tooling app cross-check failed:", te.message);
          }
          throw new Error(
            `Update reported success but "${tabName}" is missing from "${appLabel}" ` +
            `(fullName="${fullName}", tabs now: ${postTabs.join(", ") || "none"}). ` +
            (toolingHas
              ? `App exists — open App Manager → Navigation Items and add the tab, or switch apps once to refresh the nav bar.`
              : `Could not confirm the app in Tooling — the label may map to a different DeveloperName.`)
          );
        }
        if (preCount > 0 && postTabs.length < preCount) {
          throw new Error(
            `Navigation shrank on "${appLabel}" (${preCount} → ${postTabs.length}). ` +
            `Fix in App Manager → Navigation Items.`
          );
        }
        if (preCount === 0 && postTabs.length < 2) {
          throw new Error(
            `App "${appLabel}" still has no usable navigation (tabs: ${postTabs.join(", ") || "none"}). ` +
            `Open App Manager → edit the app → Navigation Items and add Home + your tab.`
          );
        }
      } catch (verifyErr) {
        if (/cancelled/i.test(verifyErr.message)) throw verifyErr;
        console.warn("[SaralForce] assignTabToApp verify failed:", verifyErr.message);
        // Still surface verify problems — a "success" that dropped tabs is worse than an error.
        throw verifyErr;
      }
      this.setState(prev => ({
        deploymentStatus: "complete",
        deploymentStep: `Tab assigned to "${appLabel}" (${fullName}) — switch apps or refresh to see it`,
        appAssigned: true,
        deploymentResults: [...prev.deploymentResults.filter(r => r.type !== "app"), {
          type: "app",
          name: currentProposal.object.name + "_app",
          label: `App (${appLabel} → ${fullName})`,
          status: "success"
        }]
      }));
      // Tab must be visible on the running profile or it won't show in the nav bar.
      try {
        await this.ensureCurrentUserVisibility(currentProposal.object.name);
      } catch (visErr) {
        console.warn("[SaralForce] post-assign visibility:", visErr.message);
      }
    } catch (err) {
      if (/cancelled/i.test(err.message)) {
        this.setState({deploymentStatus: "complete", deploymentStep: "Cancelled"});
        return;
      }
      this.setState(prev => ({
        deploymentStatus: "complete",
        deploymentStep: "App assignment failed",
        error: err.message,
        deploymentResults: [...prev.deploymentResults.filter(r => r.type !== "app"), {
          type: "app",
          name: currentProposal.object.name + "_app",
          label: `App (${selectedApp})`,
          status: "error",
          error: err.message,
          debug: this.lastSoapDebugText()
        }]
      }));
    }
  }

  // Post-deploy (or after Redeploy): apply tab visibility without redoing
  // object/fields/layout. Enabled once the Tab row is a success.
  async applyTabVisibility() {
    const {currentProposal, visibilityMode, selectedProfiles, deploymentStatus} = this.state;
    if (!currentProposal || deploymentStatus === "deploying") return;
    const tabOk = this.state.deploymentResults.some(r => r.type === "tab" && r.status === "success");
    if (!tabOk) {
      this.setState({error: "Deploy the object first — the tab must exist before visibility can be set."});
      return;
    }
    let visLabels = this.getVisibilityLabels();
    if (visibilityMode !== "selected") {
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
    const modeLabel = visibilityMode === "selected"
      ? `${visLabels.length} selected profile${visLabels.length === 1 ? "" : "s"}`
      : `all profiles (${visLabels.length})`;
    this._deployAborted = false;
    this._abortController = new AbortController();
    this.setState({
      deploymentStatus: "deploying",
      deploymentStep: `Setting tab visibility (${modeLabel})...`,
      error: null
    });
    try {
      const visResult = await this.setTabVisibilityForProfiles(
        currentProposal.object.name, visLabels, []);
      try {
        await this.ensureCurrentUserVisibility(currentProposal.object.name);
      } catch (curErr) {
        console.warn("[SaralForce] ensureCurrentUserVisibility:", curErr.message);
      }
      const visCount = visResult.ok ? (visResult.updated || []).length : 0;
      this.setState(prev => ({
        deploymentResults: [...prev.deploymentResults.filter(r => r.type !== "visibility"), {
          type: "visibility",
          name: currentProposal.object.name + "_visibility",
          label: visResult.ok
            ? `Tab Visibility (${visCount} profile${visCount === 1 ? "" : "s"})`
            : "Tab Visibility",
          status: visResult.ok ? "success" : "error",
          error: visResult.ok ? visResult.warning : visResult.error,
          debug: visResult.ok ? undefined : visResult.debug
        }],
        deploymentStatus: "complete",
        deploymentStep: visResult.ok ? "Tab visibility applied" : "Tab visibility failed"
      }));
    } catch (visErr) {
      if (/cancelled/i.test(visErr.message)) {
        this.setState({deploymentStatus: "complete", deploymentStep: "Cancelled"});
        return;
      }
      this.setState({
        deploymentStatus: "complete",
        deploymentStep: "Tab visibility failed",
        error: visErr.message
      });
    }
  }

  // Post-deploy: create record types (and RT visibility) when the proposal has them.
  async createRecordTypes() {
    const {currentProposal, deploymentStatus} = this.state;
    if (!currentProposal || !(currentProposal.recordTypes || []).length) return;
    if (deploymentStatus !== "complete") {
      this.setState({error: "Deploy the object first, then create record types."});
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
        const rtResult = await this.metaSoapRequest("create", this.buildRecordTypeXml(currentProposal.object.name, rt));
        if (rtResult.id && (rtResult.done === "false" || rtResult.state === "InProgress")) {
          await this.pollDeployStatus(rtResult.id);
        }
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
    const {sfHost} = this.props;
    const {
      messages, currentProposal, isGenerating, streamingText, isEnhancing, enhancedPreview,
      deploymentStatus, deploymentStep, deploymentProgress, deploymentResults, error, userInput, llmConfig, lastFailedPrompt,
      selectedFields, visibilityMode, selectedProfiles, availableProfiles, profilesLoading, recordTypesDone,
      availableApps, appsLoading, selectedApp
    } = this.state;

    const setupLink = this.getSetupLink();
    const hasConfig = hasValidConfig();
    const uiMode = this.state.uiMode || "builder";
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
              title: "Back to Object Builder"
            }, "← Builder"),
            h("button", {
              className: `header-btn${this.state.apiNamesOn ? " active" : ""}`,
              onClick: () => this.toggleApiNames(),
              title: "Show API names on this Salesforce page (click again to hide)"
            }, this.state.apiNamesOn ? "Hide API Names" : "Show API Names"),
            !sfConn.sessionId && h("button", {
              className: "header-btn",
              onClick: () => startSalesforceLogin(this.props.sfHost).catch(e => this.setState({error: "Login failed: " + e.message})),
              title: "Log in with Salesforce OAuth"
            }, "Connect"),
            h("button", {
              className: "header-btn header-btn-icon",
              onClick: () => this.toggleColorTheme(),
              title: `Switch to ${(this.state.colorTheme || "dark") === "dark" ? "light" : "dark"} theme`
            }, (this.state.colorTheme || "dark") === "dark" ? "☾" : "☀"),
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
            href: "https://rakesh-attri.github.io/BhajanMandali/",
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
            title: "SOQL, Data Import/Export, Org Info"
          }, "Inspector"),
          h("button", {
            className: `header-btn${this.state.apiNamesOn ? " active" : ""}`,
            onClick: () => this.toggleApiNames(),
            title: "Show API names on this Salesforce page (click again to hide)"
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
            title: "Chat History"
          }, `\u23f3 ${this.state.chatHistory.length}`),
          h("button", {
            className: "header-btn header-btn-icon",
            onClick: () => this.toggleColorTheme(),
            title: "Toggle theme"
          }, (this.state.colorTheme || "dark") === "dark" ? "☾" : "☀"),
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
                msg.role === "system" && h("div", {className: "message-system"}, msg.text),
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
              h("div", {className: "chat-input-wrap"},
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
                  onClick: () => this.enhancePrompt(),
                  disabled: isEnhancing,
                  title: "Enhance prompt"
                }, isEnhancing ? "..." : "🪄")
              ),
              !hasConfig && h("button", {
                className: "btn btn-primary",
                style: {marginLeft: "8px", alignSelf: "flex-end"},
                onClick: () => this.openOptions()
              }, "Open Settings"),
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
                return h("button", {
                  className: "btn btn-primary btn-sm",
                  onClick: () => this.deployObject(),
                  disabled: !currentProposal.fields?.length || errs.length > 0,
                  title: errs.length > 0
                    ? "Fix plan issues first: " + errs.slice(0, 2).join("; ")
                    : `Deploy ${currentProposal.object.label} to Salesforce`
                }, deploymentStatus === "complete" ? "Redeploy" : `Deploy (${(selectedFields || currentProposal.fields.map(f => f.name)).length} fields)`);
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
                        onChange: e => this.updatePlanObject({sharingModel: e.target.value})
                      },
                        ["ReadWrite", "Read", "Private", "ReadWriteTransfer", "FullAccess"].map(s =>
                          h("option", {key: s, value: s}, s))
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
                    h("span", {className: "meta-item"}, `Name Field: ${currentProposal.object.nameField?.label || "Name"} (${currentProposal.object.nameField?.type || "Text"})`),
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
                `${selectedFields?.length || currentProposal.fields.length} of ${currentProposal.fields.length} fields selected`
              )
            ),

            currentProposal.recordTypes && currentProposal.recordTypes.length > 0 && h("div", {className: "fields-section"},
              h("div", {className: "fields-header"},
                h("h4", null, `Record Types (${currentProposal.recordTypes.length})`),
                h("div", {className: "field-select-actions"},
                  h("button", {
                    className: "btn btn-secondary btn-sm",
                    disabled: deploymentStatus !== "complete" || recordTypesDone,
                    title: deploymentStatus !== "complete"
                      ? "Deploy the object first, then create record types"
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
                "\u26a0 Deployment completed with errors"
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
                  ? `Tab visibility is Default On for ${selectedProfiles?.length || 0} selected profile(s). The tab is ready — open it from App Launcher search, Setup → Tabs, or the object's Salesforce URL. To pin it onto an app's navigation bar, use the header Inspector → App Tabs tool.`
                  : "Tab visibility is Default On on all profiles. The tab is ready — open it from App Launcher search, Setup → Tabs, or the object's Salesforce URL. To pin it onto an app's navigation bar, use the header Inspector → App Tabs tool."
              ),

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
          href: "https://rakesh-attri.github.io/BhajanMandali/",
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
  function initApp() {
    // Listen for save-state request from sidebar content script before close
    window.addEventListener("message", (e) => {
      if (e.data?.type === "sfoc-save-state") {
        if (window.__sfocApp) {
          window.__sfocApp._saveState();
          saveInspectorState(sfHost, window.__sfocApp.state);
        }
      }
      if (e.data?.type === "sfoc-api-names-state" && window.__sfocApp) {
        window.__sfocApp.setState({apiNamesOn: !!e.data.on});
      }
    });

    const root = ReactDOM.render(
      h(App, {sfHost}),
      document.getElementById("root"),
      function() { window.__sfocApp = this; }
    );
  }

  // Check if session was passed via postMessage from sidebar content script
  const pendingSession = sessionStorage.getItem(sfHost + "_sidebar_session");
  if (pendingSession) {
    try {
      const session = JSON.parse(pendingSession);
      sfConn.sessionId = session.key;
      sfConn.instanceHostname = session.hostname || sfHost;
      sessionStorage.removeItem(sfHost + "_sidebar_session");
      initApp();
    } catch (e) {
      sfConn.getSession(sfHost).then(initApp);
    }
  } else {
    window.addEventListener("message", function sessionHandler(e) {
      if (e.data && e.data.type === "sfoc-session-data" && e.data.session) {
        window.removeEventListener("message", sessionHandler);
        sfConn.sessionId = e.data.session.key;
        sfConn.instanceHostname = e.data.session.hostname || e.data.sfHost || sfHost;
        initApp();
      }
    });
    // Fallback: try normal session flow (standalone tab)
    sfConn.getSession(sfHost).then(initApp);
  }
}
