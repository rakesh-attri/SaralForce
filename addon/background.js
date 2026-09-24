let sfHost;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Cross-origin LLM call proxied through the service worker so it always
  // runs with host_permissions (options page / content script fetch can
  // throw a bare "Failed to fetch" when CORS or permissions aren't ready).
  if (request.message === "llmFetch") {
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
    const currentDomain = new URL(request.url).hostname;
    chrome.cookies.get({url: request.url, name: "sid", storeId: sender.tab.cookieStoreId}, cookie => {
      if (!cookie || currentDomain.endsWith(".mcas.ms")) {
        sendResponse(currentDomain);
        return;
      }
      const [orgId] = cookie.value.split("!");
      const orderedDomains = ["salesforce.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];

      orderedDomains.forEach(domain => {
        chrome.cookies.getAll({name: "sid", domain: domain, secure: true, storeId: sender.tab.cookieStoreId}, cookies => {
          let sessionCookie = cookies.find(c => c.value.startsWith(orgId + "!") && c.domain != "help.salesforce.com");
          if (sessionCookie) {
            sendResponse(sessionCookie.domain);
          }
        });
      });
    });
    return true;
  }
  if (request.message == "getSession") {
    sfHost = request.sfHost;
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
  } else if (request.message == "reloadPage") {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.reload(tabs[0].id);
    });
  }
  return false;
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.sendMessage({
    msg: "shortcut_pressed", sfHost, command: "open-object-creator"
  });
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "open-object-creator") {
    chrome.runtime.sendMessage({
      msg: "shortcut_pressed", command, sfHost
    });
  }
});

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
chrome.runtime.setUninstallURL("https://rakesh-attri.github.io/forceforge/addon/goodbye.html");
