// Record navigator (Show All Data → Related / History): lookups to parent
// records, child relationship lists and the field-history timeline. Pure
// helpers so they can be unit-tested with `node --test`.

const SYSTEM_CHILD = /(History|Share|Feed|ChangeEvent|__hd|__Share|__Feed|__History|Tag|FieldHistory)$/;
const SYSTEM_RELATIONSHIPS = new Set(["Histories", "Feeds", "Shares", "ProcessInstances", "ProcessSteps",
  "RecordAssociatedGroups", "TopicAssignments", "CombinedAttachments", "AttachedContentDocuments",
  "ContentDocumentLinks", "LookedUpFromActivities", "NotesAndAttachments"]);

// Lookup fields that hold a value on this record.
//   fields: describe fields; values: {FieldApi: value}
export function parentLinks(fields, values) {
  const out = [];
  for (const f of fields || []) {
    if (f.type !== "reference" || !f.referenceTo || !f.referenceTo.length) continue;
    const id = values ? values[f.name] : null;
    if (!id || !/^[a-zA-Z0-9]{15,18}$/.test(String(id))) continue;
    out.push({field: f.name, label: f.label || f.name, relationshipName: f.relationshipName || null,
      targets: f.referenceTo, id: String(id)});
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// SOQL that reads the parents' names in one go ("Owner.Name, Account.Name").
export function parentNameQuery(object, id, links) {
  const cols = links.filter(l => l.relationshipName).map(l => `${l.relationshipName}.Name`);
  if (!cols.length) return null;
  return `SELECT Id, ${[...new Set(cols)].join(", ")} FROM ${object} WHERE Id = '${id}'`;
}

// Child relationships worth browsing (system companions left out).
export function childLists(describe, {includeSystem = false} = {}) {
  return (describe && describe.childRelationships || [])
    .filter(r => r.relationshipName && r.childSObject && r.field)
    .filter(r => includeSystem || (!SYSTEM_CHILD.test(r.childSObject) && !SYSTEM_RELATIONSHIPS.has(r.relationshipName)))
    .map(r => ({relationshipName: r.relationshipName, childSObject: r.childSObject, field: r.field}))
    .sort((a, b) => a.relationshipName.localeCompare(b.relationshipName));
}

// Where this object's field history lives ({object, field}) or null when
// history isn't tracked. Standard and custom objects both expose it as the
// "Histories" child relationship (Opportunity → OpportunityFieldHistory).
export function historySource(describe) {
  const rels = (describe && describe.childRelationships) || [];
  const r = rels.find(x => x.relationshipName === "Histories" && x.childSObject && x.field) ||
    rels.find(x => /FieldHistory$/.test(x.childSObject || "") && x.field);
  return r ? {object: r.childSObject, field: r.field} : null;
}

function shown(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// History records → timeline rows. Text/lookup changes produce two rows in
// Salesforce (names and ids); the id-only twin is dropped.
export function historyRows(records, fieldLabels = {}) {
  const rows = [];
  for (const r of records || []) {
    const field = r.Field || "";
    const oldV = shown(r.OldValue);
    const newV = shown(r.NewValue);
    const kind = field === "created" ? "created" : field === "locked" || field === "unlocked" ? field : "changed";
    rows.push({
      id: r.Id,
      at: r.CreatedDate,
      who: (r.CreatedBy && r.CreatedBy.Name) || "",
      field,
      label: kind === "created" ? "Record created" : kind !== "changed" ? `Record ${kind}` : (fieldLabels[field] || field),
      oldValue: oldV,
      newValue: newV,
      kind,
      idPair: /^[a-zA-Z0-9]{15,18}$/.test(oldV || newV) && (!oldV || /^[a-zA-Z0-9]{15,18}$/.test(oldV)) && (!newV || /^[a-zA-Z0-9]{15,18}$/.test(newV)),
    });
  }
  // Drop id-only rows when a readable row for the same field and moment exists.
  return rows.filter(r => !(r.idPair && rows.some(o => o !== r && !o.idPair && o.field === r.field && o.at === r.at)))
    .map(({idPair, ...r}) => r);
}

// Best display field for a list of child records.
export function nameFieldOf(describe) {
  const f = (describe && describe.fields || []).find(x => x.nameField);
  return f ? f.name : "Id";
}
