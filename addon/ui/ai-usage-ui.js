// AI usage on screen: a "ghost" note after each AI request (fades after a few
// seconds; hover keeps it) and a drawer with every call of this session —
// tokens, time, and the full input and output. Mounted once per page.
import {
  USAGE_EVENT, aiUsageLog, clearAiUsageLog, sessionTotals, savedTotals, showUsageToast, formatUsage
} from "../core/ai-usage.js";
import {safeCopyText} from "../utils.js";

const h = React.createElement;
const OPEN_EVENT = "ff-ai-usage-open";
const SHOW_MS = 6000;
const FADE_MS = 400;
const MAX_TOASTS = 3;

const fmt = v => Number(v || 0).toLocaleString("en-US");

// Open the drawer from anywhere (help menu, a toast), optionally on one call.
export function openAiUsage(entryId) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, {detail: entryId || null}));
}

function Toast({entry, onDone, onOpen}) {
  const [leaving, setLeaving] = React.useState(false);
  const timer = React.useRef(null);
  const start = (ms) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(onDone, FADE_MS);
    }, ms);
  };
  React.useEffect(() => { start(SHOW_MS); return () => clearTimeout(timer.current); }, []);
  return h("button", {
    type: "button",
    className: "aiu-toast" + (leaving ? " leaving" : "") + (entry.status !== "ok" ? " bad" : ""),
    title: formatUsage(entry) + " — click to see the input and output",
    "aria-label": formatUsage(entry),
    onMouseEnter: () => { clearTimeout(timer.current); setLeaving(false); },
    onMouseLeave: () => start(2500),
    onFocus: () => { clearTimeout(timer.current); setLeaving(false); },
    onBlur: () => start(2500),
    onClick: () => { onOpen(entry.id); onDone(); }
  },
    h("span", {className: "aiu-toast-ico", "aria-hidden": "true"}, "✨"),
    h("span", {className: "aiu-toast-f"}, entry.feature),
    h("span", {className: "aiu-toast-n"}, `${entry.estimated ? "≈ " : ""}${fmt(entry.total)} tokens`),
    h("span", {className: "aiu-toast-d"}, `${fmt(entry.input)} in · ${fmt(entry.output)} out · ${entry.ms >= 1000 ? (entry.ms / 1000).toFixed(1) + " s" : entry.ms + " ms"}`),
    entry.status !== "ok" && h("span", {className: "aiu-toast-x"}, entry.status === "cancelled" ? "cancelled" : "failed"));
}

function CopyBtn({text}) {
  const [done, setDone] = React.useState(false);
  return h("button", {
    type: "button", className: "aiu-copy",
    onClick: async () => { await safeCopyText(text); setDone(true); setTimeout(() => setDone(false), 1200); }
  }, done ? "Copied" : "Copy");
}

function Row({entry, open, onToggle}) {
  const input = entry.messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n");
  return h("li", {className: "aiu-row" + (open ? " open" : "")},
    h("button", {type: "button", className: "aiu-row-h", "aria-expanded": open, onClick: onToggle},
      h("span", {className: "aiu-row-f"}, entry.feature),
      h("span", {className: "aiu-row-m"}, entry.model || entry.provider),
      h("span", {className: "aiu-row-t"}, `${entry.estimated ? "≈ " : ""}${fmt(entry.input)} in · ${fmt(entry.output)} out · ${fmt(entry.total)}`),
      h("span", {className: "aiu-row-time"}, new Date(entry.at).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"})),
      h("span", {className: "aiu-status " + entry.status}, entry.status === "ok" ? "ok" : entry.status)),
    open && h("div", {className: "aiu-row-b"},
      h("div", {className: "aiu-meta"},
        `${entry.provider}${entry.model ? " · " + entry.model : ""} · ${entry.ms >= 1000 ? (entry.ms / 1000).toFixed(1) + " s" : entry.ms + " ms"}` +
        (entry.reasoning ? ` · ${fmt(entry.reasoning)} reasoning tokens (in the output count)` : "") +
        (entry.estimated ? " · tokens estimated (the provider did not report usage)" : "")),
      entry.error && h("div", {className: "aiu-err"}, entry.error),
      h("div", {className: "aiu-block-h"}, h("span", null, `Input · ${entry.messages.length} message${entry.messages.length === 1 ? "" : "s"}`), h(CopyBtn, {text: input})),
      h("div", {className: "aiu-msgs"},
        entry.messages.map((m, i) => h("div", {key: i, className: "aiu-msg"},
          h("div", {className: "aiu-role"}, m.role),
          h("pre", {className: "aiu-pre"}, m.content)))),
      h("div", {className: "aiu-block-h"}, h("span", null, "Output"), h(CopyBtn, {text: entry.reply})),
      h("pre", {className: "aiu-pre"}, entry.reply || "(no output)")));
}

function Drawer({focusId, onClose}) {
  const [, setTick] = React.useState(0);
  const [openId, setOpenId] = React.useState(focusId);
  React.useEffect(() => setOpenId(focusId), [focusId]);
  React.useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener(USAGE_EVENT, on);
    const esc = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener(USAGE_EVENT, on); window.removeEventListener("keydown", esc); };
  }, []);
  const list = aiUsageLog();
  const s = sessionTotals(list);
  const saved = savedTotals();
  return h("div", {className: "aiu-backdrop", onMouseDown: e => { if (e.target === e.currentTarget) onClose(); }},
    h("aside", {className: "aiu-drawer", role: "dialog", "aria-label": "AI usage"},
      h("div", {className: "aiu-h"},
        h("div", null,
          h("div", {className: "aiu-title"}, "✨ AI usage"),
          h("div", {className: "aiu-sub"}, "Tokens, time, and exactly what was sent and received.")),
        h("button", {type: "button", className: "aiu-close", "aria-label": "Close", onClick: onClose}, "✕")),
      h("div", {className: "aiu-stats"},
        h("div", {className: "aiu-stat"}, h("b", null, fmt(s.total)), h("span", null, `this session · ${s.calls} call${s.calls === 1 ? "" : "s"}`)),
        h("div", {className: "aiu-stat"}, h("b", null, fmt(saved.today.total)), h("span", null, `today · ${saved.today.calls} calls`)),
        h("div", {className: "aiu-stat"}, h("b", null, fmt(saved.all.total)), h("span", null, `all time · ${saved.all.calls} calls`))),
      h("div", {className: "aiu-bar"},
        h("span", {className: "aiu-note"}, "Input and output text is kept only until this panel is closed or reloaded."),
        list.length > 0 && h("button", {type: "button", className: "field-action-btn", onClick: () => { clearAiUsageLog(); setOpenId(null); }}, "Clear")),
      list.length === 0
        ? h("div", {className: "aiu-empty"}, "No AI requests yet in this session. Use any ✨ feature and it appears here.")
        : h("ul", {className: "aiu-list"}, list.map(e => h(Row, {
          key: e.id, entry: e, open: openId === e.id,
          onToggle: () => setOpenId(id => (id === e.id ? null : e.id))
        })))));
}

export function AiUsageLayer() {
  const [toasts, setToasts] = React.useState([]);
  const [drawer, setDrawer] = React.useState(null);   // {focusId} | null
  React.useEffect(() => {
    const onCall = (ev) => {
      const entry = ev.detail;
      if (!entry || !showUsageToast()) return;
      setToasts(t => [...t, entry].slice(-MAX_TOASTS));
    };
    const onOpen = (ev) => setDrawer({focusId: ev.detail || null});
    window.addEventListener(USAGE_EVENT, onCall);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener(USAGE_EVENT, onCall); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, []);
  return h(React.Fragment, null,
    toasts.length > 0 && h("div", {className: "aiu-toasts", role: "status", "aria-live": "polite"},
      toasts.map(e => h(Toast, {
        key: e.id, entry: e,
        onDone: () => setToasts(t => t.filter(x => x.id !== e.id)),
        onOpen: id => setDrawer({focusId: id})
      }))),
    drawer && h(Drawer, {focusId: drawer.focusId, onClose: () => setDrawer(null)}));
}

// Mount the layer once on this page (its own root, above everything).
export function mountAiUsage() {
  if (typeof document === "undefined" || document.getElementById("sfoc-ai-usage")) return;
  const el = document.createElement("div");
  el.id = "sfoc-ai-usage";
  document.body.appendChild(el);
  ReactDOM.render(h(AiUsageLayer), el);
}
