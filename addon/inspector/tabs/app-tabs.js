import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {escapeSoqlString} from "../../core/soql.js";
import {useFfSession} from "../shared/session-state.js";
import {appTabsResolveCurrentUserId} from "../shared/apex-debug.js";
import {SearchSelect} from "../shared/combo.js";

const h = React.createElement;

// ─── App Tab Manager ──────────────────────────────────────
// Standalone manager for Lightning app navigation tabs. Uses the Metadata
// API (SOAP) as the source of truth: apps are identified by their metadata
// DeveloperName (Tooling + listMetadata reconcile, never a display label),
// updates are full read-modify-write round-trips (partial CustomApplication
// writes would wipe fields), and every write is verified by a strict re-read
// loop — never a guess. Visibility writes go to Profile / PermissionSet
// tabVisibilities, which is where Salesforce actually stores them.
function appTabsIsSfId(v) {
  const s = String(v || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(s) || /^[a-zA-Z0-9]{18}$/.test(s);
}

function appTabsEscXml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function appTabsDomLocal(el) {
  if (!el) return "";
  return el.localName || String(el.tagName || "").split(":").pop();
}

function appTabsDomChildren(el) {
  if (!el || !el.childNodes) return [];
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}

function appTabsDomFind(root, local) {
  if (!root) return null;
  if (appTabsDomLocal(root) === local) return root;
  const stack = appTabsDomChildren(root);
  while (stack.length) {
    const el = stack.shift();
    if (appTabsDomLocal(el) === local) return el;
    stack.unshift(...appTabsDomChildren(el));
  }
  return null;
}

function appTabsDomFindAll(root, local, out) {
  out = out || [];
  if (!root) return out;
  if (appTabsDomLocal(root) === local) out.push(root);
  for (const c of appTabsDomChildren(root)) appTabsDomFindAll(c, local, out);
  return out;
}

function appTabsDomToMetXml(el) {
  const tag = appTabsDomLocal(el);
  let attrs = "";
  if (el.attributes) {
    for (const a of Array.from(el.attributes)) {
      if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      attrs += ` ${a.name}="${appTabsEscXml(a.value)}"`;
    }
  }
  const kids = appTabsDomChildren(el);
  let text = "";
  for (const n of Array.from(el.childNodes || [])) {
    if (n.nodeType === 3 || n.nodeType === 4) text += n.data;
  }
  if (kids.length > 0) {
    if (text.trim() === "") text = "";
    else text = appTabsEscXml(text);
    return `<met:${tag}${attrs}>${text}${kids.map(appTabsDomToMetXml).join("")}</met:${tag}>`;
  }
  if (text === "") return `<met:${tag}${attrs}/>`;
  return `<met:${tag}${attrs}>${appTabsEscXml(text)}</met:${tag}>`;
}

// Children that must follow <tabs> in CustomApplication XSD sequence.
const APP_TABS_AFTER = new Set([
  "uiType", "workspace", "actionOverrides", "profileActionOverrides",
  "objectTabs", "listViews", "navType", "formFactors", "brand", "brandColor",
  "customTab", "logo", "palette", "platform", "urlTarget", "type",
  "showInAppLauncher", "showInMobileSearch", "showLightningRuntime",
  "ssoAttemptLogin", "headerColor", "dataServiceUrl", "scriptLocs",
  "oAuthCustomScope", "platformActionOverrides", "microsite"
]);

let _appTabsDebug = null;
function appTabsNote(action, requestXml, responseText) {
  try {
    _appTabsDebug = {
      action,
      request: String(requestXml || "").slice(-4000),
      response: String(responseText || "").slice(0, 4000)
    };
  } catch (e) { /* ignore */ }
}

async function appTabsSoapPost(bodyInnerXml, timeoutMs) {
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "text/xml", "SOAPAction": '""'},
      body: envelope,
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    appTabsNote("soap", bodyInnerXml, "FETCH FAILED: " + (e.message || e));
    throw new Error(e.name === "AbortError" ? "Request timed out after 60s" : "Network error: " + e.message);
  }
  clearTimeout(timer);
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    appTabsNote("soap", bodyInnerXml, text);
    throw new Error("Failed to parse Metadata API response XML");
  }
  const fault = appTabsDomFind(doc.documentElement, "Fault");
  if (fault) {
    const fs = appTabsDomFind(fault, "faultstring");
    appTabsNote("soap", bodyInnerXml, text);
    throw new Error(fs ? fs.textContent : "Metadata API SOAP fault");
  }
  return {doc, text};
}

async function appTabsReadRecords(fullName) {
  const body = `<met:readMetadata><met:type>CustomApplication</met:type>` +
    `<met:fullNames>${appTabsEscXml(fullName)}</met:fullNames></met:readMetadata>`;
  const {doc} = await appTabsSoapPost(body);
  return appTabsDomFind(doc.documentElement, "records") || null;
}

// listMetadata entries with fileProperties (fullName + createdDate) — the
// createdDate drives the "recently created" highlight on org tabs.
async function appTabsListMetadata(type) {
  const body = `<met:listMetadata><met:queries><met:type>${appTabsEscXml(type)}</met:type></met:queries></met:listMetadata>`;
  const {doc} = await appTabsSoapPost(body);
  const entries = [];
  for (const fp of appTabsDomFindAll(doc.documentElement, "fileProperties")) {
    const fn = appTabsDomFind(fp, "fullName");
    if (fn && fn.textContent) {
      const cd = appTabsDomFind(fp, "createdDate");
      entries.push({
        fullName: fn.textContent.trim(),
        createdDate: cd && cd.textContent ? cd.textContent.trim() : null
      });
    }
  }
  if (!entries.length) {
    for (const fn of appTabsDomFindAll(doc.documentElement, "fullName")) {
      if (fn.textContent) entries.push({fullName: fn.textContent.trim(), createdDate: null});
    }
  }
  return entries;
}

async function appTabsListMetadataFullNames(type) {
  return (await appTabsListMetadata(type)).map(e => e.fullName);
}

async function appTabsUpdateMetadataRaw(xml) {
  const body = `<met:updateMetadata>${xml}</met:updateMetadata>`;
  const {doc, text} = await appTabsSoapPost(body);
  appTabsNote("updateMetadata", xml, text);
  const resultEl = doc.querySelector("result");
  if (resultEl) {
    const successEl = resultEl.querySelector("success");
    const errorsEl = resultEl.querySelector("errors");
    const success = successEl ? successEl.textContent : "true";
    if (success === "false" && errorsEl) {
      const msgEl = errorsEl.querySelector("message");
      throw new Error(msgEl ? msgEl.textContent : "Metadata API returned error");
    }
    return;
  }
  const faultEl = doc.querySelector("faultstring");
  if (faultEl) throw new Error(faultEl.textContent);
  throw new Error("Could not parse updateMetadata response: " + text.substring(0, 300));
}

async function appTabsUpdateRecords(fullName, recordsEl) {
  if (appTabsIsSfId(fullName)) {
    throw new Error(`Refusing updateMetadata: "${fullName}" is a Salesforce Id, not a metadata name`);
  }
  const parts = [];
  for (const child of appTabsDomChildren(recordsEl)) {
    if (appTabsDomLocal(child) === "fullName") continue;
    parts.push(appTabsDomToMetXml(child));
  }
  const xml = `<met:metadata xsi:type="met:CustomApplication">` +
    `<met:fullName>${appTabsEscXml(fullName)}</met:fullName>${parts.join("")}</met:metadata>`;
  return appTabsUpdateMetadataRaw(xml);
}

const appTabsDelay = ms => new Promise(r => setTimeout(r, ms));

function appTabsNormName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Visibility writes live on Profile / PermissionSet tabVisibilities — the
// only places Salesforce stores per-user tab visibility. Values: DefaultOn,
// DefaultOff, Hidden.
async function appTabsSetTabVisibility(metadataType, fullName, tabApiName, visibility) {
  const xml = `<met:metadata xsi:type="met:${metadataType}">` +
    `<met:fullName>${appTabsEscXml(fullName)}</met:fullName>` +
    `<met:tabVisibilities><met:tab>${appTabsEscXml(tabApiName)}</met:tab>` +
    `<met:visibility>${appTabsEscXml(visibility)}</met:visibility></met:tabVisibilities></met:metadata>`;
  await appTabsUpdateMetadataRaw(xml);
  await appTabsDelay(600);
}

// Profile label → metadata fullName ("System Administrator" → "Admin").
async function appTabsResolveProfileFullName(label) {
  let names = [];
  try {
    names = await appTabsListMetadataFullNames("Profile");
  } catch (e) {
    console.warn("[SaralForce] AppTabManager profile listMetadata failed:", e.message);
  }
  const targets = [appTabsNormName(label)];
  if (targets.includes("systemadministrator")) targets.push("admin");
  return names.find(n => targets.includes(appTabsNormName(n))) ||
    names.find(n => {
      const nn = appTabsNormName(n);
      return nn && targets.some(t => nn.startsWith(t) || t.startsWith(nn));
    }) || label;
}

// Set tabVisibilities DefaultOn for the running user's profile so the tab
// shows in App Launcher search. Returns the profile fullName written.
async function appTabsEnsureTabVisibleForMe(tabApiName) {
  const userId = await appTabsResolveCurrentUserId();
  const ures = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(`SELECT ProfileId FROM User WHERE Id = '${userId}'`), {useCache: false});
  const pid = ures?.records?.[0]?.ProfileId;
  if (!pid) throw new Error("Could not determine your profile (User.ProfileId missing)");
  const pres = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${pid}'`), {useCache: false});
  const label = pres?.records?.[0]?.Name;
  if (!label) throw new Error("Could not determine your profile name");
  const fullName = await appTabsResolveProfileFullName(label);
  await appTabsSetTabVisibility("Profile", fullName, tabApiName, "DefaultOn");
  appTabsInvalidateProfileVis(fullName);
  return fullName;
}

// Current user's profile tab visibility map {tab: DefaultOn|DefaultOff|Hidden}.
// One readMetadata(Profile) per profile per session — cached; big orgs make
// this the heaviest call in the tab, so it is only triggered by the table.
const _appTabsProfileVisCache = {};
async function appTabsReadProfileVisibilities(profileFullName) {
  if (Object.prototype.hasOwnProperty.call(_appTabsProfileVisCache, profileFullName)) {
    return _appTabsProfileVisCache[profileFullName];
  }
  const body = `<met:readMetadata><met:type>Profile</met:type>` +
    `<met:fullNames>${appTabsEscXml(profileFullName)}</met:fullNames></met:readMetadata>`;
  const {doc} = await appTabsSoapPost(body, 90000);
  const rec = appTabsDomFind(doc.documentElement, "records");
  const map = {};
  if (rec) {
    for (const tv of appTabsDomFindAll(rec, "tabVisibilities")) {
      const t = appTabsDomFind(tv, "tab");
      const v = appTabsDomFind(tv, "visibility");
      if (t && t.textContent) map[t.textContent.trim()] = v && v.textContent ? v.textContent.trim() : "";
    }
  }
  _appTabsProfileVisCache[profileFullName] = map;
  return map;
}

function appTabsInvalidateProfileVis(profileFullName) {
  delete _appTabsProfileVisCache[profileFullName];
}

async function appTabsTabExists(tabApiName) {
  const want = String(tabApiName || "").trim().toLowerCase();
  if (!want) return false;
  try {
    const names = await appTabsListMetadataFullNames("CustomTab");
    if (names.some(n => String(n).trim().toLowerCase() === want)) return true;
  } catch (e) {
    console.warn("[SaralForce] AppTabManager tab-exists listMetadata failed:", e.message);
  }
  try {
    const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
      encodeURIComponent(
        `SELECT DeveloperName FROM CustomTab WHERE DeveloperName = '${escapeSoqlString(String(tabApiName).trim())}' LIMIT 1`),
      {useCache: false});
    if (res.records && res.records.length) return true;
  } catch (e) {
    console.warn("[SaralForce] AppTabManager tab-exists Tooling failed:", e.message);
  }
  return false;
}

function appTabsOfRecords(recordsEl) {
  const tabs = [];
  if (!recordsEl) return tabs;
  for (const child of appTabsDomChildren(recordsEl)) {
    if (appTabsDomLocal(child) === "tabs" && child.textContent) {
      tabs.push(child.textContent.trim());
    }
  }
  return tabs;
}

async function appTabsLoadApps() {
  const apps = [];
  const seen = new Set();
  const push = (fullName, label) => {
    const fn = String(fullName || "").trim();
    if (!fn || appTabsIsSfId(fn)) return;
    const key = fn.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    apps.push({fullName: fn, label: String(label || fn).trim() || fn});
  };
  const queries = [
    "SELECT Id, DeveloperName, Name FROM CustomApplication ORDER BY Name",
    "SELECT Id, DeveloperName, MasterLabel FROM CustomApplication ORDER BY MasterLabel",
    "SELECT Id, DeveloperName FROM CustomApplication ORDER BY DeveloperName"
  ];
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const rows = res.records || [];
      if (!rows.length) continue;
      for (const a of rows) {
        push(a.DeveloperName, a.Name || a.MasterLabel || a.DeveloperName);
      }
      if (apps.length) break;
    } catch (e) {
      console.warn("[SaralForce] AppTabManager Tooling query failed:", e.message);
    }
  }
  // Reconcile with listMetadata truth: standard apps (ServiceConsole, Sales…)
  // have metadata fullNames like standard__ServiceConsole while Tooling
  // returns the bare DeveloperName — updating the bare name fails with
  // "no CustomApplication named X found".
  try {
    const names = await appTabsListMetadataFullNames("CustomApplication");
    const nameSet = new Set(names.map(n => String(n).toLowerCase()));
    for (const a of apps) {
      if (!nameSet.has(a.fullName.toLowerCase())) {
        const prefixed = "standard__" + a.fullName;
        if (nameSet.has(prefixed.toLowerCase())) {
          console.log(`[SaralForce] AppTabManager standard prefix: ${a.fullName} → ${prefixed}`);
          seen.delete(a.fullName.toLowerCase());
          a.fullName = prefixed;
          seen.add(prefixed.toLowerCase());
        }
      }
    }
    for (const n of names) {
      push(n, n);
    }
  } catch (e) {
    console.warn("[SaralForce] AppTabManager listMetadata reconcile failed:", e.message);
  }
  apps.sort((a, b) => a.label.localeCompare(b.label));
  if (!apps.length) throw new Error("No apps found (Tooling + listMetadata both empty)");
  return apps;
}

// Org tabs (custom object / visualforce / page tabs) with labels and
// createdDate (from listMetadata fileProperties) for the recent highlight.
async function appTabsLoadCustomTabs() {
  const tabs = [];
  const seen = new Set();
  const push = (apiName, label, createdDate) => {
    const n = String(apiName || "").trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tabs.push({
      apiName: n,
      label: String(label || n).trim() || n,
      createdDate: createdDate || null
    });
  };
  const queries = [
    "SELECT Id, DeveloperName, MasterLabel FROM CustomTab ORDER BY MasterLabel",
    "SELECT Id, DeveloperName, Name FROM CustomTab ORDER BY Name"
  ];
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const rows = res.records || [];
      if (!rows.length) continue;
      for (const t of rows) {
        push(t.DeveloperName, t.MasterLabel || t.Name || t.DeveloperName, null);
      }
      if (tabs.length) break;
    } catch (e) {
      console.warn("[SaralForce] AppTabManager CustomTab query failed:", e.message);
    }
  }
  try {
    const entries = await appTabsListMetadata("CustomTab");
    for (const e of entries) push(e.fullName, e.fullName, e.createdDate);
    // listMetadata entries carry the real createdDate — merge onto rows
    // that were found via Tooling first.
    for (const t of tabs) {
      if (t.createdDate) continue;
      const hit = entries.find(e => e.fullName.toLowerCase() === t.apiName.toLowerCase());
      if (hit) t.createdDate = hit.createdDate;
    }
  } catch (e) {
    console.warn("[SaralForce] AppTabManager listMetadata CustomTab failed:", e.message);
  }
  tabs.sort((a, b) => a.label.localeCompare(b.label));
  return tabs;
}

// Resolve the EXACT app from pasted text: an App Manager URL, a setup page
// URL, or a bare record Id. CustomApplication Ids start with 02u. Returns
// {id, fullName, label} — the metadata DeveloperName, never a guess from
// a duplicated display label.
async function appTabsResolveAppByRecordId(pasted) {
  const text = String(pasted || "");
  const m = text.match(/02u[a-zA-Z0-9]{12,15}/);
  if (!m) {
    throw new Error(
      "No app record Id found in that text. Open App Manager → click the dropdown next to the app → the page URL contains its Id (starts with 02u) — paste the full URL here.");
  }
  const id = m[0];
  const queries = [
    `SELECT Id, DeveloperName, Name FROM CustomApplication WHERE Id = '${id}'`,
    `SELECT Id, DeveloperName, MasterLabel FROM CustomApplication WHERE Id = '${id}'`
  ];
  let lastErr = null;
  for (const soql of queries) {
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const row = res.records && res.records[0];
      if (row && row.DeveloperName) {
        // Tooling returns the bare DeveloperName for standard apps while
        // metadata writes need the standard__ prefix (same reconcile as
        // appTabsLoadApps) — otherwise readMetadata comes back empty.
        let fullName = row.DeveloperName;
        try {
          const names = await appTabsListMetadataFullNames("CustomApplication");
          const set = new Set(names.map(n => String(n).toLowerCase()));
          if (!set.has(fullName.toLowerCase()) && set.has(("standard__" + fullName).toLowerCase())) {
            fullName = "standard__" + fullName;
          }
        } catch (e) { /* keep the bare name */ }
        return {
          id,
          fullName,
          label: row.Name || row.MasterLabel || row.DeveloperName
        };
      }
      lastErr = new Error(`Id ${id} is not a CustomApplication record`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Could not resolve app Id ${id}`);
}

// Shared read-modify-write for the app's tab list. desired = the ordered
// array of tab API names the app should end up with; every other field of
// the CustomApplication is preserved verbatim. Console apps get workspace
// mappings ensured for every desired tab. Verification is a strict re-read
// loop (metadata can lag right after a write) — throws an actionable error
// when the server state never matches. Returns {writeName, tabs}.
async function appTabsWriteTabList(fullName, desired, opts) {
  opts = opts || {};
  const verifyTab = opts.verifyTab || null;   // tab that must be present
  const action = opts.action || "update";     // "add" | "remove" | "reorder"
  const records = opts.recordsEl || await appTabsReadRecords(fullName);
  if (!records) {
    throw new Error(
      `Could not read CustomApplication metadata for "${fullName}". ` +
      `Open Setup → App Manager → edit the app and confirm its Developer Name.`);
  }
  // Trust the fullName inside the returned records (never an Id).
  const fnEl = appTabsDomFind(records, "fullName");
  const realName = fnEl && fnEl.textContent && !appTabsIsSfId(fnEl.textContent)
    ? fnEl.textContent.trim()
    : fullName;
  const doc = records.ownerDocument;
  let insertParent = null;
  let insertRef = null;
  let lastTabsEl = null;
  for (const child of appTabsDomChildren(records)) {
    if (appTabsDomLocal(child) === "tabs") lastTabsEl = child;
  }
  if (lastTabsEl && lastTabsEl.parentNode) {
    insertParent = lastTabsEl.parentNode;
    insertRef = lastTabsEl.nextSibling;
  } else {
    insertParent = records;
    insertRef = null;
    for (const child of appTabsDomChildren(records)) {
      const ln = appTabsDomLocal(child);
      if (ln === "tabs" || ln === "fullName") continue;
      if (APP_TABS_AFTER.has(ln)) {
        insertRef = child;
        break;
      }
    }
  }
  for (const child of [...appTabsDomChildren(records)]) {
    if (appTabsDomLocal(child) === "tabs") child.remove();
  }
  const tabEls = desired.map(t => {
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
  // Console apps (Service Console…) reject any tab without a workspace
  // mapping: "The X tab doesn't include a workspace mapping." Ensure
  // every desired tab has one before writing.
  {
    let ws = appTabsDomFind(records, "workspaceConfig");
    const navTypeEl = appTabsDomFind(records, "navType");
    const isConsole = !!ws ||
      (navTypeEl && /console/i.test(navTypeEl.textContent || ""));
    if (isConsole) {
      if (!ws) {
        // workspaceConfig sits last in CustomApplication XSD order.
        ws = doc.createElement("workspaceConfig");
        records.appendChild(ws);
      }
      const mapped = new Set();
      for (const m of appTabsDomChildren(ws)) {
        if (appTabsDomLocal(m) !== "mappings") continue;
        const t = appTabsDomFind(m, "tab");
        if (t && t.textContent) mapped.add(t.textContent.trim());
      }
      for (const t of desired) {
        if (mapped.has(t)) continue;
        const mapping = doc.createElement("mappings");
        const tabEl = doc.createElement("tab");
        tabEl.textContent = t;
        mapping.appendChild(tabEl);
        ws.appendChild(mapping);
        mapped.add(t);
      }
      console.log(`[SaralForce] AppTabManager workspace mappings ensured for console app (${mapped.size} mapped)`);
    }
  }
  // Standard apps must be written as standard__Name — retry with the
  // prefix when Salesforce says the bare DeveloperName doesn't exist.
  let writeName = realName;
  try {
    await appTabsUpdateRecords(writeName, records);
  } catch (ue) {
    if (/no CustomApplication named/i.test(ue.message || "") &&
        !/^standard__/i.test(writeName)) {
      writeName = "standard__" + writeName;
      console.log(`[SaralForce] AppTabManager retrying update as "${writeName}"`);
      await appTabsUpdateRecords(writeName, records);
    } else {
      throw ue;
    }
  }
  // Strict verify: re-read until the exact desired list shows up (metadata
  // can lag). Always verify against the name that was actually written.
  let postTabs = [];
  let ok = false;
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const verify = await appTabsReadRecords(writeName);
    postTabs = appTabsOfRecords(verify);
    console.log(`[SaralForce] AppTabManager verify "${writeName}" attempt ${i + 1}: tabs=[${postTabs.join(", ")}]`);
    const sameOrder = postTabs.length === desired.length &&
      desired.every((t, idx) => postTabs[idx] === t);
    if (sameOrder && (!verifyTab || postTabs.includes(verifyTab))) { ok = true; break; }
  }
  if (!ok) {
    throw new Error(
      `Update reported success but the ${action} could not be verified on "${writeName}" after 4 re-reads ` +
      `(wanted: ${desired.join(", ") || "none"}; tabs now: ${postTabs.join(", ") || "none"}). ` +
      `Most likely causes: (1) this is not the Developer Name of the app you open — check Setup → App Manager; ` +
      `(2) the app uses an App Page / managed navigation instead of CustomApplication tabs. ` +
      `Use Copy debug below and compare with App Manager → Navigation Items.`);
  }
  return {writeName, tabs: postTabs};
}

// One-shot handoff from the AI Object Builder → App Tab Manager. The
// module flag covers the same-frame sidebar; localStorage covers the
// "Inspector in a new tab" mode (fresh document, no shared module state).
// The manager consumes it on mount and NEVER writes anything without an
// explicit user approval click.
export const ffAppTabPrefill = {data: null};
export function ffSetAppTabPrefill(tabApiName, objectApiName) {
  const p = {tabApiName: String(tabApiName || ""), objectApiName: objectApiName || null, ts: Date.now()};
  ffAppTabPrefill.data = p;
  try { localStorage.setItem("ffAppTabPrefill", JSON.stringify(p)); } catch (e) { /* ignore */ }
  // Same-frame listeners (AppTabManager may already be mounted).
  try { window.dispatchEvent(new CustomEvent("ff-apptabs-prefill")); } catch (e) { /* ignore */ }
}

function ffHasAppTabPrefill() {
  if (ffAppTabPrefill.data) return true;
  try { return !!localStorage.getItem("ffAppTabPrefill"); } catch (e) { return false; }
}

// Tab metadata for the label/type columns.
const APP_TABS_STD_LABELS = {
  "standard-home": "Home",
  "standard-Account": "Accounts",
  "standard-Opportunity": "Opportunities",
  "standard-Contact": "Contacts",
  "standard-Lead": "Leads",
  "standard-Case": "Cases",
  "standard-Dashboard": "Dashboards",
  "standard-Report": "Reports",
  "standard-Quote": "Quotes",
  "standard-Contract": "Contracts",
  "standard-Order": "Orders",
  "standard-Forecast": "Forecasts",
  "standard-Calendar": "Calendar",
  "standard-Task": "Activities",
  "standard-File": "Files",
  "standard-Knowledge": "Knowledge",
  "standard-Macro": "Macros",
  "standard-InvocableAction": "Actions",
  "standard-Campaign": "Campaigns",
  "standard-Social": "Social",
  "standard-Asset": "Assets",
  "standard-Product2": "Products",
  "standard-Apex": "Developer Console"
};

function appTabsLabelFor(apiName, customTabs) {
  const hit = (customTabs || []).find(t => t.apiName.toLowerCase() === String(apiName).toLowerCase());
  if (hit) return hit.label;
  return APP_TABS_STD_LABELS[apiName] || apiName;
}

function appTabsKindFor(apiName) {
  const n = String(apiName || "");
  if (/^standard-/i.test(n)) return "Standard";
  if (/__c$|__kav$|__x$|__mdt$|__e$/i.test(n)) return "Custom Object";
  return "Custom";
}

function appTabsAppType(fullName) {
  return /^standard__/i.test(String(fullName || "")) ? "Standard" : "Custom";
}

// Recently-created window for the org-tab highlight (45 days).
const APP_TABS_RECENT_MS = 45 * 24 * 3600 * 1000;
function appTabsIsRecent(createdDate) {
  if (!createdDate) return false;
  const t = Date.parse(createdDate);
  return !isNaN(t) && (Date.now() - t) < APP_TABS_RECENT_MS;
}

function AppTabManager() {
  const [apps, setApps] = useFfSession("apptabs", "apps", []);
  const [appsLoading, setAppsLoading] = React.useState(false);
  const [sel, setSel] = useFfSession("apptabs", "sel", "");
  const [customTabs, setCustomTabs] = useFfSession("apptabs", "customTabs", []);
  const [tabsLoading, setTabsLoading] = React.useState(false);
  const [tabName, setTabName] = useFfSession("apptabs", "tabName", "");
  const [currentTabs, setCurrentTabs] = useFfSession("apptabs", "currentTabs", null);
  const [currentLoading, setCurrentLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [visWorking, setVisWorking] = React.useState(false);
  const [resolving, setResolving] = React.useState(false);
  const [appRef, setAppRef] = useFfSession("apptabs", "appRef", "");
  const [refMsg, setRefMsg] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [debug, setDebug] = React.useState("");
  // App Tab Manager: search filters, table, visibility, prefill.
  const [alsoVisible, setAlsoVisible] = React.useState(true);
  const [listQuery, setListQuery] = React.useState("");
  const [moveBusy, setMoveBusy] = React.useState(null);
  const [confirmRm, setConfirmRm] = React.useState(null);
  const [profileVis, setProfileVis] = React.useState(null);      // {tab: vis} | {} | null (loading)
  const [profileVisName, setProfileVisName] = React.useState("");
  const [visTab, setVisTab] = useFfSession("apptabs", "visTab", "");
  const [visValue, setVisValue] = React.useState("DefaultOn");
  const [visProfiles, setVisProfiles] = React.useState([]);
  const [visPsets, setVisPsets] = React.useState([]);
  const [profileList, setProfileList] = React.useState([]);
  const [psetList, setPsetList] = React.useState([]);
  const [targetsLoading, setTargetsLoading] = React.useState(false);
  const [visMsg, setVisMsg] = React.useState(null);
  const [visErr, setVisErr] = React.useState(null);
  const [visTargetsBusy, setVisTargetsBusy] = React.useState(false);
  const [prefill, setPrefill] = React.useState(null);            // {tabApiName, objectApiName}
  const [prefillCheck, setPrefillCheck] = React.useState(null);  // {exists: bool|null}

  const loadAll = async () => {
    setAppsLoading(true);
    setTabsLoading(true);
    setError(null);
    try {
      const [a, t] = await Promise.all([appTabsLoadApps(), appTabsLoadCustomTabs()]);
      setApps(a);
      setCustomTabs(t);
      if (!sel && a.length) setSel(a[0].fullName);
    } catch (e) {
      setError(e.message);
    } finally {
      setAppsLoading(false);
      setTabsLoading(false);
    }
  };

  React.useEffect(() => { loadAll(); }, []);

  const refreshCurrent = async (fullName) => {
    const fn = fullName || sel;
    if (!fn) return;
    setCurrentLoading(true);
    setError(null);
    try {
      const rec = await appTabsReadRecords(fn);
      if (!rec) throw new Error(`Could not read CustomApplication metadata for "${fn}"`);
      setCurrentTabs(appTabsOfRecords(rec));
    } catch (e) {
      setError(e.message);
      setCurrentTabs(null);
    } finally {
      setCurrentLoading(false);
    }
  };

  React.useEffect(() => {
    if (sel) refreshCurrent(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // Visibility status column: the running user's profile tabVisibilities.
  // Cached per profile; failure degrades to "—" instead of a fake value.
  React.useEffect(() => {
    let cancelled = false;
    setProfileVis(null);
    if (!sel) return () => { cancelled = true; };
    (async () => {
      try {
        const userId = await appTabsResolveCurrentUserId();
        const ures = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT ProfileId FROM User WHERE Id = '${userId}'`), {useCache: false});
        const pid = ures?.records?.[0]?.ProfileId;
        if (!pid) throw new Error("no profile id");
        const pres = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${pid}'`), {useCache: false});
        const label = pres?.records?.[0]?.Name;
        if (!label) throw new Error("no profile name");
        const fullName = await appTabsResolveProfileFullName(label);
        if (cancelled) return;
        setProfileVisName(fullName);
        const map = await appTabsReadProfileVisibilities(fullName);
        if (!cancelled) setProfileVis(map);
      } catch (e) {
        console.warn("[SaralForce] AppTabManager profile visibility load failed:", e.message);
        if (!cancelled) setProfileVis({});
      }
    })();
    return () => { cancelled = true; };
  }, [sel]);

  // Visibility targets (profiles + permission sets) for the picker.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setTargetsLoading(true);
      try {
        const [pres, psres] = await Promise.all([
          sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name"), {useCache: false})
            .catch(() => ({records: []})),
          sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            // Label is the human-readable name admins recognize; Name /
            // DeveloperName are the API names used for the metadata write.
            encodeURIComponent("SELECT Id, DeveloperName, Label, Name, NamespacePrefix FROM PermissionSet ORDER BY Label"), {useCache: false})
            .catch(() => ({records: []}))
        ]);
        let profileNames = [];
        try { profileNames = await appTabsListMetadataFullNames("Profile"); } catch (e) { /* keep empty */ }
        let psetNames = [];
        try { psetNames = await appTabsListMetadataFullNames("PermissionSet"); } catch (e) { /* keep empty */ }
        if (cancelled) return;
        const matchProfile = (label) => {
          const targets = [appTabsNormName(label)];
          if (targets.includes("systemadministrator")) targets.push("admin");
          return profileNames.find(n => targets.includes(appTabsNormName(n))) ||
            profileNames.find(n => {
              const nn = appTabsNormName(n);
              return nn && targets.some(t => nn.startsWith(t) || t.startsWith(nn));
            }) || label;
        };
        setProfileList((pres.records || []).map(r => ({
          name: r.Name || r.Id,
          fullName: matchProfile(r.Name || "")
        })));
        setPsetList((psres.records || []).map(r => {
          const dn = r.DeveloperName || r.Name || "";
          const fn = psetNames.find(n => appTabsNormName(n) === appTabsNormName(dn)) ||
            psetNames.find(n => appTabsNormName(n).endsWith(appTabsNormName(dn))) ||
            dn || r.Id;
          return {name: r.Label || dn || r.Id, fullName: fn};
        }));
      } finally {
        if (!cancelled) setTargetsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // One-shot prefill from the AI Object Builder (module flag same-frame,
  // localStorage for the new-tab mode, custom event when the manager is
  // already mounted). Never auto-writes — it only preselects the tab and
  // shows the approval card.
  React.useEffect(() => {
    const apply = (p) => {
      if (!p || !p.tabApiName) return;
      setTabName(p.tabApiName);
      setVisTab(p.tabApiName);
      setPrefill(p);
      setPrefillCheck(null);
      appTabsTabExists(p.tabApiName)
        .then(exists => setPrefillCheck({exists: !!exists}))
        .catch(() => setPrefillCheck({exists: null}));
    };
    const consume = () => {
      if (ffAppTabPrefill.data) {
        const p = ffAppTabPrefill.data;
        ffAppTabPrefill.data = null;
        try { localStorage.removeItem("ffAppTabPrefill"); } catch (e) { /* ignore */ }
        apply(p);
        return;
      }
      try {
        const raw = localStorage.getItem("ffAppTabPrefill");
        if (raw) {
          localStorage.removeItem("ffAppTabPrefill");
          const p = JSON.parse(raw);
          if (p && p.ts && Date.now() - p.ts < 10 * 60 * 1000) apply(p);
        }
      } catch (e) { /* ignore */ }
    };
    consume();
    window.addEventListener("ff-apptabs-prefill", consume);
    return () => window.removeEventListener("ff-apptabs-prefill", consume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pinpoint the exact app via its record Id (from the App Manager URL).
  // Display labels are NOT unique — two apps can both be called
  // "Service Console" while only one is the app you actually open.
  const resolveFromRef = async () => {
    setRefMsg(null);
    setError(null);
    if (!appRef.trim()) {
      setRefMsg({ok: false, text: "Paste the App Manager URL or app record Id first."});
      return;
    }
    setResolving(true);
    try {
      const hit = await appTabsResolveAppByRecordId(appRef);
      setApps(prev => {
        if (prev.some(a => a.fullName.toLowerCase() === hit.fullName.toLowerCase())) {
          return prev.map(a => a.fullName.toLowerCase() === hit.fullName.toLowerCase()
            ? {...a, label: hit.label}
            : a);
        }
        return [...prev, {fullName: hit.fullName, label: hit.label}]
          .sort((a, b) => a.label.localeCompare(b.label));
      });
      setSel(hit.fullName);
      setRefMsg({ok: true, text: `Pinned to "${hit.label}" (${hit.fullName}) — this is now the exact app that will be updated.`});
    } catch (e) {
      setRefMsg({ok: false, text: e.message});
    } finally {
      setResolving(false);
    }
  };

  // Shared add flow: validate → existence check → duplicate check →
  // read-modify-write → strict verify → optional profile visibility.
  const addTab = async (opts) => {
    opts = opts || {};
    setError(null);
    setStatus(null);
    setDebug("");
    const fullName = String(sel || "").trim();
    let tab = String(tabName || "").trim();
    if (!fullName) { setError("Select an app first"); return; }
    if (!tab) { setError("Enter a tab API name (e.g. IT_Asset__c) or pick one from the list"); return; }
    // Custom object tabs carry the __c suffix; never accept an Id.
    if (appTabsIsSfId(tab)) { setError(`"${tab}" looks like a Salesforce Id — enter the tab API name instead`); return; }
    setWorking(true);
    try {
      // Never add a tab that doesn't exist — it writes a dead entry and the
      // app still shows nothing. Metadata can lag right after deploy.
      const exists = await appTabsTabExists(tab);
      if (!exists) {
        throw new Error(
          `Tab "${tab}" was not found in this org (checked CustomTab metadata + Tooling). ` +
          `If you just deployed it, wait a minute and press Reload Apps, then try again. ` +
          `Otherwise check Setup → Tabs for the exact API name.`);
      }
      const records = await appTabsReadRecords(fullName);
      if (!records) {
        throw new Error(
          `Could not read CustomApplication metadata for "${fullName}". ` +
          `Open Setup → App Manager → edit the app and confirm its Developer Name.`);
      }
      const fnEl = appTabsDomFind(records, "fullName");
      const realName = fnEl && fnEl.textContent && !appTabsIsSfId(fnEl.textContent)
        ? fnEl.textContent.trim()
        : fullName;
      const existing = appTabsOfRecords(records);
      console.log(`[SaralForce] AppTabManager read "${realName}": tabs=[${existing.join(", ")}]`);
      if (existing.includes(tab)) {
        setStatus(`"${tab}" is already on "${realName}" — nothing to do. If you still don't see it, switch apps once to refresh the nav bar.`);
        setCurrentTabs(existing);
        return;
      }
      const desired = existing.length ? [...existing, tab] : ["standard-home", tab];
      const {writeName, tabs} = await appTabsWriteTabList(fullName, desired, {
        verifyTab: tab, action: "add", recordsEl: records
      });
      setCurrentTabs(tabs);
      if (sel !== writeName) setSel(writeName);
      // Search visibility: App Launcher search only lists tabs your profile
      // can see. Optional — the dedicated visibility panel remains for
      // profiles / permission sets / DefaultOff / Hidden.
      let visNote = "";
      if (opts.makeVisible) {
        try {
          const profileFn = await appTabsEnsureTabVisibleForMe(tab);
          visNote = ` It is now visible to you (Default On on ${profileFn}).`;
          setProfileVis(prev => ({...(prev || {}), [tab]: "DefaultOn"}));
        } catch (ve) {
          visNote = ` Could not make it visible to you (${ve.message}) — use section 3.`;
        }
      }
      setStatus(`Added "${appTabsLabelFor(tab, customTabs)}" to ${(apps.find(a => a.fullName === writeName) || {}).label || writeName} — confirmed in Salesforce.${visNote} Not in the nav bar yet? Switch apps once or refresh Lightning.`);
      setTabName("");
      if (prefill && prefill.tabApiName === tab) { setPrefill(null); setPrefillCheck(null); }
    } catch (e) {
      setError(e.message);
      if (_appTabsDebug) {
        setDebug(
          `SOAP action: ${_appTabsDebug.action}\n--- request (tail) ---\n${_appTabsDebug.request}\n--- response (head) ---\n${_appTabsDebug.response}`);
      }
    } finally {
      setWorking(false);
    }
  };

  // App Launcher search only lists tabs your profile can see (DefaultOn).
  // This sets it without a redeploy and without touching Setup.
  const makeVisible = async (tabOverride) => {
    setVisErr(null);
    setVisMsg(null);
    const tab = String(tabOverride || visTab || tabName || "").trim();
    if (!tab) { setVisErr("Enter a tab API name first"); return; }
    if (appTabsIsSfId(tab)) { setVisErr(`"${tab}" looks like a Salesforce Id — enter the tab API name instead`); return; }
    setVisWorking(true);
    try {
      const exists = await appTabsTabExists(tab);
      if (!exists) {
        throw new Error(
          `Tab "${tab}" was not found in this org. If you just deployed it, wait a minute and retry.`);
      }
      const profileFn = await appTabsEnsureTabVisibleForMe(tab);
      setVisMsg(`Tab "${tab}" set to DefaultOn for your profile (${profileFn}). Open App Launcher search in ~30s — if it still doesn't appear, hard-refresh Lightning.`);
      // Refresh the visibility column.
      setProfileVis(prev => ({...(prev || {}), [tab]: "DefaultOn"}));
    } catch (e) {
      setVisErr(e.message);
    } finally {
      setVisWorking(false);
    }
  };

  // Remove a tab from the app (app membership only — profile access is a
  // separate operation and is left untouched).
  const removeTab = async (tab) => {
    if (!sel) return;
    setError(null);
    setStatus(null);
    setWorking(true);
    setConfirmRm(null);
    try {
      const records = await appTabsReadRecords(sel);
      if (!records) throw new Error(`Could not read CustomApplication metadata for "${sel}"`);
      const existing = appTabsOfRecords(records);
      if (!existing.includes(tab)) {
        setCurrentTabs(existing);
        setStatus(`"${tab}" is no longer on the app — list refreshed.`);
        return;
      }
      const desired = existing.filter(t => t !== tab);
      const {writeName, tabs} = await appTabsWriteTabList(sel, desired, {action: "remove"});
      setCurrentTabs(tabs);
      if (sel !== writeName) setSel(writeName);
      setStatus(`Removed "${appTabsLabelFor(tab, customTabs)}" from the app — confirmed in Salesforce. Who can see the tab was not changed.`);
    } catch (e) {
      setError(e.message);
      if (_appTabsDebug) {
        setDebug(
          `SOAP action: ${_appTabsDebug.action}\n--- request (tail) ---\n${_appTabsDebug.request}\n--- response (head) ---\n${_appTabsDebug.response}`);
      }
    } finally {
      setWorking(false);
    }
  };

  // Reorder: rewrite the whole ordered list (CustomApplication stores tabs
  // as a sequence — there is no per-row order field).
  const moveTab = async (idx, dir) => {
    if (!sel || !currentTabs) return;
    const target = idx + dir;
    if (target < 0 || target >= currentTabs.length) return;
    const tab = currentTabs[idx];
    setError(null);
    setStatus(null);
    setMoveBusy(idx);
    try {
      const desired = [...currentTabs];
      [desired[idx], desired[target]] = [desired[target], desired[idx]];
      const {writeName, tabs} = await appTabsWriteTabList(sel, desired, {action: "reorder"});
      setCurrentTabs(tabs);
      if (sel !== writeName) setSel(writeName);
      setStatus(`Moved "${appTabsLabelFor(tab, customTabs)}" to position ${target + 1} of ${tabs.length} — confirmed in Salesforce.`);
    } catch (e) {
      setError(e.message);
      if (_appTabsDebug) {
        setDebug(
          `SOAP action: ${_appTabsDebug.action}\n--- request (tail) ---\n${_appTabsDebug.request}\n--- response (head) ---\n${_appTabsDebug.response}`);
      }
    } finally {
      setMoveBusy(null);
    }
  };

  // Batch visibility write across selected profiles / permission sets.
  // Each target is written individually so one failure never blocks the
  // rest, and the summary names every failed target with its reason.
  const applyVisibility = async () => {
    setVisMsg(null);
    setVisErr(null);
    const tab = String(visTab || tabName || "").trim();
    if (!tab) { setVisErr("Pick a tab first (click a row in Current App Tabs, or type one in section 2)."); return; }
    if (appTabsIsSfId(tab)) { setVisErr(`"${tab}" looks like a Salesforce Id — enter the tab API name instead`); return; }
    const targets = [
      ...visProfiles.map(id => ({type: "Profile", fullName: id})),
      ...visPsets.map(id => ({type: "PermissionSet", fullName: id}))
    ];
    if (!targets.length) { setVisErr("Select at least one profile or permission set."); return; }
    setVisTargetsBusy(true);
    try {
      const exists = await appTabsTabExists(tab);
      if (!exists) {
        throw new Error(`Tab "${tab}" was not found in this org — visibility cannot be set for a tab that doesn't exist.`);
      }
      const ok = [];
      const failed = [];
      for (const t of targets) {
        try {
          await appTabsSetTabVisibility(t.type, t.fullName, tab, visValue);
          ok.push(`${t.fullName} (${t.type})`);
        } catch (e) {
          failed.push(`${t.fullName}: ${e.message}`);
        }
      }
      if (ok.length) {
        // The column shows YOUR profile — refresh it when that profile was written.
        if (profileVisName && ok.some(o => o.startsWith(profileVisName + " (Profile)"))) {
          appTabsInvalidateProfileVis(profileVisName);
          try {
            const map = await appTabsReadProfileVisibilities(profileVisName);
            setProfileVis(map);
          } catch (e) { /* keep stale */ }
        } else if (visTab) {
          setProfileVis(prev => (prev ? {...prev, [tab]: visValue} : prev));
        }
      }
      const valueLabel = visValue === "DefaultOn" ? "Default On" : visValue === "DefaultOff" ? "Default Off" : "Hidden";
      if (ok.length && !failed.length) {
        setVisMsg(`"${tab}" set to ${valueLabel} for ${ok.length} target(s): ${ok.join(", ")}. Propagation can take ~30s.`);
      } else if (ok.length) {
        setVisMsg(`"${tab}" set to ${valueLabel} for ${ok.length} target(s): ${ok.join(", ")}.`);
        setVisErr(`Failed for ${failed.length} target(s): ${failed.join("; ")}.`);
      } else {
        setVisErr(`Every target failed: ${failed.join("; ")}.`);
      }
    } catch (e) {
      setVisErr(e.message);
      if (_appTabsDebug) {
        setDebug(
          `SOAP action: ${_appTabsDebug.action}\n--- request (tail) ---\n${_appTabsDebug.request}\n--- response (head) ---\n${_appTabsDebug.response}`);
      }
    } finally {
      setVisTargetsBusy(false);
    }
  };

  const previewApp = () => {
    if (!sel) return;
    try {
      window.open("https://" + sfConn.instanceHostname + "/lightning/app/" + encodeURIComponent(sel), "_blank");
    } catch (e) { /* popup blocked */ }
  };

  const copyDebug = async () => {
    const selApp = apps.find(a => a.fullName === sel);
    const text =
      `App label: ${selApp ? selApp.label : ""}\n` +
      `App fullName (DeveloperName): ${sel}\n` +
      `Tab: ${tabName}\n` +
      `Current tabs: ${(currentTabs || []).join(", ") || "unknown"}\n\n${debug}`;
    try {
      await safeCopyText(text);
    } catch (e) { /* ignore */ }
  };

  const selApp = apps.find(a => a.fullName === sel);
  const selLabel = (selApp || {}).label || sel;
  const dupes = selApp ? apps.filter(a => a.label === selApp.label) : [];
  const appType = sel ? appTabsAppType(sel) : "";
  const appStatus = currentLoading
    ? "Reading metadata…"
    : currentTabs
      ? "Metadata verified"
      : "Metadata not read yet";

  // App picker: label, developer name, Standard / Custom.
  const appOptions = apps.map(a => {
    const twin = apps.filter(x => x.label === a.label).length > 1;
    return {value: a.fullName, label: a.label, sub: a.fullName !== a.label ? a.fullName : null,
      tag: twin ? "same name" : appTabsAppType(a.fullName), tagTone: twin ? "warn" : appTabsAppType(a.fullName) === "Standard" ? "info" : "violet"};
  });

  // Tab picker: org custom tabs, marked when already on the app / new.
  const currentSet = new Set((currentTabs || []).map(t => t.toLowerCase()));
  const tabOptions = customTabs
    .map(t => {
      const onApp = currentSet.has(t.apiName.toLowerCase());
      const recent = appTabsIsRecent(t.createdDate);
      return {value: t.apiName, label: t.label, sub: t.label !== t.apiName ? t.apiName : null,
        tag: onApp ? "on app" : recent ? "new" : null, tagTone: onApp ? "muted" : "ok", onApp, recent};
    })
    // Not-yet-added first, newest custom tabs on top.
    .sort((a, b) => (a.onApp - b.onApp) || (b.recent - a.recent) || a.label.localeCompare(b.label));
  const recentTabs = tabOptions.filter(t => t.recent && !t.onApp).slice(0, 8);

  // Visibility picker: tabs on the app first, then every other org tab.
  const visOptions = [
    ...(currentTabs || []).map(api => {
      const label = appTabsLabelFor(api, customTabs);
      return {value: api, label, sub: label !== api ? api : null, tag: "on app", tagTone: "muted"};
    }),
    ...tabOptions.filter(t => !t.onApp)
  ];
  const visTabValue = visTab || "";

  // Current App Tabs table rows.
  const listNeedle = listQuery.trim().toLowerCase();
  const tableRows = (currentTabs || [])
    .map((api, idx) => ({
      api,
      idx,
      label: appTabsLabelFor(api, customTabs),
      kind: appTabsKindFor(api),
      vis: profileVis ? (profileVis[api] || profileVis[api.toLowerCase()] || "") : null
    }))
    .filter(r => !listNeedle ||
      r.api.toLowerCase().includes(listNeedle) || r.label.toLowerCase().includes(listNeedle));

  const visValueLabel = visValue === "DefaultOn" ? "Default On" :
    visValue === "DefaultOff" ? "Default Off" : "Hidden";
  const visTargetCount = visProfiles.length + visPsets.length;
  const pickApp = v => { setSel(v); setStatus(null); setError(null); setRefMsg(null); setConfirmRm(null); };
  const visCell = r => profileVis === null
    ? h("span", {className: "apptm-vis-cell apptm-vis-loading"}, "…")
    : r.vis
      ? h("span", {className: `apptm-vis-cell apptm-vis-${r.vis === "DefaultOn" ? "on" : r.vis === "DefaultOff" ? "off" : "hid"}`},
        r.vis === "DefaultOn" ? "Default On" : r.vis === "DefaultOff" ? "Default Off" : r.vis === "Hidden" ? "Hidden" : "Set")
      : h("span", {className: "apptm-vis-cell apptm-vis-none", title: "Not in your profile's tab settings (defaults apply)"}, "Default");

  return h("div", {className: "insp-panel apptm"},
    h("p", {className: "insp-hint-strip"},
      "Pick an app, add or reorder its tabs, and choose who can see them. Every change is read back from Salesforce to confirm it."),

    // ── Prefill from AI Object Builder (approval required) ──
    prefill && h("div", {className: "apptm-prefill"},
      h("div", {className: "apptm-prefill-h"},
        h("span", {className: "apptm-prefill-badge"}, "AI Object Builder"),
        h("span", {className: "apptm-prefill-title"}, "New object tab ready to add")
      ),
      h("div", {className: "apptm-prefill-body"},
        h("span", null, `Object: ${prefill.objectApiName || "—"}`),
        h("span", {className: "apptm-mono"}, `Tab: ${prefill.tabApiName}`),
        prefillCheck && prefillCheck.exists === true &&
          h("span", {className: "apptm-ok-text"}, "✓ Tab exists in this org"),
        prefillCheck && prefillCheck.exists === false &&
          h("span", {className: "apptm-warn-text"},
            "✗ Tab not found — create it in Setup → Tabs (or redeploy the object), then reload."),
        h("span", {className: "apptm-prefill-note"},
          "Choose the app below, then add it — nothing is written until you click.")
      ),
      h("div", {className: "apptm-prefill-actions"},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: working || !sel || (prefillCheck && prefillCheck.exists === false),
          title: "Add this tab to the selected app",
          onClick: () => addTab({makeVisible: alsoVisible})
        }, working ? "Working…" : `Add to ${selLabel || "app"}`),
        h("button", {
          className: "btn btn-secondary btn-sm",
          onClick: () => { setPrefill(null); setPrefillCheck(null); }
        }, "Dismiss")
      )
    ),

    // ── 1 · App ─────────────────────────────────────────────
    h("div", {className: "apptm-card"},
      h("div", {className: "apptm-card-h"},
        h("span", {className: "apptm-num"}, "1"),
        h("div", {className: "apptm-card-headings"},
          h("div", {className: "apptm-card-t"}, "Choose an app"),
          h("div", {className: "apptm-card-sub"}, "Type to search by app name or developer name")
        )
      ),
      h("div", {className: "apptm-row"},
        h(SearchSelect, {
          value: sel,
          options: appOptions,
          onChange: pickApp,
          placeholder: appsLoading ? "Loading apps…" : "Search apps…",
          emptyText: appsLoading ? "Loading apps…" : "No apps found",
          disabled: appsLoading || working,
          ariaLabel: "Lightning app",
          className: "apptm-grow"
        }),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: !sel,
          title: "Open the selected app in a new browser tab",
          onClick: previewApp
        }, "Open app ↗"),
        h("button", {
          className: "apptm-ico-btn apptm-ico-lg",
          disabled: appsLoading || tabsLoading || working,
          title: "Reload apps and tabs from Salesforce",
          "aria-label": "Reload apps and tabs",
          onClick: loadAll
        }, (appsLoading || tabsLoading) ? "…" : "↻")
      ),
      sel && h("div", {className: "apptm-facts"},
        h("span", {className: `apptm-tag ${appType === "Standard" ? "apptm-tag-std" : "apptm-tag-cus"}`}, appType),
        h("span", {className: "apptm-mono apptm-fact"}, sel),
        h("span", {className: `apptm-tag ${currentTabs ? "apptm-tag-ok" : "apptm-tag-idle"}`},
          currentLoading ? "Reading…" : currentTabs ? `✓ ${currentTabs.length} tab${currentTabs.length === 1 ? "" : "s"}` : appStatus)),
      dupes.length > 1 && h("div", {className: "insp-warn"},
        `${dupes.length} apps are called "${selApp.label}" (${dupes.map(a => a.fullName).join(", ")}). ` +
        `Pin the one you actually open below.`),
      h("details", {className: "apptm-more", open: dupes.length > 1 || !!refMsg},
        h("summary", null, "Two apps with the same name? Pin the exact one by its URL or Id"),
        h("div", {className: "apptm-row"},
          h("input", {
            className: "apptm-input apptm-grow",
            value: appRef,
            placeholder: "App Manager URL or record Id (02u…)",
            "aria-label": "App Manager URL or record Id",
            disabled: resolving || working,
            onChange: e => setAppRef(e.target.value),
            onKeyDown: e => { if (e.key === "Enter") resolveFromRef(); }
          }),
          h("button", {
            className: "btn btn-secondary btn-sm",
            disabled: resolving || working || !appRef.trim(),
            onClick: resolveFromRef
          }, resolving ? "Finding…" : "Find app")),
        refMsg && h("div", {className: refMsg.ok ? "insp-ok" : "insp-error"}, refMsg.text))
    ),

    // ── 2 · Tabs on this app ────────────────────────────────
    h("div", {className: "apptm-card"},
      h("div", {className: "apptm-card-h"},
        h("span", {className: "apptm-num"}, "2"),
        h("div", {className: "apptm-card-headings"},
          h("div", {className: "apptm-card-t"}, sel ? `Tabs on ${selLabel}` : "Tabs on this app"),
          h("div", {className: "apptm-card-sub"}, "Add a tab, change the order, or remove one")
        ),
        h("button", {
          className: "apptm-ico-btn apptm-ico-lg",
          disabled: currentLoading || !sel || working,
          title: "Re-read this app from Salesforce",
          "aria-label": "Re-read this app",
          onClick: () => refreshCurrent()
        }, currentLoading ? "…" : "↻")
      ),
      h("div", {className: "apptm-addbar"},
        h(SearchSelect, {
          value: tabName,
          options: tabOptions,
          onChange: v => setTabName(v),
          placeholder: tabsLoading ? "Loading tabs…" : "Search tabs, or type an API name (e.g. standard-Account)",
          emptyText: "No custom tabs match",
          disabled: working || !sel,
          allowFree: true,
          ariaLabel: "Tab to add",
          className: "apptm-grow"
        }),
        h("label", {className: "apptm-check", title: "Also set the tab to Default On for your profile, so App Launcher search finds it"},
          h("input", {type: "checkbox", checked: alsoVisible, onChange: e => setAlsoVisible(e.target.checked)}),
          " Make visible to me"),
        h("button", {
          className: "btn btn-primary",
          disabled: working || !sel || !tabName.trim() || currentSet.has(tabName.trim().toLowerCase()),
          title: currentSet.has(tabName.trim().toLowerCase()) ? "This tab is already on the app" : "Add the tab to the app",
          onClick: () => addTab({makeVisible: alsoVisible})
        }, working ? "Adding…" : "+ Add tab")
      ),
      recentTabs.length > 0 && h("div", {className: "apptm-chips apptm-recent"},
        h("span", {className: "apptm-recent-l"}, "New in your org:"),
        recentTabs.map(t => h("button", {
          key: t.value,
          className: "apptm-chip apptm-chip-new" + (tabName === t.value ? " active" : ""),
          title: `${t.sub} — click to select`,
          disabled: working,
          onClick: () => setTabName(t.value)
        }, t.label))),
      status && h("div", {className: "insp-ok"}, status),
      error && h("div", {className: "insp-error"}, error),
      debug && h("details", {className: "apptm-more"},
        h("summary", null, "Technical details"),
        h("div", {className: "insp-toolbar"},
          h("button", {className: "btn btn-secondary btn-sm", onClick: copyDebug}, "Copy details")),
        h("textarea", {className: "insp-csv-preview", readOnly: true, value: debug.slice(0, 8000)})),
      currentTabs && currentTabs.length > 6 && h("div", {className: "apptm-toolbar"},
        h("input", {
          className: "apptm-list-search",
          value: listQuery,
          placeholder: "Filter these tabs…",
          "aria-label": "Filter tabs on this app",
          onChange: e => setListQuery(e.target.value)
        })),
      !sel ? h("div", {className: "insp-empty"}, "Choose an app above.")
      : currentLoading && !currentTabs ? h("div", {className: "insp-meta"}, "Reading the app…")
      : currentTabs && currentTabs.length === 0 ? h("div", {className: "insp-empty"}, "No tabs on this app yet — add one above.")
      : currentTabs && tableRows.length === 0 ? h("div", {className: "insp-empty"}, `No tabs match "${listQuery}".`)
      : currentTabs && h("div", {className: "apptm-table-wrap"},
        h("table", {className: "apptm-table"},
          h("thead", null,
            h("tr", null,
              h("th", {className: "apptm-th-pos"}, "#"),
              h("th", null, "Tab"),
              h("th", null, "Type"),
              h("th", {title: profileVisName ? `Tab setting on your profile (${profileVisName})` : "Tab setting on your profile"}, "Your visibility"),
              h("th", {className: "apptm-th-act"}, ""))),
          h("tbody", null,
            tableRows.map(r =>
              h("tr", {key: r.api, className: "apptm-tr"},
                h("td", {className: "apptm-td-pos"}, String(r.idx + 1)),
                h("td", null,
                  h("div", {className: "apptm-tab-label"}, r.label),
                  r.label !== r.api && h("div", {className: "apptm-tab-api"}, r.api)),
                h("td", null,
                  h("span", {className: `apptm-tag ${r.kind === "Standard" ? "apptm-tag-std" : "apptm-tag-cus"}`}, r.kind)),
                h("td", null, visCell(r)),
                h("td", {className: "apptm-td-act"},
                  h("button", {
                    className: "apptm-ico-btn",
                    disabled: r.idx === 0 || moveBusy !== null || working || !!listNeedle,
                    title: "Move up",
                    "aria-label": `Move ${r.label} up`,
                    onClick: () => moveTab(r.idx, -1)
                  }, moveBusy === r.idx ? "…" : "↑"),
                  h("button", {
                    className: "apptm-ico-btn",
                    disabled: r.idx === currentTabs.length - 1 || moveBusy !== null || working || !!listNeedle,
                    title: "Move down",
                    "aria-label": `Move ${r.label} down`,
                    onClick: () => moveTab(r.idx, 1)
                  }, "↓"),
                  h("button", {
                    className: "apptm-ico-btn apptm-ico-text",
                    disabled: working,
                    title: "Choose who can see this tab (section 3)",
                    onClick: () => {
                      setVisTab(r.api);
                      const el = document.getElementById("apptm-access");
                      if (el) el.scrollIntoView({behavior: "smooth", block: "start"});
                    }
                  }, "Access"),
                  confirmRm === r.api
                    ? [
                      h("button", {key: "y", className: "apptm-ico-btn apptm-ico-danger apptm-ico-text", disabled: working,
                        onClick: () => removeTab(r.api)}, "Remove"),
                      h("button", {key: "n", className: "apptm-ico-btn apptm-ico-text", onClick: () => setConfirmRm(null)}, "Keep")
                    ]
                    : h("button", {
                      className: "apptm-ico-btn apptm-ico-danger",
                      disabled: working,
                      title: `Remove from this app (who can see the tab is not changed)`,
                      "aria-label": `Remove ${r.label}`,
                      onClick: () => setConfirmRm(r.api)
                    }, "✕"))))))),
      currentTabs && h("div", {className: "apptm-vis-state"},
        profileVis === null ? "Loading your visibility…"
          : profileVisName ? `"Your visibility" is the tab setting on your profile (${profileVisName}).`
          : "Your visibility could not be read.")
    ),

    // ── 3 · Who can see a tab ───────────────────────────────
    h("div", {className: "apptm-card", id: "apptm-access"},
      h("div", {className: "apptm-card-h"},
        h("span", {className: "apptm-num"}, "3"),
        h("div", {className: "apptm-card-headings"},
          h("div", {className: "apptm-card-t"}, "Who can see a tab"),
          h("div", {className: "apptm-card-sub"},
            "Being on an app and being visible are separate: set the tab's visibility for profiles or permission sets")
        )
      ),
      h("div", {className: "apptm-vis-grid"},
        h("div", {className: "apptm-field"},
          h("span", null, "Tab"),
          h(SearchSelect, {
            value: visTabValue,
            options: visOptions,
            onChange: v => setVisTab(v),
            placeholder: "Search tabs…",
            allowFree: true,
            ariaLabel: "Tab for visibility"
          })),
        h("div", {className: "apptm-field"},
          h("span", null, "Visibility"),
          h("div", {className: "sq3-pills apptm-seg", role: "radiogroup", "aria-label": "Visibility"},
            [["DefaultOn", "Default On", "Shown in the app and in App Launcher"],
              ["DefaultOff", "Default Off", "Available, but users add it themselves"],
              ["Hidden", "Hidden", "Users can't see the tab"]].map(([v, label, tip]) => h("button", {
              key: v, type: "button", role: "radio", "aria-checked": visValue === v, title: tip,
              className: "sq3-pill" + (visValue === v ? " active" : ""),
              disabled: visTargetsBusy,
              onClick: () => setVisValue(v)
            }, label))))
      ),
      h("div", {className: "apptm-field"},
        h("span", null, "For"),
        h("div", {className: "apptm-vis-targets"},
          h(MultiCheckDropdown, {
            label: "Profiles",
            items: profileList.map(p => ({id: p.fullName, name: p.name})),
            selected: visProfiles,
            onChange: setVisProfiles,
            emptyText: targetsLoading ? "Loading profiles…" : "No profiles found"
          }),
          h(MultiCheckDropdown, {
            label: "Permission sets",
            items: psetList.map(p => ({id: p.fullName, name: p.name})),
            selected: visPsets,
            onChange: setVisPsets,
            emptyText: targetsLoading ? "Loading permission sets…" : "No permission sets found"
          }))),
      h("div", {className: "apptm-actions"},
        h("button", {
          className: "btn btn-primary",
          disabled: visTargetsBusy || targetsLoading || !visTabValue.trim() || !visTargetCount,
          title: visTargetCount ? `Set ${visValueLabel} for the ${visTargetCount} selected` : "Choose profiles or permission sets first",
          onClick: applyVisibility
        }, visTargetsBusy ? "Applying…" : `Set ${visValueLabel}${visTargetCount ? ` for ${visTargetCount} selected` : ""}`),
        h("span", {className: "apptm-or"}, "or"),
        h("button", {
          className: "btn btn-secondary",
          disabled: visWorking || working || !visTabValue.trim(),
          title: "Set this tab to Default On for your own profile",
          onClick: () => makeVisible(visTabValue)
        }, visWorking ? "Setting…" : "Just make it visible to me")),
      h("div", {className: "apptm-vis-hint"},
        "Users also need Read access to the tab's object — Salesforce hides a tab whose object they can't open."),
      visMsg && h("div", {className: "insp-ok"}, visMsg),
      visErr && h("div", {className: "insp-error"}, visErr)
    )
  );
}

// Multi-select dropdown with search (clone-user assignment picker):
// button shows "Label (n/m selected)", panel lists checkboxes + All/Clear.
function MultiCheckDropdown({label, items, selected, onChange, emptyText}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const sel = new Set(selected || []);
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter(it => it.name.toLowerCase().includes(needle)) : items;
  const toggle = (id) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (e.target.closest && e.target.closest(".ff-multi")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return h("div", {className: "ff-multi"},
    h("button", {
      type: "button",
      className: "btn btn-secondary btn-sm",
      disabled: !items.length,
      title: items.length ? `Pick ${label.toLowerCase()} to copy` : `No ${label.toLowerCase()} assigned`,
      onClick: () => setOpen(o => !o),
      "aria-expanded": open
    }, `${label} (${sel.size}/${items.length} selected ▾)`),
    open && h("div", {className: "ff-multi-panel"},
      h("div", {className: "ff-multi-tools"},
        h("input", {
          className: "ff-multi-search",
          placeholder: "Filter…",
          value: q,
          onChange: e => setQ(e.target.value),
          onClick: e => e.stopPropagation()
        }),
        h("button", {type: "button", className: "field-action-btn",
          onClick: () => onChange(items.map(it => it.id))}, "All"),
        h("button", {type: "button", className: "field-action-btn",
          onClick: () => onChange([])}, "Clear")
      ),
      h("div", {className: "ff-multi-list"},
        shown.map(it => h("label", {key: it.id, className: "ff-multi-row", title: it.id},
          h("input", {type: "checkbox", checked: sel.has(it.id), onChange: () => toggle(it.id)}),
          h("span", null, it.name)
        )),
        shown.length === 0 && h("div", {className: "insp-empty"}, emptyText || "No matches")
      )
    )
  );
}

export {ffHasAppTabPrefill, AppTabManager};
