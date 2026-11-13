// Org reads for the Access tab and the Users access check. Every query is
// read-only; failures of optional parts (tabs, apps) degrade to empty.
import {queryAll} from "./query.js";
import {apiVersion} from "../../inspector.js";
import {ffDescribeObject} from "./describe.js";
import {soqlIdList, RISKY_PERMISSIONS, permSetDisplayName, combineAccess, summarizeSharingRule} from "../../core/access.js";
import {baseUsername} from "../../core/manual-steps.js";
import {retrieve} from "./deploy-api.js";
import {componentsFromZip} from "../../core/deploy.js";
import {bytesToText} from "../../core/zip.js";
import {escapeSoqlString} from "../../core/soql.js";
import {shareModel, settingsFromXml, summarizeSharingSet, summarizeRestrictionRule} from "../../core/sharing-page.js";

const PS_BASE_FIELDS = "Id, Name, Label, IsOwnedByProfile, Profile.Name, Type, PermissionSetGroupId, License.Name";

// conn: another org you're logged into (SandShift's org list), so the Access
// compare can put a sandbox profile next to production's. Omitted = this org.
function run(conn, soql) {
  if (!conn) return queryAll(soql);
  return conn.client.queryAll(soql, {maxRecords: 50000}).then(r => r.records || []);
}

// Profiles, permission sets and groups, each backed by a PermissionSet row.
async function loadPermSetList(conn) {
  const rows = await run(conn, `SELECT ${PS_BASE_FIELDS} FROM PermissionSet ORDER BY Label LIMIT 3000`);
  return rows
    .filter(r => r.Type !== "Session" && r.Type !== "Standard")
    .map(r => ({
      id: r.Id,
      name: permSetDisplayName(r),
      kind: r.IsOwnedByProfile ? "profile" : (r.Type === "Group" || r.PermissionSetGroupId) ? "group" : "set",
      groupId: r.PermissionSetGroupId || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const _permFields = new Map(); // host ("" = this org) → field names
// Boolean Permissions* field names on PermissionSet (system permissions).
async function loadPermFieldNames(conn) {
  const key = conn ? conn.host : "";
  if (_permFields.has(key)) return _permFields.get(key);
  const d = conn
    ? await conn.client.request(`/services/data/v${apiVersion}/sobjects/PermissionSet/describe`)
    : await ffDescribeObject("PermissionSet");
  const names = (d.fields || [])
    .filter(f => /^Permissions[A-Z]/.test(f.name) && f.type === "boolean")
    .map(f => f.name);
  _permFields.set(key, names);
  return names;
}

// PermissionSet rows with every system permission, in field chunks so the
// query URL stays short.
async function loadPermSetsWithPerms(ids, conn) {
  const list = soqlIdList(ids);
  if (!list) return [];
  const fields = await loadPermFieldNames(conn);
  const byId = new Map();
  const base = await run(conn, `SELECT ${PS_BASE_FIELDS} FROM PermissionSet WHERE Id IN (${list})`);
  for (const r of base) byId.set(r.Id, {...r});
  for (let i = 0; i < fields.length; i += 120) {
    const chunk = fields.slice(i, i + 120).join(", ");
    const rows = await run(conn, `SELECT Id, ${chunk} FROM PermissionSet WHERE Id IN (${list})`);
    for (const r of rows) Object.assign(byId.get(r.Id) || {}, r);
  }
  return ids.map(id => byId.get(id)).filter(Boolean);
}

const OBJ_PERM_FIELDS = "ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, " +
  "PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords";

// Names of what SetupEntityAccess points at, per type (Id → name).
const SETUP_NAMES = {
  ApexClass: ids => `SELECT Id, Name FROM ApexClass WHERE Id IN (${ids})`,
  ApexPage: ids => `SELECT Id, Name FROM ApexPage WHERE Id IN (${ids})`,
  CustomPermission: ids => `SELECT Id, DeveloperName FROM CustomPermission WHERE Id IN (${ids})`,
  ConnectedApplication: ids => `SELECT Id, Name FROM ConnectedApplication WHERE Id IN (${ids})`,
  FlowDefinition: ids => `SELECT DurableId, ApiName FROM FlowDefinitionView WHERE DurableId IN (${ids})`
};
const nameOfRow = r => r.Name || r.DeveloperName || r.ApiName || r.Label || "";

async function setupNames(conn, type, idList) {
  const out = new Map();
  for (let i = 0; i < idList.length; i += 150) {
    const rows = await run(conn, SETUP_NAMES[type](soqlIdList(idList.slice(i, i + 150)))).catch(() => []);
    for (const r of rows) out.set((r.Id || r.DurableId || "").slice(0, 15), nameOfRow(r));
  }
  return out;
}

// parts: which extra sections to read (fields, owd, …); the core ones always.
async function loadCompareData(ids, conn, parts = null) {
  const want = k => !parts || parts.includes(k);
  const list = soqlIdList(ids);
  const optional = p => p.catch(() => []);
  const [sets, objectPerms, tabSettings, accessRows, fieldPerms, owdRows] = await Promise.all([
    loadPermSetsWithPerms(ids, conn),
    run(conn, `SELECT ${OBJ_PERM_FIELDS} FROM ObjectPermissions WHERE ParentId IN (${list})`),
    optional(run(conn, `SELECT ParentId, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${list})`)),
    optional(run(conn, `SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId IN (${list})`)),
    want("fields") ? optional(run(conn, `SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${list})`)) : [],
    want("owd") ? optional(run(conn, "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition " +
      "WHERE IsCustomizable = true AND InternalSharingModel != null")) : []
  ]);
  const appRows = accessRows.filter(r => r.SetupEntityType === "TabSet");
  let appAccess = [];
  const appIds = [...new Set(appRows.map(r => r.SetupEntityId))];
  if (appIds.length) {
    const apps = await optional(run(conn, `SELECT ApplicationId, Label FROM AppMenuItem WHERE ApplicationId IN (${soqlIdList(appIds)})`));
    const label = new Map(apps.map(a => [a.ApplicationId, a.Label]));
    appAccess = appRows.map(r => ({ParentId: r.ParentId, app: label.get(r.SetupEntityId) || r.SetupEntityId}));
  }
  // Apex classes, VF pages, custom permissions, connected apps and flows.
  const setupAccess = [];
  for (const type of Object.keys(SETUP_NAMES)) {
    const rows = accessRows.filter(r => r.SetupEntityType === type);
    if (!rows.length) continue;
    const names = await setupNames(conn, type, [...new Set(rows.map(r => r.SetupEntityId))]);
    for (const r of rows) setupAccess.push({ParentId: r.ParentId, type, name: names.get(String(r.SetupEntityId).slice(0, 15)) || r.SetupEntityId});
  }
  const SHARE = {Private: "Private", Read: "Public Read Only", ReadWrite: "Public Read/Write", ReadWriteTransfer: "Public Read/Write/Transfer",
    ControlledByParent: "Controlled by Parent", FullAccess: "Public Full Access", ReadSelect: "Read Only (select)", ControlledByCampaign: "Controlled by Campaign",
    ControlledByLeadOrContact: "Controlled by Lead or Contact"};
  const owd = owdRows.length ? Object.fromEntries(owdRows.map(r => [r.QualifiedApiName,
    `${SHARE[r.InternalSharingModel] || r.InternalSharingModel} / ${SHARE[r.ExternalSharingModel] || r.ExternalSharingModel || "—"}`])) : null;
  return {sets, objectPerms, tabSettings, appAccess, setupAccess, fieldPerms, owd};
}

// Every permission set a user holds (profile + sets + groups) with names.
async function userPermSources(userId) {
  const rows = await queryAll(
    "SELECT PermissionSetId, PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile, " +
    "PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.MasterLabel " +
    `FROM PermissionSetAssignment WHERE AssigneeId = '${escapeSoqlString(userId)}'`);
  const names = {};
  for (const r of rows) {
    names[r.PermissionSetId] = r.PermissionSetGroupId
      ? `${(r.PermissionSetGroup && r.PermissionSetGroup.MasterLabel) || "Group"} (group)`
      : permSetDisplayName(r.PermissionSet);
  }
  return {ids: Object.keys(names), names};
}

async function objectPermRows(ids, objectName) {
  return queryAll(`SELECT ${OBJ_PERM_FIELDS} FROM ObjectPermissions WHERE ParentId IN (${soqlIdList(ids)}) ` +
    `AND SobjectType = '${escapeSoqlString(objectName)}'`);
}

async function fieldPermRows(ids, fieldPath) {
  return queryAll("SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions " +
    `WHERE ParentId IN (${soqlIdList(ids)}) AND Field = '${escapeSoqlString(fieldPath)}'`);
}

// Rows shaped like permission rows ({ParentId, [field]: bool}) for one
// system permission across the given permission sets.
async function systemPermRows(ids, permField) {
  if (!/^Permissions[A-Za-z0-9]+$/.test(permField)) throw new Error("Unknown system permission");
  const rows = await queryAll(`SELECT Id, ${permField} FROM PermissionSet WHERE Id IN (${soqlIdList(ids)})`);
  return rows.map(r => ({ParentId: r.Id, [permField]: r[permField] === true}));
}

// Active users holding each risky system permission (by assignment).
async function riskyAssignments(onProgress) {
  const out = {};
  let done = 0;
  for (const [field] of RISKY_PERMISSIONS) {
    try {
      out[field] = await queryAll(
        "SELECT AssigneeId, Assignee.Id, Assignee.Name, Assignee.Username, PermissionSet.Label, PermissionSet.Name, " +
        "PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSet.Type " +
        `FROM PermissionSetAssignment WHERE PermissionSet.${field} = true AND Assignee.IsActive = true LIMIT 5000`);
    } catch (e) { /* permission not in this org edition */ }
    done++;
    if (onProgress) onProgress(done, RISKY_PERMISSIONS.length);
  }
  return out;
}

// ── Compare users: effective access ───────────────────────────────────
// Active users first, up to 2000, for the picker (searched in the browser).
async function loadUserList(conn) {
  const rows = await run(conn, "SELECT Id, Name, Username, Email, IsActive, Profile.Name FROM User " +
    "WHERE UserType = 'Standard' ORDER BY IsActive DESC, Name LIMIT 2000");
  return rows.map(u => ({id: u.Id, name: u.Name, username: u.Username, email: u.Email, active: u.IsActive,
    profile: u.Profile ? u.Profile.Name : "", kind: "user"}));
}

// Each user's access combined from their profile, permission sets and groups.
// → {data (one set per user, Id = user id), origins: {userId: {...}}}
async function loadUserAccess(userIds, conn, parts) {
  const list = soqlIdList(userIds);
  const [users, assigns] = await Promise.all([
    run(conn, "SELECT Id, Name, Username, IsActive, Profile.Name, Profile.UserLicense.Name, UserRole.Name FROM User " +
      `WHERE Id IN (${list})`),
    run(conn, "SELECT AssigneeId, PermissionSetId, PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile, " +
      "PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.MasterLabel " +
      `FROM PermissionSetAssignment WHERE AssigneeId IN (${list})`)
  ]);
  const names = {};
  for (const a of assigns) {
    const ps = a.PermissionSet || {};
    names[a.PermissionSetId] = a.PermissionSetGroupId
      ? `Group: ${(a.PermissionSetGroup && a.PermissionSetGroup.MasterLabel) || ps.Label || "group"}`
      : ps.IsOwnedByProfile ? `Profile: ${(ps.Profile && ps.Profile.Name) || ps.Label}` : `Perm set: ${ps.Label || ps.Name}`;
  }
  const allIds = [...new Set(assigns.map(a => a.PermissionSetId))];
  const data = allIds.length ? await loadCompareData(allIds, conn, parts) : {sets: []};
  const out = {sets: [], objectPerms: [], tabSettings: [], appAccess: [], setupAccess: [], fieldPerms: [], owd: data.owd || null};
  const origins = {};
  for (const id of userIds) {
    const u = users.find(x => x.Id === id) || {};
    const general = {
      "Profile": u.Profile ? u.Profile.Name : "",
      "Role": u.UserRole ? u.UserRole.Name : "",
      "User license": u.Profile && u.Profile.UserLicense ? u.Profile.UserLicense.Name : "",
      "Active": u.IsActive == null ? "" : u.IsActive ? "Yes" : "No"
    };
    const mine = assigns.filter(a => a.AssigneeId === id).map(a => a.PermissionSetId);
    const r = combineAccess(data, mine, id, names, general);
    for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k].push(...(r.data[k] || []));
    origins[id] = r.origins;
  }
  return {data: out, origins};
}

// ── Compare roles, public groups and queues ───────────────────────────
async function loadRoleGroupList(conn) {
  const [roles, groups] = await Promise.all([
    run(conn, "SELECT Id, Name, DeveloperName FROM UserRole ORDER BY Name LIMIT 2000").catch(() => []),
    run(conn, "SELECT Id, Name, DeveloperName, Type FROM Group WHERE Type IN ('Regular', 'Queue') ORDER BY Name LIMIT 2000").catch(() => [])
  ]);
  return [
    ...roles.map(r => ({id: r.Id, name: r.Name, dev: r.DeveloperName, kind: "role"})),
    ...groups.map(g => ({id: g.Id, name: g.Name, dev: g.DeveloperName, kind: g.Type === "Queue" ? "queue" : "group"}))
  ].sort((a, b) => a.name.localeCompare(b.name));
}

const ROLE_ACCESS = {None: "No access", Read: "Read only", Edit: "Read/Write", All: "Full"};

// items: [{id, kind}] → {id: {kind, settings, members, queueObjects}}
async function loadRoleGroupData(items, conn) {
  const roleIds = items.filter(i => i.kind === "role").map(i => i.id);
  const groupIds = items.filter(i => i.kind !== "role").map(i => i.id);
  const out = {};
  const userName = new Map();
  const needUsers = async ids => {
    const want = ids.filter(id => !userName.has(id));
    for (let i = 0; i < want.length; i += 150) {
      const rows = await run(conn, `SELECT Id, Username FROM User WHERE Id IN (${soqlIdList(want.slice(i, i + 150))})`).catch(() => []);
      for (const u of rows) userName.set(u.Id, baseUsername(u.Username));
    }
  };
  if (roleIds.length) {
    const list = soqlIdList(roleIds);
    const [roles, users] = await Promise.all([
      run(conn, "SELECT Id, DeveloperName, ParentRole.DeveloperName, OpportunityAccessForAccountOwner, CaseAccessForAccountOwner, " +
        `ContactAccessForAccountOwner FROM UserRole WHERE Id IN (${list})`),
      run(conn, `SELECT Username, UserRoleId FROM User WHERE IsActive = true AND UserRoleId IN (${list})`).catch(() => [])
    ]);
    for (const r of roles) {
      out[r.Id] = {kind: "role", queueObjects: [],
        settings: {"Type": "Role", "Reports to": r.ParentRole ? r.ParentRole.DeveloperName : "(top)",
          "Opportunity access (account owner)": ROLE_ACCESS[r.OpportunityAccessForAccountOwner] || r.OpportunityAccessForAccountOwner || "",
          "Case access (account owner)": ROLE_ACCESS[r.CaseAccessForAccountOwner] || r.CaseAccessForAccountOwner || "",
          "Contact access (account owner)": ROLE_ACCESS[r.ContactAccessForAccountOwner] || r.ContactAccessForAccountOwner || ""},
        members: users.filter(u => u.UserRoleId === r.Id).map(u => ({type: "User", name: baseUsername(u.Username)}))};
    }
  }
  if (groupIds.length) {
    const list = soqlIdList(groupIds);
    const [groups, members, queueObjs] = await Promise.all([
      run(conn, `SELECT Id, DeveloperName, Type, DoesIncludeBosses, Email FROM Group WHERE Id IN (${list})`),
      run(conn, `SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (${list})`).catch(() => []),
      run(conn, `SELECT QueueId, SobjectType FROM QueueSobject WHERE QueueId IN (${list})`).catch(() => [])
    ]);
    await needUsers(members.map(m => m.UserOrGroupId).filter(id => /^005/.test(id)));
    // Members that are groups: public groups, or a role ("Role" / "RoleAndSubordinates" groups point at the role).
    const memberGroupIds = members.map(m => m.UserOrGroupId).filter(id => /^00G/.test(id));
    const mg = memberGroupIds.length ? await run(conn, `SELECT Id, DeveloperName, Type, RelatedId FROM Group WHERE Id IN (${soqlIdList(memberGroupIds)})`).catch(() => []) : [];
    const roleIdsInGroups = mg.filter(g => g.RelatedId && /^00E/.test(g.RelatedId)).map(g => g.RelatedId);
    const rn = roleIdsInGroups.length ? await run(conn, `SELECT Id, DeveloperName FROM UserRole WHERE Id IN (${soqlIdList(roleIdsInGroups)})`).catch(() => []) : [];
    const roleName = new Map(rn.map(r => [r.Id, r.DeveloperName]));
    const memberOf = id => {
      if (/^005/.test(id)) return {type: "User", name: userName.get(id) || id};
      const g = mg.find(x => x.Id === id);
      if (!g) return {type: "Group", name: id};
      if (g.RelatedId && roleName.has(g.RelatedId)) return {type: /Subordinates/.test(g.Type) ? "Role & subordinates" : "Role", name: roleName.get(g.RelatedId)};
      return {type: "Group", name: g.DeveloperName || id};
    };
    for (const g of groups) {
      const queue = g.Type === "Queue";
      out[g.Id] = {kind: queue ? "queue" : "group",
        settings: queue ? {"Type": "Queue", "Email": g.Email || ""} : {"Type": "Public group", "Include bosses": g.DoesIncludeBosses ? "Yes" : "No"},
        members: members.filter(m => m.GroupId === g.Id).map(m => memberOf(m.UserOrGroupId)),
        queueObjects: queueObjs.filter(q => q.QueueId === g.Id).map(q => q.SobjectType)};
    }
  }
  return out;
}

// ── Sharing rules of an org (Metadata API) ────────────────────────────
// conn: a SandShift org connection (this org included). → {"Account.Rule": summary}
async function loadSharingRules(conn) {
  const res = await retrieve(conn, {SharingRules: ["*"]});
  const comps = componentsFromZip(res.files, bytesToText);
  const out = {};
  for (const c of comps.values()) {
    if (!/^Sharing(Criteria|Owner|Territory|Guest)Rule$/.test(c.type)) continue;
    out[c.fullName] = summarizeSharingRule(c.type, Object.values(c.files || {}).join("\n"));
  }
  return out;
}

// ── Setup's Sharing Settings page of an org ───────────────────────────
// conn: a SandShift org connection (this org included). parts: section keys
// from SHARING_PAGE_PARTS. One retrieve for everything that is metadata.
// → {owd, settings, rules, sharingSets, restrictionRules, notes}
async function loadSharingPage(conn, parts, onStatus) {
  const want = k => parts.includes(k);
  const out = {owd: {}, settings: {}, rules: {}, sharingSets: {}, restrictionRules: {}, notes: []};
  const types = {};
  if (want("settings")) types.Settings = ["Sharing"];
  if (want("rules")) types.SharingRules = ["*"];
  if (want("sharingSets")) types.SharingSet = ["*"];
  if (want("restrictionRules")) types.RestrictionRule = ["*"];
  const owdP = want("owd")
    ? run(conn, "SELECT QualifiedApiName, Label, InternalSharingModel, ExternalSharingModel FROM EntityDefinition " +
      "WHERE IsCustomizable = true AND InternalSharingModel != null")
    : Promise.resolve([]);
  const retrieveAll = async () => {
    if (!Object.keys(types).length) return null;
    if (onStatus) onStatus("Reading sharing settings…");
    try {
      return await retrieve(conn, types);
    } catch (e) {
      // Orgs without Experience Cloud or restriction rules can refuse those
      // types: try again with the core ones only.
      if (!types.SharingSet && !types.RestrictionRule) throw e;
      delete types.SharingSet;
      delete types.RestrictionRule;
      out.notes.push("Sharing sets and restriction rules could not be read: " + e.message);
      return retrieve(conn, types);
    }
  };
  const [owdRows, res] = await Promise.all([owdP, retrieveAll()]);
  for (const r of owdRows) {
    out.owd[r.QualifiedApiName] = {label: r.Label || r.QualifiedApiName,
      internal: shareModel(r.InternalSharingModel), external: shareModel(r.ExternalSharingModel)};
  }
  if (!res) return out;
  for (const m of res.messages || []) if (m.problem) out.notes.push(m.problem);
  for (const [path, bytes] of res.files) {
    const text = () => (typeof bytes === "string" ? bytes : bytesToText(bytes));
    if (/^settings\/Sharing\.settings$/.test(path)) out.settings = settingsFromXml(text());
    else if (/^sharingSets\/.+\.sharingSet$/.test(path)) out.sharingSets[path.replace(/^sharingSets\/|\.sharingSet$/g, "")] = summarizeSharingSet(text());
    else if (/^restrictionRules\/.+\.rule$/.test(path)) out.restrictionRules[path.replace(/^restrictionRules\/|\.rule$/g, "")] = summarizeRestrictionRule(text());
  }
  if (want("rules")) {
    for (const c of componentsFromZip(res.files, bytesToText).values()) {
      if (!/^Sharing(Criteria|Owner|Territory|Guest)Rule$/.test(c.type)) continue;
      out.rules[c.fullName] = summarizeSharingRule(c.type, Object.values(c.files || {}).join("\n"));
    }
  }
  return out;
}

export {
  loadSharingPage,
  loadUserList, loadUserAccess, loadRoleGroupList, loadRoleGroupData, loadSharingRules,
  loadPermSetList, loadPermFieldNames, loadCompareData, userPermSources,
  objectPermRows, fieldPermRows, systemPermRows, riskyAssignments
};
