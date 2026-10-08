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
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="sfbg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient><linearGradient id="sfbr" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs><rect width="120" height="120" rx="26" fill="url(#sfbg)"/><g transform="translate(14.5,21) scale(1.18)"><path d="M35 12 C24 12 15 20 13 31 C8 32 4 37 4 43 C4 49 9 54 15 54 L62 54 C68 54 73 49 73 43 C73 38 70 33 65 31 C63 20 54 12 43 12 C40 12 37 13 35 12 Z" fill="url(#sfbr)" opacity="0.15"/><path d="M33 10 C22.5 10 14 18.5 14 29 C9 30 5 34.5 5 40 C5 45.5 9.5 50 15 50 L58 50 C63.5 50 68 45.5 68 40 C68 35 64 31 59 30 C57 19.5 48.5 10 38 10 C35.5 10 34.2 10.5 33 10 Z" fill="none" stroke="url(#sfbr)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 31 L20 37 L26 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M47 31 L53 37 L47 43" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="41" y1="28" x2="32" y2="46" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></g></svg>`;
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

      sidebarContainer = document.createElement("div");
      sidebarContainer.id = "sf-object-creator-sidebar-host";
      sidebarContainer.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: min(920px, 75vw);
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

      const userChip = document.createElement("button");
      userChip.title = "Signed-in Salesforce user — click for details";
      userChip.style.cssText = [
        "display:flex", "align-items:center", "gap:8px",
        "background:#dcf5e3", "color:#14532d",
        "border:1px solid #b7e4c7", "border-radius:999px",
        "padding:3px 6px 3px 12px", "font-size:12px", "font-weight:600",
        "font-family:'Salesforce Sans',Arial,sans-serif",
        "cursor:pointer", "max-width:340px", "margin:0 8px"
      ].join(";");
      const userChipLabel = document.createElement("span");
      userChipLabel.textContent = "…";
      userChipLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const userAvatar = document.createElement("span");
      userAvatar.textContent = "?";
      userAvatar.style.cssText = [
        "display:inline-flex", "align-items:center", "justify-content:center",
        "width:24px", "height:24px", "border-radius:50%",
        "background:#6d28d9", "color:#fff", "font-size:11px", "font-weight:700",
        "flex:0 0 auto"
      ].join(";");
      userChip.appendChild(userChipLabel);
      userChip.appendChild(userAvatar);
      userChip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (userPopup) { closeUserPopup(); return; }
        if (!userInfoCache) {
          fetchUserCard(session.key).then((info) => {
            userInfoCache = info;
            paintUserChip(info, userChipLabel, userAvatar, userChip);
            openUserPopup();
          }).catch(() => openUserPopup());
          return;
        }
        openUserPopup();
      });
      header.appendChild(headerActions);
      header.insertBefore(userChip, headerActions);
      userChipEl = userChip;

      fetchUserCard(session.key).then((info) => {
        userInfoCache = info;
        paintUserChip(info, userChipLabel, userAvatar, userChip);
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
    closeUserPopup();
    userInfoCache = null;
    userChipEl = null;
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

  // ─── Signed-in user chip + profile popup (sidebar header) ──────────
  // Shows "OrgName: Welcome Full Name" with an avatar; click opens a card
  // with username, user/org ids, instance URL and Prod/Sandbox tag.
  let userPopup = null;
  let userChipEl = null;
  let userInfoCache = null;

  function closeUserPopup() {
    if (userPopup) userPopup.remove();
    userPopup = null;
    document.removeEventListener("mousedown", outsideUserPopup);
  }

  function outsideUserPopup(e) {
    if (userPopup && !userPopup.contains(e.target) &&
        (!userChipEl || !userChipEl.contains(e.target))) closeUserPopup();
  }

  function userInitials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function paintUserChip(info, labelEl, avatarEl, chipEl) {
    const name = info && info.name && info.name !== "—" ? info.name : "";
    const org = info && info.orgName ? info.orgName : "";
    if (!name && !org) {
      chipEl.style.display = "none";
      return;
    }
    labelEl.textContent = org && name ? `${org}: Welcome ${name}` : (org || `Welcome ${name}`);
    avatarEl.textContent = name ? userInitials(name) : "?";
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
    const orgQ = getJson(base + "/services/data/v67.0/query?q=" +
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

  function getRecordInfo() {
    const parts = [location.pathname, location.hash.replace(/^#/, "")];
    for (const p of parts) {
      const m = p.match(/\/(?:r|sObject)\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
      if (m) return {obj: m[1], id: m[2]};
      const m2 = p.match(/\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})(?:\/view)?\/?$/);
      if (m2) return {obj: m2[1], id: m2[2]};
    }
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
      const recordUrl = `${location.origin}/services/data/v67.0/ui-api/records/${rec.id}?layoutTypes=Full`;
      let rawRecord = null;
      const describeMap = (obj) => sfFetchJson(
        `${location.origin}/services/data/v67.0/sobjects/${obj}/describe`, token
      ).then((r) => labelMapFromDescribe(r.data));
      // Layout endpoint uses the same UI API auth path as the record call (REST
      // describe 401s on some orgs), so it is the primary fallback.
      const layoutMap = (obj, recordTypeId) => {
        const url = `${location.origin}/services/data/v67.0/ui-api/layout/${obj}?layoutType=Full&mode=View` +
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
    const fromPanel = ifr && event.source === ifr.contentWindow;
    const fromSelf = event.source === window;
    if (!fromPanel && !fromSelf) return;
    if (event.data.type === "sfoc-show-api-names") {
      toggleApiNames();
    } else if (event.data.type === "sfoc-query-api-names") {
      try { event.source.postMessage({type: "sfoc-api-names-state", on: apiNamesActive}, "*"); } catch (e) { /* ignore */ }
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
