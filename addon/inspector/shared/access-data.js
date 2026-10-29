// Org reads for the Access tab and the Users access check. Every query is
// read-only; failures of optional parts (tabs, apps) degrade to empty.
import {queryAll} from "./query.js";
import {ffDescribeObject} from "./describe.js";
import {soqlIdList, RISKY_PERMISSIONS, permSetDisplayName} from "../../core/access.js";
import {escapeSoqlString} from "../../core/soql.js";

const PS_BASE_FIELDS = "Id, Name, Label, IsOwnedByProfile, Profile.Name, Type, PermissionSetGroupId";

// Profiles, permission sets and groups, each backed by a PermissionSet row.
async function loadPermSetList() {
  const rows = await queryAll(`SELECT ${PS_BASE_FIELDS} FROM PermissionSet ORDER BY Label LIMIT 3000`);
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

let _permFields = null;
// Boolean Permissions* field names on PermissionSet (system permissions).
async function loadPermFieldNames() {
  if (_permFields) return _permFields;
  const d = await ffDescribeObject("PermissionSet");
  _permFields = (d.fields || [])
    .filter(f => /^Permissions[A-Z]/.test(f.name) && f.type === "boolean")
    .map(f => f.name);
  return _permFields;
}

// PermissionSet rows with every system permission, in field chunks so the
// query URL stays short.
async function loadPermSetsWithPerms(ids) {
  const list = soqlIdList(ids);
  if (!list) return [];
  const fields = await loadPermFieldNames();
  const byId = new Map();
  const base = await queryAll(`SELECT ${PS_BASE_FIELDS} FROM PermissionSet WHERE Id IN (${list})`);
  for (const r of base) byId.set(r.Id, {...r});
  for (let i = 0; i < fields.length; i += 120) {
    const chunk = fields.slice(i, i + 120).join(", ");
    const rows = await queryAll(`SELECT Id, ${chunk} FROM PermissionSet WHERE Id IN (${list})`);
    for (const r of rows) Object.assign(byId.get(r.Id) || {}, r);
  }
  return ids.map(id => byId.get(id)).filter(Boolean);
}

const OBJ_PERM_FIELDS = "ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, " +
  "PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords";

async function loadCompareData(ids) {
  const list = soqlIdList(ids);
  const optional = p => p.catch(() => []);
  const [sets, objectPerms, tabSettings, appRows] = await Promise.all([
    loadPermSetsWithPerms(ids),
    queryAll(`SELECT ${OBJ_PERM_FIELDS} FROM ObjectPermissions WHERE ParentId IN (${list})`),
    optional(queryAll(`SELECT ParentId, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${list})`)),
    optional(queryAll(`SELECT ParentId, SetupEntityId FROM SetupEntityAccess WHERE ParentId IN (${list}) AND SetupEntityType = 'TabSet'`)),
  ]);
  let appAccess = [];
  const appIds = [...new Set(appRows.map(r => r.SetupEntityId))];
  if (appIds.length) {
    const apps = await optional(queryAll(`SELECT ApplicationId, Label FROM AppMenuItem WHERE ApplicationId IN (${soqlIdList(appIds)})`));
    const label = new Map(apps.map(a => [a.ApplicationId, a.Label]));
    appAccess = appRows.map(r => ({ParentId: r.ParentId, app: label.get(r.SetupEntityId) || r.SetupEntityId}));
  }
  return {sets, objectPerms, tabSettings, appAccess};
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

export {
  loadPermSetList, loadPermFieldNames, loadCompareData, userPermSources,
  objectPermRows, fieldPermRows, systemPermRows, riskyAssignments
};
