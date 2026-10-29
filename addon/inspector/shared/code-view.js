// Open code in a full browser tab (code-viewer.html). The files go through
// chrome.storage.local, which all extension pages share, keyed by a random
// id in the URL hash; entries older than a day are pruned on each open.
const PREFIX = "sfoc_codeview_";
const DAY = 86400e3;

function storageArea() {
  try { return globalThis.chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
  catch (e) { return null; }
}

function prune(area) {
  try {
    area.get(null, items => {
      try {
        const old = Object.keys(items || {}).filter(k => k.startsWith(PREFIX) &&
          !(items[k] && items[k].at > Date.now() - DAY));
        if (old.length) area.remove(old);
      } catch (e) { /* best effort */ }
    });
  } catch (e) { /* best effort */ }
}

// files: [{path, content, lang}] — lang "apex" | "js" highlight; others plain.
export function openCodeViewer({title, subtitle, files}) {
  const list = (files || []).filter(f => f && typeof f.content === "string");
  if (!list.length) return;
  const key = PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const payload = {title, subtitle, files: list, at: Date.now()};
  const open = () => window.open("code-viewer.html#" + encodeURIComponent(key), "_blank", "noopener");
  const area = storageArea();
  if (area) {
    prune(area);
    area.set({[key]: payload}, open);
  } else {
    try { localStorage.setItem("chrome.storage:" + key, JSON.stringify(payload)); } catch (e) { /* quota */ }
    open();
  }
}
