// Panel <-> host-page messaging. The panel (object-creator.html) is framed by
// the content script on a Salesforce page; every postMessage goes to that one
// verified parent origin, and only messages from it are accepted. Anything
// else (another site framing the panel, scripts posting to the panel) is
// ignored.

const SALESFORCE_HOST_SUFFIXES = [
  ".salesforce.com",
  ".salesforce-setup.com",
  ".force.com",
  ".cloudforce.com",
  ".visualforce.com",
  ".sfcrmapps.cn",
  ".sfcrmproducts.cn",
  ".salesforce.mil",
  ".force.mil",
  ".cloudforce.mil",
  ".visualforce.mil",
  ".crmforce.mil",
  ".force.com.mcas.ms",
  ".builder.salesforce-experience.com"
];

// True for https origins on a Salesforce domain the extension is built for.
export function isSalesforceOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch (e) { return false; }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return SALESFORCE_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// The dev harness (test/smoke.html) serves the panel from a loopback http
// page. Loopback parents are accepted only there — never when the panel runs
// as an extension page.
export function isLoopbackOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch (e) { return false; }
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

function runningAsExtensionPage() {
  const protocol = globalThis.location && globalThis.location.protocol;
  return protocol === "chrome-extension:" || protocol === "extension:";
}

export function isTrustedFrameOrigin(origin) {
  return isSalesforceOrigin(origin) || (!runningAsExtensionPage() && isLoopbackOrigin(origin));
}

let trustedParentOrigin = null;

// Set once at bootstrap, after the parent page has been verified to belong to
// the same org as the panel's ?host=.
export function setTrustedParentOrigin(origin) {
  trustedParentOrigin = origin && isTrustedFrameOrigin(origin) ? origin : null;
}

export function getTrustedParentOrigin() {
  return trustedParentOrigin;
}

// Origin of the page framing this document, or null when not embedded.
export function getParentOrigin(win = window) {
  if (win.parent === win) return null;
  const ancestors = win.location.ancestorOrigins;
  return ancestors && ancestors.length ? ancestors[0] : null;
}

export function postToParent(message) {
  if (!trustedParentOrigin || window.parent === window) return false;
  try {
    window.parent.postMessage(message, trustedParentOrigin);
    return true;
  } catch (e) {
    return false;
  }
}

// Record context reported by the host page: object API name and/or 15/18
// char Id. Anything else is dropped so it can never reach a query string.
export function sanitizeRecordContext(rec) {
  if (!rec || typeof rec !== "object") return null;
  const obj = typeof rec.obj === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(rec.obj) ? rec.obj : null;
  const id = typeof rec.id === "string" && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(rec.id) ? rec.id : null;
  if (!obj && !id) return null;
  return {...rec, obj, id};
}

// Ask the host page (content script) which record/list is open: it replies
// {obj, id} (id null on list pages). Resolves null when standalone — e.g.
// the inspector tab itself has no content-script parent — or on timeout.
export function queryHostRecord(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      resolve(value);
    };
    const onMsg = (e) => {
      if (isFromTrustedParent(e) && e.data.type === "sfoc-open-record") {
        finish(sanitizeRecordContext(e.data.rec));
      }
    };
    window.addEventListener("message", onMsg);
    if (!postToParent({type: "sfoc-query-open-record"})) {
      finish(null);
      return;
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

export function isFromTrustedParent(event) {
  return !!trustedParentOrigin &&
    event.source === window.parent &&
    event.origin === trustedParentOrigin &&
    !!event.data && typeof event.data.type === "string";
}
