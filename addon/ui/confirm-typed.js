// "Type the name to confirm" dialog for actions that can't be undone
// (refresh, discard or delete a sandbox). Same look as confirmDialog.
import {ensureStyle} from "./confirm.js";

const h = React.createElement;

function TypedModal({title, message, word, confirmLabel, danger, onClose}) {
  const [text, setText] = React.useState("");
  const ok = text.trim().toLowerCase() === String(word).trim().toLowerCase();
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  return h("div", {className: "sf-confirm-overlay", onMouseDown: e => { if (e.target === e.currentTarget) onClose(false); }},
    h("div", {className: "sf-confirm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "sf-typed-title",
      onKeyDown: e => { if (e.key === "Escape") { e.stopPropagation(); onClose(false); } }},
      h("h2", {id: "sf-typed-title", className: "sf-confirm-title"}, title),
      h("p", {className: "sf-confirm-message", style: {whiteSpace: "pre-line"}}, message),
      h("label", {className: "sf-typed-label", style: {display: "block", fontSize: "13px", margin: "6px 0 4px"}},
        "Type ", h("b", null, word), " to confirm"),
      h("input", {ref: inputRef, value: text, "aria-label": `Type ${word} to confirm`, autoComplete: "off", spellCheck: false,
        style: {width: "100%", boxSizing: "border-box", padding: "7px 9px", font: "inherit", borderRadius: "6px", border: "1px solid #c9ced8"},
        onChange: e => setText(e.target.value), onKeyDown: e => { if (e.key === "Enter" && ok) onClose(true); }}),
      h("div", {className: "sf-confirm-actions"},
        h("button", {type: "button", className: "sf-confirm-btn", onClick: () => onClose(false)}, "Cancel"),
        h("button", {type: "button", disabled: !ok, className: "sf-confirm-btn " + (danger ? "sf-confirm-btn-danger" : "sf-confirm-btn-primary"),
          onClick: () => onClose(true)}, confirmLabel))));
}

// → Promise<boolean>: true only when the word was typed and confirmed.
export function typedConfirm({title, message = "", word, confirmLabel = "Confirm", danger = true} = {}) {
  ensureStyle();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const previous = document.activeElement;
  const root = ReactDOM.createRoot ? ReactDOM.createRoot(container) : null;
  return new Promise(resolve => {
    let done = false;
    const onClose = result => {
      if (done) return;
      done = true;
      if (root) root.unmount(); else ReactDOM.unmountComponentAtNode(container);
      container.remove();
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
      resolve(result);
    };
    const el = h(TypedModal, {title, message, word, confirmLabel, danger, onClose});
    if (root) root.render(el); else ReactDOM.render(el, container);
  });
}
