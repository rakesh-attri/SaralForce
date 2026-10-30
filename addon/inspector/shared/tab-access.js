// Read what decides whether the running user sees an object's tab in the
// App Launcher, and repair it. Facts come from records (PermissionSetTabSetting,
// ObjectPermissions, PermissionSetAssignment, UserAppMenuItem), i.e. what
// Salesforce actually applies — not from what a metadata write claimed.
import {sfConn, apiVersion} from "../../inspector.js";
import {escapeSoqlString} from "../../core/soql.js";
import {permissionSetNameFor} from "../../core/plan-fields.js";
import {bestTabSetting} from "../../core/tab-access.js";
import {appTabsResolveCurrentUserId} from "./apex-debug.js";

const q = async (soql, {tooling = false} = {}) => {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/${tooling ? "tooling/" : ""}query/?q=` + encodeURIComponent(soql), {useCache: false});
  return res.records || [];
};
const idList = ids => ids.map(id => `'${escapeSoqlString(id)}'`).join(",");

// The user's permission sets, profile-owned one included.
async function myPermissionSets(userId) {
  const rows = await q("SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, " +
    "PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsModifyAllData, PermissionSet.Profile.Name " +
    `FROM PermissionSetAssignment WHERE AssigneeId = '${escapeSoqlString(userId)}'`);
  return rows.map(r => {
    const ps = r.PermissionSet || {};
    return {
      id: r.PermissionSetId,
      label: ps.IsOwnedByProfile ? `profile ${(ps.Profile && ps.Profile.Name) || ps.Label || ""}`.trim() : (ps.Label || ps.Name),
      ownedByProfile: !!ps.IsOwnedByProfile,
      viewAll: !!(ps.PermissionsViewAllData || ps.PermissionsModifyAllData)
    };
  });
}

// opts.appTabs(): async () => string[] | null — tabs on the chosen app.
export async function readTabAccess(objectName, opts = {}) {
  const obj = String(objectName || "").trim();
  // Tab name for standard objects is "standard-Account"; the object is "Account".
  const sobj = obj.replace(/^standard-/, "");
  const notes = [];
  const userId = await appTabsResolveCurrentUserId();
  let sets = [];
  try { sets = await myPermissionSets(userId); } catch (e) { notes.push("assignments: " + e.message); }
  const byId = new Map(sets.map(s => [s.id, s]));
  const ids = sets.map(s => s.id);

  // TabDefinition does not allow OR: filter on the tab name for standard
  // tabs, on the object for custom object tabs.
  const tabWhere = obj !== sobj ? `Name = '${escapeSoqlString(obj)}'` : `SobjectName = '${escapeSoqlString(sobj)}'`;
  let tab = {exists: null, label: ""};
  try {
    const rows = await q(`SELECT Name, Label FROM TabDefinition WHERE ${tabWhere} LIMIT 1`, {tooling: true});
    tab = rows.length ? {exists: true, label: rows[0].Label || rows[0].Name} : {exists: false, label: ""};
  } catch (e) { notes.push("TabDefinition (tooling): " + e.message); }

  let tabSettings = [];
  if (ids.length) {
    try {
      const rows = await q(`SELECT Id, Visibility, ParentId FROM PermissionSetTabSetting WHERE Name = '${escapeSoqlString(obj)}' AND ParentId IN (${idList(ids)})`);
      tabSettings = rows.map(r => {
        const s = byId.get(r.ParentId) || {};
        return {id: r.Id, visibility: r.Visibility, parentId: r.ParentId, parent: s.label || r.ParentId, ownedByProfile: !!s.ownedByProfile};
      });
    } catch (e) { notes.push("PermissionSetTabSetting: " + e.message); }
  }

  let objectPerms = [];
  if (ids.length) {
    try {
      const rows = await q(`SELECT PermissionsRead, ParentId FROM ObjectPermissions WHERE SobjectType = '${escapeSoqlString(sobj)}' AND ParentId IN (${idList(ids)})`);
      objectPerms = rows.map(r => ({read: !!r.PermissionsRead, parent: (byId.get(r.ParentId) || {}).label || r.ParentId}));
    } catch (e) { notes.push("ObjectPermissions: " + e.message); }
  }

  // Available to you = in the App Launcher: the normal-API TabDefinition only
  // returns tabs the running user can open. (UserAppMenuItem lists apps, not
  // object tabs, so it can't answer this.)
  let inLauncher = null;
  try {
    inLauncher = (await q(`SELECT Name FROM TabDefinition WHERE ${tabWhere} LIMIT 1`)).length > 0;
  } catch (e) { notes.push("TabDefinition: " + e.message); }
  // /tabs only when that query could not run.
  if (inLauncher === null) {
    try {
      const tabs = await sfConn.rest(`/services/data/v${apiVersion}/tabs`, {useCache: false});
      inLauncher = (Array.isArray(tabs) ? tabs : []).some(t => (String(t.name || "").toLowerCase() === obj.toLowerCase() || String(t.sobjectName || "").toLowerCase() === sobj.toLowerCase()));
    } catch (e) { notes.push("/tabs: " + e.message); }
  }

  let app = null;
  if (opts.appLabel && opts.appTabs) {
    try {
      const appTabs = await opts.appTabs();
      app = {label: opts.appLabel, onApp: !!(appTabs || []).some(t => String(t).toLowerCase() === obj.toLowerCase())};
    } catch (e) { notes.push("app: " + e.message); }
  }

  return {userId, permissionSets: sets, tab, tabSettings, objectPerms, viewAllData: sets.some(s => s.viewAll), inLauncher, app, notes};
}

const isVisible = facts => {
  const best = bestTabSetting(facts.tabSettings);
  return !!best && (best.visibility === "DefaultOn" || best.visibility === "DefaultOff");
};

// Find or create the "<Object> Access" permission set and assign it to the user.
async function accessPermissionSet(objectName, userId) {
  const {name, label} = permissionSetNameFor(objectName);
  let id = null;
  const found = await q(`SELECT Id FROM PermissionSet WHERE Name = '${escapeSoqlString(name)}' LIMIT 1`);
  if (found.length) id = found[0].Id;
  else {
    const res = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSet`, {
      method: "POST", body: {Name: name, Label: label, Description: `Access to ${objectName}, created by SaralForce`}
    });
    id = res.id;
  }
  try {
    await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetAssignment`, {method: "POST", body: {AssigneeId: userId, PermissionSetId: id}});
  } catch (e) {
    if (!/duplicate|already/i.test(e.message || "")) throw e;
  }
  return {id, label};
}

async function upsertTabSetting(parentId, objectName, existing) {
  if (existing && existing.id) {
    await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetTabSetting/${existing.id}`, {method: "PATCH", body: {Visibility: "DefaultOn"}});
  } else {
    await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetTabSetting`, {
      method: "POST", body: {ParentId: parentId, Name: objectName, Visibility: "DefaultOn"}
    });
  }
}

async function grantObject(parentId, objectName, full) {
  try {
    await sfConn.rest(`/services/data/v${apiVersion}/sobjects/ObjectPermissions`, {
      method: "POST",
      body: {ParentId: parentId, SobjectType: objectName, PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: !!full}
    });
  } catch (e) {
    if (!/duplicate|already exists/i.test(e.message || "")) throw e;
  }
}

// Make the tab visible (and the object readable) for the running user, then
// read it back. Steps, each only when the previous did not stick:
//   1. opts.profileWrite()  — the profile metadata write (caller supplies it)
//   2. PermissionSetTabSetting on the user's profile-owned permission set
//   3. the "<Object> Access" permission set: tab + object access, assigned to the user
// then 4. opts.resaveTab() — save the tab again so the App Launcher picks it up.
// Returns {ok, how, steps, facts}.
export async function ensureTabVisibleForUser(objectName, opts = {}) {
  const steps = [];
  const result = await makeTabVisible(objectName, opts, steps);
  // Salesforce stores API-written tab settings but only recomputes who can see
  // the tab when the tab itself is saved (what Setup → Tabs → Edit → Save
  // does). Save it once, unchanged, then read the facts again.
  if (opts.resaveTab) {
    try {
      if (await opts.resaveTab()) steps.push("tab saved again");
    } catch (e) {
      steps.push("tab re-save: " + e.message);
    }
    result.facts = await readTabAccess(objectName);
  }
  return {...result, steps};
}

async function makeTabVisible(objectName, opts, steps) {
  if (opts.profileWrite) {
    try { await opts.profileWrite(); steps.push("profile metadata: written"); } catch (e) { steps.push("profile metadata: " + e.message); }
  }
  let facts = await readTabAccess(objectName);
  const objOk = f => f.viewAllData || f.objectPerms.some(p => p.read);
  if (isVisible(facts) && objOk(facts)) return {ok: true, how: "your profile", steps, facts};

  const profileSet = facts.permissionSets.find(s => s.ownedByProfile);
  if (profileSet) {
    try {
      if (!isVisible(facts)) {
        await upsertTabSetting(profileSet.id, objectName, facts.tabSettings.find(t => t.parentId === profileSet.id));
        steps.push("profile tab setting: Default On");
      }
      if (!objOk(facts)) {
        await grantObject(profileSet.id, objectName, false);
        steps.push("profile object access: granted");
      }
    } catch (e) {
      steps.push("profile records: " + e.message);
    }
    facts = await readTabAccess(objectName);
    if (isVisible(facts) && objOk(facts)) return {ok: true, how: "your profile (tab setting added by SaralForce)", steps, facts};
  }

  try {
    const ps = await accessPermissionSet(objectName, facts.userId);
    await grantObject(ps.id, objectName, true);
    const existing = (await q(`SELECT Id FROM PermissionSetTabSetting WHERE ParentId = '${escapeSoqlString(ps.id)}' AND Name = '${escapeSoqlString(objectName)}' LIMIT 1`))[0];
    await upsertTabSetting(ps.id, objectName, existing ? {id: existing.Id} : null);
    steps.push(`permission set ${ps.label}: tab + object access, assigned to you`);
  } catch (e) {
    steps.push("permission set: " + e.message);
  }
  facts = await readTabAccess(objectName);
  return {ok: isVisible(facts) && objOk(facts), how: "permission set", steps, facts};
}

// Tab setting for an existing permission set (the "New permission set" field-access option).
export async function setPermissionSetTab(permissionSetId, objectName) {
  const existing = (await q(`SELECT Id FROM PermissionSetTabSetting WHERE ParentId = '${escapeSoqlString(permissionSetId)}' AND Name = '${escapeSoqlString(objectName)}' LIMIT 1`))[0];
  await upsertTabSetting(permissionSetId, objectName, existing ? {id: existing.Id} : null);
}
