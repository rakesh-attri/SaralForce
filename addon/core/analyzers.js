// Pre-deploy problem analyzers (Gearset-style): things that make a deploy
// fail or do harm, found before anything is sent. Pure.
//
// plan = {members: {type: [names]}, destructive: {type: [names]},
//         texts: [{key, text}], statuses?: Map(key → "new"|"changed")}
// ctx  = {targetApi?: number (max API version of the target), isProd?: bool}
// → [{kind: "err"|"warn"|"info", id, text}]
import {splitKey, keysFromMembers} from "./deploy.js";

const MAX_FILES = 10000;
const MAX_ZIP_BYTES = 39 * 1024 * 1024; // the API limit is 39 MB of base64

function stripComments(code) {
  return String(code || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// Lines of SOQL / DML inside for / while / do loops (brace-tracked).
export function apexLoopIssues(code) {
  const src = stripComments(code);
  const out = [];
  const lines = src.split("\n");
  const loopDepths = [];
  let depth = 0;
  let pendingLoop = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInLoop = loopDepths.length > 0 || pendingLoop;
    // The loop header itself (for (X x : [SELECT …])) is a SOQL for-loop, the
    // right pattern: only what follows the header's closing paren is body.
    let body = line;
    const head = /\b(for|while)\s*\(/.exec(line);
    if (head) {
      let depthP = 0;
      let end = -1;
      for (let j = head.index + head[0].length - 1; j < line.length; j++) {
        if (line[j] === "(") depthP++;
        else if (line[j] === ")" && --depthP === 0) { end = j; break; }
      }
      body = wasInLoop ? line : (end >= 0 ? line.slice(end + 1) : "");
      pendingLoop = true;
    } else if (/\bdo\s*\{/.test(line)) pendingLoop = true;
    if (wasInLoop || head || pendingLoop) {
      if (/\[\s*SELECT\b/i.test(body) || /\bDatabase\.query\s*\(/.test(body)) out.push({line: i + 1, kind: "soql"});
      if (/(^|[;{]\s*)(insert|update|upsert|delete|undelete|merge)\s+[\w.(]/i.test(body.trim()) || /\bDatabase\.(insert|update|upsert|delete)\s*\(/.test(body)) out.push({line: i + 1, kind: "dml"});
    }
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        if (pendingLoop) { loopDepths.push(depth); pendingLoop = false; }
      } else if (ch === "}") {
        if (loopDepths.length && loopDepths[loopDepths.length - 1] === depth) loopDepths.pop();
        depth--;
      }
    }
    // A loop body without braces covers just the next statement.
    if (pendingLoop && /;\s*$/.test(line)) pendingLoop = false;
  }
  return out;
}

// 15/18-character Salesforce record Ids written in code (break across orgs).
export function hardcodedIds(code) {
  const src = String(code || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const ids = new Set();
  for (const m of src.matchAll(/'([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})'/g)) {
    const id = m[1];
    if (/^(00[0-9A-Za-z]|01[0-9A-Za-z]|0[A-Z][0-9A-Za-z]|a0[0-9A-Za-z])/.test(id) && /\d/.test(id) && /[A-Za-z]/.test(id.slice(3))) ids.add(id);
  }
  return [...ids];
}

function apiVersionOf(text) {
  const m = /<apiVersion>\s*(\d+(?:\.\d+)?)\s*<\/apiVersion>/.exec(text || "");
  return m ? Number(m[1]) : null;
}

function isTestClass(text) {
  return /@isTest\b/i.test(text || "") || /\btestMethod\b/i.test(text || "");
}

export function analyzePlan(plan, ctx = {}) {
  const out = [];
  const keys = keysFromMembers(plan.members || {});
  const dels = keysFromMembers(plan.destructive || {});
  const texts = new Map((plan.texts || []).map(t => [t.key, t.text || ""]));
  const statuses = plan.statuses || new Map();
  const ofType = (list, type) => list.filter(k => splitKey(k).type === type).map(k => splitKey(k).fullName);

  // API version newer than the target supports.
  if (ctx.targetApi) {
    const tooNew = [];
    for (const [key, text] of texts) {
      const v = apiVersionOf(text);
      if (v && v > ctx.targetApi) tooNew.push(`${splitKey(key).fullName} (${v})`);
    }
    if (tooNew.length) out.push({kind: "err", id: "api-version", text: `The target supports API ${ctx.targetApi.toFixed(1)} at most, but ${tooNew.slice(0, 5).join(", ")}${tooNew.length > 5 ? "…" : ""} use a newer version. Lower their API version in the source, or upgrade the target sandbox first.`});
  }

  // New fields nobody can see.
  const newFields = ofType(keys, "CustomField").filter(n => statuses.get("CustomField:" + n) === "new");
  const grantsAccess = keys.some(k => /^(PermissionSet|Profile|PermissionSetGroup):/.test(k));
  if (newFields.length && !grantsAccess) {
    out.push({kind: "warn", id: "fls", text: `${newFields.length} new field(s) (${newFields.slice(0, 3).join(", ")}${newFields.length > 3 ? "…" : ""}) arrive with no field access for anyone. Add the permission set that grants it, or grant access after the deploy.`});
  }

  // Deletes that Salesforce refuses or that lose data.
  const delFlows = ofType(dels, "Flow");
  if (delFlows.length) out.push({kind: "warn", id: "flow-delete", text: `Deleting flow(s) ${delFlows.join(", ")}: an active flow can't be deleted; deactivate it in the target first. All its versions are removed.`});
  const delData = dels.filter(k => /^(CustomField|CustomObject):/.test(k));
  if (delData.length) out.push({kind: "warn", id: "data-loss", text: `Deleting ${delData.length} field(s)/object(s) also deletes their data, and a rollback can bring back the field but not the data. Export it first.`});
  const both = dels.filter(k => keys.includes(k));
  if (both.length) out.push({kind: "err", id: "deploy-and-delete", text: `${both.map(k => splitKey(k).fullName).join(", ")} are both deployed and deleted. Remove them from one list.`});

  // Apex: queries / DML in loops, hard-coded Ids, missing tests.
  const loopHits = [];
  const idHits = [];
  for (const [key, text] of texts) {
    const {type, fullName} = splitKey(key);
    if (type !== "ApexClass" && type !== "ApexTrigger") continue;
    const code = text.split(/\/\/ ── [^\n]*-meta\.xml ──/)[0];
    const loops = apexLoopIssues(code);
    if (loops.length) loopHits.push(`${fullName} line ${loops.slice(0, 3).map(l => l.line).join(", ")}`);
    const ids = hardcodedIds(code);
    if (ids.length) idHits.push(`${fullName} (${ids.slice(0, 2).join(", ")})`);
  }
  if (loopHits.length) out.push({kind: "warn", id: "apex-loops", text: `Query or DML inside a loop (hits governor limits with many records): ${loopHits.slice(0, 4).join("; ")}.`});
  if (idHits.length) out.push({kind: "warn", id: "hardcoded-ids", text: `Hard-coded record Ids (they differ between orgs): ${idHits.slice(0, 4).join("; ")}.`});
  const apexKeys = keys.filter(k => /^(ApexClass|ApexTrigger):/.test(k));
  if (apexKeys.length && texts.size) {
    const tests = apexKeys.filter(k => isTestClass(texts.get(k)));
    const code = apexKeys.filter(k => !isTestClass(texts.get(k)) && texts.has(k));
    if (code.length && !tests.length && ctx.isProd) {
      out.push({kind: "warn", id: "no-tests", text: "Apex is going to production with no test class in the package. Production needs 75% coverage of the changed code; include the tests that cover it."});
    }
  }

  // Field type changes (data conversion can fail; some changes are refused).
  const before = plan.before || new Map();
  const typeChanges = [];
  for (const k of keys.filter(x => x.startsWith("CustomField:"))) {
    const was = (/<type>([^<]+)<\/type>/.exec(before.get(k) || "") || [])[1];
    const now = (/<type>([^<]+)<\/type>/.exec(texts.get(k) || "") || [])[1];
    if (was && now && was !== now) typeChanges.push(`${splitKey(k).fullName} (${was} → ${now})`);
  }
  if (typeChanges.length) out.push({kind: "warn", id: "field-type", text: `Field type changes: ${typeChanges.slice(0, 4).join(", ")}. Existing data must convert; Salesforce refuses some changes (for example to or from formula, or when the field is used). Check in a sandbox first.`});

  // Profiles overwrite.
  const profiles = ofType(keys, "Profile");
  if (profiles.length) out.push({kind: "warn", id: "profiles", text: `${profiles.length} profile(s) included: only settings for components in this package are deployed, and they overwrite the target's. Prefer permission sets.`});

  return out;
}

// Size limits of a deploy zip, checked before it is sent.
export function sizeProblems(entries, zipBytes) {
  const out = [];
  if (entries.length > MAX_FILES) out.push({kind: "err", id: "too-many-files", text: `${entries.length} files: Salesforce accepts at most ${MAX_FILES} per deploy. Split the release.`});
  const b64 = Math.ceil(zipBytes / 3) * 4;
  if (b64 > MAX_ZIP_BYTES) out.push({kind: "err", id: "too-big", text: `The package is ${(b64 / 1048576).toFixed(1)} MB encoded: Salesforce accepts at most 39 MB. Split the release (static resources are often the cause).`});
  return out;
}

// Target components changed after a baseline time (someone else's work a
// deploy would overwrite). listed: Map(key → {lastModifiedDate, lastModifiedByName}).
export function overwriteRisks(keys, listed, sinceIso) {
  const since = Date.parse(sinceIso || "");
  if (!Number.isFinite(since)) return [];
  const out = [];
  for (const k of keys) {
    const r = listed.get(k);
    const at = r && Date.parse(r.lastModifiedDate || "");
    if (Number.isFinite(at) && at > since) out.push({key: k, fullName: splitKey(k).fullName, by: r.lastModifiedByName || "", at: r.lastModifiedDate});
  }
  return out;
}

// Permission sets / profiles in a compare that grant access to the selection
// (Gearset's "include permissions dependencies"). rows: compare rows.
export function permissionHolders(rows, selected) {
  const names = {fields: new Set(), objects: new Set(), classes: new Set(), tabs: new Set(), pages: new Set(), flows: new Set()};
  for (const k of selected) {
    const {type, fullName} = splitKey(k);
    if (type === "CustomField") names.fields.add(fullName);
    if (type === "CustomObject") names.objects.add(fullName);
    if (type === "ApexClass") names.classes.add(fullName);
    if (type === "CustomTab") names.tabs.add(fullName);
    if (type === "ApexPage") names.pages.add(fullName);
    if (type === "Flow") names.flows.add(fullName);
  }
  const out = [];
  for (const r of rows) {
    if (!/^(PermissionSet|Profile)$/.test(r.type) || selected.has(r.key) || r.status === "same" || r.status === "deleted") continue;
    const t = r.sourceText || "";
    const hit = [...t.matchAll(/<field>([^<]+)<\/field>/g)].some(m => names.fields.has(m[1])) ||
      [...t.matchAll(/<object>([^<]+)<\/object>/g)].some(m => names.objects.has(m[1])) ||
      [...t.matchAll(/<apexClass>([^<]+)<\/apexClass>/g)].some(m => names.classes.has(m[1])) ||
      [...t.matchAll(/<tab>([^<]+)<\/tab>/g)].some(m => names.tabs.has(m[1])) ||
      [...t.matchAll(/<apexPage>([^<]+)<\/apexPage>/g)].some(m => names.pages.has(m[1])) ||
      [...t.matchAll(/<flow>([^<]+)<\/flow>/g)].some(m => names.flows.has(m[1]));
    if (hit) out.push(r.key);
  }
  return out;
}
