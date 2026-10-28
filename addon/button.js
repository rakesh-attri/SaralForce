(function() {
  "use strict";

  // Keep in sync with defaultApiVersion in inspector.js (checked by
  // test/unit/api-version.test.js). A content script cannot import modules.
  const API_VERSION = "67.0";

  // Messages to the panel iframe go only to the extension's own origin.
  const PANEL_ORIGIN = new URL(chrome.runtime.getURL(""), location.href).origin;

  let sfHost = null;
  let sidebarOpen = false;
  let sidebarContainer = null;

  // Host-page boot id: bumped once per host document load (top frame only)
  // and passed to the panel iframe. The panel stamps its minimize snapshot
  // with it and ignores snapshots from an older boot — so a host-page
  // reload always reopens on a fresh page instead of the pre-reload one.
  let hostBoot = null;
  if (window.top === window) {
    try {
      const n = parseInt(sessionStorage.getItem("sfoc_host_boot") || "0", 10) || 0;
      hostBoot = n + 1;
      sessionStorage.setItem("sfoc_host_boot", String(hostBoot));
    } catch (e) { hostBoot = null; }
  }

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
      top: calc(50% - 1.5in);
      right: 10px;
      transform: translateY(-50%);
      z-index: 2147483647;
      width: 42px;
      height: 42px;
      border-radius: 50%;
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
    btn.innerHTML = `<svg width="26" height="26" viewBox="0 0 128 128" aria-hidden="true"><defs><linearGradient id="sfbTile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c2452"/><stop offset="1" stop-color="#0a0f26"/></linearGradient><linearGradient id="sfbCloud" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#ffd36e"/><stop offset="0.5" stop-color="#ff9a1f"/><stop offset="1" stop-color="#f05a0e"/></linearGradient><radialGradient id="sfbHalo" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="#ff9a1f" stop-opacity="0.45"/><stop offset="1" stop-color="#ff9a1f" stop-opacity="0"/></radialGradient></defs><rect x="2" y="2" width="124" height="124" rx="28" fill="url(#sfbTile)"/><rect x="2.5" y="2.5" width="123" height="123" rx="27.5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/><circle cx="64" cy="70" r="54" fill="url(#sfbHalo)"/><g transform="translate(0 -4)"><path d="M36 98 H94 A19 19 0 0 0 97.5 60.4 A30 30 0 0 0 40.6 56.6 A21 21 0 0 0 36 98 Z" fill="url(#sfbCloud)"/><path d="M43 64 A16 16 0 0 1 57 50" fill="none" stroke="#fff6dc" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round"/><g fill="none" stroke="#141a3c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M51 69 L41 78.5 L51 88"/><path d="M71 64 L61 93"/><path d="M81 69 L91 78.5 L81 88"/></g></g><path d="M101 14 Q103 25 112 27 Q103 29 101 40 Q99 29 90 27 Q99 25 101 14 Z" fill="#fff3c4"/></svg>`;
    btn.title = "SaralForce";

    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "1";
      btn.style.transform = "translateY(-50%) scale(1.05)";
    });

    btn.addEventListener("mouseleave", () => {
      if (!sidebarOpen) {
        btn.style.opacity = "0.6";
      }
      btn.style.transform = "translateY(-50%) scale(1)";
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
      lastSessionKey = session.key;

      sidebarContainer = document.createElement("div");
      sidebarContainer.id = "sf-object-creator-sidebar-host";
      sidebarContainer.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: min(1024px, 75vw);
        height: 100vh;
        z-index: 2147483646;
        box-shadow: -4px 0 24px rgba(0,0,0,0.2);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        transform: translateX(100%);
        background: #0B0F19;
      `;

      const header = document.createElement("div");
      header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: rgba(11, 15, 25, 0.95);
        border-bottom: 1px solid rgba(255, 255, 255, 0.10);
        color: #fff;
        font-family: 'Salesforce Sans', Arial, sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: move;
        user-select: none;
      `;
      header.innerHTML = `
        <span style="display:flex;align-items:center;gap:8px;">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="sfhCloud" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#ffc24a"/><stop offset="1" stop-color="#f05a0e"/></linearGradient></defs><rect x="0" y="0" width="16" height="16" rx="3.5" fill="#141a3c"/><g transform="translate(0 -0.8)"><path d="M3 14 H12.5 A2.8 2.8 0 0 0 13 8.4 A4.6 4.6 0 0 0 4.3 7.6 A3.3 3.3 0 0 0 3 14 Z" fill="url(#sfhCloud)"/><path d="M6.6 9.4 L5 11 L6.6 12.6 M9.4 9.4 L11 11 L9.4 12.6" fill="none" stroke="#141a3c" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g></svg>
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

      const loadTimer = document.createElement("span");
      loadTimer.style.cssText = `
        color: #94a3b8;
        font-size: 11px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        padding: 0 6px;
        cursor: default;
      `;
      const paintLoadTimer = () => {
        let ms = null;
        try {
          const nav = performance && performance.getEntriesByType &&
            performance.getEntriesByType("navigation")[0];
          if (nav && nav.loadEventEnd > 0) ms = Math.max(0, Math.round(nav.loadEventEnd - nav.startTime));
        } catch (e) { /* timing API unavailable — stays blank */ }
        if (ms == null) {
          loadTimer.textContent = "⏱ …";
          loadTimer.title = "Page load time (page still loading…)";
        } else {
          const s = Math.floor(ms / 1000);
          loadTimer.textContent = `⏱ ${s}s ${ms - s * 1000}ms`;
          loadTimer.title = `Page load: ${ms} ms (last full load)`;
        }
      };
      paintLoadTimer();
      try {
        if (document.readyState !== "complete") {
          window.addEventListener("load", paintLoadTimer, {once: true});
        }
      } catch (e) { /* ignore */ }

      const headerActions = document.createElement("span");
      headerActions.style.cssText = "display:flex;align-items:center;gap:2px;";
      headerActions.appendChild(settingsBtn);
      headerActions.appendChild(loadTimer);
      headerActions.appendChild(closeBtn);

      const userChip = document.createElement("span");
      userChip.style.cssText = [
        "display:flex", "align-items:center", "gap:8px",
        "background:#dcf5e3", "color:#14532d",
        "border:1px solid #b7e4c7", "border-radius:999px",
        "padding:3px 12px", "font-size:12px", "font-weight:600",
        "font-family:'Salesforce Sans',Arial,sans-serif",
        "max-width:340px", "margin:0 8px"
      ].join(";");
      const userChipLabel = document.createElement("span");
      userChipLabel.textContent = "…";
      userChipLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      userChip.appendChild(userChipLabel);
      header.appendChild(headerActions);
      header.insertBefore(userChip, headerActions);
      userChipEl = userChip;
      userChipLabelEl = userChipLabel;

      fetchUserCard(session.key).then((info) => {
        userInfoCache = info;
        paintUserChip(info, userChipLabel, userChip);
      }).catch(() => { userChip.style.display = "none"; });

      const iframe = document.createElement("iframe");
      iframe.id = "sf-object-creator-iframe";
      // Cross-origin embed: without an explicit allowlist the panel's
      // clipboard writes are blocked by Permissions Policy (Copy Id etc.).
      iframe.setAttribute("allow", "clipboard-read; clipboard-write");
      iframe.style.cssText = `
        width: 100%;
        height: calc(100vh - 40px);
        border: none;
        display: block;
      `;
      iframe.src = chrome.runtime.getURL(`object-creator.html?host=${encodeURIComponent(sfHost)}` +
        (hostBoot != null ? `&hostBoot=${hostBoot}` : ""));

      sidebarContainer.appendChild(header);
      sidebarContainer.appendChild(iframe);
      document.body.appendChild(sidebarContainer);

      // The panel looks the session up itself through the extension's
      // background worker; it is never written to this page's storage or
      // posted across frames.

      requestAnimationFrame(() => {
        sidebarContainer.style.transform = "translateX(0)";
      });

      sidebarOpen = true;
      document.getElementById("sf-object-creator-btn")?.style.setProperty("opacity", "1");
    });
  }

  function closeSidebar() {
    if (!sidebarContainer) return;
    closeUserPopup();
    userInfoCache = null;
    userChipEl = null;
    userChipLabelEl = null;
    // Ask iframe to save state before we destroy it
    const iframe = document.getElementById("sf-object-creator-iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({type: "sfoc-save-state"}, PANEL_ORIGIN);
    }
    sidebarContainer.style.transform = "translateX(100%)";
    setTimeout(() => {
      sidebarContainer?.remove();
      sidebarContainer = null;
    }, 300);
    sidebarOpen = false;
    document.getElementById("sf-object-creator-btn")?.style.setProperty("opacity", "0.6");
  }

  // ─── Signed-in user chip + profile popup (sidebar header) ──────────
  // Shows "OrgName: Welcome Full Name" with an avatar; click opens a card
  // with username, user/org ids, instance URL and Prod/Sandbox tag.
  let userPopup = null;
  let userChipEl = null;
  let userChipLabelEl = null;
  let userInfoCache = null;
  let lastSessionKey = null;

  function closeUserPopup() {
    if (userPopup) userPopup.remove();
    userPopup = null;
    document.removeEventListener("mousedown", outsideUserPopup);
  }

  function outsideUserPopup(e) {
    if (userPopup && !userPopup.contains(e.target) &&
        (!userChipEl || !userChipEl.contains(e.target))) closeUserPopup();
  }

  function mergeUserInfo(old, incoming) {
    if (!incoming) return old;
    if (!old) return incoming;
    const out = {...old};
    for (const k of Object.keys(incoming)) {
      const v = incoming[k];
      if (k === "sandbox") {
        if (typeof out.sandbox !== "boolean" && typeof v === "boolean") out.sandbox = v;
        continue;
      }
      if ((v === "" || v == null || v === "—") ||
          (out[k] !== "" && out[k] != null && out[k] !== "—")) continue;
      out[k] = v;
    }
    return out;
  }

  function toggleUserCard() {
    if (userPopup) { closeUserPopup(); return; }
    if (!userInfoCache) {
      fetchUserCard(lastSessionKey).then((info) => {
        userInfoCache = info;
        if (userChipEl && userChipLabelEl) paintUserChip(userInfoCache, userChipLabelEl, userChipEl);
        openUserPopup();
      }).catch(() => openUserPopup());
      return;
    }
    openUserPopup();
  }

  function paintUserChip(info, labelEl, chipEl) {
    const name = info && info.name && info.name !== "—" ? info.name : "";
    const org = info && info.orgName ? info.orgName : "";
    if (!name && !org) {
      chipEl.style.display = "none";
      return;
    }
    chipEl.style.display = "";
    const tag = info && typeof info.sandbox === "boolean" ? (info.sandbox ? "Sandbox" : "Prod") : "";
    if (org && name) {
      labelEl.textContent = tag ? `${org} (${tag}) : Welcome ${name}` : `${org} : Welcome ${name}`;
    } else {
      labelEl.textContent = tag && org ? `${org} (${tag})` : (org || `Welcome ${name}`);
    }
  }

  function fetchUserCard(token) {
    const base = location.origin;
    const headers = {Accept: "application/json"};
    if (token) headers.Authorization = "Bearer " + token;
    const getJson = (url) => fetch(url, {headers}).then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        try { return await res.json(); } catch (e) { return null; }
      });
    const ui = getJson(base + "/services/oauth2/userinfo").catch(() => null);
    const orgQ = getJson(base + `/services/data/v${API_VERSION}/query?q=` +
      encodeURIComponent("SELECT Id,Name,IsSandbox,InstanceName FROM Organization")).catch(() => null);
    return Promise.all([ui, orgQ]).then(([u, o]) => {
      const org = (o && o.records && o.records[0]) || {};
      return {
        name: (u && (u.name || u.nickname || u.preferred_username)) || "—",
        username: (u && u.preferred_username) || "",
        userId: (u && u.user_id) || "",
        orgName: org.Name || "",
        orgId: org.Id || (u && u.organization_id) || "",
        sandbox: org.IsSandbox === true,
        instanceUrl: base
      };
    });
  }

  function openUserPopup() {
    closeUserPopup();
    const info = userInfoCache;
    userPopup = document.createElement("div");
    userPopup.style.cssText = [
      "position:absolute", "top:46px", "right:12px", "width:300px",
      "background:#fff", "color:#0f172a", "border-radius:12px",
      "box-shadow:0 12px 32px rgba(2,16,44,.35)", "border:1px solid #e2e8f0",
      "font-family:'Salesforce Sans',Arial,sans-serif", "font-size:12px",
      "z-index:10", "padding:14px 16px", "line-height:1.5"
    ].join(";");
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:8px;";
    const title = document.createElement("div");
    title.style.cssText = "font-size:14px;font-weight:700;";
    title.textContent = info ? info.name : "Loading…";
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Close";
    x.style.cssText = "background:none;border:none;font-size:18px;line-height:1;cursor:pointer;color:#64748b;padding:0 2px;";
    x.addEventListener("click", (e) => { e.stopPropagation(); closeUserPopup(); });
    head.appendChild(title);
    head.appendChild(x);
    userPopup.appendChild(head);
    const addRow = (label, value, bold) => {
      const row = document.createElement("div");
      if (bold) row.style.fontWeight = "700";
      else if (label) {
        const k = document.createElement("span");
        k.style.color = "#64748b";
        k.textContent = label + ": ";
        row.appendChild(k);
      }
      const v = document.createElement("span");
      v.textContent = value == null || value === "" ? "—" : String(value);
      row.appendChild(v);
      userPopup.appendChild(row);
    };
    if (!info) {
      addRow("", "Could not load user info.");
    } else {
      addRow("", info.username);
      addRow("User ID", info.userId);
      addRow("", `${info.orgName || "Org"} (${info.sandbox ? "Sandbox" : "Prod"})`, true);
      addRow("", info.instanceUrl);
      addRow("Org ID", info.orgId);
    }
    if (sidebarContainer) sidebarContainer.appendChild(userPopup);
    document.addEventListener("mousedown", outsideUserPopup);
  }

  // ─── API Names overlay: show field API names on the Salesforce page ──
  // The panel's "API Names" button postMessages here; we read the open
  // record via the UI API and drop a copyable chip under every field label.
  let apiNamesActive = false;
  let apiNamesBusy = false;

  function ensureApiNamesStyle() {
    if (document.getElementById("sfapi-style")) return;
    const style = document.createElement("style");
    style.id = "sfapi-style";
    style.textContent = `
      .sfapi-name-chip {
        display: inline-flex; align-items: center; gap: 4px;
        margin: 2px 0 6px; padding: 1px 7px;
        font-family: 'Salesforce Sans', Arial, sans-serif;
        font-size: 11px; line-height: 1.6; font-weight: 600;
        color: #0176d3; background: #eef4ff;
        border: 1px solid #d5e2f7; border-radius: 999px;
        cursor: pointer; user-select: none;
        transition: background .15s ease, border-color .15s ease, transform .15s ease;
      }
      .sfapi-name-chip:hover {
        background: #dbeafe; border-color: #93c5fd; transform: translateY(-1px);
      }
      .sfapi-name-chip::after {
        content: "\\29C9"; opacity: 0; font-size: 10px; transition: opacity .15s ease;
      }
      .sfapi-name-chip:hover::after { opacity: .85; }
      .sfapi-name-chip.sfapi-copied {
        color: #2e844a; background: #eafbea; border-color: #9fe0ad;
      }
      .sfapi-name-chip.sfapi-copied::after { content: none; }
      .sfapi-toast {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        max-width: 400px;
        background: #032d60; color: #fff;
        font: 600 13px/1.45 'Salesforce Sans', Arial, sans-serif;
        padding: 10px 14px; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(2, 16, 44, .35);
        animation: sfapi-toast-in .25s ease;
      }
      .sfapi-toast.sfapi-toast-err { background: #ba0517; }
      @keyframes sfapi-toast-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  function apiNamesToast(text, isError) {
    ensureApiNamesStyle();
    let t = document.getElementById("sfapi-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "sfapi-toast";
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.className = isError ? "sfapi-toast sfapi-toast-err" : "sfapi-toast";
    t.style.display = "block";
    clearTimeout(apiNamesToast._h);
    apiNamesToast._h = setTimeout(() => { t.style.display = "none"; }, 4000);
  }

  // Deep query that pierces open shadow roots (Lightning renders fields in LWCs).
  function deepElements(root, out) {
    out = out || [];
    const nodes = root.querySelectorAll("*");
    for (const el of nodes) {
      out.push(el);
      if (el.shadowRoot) deepElements(el.shadowRoot, out);
    }
    return out;
  }

  function removeApiNameChips() {
    for (const el of deepElements(document.body)) {
      if (el.classList && el.classList.contains("sfapi-name-chip")) el.remove();
    }
  }

  function copyTextPlain(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (e) { /* best effort */ }
  }

  function copyApiText(api) {
    let p = Promise.resolve(false);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        p = navigator.clipboard.writeText(api).then(() => true).catch(() => false);
      }
    } catch (e) { p = Promise.resolve(false); }
    Promise.race([p, new Promise((r) => setTimeout(() => r(false), 400))])
      .then((ok) => { if (!ok) copyTextPlain(api); });
  }

  function buildApiChip(api) {
    ensureApiNamesStyle();
    const chip = document.createElement("span");
    chip.className = "sfapi-name-chip";
    chip.textContent = api;
    chip.title = "Click to copy " + api;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyApiText(api);
      chip.textContent = "\u2713 Copied";
      chip.classList.add("sfapi-copied");
      setTimeout(() => {
        chip.textContent = api;
        chip.classList.remove("sfapi-copied");
      }, 900);
    }, true);
    return chip;
  }

  // ─── Setup pages ────────────────────────────────────────────────────────
  // Setup record pages wrap their target in the `address` query param, e.g.
  //   /lightning/setup/ManageUsers/page?address=%2F005f6000008kWGP%3FisUserEntityOverride%3D1…
  // Decode the wrapped target (sometimes double-encoded: a URL inside the
  // address) and pull the object/record out of it. Object Manager pages
  // carry the object API name directly in the path instead.
  function parseSetupContext() {
    const path = location.pathname;
    if (path.indexOf("/lightning/setup/") !== 0) return null;

    // Object Manager detail page (field / layout / record type record):
    // /lightning/setup/ObjectManager/{Obj}/{Segment}/{15-18 id}/view
    const omRec = path.match(
      /^\/lightning\/setup\/ObjectManager\/[A-Za-z0-9_.]+\/[A-Za-z0-9]+\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (omRec) return {obj: null, id: omRec[1]};

    // Object Manager object page: object known, no record of its own (the
    // object name can never be 15-18 chars here — it is checked only when
    // the detail pattern above did not already match a real record Id).
    const omObj = path.match(/^\/lightning\/setup\/ObjectManager\/([A-Za-z0-9_.]+)(?:\/|$)/);
    if (omObj) return {obj: omObj[1], id: null};

    // Wrapped target: /lightning/setup/{SetupNode}/page?address=…
    let target = null;
    try { target = new URLSearchParams(location.search).get("address"); } catch (e) { target = null; }
    if (!target) return null;
    for (let i = 0; i < 2; i++) {
      let dec;
      try { dec = decodeURIComponent(target); } catch (e) { break; }
      if (dec === target) break;
      target = dec;
    }
    // /r/{Obj}/{id} (and the lightning/r + sObject spellings) inside the target.
    const lit = target.match(
      /\/(?:lightning\/r|sObject|r)\/([A-Za-z0-9_.]+)\/([a-zA-Z0-9]{15,18})(?:\/view)?/);
    if (lit) return {obj: lit[1], id: lit[2]};
    // Bare record URL — /{15-18 id} at the very start of the target …
    const bare = target.match(/^[=?/]+([a-zA-Z0-9]{15,18})(?=$|[/?&#])/);
    if (bare) return {obj: null, id: bare[1]};
    // … or behind a classic ?id= style parameter inside it.
    const byParam = target.match(/[?&#](?:id|recordId|cid)=([a-zA-Z0-9]{15,18})(?=$|[^a-zA-Z0-9])/);
    if (byParam) return {obj: null, id: byParam[1]};
    return null;
  }

  function getRecordInfo() {
    // Setup first: its URLs never match the patterns below, and the wrapped
    // target can itself be a normal record URL.
    const setup = parseSetupContext();
    if (setup) return setup;
    const parts = [location.pathname, location.hash.replace(/^#/, "")];
    for (const p of parts) {
      const m = p.match(/\/(?:r|sObject)\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
      if (m) return {obj: m[1], id: m[2]};
      // Generic end-of-path fallback — only inside Salesforce UI paths
      // (Lightning, one.app, community /s/), so a home/setup/dashboard page
      // whose URL happens to end /Word/<15-18 chars> can never fake a
      // record context.
      const m2 = /^\/(?:lightning\/one|one|s)\//.test(p)
        ? p.match(/\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})(?:\/view)?\/?$/) : null;
      if (m2) return {obj: m2[1], id: m2[2]};
      // Object / list page (Records tab VIEW O): object known, no record.
      const m3 = p.match(/\/o\/([A-Za-z0-9_]+)\/(?:list|home)(?:\/|$)/);
      if (m3) return {obj: m3[1], id: null};
    }
    // Classic record page: the whole path is one record Id. The panel
    // resolves the object from the Id prefix (object unknown here).
    const classic = location.pathname.match(/^\/([a-zA-Z0-9]{15,18})\/?$/);
    if (classic) return {obj: null, id: classic[1]};
    const rid = new URLSearchParams(location.search).get("rid");
    if (rid && /^[a-zA-Z0-9]{15,18}$/.test(rid)) return {obj: null, id: rid};
    return null;
  }

  function sfFetchJson(url, token) {
    return fetch(url, {
      headers: {"Authorization": "Bearer " + token, "Accept": "application/json"}
    }).then(async (res) => {
      const text = await res.text().catch(() => "");
      let data = null;
      let parseErr = false;
      try { data = JSON.parse(text); } catch (e) { parseErr = true; }
      if (!res.ok) {
        const msg = (Array.isArray(data) && data[0] && data[0].message) ||
          (data && data.message) || (parseErr && text ? String(text).slice(0, 160) : "") ||
          ("HTTP " + res.status);
        throw new Error(msg);
      }
      return {data, parseErr, text};
    });
  }

  function labelMapFromRecord(data) {
    const m = new Map();
    const fields = (data && data.fields) || {};
    for (const api of Object.keys(fields)) {
      const f = fields[api];
      if (f && f.label && !m.has(f.label)) m.set(f.label, api);
    }
    return m;
  }

  function labelMapFromDescribe(desc) {
    const m = new Map();
    for (const f of ((desc && desc.fields) || [])) {
      if (f && f.label && f.name && !m.has(f.label)) m.set(f.label, f.name);
    }
    return m;
  }

  // UI API layout shape: sections[].layoutRows[].layoutItems[].layoutComponents[]
  // Each item carries the page label; each Field component carries apiName + field label.
  function labelMapFromSections(layout) {
    const m = new Map();
    for (const sec of ((layout && layout.sections) || [])) {
      for (const row of (sec.layoutRows || [])) {
        for (const item of (row.layoutItems || [])) {
          const comps = (item.layoutComponents || [])
            .filter(c => c && c.apiName && c.componentType === "Field");
          if (!comps.length) continue;
          if (item.label && !m.has(item.label)) {
            const match = comps.find(c => c.label === item.label);
            m.set(item.label, (match || comps[0]).apiName);
          }
          for (const c of comps) {
            if (c.label && !m.has(c.label)) m.set(c.label, c.apiName);
          }
        }
      }
    }
    return m;
  }

  function injectApiChips(labelMap) {
    removeApiNameChips();
    const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "A", "BUTTON", "INPUT",
      "TEXTAREA", "SELECT", "OPTION", "IFRAME", "NOSCRIPT", "CODE", "PRE"]);
    let count = 0;
    for (const el of deepElements(document.body)) {
      if (SKIP.has(el.tagName)) continue;
      if (el.closest && el.closest("#sf-object-creator-sidebar-host, #sf-object-creator-btn, #sfapi-toast, .sfapi-name-chip")) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 60 || !labelMap.has(text)) continue;
      // Innermost matching element only — skip wrappers with same text child.
      let hasSameChild = false;
      for (const c of el.children || []) {
        if ((c.textContent || "").trim() === text) { hasSameChild = true; break; }
      }
      if (hasSameChild) continue;
      if (el.nextElementSibling && el.nextElementSibling.classList &&
          el.nextElementSibling.classList.contains("sfapi-name-chip")) continue;
      el.insertAdjacentElement("afterend", buildApiChip(labelMap.get(text)));
      count++;
    }
    return count;
  }

  function toggleApiNames() {
    if (apiNamesBusy) return;
    const existing = deepElements(document.body)
      .filter(el => el.classList && el.classList.contains("sfapi-name-chip"));
    if (apiNamesActive && existing.length) {
      existing.forEach(el => el.remove());
      apiNamesActive = false;
      apiNamesToast("API names hidden.");
      return;
    }
    const rec = getRecordInfo();
    if (!rec || !rec.id) {
      apiNamesToast("Open a Salesforce record page to show API names.", true);
      return;
    }
    apiNamesBusy = true;
    apiNamesToast("Loading API names\u2026");
    chrome.runtime.sendMessage({message: "getSession", sfHost}, (session) => {
      if (!session || !session.key) {
        apiNamesBusy = false;
        apiNamesToast("No active Salesforce session — log in first.", true);
        return;
      }
      const token = session.key;
      const recordUrl = `${location.origin}/services/data/v${API_VERSION}/ui-api/records/${rec.id}?layoutTypes=Full`;
      let rawRecord = null;
      const describeMap = (obj) => sfFetchJson(
        `${location.origin}/services/data/v${API_VERSION}/sobjects/${obj}/describe`, token
      ).then((r) => labelMapFromDescribe(r.data));
      // Layout endpoint uses the same UI API auth path as the record call (REST
      // describe 401s on some orgs), so it is the primary fallback.
      const layoutMap = (obj, recordTypeId) => {
        const url = `${location.origin}/services/data/v${API_VERSION}/ui-api/layout/${obj}?layoutType=Full&mode=View` +
          (recordTypeId ? `&recordTypeId=${encodeURIComponent(recordTypeId)}` : "");
        return sfFetchJson(url, token).then((r) => labelMapFromSections(r.data));
      };
      const fallbackMap = (obj, recordTypeId) =>
        layoutMap(obj, recordTypeId).catch((e) => {
          console.warn("[SaralForce] API Names: UI API layout request failed.", e && e.message);
          return null;
        }).then((m) => {
          if (m && m.size) return m;
          console.warn("[SaralForce] API Names: layout had no fields; trying REST describe as last resort.");
          return describeMap(obj).catch((e) => {
            console.warn("[SaralForce] API Names: REST describe failed.", e && e.message);
            return new Map();
          });
        });
      sfFetchJson(recordUrl, token)
        .then((r) => {
          rawRecord = r.data;
          if (r.parseErr) {
            console.warn("[SaralForce] API Names: UI API response was not JSON.", (r.text || "").slice(0, 300));
          }
          let m = labelMapFromRecord(r.data);
          if (!m.size) m = labelMapFromSections(r.data && r.data.layout);
          if (m.size) return m;
          const obj = (r.data && r.data.apiName) || rec.obj;
          console.warn("[SaralForce] API Names: record response had no labels; fetching UI API layout.", r.data);
          if (!obj) return m;
          return fallbackMap(obj, (r.data && r.data.recordTypeId) || "");
        }, (err) => {
          if (!rec.obj) throw err;
          console.warn("[SaralForce] API Names: record request failed; using layout/describe.", err && err.message);
          return fallbackMap(rec.obj, "");
        })
        .then((labelMap) => {
          apiNamesBusy = false;
          if (!labelMap.size) {
            console.warn("[SaralForce] API Names: no label mappings available. UI API payload:", rawRecord);
            apiNamesToast("No fields found on this record layout.", true);
            return;
          }
          const count = injectApiChips(labelMap);
          if (count) {
            apiNamesActive = true;
            apiNamesToast(`\u2728 ${count} API name${count === 1 ? "" : "s"} shown — click any chip to copy.`);
          } else {
            apiNamesActive = false;
            apiNamesToast("No field labels matched on this page — scroll to the Details section and try again.", true);
          }
        })
        .catch(err => {
          apiNamesBusy = false;
          apiNamesActive = false;
          apiNamesToast("Could not load API names: " + err.message, true);
        });
    });
  }

  // The panel iframe (and the app when opened standalone) asks us to toggle.
  window.addEventListener("message", (event) => {
    if (!event.data || !event.data.type) return;
    const ifr = document.getElementById("sf-object-creator-iframe");
    // Only the panel iframe (extension origin) may drive the sidebar.
    const fromPanel = ifr && event.source === ifr.contentWindow && event.origin === PANEL_ORIGIN;
    if (!fromPanel) return;
    if (event.data.type === "sfoc-show-api-names") {
      toggleApiNames();
    } else if (event.data.type === "sfoc-query-api-names") {
      try { event.source.postMessage({type: "sfoc-api-names-state", on: apiNamesActive}, PANEL_ORIGIN); } catch (e) { /* ignore */ }
    } else if (event.data.type === "sfoc-query-open-record") {
      try { event.source.postMessage({type: "sfoc-open-record", rec: getRecordInfo()}, PANEL_ORIGIN); } catch (e) { /* ignore */ }
    } else if (event.data.type === "sfoc-user-card") {
      userInfoCache = mergeUserInfo(userInfoCache, event.data.info || null);
      if (userChipEl && userChipLabelEl) {
        paintUserChip(userInfoCache, userChipLabelEl, userChipEl);
      }
    } else if (event.data.type === "sfoc-show-user-card") {
      toggleUserCard();
    } else if (event.data.type === "sfoc-close-sidebar") {
      closeSidebar();
    }
  });

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
