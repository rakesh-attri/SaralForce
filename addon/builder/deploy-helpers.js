// Pure helpers used by the deploy pipeline: Salesforce Id detection, deploy
// error classification and profile label → metadata fullName matching.

// 15/18-char Salesforce Id — AppMenu sometimes returns Id in `name`;
// updateMetadata needs a metadata fullName (developer name), never an Id.
export function isSfId(value) {
  const v = String(value || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(v) || /^[a-zA-Z0-9]{18}$/.test(v);
}

export function isDuplicateError(err) {
  const msg = (err?.message || "") + " " + (err?.statusCode || "") + " " + (err?.detail ? JSON.stringify(err.detail) : "");
  return /DUPLICATE_DEVELOPER_NAME|DUPLICATE_VALUE|already exists|duplicate value|DUPLICATE_CUSTOM_FIELD/i.test(msg);
}

// Soft-deleted fields keep their child-relationship name for ~15 days.
// "There is already a Child Relationship named IT_Asset_Assigned_To on User."
export function isRelationshipCollisionError(err) {
  return /already a Child Relationship named/i.test(err?.message || "");
}

export function relationshipCollisionName(err) {
  const m = (err?.message || "").match(/already a Child Relationship named\s+(\S+)\s+on\s+(\S+)/i);
  return m ? {name: m[1], parent: m[2].replace(/[.,;]+$/, "")} : null;
}

// Case-insensitive / punctuation-insensitive match of a profile label
// against metadata fullNames (e.g. "System Administrator" → "Admin").
export function matchProfileFullName(label, names) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "System Administrator (non-API user)" → also try the base before "(".
  const baseLabel = String(label || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const targets = [norm(label), norm(baseLabel)].filter(Boolean);
  if (targets.includes("systemadministrator")) {
    const aliases = ["admin", "systemadministrator"];
    for (const a of aliases) {
      const hit = names.find(n => norm(n) === a);
      if (hit) return hit;
    }
  }
  for (const target of targets) {
    const exact = names.find(n => norm(n) === target);
    if (exact) return exact;
    const loose = names.find(n => {
      const nn = norm(n);
      return nn && (nn.startsWith(target) || target.startsWith(nn));
    });
    if (loose) return loose;
  }
  // Base label only (drop qualifier): "Marketing User (API)" → "Marketing User".
  if (baseLabel && baseLabel !== label) {
    const base = norm(baseLabel);
    const exact = names.find(n => norm(n) === base);
    if (exact) return exact;
    const loose = names.find(n => {
      const nn = norm(n);
      return nn && (nn.startsWith(base) || base.startsWith(nn));
    });
    if (loose) return loose;
  }
  return null;
}
