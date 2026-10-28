// Service worker: session pickup derived in part from Salesforce-Inspector-reloaded
// (https://github.com/tprouvot/Salesforce-Inspector-reloaded)
// MIT License, Copyright (c) 2023 Thomas Prouvot. See LICENSE.
let inspectorTabId = null;

const SESSION_COOKIE_DOMAINS = ["salesforce.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];

function isExtensionPage(sender) {
  return !!sender && sender.id === chrome.runtime.id &&
    typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

// Maps a Salesforce page URL to the API host of the same org's session: the
// first domain (in SESSION_COOKIE_DOMAINS order) holding a sid cookie for the
// page's org id. Falls back to the page's own host. Always answers once.
// Callback wrappers: promise-returning chrome.cookies needs a newer Chrome
// than minimum_chrome_version.
function getCookie(details) {
  return new Promise(resolve => chrome.cookies.get(details, cookie => resolve(cookie || null)));
}

function getAllCookies(details) {
  return new Promise(resolve => chrome.cookies.getAll(details, cookies => resolve(cookies || [])));
}

async function resolveSfHost(url, storeId) {
  const currentDomain = new URL(url).hostname;
  const cookie = await getCookie({url, name: "sid", storeId});
  if (!cookie || currentDomain.endsWith(".mcas.ms")) return currentDomain;
  const [orgId] = cookie.value.split("!");
  for (const domain of SESSION_COOKIE_DOMAINS) {
    const cookies = await getAllCookies({name: "sid", domain, secure: true, storeId});
    const sessionCookie = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain != "help.salesforce.com");
    if (sessionCookie) return sessionCookie.domain;
  }
  return currentDomain;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Cross-origin LLM call proxied through the service worker so it always
  // runs with host_permissions (options page / content script fetch can
  // throw a bare "Failed to fetch" when CORS or permissions aren't ready).
  if (request.message === "llmFetch") {
    // Only extension pages (panel, options) call AI providers; content
    // scripts running on Salesforce pages never need this proxy.
    if (!isExtensionPage(sender)) {
      sendResponse({ok: false, status: 0, error: "llmFetch is only available to extension pages"});
      return false;
    }
    fetch(request.url, {
      method: request.method || "POST",
      headers: request.headers || {},
      body: request.body
    }).then(async res => {
      const text = await res.text();
      sendResponse({ok: res.ok, status: res.status, text});
    }).catch(err => {
      sendResponse({ok: false, status: 0, error: String(err && err.message || err)});
    });
    return true;
  }
  if (request.message == "getSfHost") {
    resolveSfHost(request.url, sender.tab && sender.tab.cookieStoreId).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (request.message == "getSession") {
    chrome.cookies.get({url: "https://" + request.sfHost, name: "sid", storeId: sender.tab.cookieStoreId}, sessionCookie => {
      if (!sessionCookie) {
        sendResponse(null);
        return;
      }
      let session = {key: sessionCookie.value, hostname: sessionCookie.domain};
      sendResponse(session);
    });
    return true;
  } else if (request.message == "createWindow") {
    const brow = typeof browser === "undefined" ? chrome : browser;
    brow.windows.create({
      url: request.url,
      incognito: request.incognito ?? false
    });
  } else if (request.message == "openOptions") {
    const url = chrome.runtime.getURL("options.html" + (request.host ? `?host=${encodeURIComponent(request.host)}` : ""));
    chrome.tabs.create({url});
    sendResponse({ok: true, url});
    return true;
  } else if (request.message == "openInspectorTab") {
    const openerTabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
    // Record context carried from the opener page (absent when the sidebar
    // had no record context): the new tab has no content-script parent to
    // ask, so it arrives as openRecObj/openRecId URL params instead. Setup
    // and classic pages contribute an Id with no object name — the panel
    // resolves the object from the Id prefix.
    const recObj = request.rec && /^[A-Za-z0-9_]+$/.test(request.rec.obj || "")
      ? request.rec.obj : "";
    const recId = request.rec && /^[a-zA-Z0-9]{15,18}$/.test(request.rec.id || "")
      ? request.rec.id : "";
    const recSuffix = (recObj || recId)
      ? (recObj ? `&openRecObj=${encodeURIComponent(recObj)}` : "") +
        (recId ? `&openRecId=${encodeURIComponent(recId)}` : "")
      : "";
    const openFresh = () => {
      let url = chrome.runtime.getURL("object-creator.html" + (request.host ? `?host=${encodeURIComponent(request.host)}` : ""));
      url += (url.includes("?") ? "&" : "?") + "view=inspector";
      url += recSuffix;
      if (openerTabId != null) url += `&fromTab=${openerTabId}`;
      const props = {url, active: true};
      if (openerTabId != null) props.openerTabId = openerTabId;
      chrome.tabs.create(props, (tab) => {
        if (tab && tab.id != null) inspectorTabId = tab.id;
        sendResponse({ok: true});
      });
    };
    if (inspectorTabId != null && !recSuffix) {
      chrome.tabs.get(inspectorTabId, () => {
        if (!chrome.runtime.lastError) {
          chrome.tabs.update(inspectorTabId, {active: true});
          sendResponse({ok: true, reused: true});
        } else {
          inspectorTabId = null;
          openFresh();
        }
      });
    } else {
      // A record context always opens fresh so the previous tab keeps its
      // work; the new tab becomes the reused one from here on.
      inspectorTabId = null;
      openFresh();
    }
    return true;
  } else if (request.message == "reloadPage") {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.reload(tabs[0].id);
    });
  }
  return false;
});

// Content scripts only receive messages via chrome.tabs.sendMessage — the
// runtime broadcast below never reached button.js.
function sendShortcut(command) {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, {msg: "shortcut_pressed", command}, () => {
        void chrome.runtime.lastError; // tab has no content script — ignore
      });
    }
  });
}

chrome.action.onClicked.addListener(() => sendShortcut("open-object-creator"));

chrome.commands?.onCommand.addListener(sendShortcut);

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.tabs.create({
      url: "options.html"
    });
  }
});

// Farewell page on uninstall. Chrome only allows http(s) uninstall URLs,
// so addon/goodbye.html is hosted via GitHub Pages (repo Settings → Pages).
// Preview locally by opening addon/goodbye.html in the browser.
chrome.runtime.setUninstallURL("https://rakesh-attri.github.io/SaralForce/addon/goodbye.html");
