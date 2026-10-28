// Colour theme: "system" (default, follows the OS), "light" or "dark".
// Kept in localStorage rather than chrome.storage because theme-init.js
// must read it synchronously before first paint to avoid a theme flash.

export const THEME_KEY = "sfoc_theme";
export const THEME_PREFERENCES = ["system", "light", "dark"];
const NEXT = {system: "light", light: "dark", dark: "system"};
const LABEL = {system: "System", light: "Light", dark: "Dark"};

function systemPrefersDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getThemePreference() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_PREFERENCES.includes(v) ? v : "system";
  } catch (e) {
    return "system";
  }
}

export function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark() ? "dark" : "light";
}

export function applyTheme(pref) {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  root.style.colorScheme = theme;
  return theme;
}

export function setThemePreference(pref) {
  const value = THEME_PREFERENCES.includes(pref) ? pref : "system";
  try { localStorage.setItem(THEME_KEY, value); } catch (e) { /* storage disabled */ }
  return applyTheme(value);
}

export function nextThemePreference(pref) {
  return NEXT[pref] || "system";
}

export function themeLabel(pref) {
  return LABEL[pref] || LABEL.system;
}

// Re-applies the theme when the OS setting changes while on "system".
// Returns an unsubscribe function.
export function watchSystemTheme(getPref, onChange) {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getPref() === "system") {
      const theme = applyTheme("system");
      if (onChange) onChange(theme);
    }
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
