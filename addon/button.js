(function() {
  "use strict";

  let sfHost = null;
  let sidebarOpen = false;
  let sidebarContainer = null;

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
      top: 4px;
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
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
    btn.title = "ForceForge";

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
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          ForceForge
          <span style="font-weight:400;opacity:0.7;font-size:11px;">AI Toolkit</span>
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

      sidebarContainer.appendChild(header);
      sidebarContainer.appendChild(iframe);
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
