// Full-screen code view opened from the Metadata tab ("Open full screen").
// The panel stores {title, subtitle, files: [{path, content, lang}]} under
// the key in the URL hash; this page renders it with line numbers.
import {apexHighlight} from "./inspector/shared/highlight.js";

const $ = id => document.getElementById(id);
const PREFS_KEY = "sfoc_codeview_prefs";

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(line, lang) {
  return lang === "apex" || lang === "js" ? apexHighlight(line) : escHtml(line);
}

// chrome.storage.local is shared by every extension page (the panel lives in
// an iframe on the Salesforce page); the dev preview falls back to localStorage.
function readPayload(key) {
  return new Promise(resolve => {
    try {
      if (globalThis.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(key, items => resolve(items && items[key] ? items[key] : null));
        return;
      }
    } catch (e) { /* fall through */ }
    try { resolve(JSON.parse(localStorage.getItem("chrome.storage:" + key) || "null")); }
    catch (e) { resolve(null); }
  });
}

function loadPrefs() {
  try { return {size: 13, wrap: false, theme: "dark", ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")}; }
  catch (e) { return {size: 13, wrap: false, theme: "dark"}; }
}

const prefs = loadPrefs();
let payload = null;
let active = 0;

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty("--cv-size", prefs.size + "px");
  $("cv-main").classList.toggle("wrap", prefs.wrap);
  $("cv-wrap").setAttribute("aria-pressed", String(prefs.wrap));
}

function renderFiles() {
  const nav = $("cv-files");
  nav.textContent = "";
  nav.hidden = payload.files.length < 2;
  payload.files.forEach((f, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "tab";
    b.className = "cv-file" + (i === active ? " active" : "");
    b.setAttribute("aria-selected", String(i === active));
    b.textContent = f.path.split("/").pop();
    b.title = f.path;
    b.addEventListener("click", () => { active = i; renderFiles(); renderCode(); });
    nav.appendChild(b);
  });
}

function renderCode() {
  const f = payload.files[active];
  const lines = String(f.content || "").replace(/\r\n/g, "\n").split("\n");
  const rows = lines.map((ln, i) =>
    `<tr id="L${i + 1}"><td class="cv-ln"><a href="#L${i + 1}">${i + 1}</a></td><td class="cv-src">${highlight(ln, f.lang) || " "}</td></tr>`);
  $("cv-main").innerHTML = `<table class="cv-code"><tbody>${rows.join("")}</tbody></table>`;
  document.title = `${f.path.split("/").pop()} · SaralForce`;
  find();
}

// Highlight every line containing the search text; Enter jumps to the next.
let hitIndex = -1;
function find(jump) {
  const term = $("cv-find").value.trim().toLowerCase();
  const rows = [...document.querySelectorAll(".cv-code tr")];
  rows.forEach(r => r.classList.remove("hit", "hit-now"));
  if (!term) { $("cv-hits").textContent = ""; return; }
  const hits = rows.filter(r => r.querySelector(".cv-src").textContent.toLowerCase().includes(term));
  hits.forEach(r => r.classList.add("hit"));
  $("cv-hits").textContent = hits.length ? `${hits.length} line${hits.length === 1 ? "" : "s"}` : "no match";
  if (jump && hits.length) {
    hitIndex = (hitIndex + 1) % hits.length;
    hits[hitIndex].classList.add("hit-now");
    hits[hitIndex].scrollIntoView({block: "center"});
  }
}

function bind() {
  $("cv-wrap").addEventListener("click", () => { prefs.wrap = !prefs.wrap; savePrefs(); applyPrefs(); });
  $("cv-smaller").addEventListener("click", () => { prefs.size = Math.max(10, prefs.size - 1); savePrefs(); applyPrefs(); });
  $("cv-bigger").addEventListener("click", () => { prefs.size = Math.min(24, prefs.size + 1); savePrefs(); applyPrefs(); });
  $("cv-theme").addEventListener("click", () => { prefs.theme = prefs.theme === "dark" ? "light" : "dark"; savePrefs(); applyPrefs(); });
  $("cv-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payload.files[active].content || "");
      $("cv-copy").textContent = "Copied";
      setTimeout(() => { $("cv-copy").textContent = "Copy"; }, 1200);
    } catch (e) { /* clipboard blocked */ }
  });
  $("cv-download").addEventListener("click", () => {
    const f = payload.files[active];
    const url = URL.createObjectURL(new Blob([f.content || ""], {type: "text/plain"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.path.split("/").pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("cv-find").addEventListener("input", () => { hitIndex = -1; find(); });
  $("cv-find").addEventListener("keydown", e => { if (e.key === "Enter") find(true); });
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("cv-find").focus(); }
  });
}

async function main() {
  applyPrefs();
  bind();
  const key = decodeURIComponent(location.hash.slice(1));
  payload = key ? await readPayload(key) : null;
  if (!payload || !Array.isArray(payload.files) || !payload.files.length) {
    $("cv-name").textContent = "Nothing to show";
    $("cv-sub").textContent = "Open this page from SaralForce → Metadata → Open full screen.";
    return;
  }
  $("cv-name").textContent = payload.title || "Code";
  $("cv-sub").textContent = payload.subtitle || "";
  renderFiles();
  renderCode();
}

main();
