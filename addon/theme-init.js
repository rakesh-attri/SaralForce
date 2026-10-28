// Applies the saved colour theme before first paint (classic script in
// <head>, so there is no light/dark flash). Mirrors core/theme.js.
(function() {
  var pref = "system";
  try {
    var saved = localStorage.getItem("sfoc_theme");
    if (saved === "light" || saved === "dark" || saved === "system") pref = saved;
  } catch (e) { /* storage disabled */ }
  var dark = pref === "dark" || (pref === "system" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  if (dark) {
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  }
  root.style.colorScheme = dark ? "dark" : "light";
})();
