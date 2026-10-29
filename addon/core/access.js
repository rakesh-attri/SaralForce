// Pure helpers for permission comparison, effective access and the risky
// access audit. No chrome/window/DOM access so they can be unit-tested.

export const OBJECT_PERM_FLAGS = [
  ["PermissionsRead", "Read", "R"],
  ["PermissionsCreate", "Create", "C"],
  ["PermissionsEdit", "Edit", "E"],
  ["PermissionsDelete", "Delete", "D"],
  ["PermissionsViewAllRecords", "View All", "V"],
  ["PermissionsModifyAllRecords", "Modify All", "M"],
];

// System permissions worth flagging in an audit, most powerful first.
export const RISKY_PERMISSIONS = [
  ["PermissionsModifyAllData", "Modify All Data"],
  ["PermissionsViewAllData", "View All Data"],
  ["PermissionsManageUsers", "Manage Users"],
  ["PermissionsAuthorApex", "Author Apex"],
  ["PermissionsCustomizeApplication", "Customize Application"],
  ["PermissionsManageProfilesPermissionsets", "Manage Profiles and Permission Sets"],
  ["PermissionsAssignPermissionSets", "Assign Permission Sets"],
  ["PermissionsResetPasswords", "Reset User Passwords"],
  ["PermissionsViewSetup", "View Setup and Configuration"],
  ["PermissionsExportReport", "Export Reports"],
];

const RISKY_LABELS = Object.fromEntries(RISKY_PERMISSIONS);

// "PermissionsManageUsers" → "Manage Users".
export function humanizePermission(field) {
  if (RISKY_LABELS[field]) return RISKY_LABELS[field];
  return String(field || "")
    .replace(/^Permissions/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

// Display name for a PermissionSet row: profiles and groups are backed by
// permission sets too, so say which kind it is.
export function permSetDisplayName(ps) {
  if (!ps) return "";
  if (ps.IsOwnedByProfile) return `${(ps.Profile && ps.Profile.Name) || ps.Label || ps.Name} (profile)`;
  if (ps.Type === "Group" || ps.PermissionSetGroupId) return `${ps.Label || ps.Name} (group)`;
  return ps.Label || ps.Name || ps.Id;
}

// Compact CRUD letters for an ObjectPermissions row, e.g. "RCE" or "—".
export function objectPermLetters(row) {
  if (!row) return "—";
  const s = OBJECT_PERM_FLAGS.filter(([f]) => row[f] === true).map(([, , l]) => l).join("");
  return s || "—";
}

function differs(values) {
  return new Set(values).size > 1;
}

// Side-by-side matrix for 2-5 permission sets (profiles included).
//   sets: PermissionSet rows (with Permissions* booleans)
//   objectPerms: ObjectPermissions rows (ParentId, SobjectType, flags)
//   tabSettings: PermissionSetTabSetting rows (ParentId, Name, Visibility)
//   appAccess: [{ParentId, app}] app labels the set can see
// Returns [{key, title, rows: [{key, label, values, differs}]}].
export function buildCompareMatrix({sets, objectPerms = [], tabSettings = [], appAccess = []}) {
  const ids = sets.map(s => s.Id);
  const sections = [];

  const sysFields = new Set();
  for (const s of sets) {
    for (const k of Object.keys(s)) if (/^Permissions[A-Z]/.test(k) && typeof s[k] === "boolean") sysFields.add(k);
  }
  const sysRows = [...sysFields]
    .map(f => {
      const values = sets.map(s => (s[f] === true ? "✓" : ""));
      return {key: f, label: humanizePermission(f), values, differs: differs(values)};
    })
    .filter(r => r.values.some(Boolean))
    .sort((a, b) => a.label.localeCompare(b.label));
  sections.push({key: "system", title: "System permissions", rows: sysRows});

  const byObj = new Map();
  for (const r of objectPerms) {
    if (!ids.includes(r.ParentId)) continue;
    if (!byObj.has(r.SobjectType)) byObj.set(r.SobjectType, {});
    byObj.get(r.SobjectType)[r.ParentId] = r;
  }
  const objRows = [...byObj.keys()].sort().map(obj => {
    const values = ids.map(id => objectPermLetters(byObj.get(obj)[id]));
    return {key: obj, label: obj, values, differs: differs(values)};
  });
  sections.push({key: "objects", title: "Object permissions (R C E D · View All · Modify All)", rows: objRows});

  const byTab = new Map();
  for (const t of tabSettings) {
    if (!ids.includes(t.ParentId)) continue;
    if (!byTab.has(t.Name)) byTab.set(t.Name, {});
    byTab.get(t.Name)[t.ParentId] = t.Visibility === "DefaultOn" ? "Visible" : t.Visibility === "DefaultOff" ? "Available" : (t.Visibility || "");
  }
  const tabRows = [...byTab.keys()].sort().map(name => {
    const values = ids.map(id => byTab.get(name)[id] || "");
    return {key: name, label: name, values, differs: differs(values)};
  });
  sections.push({key: "tabs", title: "Tab settings", rows: tabRows});

  const byApp = new Map();
  for (const a of appAccess) {
    if (!ids.includes(a.ParentId)) continue;
    if (!byApp.has(a.app)) byApp.set(a.app, new Set());
    byApp.get(a.app).add(a.ParentId);
  }
  const appRows = [...byApp.keys()].sort().map(app => {
    const values = ids.map(id => (byApp.get(app).has(id) ? "✓" : ""));
    return {key: app, label: app, values, differs: differs(values)};
  });
  sections.push({key: "apps", title: "Assigned apps", rows: appRows});
  return sections;
}

// Narrow a matrix to differing rows and/or rows matching a search term.
export function filterMatrix(sections, {onlyDiff = false, term = ""} = {}) {
  const t = String(term || "").trim().toLowerCase();
  return sections.map(s => ({
    ...s,
    rows: s.rows.filter(r => (!onlyDiff || r.differs) &&
      (!t || r.label.toLowerCase().includes(t) || r.key.toLowerCase().includes(t))),
  }));
}

// Effective access from several sources (a user's profile + permission
// sets + groups): a flag is on when any source grants it.
//   rows: permission rows with boolean flag fields and ParentId
//   flags: [[field, label], …]
//   names: {ParentId: display name}
export function effectiveAccess(rows, flags, names = {}) {
  const effective = {};
  for (const [f, label] of flags) effective[label] = rows.some(r => r[f] === true);
  const sources = rows
    .map(r => ({
      id: r.ParentId,
      name: names[r.ParentId] || r.ParentId,
      grants: flags.filter(([f]) => r[f] === true).map(([, label]) => label),
    }))
    .filter(s => s.grants.length)
    .sort((a, b) => b.grants.length - a.grants.length || a.name.localeCompare(b.name));
  return {effective, sources};
}

// Risky access audit. byPerm: {PermissionsX: PermissionSetAssignment rows
// with Assignee{Id,Name,Username} and PermissionSet{Label,Name,IsOwnedByProfile,Profile{Name}}}.
// Returns per-permission counts and the users holding the most of them.
export function summarizeRiskyAccess(byPerm) {
  const users = new Map();
  const perms = [];
  for (const [field, label] of RISKY_PERMISSIONS) {
    const rows = byPerm[field];
    if (!rows) continue;
    const holders = new Set();
    const sources = new Map();
    for (const r of rows) {
      const a = r.Assignee || {};
      const uid = a.Id || r.AssigneeId;
      if (!uid) continue;
      holders.add(uid);
      const src = permSetDisplayName(r.PermissionSet);
      sources.set(src, (sources.get(src) || 0) + 1);
      if (!users.has(uid)) users.set(uid, {id: uid, name: a.Name || uid, username: a.Username || "", perms: new Set(), sources: new Set()});
      const u = users.get(uid);
      u.perms.add(label);
      u.sources.add(src);
    }
    perms.push({
      field, label, userCount: holders.size,
      sources: [...sources].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count),
    });
  }
  const userList = [...users.values()]
    .map(u => ({...u, perms: [...u.perms], sources: [...u.sources]}))
    .sort((a, b) => b.perms.length - a.perms.length || a.name.localeCompare(b.name));
  return {perms, users: userList};
}

// Quote and join ids for a SOQL IN list (ids are validated as Salesforce ids).
export function soqlIdList(ids) {
  return ids.filter(id => /^[a-zA-Z0-9]{15,18}$/.test(String(id))).map(id => `'${id}'`).join(",");
}
