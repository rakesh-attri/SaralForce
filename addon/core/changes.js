// Release Center → Changes: one list of New / Updated / Deleted components
// since a date. listMetadata only knows components that still exist, so
// deletes come from source tracking (SourceMember) and the Setup audit trail.
// Pure.
import {compKey, TYPE_BY_NAME} from "./deploy.js";

// Audit trail phrase (the words between "Deleted" and the name) → type.
// Only exact phrases: "page layout", "Lightning page" or "Flow Version #2 of
// flow X" must never turn into the wrong component.
const AUDIT_PHRASES = {
  "apex class": "ApexClass", "class": "ApexClass",
  "apex trigger": "ApexTrigger", "trigger": "ApexTrigger",
  "visualforce page": "ApexPage", "visualforce component": "ApexComponent",
  "static resource": "StaticResource", "lightning web component": "LightningComponentBundle",
  "aura component": "AuraDefinitionBundle", "lightning component": "AuraDefinitionBundle",
  "permission set": "PermissionSet", "permission set group": "PermissionSetGroup",
  "custom label": "CustomLabel", "named credential": "NamedCredential", "remote site": "RemoteSiteSetting"
};

// One SetupAuditTrail row → a deleted component, or null.
export function auditDelete(rec) {
  const text = String(rec && rec.Display || "").trim();
  const m = /^deleted\s+(?:the\s+)?([A-Za-z][A-Za-z ]*?)\s+["'“]?([A-Za-z][\w]*)["'”]?\.?$/i.exec(text);
  if (!m) return null;
  const type = AUDIT_PHRASES[m[1].trim().toLowerCase()];
  if (!type) return null;
  return {type, fullName: m[2], by: rec.CreatedBy ? rec.CreatedBy.Name : "", at: rec.CreatedDate || "", from: "audit"};
}

// SourceMember rows (tooling) → deleted components.
export function sourceMemberDeletes(rows, userNames = {}) {
  return (rows || []).filter(r => r.IsNameObsolete && r.MemberType && r.MemberName).map(r => ({
    type: r.MemberType, fullName: r.MemberName,
    by: userNames[r.LastModifiedById] || (r.LastModifiedBy && r.LastModifiedBy.Name) || "",
    at: r.LastModifiedDate || "", from: "tracking"
  }));
}

// listed: listComponents values; deleted: auditDelete / sourceMemberDeletes
// output; sinceMs: start of the period. Returns rows newest first:
// {key, type, fullName, status: "new"|"updated"|"deleted", by, at, deployable}
export function buildChanges(listed, deleted, sinceMs, types) {
  const want = types ? new Set(types) : null;
  const out = new Map();
  for (const r of listed) {
    const at = Date.parse(r.lastModifiedDate || "");
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const created = Date.parse(r.createdDate || "");
    const key = compKey(r.type, r.fullName);
    out.set(key, {key, type: r.type, fullName: r.fullName, by: r.lastModifiedByName || "", at: r.lastModifiedDate,
      status: Number.isFinite(created) && created >= sinceMs ? "new" : "updated", deployable: true});
  }
  for (const d of deleted) {
    if (want && !want.has(d.type)) continue;
    const at = Date.parse(d.at || "");
    if (Number.isFinite(at) && at < sinceMs) continue;
    const key = compKey(d.type, d.fullName);
    if (out.has(key)) continue; // still exists: deleted and re-created
    out.set(key, {key, type: d.type, fullName: d.fullName, by: d.by, at: d.at, status: "deleted",
      deployable: !!TYPE_BY_NAME[d.type], from: d.from});
  }
  return [...out.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function changeCounts(rows) {
  const c = {new: 0, updated: 0, deleted: 0};
  for (const r of rows) c[r.status]++;
  return c;
}
