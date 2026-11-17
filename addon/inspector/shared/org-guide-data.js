// Org Guide reads: every non-managed trigger, Apex class, active flow, LWC,
// Aura bundle and validation rule of this org, shaped for core/org-guide.js
// buildGuide(). Tooling API only, read-only. Flow and validation-rule
// Metadata can only be read one record at a time, so those go a few at a
// time with a cap; everything else is batched.
import {queryAll} from "./query.js";
import {ffGetObjects, ffDescribeObject} from "./describe.js";
import {escapeSoqlString} from "../../core/soql.js";

const MAX_FLOWS = 200;
const MAX_RULES = 40;
const MAX_DESCRIBES = 30;
const COMMON_OBJECTS = ["Account", "Contact", "Opportunity", "Case", "Lead"];

const tooling = soql => queryAll(soql, {tooling: true});
const idList = ids => ids.map(id => `'${escapeSoqlString(id)}'`).join(",");
const stop = signal => { if (signal && signal.aborted) throw new Error("Cancelled"); };

// fn over items, `limit` at a time.
async function pool(items, limit, fn, signal) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      stop(signal);
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

async function inChunks(ids, size, query) {
  const rows = [];
  for (let i = 0; i < ids.length; i += size) rows.push(...await query(idList(ids.slice(i, i + size))));
  return rows;
}

function targetsFromMeta(xml) {
  return [...String(xml || "").matchAll(/<target>\s*([^<]+?)\s*<\/target>/g)].map(m => m[1]);
}

// scope: {kind: "area", object} | {kind: "org"}. → {items, notes}
export async function loadGuideData(scope, {onStatus = () => {}, signal} = {}) {
  const notes = [];
  const items = {objects: [], triggers: [], classes: [], flows: [], lwc: [], aura: [], rules: [], deps: []};

  onStatus("Reading Apex classes and triggers…");
  const [classes, triggers] = await Promise.all([
    tooling("SELECT Id, Name, ApiVersion, Body FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name"),
    tooling("SELECT Id, Name, TableEnumOrId, Status, Body FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name"),
  ]);
  stop(signal);
  items.classes = classes.filter(c => c.Body && c.Body !== "(hidden)").map(c => ({name: c.Name, body: c.Body}));
  items.triggers = triggers.filter(t => t.Status !== "Inactive" && t.Body).map(t => ({name: t.Name, object: t.TableEnumOrId, body: t.Body}));
  if (classes.truncated) notes.push(`Only the first ${classes.length} Apex classes were read.`);

  onStatus("Reading flows…");
  const defs = (await tooling("SELECT Id, DeveloperName, MasterLabel, ActiveVersionId, NamespacePrefix FROM FlowDefinition ORDER BY DeveloperName"))
    .filter(d => d.ActiveVersionId && !d.NamespacePrefix);
  stop(signal);
  if (defs.length > MAX_FLOWS) notes.push(`${defs.length} active flows: only the first ${MAX_FLOWS} were read.`);
  const flowDefs = defs.slice(0, MAX_FLOWS);
  let done = 0;
  const metas = await pool(flowDefs, 4, async d => {
    const r = await tooling(`SELECT Id, Metadata FROM Flow WHERE Id = '${escapeSoqlString(d.ActiveVersionId)}'`).catch(() => []);
    done++;
    if (done % 5 === 0 || done === flowDefs.length) onStatus(`Reading flows… ${done} of ${flowDefs.length}`);
    return (r[0] || {}).Metadata || null;
  }, signal);
  items.flows = flowDefs.map((d, i) => ({name: d.DeveloperName, label: d.MasterLabel, versionId: d.ActiveVersionId, meta: metas[i]})).filter(f => f.meta);

  onStatus("Reading Lightning components…");
  const [lwcBundles, auraBundles] = await Promise.all([
    tooling("SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM LightningComponentBundle ORDER BY DeveloperName").catch(() => []),
    tooling("SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM AuraDefinitionBundle ORDER BY DeveloperName").catch(() => []),
  ]);
  stop(signal);
  const lwcOwn = lwcBundles.filter(b => !b.NamespacePrefix);
  const lwcFiles = await inChunks(lwcOwn.map(b => b.Id), 50, ids =>
    tooling(`SELECT LightningComponentBundleId, FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId IN (${ids})`).catch(() => []));
  items.lwc = lwcOwn.map(b => {
    const files = lwcFiles.filter(f => f.LightningComponentBundleId === b.Id && /\.(js|js-meta\.xml)$/.test(f.FilePath || ""))
      .map(f => ({path: f.FilePath, source: f.Source || ""}));
    const metaXml = (files.find(f => /\.js-meta\.xml$/.test(f.path)) || {}).source || "";
    return {name: b.DeveloperName, label: b.MasterLabel, files: files.filter(f => !/\.js-meta\.xml$/.test(f.path)),
      meta: {masterLabel: b.MasterLabel, targets: {target: targetsFromMeta(metaXml)}}};
  });
  const auraOwn = auraBundles.filter(b => !b.NamespacePrefix);
  const auraDefs = await inChunks(auraOwn.map(b => b.Id), 50, ids =>
    tooling(`SELECT AuraDefinitionBundleId, DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundleId IN (${ids})`).catch(() => []));
  items.aura = auraOwn.map(b => ({name: b.DeveloperName, label: b.MasterLabel,
    defs: auraDefs.filter(d => d.AuraDefinitionBundleId === b.Id && /^(COMPONENT|APPLICATION|CONTROLLER)$/.test(d.DefType))
      .map(d => ({defType: d.DefType, source: d.Source || ""}))}));

  onStatus("Reading validation rules…");
  const rules = (await tooling("SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName, ErrorMessage, NamespacePrefix FROM ValidationRule").catch(() => []))
    .filter(r => !r.NamespacePrefix);
  stop(signal);
  const objOf = r => (r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || "";
  // Formulas only for the area's object (Metadata is one record per query).
  // The whole-org read (Handbook) takes active rules first: the life-of-a-record view places them by their formula.
  const want = scope.kind === "area"
    ? rules.filter(r => objOf(r).toLowerCase() === String(scope.object).toLowerCase()).slice(0, MAX_RULES)
    : rules.filter(r => r.Active !== false).slice(0, MAX_RULES * 2);
  const formulas = await pool(want, 4, r => tooling(`SELECT Id, Metadata FROM ValidationRule WHERE Id = '${escapeSoqlString(r.Id)}'`)
    .then(x => (x[0] || {}).Metadata || {}).catch(() => ({})), signal);
  const formulaOf = new Map(want.map((r, i) => [r.Id, formulas[i]]));
  items.rules = rules.map(r => ({name: r.ValidationName, object: objOf(r), active: r.Active !== false,
    formula: (formulaOf.get(r.Id) || {}).errorConditionFormula || "", message: r.ErrorMessage || ""}));

  onStatus("Reading objects…");
  const all = await ffGetObjects().catch(() => []);
  stop(signal);
  const label = new Map(all.map(o => [o.name.toLowerCase(), o.label]));
  const toDescribe = scope.kind === "area"
    ? [scope.object]
    : [...all.filter(o => o.custom && /__c$/.test(o.name)).map(o => o.name).slice(0, MAX_DESCRIBES), ...COMMON_OBJECTS.filter(o => label.has(o.toLowerCase()))];
  const described = await pool(toDescribe, 4, name => ffDescribeObject(name).catch(() => null), signal);
  // Lookups and master-detail to business objects (not owner / created-by / record type).
  const lookupsOf = d => (d.fields || []).filter(f => f.type === "reference" && Array.isArray(f.referenceTo))
    .flatMap(f => f.referenceTo.filter(t => !/^(User|Group|RecordType|Profile|Organization|BusinessHours)$/.test(t))
      .map(t => ({field: f.name, label: f.label, to: t, master: f.relationshipOrder != null || f.cascadeDelete === true})));
  const seenObj = new Set();
  described.forEach((d, i) => {
    if (!d) return;
    seenObj.add(toDescribe[i].toLowerCase());
    items.objects.push({name: d.name || toDescribe[i], label: d.label || toDescribe[i], lookups: lookupsOf(d)});
  });
  // Labels for every other object the guide may mention.
  for (const o of all) if (!seenObj.has(o.name.toLowerCase())) items.objects.push({name: o.name, label: o.label, lookups: [], labelOnly: true});

  onStatus("Reading Salesforce's dependency data…");
  items.deps = (await tooling("SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType " +
    "FROM MetadataComponentDependency WHERE RefMetadataComponentType IN ('ApexClass', 'Flow') LIMIT 2000").catch(() => []))
    .map(d => ({fromType: d.MetadataComponentType, from: d.MetadataComponentName, toType: d.RefMetadataComponentType, to: d.RefMetadataComponentName}));
  stop(signal);
  return {items, notes};
}

// ── Handbook extras: departments (apps → objects) and, for the busiest
// objects, their stage / status picklists and record types. Every read here
// is optional: a failure just leaves that part out.
const KEY_PICKLIST = /^(StageName|Status|Priority|Type|Origin|Rating|Industry|LeadSource)$|(Status|Stage|Priority|Type|Category)(__c)?$/i;

export async function loadHandbookExtras(objectNames, {onStatus = () => {}, signal} = {}) {
  const notes = [];
  onStatus("Reading apps…");
  let apps = [];
  try {
    const defs = await queryAll("SELECT DurableId, Label, DeveloperName, NavType, UiType, Description FROM AppDefinition ORDER BY Label");
    const tabs = await queryAll("SELECT DurableId, Name, Label, SobjectName FROM TabDefinition").catch(() => []);
    const tabBy = new Map();
    for (const t of tabs) { tabBy.set(t.DurableId, t); tabBy.set(t.Name, t); }
    let members = await queryAll("SELECT AppDefinitionId, TabDefinitionId, SortOrder FROM AppTabMember").catch(() => null);
    if (!members) {
      // Some orgs want AppTabMember filtered by app.
      members = [];
      for (const d of defs.slice(0, 40)) {
        stop(signal);
        members.push(...await queryAll(`SELECT AppDefinitionId, TabDefinitionId, SortOrder FROM AppTabMember WHERE AppDefinitionId = '${escapeSoqlString(d.DurableId)}'`).catch(() => []));
      }
    }
    apps = defs.map(d => ({
      name: d.DeveloperName, label: d.Label, description: d.Description || "",
      tabs: members.filter(m => m.AppDefinitionId === d.DurableId).sort((a, b) => (a.SortOrder || 0) - (b.SortOrder || 0))
        .map(m => tabBy.get(m.TabDefinitionId)).filter(Boolean).map(t => ({label: t.Label, object: t.SobjectName || ""})),
    }));
  } catch (e) {
    notes.push("Apps could not be read: " + e.message);
  }
  stop(signal);
  onStatus("Reading stages and record types…");
  const described = await pool(objectNames.slice(0, 12), 4, n => ffDescribeObject(n).catch(() => null), signal);
  const objectInfo = {};
  described.forEach((d, i) => {
    if (!d) return;
    const picks = (d.fields || []).filter(f => (f.type === "picklist" || f.type === "multipicklist") && KEY_PICKLIST.test(f.name))
      .map(f => ({name: f.name, label: f.label, values: (f.picklistValues || []).filter(v => v.active !== false).map(v => v.label || v.value)}))
      .filter(p => p.values.length);
    objectInfo[objectNames[i]] = {
      label: d.label, picklists: picks,
      recordTypes: (d.recordTypeInfos || []).filter(r => !r.master && r.active !== false).map(r => r.name),
    };
  });
  return {apps, objectInfo, notes};
}
