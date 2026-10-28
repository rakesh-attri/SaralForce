import {sf, sfConn, apiVersion} from "../../inspector.js";
import {ffStoppedError, ffSleep} from "./hooks.js";

// ── Bulk API 2.0 client ────────────────────────────────────────────────────
// Built on the shared client (sf.request) so it gets the same 401/403 session
// handling, network-error retries for reads and AbortSignal support, while
// returnResponse keeps response headers (Sforce-Locator) readable.
// opts: method, headers, body (string), bodyType ("json" | "raw"),
// responseType ("json" | "text"), signal. Resolves {status, headers, text, json}.
async function ffBulkFetch(path, opts) {
  const o = opts || {};
  if (!sfConn.instanceHostname || !sfConn.sessionId) throw new Error("No active Salesforce session");
  const responseType = o.responseType || "json";
  let res;
  try {
    res = await sf.request(path, {
      method: o.method || "GET",
      headers: o.headers,
      body: o.body,
      bodyType: o.bodyType || "json",
      responseType,
      signal: o.signal,
      useCache: false,
      returnResponse: true
    });
  } catch (e) {
    // Aborted by the caller (view closed / Stop): same error as ffSleep.
    if (o.signal && o.signal.aborted) throw ffStoppedError();
    // Keep error texts short (an HTML error page would otherwise be dumped).
    if (e && typeof e.message === "string" && e.message.length > 300) e.message = e.message.slice(0, 300);
    throw e;
  }
  const body = res.body;
  let text;
  let json = null;
  if (typeof body === "string") {
    text = body;
    if (responseType === "json") {
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain text */ }
    }
  } else {
    json = body;
    text = body == null ? "" : JSON.stringify(body);
  }
  return {status: res.status, headers: res.headers, text, json};
}

function signalOf(opts) {
  return opts && opts.signal ? opts.signal : undefined;
}

async function ffBulkQueryCreate(soql, opts) {
  const o = opts || {};
  const r = await ffBulkFetch("/services/data/v" + apiVersion + "/jobs/query", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: {
      operation: o.allRows ? "queryAll" : "query",
      query: String(soql || "").trim()
    },
    signal: o.signal
  });
  return r.json;
}

function ffBulkQueryStatus(jobId, opts) {
  return ffBulkFetch(`/services/data/v${apiVersion}/jobs/query/${jobId}`, {signal: signalOf(opts)}).then(r => r.json);
}

async function ffBulkQueryResults(jobId, locator, opts) {
  const path = `/services/data/v${apiVersion}/jobs/query/${jobId}/results` +
    (locator ? `?locator=${encodeURIComponent(locator)}` : "");
  const r = await ffBulkFetch(path, {headers: {Accept: "text/csv"}, responseType: "text", signal: signalOf(opts)});
  // Sforce-Locator present => more result chunks remain.
  return {csv: r.text, locator: r.headers.get("Sforce-Locator")};
}

async function ffBulkIngestCreate(opts) {
  const body = {
    operation: opts.operation, // insert | update | upsert | delete | hardDelete
    object: opts.object,
    contentType: "CSV",
    lineEnding: opts.lineEnding === "\n" ? "LF" : "CRLF"
  };
  if (opts.operation === "upsert" && opts.externalIdFieldName) {
    body.externalIdFieldName = opts.externalIdFieldName;
  }
  const r = await ffBulkFetch("/services/data/v" + apiVersion + "/jobs/ingest", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body,
    signal: opts.signal
  });
  return r.json;
}

function ffBulkIngestUpload(jobId, csv, opts) {
  return ffBulkFetch(`/services/data/v${apiVersion}/jobs/ingest/${jobId}/batches`, {
    method: "PUT",
    headers: {"Content-Type": "text/csv"},
    body: csv,
    bodyType: "raw",
    signal: signalOf(opts)
  });
}

function ffBulkIngestClose(jobId, opts) {
  return ffBulkFetch(`/services/data/v${apiVersion}/jobs/ingest/${jobId}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: {state: "UploadComplete"},
    signal: signalOf(opts)
  });
}

function ffBulkIngestStatus(jobId, opts) {
  return ffBulkFetch(`/services/data/v${apiVersion}/jobs/ingest/${jobId}`, {signal: signalOf(opts)}).then(r => r.json);
}

async function ffBulkIngestResults(jobId, kind, opts) {
  // kind: successfulResults | failedResults | unprocessedRecords
  const r = await ffBulkFetch(
    `/services/data/v${apiVersion}/jobs/ingest/${jobId}/${kind}`,
    {headers: {Accept: "text/csv"}, responseType: "text", signal: signalOf(opts)});
  return r.text;
}

// Cancels the Salesforce job itself (explicit user action). Not tied to the
// poll signal: stopping the client must never abort the server job.
async function ffBulkJobCancel(jobId, kind) {
  if (kind === "query") {
    return ffBulkFetch(`/services/data/v${apiVersion}/jobs/query/${jobId}`, {method: "DELETE"});
  }
  return ffBulkFetch(`/services/data/v${apiVersion}/jobs/ingest/${jobId}`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: {state: "Aborted"}
  });
}

// Poll a Bulk job until a terminal state. onTick receives each intermediate
// job record so the UI can render live progress. opts.signal stops the
// client-side polling (including an in-flight status request); it never
// aborts the Salesforce job. getStatus is called as getStatus(jobId, {signal}).
async function ffBulkPoll(getStatus, jobId, opts) {
  const o = opts || {};
  const terminal = o.terminal || ["JobComplete", "Failed", "Aborted"];
  const intervalMs = o.intervalMs || 2000;
  const timeoutMs = o.timeoutMs || 300000;
  const start = Date.now();
  const fetchStatus = async () => {
    try {
      return await getStatus(jobId, {signal: o.signal});
    } catch (e) {
      // A custom getStatus may not map aborts itself.
      if (o.signal && o.signal.aborted) throw ffStoppedError();
      throw e;
    }
  };
  let job = await fetchStatus();
  while (terminal.indexOf(job.state) === -1) {
    if (o.signal && o.signal.aborted) throw ffStoppedError();
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for Bulk job " + jobId + " (last state: " + job.state + ")");
    }
    if (o.onTick) o.onTick(job);
    await ffSleep(intervalMs, o.signal);
    job = await fetchStatus();
  }
  if (o.signal && o.signal.aborted) throw ffStoppedError();
  if (o.onTick) o.onTick(job);
  return job;
}

export {ffBulkQueryCreate, ffBulkQueryStatus, ffBulkQueryResults, ffBulkIngestCreate, ffBulkIngestUpload, ffBulkIngestClose, ffBulkIngestStatus, ffBulkIngestResults, ffBulkJobCancel, ffBulkPoll};
