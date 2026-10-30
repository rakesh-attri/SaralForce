// API Explorer: send REST, Composite or SOAP requests to the current org with
// the panel's session, and read the formatted response. History per org.
import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {confirmDialog} from "../../ui/confirm.js";
import {
  METHODS, WRITE_METHODS, REST_PRESETS, SOAP_APIS, SESSION_PLACEHOLDER,
  withVersion, normalizePath, soapTemplate, prettyBody, apiLinks, addHistory, byteSize
} from "../../core/api-explorer.js";
import {downloadText} from "../shared/csv.js";
import {FFBadge} from "../shared/ui.js";
import {ffLoadJson, ffSaveJson, useFfSession} from "../shared/session-state.js";

const h = React.createElement;
const HISTORY_KEY = "ff_api_history";

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// JSON with API paths turned into links (handled by a delegated click).
function jsonHtml(text) {
  return escHtml(text)
    .replace(/(&quot;|")(\/services\/(?:data|apexrest)\/[^"&\s]+)(&quot;|")/g,
      (m, a, path, b) => `${a}<a href="#" class="api-link" data-path="${path}">${path}</a>${b}`)
    .replace(/^(\s*)("[^"]+")(:)/gm, "$1<span class=\"tok-col\">$2</span>$3")
    .replace(/: ("(?:[^"\\]|\\.)*")/g, ": <span class=\"tok-s\">$1</span>")
    .replace(/: (-?\d+(?:\.\d+)?|true|false|null)(,?)$/gm, ": <span class=\"tok-n\">$1</span>$2");
}

async function sendRequest({method, path, body, soap}) {
  const url = `https://${sfConn.instanceHostname}${path}`;
  const headers = soap
    ? {"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "\"\""}
    : {"Authorization": "Bearer " + sfConn.sessionId, "Accept": "application/json",
       ...(body != null ? {"Content-Type": "application/json; charset=UTF-8"} : {})};
  const t0 = performance.now();
  const res = await fetch(url, {method, headers, body: body == null ? undefined : body});
  const text = await res.text();
  return {
    status: res.status, statusText: res.statusText, ms: Math.round(performance.now() - t0),
    contentType: res.headers.get("content-type") || "", headers: [...res.headers.entries()], text,
  };
}

function ApiTab() {
  const [mode, setMode] = useFfSession("api", "mode", "rest");
  const [method, setMethod] = useFfSession("api", "method", "GET");
  const [path, setPath] = useFfSession("api", "path", `/services/data/v${apiVersion}/`);
  const [body, setBody] = useFfSession("api", "body", "");
  const [soapApi, setSoapApi] = useFfSession("api", "soapApi", "partner");
  const [envelope, setEnvelope] = useFfSession("api", "envelope", "");
  const [resp, setResp] = useFfSession("api", "resp", null);
  const [view, setView] = React.useState("body");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [history, setHistory] = React.useState(() => ffLoadJson(HISTORY_KEY, []));
  const api = SOAP_APIS.find(a => a.id === soapApi) || SOAP_APIS[0];
  const soapPath = withVersion(api.path, apiVersion);

  React.useEffect(() => {
    if (mode === "soap" && !envelope) setEnvelope(soapTemplate(api, apiVersion));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const applyPreset = p => {
    setMode("rest");
    setMethod(p.method);
    setPath(withVersion(p.path, apiVersion));
    setBody(p.body ? JSON.stringify(withVersion(p.body, apiVersion), null, 2) : "");
    setError(null);
  };

  const send = async (override) => {
    const req = override || (mode === "soap"
      ? {mode: "soap", method: "POST", path: soapPath, body: envelope}
      : {mode: "rest", method, path: normalizePath(path, apiVersion), body: WRITE_METHODS.has(method) && method !== "DELETE" ? body : null});
    setError(null);
    if (req.mode === "rest" && req.body != null && String(req.body).trim()) {
      try { JSON.parse(req.body); } catch (e) { setError("The body is not valid JSON: " + e.message); return; }
    }
    if (req.method === "DELETE") {
      const ok = await confirmDialog({title: "Send a DELETE request?", message: `${req.path}\n\nThis can delete data in the org.`,
        confirmLabel: "Send DELETE", danger: true});
      if (!ok) return;
    }
    if (req.mode === "rest") setPath(req.path);
    setBusy(true);
    try {
      const sentBody = req.mode === "soap" ? String(req.body || "").split(SESSION_PLACEHOLDER).join(sfConn.sessionId) : (req.body && String(req.body).trim() ? req.body : null);
      const r = await sendRequest({method: req.method, path: req.path, body: sentBody, soap: req.mode === "soap"});
      setResp({...r, request: {mode: req.mode, method: req.method, path: req.path}});
      setView("body");
      const next = addHistory(history, {mode: req.mode, method: req.method, path: req.path, body: req.mode === "rest" ? req.body : null,
        soapApi: req.mode === "soap" ? soapApi : null, status: r.status, ms: r.ms, at: Date.now()});
      setHistory(next);
      ffSaveJson(HISTORY_KEY, next);
    } catch (e) {
      setError("Request failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const openLink = p => {
    setMode("rest");
    setMethod("GET");
    setPath(p);
    send({mode: "rest", method: "GET", path: p, body: null});
  };

  const pretty = resp ? prettyBody(resp.text, resp.contentType) : null;
  const links = pretty && pretty.kind === "json" ? apiLinks(pretty.text) : [];
  const statusKind = resp ? (resp.status < 300 ? "ok" : resp.status < 400 ? "info" : "err") : "info";
  const groups = [...new Set(REST_PRESETS.map(p => p.group))];

  return h("div", {className: "insp-panel"},
    h("div", {className: "usr-layout api-layout"},
      h("div", {className: "usr-side"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"}, h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, "⚡"), h("span", {className: "sq3-card-t"}, "Quick requests")),
          groups.map(g => h("div", {key: g, className: "api-group"},
            h("div", {className: "md-group-h"}, g),
            REST_PRESETS.filter(p => p.group === g).map(p => h("button", {
              key: p.label, className: "api-preset", title: withVersion(p.path, apiVersion), onClick: () => applyPreset(p)
            }, h("span", {className: "api-m m-" + p.method.toLowerCase()}, p.method), h("span", null, p.label))))),
          h("div", {className: "md-group-h"}, "SOAP"),
          SOAP_APIS.map(a => h("button", {
            key: a.id, className: "api-preset", onClick: () => { setMode("soap"); setSoapApi(a.id); setEnvelope(soapTemplate(a, apiVersion)); }
          }, h("span", {className: "api-m m-soap"}, "SOAP"), h("span", null, a.label)))),
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, "🕘"), h("span", {className: "sq3-card-t"}, "History"),
            history.length > 0 && h("button", {className: "sq3-viewall", onClick: () => { setHistory([]); ffSaveJson(HISTORY_KEY, []); }}, "Clear")),
          !history.length && h("div", {className: "insp-meta"}, "Requests you send appear here."),
          history.map((e, i) => h("button", {
            key: i, className: "api-hist", title: e.path,
            onClick: () => {
              if (e.mode === "soap") { setMode("soap"); if (e.soapApi) setSoapApi(e.soapApi); return; }
              setMode("rest"); setMethod(e.method); setPath(e.path); setBody(e.body || "");
            }
          },
            h("span", {className: "api-m m-" + (e.mode === "soap" ? "soap" : e.method.toLowerCase())}, e.mode === "soap" ? "SOAP" : e.method),
            h("span", {className: "api-hist-p"}, e.path.replace(/^\/services\/data\/v[\d.]+/, "…")),
            h("span", {className: "api-hist-s " + (e.status < 300 ? "ok" : "bad")}, e.status))))),
      h("div", {className: "usr-main"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-pills md-views", role: "tablist"},
            [["rest", "REST & Composite"], ["soap", "SOAP"]].map(([id, label]) => h("button", {
              key: id, role: "tab", "aria-selected": mode === id, className: "sq3-pill" + (mode === id ? " active" : ""), onClick: () => setMode(id)
            }, label))),
          mode === "rest"
            ? h("div", null,
                h("div", {className: "api-line"},
                  h("select", {className: "mdn-input api-method", value: method, "aria-label": "Method", onChange: e => setMethod(e.target.value)},
                    METHODS.map(m => h("option", {key: m, value: m}, m))),
                  h("input", {className: "mdn-input api-path", value: path, spellCheck: false, "aria-label": "Path",
                    placeholder: "/services/data/v67.0/sobjects/Account  or  sobjects/Account",
                    onChange: e => setPath(e.target.value), onKeyDown: e => { if (e.key === "Enter") send(); }}),
                  h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: () => send()}, busy ? "Sending…" : "Send ▸")),
                WRITE_METHODS.has(method) && method !== "DELETE" && h("div", {className: "api-body"},
                  h("div", {className: "api-body-h"},
                    h("span", {className: "mdn-label"}, "Request body (JSON)"),
                    h("button", {className: "field-action-btn", onClick: () => {
                      try { setBody(JSON.stringify(JSON.parse(body || "{}"), null, 2)); setError(null); }
                      catch (e) { setError("The body is not valid JSON: " + e.message); }
                    }}, "Format")),
                  h("textarea", {className: "mdn-input mdn-code api-textarea", rows: 10, value: body, spellCheck: false,
                    "aria-label": "Request body", onChange: e => setBody(e.target.value)})),
                WRITE_METHODS.has(method) && h("div", {className: "insp-hint-strip api-warn"},
                  method === "DELETE" ? "DELETE removes data — you'll be asked to confirm." : `${method} changes data in this org.`))
            : h("div", null,
                h("div", {className: "api-line"},
                  h("select", {className: "mdn-input api-method", value: soapApi, "aria-label": "SOAP API",
                    onChange: e => { const a = SOAP_APIS.find(x => x.id === e.target.value); setSoapApi(a.id); setEnvelope(soapTemplate(a, apiVersion)); }},
                    SOAP_APIS.map(a => h("option", {key: a.id, value: a.id}, a.label))),
                  h("input", {className: "mdn-input api-path", value: soapPath, readOnly: true, "aria-label": "Endpoint"}),
                  h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: () => send()}, busy ? "Sending…" : "Send ▸")),
                h("div", {className: "api-body"},
                  h("div", {className: "api-body-h"},
                    h("span", {className: "mdn-label"}, "Envelope"),
                    h("span", {className: "insp-meta"}, `${SESSION_PLACEHOLDER} is replaced with your session when sent`)),
                  h("textarea", {className: "mdn-input mdn-code api-textarea", rows: 14, value: envelope, spellCheck: false,
                    "aria-label": "SOAP envelope", onChange: e => setEnvelope(e.target.value)}))),
          error && h("div", {className: "insp-error"}, error)),
        resp && h("div", {className: "sq3-card api-resp"},
          h("div", {className: "api-resp-h"},
            h(FFBadge, {kind: statusKind}, `${resp.status} ${resp.statusText || ""}`.trim()),
            h("span", {className: "md-chip-mini"}, `${resp.ms} ms`),
            h("span", {className: "md-chip-mini"}, byteSize(resp.text)),
            h("span", {className: "insp-meta api-resp-req", title: resp.request.path}, `${resp.request.method} ${resp.request.path}`),
            h("div", {className: "api-resp-actions"},
              h("button", {className: "btn btn-secondary btn-sm", onClick: () => safeCopyText(pretty.text || resp.text)}, "Copy"),
              h("button", {className: "btn btn-secondary btn-sm", onClick: () => downloadText(`response.${pretty.kind === "json" ? "json" : pretty.kind === "xml" ? "xml" : "txt"}`, pretty.text || resp.text)}, "Download"))),
          h("div", {className: "sq3-pills md-views", role: "tablist"},
            [["body", "Body"], ["headers", `Headers (${resp.headers.length})`]].map(([id, label]) => h("button", {
              key: id, role: "tab", "aria-selected": view === id, className: "sq3-pill" + (view === id ? " active" : ""), onClick: () => setView(id)
            }, label)),
            links.length > 0 && view === "body" && h("span", {className: "insp-meta api-links-note"}, `${links.length} link${links.length === 1 ? "" : "s"} — click a path to open it`)),
          view === "body"
            ? (pretty.kind === "empty"
              ? h("div", {className: "insp-meta"}, "Empty response body.")
              : h("pre", {
                  className: "api-out",
                  onClick: e => {
                    const a = e.target.closest && e.target.closest(".api-link");
                    if (a) { e.preventDefault(); openLink(a.getAttribute("data-path")); }
                  },
                  dangerouslySetInnerHTML: {__html: pretty.kind === "json" ? jsonHtml(pretty.text) : escHtml(pretty.text)}
                }))
            : h("table", {className: "insp-table api-headers"}, h("tbody", null, resp.headers.map(([k, v]) =>
                h("tr", {key: k}, h("td", {className: "ff-mono"}, k), h("td", null, v)))))))));
}

export {ApiTab};
