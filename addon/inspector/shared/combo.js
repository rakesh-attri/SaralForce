// Searchable select: one box to type in and pick from (replaces a separate
// search input + <select>). Arrow keys move, Enter picks, Esc closes.
// allowFree: Enter / blur keeps typed text as the value (e.g. a tab API name
// that is not in the list).

const h = React.createElement;
const MAX_SHOWN = 200;

export function filterComboOptions(options, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return options;
  const words = q.split(/\s+/);
  return options.filter(o => {
    const hay = `${o.label} ${o.sub || ""} ${o.value}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

export function SearchSelect({value, options, onChange, placeholder, emptyText, disabled, allowFree, ariaLabel, className}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const wrapRef = React.useRef(null);
  const listRef = React.useRef(null);
  const selected = options.find(o => o.value === value);
  const shown = filterComboOptions(options, query).slice(0, MAX_SHOWN);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(true); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  });
  React.useEffect(() => {
    const el = listRef.current && listRef.current.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({block: "nearest"});
  }, [active, open]);

  const close = (commitFree) => {
    if (commitFree && allowFree && query.trim() && query.trim() !== value) onChange(query.trim());
    setOpen(false);
    setQuery("");
  };
  const pick = o => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    setQuery("");
  };
  const onKey = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // Highlighted option wins; with no match, allowFree keeps the typed text.
      if (open && shown[active]) pick(shown[active]);
      else close(true);
    } else if (e.key === "Escape") { e.preventDefault(); close(false); }
  };

  const display = open ? query : selected ? selected.label : (value || "");
  return h("div", {className: "ff-combo" + (open ? " open" : "") + (className ? " " + className : ""), ref: wrapRef},
    h("input", {
      className: "ff-combo-input",
      value: display,
      placeholder: open && (selected || value) ? (selected ? selected.label : value) : placeholder,
      disabled,
      role: "combobox",
      "aria-expanded": open,
      "aria-label": ariaLabel || placeholder,
      "aria-autocomplete": "list",
      spellCheck: false,
      onFocus: () => { setOpen(true); setActive(0); },
      onClick: () => setOpen(true),
      onChange: e => { setQuery(e.target.value); setOpen(true); setActive(0); },
      onKeyDown: onKey
    }),
    selected && selected.sub && !open && h("span", {className: "ff-combo-sub"}, selected.sub),
    h("span", {className: "ff-combo-caret", "aria-hidden": "true"}, "▾"),
    open && h("div", {className: "ff-combo-panel", role: "listbox", ref: listRef},
      shown.map((o, i) => h("div", {
        key: o.value,
        role: "option",
        "aria-selected": o.value === value,
        className: "ff-combo-opt" + (i === active ? " active" : "") + (o.value === value ? " selected" : "") + (o.disabled ? " disabled" : ""),
        onMouseEnter: () => setActive(i),
        onMouseDown: e => { e.preventDefault(); pick(o); }
      },
        h("span", {className: "ff-combo-opt-l"}, o.label),
        o.sub && h("span", {className: "ff-combo-opt-s"}, o.sub),
        o.tag && h("span", {className: "ff-combo-tag ff-combo-tag-" + (o.tagTone || "info")}, o.tag))),
      !shown.length && h("div", {className: "ff-combo-empty"},
        allowFree && query.trim() ? `Press Enter to use "${query.trim()}"` : (emptyText || "No matches")),
      shown.length === MAX_SHOWN && h("div", {className: "ff-combo-empty"}, "Keep typing to narrow the list…")));
}
