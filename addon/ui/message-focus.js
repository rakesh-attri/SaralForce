// App-wide: when a success / warning / error message appears (or changes)
// after something the user did, scroll it into view and flash it once, so a
// result shown below the fold (e.g. "Trace flag created", an import error)
// is never missed.

export const MESSAGE_SELECTOR = [
  ".insp-error", ".insp-ok", ".insp-status-ok", ".insp-warn",
  ".error-banner", ".deploy-success-banner", ".deploy-partial-banner", ".deploy-error-msg"
].join(",");

// Only results of a recent click / key press, and never while the user is
// scrolling (a message from a slow background poll must not yank the page).
const ACTION_WINDOW_MS = 180000;
const SCROLL_QUIET_MS = 1500;

function scrollParents(el) {
  const out = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 2) out.push(p);
  }
  return out;
}

// Fully visible in the window and in every scrolling container around it?
export function isInView(el) {
  const r = el.getBoundingClientRect();
  if (!r.height && !r.width) return true; // hidden: nothing to scroll to
  if (r.top < 0 || r.bottom > window.innerHeight) return false;
  return scrollParents(el).every(p => {
    const pr = p.getBoundingClientRect();
    return r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1;
  });
}

export function installMessageFocus(root = document.body) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  let lastAction = 0;
  let lastScroll = 0;
  const onAction = () => { lastAction = Date.now(); };
  const onScroll = () => { lastScroll = Date.now(); };
  window.addEventListener("pointerdown", onAction, true);
  window.addEventListener("keydown", onAction, true);
  window.addEventListener("wheel", onScroll, {capture: true, passive: true});
  window.addEventListener("touchmove", onScroll, {capture: true, passive: true});

  let pending = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const now = Date.now();
    const els = [...pending].filter(el => el.isConnected && String(el.textContent || "").trim());
    pending = new Set();
    if (!els.length || now - lastAction > ACTION_WINDOW_MS || now - lastScroll < SCROLL_QUIET_MS) return;
    // Errors first, then the last message added.
    const target = els.find(el => el.matches(".insp-error, .error-banner, .deploy-error-msg")) || els[els.length - 1];
    if (!isInView(target)) {
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({behavior: reduce ? "auto" : "smooth", block: "center"});
    }
    target.classList.remove("ff-msg-flash");
    void target.offsetWidth; // restart the animation
    target.classList.add("ff-msg-flash");
    setTimeout(() => target.classList.remove("ff-msg-flash"), 1500);
  };
  const consider = el => {
    if (!el || el.nodeType !== 1) return;
    const msg = el.matches(MESSAGE_SELECTOR) ? el : el.closest(MESSAGE_SELECTOR);
    if (msg) pending.add(msg);
    else if (el.querySelectorAll) el.querySelectorAll(MESSAGE_SELECTOR).forEach(m => pending.add(m));
  };
  const obs = new MutationObserver(records => {
    for (const rec of records) {
      if (rec.type === "characterData") consider(rec.target.parentElement);
      else rec.addedNodes.forEach(n => consider(n.nodeType === 3 ? n.parentElement : n));
    }
    if (pending.size && !timer) timer = setTimeout(flush, 120);
  });
  obs.observe(root, {childList: true, subtree: true, characterData: true});
  return () => {
    obs.disconnect();
    window.removeEventListener("pointerdown", onAction, true);
    window.removeEventListener("keydown", onAction, true);
    window.removeEventListener("wheel", onScroll, {capture: true});
    window.removeEventListener("touchmove", onScroll, {capture: true});
  };
}
