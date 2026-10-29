// Edit EXISTING metadata: load it into an edit draft and save the changes
// back. Apex classes, triggers and Visualforce pages go through a
// MetadataContainer (compiled by Salesforce, like the Developer Console);
// LWC and Aura files are updated one by one. Apex can only be saved this
// way in sandboxes and developer orgs.
import {sfConn, apiVersion} from "../../inspector.js";
import {escapeSoqlString} from "../../core/soql.js";
import {
  editDraftFromSource, changedFiles, newApexClasses, readCompileResult, containerName, auraPath, CONTAINER_MEMBER
} from "../../core/edit-draft.js";
import {queryAll} from "./query.js";

const tooling = {tooling: true};
const path = (type, id) => `/services/data/v${apiVersion}/tooling/sobjects/${type}/${id ? encodeURIComponent(id) : ""}`;
const byId = (what, id) => `SELECT ${what} WHERE Id = '${escapeSoqlString(id)}'`;

async function create(type, body) {
  const res = await sfConn.rest(path(type), {method: "POST", useCache: false, body});
  if (!res || !res.id) throw new Error(`Salesforce did not return an id for the new ${type}.`);
  return res.id;
}

const update = (type, id, body) => sfConn.rest(path(type, id), {method: "PATCH", useCache: false, body});

async function removeQuietly(type, id) {
  try { await sfConn.rest(path(type, id), {method: "DELETE", useCache: false}); } catch (e) { /* best effort */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function friendly(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/production|active organization|not allowed in this org|Cannot modify.*(managed|production)/i.test(msg)) {
    return msg + " — Apex classes and triggers can only be changed this way in sandboxes and developer orgs.";
  }
  return msg;
}

// Load one component from the org as an edit draft.
async function loadEditDraft(kind, row) {
  if (row.NamespacePrefix) throw new Error("Components from managed packages cannot be edited.");
  const id = escapeSoqlString(row.Id);
  if (kind === "apex" || kind === "triggers" || kind === "pages") {
    const type = kind === "apex" ? "ApexClass" : kind === "triggers" ? "ApexTrigger" : "ApexPage";
    const field = kind === "pages" ? "Markup" : "Body";
    const rec = (await queryAll(byId(`Id, ${field}, LastModifiedDate FROM ${type}`, row.Id), tooling))[0];
    if (!rec) throw new Error("It no longer exists in the org.");
    const name = row.Name;
    const file = kind === "apex" ? `classes/${name}.cls` : kind === "triggers" ? `triggers/${name}.trigger` : `pages/${name}.page`;
    return editDraftFromSource(kind, {...row, LastModifiedDate: rec.LastModifiedDate || row.LastModifiedDate},
      [{path: file, content: rec[field] || ""}]);
  }
  if (kind === "lwc") {
    const res = await queryAll(`SELECT Id, FilePath, Format, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${id}'`, tooling);
    const order = p => ([".html", ".js", ".css", ".svg", ".js-meta.xml"].findIndex(e => p.endsWith(e)) + 1) || 9;
    const files = res.sort((a, b) => order(a.FilePath) - order(b.FilePath) || a.FilePath.localeCompare(b.FilePath)).map(r => ({
      path: r.FilePath, content: r.Source || "", resourceId: r.Id, format: r.Format,
      // Targets/exposure live in the bundle metadata; keep the XML read-only.
      readOnly: /\.js-meta\.xml$/.test(r.FilePath),
    }));
    return editDraftFromSource(kind, row, files);
  }
  if (kind === "aura") {
    const res = await queryAll(`SELECT Id, DefType, Format, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${id}'`, tooling);
    const files = res.map(r => ({path: auraPath(row.DeveloperName, r.DefType), content: r.Source || "", resourceId: r.Id,
      defType: r.DefType, format: r.Format}));
    return editDraftFromSource(kind, row, files);
  }
  throw new Error("This kind cannot be edited here.");
}

// When was it last changed in the org? (conflict check before saving)
async function orgLastModified(kind, draft) {
  const type = {apex: "ApexClass", triggers: "ApexTrigger", pages: "ApexPage", lwc: "LightningComponentBundle", aura: "AuraDefinitionBundle"}[kind];
  const rec = (await queryAll(byId(`LastModifiedDate FROM ${type}`, draft.existing.id), tooling))[0];
  return rec ? rec.LastModifiedDate : null;
}

// Apex class / trigger / page through a MetadataContainer. checkOnly
// compiles without saving. Throws with line-numbered compile errors.
async function saveViaContainer(draft, {checkOnly, onProgress}) {
  const main = changedFiles(draft).find(f => !newApexClasses(draft).includes(f));
  if (!main) return;
  const containerId = await create("MetadataContainer", {Name: containerName()});
  try {
    await create(CONTAINER_MEMBER[draft.kind], {MetadataContainerId: containerId, ContentEntityId: draft.existing.id, Body: main.content});
    const reqId = await create("ContainerAsyncRequest", {MetadataContainerId: containerId, IsCheckOnly: !!checkOnly});
    const started = Date.now();
    for (;;) {
      await sleep(1000);
      const req = await sfConn.rest(path("ContainerAsyncRequest", reqId), {useCache: false});
      const r = readCompileResult(req);
      if (r.done) {
        if (!r.ok) throw new Error((checkOnly ? "Compile check failed: " : "Salesforce rejected the save: ") + r.errors.join(" | "));
        return;
      }
      if (onProgress) onProgress(`Compiling… ${Math.round((Date.now() - started) / 1000)}s`);
      if (Date.now() - started > 120000) throw new Error("The save is still running after 2 minutes; check Setup → Apex Classes before trying again.");
    }
  } finally {
    await removeQuietly("MetadataContainer", containerId);
  }
}

// Save an edit draft. Options: checkOnly (Apex/trigger/page compile only),
// force (skip the "changed in the org since you opened it" check).
// Returns {saved: [paths]} or throws; a conflict throws error.code "CONFLICT".
async function saveEditDraft(draft, {checkOnly = false, force = false, onProgress} = {}) {
  const changed = changedFiles(draft);
  if (!changed.length) throw new Error("Nothing changed yet.");
  try {
    if (!force && !checkOnly && draft.existing.lastModified) {
      const now = await orgLastModified(draft.kind, draft);
      if (now && now !== draft.existing.lastModified) {
        const err = new Error(`${draft.name} was changed in the org after you opened it (${now}). Saving would overwrite those changes.`);
        err.code = "CONFLICT";
        throw err;
      }
    }
    const ver = Number((draft.form || {}).apiVersion) || Number(apiVersion);
    // Classes the AI added (controllers, handlers) are created first.
    if (!checkOnly) {
      for (const f of newApexClasses(draft)) {
        await create("ApexClass", {Name: f.path.replace(/^classes\/|\.cls$/g, ""), Body: f.content, ApiVersion: ver});
      }
    }
    if (CONTAINER_MEMBER[draft.kind]) {
      await saveViaContainer(draft, {checkOnly, onProgress});
    } else if (!checkOnly) {
      const bundleId = draft.existing.id;
      for (const f of changed.filter(x => !newApexClasses(draft).includes(x))) {
        if (draft.kind === "lwc") {
          if (f.resourceId) await update("LightningComponentResource", f.resourceId, {Source: f.content});
          else await create("LightningComponentResource", {LightningComponentBundleId: bundleId, FilePath: f.path,
            Format: f.format || f.path.split(".").pop(), Source: f.content});
        } else {
          if (f.resourceId) await update("AuraDefinition", f.resourceId, {Source: f.content});
          else await create("AuraDefinition", {AuraDefinitionBundleId: bundleId, DefType: f.defType, Format: f.format, Source: f.content});
        }
      }
    }
    return {saved: changed.map(f => f.path)};
  } catch (e) {
    if (e.code === "CONFLICT") throw e;
    throw new Error(friendly(e));
  }
}

export {loadEditDraft, saveEditDraft};
