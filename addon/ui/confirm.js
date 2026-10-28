// Promise-based confirmation modal. Renders into its own container so it can
// be called from any handler: `if (!await confirmDialog({...})) return;`.
// Uses the global React / ReactDOM UMD builds; nothing runs at import time.

const STYLE_ID = "sf-confirm-style";

const CSS = `
.sf-confirm-overlay {
  --sfc-bg: var(--sf-surface, #ffffff);
  --sfc-fg: var(--sf-text, #181818);
  --sfc-muted: var(--sf-text-muted, #444b57);
  --sfc-border: var(--sf-border, #d8dde6);
  --sfc-btn-bg: #ffffff;
  --sfc-btn-fg: #0b5cab;
  --sfc-primary: #0176d3;
  --sfc-danger: #ba0517;
  --sfc-focus: #1b96ff;
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8, 12, 20, 0.55); padding: 16px;
  font-family: inherit;
}
html.dark .sf-confirm-overlay, html[data-theme="dark"] .sf-confirm-overlay {
  --sfc-bg: #1b2130;
  --sfc-fg: #e8ebf2;
  --sfc-muted: #b4bccb;
  --sfc-border: #343c50;
  --sfc-btn-bg: #252d40;
  --sfc-btn-fg: #9cc8ff;
  --sfc-primary: #3b8eea;
  --sfc-danger: #e5484d;
  --sfc-focus: #58a6ff;
}
.sf-confirm-dialog {
  background: var(--sfc-bg); color: var(--sfc-fg);
  border: 1px solid var(--sfc-border); border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  width: 100%; max-width: 440px; padding: 20px 22px 16px;
}
.sf-confirm-dialog:focus { outline: none; }
.sf-confirm-title { margin: 0 0 8px; font-size: 16px; font-weight: 700; line-height: 1.3; }
.sf-confirm-message { margin: 0 0 18px; font-size: 13px; line-height: 1.5; color: var(--sfc-muted); white-space: pre-wrap; }
.sf-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.sf-confirm-btn {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  padding: 6px 14px; border-radius: 4px; min-height: 32px;
  border: 1px solid var(--sfc-border); background: var(--sfc-btn-bg); color: var(--sfc-btn-fg);
}
.sf-confirm-btn-primary { background: var(--sfc-primary); border-color: var(--sfc-primary); color: #ffffff; }
.sf-confirm-btn-danger { background: var(--sfc-danger); border-color: var(--sfc-danger); color: #ffffff; }
.sf-confirm-btn:focus-visible { outline: 2px solid var(--sfc-focus); outline-offset: 2px; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

let seq = 0;

function ConfirmModal(props) {
  const h = React.createElement;
  const {title, message, confirmLabel, cancelLabel, danger, onClose, idBase} = props;
  const dialogRef = React.useRef(null);
  const cancelRef = React.useRef(null);
  const confirmRef = React.useRef(null);

  React.useEffect(() => {
    // Danger dialogs default to the safe choice.
    const target = danger ? cancelRef.current : confirmRef.current;
    if (target) target.focus();
  }, []);

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(false);
      return;
    }
    if (e.key === "Tab") {
      const items = [cancelRef.current, confirmRef.current].filter(Boolean);
      const idx = items.indexOf(document.activeElement);
      e.preventDefault();
      const next = e.shiftKey
        ? (idx <= 0 ? items.length - 1 : idx - 1)
        : (idx === -1 || idx === items.length - 1 ? 0 : idx + 1);
      items[next].focus();
      return;
    }
    // Keep keystrokes (Enter, shortcuts) from reaching page-level handlers;
    // the focused button handles Enter/Space natively.
    e.stopPropagation();
  };

  return h("div", {
    className: "sf-confirm-overlay",
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(false); }
  },
  h("div", {
    ref: dialogRef,
    className: "sf-confirm-dialog",
    // Focusable so clicks on the dialog body keep keyboard focus inside it.
    tabIndex: -1,
    role: "alertdialog",
    "aria-modal": "true",
    "aria-labelledby": idBase + "-title",
    "aria-describedby": idBase + "-desc",
    onKeyDown
  },
  h("h2", {id: idBase + "-title", className: "sf-confirm-title"}, title),
  h("p", {id: idBase + "-desc", className: "sf-confirm-message"}, message),
  h("div", {className: "sf-confirm-actions"},
    h("button", {
      ref: cancelRef, type: "button", className: "sf-confirm-btn",
      onClick: () => onClose(false)
    }, cancelLabel),
    h("button", {
      ref: confirmRef, type: "button",
      className: "sf-confirm-btn " + (danger ? "sf-confirm-btn-danger" : "sf-confirm-btn-primary"),
      onClick: () => onClose(true)
    }, confirmLabel))));
}

// Resolves true when the user confirms, false on cancel / Esc / backdrop.
export function confirmDialog(opts) {
  const o = opts || {};
  ensureStyle();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const previousFocus = document.activeElement;
  const root = ReactDOM.createRoot ? ReactDOM.createRoot(container) : null;
  const idBase = "sf-confirm-" + (++seq);

  return new Promise((resolve) => {
    let done = false;
    const onClose = (result) => {
      if (done) return;
      done = true;
      if (root) root.unmount();
      else ReactDOM.unmountComponentAtNode(container);
      container.remove();
      if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
        previousFocus.focus();
      }
      resolve(result);
    };
    const el = React.createElement(ConfirmModal, {
      title: o.title || "Are you sure?",
      message: o.message || "",
      confirmLabel: o.confirmLabel || "Confirm",
      cancelLabel: o.cancelLabel || "Cancel",
      danger: !!o.danger,
      onClose,
      idBase
    });
    if (root) root.render(el);
    else ReactDOM.render(el, container);
  });
}
