import {soqlCompletionContext, soqlCompletions, applyCompletion} from "../../core/soql-complete.js";

const h = React.createElement;

// Pixel position just below the caret of a monospace, non-wrapping textarea.
function caretPoint(ta, caret) {
  const cs = getComputedStyle(ta);
  const fontSize = parseFloat(cs.fontSize) || 13;
  const lh = parseFloat(cs.lineHeight) || fontSize * 1.55;
  let cw = fontSize * 0.6;
  try {
    const ctx = (caretPoint.canvas || (caretPoint.canvas = document.createElement("canvas"))).getContext("2d");
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    cw = ctx.measureText("MMMMMMMMMM").width / 10 || cw;
  } catch (e) { /* keep the estimate */ }
  const before = ta.value.slice(0, caret).split("\n");
  const row = before.length - 1;
  const col = before[row].replace(/\t/g, "  ").length;
  const r = ta.getBoundingClientRect();
  const left = r.left + (parseFloat(cs.paddingLeft) || 0) + col * cw - ta.scrollLeft;
  const lineTop = r.top + (parseFloat(cs.paddingTop) || 0) + row * lh - ta.scrollTop;
  return {left, top: lineTop + lh + 2, lineTop};
}

// Inline suggestions for the SOQL editor. The textarea stays the source of
// truth; the popup only reads its value/caret and writes back through setQuery.
//   describe(objectName) → describe result, listObjects() → [{name, label}]
function useSoqlAutocomplete({taRef, setQuery, describe, listObjects}) {
  const [state, setState] = React.useState(null); // {items, active, ctx, pos}
  const seq = React.useRef(0);
  const close = React.useCallback(() => { seq.current++; setState(null); }, []);

  const refresh = React.useCallback((value, caret) => {
    const ctx = soqlCompletionContext(value, caret);
    // Offer only while a word is being typed, after a dot, or right after FROM.
    const typing = ctx && (ctx.prefix || ctx.path.length || ctx.kind === "object" || ctx.kind === "child");
    if (!typing) { close(); return; }
    const mine = ++seq.current;
    soqlCompletions(ctx, {describe, listObjects}).then(items => {
      if (mine !== seq.current) return;
      const ta = taRef.current;
      // Hide when the only match is exactly what is already typed.
      const useful = items.filter(i => i.value.toLowerCase() !== ctx.prefix.toLowerCase() || i.kind === "relationship");
      if (!ta || !useful.length || ta.value !== value) { setState(null); return; }
      setState({items: items.slice(0, 50), active: 0, ctx, pos: caretPoint(ta, caret)});
    }).catch(() => { if (mine === seq.current) setState(null); });
  }, [describe, listObjects, taRef, close]);

  const accept = React.useCallback((item) => {
    const ta = taRef.current;
    if (!ta || !state) return;
    const {text, caret} = applyCompletion(ta.value, state.ctx, item);
    setQuery(text);
    close();
    requestAnimationFrame(() => {
      try {
        if (ta.value !== text) return;
        ta.focus();
        ta.setSelectionRange(caret, caret);
        // "Owner." opens the next level straight away.
        if (item.kind === "relationship") refresh(text, caret);
      } catch (e) { /* ignore */ }
    });
  }, [state, taRef, setQuery, close, refresh]);

  // Returns true when the key was used by the popup.
  const onKeyDown = (e) => {
    if (!state) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) { close(); return false; }
    const n = state.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setState(s => s && {...s, active: (s.active + d + n) % n});
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(state.items[state.active]);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); close(); return true; }
    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) close();
    return false;
  };

  React.useEffect(() => {
    if (!state) return undefined;
    const el = document.querySelector(".soql-ac-item.active");
    if (el && el.scrollIntoView) el.scrollIntoView({block: "nearest"});
    return undefined;
  }, [state && state.active]);

  React.useEffect(() => {
    if (!state) return undefined;
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [!!state, close]);

  let popup = null;
  if (state) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const width = 320;
    const maxH = 240;
    const left = Math.max(4, Math.min(state.pos.left, vw - width - 4));
    const below = state.pos.top + maxH <= vh || state.pos.lineTop < maxH;
    const style = below
      ? {left, top: state.pos.top, width, maxHeight: maxH}
      : {left, bottom: vh - state.pos.lineTop + 2, width, maxHeight: maxH};
    popup = h("div", {className: "soql-ac", role: "listbox", "aria-label": "SOQL suggestions", style},
      state.items.map((it, i) => h("div", {
        key: it.kind + ":" + it.value,
        role: "option",
        "aria-selected": i === state.active,
        className: "soql-ac-item" + (i === state.active ? " active" : ""),
        title: it.label || it.value,
        onMouseDown: (e) => { e.preventDefault(); accept(it); },
        onMouseEnter: () => setState(s => s && {...s, active: i})
      },
        h("span", {className: "soql-ac-kind k-" + it.kind, "aria-hidden": "true"},
          {object: "O", child: "C", relationship: "→", keyword: "K"}[it.kind] || "F"),
        h("span", {className: "soql-ac-val"}, it.value),
        it.detail && h("span", {className: "soql-ac-detail"}, it.detail))));
  }

  return {refresh, close, onKeyDown, popup, open: !!state};
}

export {useSoqlAutocomplete};
