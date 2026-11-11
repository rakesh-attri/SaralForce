// Create new metadata through the Tooling API from a Metadata-tab draft.
// Bundles (LWC, Aura) are created in two steps; when a later step fails the
// half-created bundle is deleted again so nothing is left behind.
import {sfConn, apiVersion} from "../../inspector.js";
import {cmdtTypeXml} from "../../core/cmdt.js";
import {bundleCreateOrder} from "../../core/bundle-order.js";
import {soapCreate} from "./cmdt-data.js";
import {draftPackage, draftTestOptions, compileErrorText, PACKAGE_KINDS} from "../../core/draft-package.js";
import {lintFiles, lintText} from "../../core/apex-lint.js";
import {currentOrgConn, startDeploy, waitForDeploy} from "./deploy-api.js";

let sandboxCache = null;
async function isSandboxOrg() {
  if (sandboxCache != null) return sandboxCache;
  try {
    const r = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=${encodeURIComponent("SELECT IsSandbox FROM Organization")}`, {useCache: false});
    sandboxCache = !!(r.records && r.records[0] && r.records[0].IsSandbox);
  } catch (e) { sandboxCache = false; }
  return sandboxCache;
}

const ID_QUERY = {
  ApexClass: n => `SELECT Id FROM ApexClass WHERE Name = '${n}' AND NamespacePrefix = null`,
  ApexTrigger: n => `SELECT Id FROM ApexTrigger WHERE Name = '${n}' AND NamespacePrefix = null`,
  ApexPage: n => `SELECT Id FROM ApexPage WHERE Name = '${n}' AND NamespacePrefix = null`,
  LightningComponentBundle: n => `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${n}' AND NamespacePrefix = null`,
  AuraDefinitionBundle: n => `SELECT Id FROM AuraDefinitionBundle WHERE DeveloperName = '${n}' AND NamespacePrefix = null`
};

const TYPE_LABEL = {ApexClass: "Apex class", ApexTrigger: "Apex trigger", ApexPage: "Visualforce page",
  LightningComponentBundle: "Lightning web component", AuraDefinitionBundle: "Aura component"};

// A Metadata API deploy replaces a component that has the same name. A "new"
// draft must never do that silently, so look the names up first.
async function existingMembers(members) {
  const taken = [];
  for (const [type, names] of Object.entries(members || {})) {
    if (!ID_QUERY[type]) continue;
    for (const name of names) {
      const r = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(ID_QUERY[type](name))}`, {useCache: false});
      if (r.records && r.records.length) taken.push({type, name});
    }
  }
  return taken;
}

// Apex, triggers, Visualforce, LWC and Aura go as ONE Metadata API package:
// Salesforce compiles every file together and saves all of them or none.
// checkOnly = compile (and in production run the draft's tests) without saving.
async function deployDraftPackage(draft, {checkOnly = false, onProgress = () => {}, skipLint = false} = {}) {
  // 1. Known mistakes, caught without a round trip (skipLint: "check anyway").
  const lint = skipLint ? [] : lintFiles(draft.files, {apiVersion: (draft.form || {}).apiVersion || apiVersion});
  if (lint.length) {
    const err = new Error(lintText(lint));
    err.code = "LINT";
    throw err;
  }
  // 2. Compile (and deploy) the whole draft at once.
  const pkg = draftPackage(draft, apiVersion);
  if (!checkOnly && draft.mode !== "edit") {
    onProgress("Checking names…");
    const taken = await existingMembers(pkg.members);
    if (taken.length) {
      const err = new Error(`Already in this org: ${taken.map(t => `${t.name} (${TYPE_LABEL[t.type] || t.type})`).join(", ")}. ` +
        "Deploying would replace it. Rename the new component, or open the existing one from the list to edit it.");
      err.code = "EXISTS";
      throw err;
    }
  }
  const isSandbox = await isSandboxOrg();
  const opts = draftTestOptions({isSandbox, hasApex: !!(pkg.members.ApexClass || pkg.members.ApexTrigger), tests: pkg.tests});
  onProgress(checkOnly ? "Compiling…" : "Deploying…");
  const conn = currentOrgConn();
  const id = await startDeploy(conn, pkg.entries, {checkOnly, ...opts});
  const summary = await waitForDeploy(conn, id, {onUpdate: x => onProgress(`${checkOnly ? "Compiling" : "Deploying"}… ${x.stateDetail || x.status}` +
    (x.tests.total ? ` · tests ${x.tests.completed}/${x.tests.total}` : ""))});
  if (!summary.success) {
    const err = new Error(compileErrorText(summary, draft));
    err.code = "COMPILE";
    err.summary = summary;
    throw err;
  }
  if (checkOnly) return {checked: true, name: draft.name, tests: opts.testLevel};
  let newId = "";
  try {
    const r = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=${encodeURIComponent(ID_QUERY[pkg.main.type](draft.name))}`, {useCache: false});
    newId = r.records && r.records[0] ? r.records[0].Id : "";
  } catch (e) { /* the list refresh finds it anyway */ }
  return {type: pkg.main.type, name: draft.name, id: newId};
}

const toolingPath = (type, id) => `/services/data/v${apiVersion}/tooling/sobjects/${type}/${id ? encodeURIComponent(id) : ""}`;

async function create(type, body) {
  const res = await sfConn.rest(toolingPath(type), {method: "POST", useCache: false, body});
  if (!res || !res.id) throw new Error(`Salesforce did not return an id for the new ${type}.`);
  return res.id;
}

async function remove(type, id) {
  try { await sfConn.rest(toolingPath(type, id), {method: "DELETE", useCache: false}); }
  catch (e) { /* best effort rollback */ }
}

// Salesforce versions available in this org, newest first ("68.0", …).
async function orgApiVersions() {
  try {
    const res = await sfConn.rest("/services/data/", {useCache: false});
    const list = (Array.isArray(res) ? res : []).map(v => v.version).filter(Boolean);
    if (list.length) return list.sort((a, b) => parseFloat(b) - parseFloat(a)).slice(0, 8);
  } catch (e) { /* fall back to the extension's version */ }
  return [apiVersion];
}

function friendly(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/production|active organization|not allowed in this org/i.test(msg)) {
    return msg + " — Apex and some metadata can only be created in sandboxes and developer orgs; deploy to production with a change set or the Metadata API.";
  }
  return msg;
}

const body = (draft, path) => {
  const f = draft.files.find(x => x.path === path) || draft.files[0];
  return f ? f.content : "";
};

// Apex classes a bundle template imports (controller + test) must exist
// before the bundle saves, so they go first.
async function createApexHelpers(draft, ver, roles = ["apex"]) {
  for (const file of draft.files.filter(x => roles.includes(x.role))) {
    await create("ApexClass", {Name: file.name, Body: file.content, ApiVersion: ver});
  }
}

// Extra classes created after the main one (e.g. an AI-written test class).
// The main class already exists then, so say which extra failed.
async function createExtras(draft, ver) {
  for (const file of draft.files.filter(x => x.role === "extra")) {
    try { await create("ApexClass", {Name: file.name, Body: file.content, ApiVersion: ver}); }
    catch (e) { throw new Error(`${draft.name} was created, but ${file.name} failed: ${e.message}`); }
  }
}

// Deploy one draft. Returns {type, id, name} of the main component.
async function deployDraft(draft, opts = {}) {
  if (PACKAGE_KINDS.includes(draft.kind)) return deployDraftPackage(draft, opts);
  const f = draft.form || {};
  const ver = Number(f.apiVersion) || Number(apiVersion);
  try {
    switch (draft.kind) {
    case "apex": {
      const id = await create("ApexClass", {Name: draft.name, Body: body(draft, `classes/${draft.name}.cls`), ApiVersion: ver});
      await createExtras(draft, ver);
      return {type: "ApexClass", name: draft.name, id};
    }
    case "triggers": {
      // Handler classes (template or AI) must exist before the trigger.
      await createApexHelpers(draft, ver, ["handler", "apex"]);
      return {type: "ApexTrigger", name: draft.name,
        id: await create("ApexTrigger", {Name: draft.name, TableEnumOrId: f.object,
          Body: body(draft, `triggers/${draft.name}.trigger`), ApiVersion: ver})};
    }
    case "pages":
      await createApexHelpers(draft, ver);
      return {type: "ApexPage", name: draft.name,
        id: await create("ApexPage", {Name: draft.name, MasterLabel: f.label || draft.name,
          Markup: body(draft, `pages/${draft.name}.page`), ApiVersion: ver})};
    case "lwc": {
      await createApexHelpers(draft, ver);
      const meta = {apiVersion: ver, isExposed: !!f.exposed, masterLabel: f.label || draft.name};
      if (f.description) meta.description = f.description;
      if (f.exposed && f.targets && f.targets.length) meta.targets = {target: f.targets};
      const id = await create("LightningComponentBundle", {FullName: draft.name, Metadata: meta});
      try {
        // The component's own .js (its base file) must be created first.
        for (const file of bundleCreateOrder(draft.files.filter(x => !x.generated && x.role !== "apex"), "lwc", draft.name)) {
          await create("LightningComponentResource", {LightningComponentBundleId: id, FilePath: file.path, Format: file.format, Source: file.content});
        }
      } catch (e) {
        await remove("LightningComponentBundle", id);
        throw e;
      }
      return {type: "LightningComponentBundle", name: draft.name, id};
    }
    case "aura": {
      await createApexHelpers(draft, ver);
      const id = await create("AuraDefinitionBundle", {DeveloperName: draft.name, MasterLabel: f.label || draft.name,
        Description: f.description || "", ApiVersion: ver});
      try {
        // The .cmp / .app (base definition) must be created first.
        for (const file of bundleCreateOrder(draft.files.filter(x => x.role !== "apex"), "aura", draft.name)) {
          await create("AuraDefinition", {AuraDefinitionBundleId: id, DefType: file.defType, Format: file.format, Source: file.content});
        }
      } catch (e) {
        await remove("AuraDefinitionBundle", id);
        throw e;
      }
      return {type: "AuraDefinitionBundle", name: draft.name, id};
    }
    case "flows": {
      let meta;
      try { meta = JSON.parse(body(draft)); } catch (e) { throw new Error("The flow metadata is not valid JSON: " + e.message); }
      return {type: "Flow", name: draft.name, id: await create("Flow", {FullName: draft.name, Metadata: meta})};
    }
    case "rules": {
      let meta;
      try { meta = JSON.parse(body(draft)); } catch (e) { throw new Error("The rule metadata is not valid JSON: " + e.message); }
      return {type: "ValidationRule", name: `${f.object}.${draft.name}`,
        id: await create("ValidationRule", {FullName: `${f.object}.${draft.name}`, Metadata: meta})};
    }
    case "cmdt": {
      let def;
      try { def = JSON.parse(body(draft)); } catch (e) { throw new Error("The type definition is not valid JSON: " + e.message); }
      const r = await soapCreate(cmdtTypeXml(def));
      return {type: "CustomObject", name: r.fullName || `${def.name}__mdt`, id: `${def.name}__mdt`};
    }
    default:
      throw new Error("Unknown metadata kind: " + draft.kind);
    }
  } catch (e) {
    throw new Error(friendly(e));
  }
}

export {deployDraft, orgApiVersions, PACKAGE_KINDS};
