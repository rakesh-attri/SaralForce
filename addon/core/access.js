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
//   setupAccess: [{ParentId, type, name}] Apex classes, VF pages, custom
//     permissions, connected apps, flows the set can use
//   fieldPerms: [{ParentId, Field, PermissionsRead, PermissionsEdit}]
//   owd: {setId: {object: "Private / Private"}} the set's org's sharing defaults
// Returns [{key, title, rows: [{key, label, values, differs}]}].
export const COMPARE_PARTS = [
  ["general", "General"], ["system", "System permissions"], ["objects", "Object permissions"], ["fields", "Field permissions"],
  ["tabs", "Tab settings"], ["apps", "Assigned apps"], ["apex", "Apex classes"], ["pages", "Visualforce pages"],
  ["customPerms", "Custom permissions"], ["connectedApps", "Connected apps"], ["flows", "Flows"], ["owd", "Sharing defaults"]
];
const SETUP_SECTIONS = [
  ["apex", "ApexClass", "Apex class access"], ["pages", "ApexPage", "Visualforce page access"],
  ["customPerms", "CustomPermission", "Custom permissions"], ["connectedApps", "ConnectedApplication", "Connected app access"],
  ["flows", "FlowDefinition", "Flow access"]
];

export function buildCompareMatrix({sets, objectPerms = [], tabSettings = [], appAccess = [], setupAccess = [], fieldPerms = [], owd = null}) {
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

  // ✓ per item for each kind of setup access.
  for (const [key, type, title] of SETUP_SECTIONS) {
    const byName = new Map();
    for (const a of setupAccess) {
      if (a.type !== type || !ids.includes(a.ParentId)) continue;
      if (!byName.has(a.name)) byName.set(a.name, new Set());
      byName.get(a.name).add(a.ParentId);
    }
    const rows = [...byName.keys()].sort((a, b) => a.localeCompare(b)).map(name => {
      const values = ids.map(id => (byName.get(name).has(id) ? "✓" : ""));
      return {key: name, label: name, values, differs: differs(values)};
    });
    sections.push({key, title, rows});
  }

  // Field-level security: "Read · Edit", "Read" or "" (no access).
  const byField = new Map();
  for (const r of fieldPerms) {
    if (!ids.includes(r.ParentId)) continue;
    if (!byField.has(r.Field)) byField.set(r.Field, {});
    byField.get(r.Field)[r.ParentId] = r.PermissionsEdit ? "Read · Edit" : r.PermissionsRead ? "Read" : "";
  }
  const fieldRows = [...byField.keys()].sort().map(field => {
    const values = ids.map(id => byField.get(field)[id] || "");
    return {key: field, label: field, values, differs: differs(values)};
  });
  sections.push({key: "fields", title: "Field permissions", rows: fieldRows});

  // License and kind first, as "General" (users bring their own rows).
  const own = sets.some(st => st.general)
    ? [...new Set(sets.flatMap(st => Object.keys(st.general || {})))].map(label => [label, label, st => (st.general || {})[label] || ""])
    : null;
  const general = (own || [
    ["license", "User license", st => (st.License && st.License.Name) || (st.Profile && st.Profile.UserLicense && st.Profile.UserLicense.Name) || ""],
    ["kind", "Kind", st => st.IsOwnedByProfile ? "Profile" : st.Type === "Group" || st.PermissionSetGroupId ? "Permission set group" : "Permission set"]
  ]).map(([key, label, get]) => {
    const values = sets.map(get);
    return {key, label, values, differs: differs(values)};
  }).filter(r => r.values.some(Boolean));
  sections.unshift({key: "general", title: "General", rows: general});

  // Org-wide sharing defaults: the org of each column (only across orgs).
  if (owd) {
    const objs = new Set();
    for (const id of ids) for (const o of Object.keys(owd[id] || {})) objs.add(o);
    const owdRows = [...objs].sort().map(o => {
      const values = ids.map(id => (owd[id] || {})[o] || "");
      return {key: o, label: o, values, differs: differs(values)};
    });
    sections.push({key: "owd", title: "Sharing defaults (internal / external)", rows: owdRows});
  }
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

// ── Compare across orgs ───────────────────────────────────────────────
// A picked item is "host|id" ("" host = this org); a bare id (saved by an
// older version) is this org.
export function pickKey(host, id) {
  return `${host || ""}|${id}`;
}
export function splitPick(key) {
  const s = String(key || "");
  const i = s.indexOf("|");
  return i < 0 ? {host: "", id: s} : {host: s.slice(0, i), id: s.slice(i + 1)};
}

// parts: [{host, data}] with data from loadCompareData for that org. Ids of
// different orgs can't clash: every Id / ParentId becomes its pick key.
// Returns one data set for buildCompareMatrix, sets in `order` (pick keys).
export function mergeCompareData(parts, order) {
  const out = {sets: [], objectPerms: [], tabSettings: [], appAccess: [], setupAccess: [], fieldPerms: [], owd: null};
  const sets = new Map();
  for (const {host, data} of parts) {
    const k = id => pickKey(host, id);
    for (const s of data.sets || []) sets.set(k(s.Id), {...s, Id: k(s.Id)});
    for (const r of data.objectPerms || []) out.objectPerms.push({...r, ParentId: k(r.ParentId)});
    for (const r of data.tabSettings || []) out.tabSettings.push({...r, ParentId: k(r.ParentId)});
    for (const r of data.appAccess || []) out.appAccess.push({...r, ParentId: k(r.ParentId)});
    for (const r of data.setupAccess || []) out.setupAccess.push({...r, ParentId: k(r.ParentId)});
    for (const r of data.fieldPerms || []) out.fieldPerms.push({...r, ParentId: k(r.ParentId)});
    // Each item gets its own org's sharing defaults.
    if (data.owd) {
      out.owd = out.owd || {};
      for (const st of data.sets || []) out.owd[k(st.Id)] = data.owd;
    }
  }
  // Sharing defaults only say something when more than one org is compared.
  if (parts.filter(p => p.data && p.data.owd).length < 2) out.owd = null;
  out.sets = order.map(key => sets.get(key)).filter(Boolean);
  return out;
}

// ── Readable differences ──────────────────────────────────────────────
// cols: [{item, org, kind}] (kind "Sandbox" / "Production"). The shortest
// label that still tells the columns apart: the org when the same item is
// compared across orgs (with its kind when two org names look alike), the
// item when everything is in one org, otherwise both.
export function columnLabels(cols) {
  const items = new Set(cols.map(c => c.item));
  const orgs = new Set(cols.map(c => c.org));
  const orgLabel = c => {
    const twin = cols.some(o => o !== c && o.org !== c.org && String(o.org).toLowerCase() === String(c.org).toLowerCase());
    const same = cols.some(o => o !== c && o.org === c.org);
    return (twin || same) && c.kind ? `${c.org} (${c.kind})` : c.org;
  };
  if (items.size === 1 && orgs.size > 1) return cols.map(orgLabel);
  if (orgs.size <= 1) return cols.map(c => c.item);
  return cols.map(c => `${c.item} · ${orgLabel(c)}`);
}

const LETTER_LABEL = Object.fromEntries(OBJECT_PERM_FLAGS.map(([, label, l]) => [l, label]));

// "Only in A" / "Not in B" for a set of column indexes that have something.
function whoHas(idx, labels) {
  const n = labels.length;
  if (idx.length === n || !idx.length) return "";
  if (idx.length === 1) return `only in ${labels[idx[0]]}`;
  const missing = labels.filter((_, i) => !idx.includes(i));
  return `not in ${missing.join(", ")}`;
}

// One differing row in plain words, e.g. "Create, Edit, Delete: only in UAT".
export function describeRowDiff(sectionKey, values, labels) {
  if (sectionKey === "objects") {
    const none = values.map((v, i) => (v === "—" || !v ? i : -1)).filter(i => i >= 0);
    const parts = [];
    if (none.length && none.length < values.length) parts.push(`No access in ${none.map(i => labels[i]).join(", ")}`);
    // Group flags by which columns have them.
    const groups = new Map();
    for (const l of Object.keys(LETTER_LABEL)) {
      const idx = values.map((v, i) => (String(v).includes(l) ? i : -1)).filter(i => i >= 0);
      if (!idx.length || idx.length === values.length) continue;
      // Missing only where there is no access at all: already said.
      if (values.every((v, i) => idx.includes(i) || none.includes(i))) continue;
      const sig = whoHas(idx, labels);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(LETTER_LABEL[l]);
    }
    for (const [sig, flags] of groups) parts.push(`${flags.join(", ")}: ${sig}`);
    return parts.join(" · ");
  }
  if (sectionKey === "sharingRules") {
    // A rule missing on one side, or only the parts of it that changed.
    const have = values.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
    if (have.length < values.length) {
      const who = whoHas(have, labels);
      return who.charAt(0).toUpperCase() + who.slice(1);
    }
    const parts = values.map(v => String(v).split(" · "));
    const n = Math.max(...parts.map(p => p.length));
    const changed = [...Array(n).keys()].filter(j => new Set(parts.map(p => p[j] || "")).size > 1);
    return values.map((v, i) => `${labels[i]}: ${changed.map(j => parts[i][j] || "—").join(" · ")}`).join(" · ");
  }
  const EMPTY = {tabs: "Not set", fields: "No access", owd: "—", general: "—", rgSettings: "—", sharingRules: "Not in this org"};
  if (EMPTY[sectionKey]) return values.map((v, i) => `${labels[i]}: ${v || EMPTY[sectionKey]}`).join(" · ");
  // system / apps: "✓" or "".
  const idx = values.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  const who = whoHas(idx, labels);
  return who ? who.charAt(0).toUpperCase() + who.slice(1) : "";
}

// "3 differences: 2 object permissions, 1 tab setting".
export function diffSummary(sections) {
  const NAMES = {system: ["system permission", "system permissions"], objects: ["object permission", "object permissions"],
    tabs: ["tab setting", "tab settings"], apps: ["app", "apps"], general: ["general setting", "general settings"],
    fields: ["field permission", "field permissions"], apex: ["Apex class", "Apex classes"], pages: ["Visualforce page", "Visualforce pages"],
    customPerms: ["custom permission", "custom permissions"], connectedApps: ["connected app", "connected apps"], flows: ["flow", "flows"],
    owd: ["sharing default", "sharing defaults"], rgSettings: ["setting", "settings"], members: ["member", "members"],
    queueObjects: ["queue object", "queue objects"], sharingRules: ["sharing rule", "sharing rules"]};
  const parts = [];
  let total = 0;
  for (const s of sections) {
    const n = s.rows.filter(r => r.differs).length;
    total += n;
    if (n) parts.push(`${n} ${(NAMES[s.key] || [s.title, s.title])[n === 1 ? 0 : 1]}`);
  }
  return {total, text: total ? `${total} difference${total === 1 ? "" : "s"}: ${parts.join(", ")}` : "No differences: they grant the same access."};
}

// ── Users: effective access ───────────────────────────────────────────
const TAB_RANK = {Visible: 3, Available: 2, Hidden: 1, "": 0};

// data: loadCompareData for every source (profile + permission sets + group
// sets) of one user; sourceIds: that user's sources; names: {id: "Profile X"}.
// → one "set" (key) holding what any source grants, and origins:
//   {"system|PermissionsX": ["Profile: System Administrator"], …}
export function combineAccess(data, sourceIds, key, names = {}, general = null) {
  const src = new Set(sourceIds);
  const origins = {};
  const note = (k, id) => { (origins[k] = origins[k] || []).includes(names[id] || id) || origins[k].push(names[id] || id); };
  const set = {Id: key, general};
  for (const st of data.sets || []) {
    if (!src.has(st.Id)) continue;
    for (const [k, v] of Object.entries(st)) {
      if (!/^Permissions[A-Z]/.test(k) || typeof v !== "boolean") continue;
      set[k] = set[k] === true || v === true;
      if (v === true) note("system|" + k, st.Id);
    }
  }
  const byObj = new Map();
  for (const r of data.objectPerms || []) {
    if (!src.has(r.ParentId)) continue;
    const cur = byObj.get(r.SobjectType) || {ParentId: key, SobjectType: r.SobjectType};
    for (const [flag] of OBJECT_PERM_FLAGS) cur[flag] = cur[flag] === true || r[flag] === true;
    byObj.set(r.SobjectType, cur);
    if (OBJECT_PERM_FLAGS.some(([flag]) => r[flag] === true)) note("objects|" + r.SobjectType, r.ParentId);
  }
  const byField = new Map();
  for (const r of data.fieldPerms || []) {
    if (!src.has(r.ParentId)) continue;
    const cur = byField.get(r.Field) || {ParentId: key, Field: r.Field, PermissionsRead: false, PermissionsEdit: false};
    cur.PermissionsRead = cur.PermissionsRead || !!r.PermissionsRead;
    cur.PermissionsEdit = cur.PermissionsEdit || !!r.PermissionsEdit;
    byField.set(r.Field, cur);
    if (r.PermissionsRead || r.PermissionsEdit) note("fields|" + r.Field, r.ParentId);
  }
  const byTab = new Map();
  for (const t of data.tabSettings || []) {
    if (!src.has(t.ParentId)) continue;
    const v = t.Visibility === "DefaultOn" ? "Visible" : t.Visibility === "DefaultOff" ? "Available" : (t.Visibility || "");
    const cur = byTab.get(t.Name);
    if (!cur || (TAB_RANK[v] || 0) > (TAB_RANK[cur] || 0)) byTab.set(t.Name, v);
    note("tabs|" + t.Name, t.ParentId);
  }
  const VIS = {Visible: "DefaultOn", Available: "DefaultOff"};
  const SETUP_SECTION = {ApexClass: "apex", ApexPage: "pages", CustomPermission: "customPerms", ConnectedApplication: "connectedApps", FlowDefinition: "flows"};
  const apps = (data.appAccess || []).filter(a => src.has(a.ParentId));
  const setup = (data.setupAccess || []).filter(a => src.has(a.ParentId));
  for (const a of apps) note("apps|" + a.app, a.ParentId);
  for (const a of setup) note((SETUP_SECTION[a.type] || a.type) + "|" + a.name, a.ParentId);
  return {
    data: {
      sets: [set],
      objectPerms: [...byObj.values()],
      fieldPerms: [...byField.values()],
      tabSettings: [...byTab.entries()].map(([Name, v]) => ({ParentId: key, Name, Visibility: VIS[v] || v})),
      appAccess: [...new Map(apps.map(a => [a.app, {ParentId: key, app: a.app}])).values()],
      setupAccess: [...new Map(setup.map(a => [a.type + "|" + a.name, {ParentId: key, type: a.type, name: a.name}])).values()],
      owd: data.owd || null
    },
    origins
  };
}

// The same person in another org: by email first, then by username without
// the sandbox suffix (passed in as base, e.g. from manual-steps baseUsername).
export function matchUser(user, candidates, base = u => String(u || "").toLowerCase()) {
  const email = String(user.email || "").toLowerCase();
  if (email) {
    const byEmail = candidates.filter(c => String(c.email || "").toLowerCase() === email);
    if (byEmail.length === 1) return byEmail[0];
  }
  const b = base(user.username);
  return candidates.find(c => base(c.username) === b) || null;
}

// ── Roles, public groups and queues ───────────────────────────────────
// items (one per column): {kind: "role"|"group"|"queue", settings: {label: value},
//   members: [{type: "User"|"Group"|"Role", name}], queueObjects: [names]}
export function buildRoleGroupMatrix(items) {
  const rowsFrom = (keysOf, valueOf) => {
    const all = [...new Set(items.flatMap(keysOf))].sort((a, b) => a.localeCompare(b));
    return all.map(k => {
      const values = items.map(it => valueOf(it, k));
      return {key: k, label: k, values, differs: differs(values)};
    });
  };
  return [
    {key: "rgSettings", title: "Settings", rows: rowsFrom(it => Object.keys(it.settings || {}), (it, k) => (it.settings || {})[k] || "")},
    {key: "members", title: "Members", rows: rowsFrom(it => (it.members || []).map(m => `${m.type}: ${m.name}`),
      (it, k) => (it.members || []).some(m => `${m.type}: ${m.name}` === k) ? "✓" : "")},
    {key: "queueObjects", title: "Queue objects", rows: rowsFrom(it => it.queueObjects || [], (it, k) => (it.queueObjects || []).includes(k) ? "✓" : "")}
  ];
}

// ── Sharing rules ─────────────────────────────────────────────────────
const tagText = (xml, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1].trim() : ""; };
const SHARE_TO = {group: "Group", role: "Role", roleAndSubordinates: "Role & subordinates", roleAndSubordinatesInternal: "Role & internal subordinates",
  allInternalUsers: "All internal users", allPartnerUsers: "All partner users", allCustomerPortalUsers: "All customer portal users",
  portalRole: "Portal role", portalRoleAndSubordinates: "Portal role & subordinates", territory: "Territory", territoryAndSubordinates: "Territory & subordinates",
  queue: "Queue", guestUser: "Guest user"};
const ACCESS = {Read: "Read Only", Edit: "Read/Write", All: "Full Access"};
function whoText(block) {
  for (const [tag, label] of Object.entries(SHARE_TO)) {
    const v = tagText(block, tag);
    // Empty targets (all internal users) come as <tag/> or <tag></tag>.
    if (v || new RegExp(`<${tag}[\\s/>]`).test(block)) return v ? `${label} ${v}` : label;
  }
  return "?";
}

// One SharingCriteriaRule / SharingOwnerRule (… child XML) in a line.
export function summarizeSharingRule(type, xml) {
  const x = String(xml || "");
  const to = whoText(tagText(x, "sharedTo"));
  const access = ACCESS[tagText(x, "accessLevel")] || tagText(x, "accessLevel");
  if (/Owner/.test(type)) return `Owner · ${whoText(tagText(x, "sharedFrom"))} → ${to} · ${access}`;
  const items = [...x.matchAll(/<criteriaItems>([\s\S]*?)<\/criteriaItems>/g)].map(m =>
    `${tagText(m[1], "field")} ${tagText(m[1], "operation").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${tagText(m[1], "value")}`.trim());
  const logic = tagText(x, "booleanFilter");
  const label = /Guest/.test(type) ? "Guest" : /Territory/.test(type) ? "Territory" : "Criteria";
  return `${label} · ${items.join(logic ? ` (${logic}) ` : " AND ") || "any record"} → ${to} · ${access}`;
}

// Columns' orgs → a section of rules: rulesByHost {host: {"Account.Rule": summary}}.
export function sharingRulesSection(colHosts, rulesByHost) {
  const keys = [...new Set(colHosts.flatMap(h => Object.keys(rulesByHost[h] || {})))].sort((a, b) => a.localeCompare(b));
  const rows = keys.map(k => {
    const values = colHosts.map(h => (rulesByHost[h] || {})[k] || "");
    return {key: k, label: k, values, differs: differs(values)};
  });
  return {key: "sharingRules", title: "Sharing rules", rows};
}
