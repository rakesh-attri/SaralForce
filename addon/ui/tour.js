// Guided tours: a spotlight around one element plus a step card with Back /
// Next / Skip. Plain DOM (no React) so the panel and the Settings page share
// it. Colours match the confirm dialog (ui/confirm.js) in light and dark.
//
// A tour is {id, steps: [{target?, title, body, placement?, onEnter?}]}.
// target is a CSS selector; steps whose target is missing or hidden are
// skipped, and a step without a target is shown centred.

const STYLE_ID = "sf-tour-style";
const CSS = `
.sf-tour-vars {
  --sft-bg: #ffffff; --sft-fg: #181818; --sft-muted: #444b57; --sft-border: #d8dde6;
  --sft-btn-bg: #ffffff; --sft-btn-fg: #0b5cab; --sft-primary: #0176d3; --sft-focus: #1b96ff;
  --sft-dot: #c9d1dc; --sft-scrim: rgba(8, 15, 30, 0.55);
}
.sf-tour-root { position: fixed; inset: 0; z-index: 2147483600; font-family: inherit; }
html.dark .sf-tour-vars, html[data-theme="dark"] .sf-tour-vars {
  --sft-bg: #1b2130; --sft-fg: #e8ebf2; --sft-muted: #b4bccb; --sft-border: #343c50;
  --sft-btn-bg: #252d40; --sft-btn-fg: #9cc8ff; --sft-primary: #3b8eea; --sft-focus: #58a6ff;
  --sft-dot: #46506a; --sft-scrim: rgba(0, 0, 0, 0.6);
}
.sf-tour-blocker { position: absolute; inset: 0; }
.sf-tour-blocker.sf-tour-dim { background: var(--sft-scrim); }
.sf-tour-spot {
  position: absolute; border-radius: 8px; pointer-events: none;
  box-shadow: 0 0 0 9999px var(--sft-scrim), 0 0 0 2px var(--sft-primary);
  transition: top .2s ease, left .2s ease, width .2s ease, height .2s ease;
}
.sf-tour-card {
  position: absolute; box-sizing: border-box; width: min(340px, calc(100vw - 24px));
  background: var(--sft-bg); color: var(--sft-fg); border: 1px solid var(--sft-border);
  border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); padding: 16px 18px 14px;
}
.sf-tour-step { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--sft-muted); letter-spacing: .02em; }
.sf-tour-title { margin: 0 0 6px; font-size: 15px; font-weight: 700; line-height: 1.3; }
.sf-tour-body { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: var(--sft-muted); white-space: pre-line; }
.sf-tour-foot { display: flex; align-items: center; gap: 8px; }
.sf-tour-dots { display: flex; gap: 5px; margin-right: auto; }
.sf-tour-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sft-dot); }
.sf-tour-dot.on { background: var(--sft-primary); }
.sf-tour-btn {
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 5px 12px;
  border-radius: 4px; min-height: 28px; border: 1px solid var(--sft-border);
  background: var(--sft-btn-bg); color: var(--sft-btn-fg);
}
.sf-tour-btn-primary { background: var(--sft-primary); border-color: var(--sft-primary); color: #ffffff; }
.sf-tour-btn-link { border-color: transparent; background: transparent; color: var(--sft-muted); padding: 5px 6px; }
.sf-tour-btn:focus-visible { outline: 2px solid var(--sft-focus); outline-offset: 2px; }
.sf-tour-menu {
  position: fixed; z-index: 2147483600; min-width: 190px; padding: 4px; box-sizing: border-box;
  background: var(--sft-bg); color: var(--sft-fg); border: 1px solid var(--sft-border);
  border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22); font-family: inherit;
}
.sf-tour-menu button {
  display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; cursor: pointer;
  padding: 7px 10px; border: 0; border-radius: 4px; background: transparent; color: inherit;
}
.sf-tour-menu button:hover, .sf-tour-menu button:focus-visible { background: var(--sft-border); outline: none; }
@media (prefers-reduced-motion: reduce) { .sf-tour-spot { transition: none; } }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function visibleTarget(selector) {
  if (!selector) return null;
  const node = document.querySelector(selector);
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? node : null;
}

const PAD = 6;
const GAP = 12;

// Card position next to the target rect, flipping to the side with room and
// clamping inside the viewport.
export function placeCard(target, card, placement, viewport) {
  const vw = viewport.width;
  const vh = viewport.height;
  if (!target) return {left: Math.max(12, (vw - card.width) / 2), top: Math.max(12, (vh - card.height) / 2)};
  const room = {
    bottom: vh - (target.bottom + PAD),
    top: target.top - PAD,
    right: vw - (target.right + PAD),
    left: target.left - PAD
  };
  const fits = {
    bottom: room.bottom >= card.height + GAP,
    top: room.top >= card.height + GAP,
    right: room.right >= card.width + GAP,
    left: room.left >= card.width + GAP
  };
  const order = [placement, "bottom", "top", "right", "left"].filter(Boolean);
  const side = order.find(s => fits[s]) || (room.bottom >= room.top ? "bottom" : "top");
  let left;
  let top;
  if (side === "bottom" || side === "top") {
    left = target.left + target.width / 2 - card.width / 2;
    top = side === "bottom" ? target.bottom + PAD + GAP : target.top - PAD - GAP - card.height;
  } else {
    top = target.top + target.height / 2 - card.height / 2;
    left = side === "right" ? target.right + PAD + GAP : target.left - PAD - GAP - card.width;
  }
  left = Math.min(Math.max(12, left), vw - card.width - 12);
  top = Math.min(Math.max(12, top), vh - card.height - 12);
  return {left, top, side};
}

let active = null;

export function isTourRunning() {
  return !!active;
}

// Runs a tour. Resolves "done" (finished) or "skipped" (Skip / Esc).
export function startTour(tour, {labels} = {}) {
  if (active) active.finish("skipped");
  ensureStyle();
  const steps = tour.steps || [];
  const text = {back: "Back", next: "Next", done: "Done", skip: "Skip tour", gotIt: "Got it", ...(labels || {})};
  const previousFocus = document.activeElement;

  const root = el("div", "sf-tour-root sf-tour-vars");
  const blocker = el("div", "sf-tour-blocker");
  const spot = el("div", "sf-tour-spot");
  const card = el("div", "sf-tour-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  const titleId = "sf-tour-title-" + Date.now();
  const bodyId = titleId + "-body";
  card.setAttribute("aria-labelledby", titleId);
  card.setAttribute("aria-describedby", bodyId);
  const stepLabel = el("p", "sf-tour-step");
  const title = el("h2", "sf-tour-title");
  title.id = titleId;
  const body = el("p", "sf-tour-body");
  body.id = bodyId;
  const foot = el("div", "sf-tour-foot");
  const dots = el("div", "sf-tour-dots");
  const skipBtn = el("button", "sf-tour-btn sf-tour-btn-link", text.skip);
  const backBtn = el("button", "sf-tour-btn", text.back);
  const nextBtn = el("button", "sf-tour-btn sf-tour-btn-primary", text.next);
  [skipBtn, backBtn, nextBtn].forEach(b => { b.type = "button"; });
  foot.append(dots, skipBtn, backBtn, nextBtn);
  card.append(stepLabel, title, body, foot);
  root.append(blocker, spot, card);
  document.body.appendChild(root);

  let index = -1;
  let target = null;
  let raf = 0;

  // Indexes of steps that can show right now (target present, or centred).
  const showable = (i) => !steps[i].target || !!visibleTarget(steps[i].target);

  const position = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const vp = {width: window.innerWidth, height: window.innerHeight};
      const rect = target ? target.getBoundingClientRect() : null;
      if (rect) {
        spot.style.display = "";
        blocker.classList.remove("sf-tour-dim");
        Object.assign(spot.style, {
          left: rect.left - PAD + "px", top: rect.top - PAD + "px",
          width: rect.width + PAD * 2 + "px", height: rect.height + PAD * 2 + "px"
        });
      } else {
        spot.style.display = "none";
        blocker.classList.add("sf-tour-dim");
      }
      const cr = card.getBoundingClientRect();
      const pos = placeCard(rect, {width: cr.width, height: cr.height}, steps[index] && steps[index].placement, vp);
      card.style.left = pos.left + "px";
      card.style.top = pos.top + "px";
    });
  };

  const render = () => {
    const step = steps[index];
    const visible = steps.map((s, i) => i).filter(showable);
    const pos = visible.indexOf(index);
    target = visibleTarget(step.target);
    // Scroll only when needed: scrollIntoView can also scroll the Salesforce
    // page that hosts the panel iframe.
    if (target && target.scrollIntoView) {
      const r = target.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) {
        target.scrollIntoView({block: "nearest", inline: "nearest"});
      }
    }
    // A single tip reads as a tip, not a one-step tour.
    const single = visible.length === 1;
    stepLabel.textContent = single ? "" : `Step ${pos + 1} of ${visible.length}`;
    stepLabel.style.display = single ? "none" : "";
    skipBtn.style.display = single ? "none" : "";
    title.textContent = step.title;
    body.textContent = step.body;
    dots.replaceChildren(...(single ? [] : visible.map(i => el("span", "sf-tour-dot" + (i === index ? " on" : "")))));
    backBtn.style.visibility = pos > 0 ? "visible" : "hidden";
    nextBtn.textContent = single ? text.gotIt : (pos === visible.length - 1 ? text.done : text.next);
    position();
    nextBtn.focus();
  };

  const go = async (dir) => {
    let i = index + dir;
    while (i >= 0 && i < steps.length) {
      if (steps[i].onEnter) {
        try { await steps[i].onEnter(); } catch (e) { /* show the step anyway */ }
        await new Promise(r => setTimeout(r, 80));
      }
      if (showable(i)) break;
      i += dir;
    }
    if (i < 0) return;
    if (i >= steps.length) {
      finish("done");
      return;
    }
    index = i;
    render();
  };

  let resolveTour;
  const finished = new Promise(resolve => { resolveTour = resolve; });
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish("skipped");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "Tab") {
      const focusables = [skipBtn, backBtn, nextBtn].filter(b => b.style.visibility !== "hidden" && b.style.display !== "none");
      const at = focusables.indexOf(document.activeElement);
      e.preventDefault();
      const next = e.shiftKey ? (at <= 0 ? focusables.length - 1 : at - 1) : (at + 1) % focusables.length;
      focusables[next].focus();
    }
  };

  function finish(result) {
    if (!active || active.root !== root) return;
    active = null;
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    root.remove();
    if (previousFocus && previousFocus.focus) {
      try { previousFocus.focus(); } catch (e) { /* element gone */ }
    }
    resolveTour(result);
  }

  nextBtn.addEventListener("click", () => go(1));
  backBtn.addEventListener("click", () => go(-1));
  skipBtn.addEventListener("click", () => finish("skipped"));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);

  active = {root, finish};
  go(1);
  return finished;
}

// Small menu anchored under a button (used by the "?" help button).
// items: [{label, onSelect}]
export function showMenu(anchor, items) {
  ensureStyle();
  closeMenu();
  const menu = el("div", "sf-tour-menu sf-tour-vars");
  menu.setAttribute("role", "menu");
  const buttons = items.map(item => {
    const b = el("button", "", item.label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      closeMenu();
      item.onSelect();
    });
    return b;
  });
  menu.append(...buttons);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.getBoundingClientRect().width;
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  const onDoc = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) closeMenu();
  };
  const onKey = (e) => {
    const at = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") {
      closeMenu();
      anchor.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(at + 1) % buttons.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(at - 1 + buttons.length) % buttons.length].focus();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", onDoc, true));
  document.addEventListener("keydown", onKey, true);
  openMenu = {menu, cleanup() {
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    menu.remove();
  }};
  buttons[0].focus();
}

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.cleanup();
    openMenu = null;
  }
}
