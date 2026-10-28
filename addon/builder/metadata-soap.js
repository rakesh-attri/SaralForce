// Metadata API SOAP transport. Every function takes a context object instead
// of reading component state, so the deploy pipeline can be driven (and
// tested) outside the React class:
//
//   ctx = {
//     conn,          // {instanceHostname, sessionId} — read at call time
//     apiVersion,    // e.g. "67.0"
//     signal,        // optional shared AbortSignal (deploy "Cancel")
//     isAborted,     // () => boolean — the deploy was cancelled by the user
//     onDebug,       // (action, requestXml, responseText) => void
//     delay          // (ms) => Promise — cancellable wait used when polling
//   }
//
// fetch / DOMParser are only touched when a request is made, so the module
// imports cleanly in Node.
import {buildReadMetadataBody, buildListMetadataBody, buildUpdateMetadataXml} from "./metadata-xml.js";
import {domLocal, domChildren, domFind, domFindAll, domToMetXml} from "./metadata-dom.js";
import {isSfId} from "./deploy-helpers.js";

const REQUEST_TIMEOUT_MS = 60000;

function note(ctx, action, requestXml, responseText) {
  if (ctx && typeof ctx.onDebug === "function") ctx.onDebug(action, requestXml, responseText);
}

function aborted(ctx) {
  return !!(ctx && typeof ctx.isAborted === "function" && ctx.isAborted());
}

export function soapEndpoint(ctx) {
  return "https://" + ctx.conn.instanceHostname + "/services/Soap/m/" + ctx.apiVersion;
}

// `bodyXml` is placed verbatim inside <soapenv:Body> (4-space indent).
export function buildSoapEnvelope(sessionId, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <met:SessionHeader>
      <met:sessionId>${sessionId}</met:sessionId>
    </met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    ${bodyXml}
  </soapenv:Body>
</soapenv:Envelope>`;
}

// POST an envelope with a per-request AbortController: the 60s timeout must
// NOT abort the shared deploy controller (that permanently kills every
// later SOAP call). Listen to the shared cancel signal instead so "Cancel"
// still works. `label` names the call in timeout errors/debug.
async function postEnvelope(ctx, envelope, label, requestXml) {
  const url = soapEndpoint(ctx);
  const local = new AbortController();
  const shared = ctx.signal || null;
  let onSharedAbort = null;
  if (shared) {
    if (shared.aborted) local.abort();
    else {
      onSharedAbort = () => local.abort();
      shared.addEventListener("abort", onSharedAbort, {once: true});
    }
  }
  const timeoutId = setTimeout(() => local.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "SOAPAction": '""'
      },
      body: envelope,
      signal: local.signal
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === "AbortError") {
      if (aborted(ctx)) throw new Error("Deployment cancelled");
      note(ctx, label, requestXml, "TIMED OUT after 60s (no response body)");
      throw new Error(`Request timed out after 60s (${label})`);
    }
    throw new Error("Network error: " + fetchErr.message);
  } finally {
    clearTimeout(timeoutId);
    if (onSharedAbort && shared) {
      shared.removeEventListener("abort", onSharedAbort);
    }
  }
}

// Parse a create/update/checkStatus style response. Throws on SOAP faults and
// on success=false results (with err.statusCode when present).
export function parseMetaSoapResponse(ctx, action, metadataXml, status, responseText) {
  if (status !== 200) {
    const faultMatch = responseText.match(/<faultstring[^>]*>([^<]*)<\/faultstring>/);
    const faultMsg = faultMatch ? faultMatch[1] : "HTTP " + status;
    note(ctx, action, metadataXml, responseText);
    throw new Error(faultMsg);
  }

  // Parse as XML DOM to handle namespace prefixes like met:id, met:done etc.
  const parser = new DOMParser();
  const doc = parser.parseFromString(responseText, "text/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    console.error("[SaralForce] XML parse error:", parseError.textContent);
    note(ctx, action, metadataXml, responseText);
    throw new Error("Failed to parse Metadata API response XML");
  }

  if (action === "checkDeployStatus") {
    const doneEl = doc.querySelector("done");
    const successEl = doc.querySelector("success");
    const errorMessageEl = doc.querySelector("errorMessage");
    const problemEl = doc.querySelector("problem");
    const done = doneEl ? doneEl.textContent : "true";
    const st = successEl ? (successEl.textContent === "true" ? "Succeeded" : "Failed") : "Failed";
    const errorMsg = errorMessageEl ? errorMessageEl.textContent : (problemEl ? problemEl.textContent : null);
    return {done, status: st, errorMessage: errorMsg};
  }

  // For create/createResponse - find the result element
  const resultEl = doc.querySelector("result");
  if (resultEl) {
    const idEl = resultEl.querySelector("id");
    const doneEl = resultEl.querySelector("done");
    const stateEl = resultEl.querySelector("state");
    const successEl = resultEl.querySelector("success");
    const errorsEl = resultEl.querySelector("errors");
    const messageEl = resultEl.querySelector("message");
    const statusCodeEl = resultEl.querySelector("statusCode");

    const id = idEl ? idEl.textContent : null;
    const done = doneEl ? doneEl.textContent : "true";
    const state = stateEl ? stateEl.textContent : "Completed";
    const success = successEl ? successEl.textContent : "true";
    const message = messageEl ? messageEl.textContent : null;
    const statusCode = statusCodeEl ? statusCodeEl.textContent : null;

    console.log("[SaralForce] Parsed result:", {id, done, state, success, message, statusCode});

    if (success === "false" && errorsEl) {
      const msgEl = errorsEl.querySelector("message");
      const codeEl = errorsEl.querySelector("statusCode");
      const errMsg = msgEl ? msgEl.textContent : "Metadata API returned error";
      note(ctx, action, metadataXml, responseText);
      const err = new Error(errMsg);
      if (codeEl) err.statusCode = codeEl.textContent;
      throw err;
    }

    return {id, done, state, success, message, statusCode};
  }

  // Check for SOAP fault
  const faultEl = doc.querySelector("faultstring");
  if (faultEl) {
    note(ctx, action, metadataXml, responseText);
    throw new Error(faultEl.textContent);
  }

  note(ctx, action, metadataXml, responseText);
  throw new Error("Could not parse Metadata API response: " + responseText.substring(0, 300));
}

export async function metaSoapRequest(ctx, action, metadataXml) {
  const url = soapEndpoint(ctx);
  console.log("[SaralForce] SOAP request to:", url, "Action:", action);

  const envelope = buildSoapEnvelope(ctx.conn.sessionId,
    `<met:${action}>
      ${metadataXml}
    </met:${action}>`);

  console.log("[SaralForce] SOAP envelope length:", envelope.length);

  const response = await postEnvelope(ctx, envelope, action, metadataXml);

  console.log("[SaralForce] SOAP response status:", response.status);

  const responseText = await response.text();
  console.log("[SaralForce] SOAP response (first 500 chars):", responseText.substring(0, 500));

  return parseMetaSoapResponse(ctx, action, metadataXml, response.status, responseText);
}

// Raw SOAP POST returning a parsed DOM. Used for readMetadata (whose
// records response doesn't fit metaSoapRequest's create-style parser).
export async function soapPostDom(ctx, bodyInnerXml) {
  const envelope = buildSoapEnvelope(ctx.conn.sessionId, bodyInnerXml);
  const response = await postEnvelope(ctx, envelope, "soapPostDom", bodyInnerXml);
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    note(ctx, "raw", bodyInnerXml, text);
    throw new Error("Failed to parse Metadata API response XML");
  }
  const fault = domFind(doc.documentElement, "Fault");
  if (fault) {
    const fs = domFind(fault, "faultstring");
    const msg = fs ? fs.textContent : "Metadata API SOAP fault";
    note(ctx, "raw", bodyInnerXml, text);
    throw new Error(msg);
  }
  return doc;
}

// Read one metadata component, returning its <records> DOM element (or
// null when the fullName doesn't exist). Namespace-agnostic.
export async function metadataReadRecords(ctx, type, fullName) {
  const doc = await soapPostDom(ctx, buildReadMetadataBody(type, fullName));
  return domFind(doc.documentElement, "records") || null;
}

// Write back a records element previously obtained via metadataReadRecords
// (optionally mutated) using the SYNC updateMetadata call, which supports
// every metadata type (unlike async update()). Full round-trip: nothing
// outside the mutation is lost, so Profile/Layout updates can't wipe data.
export async function metadataUpdateRecords(ctx, xsiType, fullName, recordsEl) {
  // CustomApplication (and others) must use metadata fullName, never a record Id.
  if (isSfId(fullName)) {
    throw new Error(
      `Refusing updateMetadata: fullName "${fullName}" is a Salesforce Id, not a metadata name`
    );
  }
  const parts = [];
  for (const child of domChildren(recordsEl)) {
    if (domLocal(child) === "fullName") continue;
    parts.push(domToMetXml(child));
  }
  const xml = buildUpdateMetadataXml(xsiType, fullName, parts.join(""));
  const result = await metaSoapRequest(ctx, "updateMetadata", xml);
  // updateMetadata can run async — poll or the caller verifies too early.
  if (result && result.id && (result.done === "false" || result.state === "InProgress")) {
    console.log(`[SaralForce] updateMetadata(${xsiType}) async, polling ${result.id}...`);
    await pollDeployStatus(ctx, result.id);
  }
  return result;
}

// Create one metadata component. Primary path is the synchronous
// createMetadata() call (SaveResult) — the async CRUD create()/checkStatus()
// pair is documented as available only in API 30.0 and earlier, and this
// app talks to /services/Soap/m/<apiVersion> (67.0 by default). The legacy
// create() + checkStatus() polling is kept only as a fallback for an org
// or endpoint that rejects createMetadata as an unknown operation.
export async function metadataCreate(ctx, metadataXml) {
  try {
    return await metaSoapRequest(ctx, "createMetadata", metadataXml);
  } catch (err) {
    if (!/No operation available|INVALID_OPERATION|Unknown operation|not a valid operation/i.test(err.message || "")) {
      throw err;
    }
    console.warn("[SaralForce] createMetadata unavailable, falling back to create():", err.message);
    const res = await metaSoapRequest(ctx, "create", metadataXml);
    if (res && res.id && (res.done === "false" || res.state === "InProgress")) {
      await pollDeployStatus(ctx, res.id);
    }
    return res;
  }
}

export async function pollDeployStatus(ctx, deployId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    if (aborted(ctx)) throw new Error("Deployment cancelled");
    await ctx.delay(3000);
    console.log(`[SaralForce] Polling create status (${i + 1}/${maxAttempts})...`);

    const checkXml = `<met:id>${deployId}</met:id>`;

    let result;
    try {
      result = await metaSoapRequest(ctx, "checkStatus", checkXml);
    } catch (netErr) {
      console.warn("[SaralForce] Poll network error:", netErr.message);
      if (i === maxAttempts - 1) throw netErr;
      continue;
    }

    console.log("[SaralForce] Create status:", result);

    if (result.state === "Failed" || result.state === "Error") {
      throw new Error(result.message || result.errorMessage || "Metadata creation failed");
    }
    if (result.done === "true" || result.state === "Completed") {
      console.log("[SaralForce] Create completed successfully");
      return;
    }
  }
  throw new Error("Deployment timed out waiting for completion");
}

// listMetadata → array of fullNames for a metadata type.
export async function listMetadataFullNames(ctx, type) {
  const doc = await soapPostDom(ctx, buildListMetadataBody(type));
  const names = [];
  for (const fp of domFindAll(doc.documentElement, "fileProperties")) {
    const fn = domFind(fp, "fullName");
    if (fn && fn.textContent) names.push(fn.textContent);
  }
  if (names.length === 0) {
    // Some orgs return fullNames without a fileProperties wrapper.
    for (const fn of domFindAll(doc.documentElement, "fullName")) {
      if (fn.textContent) names.push(fn.textContent);
    }
  }
  return names;
}
