(function() {
  "use strict";

  let sfHost = null;
  let sidebarOpen = false;
  let sidebarContainer = null;
  let sidebarExpanded = false;

  function getHostFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }

  function init() {
    if (document.getElementById("sf-object-creator-sidebar-host")) return;

    const currentUrl = window.location.href;
    sfHost = getHostFromUrl(currentUrl);

    if (!sfHost) return;

    chrome.runtime.sendMessage({message: "getSfHost", url: currentUrl}, (response) => {
      if (response) {
        sfHost = response;
        createButton();
      }
    });
  }

  function createButton() {
    if (document.getElementById("sf-object-creator-btn")) return;

    const btn = document.createElement("div");
    btn.id = "sf-object-creator-btn";
    btn.style.cssText = `
      position: fixed;
      top: 40px;
      right: 4px;
      z-index: 2147483647;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: #032d60;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
      font-weight: bold;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      transition: all 0.2s ease;
      font-family: 'Salesforce Sans', Arial, sans-serif;
      opacity: 0.6;
    `;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="sfbg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient><linearGradient id="sfbr" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs><rect width="120" height="120" rx="26" fill="url(#sfbg)"/><g transform="translate(14.5,21) scale(1.18)"><path d="M35 12 C24 12 15 20 13 31 C8 32 4 37 4 43 C4 49 9 54 15 54 L62 54 C68 54 73 49 73 43 C73 38 70 33 65 31 C63 20 54 12 43 12 C40 12 37 13 35 12 Z" fill="url(#sfbr)" opacity="0.15"/><path d="M33 10 C22.5 10 14 18.5 14 29 C9 30 5 34.5 5 40 C5 45.5 9.5 50 15 50 L58 50 C63.5 50 68 45.5 68 40 C68 35 64 31 59 30 C57 19.5 48.5 10 38 10 C35.5 10 34.2 10.5 33 10 Z" fill="none" stroke="url(#sfbr)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 31 L20 37 L26 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M47 31 L53 37 L47 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="41" y1="28" x2="32" y2="46" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></g></svg>`;
    btn.title = "SaralForce";

    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "1";
      btn.style.transform = "scale(1.05)";
    });

    btn.addEventListener("mouseleave", () => {
      if (!sidebarOpen) {
        btn.style.opacity = "0.6";
      }
      btn.style.transform = "scale(1)";
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar();
    });

    document.body.appendChild(btn);
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  function openSidebar() {
    if (sidebarOpen || !sfHost) return;

    chrome.runtime.sendMessage({message: "getSession", sfHost}, (session) => {
      if (!session) {
        alert("No active Salesforce session. Please log in first.");
        return;
      }

      sidebarContainer = document.createElement("div");
      sidebarContainer.id = "sf-object-creator-sidebar-host";
      sidebarContainer.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 480px;
        height: 100vh;
        z-index: 2147483646;
        box-shadow: -4px 0 24px rgba(0,0,0,0.2);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        transform: translateX(100%);
        background: #fff;
      `;

      const header = document.createElement("div");
      header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #032d60;
        color: #fff;
        font-family: 'Salesforce Sans', Arial, sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: move;
        user-select: none;
      `;
      header.innerHTML = `
        <span style="display:flex;align-items:center;gap:8px;">
          <svg width="14" height="14" viewBox="0 0 120 120" aria-hidden="true"><rect width="120" height="120" rx="26" fill="#0f172a"/><g transform="translate(14.5,21) scale(1.18)"><path d="M33 10 C22.5 10 14 18.5 14 29 C9 30 5 34.5 5 40 C5 45.5 9.5 50 15 50 L58 50 C63.5 50 68 45.5 68 40 C68 35 64 31 59 30 C57 19.5 48.5 10 38 10 C35.5 10 34.2 10.5 33 10 Z" fill="none" stroke="#38bdf8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 31 L20 37 L26 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M47 31 L53 37 L47 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="41" y1="28" x2="32" y2="46" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></g></svg>
          SaralForce
          <span style="font-weight:400;opacity:0.7;font-size:11px;">Developer Inspector Utility</span>
        </span>
      `;

      const closeBtn = document.createElement("button");
      closeBtn.innerHTML = "\u00d7";
      closeBtn.style.cssText = `
        background: none;
        border: none;
        color: #fff;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        opacity: 0.8;
      `;
      closeBtn.addEventListener("click", closeSidebar);
      closeBtn.addEventListener("mouseenter", () => closeBtn.style.opacity = "1");
      closeBtn.addEventListener("mouseleave", () => closeBtn.style.opacity = "0.8");

      const settingsBtn = document.createElement("button");
      settingsBtn.innerHTML = "\u2699";
      settingsBtn.title = "LLM / Settings";
      settingsBtn.style.cssText = `
        background: none;
        border: none;
        color: #fff;
        font-size: 16px;
        cursor: pointer;
        padding: 0 6px;
        line-height: 1;
        opacity: 0.85;
        margin-right: 4px;
      `;
      settingsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({message: "openOptions", host: sfHost || ""});
      });
      settingsBtn.addEventListener("mouseenter", () => settingsBtn.style.opacity = "1");
      settingsBtn.addEventListener("mouseleave", () => settingsBtn.style.opacity = "0.85");

      const headerActions = document.createElement("span");
      headerActions.style.cssText = "display:flex;align-items:center;gap:2px;";
      headerActions.appendChild(settingsBtn);
      headerActions.appendChild(closeBtn);
      header.appendChild(headerActions);

      const iframe = document.createElement("iframe");
      iframe.id = "sf-object-creator-iframe";
      iframe.style.cssText = `
        width: 100%;
        height: calc(100vh - 40px);
        border: none;
        display: block;
      `;
      iframe.src = chrome.runtime.getURL(`object-creator.html?host=${sfHost}`);

      // Floating expand/collapse pill pinned to the panel's left edge (center).
      // Lives outside the iframe so it never covers app content.
      const resizeBtn = document.createElement("button");
      resizeBtn.id = "sf-object-creator-resize";
      resizeBtn.type = "button";
      resizeBtn.title = "Expand panel";
      resizeBtn.style.cssText = `
        position: absolute;
        left: -18px;
        top: 50%;
        transform: translateY(-50%);
        width: 18px;
        height: 64px;
        padding: 0;
        border: none;
        border-radius: 8px 0 0 8px;
        background: #ffb35c;
        color: #032d60;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: -2px 0 8px rgba(0,0,0,0.25);
        opacity: 0.85;
        z-index: 2;
        font-family: 'Salesforce Sans', Arial, sans-serif;
      `;
      resizeBtn.innerHTML = "&#187;";
      resizeBtn.addEventListener("mouseenter", () => resizeBtn.style.opacity = "1");
      resizeBtn.addEventListener("mouseleave", () => resizeBtn.style.opacity = "0.85");
      resizeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Expanded = min(920px, 75vw); skip when the window is too narrow to grow.
        const maxW = Math.min(920, window.innerWidth * 0.75);
        if (!sidebarExpanded && maxW <= 485) return;
        sidebarExpanded = !sidebarExpanded;
        sidebarContainer.style.width = sidebarExpanded ? "min(920px, 75vw)" : "480px";
        resizeBtn.innerHTML = sidebarExpanded ? "&#171;" : "&#187;";
        resizeBtn.title = sidebarExpanded ? "Collapse panel" : "Expand panel";
      });

      sidebarContainer.appendChild(header);
      sidebarContainer.appendChild(iframe);
      sidebarContainer.appendChild(resizeBtn);
      document.body.appendChild(sidebarContainer);

      // Store session for the iframe to pick up
      const storeKey = sfHost + "_sidebar_session";
      sessionStorage.setItem(storeKey, JSON.stringify(session));

      iframe.addEventListener("load", () => {
        iframe.contentWindow.postMessage({
          type: "sfoc-session-data",
          session: session,
          sfHost: sfHost
        }, "*");
      });

      requestAnimationFrame(() => {
        sidebarContainer.style.transform = "translateX(0)";
      });

      sidebarOpen = true;
      document.getElementById("sf-object-creator-btn")?.style.setProperty("opacity", "1");
    });
  }

  function closeSidebar() {
    if (!sidebarContainer) return;
    // Ask iframe to save state before we destroy it
    const iframe = document.getElementById("sf-object-creator-iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({type: "sfoc-save-state"}, "*");
    }
    sidebarContainer.style.transform = "translateX(100%)";
    setTimeout(() => {
      sidebarContainer?.remove();
      sidebarContainer = null;
    }, 300);
    sidebarOpen = false;
    sidebarExpanded = false;
    document.getElementById("sf-object-creator-btn")?.style.setProperty("opacity", "0.6");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.msg === "shortcut_pressed" && request.command === "open-object-creator") {
      if (sidebarOpen) {
        closeSidebar();
      } else {
        openSidebar();
      }
    }
  });

})();
