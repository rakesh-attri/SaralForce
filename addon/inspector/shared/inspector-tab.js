// "Full screen": open the inspector itself in a browser tab, landing on a
// Metadata item (background.js turns `md` into openTab/mdKind/mdId params).
import {sfConn} from "../../inspector.js";

function currentHost() {
  try {
    return new URLSearchParams(location.search).get("host") || sfConn.instanceHostname || "";
  } catch (e) {
    return "";
  }
}

export function openMetadataInTab(kind, id) {
  const host = currentHost();
  const md = {kind: String(kind || ""), id: String(id || "")};
  try {
    if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({message: "openInspectorTab", host, md});
      return;
    }
  } catch (e) { /* fall back to a plain link */ }
  window.open(`object-creator.html?host=${encodeURIComponent(host)}&view=inspector&openTab=metadata` +
    `&mdKind=${encodeURIComponent(md.kind)}&mdId=${encodeURIComponent(md.id)}`, "_blank");
}

// True when this page is the inspector open in its own browser tab (the
// side panel is an iframe inside the Salesforce page).
export function isInspectorTab() {
  try {
    return window.top === window && /object-creator\.html$/.test(location.pathname);
  } catch (e) {
    return false;
  }
}

// Metadata target from this page's URL (only in a tab opened as above).
export function metadataTargetFromUrl() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("openTab") !== "metadata") return null;
    const kind = q.get("mdKind") || "";
    const id = q.get("mdId") || "";
    if (!/^[a-z]{2,20}$/.test(kind)) return null;
    return {kind, id: /^[\w.:-]{1,120}$/.test(id) ? id : ""};
  } catch (e) {
    return null;
  }
}
