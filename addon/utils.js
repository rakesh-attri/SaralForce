// Helpers derived in part from Salesforce-Inspector-reloaded
// (https://github.com/tprouvot/Salesforce-Inspector-reloaded)
// MIT License, Copyright (c) 2023 Thomas Prouvot. See LICENSE.
import {sfConn, apiVersion} from "./inspector.js";

if (typeof browser === "undefined") {
  var browser = chrome;
}

export class Constants {
  static ACCESS_TOKEN = "_access_token";
  static CODE_VERIFIER = "_code_verifier";
  static CLIENT_ID = "_clientId";
  // ForceForge External Client App consumer key (Setup → External Client App
  // Manager → Consumer Key and Secret). Public-client PKCE flow: no secret.
  static DEFAULT_CLIENT_ID = "3MVG9GBhY6wQjl2vmOksB1OaNFVitli1nhCByqjDeRWX3GJoBjiJUwAOz1imu4KU6FpTorToreT2U9NJTuNyi";
  static GLOBAL_LINKS_KEY = "globalLinks";
}

export function getLinkTarget(e = {}) {
  if (localStorage.getItem("openLinksInNewTab") == "true" || (e.ctrlKey || e.metaKey)) {
    return "_blank";
  } else {
    return "_top";
  }
}

export function isSettingEnabled(settingName, defaultValue = false){
  const value = localStorage.getItem(settingName);
  if (value === null) {
    return defaultValue;
  }
  return value === "true";
}

export function getBrowserType() {
  return navigator.userAgent?.includes("Chrome") ? "chrome" : "moz";
}

export function getExtensionId() {
  return chrome.i18n.getMessage("@@extension_id");
}

export function getClientId(sfHost) {
  const storedClientId = localStorage.getItem(sfHost + Constants.CLIENT_ID);
  return storedClientId || Constants.DEFAULT_CLIENT_ID;
}

export function getRedirectUri(page = "object-creator.html") {
  const browser = getBrowserType();
  const extensionId = getExtensionId();
  return `${browser}-extension://${extensionId}/${page}`;
}

export async function getPKCEParameters(sfHost) {
  try {
    const response = await fetch(`https://${sfHost}/services/oauth2/pkce/generator`);
    if (!response.ok) {
      throw new Error(`Failed to fetch PKCE parameters: ${response.status}`);
    }
    const data = await response.json();
    return {
      code_verifier: data.code_verifier,
      code_challenge: data.code_challenge
    };
  } catch (error) {
    console.error("Error fetching PKCE parameters:", error);
    throw error;
  }
}

// Clipboard write with a synchronous execCommand fallback. The panel runs in
// an iframe where navigator.clipboard may be blocked by Permissions Policy
// ("Failed to execute 'writeText' on 'Clipboard'..."), so never surface that
// raw error to the user — fall back to a textarea + execCommand copy.
export async function safeCopyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

export function copyToClipboard(value) {
  let temp = document.createElement("input");
  temp.value = "temp";
  temp.addEventListener("copy", e => {
    e.clipboardData.setData("text/plain", value);
    e.preventDefault();
  });
  document.body.appendChild(temp);
  try {
    temp.select();
    let success = document.execCommand("copy");
    if (!success) {
      alert("Copy failed");
    }
  } finally {
    document.body.removeChild(temp);
  }
}

export async function getUserInfo() {
  try {
    const res = await sfConn.soap(sfConn.wsdl(apiVersion, "Partner"), "getUserInfo", {});
    return {
      success: true,
      userInfo: res.userFullName + " / " + res.userName + " / " + res.organizationName,
      userFullName: res.userFullName,
      userInitials: res.userFullName.split(" ").map(n => n[0]).join(""),
      userName: res.userName,
      userError: null,
      userErrorDescription: null
    };
  } catch (error) {
    console.error("Error fetching user info:", error);
    return {
      success: false,
      userInfo: "Error loading user info",
      userFullName: "Unknown User",
      userInitials: "?",
      userName: "Unknown",
      userError: "Error fetching user info",
      userErrorDescription: "Session is probably expired or invalid"
    };
  }
}

export function createSpinForMethod(context) {
  return function(promise) {
    context.spinnerCount++;
    promise
      .catch(err => {
        console.error("spinFor", err);
      })
      .then(() => {
        context.spinnerCount--;
        context.didUpdate();
      })
      .catch(err => console.log("error handling failed", err));
  };
}

export class UserInfoModel {
  constructor(spinForCallback) {
    this.userInfo = "...";
    this.userFullName = "";
    this.userInitials = "";
    this.userName = "";
    this.userError = null;
    this.userErrorDescription = null;

    if (spinForCallback) {
      spinForCallback(this.fetchUserInfo());
    } else {
      this.fetchUserInfo();
    }
  }

  async fetchUserInfo() {
    const result = await getUserInfo();
    this.userInfo = result.userInfo;
    this.userFullName = result.userFullName;
    this.userInitials = result.userInitials;
    this.userName = result.userName;
    this.userError = result.userError;
    this.userErrorDescription = result.userErrorDescription;
  }

  getProps() {
    return {
      userInitials: this.userInitials,
      userFullName: this.userFullName,
      userName: this.userName,
      userError: this.userError,
      userErrorDescription: this.userErrorDescription
    };
  }
}
