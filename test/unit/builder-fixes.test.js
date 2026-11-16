import {test} from "node:test";
import assert from "node:assert/strict";
import {isSfId, matchProfileFullName} from "../../addon/builder/deploy-helpers.js";
import {escXml, buildFieldXml} from "../../addon/builder/metadata-xml.js";
import {lintApex, lintLwcJs} from "../../addon/core/apex-lint.js";
import {removeEmptyLayoutColumns, fixCustomLinksWithFields, layoutNeedsRepair, ensureLayoutCustomLinks} from "../../addon/builder/layout-repair.js";
import {loadChatHistory, saveChatHistory, CHAT_HISTORY_KEY} from "../../addon/builder/chat-history.js";

// ---- deploy-helpers -------------------------------------------------------

test("isSfId: all-letter 15/18-char profile names are not Ids", () => {
  for (const name of ["ContractManager", "SolutionManager", "CustomerSupport", "AbcdefghijklmnopQR"]) {
    assert.equal(isSfId(name), false, name);
  }
  assert.equal(isSfId("02u5g000000abcD"), true);
  assert.equal(isSfId("02u5g000000abcDAAQ"), true);
  assert.equal(isSfId("Admin"), false);
});

test("matchProfileFullName: standard aliases and no loose prefix match", () => {
  const names = ["Admin", "Standard", "StandardAul", "Sales", "MarketingProfile", "ContractManager",
    "SolutionManager", "ReadOnly", "Partner Community User", "Customer Community User", "Chatter Free User"];
  const cases = {
    "System Administrator": "Admin",
    "Standard User": "Standard",
    "Standard Platform User": "StandardAul",
    "Marketing User": "MarketingProfile",
    "Marketing User (API)": "MarketingProfile",
    "Contract Manager": "ContractManager",
    "Solution Manager": "SolutionManager",
    "Read Only": "ReadOnly",
    "Partner Community User": "Partner Community User",
    "Customer Community User": "Customer Community User",
    "Chatter Free User": "Chatter Free User",
    "sales": "Sales"
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(matchProfileFullName(label, names), want, label);
  assert.equal(matchProfileFullName("Sales Manager", names), null);
  assert.equal(matchProfileFullName("Standard Platform User", ["Standard"]), null);
});

// ---- metadata-xml ---------------------------------------------------------

test("escXml strips XML-1.0-invalid control characters, keeps tab/LF/CR", () => {
  assert.equal(escXml("a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\t\n\r<"), "abcdef\t\n\r&lt;");
});

test("numeric field values are coerced and clamped", () => {
  const text = buildFieldXml("A__c", {name: "T__c", label: "T", type: "Text", length: "500</met:length><x>"});
  assert.match(text, /<met:length>255<\/met:length>/);
  assert.doesNotMatch(text, /<x>/);
  assert.match(buildFieldXml("A__c", {name: "T__c", label: "T", type: "Text", length: "abc"}), /<met:length>255</);
  assert.match(buildFieldXml("A__c", {name: "T__c", label: "T", type: "Text", length: 0}), /<met:length>1</);
  const lta = buildFieldXml("A__c", {name: "L__c", label: "L", type: "LongTextArea", length: 999999, visibleLines: "9x"});
  assert.match(lta, /<met:length>131072</);
  assert.match(lta, /<met:visibleLines>9</);
  assert.match(buildFieldXml("A__c", {name: "L__c", label: "L", type: "LongTextArea", length: 10}), /<met:length>256</);
  const num = buildFieldXml("A__c", {name: "N__c", label: "N", type: "Number", precision: 40, scale: 30});
  assert.match(num, /<met:precision>18</);
  assert.match(num, /<met:scale>18</);
});

test("formula Currency/Percent scale respects 0", () => {
  const f = buildFieldXml("A__c", {name: "F__c", label: "F", type: "Formula", returnType: "Currency", formula: "1", scale: 0});
  assert.match(f, /<met:scale>0<\/met:scale>/);
  const d = buildFieldXml("A__c", {name: "F__c", label: "F", type: "Formula", returnType: "Percent", formula: "1"});
  assert.match(d, /<met:scale>2<\/met:scale>/);
});

test("EncryptedText maskType / maskChar are whitelisted", () => {
  const bad = buildFieldXml("A__c", {name: "E__c", label: "E", type: "EncryptedText", maskType: "<evil/>", maskChar: "#"});
  assert.match(bad, /<met:maskType>all</);
  assert.match(bad, /<met:maskChar>asterisk</);
  assert.match(buildFieldXml("A__c", {name: "E__c", label: "E", type: "EncryptedText", maskType: "lastFour", maskChar: "X"}), /<met:maskChar>X<[\s\S]*<met:maskType>lastFour</);
});

// ---- apex-lint ------------------------------------------------------------

test("strings with // or /* do not start comments", () => {
  const code = "String u = 'http://x';\nString c = '/*';\nTest.getSentEmailMessages();\nString e = '*/';";
  const out = lintApex(code);
  assert.equal(out.length, 1);
  assert.equal(out[0].line, 3);
  // A quote inside a comment does not start a string.
  assert.equal(lintApex("// it's fine\nJSON.parse(x);")[0].line, 2);
  // LWC: comment markers inside strings are kept as strings.
  assert.deepEqual(lintLwcJs("const u = 'http://x'; import { ShowToastEvent } from 'lightning/platformShowToastEvent';"), []);
});

test("argCount ignores => in map literals", () => {
  const ok = "List<SObject> r = Database.queryWithBinds(q, new Map<String,Object>{'n' => n}, AccessLevel.USER_MODE);";
  assert.deepEqual(lintApex(ok), []);
  assert.match(lintApex("Database.queryWithBinds(q, new Map<String,Object>{'n' => n});")[0].message, /queryWithBinds/);
});

test("pathological input lints fast", () => {
  for (const big of ["[SELECT ".repeat(64000), "@AuraEnabled(cacheable=true) ".repeat(17000),
    "@AuraEnabled(cacheable=true) {".repeat(17000), "/*".repeat(250000), "@isTest(".repeat(60000)]) {
    const t = Date.now();
    lintApex(big);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  }
  const t = Date.now();
  lintLwcJs("this.template.querySelector(".repeat(20000) + "import {".repeat(20000));
  assert.ok(Date.now() - t < 1000);
});

// ---- layout-repair (minimal DOM) -------------------------------------------

class El {
  constructor(doc, tag, text) {
    this.ownerDocument = doc; this.localName = tag; this.nodeType = 1; this.childNodes = [];
    this._text = text || "";
  }
  get textContent() { return this.childNodes.length ? this.childNodes.map(c => c.textContent).join("") : this._text; }
  set textContent(v) { this.childNodes = []; this._text = v; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
  }
  setAttributeNS() {}
}
const doc = {createElement: tag => new El(doc, tag)};
const el = (tag, ...kids) => {
  const e = new El(doc, tag, typeof kids[0] === "string" ? kids[0] : "");
  for (const k of kids) if (typeof k !== "string") e.appendChild(k);
  return e;
};
const item = f => el("layoutItems", el("behavior", "Edit"), el("customLink"), el("field", f));
const fieldsIn = col => col.childNodes.map(li => li.childNodes.find(c => c.localName === "field").textContent);

test("empty column in a used section is kept so the right column stays right", () => {
  const sec = el("layoutSections", el("layoutColumns"), el("layoutColumns", item("B__c")), el("style", "TwoColumnsTopToBottom"));
  const root = el("Layout", sec);
  assert.equal(layoutNeedsRepair(root), false);
  removeEmptyLayoutColumns(root);
  const cols = sec.childNodes.filter(c => c.localName === "layoutColumns");
  assert.equal(cols.length, 2);
  assert.deepEqual(fieldsIn(cols[1]), ["B__c"]);
  // A section whose columns are all empty is still cleaned up.
  const empty = el("layoutSections", el("layoutColumns"), el("layoutColumns"));
  const root2 = el("Layout", empty);
  assert.equal(layoutNeedsRepair(root2), true);
  removeEmptyLayoutColumns(root2);
  assert.equal(empty.childNodes.length, 0);
});

test("CustomLinks → TwoColumnsTopToBottom merges extra columns into two", () => {
  const sec = el("layoutSections", el("label", "Links"),
    el("layoutColumns", item("A__c")), el("layoutColumns", item("B__c")), el("layoutColumns", item("C__c"), item("D__c")),
    el("style", "CustomLinks"));
  fixCustomLinksWithFields(el("Layout", sec));
  const cols = sec.childNodes.filter(c => c.localName === "layoutColumns");
  assert.equal(cols.length, 2);
  assert.deepEqual(fieldsIn(cols[0]), ["A__c"]);
  assert.deepEqual(fieldsIn(cols[1]), ["B__c", "C__c", "D__c"]);
  assert.equal(sec.childNodes.find(c => c.localName === "style").textContent, "TwoColumnsTopToBottom");
});

test("a missing customLink goes in schema order, before emptySpace / field", () => {
  const spacer = el("layoutItems", el("emptySpace", "true"), el("width", "10"));
  const fieldItem = el("layoutItems", el("behavior", "Edit"), el("field", "A__c"));
  const root = el("Layout", el("layoutSections", el("layoutColumns", spacer, fieldItem)));
  ensureLayoutCustomLinks(root);
  assert.deepEqual(spacer.childNodes.map(c => c.localName), ["customLink", "emptySpace", "width"]);
  assert.deepEqual(fieldItem.childNodes.map(c => c.localName), ["behavior", "customLink", "field"]);
});

test("a picklist can have no default; otherwise the first value stays the default", () => {
  const base = {name: "Status__c", label: "Status", type: "Picklist", values: ["Open", "Closed"]};
  const none = buildFieldXml("Invoice__c", {...base, noDefault: true});
  assert.ok(!none.includes("<met:default>true</met:default>"));
  assert.match(buildFieldXml("Invoice__c", base), /<met:fullName>Open<\/met:fullName>\s*<met:default>true/);
  assert.match(buildFieldXml("Invoice__c", {...base, defaultValue: "Closed", noDefault: true}),
    /<met:fullName>Closed<\/met:fullName>\s*<met:default>true/);
});

// ---- chat-history (fake localStorage with a byte quota) ---------------------

function fakeStorage(quota) {
  const m = new Map();
  const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      const old = m.get(k);
      m.set(k, String(v));
      if (size() > quota) { if (old === undefined) m.delete(k); else m.set(k, old); throw new Error("QuotaExceededError"); }
    },
    removeItem: k => m.delete(k)
  };
}
const chat = (id, ts) => ({id, timestamp: ts, messages: ["x".repeat(200)]});

test("loadChatHistory returns [] for a non-array value", () => {
  globalThis.localStorage = fakeStorage(1e6);
  globalThis.localStorage.setItem(CHAT_HISTORY_KEY + "_h", JSON.stringify({a: 1}));
  assert.deepEqual(loadChatHistory("h"), []);
  globalThis.localStorage.setItem(CHAT_HISTORY_KEY + "_h", "42");
  assert.deepEqual(loadChatHistory("h"), []);
});

test("saveChatHistory drops oldest chats (own host first, then others) on quota", () => {
  globalThis.localStorage = fakeStorage(1000);
  globalThis.localStorage.setItem(CHAT_HISTORY_KEY + "_other", JSON.stringify([chat("o1", 1), chat("o2", 50)]));
  assert.equal(saveChatHistory("h", [chat("c3", 30), chat("c2", 20), chat("c1", 10)]), true);
  const mine = loadChatHistory("h");
  assert.ok(mine.length >= 1 && mine.length < 3);
  assert.equal(mine[0].id, "c3");
  assert.ok(!mine.some(c => c.id === "c1"));
  // Own host down to one chat: other hosts give way, oldest first.
  globalThis.localStorage = fakeStorage(700);
  globalThis.localStorage.setItem(CHAT_HISTORY_KEY + "_other", JSON.stringify([chat("o1", 1), chat("o2", 50)]));
  assert.equal(saveChatHistory("h", [chat("big", 99)]), true);
  assert.deepEqual(loadChatHistory("other").map(c => c.id), ["o2"]);
  // Still too big → false.
  globalThis.localStorage = fakeStorage(100);
  assert.equal(saveChatHistory("h", [chat("big", 99)]), false);
  delete globalThis.localStorage;
});
