// Release Center transport: Metadata API listMetadata / retrieve / deploy /
// quick deploy / cancel against ANY Salesforce org with a session in this
// browser (source and target can differ from the org the panel is on).
import {sfConn, apiVersion, reportSessionExpired} from "../../inspector.js";
import {createSfClient} from "../../core/sf-client.js";
import {soapPostDom} from "../../builder/metadata-soap.js";
import {escXml} from "../../builder/metadata-xml.js";
import {domLocal, domChildren, domFind} from "../../builder/metadata-dom.js";
import {chunk, keepListRow, compKey, TYPE_BY_NAME, summarizeDeployResult, registerTypes, settingsMembers} from "../../core/deploy.js";
import {readZip, base64ToBytes, bytesToBase64, writeZipCompressed} from "../../core/zip.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sendMessage(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, resolve); } catch (e) { resolve(null); }
  });
}

// ── Orgs ──────────────────────────────────────────────────────────────
// Re-read the org's session cookie (after logging in again). True if new.
async function renewConn(conn) {
  if (conn.isCurrent) return sfConn.renewSession();
  const session = await sendMessage({message: "getSession", sfHost: conn.host});
  if (!session || !session.key || session.key === conn.sessionId) return false;
  conn.sessionId = session.key;
  return true;
}

function connFor(host, sessionId) {
  const conn = {host, sessionId, apiVersion};
  conn.client = createSfClient({getHost: () => host, getSessionId: () => conn.sessionId, getApiVersion: () => apiVersion,
    renewSession: () => renewConn(conn)});
  return conn;
}

const orgCache = new Map();

// The org the panel runs on, as a connection.
export function currentOrgConn() {
  const conn = connFor(sfConn.instanceHostname, sfConn.sessionId);
  conn.isCurrent = true;
  // Always the panel's live session, so a renewed one is used everywhere.
  Object.defineProperty(conn, "sessionId", {get: () => sfConn.sessionId, set: () => {}, enumerable: true});
  return conn;
}

async function describeOrg(conn, isCurrent) {
  const res = await conn.client.query("SELECT Id, Name, IsSandbox, OrganizationType, InstanceName FROM Organization");
  const o = (res.records || [])[0] || {};
  let user = "";
  try {
    const info = await conn.client.request(`/services/data/v${apiVersion}/chatter/users/me`, {useCache: false});
    user = info && (info.username || info.name) || "";
  } catch (e) { /* optional */ }
  return {host: conn.host, orgId: o.Id || "", name: o.Name || conn.host, isSandbox: !!o.IsSandbox,
    edition: o.OrganizationType || "", instance: o.InstanceName || "", user, isCurrent, conn};
}

// Every org you're logged into here (the current one first). Orgs whose
// session is gone are skipped silently.
export async function listOrgs({refresh = false} = {}) {
  if (orgCache.size && !refresh) return [...orgCache.values()];
  orgCache.clear();
  const current = currentOrgConn();
  const found = [{host: current.host, conn: current, isCurrent: true}];
  const others = (await sendMessage({message: "listOrgs"})) || [];
  for (const o of others) {
    if (!o || !o.host || sameOrgHost(o.host, current.host)) continue;
    const session = await sendMessage({message: "getSession", sfHost: o.host});
    if (session && session.key) found.push({host: session.hostname || o.host, conn: connFor(session.hostname || o.host, session.key), isCurrent: false});
  }
  const out = await Promise.all(found.map(f => describeOrg(f.conn, f.isCurrent).catch(() => null)));
  const seen = new Set();
  for (const org of out) {
    if (!org || seen.has(org.orgId || org.host)) continue;
    seen.add(org.orgId || org.host);
    orgCache.set(org.host, org);
  }
  return [...orgCache.values()];
}

function sameOrgHost(a, b) {
  return String(a).replace(/\.lightning\.force\./, ".my.salesforce.") === String(b).replace(/\.lightning\.force\./, ".my.salesforce.");
}

function ctxFor(conn, {signal} = {}) {
  return {conn: {instanceHostname: conn.host, sessionId: conn.sessionId}, apiVersion, signal, delay: sleep};
}

async function mdCall(conn, inner, opts) {
  const used = conn.sessionId;
  try {
    return await soapPostDom(ctxFor(conn, opts), inner);
  } catch (e) {
    if (!/INVALID_SESSION_ID|Session expired or invalid/i.test(e.message || "")) throw e;
    if (conn.sessionId !== used || await renewConn(conn)) return soapPostDom(ctxFor(conn, opts), inner);
    if (conn.isCurrent) reportSessionExpired();
    throw e;
  }
}

// DOM element → plain object (repeated children become arrays).
export function domToObj(el) {
  const kids = domChildren(el);
  if (!kids.length) {
    const nil = el.getAttribute && (el.getAttribute("xsi:nil") === "true");
    return nil ? null : el.textContent;
  }
  const out = {};
  for (const k of kids) {
    const name = domLocal(k);
    const v = domToObj(k);
    if (name in out) out[name] = Array.isArray(out[name]) ? [...out[name], v] : [out[name], v];
    else out[name] = v;
  }
  return out;
}

function resultObjs(doc) {
  const body = domFind(doc.documentElement, "Body");
  const resp = body && domChildren(body)[0];
  if (!resp) return [];
  return domChildren(resp).filter(c => domLocal(c) === "result").map(domToObj);
}

// ── describeMetadata: every type this org can deploy ─────────────────
const described = new Map(); // host → Promise<count>

export async function describeMetadata(conn, {signal} = {}) {
  const doc = await mdCall(conn, `<met:describeMetadata><met:asOfVersion>${apiVersion}</met:asOfVersion></met:describeMetadata>`, {signal});
  const r = resultObjs(doc)[0] || {};
  return [].concat(r.metadataObjects || []);
}

// Adds the org's types to the catalog (once per org and page load).
// Never fails: without it the built-in types still work.
export function loadCatalog(conn) {
  if (!conn || !conn.host) return Promise.resolve(0);
  if (!described.has(conn.host)) {
    described.set(conn.host, describeMetadata(conn).then(list => registerTypes(list)).catch(() => {
      described.delete(conn.host);
      return 0;
    }));
  }
  return described.get(conn.host);
}

// ── listMetadata ──────────────────────────────────────────────────────
// queries: [{type, folder?}] → rows with dates and authors (managed skipped).
export async function listMetadata(conn, queries, {signal, onProgress} = {}) {
  const rows = [];
  const groups = chunk(queries, 3);
  let n = 0;
  for (const g of groups) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    const qx = g.map(q => `<met:queries>${q.folder ? `<met:folder>${escXml(q.folder)}</met:folder>` : ""}<met:type>${escXml(q.type)}</met:type></met:queries>`).join("");
    const call = x => mdCall(conn, `<met:listMetadata>${x}<met:asOfVersion>${apiVersion}</met:asOfVersion></met:listMetadata>`, {signal});
    let docs;
    try {
      docs = [await call(qx)];
    } catch (e) {
      // A type the other org doesn't have (feature off, older API): list
      // the group one by one and skip only that type.
      if (g.length < 2 || /INVALID_SESSION|Cancelled/i.test(e.message || "")) {
        if (g.length < 2 && /INVALID_TYPE|not a valid|Unknown type|UNKNOWN_EXCEPTION/i.test(e.message || "")) docs = [];
        else throw e;
      } else {
        docs = [];
        for (const q of g) {
          try { docs.push(await call(`<met:queries>${q.folder ? `<met:folder>${escXml(q.folder)}</met:folder>` : ""}<met:type>${escXml(q.type)}</met:type></met:queries>`)); } catch (e2) { /* skip this type */ }
        }
      }
    }
    for (const doc of docs) for (const r of resultObjs(doc)) if (keepListRow(r)) rows.push(r);
    n++;
    if (onProgress) onProgress(n, groups.length);
  }
  return rows;
}

// Lists the given types, walking folders for folder-based types.
// Returns Map(compKey → {type, fullName, lastModifiedDate, lastModifiedByName, …}).
export async function listComponents(conn, types, {signal, onProgress} = {}) {
  const plain = [];
  const folderTypes = [];
  const settings = [];
  for (const t of types) {
    const def = TYPE_BY_NAME[t];
    if (!def || def.hidden) continue;
    // Can't be listed: every setting the org knows, retrieved to see which exist.
    if (t === "Settings") settings.push(...settingsMembers().map(n => ({type: "Settings", fullName: n, synthetic: true})));
    else if (def.folder) folderTypes.push(def); else plain.push({type: t});
  }
  const queries = plain.slice();
  if (folderTypes.length) {
    const folders = await listMetadata(conn, folderTypes.map(d => ({type: d.folder})), {signal});
    for (const d of folderTypes) {
      const own = folders.filter(f => f.type === d.folder);
      for (const f of own) queries.push({type: d.name, folder: f.fullName});
      if (d.name !== "Dashboard") queries.push({type: d.name, folder: "unfiled$public"});
    }
    for (const f of folders) {
      const d = folderTypes.find(x => x.folder === f.type);
      if (d) queries.push({folderRow: {...f, type: d.name, isFolder: true}});
    }
  }
  const real = queries.filter(q => !q.folderRow);
  const rows = await listMetadata(conn, real, {signal, onProgress});
  for (const q of queries) if (q.folderRow) rows.push(q.folderRow);
  rows.push(...settings);
  const out = new Map();
  for (const r of rows) {
    const type = r.type || "";
    out.set(compKey(type, r.fullName), {
      type, fullName: r.fullName, isFolder: !!r.isFolder,
      lastModifiedDate: r.lastModifiedDate || "", lastModifiedByName: r.lastModifiedByName || "",
      createdDate: r.createdDate || "", createdByName: r.createdByName || "", id: r.id || "", synthetic: !!r.synthetic
    });
  }
  return out;
}

// ── retrieve ──────────────────────────────────────────────────────────
function typesXml(members) {
  return Object.keys(members).sort().filter(t => members[t].length).map(t =>
    `<met:types>${members[t].map(m => `<met:members>${escXml(m)}</met:members>`).join("")}<met:name>${escXml(t)}</met:name></met:types>`).join("");
}

// members: {type: [fullName]} → {files: Map(path → bytes), messages: [{fileName, problem}]}
export async function retrieve(conn, members, {signal, onProgress, timeoutMs = 15 * 60000} = {}) {
  const inner = `<met:retrieve><met:retrieveRequest><met:apiVersion>${apiVersion}</met:apiVersion>` +
    `<met:singlePackage>true</met:singlePackage><met:unpackaged>${typesXml(members)}` +
    `<met:version>${apiVersion}</met:version></met:unpackaged></met:retrieveRequest></met:retrieve>`;
  const started = await mdCall(conn, inner, {signal});
  const id = (resultObjs(started)[0] || {}).id;
  if (!id) throw new Error("Salesforce did not start the retrieve");
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    if (Date.now() - t0 > timeoutMs) throw new Error("Retrieve timed out");
    await sleep(i < 3 ? 1500 : 3000);
    const doc = await mdCall(conn, `<met:checkRetrieveStatus><met:asyncProcessId>${id}</met:asyncProcessId><met:includeZip>true</met:includeZip></met:checkRetrieveStatus>`, {signal});
    const r = resultObjs(doc)[0] || {};
    if (onProgress) onProgress(r.status || "InProgress");
    if (r.done !== "true") continue;
    if (r.status === "Failed") throw new Error(r.errorMessage || "Retrieve failed");
    const messages = [].concat(r.messages || []).filter(Boolean).map(m => ({fileName: m.fileName || "", problem: m.problem || ""}));
    const files = r.zipFile ? await readZip(base64ToBytes(r.zipFile)) : new Map();
    return {files, messages};
  }
}

// ── deploy ────────────────────────────────────────────────────────────
// entries: [[path, bytes|string]]. options: {checkOnly, testLevel, runTests[], ignoreWarnings}
export async function startDeploy(conn, entries, options = {}) {
  const zip = bytesToBase64(await writeZipCompressed(entries));
  const runTests = options.testLevel === "RunSpecifiedTests" ? (options.runTests || []) : [];
  // DeployOptions children must follow the WSDL sequence.
  const opts = [
    `<met:checkOnly>${options.checkOnly ? "true" : "false"}</met:checkOnly>`,
    `<met:ignoreWarnings>${options.ignoreWarnings ? "true" : "false"}</met:ignoreWarnings>`,
    `<met:rollbackOnError>true</met:rollbackOnError>`,
    ...runTests.map(t => `<met:runTests>${escXml(t)}</met:runTests>`),
    `<met:singlePackage>true</met:singlePackage>`,
    options.testLevel && options.testLevel !== "Default" ? `<met:testLevel>${escXml(options.testLevel)}</met:testLevel>` : ""
  ].join("");
  const doc = await mdCall(conn, `<met:deploy><met:ZipFile>${zip}</met:ZipFile><met:DeployOptions>${opts}</met:DeployOptions></met:deploy>`);
  const id = (resultObjs(doc)[0] || {}).id;
  if (!id) throw new Error("Salesforce did not start the deploy");
  return id;
}

export async function deployStatus(conn, id) {
  const doc = await mdCall(conn, `<met:checkDeployStatus><met:asyncProcessId>${escXml(id)}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`);
  return summarizeDeployResult(resultObjs(doc)[0] || {});
}

// Polls until done; onUpdate(summary) after every check.
export async function waitForDeploy(conn, id, {onUpdate, signal, timeoutMs = 3 * 60 * 60000} = {}) {
  const t0 = Date.now();
  let fails = 0;
  for (let i = 0; ; i++) {
    if (signal && signal.aborted) throw new Error("Stopped watching");
    let s;
    try {
      s = await deployStatus(conn, id);
      fails = 0;
    } catch (e) {
      // A network blip or a slow answer must not lose a running deploy.
      if (++fails >= 6) throw new Error(`Lost contact with Salesforce (${e.message}). The deploy may still be running: check History → Check status.`);
      await sleep(5000);
      continue;
    }
    if (onUpdate) onUpdate(s);
    if (s.done) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error("Still running in Salesforce after 3 hours: check History → Check status, or Setup → Deployment Status.");
    await sleep(i < 5 ? 2000 : 4000);
  }
}

// Quick deploy of a passed validation (no tests re-run).
export async function quickDeploy(conn, validationId) {
  const doc = await mdCall(conn, `<met:deployRecentValidation><met:validationId>${escXml(validationId)}</met:validationId></met:deployRecentValidation>`);
  const body = domFind(doc.documentElement, "result");
  const id = body ? body.textContent : "";
  if (!id) throw new Error("Salesforce did not start the quick deploy");
  return id;
}

export async function cancelDeploy(conn, id) {
  await mdCall(conn, `<met:cancelDeploy><met:String>${escXml(id)}</met:String></met:cancelDeploy>`);
}

// Tooling/REST helpers on a given org.
export async function queryAll(conn, soql, {tooling = false} = {}) {
  const res = await conn.client.queryAll(soql, {tooling, maxRecords: 2000});
  return res.records || [];
}

export function setupUrl(conn, path) {
  const host = String(conn.host).replace(/\.my\.salesforce\.com$/, ".lightning.force.com");
  return `https://${host}${path}`;
}
