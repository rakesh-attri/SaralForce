// API Explorer: send REST, Composite or SOAP requests to the current org and
// read the response. Pure helpers (path handling, pretty-printing, SOAP
// templates, history) so they can be unit-tested with `node --test`.

export const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
export const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Ready-made requests. {v} is replaced with the API version.
export const REST_PRESETS = [
  {group: "Org", label: "API versions", method: "GET", path: "/services/data/"},
  {group: "Org", label: "Resources", method: "GET", path: "/services/data/v{v}/"},
  {group: "Org", label: "Limits", method: "GET", path: "/services/data/v{v}/limits"},
  {group: "Org", label: "Current user", method: "GET", path: "/services/oauth2/userinfo"},
  {group: "Data", label: "All objects", method: "GET", path: "/services/data/v{v}/sobjects/"},
  {group: "Data", label: "Describe Account", method: "GET", path: "/services/data/v{v}/sobjects/Account/describe"},
  {group: "Data", label: "Query", method: "GET", path: "/services/data/v{v}/query/?q=SELECT+Id,+Name+FROM+Account+LIMIT+5"},
  {group: "Data", label: "Search (SOSL)", method: "GET", path: "/services/data/v{v}/search/?q=FIND+%7Bacme%7D+IN+NAME+FIELDS+RETURNING+Account(Id,Name)"},
  {group: "Data", label: "Create Account", method: "POST", path: "/services/data/v{v}/sobjects/Account", body: {Name: "API Explorer test"}},
  {group: "Composite", label: "Composite (create + read)", method: "POST", path: "/services/data/v{v}/composite", body: {
    allOrNone: true,
    compositeRequest: [
      {method: "POST", url: "/services/data/v{v}/sobjects/Account", referenceId: "newAccount", body: {Name: "Composite test"}},
      {method: "GET", url: "/services/data/v{v}/sobjects/Account/@{newAccount.id}?fields=Id,Name", referenceId: "readBack"},
    ],
  }},
  {group: "Composite", label: "sObject Collections (create 2)", method: "POST", path: "/services/data/v{v}/composite/sobjects", body: {
    allOrNone: false,
    records: [{attributes: {type: "Account"}, Name: "Collection A"}, {attributes: {type: "Account"}, Name: "Collection B"}],
  }},
  {group: "Composite", label: "Batch (2 queries)", method: "POST", path: "/services/data/v{v}/composite/batch", body: {
    batchRequests: [
      {method: "GET", url: "v{v}/query/?q=SELECT+COUNT()+FROM+Account"},
      {method: "GET", url: "v{v}/query/?q=SELECT+COUNT()+FROM+Contact"},
    ],
  }},
  {group: "Tooling", label: "Tooling query", method: "GET", path: "/services/data/v{v}/tooling/query/?q=SELECT+Id,+Name+FROM+ApexClass+LIMIT+5"},
  {group: "Tooling", label: "Tooling objects", method: "GET", path: "/services/data/v{v}/tooling/sobjects/"},
  {group: "Apex REST", label: "Your Apex REST class", method: "GET", path: "/services/apexrest/"},
];

export const SOAP_APIS = [
  {id: "partner", label: "Partner API", path: "/services/Soap/u/{v}", ns: "urn:partner.soap.sforce.com",
    sample: "    <urn:getUserInfo/>"},
  {id: "metadata", label: "Metadata API", path: "/services/Soap/m/{v}", ns: "http://soap.sforce.com/2006/04/metadata",
    sample: "    <urn:listMetadata>\n      <urn:queries><urn:type>ApexClass</urn:type></urn:queries>\n      <urn:asOfVersion>{v}</urn:asOfVersion>\n    </urn:listMetadata>"},
  {id: "apex", label: "Apex API", path: "/services/Soap/s/{v}", ns: "http://soap.sforce.com/2006/08/apex",
    sample: "    <urn:executeAnonymous><urn:String>System.debug('hi');</urn:String></urn:executeAnonymous>"},
];

export function withVersion(value, version) {
  if (typeof value === "string") return value.replace(/\{v\}/g, version);
  return JSON.parse(JSON.stringify(value).replace(/\{v\}/g, version));
}

// User input → absolute API path. Bare resources ("sobjects/Account",
// "query/?q=…") go under /services/data/v{version}/.
export function normalizePath(input, version) {
  let p = String(input || "").trim();
  if (!p) return `/services/data/v${version}/`;
  p = p.replace(/^https?:\/\/[^/]+/i, "");
  if (p.startsWith("/")) return p;
  if (/^services\//.test(p)) return "/" + p;
  if (/^v\d+\.\d+\//.test(p)) return `/services/data/${p}`;
  return `/services/data/v${version}/${p}`;
}

// SOAP envelope for an API with the session id filled in. The session id
// is shown masked in the editor and only substituted when sending.
export const SESSION_PLACEHOLDER = "{{sessionId}}";
export function soapTemplate(api, version) {
  const session = `    <urn:SessionHeader><urn:sessionId>${SESSION_PLACEHOLDER}</urn:sessionId></urn:SessionHeader>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${api.ns}">
  <soapenv:Header>
${session}
  </soapenv:Header>
  <soapenv:Body>
${withVersion(api.sample, version)}
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Indent XML for reading (tags on their own lines; text kept inline).
export function formatXml(xml) {
  const src = String(xml || "").replace(/>\s+</g, "><").trim();
  const tokens = src.split(/(<[^>]+>)/).filter(Boolean);
  let depth = 0;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^<\?/.test(t) || /^<!/.test(t)) { out.push(t); continue; }
    if (/^<\//.test(t)) { depth = Math.max(0, depth - 1); out.push("  ".repeat(depth) + t); continue; }
    if (/^</.test(t)) {
      const selfClose = /\/>$/.test(t);
      const text = tokens[i + 1];
      const close = tokens[i + 2];
      if (!selfClose && text && !/^</.test(text) && close && /^<\//.test(close)) {
        out.push("  ".repeat(depth) + t + text + close);
        i += 2;
        continue;
      }
      out.push("  ".repeat(depth) + t);
      if (!selfClose) depth++;
      continue;
    }
    out.push("  ".repeat(depth) + t.trim());
  }
  return out.join("\n");
}

// Response text → {kind, text} for display.
export function prettyBody(text, contentType) {
  const raw = String(text == null ? "" : text);
  const ct = String(contentType || "").toLowerCase();
  if (!raw.trim()) return {kind: "empty", text: ""};
  if (ct.includes("json") || /^\s*[[{"]/.test(raw)) {
    try { return {kind: "json", text: JSON.stringify(JSON.parse(raw), null, 2)}; } catch (e) { /* not JSON */ }
  }
  if (ct.includes("xml") || /^\s*</.test(raw)) return {kind: "xml", text: formatXml(raw)};
  return {kind: "text", text: raw};
}

// API paths inside a JSON response that can be opened with one click.
export function apiLinks(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/"(\/services\/(?:data|apexrest)\/[^"\s]+)"/g)) out.add(m[1]);
  return [...out];
}

// Newest first, no duplicates of the same method + path, at most max.
export function addHistory(list, entry, max = 30) {
  const key = e => `${e.mode}|${e.method}|${e.path}`;
  return [entry, ...(list || []).filter(e => key(e) !== key(entry))].slice(0, max);
}

export function byteSize(text) {
  const n = new TextEncoder().encode(String(text || "")).length;
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
