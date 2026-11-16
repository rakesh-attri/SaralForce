// Pure helpers used by the deploy pipeline: Salesforce Id detection, deploy
// error classification and profile label → metadata fullName matching.

// 15/18-char Salesforce Id — AppMenu sometimes returns Id in `name`;
// updateMetadata needs a metadata fullName (developer name), never an Id.
// Real Ids always contain digits (key prefix + pod/instance chars), so an
// all-letter developer name of the same length ("ContractManager") is not one.
export function isSfId(value) {
  const v = String(value || "").trim();
  return /^(?:[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(v) && /\d/.test(v);
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

// Standard profile labels whose metadata fullName differs from the label
// (keys are normalized labels). Values are tried in order.
const PROFILE_ALIASES = {
  systemadministrator: ["Admin", "System Administrator"],
  standarduser: ["Standard"],
  standardplatformuser: ["StandardAul"],
  marketinguser: ["MarketingProfile"],
  contractmanager: ["ContractManager"],
  solutionmanager: ["SolutionManager"],
  readonly: ["ReadOnly"],
  partnercommunityuser: ["Partner Community User"],
  customercommunityuser: ["Customer Community User"],
  chatterfreeuser: ["Chatter Free User"]
};

// Case-insensitive / punctuation-insensitive match of a profile label
// against metadata fullNames (e.g. "System Administrator" → "Admin").
// Order: known standard-profile aliases, then exact normalized match on the
// full label, then on the label without a trailing "(…)" qualifier. No
// prefix guessing: "Sales Manager" must never resolve to "Sales".
export function matchProfileFullName(label, names) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const list = Array.isArray(names) ? names : [];
  // "System Administrator (non-API user)" → also try the base before "(".
  const baseLabel = String(label || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const targets = [...new Set([norm(label), norm(baseLabel)].filter(Boolean))];
  // Metadata fullNames URL-encode some characters ("Custom%3A Sales Profile").
  const decoded = n => { try { return decodeURIComponent(String(n)); } catch (e) { return String(n); } };
  const exactHit = t => list.find(n => norm(n) === t || norm(decoded(n)) === t);
  for (const target of targets) {
    for (const alias of PROFILE_ALIASES[target] || []) {
      const hit = exactHit(norm(alias));
      if (hit) return hit;
    }
    const exact = exactHit(target);
    if (exact) return exact;
  }
  return null;
}
