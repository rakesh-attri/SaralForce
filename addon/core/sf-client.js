// One HTTP client for every Salesforce API the extension calls (REST,
// Tooling, Composite/Collections, Bulk 2.0, raw SOAP envelopes). Adds what
// the old per-call XHR code lacked: AbortSignal cancellation, timeouts,
// retries for idempotent reads, Retry-After, and a single place that turns
// 401/403 into session errors. Pure apart from the injected fetch, so it is
// unit-tested with a fake.

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD"]);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal) signal.addEventListener("abort", onAbort, {once: true});
  });
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The request was cancelled");
  err.name = "AbortError";
  return err;
}

// Combines a caller signal with a timeout. Returns {signal, cleanup}.
function linkSignals(signal, timeoutMs) {
  if (!timeoutMs && !signal) return {signal: undefined, cleanup() {}};
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, {once: true});
  }
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      const err = new Error(`Salesforce did not answer within ${Math.round(timeoutMs / 1000)}s`);
      err.name = "TimeoutError";
      controller.abort(err);
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}

function retryAfterMs(headers, attempt) {
  const raw = headers && headers.get && headers.get("Retry-After");
  const secs = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30000);
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

async function readBody(response, responseType) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (responseType === "text") return text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return text; // e.g. an HTML error page from a proxy
  }
}

// "ERROR_CODE: message [Field1, Field2]" lines, like the old XHR client.
export function formatSalesforceErrors(detail) {
  if (Array.isArray(detail)) {
    const lines = detail.filter(Boolean).map(e =>
      `${e.errorCode}: ${e.message}${e.fields && e.fields.length > 0 ? ` [${e.fields.join(", ")}]` : ""}`);
    if (lines.length) return lines.join("\n");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return detail == null ? "" : String(detail);
}

function firstMessage(detail) {
  return Array.isArray(detail) && detail.length > 0 && detail[0] ? detail[0].message : null;
}

export function createSfClient({getHost, getSessionId, getApiVersion, fetchImpl, onAuthError, callOptionsClient = "SaralForce"}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  // Low-level request. path is relative to the instance (or absolute).
  // opts: method, body, bodyType ("json" | "raw"), responseType ("json" |
  // "text"), headers, signal, timeoutMs, useCache (true adds a cache-buster),
  // retries (default 2 for GET/HEAD, 0 otherwise), returnResponse (resolve to
  // {status, headers, body} instead of the body), suppressSessionError.
  async function request(path, opts = {}) {
    const host = getHost();
    if (!host) throw new Error("Instance Hostname not found");
    const method = (opts.method || "GET").toUpperCase();
    const responseType = opts.responseType || "json";
    const headers = Object.assign({}, opts.headers || {});
    let url = String(path);
    // Cache-buster on by default, as with the old XHR client.
    if (opts.useCache !== false) {
      url += (url.includes("?") ? "&" : "?") + "cache=" + Math.random();
    }
    const fullUrl = new URL(url, "https://" + host).toString();

    headers.Authorization = "Bearer " + getSessionId();
    if (!("Accept" in headers)) headers.Accept = "application/json; charset=UTF-8";
    let body = opts.body;
    if (body !== undefined) {
      if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json; charset=UTF-8";
      if ((opts.bodyType || "json") === "json") body = JSON.stringify(body);
    }
    headers["Sforce-Call-Options"] = `client=${callOptionsClient}`;

    const maxRetries = opts.retries != null ? opts.retries : (IDEMPOTENT.has(method) ? 2 : 0);
    for (let attempt = 0; ; attempt++) {
      const linked = linkSignals(opts.signal, opts.timeoutMs);
      let response;
      try {
        response = await doFetch(fullUrl, {method, headers, body, signal: linked.signal});
      } catch (fetchErr) {
        linked.cleanup();
        if (opts.signal && opts.signal.aborted) throw abortError(opts.signal);
        if (linked.signal && linked.signal.aborted && linked.signal.reason instanceof Error) throw linked.signal.reason;
        if (attempt < maxRetries) {
          await delay(retryAfterMs(null, attempt), opts.signal);
          continue;
        }
        const err = new Error("Network error, offline or timeout");
        err.name = "SalesforceRestError";
        err.cause = fetchErr;
        throw err;
      }
      linked.cleanup();

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await delay(retryAfterMs(response.headers, attempt), opts.signal);
        continue;
      }

      const data = await readBody(response, responseType);
      const status = response.status;
      if (status >= 200 && status < 400) {
        return opts.returnResponse ? {status, headers: response.headers, body: data} : data;
      }
      if (status === 401) {
        const err = new Error(firstMessage(data) || "New access token needed");
        err.name = "Unauthorized";
        err.status = status;
        err.detail = data;
        if (!opts.suppressSessionError && onAuthError) onAuthError("unauthorized", err.message);
        throw err;
      }
      if (status === 403) {
        const err = new Error(firstMessage(data) || "Error");
        err.name = "Forbidden";
        err.status = status;
        err.detail = data;
        if (!opts.suppressSessionError && onAuthError) onAuthError("forbidden", err.message);
        throw err;
      }
      const err = new Error(formatSalesforceErrors(data) || `HTTP ${status}`);
      err.name = "SalesforceRestError";
      err.status = status;
      err.detail = data;
      throw err;
    }
  }

  const v = () => getApiVersion();
  const describeCache = new Map();

  return {
    request,

    // One page of query results.
    query(soql, {tooling = false, all = false, signal} = {}) {
      const base = tooling ? `/services/data/v${v()}/tooling/query/` : `/services/data/v${v()}/${all ? "queryAll" : "query"}/`;
      return request(base + "?q=" + encodeURIComponent(soql), {signal, useCache: false});
    },

    // Every page, up to maxRecords. Returns {records, totalSize, truncated}.
    async queryAll(soql, {tooling = false, all = false, signal, maxRecords = 50000, maxPages = 500} = {}) {
      let res = await this.query(soql, {tooling, all, signal});
      const records = (res.records || []).slice();
      const totalSize = res.totalSize != null ? res.totalSize : records.length;
      let pages = 1;
      while (res.nextRecordsUrl && records.length < maxRecords && pages < maxPages) {
        res = await request(res.nextRecordsUrl, {signal, useCache: false});
        records.push(...(res.records || []));
        pages++;
      }
      const truncated = !!res.nextRecordsUrl || records.length > maxRecords;
      return {records: records.slice(0, maxRecords), totalSize, truncated};
    },

    // Cached describe per object and API (standard vs Tooling).
    describe(sobject, {tooling = false, signal, refresh = false} = {}) {
      const key = (tooling ? "t:" : "s:") + String(sobject).toLowerCase();
      if (!refresh && describeCache.has(key)) return describeCache.get(key);
      const path = `/services/data/v${v()}/${tooling ? "tooling/" : ""}sobjects/${encodeURIComponent(sobject)}/describe/`;
      const promise = request(path, {signal});
      describeCache.set(key, promise);
      promise.catch(() => describeCache.delete(key));
      return promise;
    },

    clearDescribeCache() {
      describeCache.clear();
    },

    limits({signal} = {}) {
      return request(`/services/data/v${v()}/limits/`, {signal, useCache: false});
    },

    // sObject Collections: up to 200 records per call, in order.
    // operation: "insert" | "update" | "upsert" | "delete". Returns one
    // SaveResult per record, in input order.
    async collections(operation, records, {sobject, externalIdField, allOrNone = false, signal, onProgress} = {}) {
      const results = [];
      const base = `/services/data/v${v()}/composite/sobjects`;
      for (let i = 0; i < records.length; i += 200) {
        const chunk = records.slice(i, i + 200);
        let res;
        if (operation === "delete") {
          const ids = chunk.map(r => (typeof r === "string" ? r : r.Id)).join(",");
          res = await request(`${base}?ids=${encodeURIComponent(ids)}&allOrNone=${allOrNone}`, {method: "DELETE", signal, useCache: false});
        } else {
          const typed = chunk.map(r => Object.assign({attributes: {type: sobject}}, r));
          const body = {allOrNone, records: typed};
          if (operation === "insert") {
            res = await request(base, {method: "POST", body, signal, useCache: false});
          } else if (operation === "update") {
            res = await request(base, {method: "PATCH", body, signal, useCache: false});
          } else if (operation === "upsert") {
            if (!sobject || !externalIdField) throw new Error("Upsert needs sobject and externalIdField");
            res = await request(`${base}/${encodeURIComponent(sobject)}/${encodeURIComponent(externalIdField)}`,
              {method: "PATCH", body, signal, useCache: false});
          } else {
            throw new Error("Unknown collections operation: " + operation);
          }
        }
        results.push(...(res || []));
        if (onProgress) onProgress(Math.min(i + chunk.length, records.length), records.length);
      }
      return results;
    }
  };
}
