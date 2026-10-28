// Small user preferences shared by the panel and the Settings page.
import {getSetting, setSetting} from "./storage.js";

const INSPECTOR_TAB_KEY = "sfoc_open_inspector_tab";

// Open the Inspector in a full browser tab instead of the sidebar.
export function openInspectorInNewTab() {
  const v = getSetting(INSPECTOR_TAB_KEY, false);
  return v === true || v === "true";
}

export function setOpenInspectorInNewTab(on) {
  setSetting(INSPECTOR_TAB_KEY, !!on);
}
