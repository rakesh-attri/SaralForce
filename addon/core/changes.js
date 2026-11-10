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

// A component date that can be trusted: some types list a blank date or
// 1970, which says nothing about when they changed. → epoch ms or NaN.
export function trustedDate(str) {
  const t = Date.parse(str || "");
  return Number.isFinite(t) && t >= Date.UTC(2000, 0, 1) ? t : NaN;
}

// In [fromMs, toMs)? 0 means open. Unknown dates stay in: better to compare
// something unchanged than to miss a change.
export function inRange(str, fromMs, toMs) {
  const t = trustedDate(str);
  if (!Number.isFinite(t)) return true;
  return (!fromMs || t >= fromMs) && (!toMs || t < toMs);
}

// One SetupAuditTrail row → a deleted component, or null.
export function auditDelete(rec) {
  const text = String(rec && rec.Display || "").trim();
  const m = /^deleted\s+(?:the\s+)?([A-Za-z][A-Za-z ]*?)\s+["'“]?([A-Za-z][\w]*)["'”]?\.?$/i.exec(text);
  if (!m) return null;
  const type = AUDIT_PHRASES[m[1].trim().toLowerCase()];
  if (!type) return null;
  return {type, fullName: m[2], by: rec.CreatedBy ? rec.CreatedBy.Name : "", at: rec.CreatedDate || "", from: "audit"};
}

// Profile and permission set edits (field access, object rights…) often leave
// the Metadata API's lastModifiedDate alone; the audit trail still says
// "Changed profile Sales User: field-level security for …".
// → [{type: "Profile"|"PermissionSet", label, by, at}]
export function auditPermissionEdits(rows) {
  const out = [];
  for (const rec of rows || []) {
    const text = String(rec && rec.Display || "").trim();
    const m = /^(?:changed|edited|updated|created|enabled|disabled)\b.*?\b(profile|permission set)\s+["'“]?([^"'”:]+?)["'”]?\s*(?::|$)/i.exec(text);
    if (!m || /permission set group/i.test(m[0])) continue;
    out.push({type: /profile/i.test(m[1]) ? "Profile" : "PermissionSet", label: m[2].trim(),
      by: rec.CreatedBy ? rec.CreatedBy.Name : "", at: rec.CreatedDate || ""});
  }
  return out;
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
// touched: [{type, fullName, by, at}] edits known from elsewhere (audit
// trail, Profile.LastModifiedDate) that listMetadata's date misses.
// untilMs: end of the period (0 = now).
export function buildChanges(listed, deleted, sinceMs, types, touched = [], untilMs = 0) {
  const late = at => untilMs && at >= untilMs;
  const want = types ? new Set(types) : null;
  const out = new Map();
  for (const r of listed) {
    const at = Date.parse(r.lastModifiedDate || "");
    if (!Number.isFinite(at) || at < sinceMs || late(at)) continue;
    const created = Date.parse(r.createdDate || "");
    const key = compKey(r.type, r.fullName);
    out.set(key, {key, type: r.type, fullName: r.fullName, by: r.lastModifiedByName || "", at: r.lastModifiedDate,
      status: Number.isFinite(created) && created >= sinceMs ? "new" : "updated", deployable: true});
  }
  const known = new Map(listed.map(r => [compKey(r.type, r.fullName), r]));
  for (const t of touched) {
    const at = Date.parse(t.at || "");
    if (!Number.isFinite(at) || at < sinceMs || late(at) || (want && !want.has(t.type))) continue;
    const key = compKey(t.type, t.fullName);
    const cur = out.get(key);
    if (cur && String(cur.at) >= String(t.at)) continue;
    const r = known.get(key);
    const created = Date.parse(r && r.createdDate || "");
    out.set(key, {key, type: t.type, fullName: t.fullName, by: t.by || (cur && cur.by) || "", at: t.at,
      status: cur ? cur.status : Number.isFinite(created) && created >= sinceMs ? "new" : "updated", deployable: true});
  }
  for (const d of deleted) {
    if (want && !want.has(d.type)) continue;
    const at = Date.parse(d.at || "");
    if (Number.isFinite(at) && (at < sinceMs || late(at))) continue;
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
