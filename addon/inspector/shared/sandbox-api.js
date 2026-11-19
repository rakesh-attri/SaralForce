// Sandbox Manager calls. Sandboxes are managed from PRODUCTION (Tooling
// SandboxInfo / SandboxProcess); backups, restores and the post-refresh
// checklist run in the sandbox itself (its own logged-in connection).
import {apiVersion} from "../../inspector.js";
import {queryAll as connQuery, listComponents, loadCatalog} from "./deploy-api.js";
import {retrieveAll, keepObject} from "../tabs/release-compare.js";
import {presetTypes} from "../../core/deploy.js";
import {saveSnapshot, saveBytes, loadBytes, saveBackup} from "./release-store.js";
import {ffBulkQueryCreate, ffBulkQueryStatus, ffBulkQueryResults, ffBulkPoll} from "./bulk-api.js";
import {mergeCsvChunks} from "../../core/bulk.js";
import {parseCsv} from "../../core/csv.js";
import {textToBytes, bytesToText} from "../../core/zip.js";
import {escapeSoqlString} from "../../core/soql.js";
import {executeAnonymous, deactivateFlows} from "./manual-actions.js";
import {mergeSandboxes, backupMatchesOrg, restoreOrder, restoreRecord, addIds, isInvalidEmail, stripInvalid, endpointKind, flowOutsideReasons} from "../../core/sandboxes.js";

const T = `/services/data/v${apiVersion}/tooling`;
const rest = (conn, path, opts = {}) => conn.client.request(path, {useCache: false, ...opts});
const tooling = (conn, soql) => connQuery(conn, soql, {tooling: true});
const soql = (conn, q) => connQuery(conn, q);
const idList = ids => ids.map(i => `'${escapeSoqlString(i)}'`).join(",");

// ── Sandboxes (production session) ────────────────────────────────────
const INFO_FIELDS = ["Id", "SandboxName", "LicenseType", "Description", "AutoActivate", "ApexClassId", "ActivationUserGroupId", "SourceId",
  "TemplateId", "HistoryDays", "CopyChatter", "CreatedDate"];
const PROC_FIELDS = ["Id", "SandboxInfoId", "SandboxName", "LicenseType", "Status", "CopyProgress", "StartDate", "EndDate", "ActivatedDate",
  "SandboxOrganization", "Description", "CreatedDate"];

// Fields some orgs / versions don't expose are dropped and the query retried.
async function tolerantQuery(conn, object, fields, tail = "") {
  let f = [...fields];
  for (let i = 0; i < 4; i++) {
    try {
      return await tooling(conn, `SELECT ${f.join(", ")} FROM ${object}${tail}`);
    } catch (e) {
      const bad = /No such column '(\w+)'/i.exec(e.message || "");
      if (!bad || !f.includes(bad[1])) throw e;
      f = f.filter(x => x !== bad[1]);
    }
  }
  return tooling(conn, `SELECT Id FROM ${object}${tail}`);
}

export async function listSandboxes(prodConn) {
  const [infos, procs] = await Promise.all([
    tolerantQuery(prodConn, "SandboxInfo", INFO_FIELDS, " ORDER BY SandboxName"),
    tolerantQuery(prodConn, "SandboxProcess", PROC_FIELDS, " ORDER BY CreatedDate DESC"),
  ]);
  return mergeSandboxes(infos, procs);
}

export const createSandbox = (conn, body) => rest(conn, `${T}/sobjects/SandboxInfo`, {method: "POST", body});
export const refreshSandbox = (conn, id, body) => rest(conn, `${T}/sobjects/SandboxInfo/${encodeURIComponent(id)}`, {method: "PATCH", body});
export const deleteSandbox = (conn, id) => rest(conn, `${T}/sobjects/SandboxInfo/${encodeURIComponent(id)}`, {method: "DELETE"});
// ACTIVATE or DISCARD a sandbox that is Pending Activation.
export const setRefreshAction = (conn, processId, action) =>
  rest(conn, `${T}/sobjects/SandboxProcess/${encodeURIComponent(processId)}`, {method: "PATCH", body: {RefreshAction: action}});

// Pickers for the create / refresh dialog.
export async function postCopyClasses(conn) {
  try {
    const r = await rest(conn, `/services/data/v${apiVersion}/search/?q=` + encodeURIComponent("FIND {SandboxPostCopy} IN ALL FIELDS RETURNING ApexClass(Id, Name)"));
    const list = (r.searchRecords || []).map(x => ({id: x.Id, name: x.Name}));
    if (list.length) return list;
  } catch (e) { /* search not available: scan the class bodies */ }
  const rows = await tooling(conn, "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null").catch(() => []);
  return rows.filter(c => /implements\s+(System\.)?SandboxPostCopy/i.test(c.Body || "")).map(c => ({id: c.Id, name: c.Name}));
}
export async function publicGroups(conn) {
  return (await soql(conn, "SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Regular' ORDER BY Name LIMIT 2000").catch(() => []))
    .map(g => ({id: g.Id, name: g.Name || g.DeveloperName}));
}

// ── Backup (in the sandbox) ───────────────────────────────────────────
// Objects worth offering for a data backup: custom objects + common ones.
export async function backupCandidates(conn) {
  const res = await rest(conn, `/services/data/v${apiVersion}/sobjects/`);
  const COMMON = new Set(["Account", "Contact", "Opportunity", "Case", "Lead", "Product2", "Pricebook2", "PricebookEntry", "Campaign", "Contract", "Order"]);
  return (res.sobjects || []).filter(o => o.queryable && o.createable && (o.custom ? /__c$/.test(o.name) : COMMON.has(o.name)))
    .map(o => ({name: o.name, label: o.label, custom: o.custom})).sort((a, b) => (b.custom - a.custom) || a.label.localeCompare(b.label));
}

async function describe(conn, object) {
  return rest(conn, `/services/data/v${apiVersion}/sobjects/${encodeURIComponent(object)}/describe`);
}

// Createable fields and the lookups among them (for the restore).
function restorable(d) {
  const fields = (d.fields || []).filter(f => f.createable && !f.calculated && !f.autoNumber && f.type !== "base64" && f.name !== "Id");
  return {
    fields: ["Id", ...fields.map(f => f.name)],
    refs: fields.filter(f => f.type === "reference" && (f.referenceTo || []).length).map(f => ({field: f.name, to: f.referenceTo})),
  };
}

async function bulkExport(conn, soqlText, {signal, onTick} = {}) {
  const client = conn.client;
  const job = await ffBulkQueryCreate(soqlText, {signal, client});
  const done = await ffBulkPoll((id, o) => ffBulkQueryStatus(id, {...o, client}), job.id, {signal, terminal: ["JobComplete", "Failed", "Aborted"], onTick});
  if (done.state !== "JobComplete") throw new Error(done.errorMessage || `The export job ended as ${done.state}`);
  const chunks = [];
  let locator = null;
  do {
    const r = await ffBulkQueryResults(job.id, locator, {signal, client});
    chunks.push(r.csv);
    locator = r.locator && r.locator !== "null" ? r.locator : null;
  } while (locator);
  return mergeCsvChunks(chunks);
}

// org: a SandShift org (the sandbox). → saved backup row.
export async function backupSandbox(org, {sandboxName, objects = [], metadata = true, presets = ["apex", "ui", "flows", "objects", "security"], onStatus = () => {}, signal} = {}) {
  let snapshotId = null;
  let metaCount = 0;
  if (metadata) {
    onStatus("Listing metadata…");
    await loadCatalog(org.conn);
    const list = await listComponents(org.conn, presetTypes(presets), {onProgress: (n, of) => onStatus(`Listing metadata… ${n}/${of}`)});
    const keys = [...list.keys()].filter(keepObject);
    const {files} = keys.length ? await retrieveAll(org.conn, keys, org.name, s => onStatus(s), {signal}) : {files: new Map()};
    const snap = await saveSnapshot({orgHost: org.host, orgName: org.name, kind: "pre-refresh", label: `Before refresh · ${sandboxName || org.name}`,
      keys, missing: [], types: presetTypes(presets)}, files);
    snapshotId = snap.id;
    metaCount = keys.length;
  }
  const data = [];
  for (const object of objects) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    onStatus(`Backing up ${object} records…`);
    const d = await describe(org.conn, object);
    const {fields, refs} = restorable(d);
    const csv = await bulkExport(org.conn, `SELECT ${fields.join(", ")} FROM ${object}`, {signal,
      onTick: j => onStatus(`Backing up ${object}… ${j.numberRecordsProcessed || 0} records`)});
    const rows = parseCsv(csv).records.length;
    const blobId = `bakdata-${Date.now().toString(36)}-${object}`;
    await saveBytes(blobId, textToBytes(csv));
    data.push({object, label: d.label || object, rows, blobId, fields, refs, bytes: csv.length});
  }
  const size = data.reduce((s, x) => s + x.bytes, 0);
  return saveBackup({sandbox: sandboxName || org.name, orgId: org.orgId || "", orgHost: org.host, orgName: org.name, snapshotId, metaCount, data, size});
}

// Rows of a backed-up object (header row → objects).
export async function backupRows(item) {
  const bytes = await loadBytes(item.blobId);
  if (!bytes) throw new Error(`The ${item.object} backup is missing from this browser.`);
  const parsed = parseCsv(bytesToText(bytes));
  if (parsed.parseError) throw new Error(`The ${item.object} backup can't be read: ${parsed.parseError}`);
  return parsed.records;
}

// Data restore: parents first, new ids remapped into later lookups.
// → [{object, inserted, failed, errors: [{row, message}]}]
export async function restoreData(org, backup, {objects, maxRows = 50000, onStatus = () => {}, signal} = {}) {
  if (!backupMatchesOrg(backup, org)) throw new Error(`This backup was taken from ${backup.orgName || backup.orgHost || "another org"}, not ${org.host}: it can only be restored there.`);
  const items = backup.data.filter(d => !objects || objects.includes(d.object));
  const order = restoreOrder(items.map(d => ({name: d.object, refs: d.refs})));
  const idMap = new Map();
  const out = [];
  for (const name of order) {
    const item = items.find(d => d.object === name);
    const rows = (await backupRows(item)).slice(0, maxRows);
    const recs = rows.map(r => restoreRecord(r, {fields: item.fields.filter(f => f !== "Id"), refs: item.refs, idMap}));
    let inserted = 0;
    const errors = [];
    for (let i = 0; i < recs.length; i += 200) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      onStatus(`Restoring ${name}… ${Math.min(i + 200, recs.length)} of ${recs.length}`);
      const part = recs.slice(i, i + 200).map(r => ({attributes: {type: name}, ...r}));
      const res = await rest(org.conn, `/services/data/v${apiVersion}/composite/sobjects`, {method: "POST", body: {allOrNone: false, records: part}});
      const list = Array.isArray(res) ? res : [];
      addIds(idMap, rows.slice(i, i + 200), list);
      list.forEach((r, j) => {
        if (r && r.success) inserted++;
        else errors.push({row: i + j + 2, message: ((r && r.errors) || []).map(e => e.message).join("; ") || "failed"});
      });
    }
    out.push({object: name, inserted, failed: errors.length, errors, capped: rows.length < item.rows});
  }
  return out;
}

// ── Post-refresh checks (in the sandbox) ──────────────────────────────
// Email deliverability can't be read or set by API: reserving capacity
// fails when the sandbox may not send email (no email is sent).
export async function checkDeliverability(org) {
  try {
    await executeAnonymous(org.conn, "Messaging.reserveSingleEmailCapacity(1);");
    return {ok: true, text: "This sandbox can send email: deliverability is set to All email."};
  } catch (e) {
    return {ok: false, text: /NO_MASS_MAIL_PERMISSION|not permitted|disabled|deliverability|limit/i.test(e.message || "")
      ? "Email is switched off here (\"System email only\" or \"No access\"). That is safe; open Deliverability to change it."
      : `Could not tell: ${e.message}`};
  }
}

export async function invalidEmailUsers(org) {
  const rows = await soql(org.conn, "SELECT Id, Name, Username, Email, Profile.Name, UserType FROM User " +
    "WHERE IsActive = true AND Email LIKE '%.invalid' ORDER BY Name LIMIT 2000");
  return rows.filter(u => isInvalidEmail(u.Email)).map(u => ({id: u.Id, name: u.Name, username: u.Username, email: u.Email,
    fixed: stripInvalid(u.Email), profile: (u.Profile && u.Profile.Name) || "", type: u.UserType}));
}
export async function fixInvalidEmails(org, users) {
  const recs = users.map(u => ({attributes: {type: "User"}, Id: u.id, Email: stripInvalid(u.email)}));
  const out = [];
  for (let i = 0; i < recs.length; i += 200) {
    const res = await rest(org.conn, `/services/data/v${apiVersion}/composite/sobjects`, {method: "PATCH", body: {allOrNone: false, records: recs.slice(i, i + 200)}});
    out.push(...(Array.isArray(res) ? res : []));
  }
  return {ok: out.filter(r => r.success).length, failed: out.filter(r => !r.success).map(r => ((r.errors || [])[0] || {}).message || "failed")};
}

export async function scheduledJobs(org) {
  const rows = await soql(org.conn, "SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, CronExpression, NextFireTime, State FROM CronTrigger " +
    "WHERE State NOT IN ('DELETED', 'COMPLETE') ORDER BY NextFireTime LIMIT 500");
  const TYPES = {1: "Data export", 3: "Dashboard refresh", 4: "Reporting snapshot", 6: "Scheduled flow", 7: "Scheduled Apex", 8: "Report run", 9: "Batch job", A: "Report notification"};
  return rows.map(c => ({id: c.Id, name: (c.CronJobDetail && c.CronJobDetail.Name) || c.Id,
    type: TYPES[(c.CronJobDetail && c.CronJobDetail.JobType) || ""] || (c.CronJobDetail && c.CronJobDetail.JobType) || "",
    cron: c.CronExpression, next: c.NextFireTime, state: c.State}));
}
export async function abortJobs(org, ids) {
  const log = [];
  for (const id of ids) {
    try { await executeAnonymous(org.conn, `System.abortJob('${escapeSoqlString(id)}');`); log.push({id, ok: true}); }
    catch (e) { log.push({id, ok: false, message: e.message}); }
  }
  return log;
}

export async function outsideFlows(org) {
  const defs = (await tooling(org.conn, "SELECT Id, DeveloperName, MasterLabel, ActiveVersionId FROM FlowDefinition WHERE NamespacePrefix = null"))
    .filter(d => d.ActiveVersionId).slice(0, 150);
  const out = [];
  for (const d of defs) {
    const meta = ((await tooling(org.conn, `SELECT Metadata FROM Flow WHERE Id = '${escapeSoqlString(d.ActiveVersionId)}'`).catch(() => []))[0] || {}).Metadata;
    const reasons = flowOutsideReasons(meta);
    if (reasons.length) out.push({name: d.DeveloperName, label: d.MasterLabel, reasons});
  }
  return out;
}
export const deactivate = (org, names) => deactivateFlows({target: org, targets: names});

export async function endpoints(org, prodHost) {
  const [named, remote] = await Promise.all([
    tooling(org.conn, "SELECT Id, DeveloperName, MasterLabel, Endpoint FROM NamedCredential").catch(() => []),
    tooling(org.conn, "SELECT Id, SiteName, EndpointUrl, IsActive FROM RemoteProxy").catch(() => []),
  ]);
  return [
    ...named.map(n => ({kind: "Named credential", name: n.MasterLabel || n.DeveloperName, url: n.Endpoint || "", setup: "/lightning/setup/NamedCredential/home"})),
    ...remote.map(r => ({kind: "Remote site", name: r.SiteName, url: r.EndpointUrl || "", setup: "/lightning/setup/SecurityRemoteProxy/home"})),
  ].map(x => ({...x, looks: endpointKind(x.url, {prodHost})}));
}

// Custom setting values that contain the production domain.
export async function prodUrlSettings(org, prodHost) {
  const res = await rest(org.conn, `/services/data/v${apiVersion}/sobjects/`);
  const settings = (res.sobjects || []).filter(o => o.customSetting && /__c$/.test(o.name)).slice(0, 40);
  const host = String(prodHost || "").toLowerCase();
  const dom = host.split(".")[0];
  const out = [];
  for (const s of settings) {
    const d = await describe(org.conn, s.name).catch(() => null);
    if (!d) continue;
    const textFields = d.fields.filter(f => ["string", "url", "textarea"].includes(f.type) && f.updateable).map(f => f.name);
    if (!textFields.length) continue;
    const rows = await soql(org.conn, `SELECT Id, Name, ${textFields.join(", ")} FROM ${s.name} LIMIT 200`).catch(() => []);
    for (const r of rows) {
      for (const f of textFields) {
        const v = String(r[f] || "");
        if (v && dom && v.toLowerCase().includes(dom) && !/--|sandbox/i.test(v)) out.push({object: s.name, label: s.label, id: r.Id, name: r.Name, field: f, value: v});
      }
    }
  }
  return out;
}
export async function replaceSettingValues(org, items, sandboxHost, prodHost) {
  const log = [];
  for (const it of items) {
    const value = it.value.split(prodHost).join(sandboxHost);
    try {
      await rest(org.conn, `/services/data/v${apiVersion}/sobjects/${it.object}/${it.id}`, {method: "PATCH", body: {[it.field]: value}});
      log.push({...it, ok: true, value});
    } catch (e) { log.push({...it, ok: false, message: e.message}); }
  }
  return log;
}

// Freeze active users who are not in a public group (keep the project team).
export async function usersOutsideGroup(org, groupId) {
  const members = groupId ? await soql(org.conn, `SELECT UserOrGroupId FROM GroupMember WHERE GroupId = '${escapeSoqlString(groupId)}'`) : [];
  const keep = new Set(members.map(m => m.UserOrGroupId));
  const users = await soql(org.conn, "SELECT Id, Name, Username, Profile.Name FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT 2000");
  return users.filter(u => !keep.has(u.Id)).map(u => ({id: u.Id, name: u.Name, username: u.Username, profile: (u.Profile && u.Profile.Name) || ""}));
}
export async function freezeUsers(org, userIds) {
  const logins = [];
  for (let i = 0; i < userIds.length; i += 200) {
    logins.push(...await soql(org.conn, `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN (${idList(userIds.slice(i, i + 200))})`));
  }
  const recs = logins.filter(l => !l.IsFrozen).map(l => ({attributes: {type: "UserLogin"}, Id: l.Id, IsFrozen: true}));
  let ok = 0;
  for (let i = 0; i < recs.length; i += 200) {
    const res = await rest(org.conn, `/services/data/v${apiVersion}/composite/sobjects`, {method: "PATCH", body: {allOrNone: false, records: recs.slice(i, i + 200)}});
    ok += (Array.isArray(res) ? res : []).filter(r => r.success).length;
  }
  return {frozen: ok, already: logins.length - recs.length};
}
