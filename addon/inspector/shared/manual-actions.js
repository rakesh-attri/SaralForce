// Release Center → Manual steps: the automated ones, run against the target
// org (and read from the source org where the data comes from). Each action
// returns a plain-text log; partial success is reported, never hidden.
import {apiVersion} from "../../inspector.js";
import {metadataReadRecords, metadataUpdateRecords} from "../../builder/metadata-soap.js";
import {domChildren, domLocal, domMakeEl} from "../../builder/metadata-dom.js";
import {baseUsername} from "../../core/manual-steps.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const inList = list => list.map(q).join(",");

async function query(conn, soql, tooling = false) {
  const res = await conn.client.queryAll(soql, {tooling, maxRecords: 5000});
  return res.records || [];
}

function rest(conn, path, opts) {
  return conn.client.request(`/services/data/v${apiVersion}${path}`, {useCache: false, ...opts});
}

function ctxFor(conn) {
  return {conn: {instanceHostname: conn.host, sessionId: conn.sessionId}, apiVersion, delay: sleep};
}

// Insert many records; returns {ok, failed: [messages]}.
async function insertAll(conn, type, rows) {
  let ok = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i += 200) {
    const records = rows.slice(i, i + 200).map(r => ({attributes: {type}, ...r}));
    const res = await rest(conn, "/composite/sobjects", {method: "POST", body: {allOrNone: false, records}});
    for (const r of res || []) {
      if (r.success) ok++;
      else failed.push(((r.errors || [])[0] || {}).message || "failed");
    }
  }
  return {ok, failed};
}

export async function executeAnonymous(conn, code) {
  const res = await rest(conn, "/tooling/executeAnonymous/?anonymousBody=" + encodeURIComponent(code));
  if (!res || !res.compiled) throw new Error(`Line ${res && res.line}: ${res && res.compileProblem || "did not compile"}`);
  if (!res.success) throw new Error(res.exceptionMessage || "Apex failed");
  return res;
}

// ── tabs: save each tab twice (changed, then restored) ────────────────
async function resaveTabs({target, targets}) {
  const ctx = ctxFor(target.conn);
  const log = [];
  for (const name of targets) {
    try {
      const rec = await metadataReadRecords(ctx, "CustomTab", name);
      if (!rec) { log.push(`✗ ${name}: not found in ${target.name}`); continue; }
      const desc = domChildren(rec).find(c => domLocal(c) === "description");
      const original = desc ? desc.textContent : null;
      const base = original || `Tab for ${name.replace(/__c$/, "").replace(/_/g, " ")}`;
      const el = desc || rec.appendChild(domMakeEl(rec.ownerDocument, "description", ""));
      el.textContent = base + " (refresh)";
      await metadataUpdateRecords(ctx, "CustomTab", name, rec);
      if (original === null) rec.removeChild(el); else el.textContent = original;
      await metadataUpdateRecords(ctx, "CustomTab", name, rec);
      log.push(`✓ ${name}: saved again; it now shows for users whose profile or permission set makes it visible`);
    } catch (e) {
      log.push(`✗ ${name}: ${e.message}`);
    }
  }
  return log.join("\n");
}

// ── flows: activate the latest version ───────────────────────────────
async function activateFlows({target, targets}) {
  const defs = await query(target.conn, "SELECT Id, DeveloperName, LatestVersion.VersionNumber, ActiveVersion.VersionNumber " +
    `FROM FlowDefinition WHERE DeveloperName IN (${inList(targets)})`, true);
  const log = [];
  for (const name of targets) {
    const d = defs.find(x => x.DeveloperName === name);
    if (!d) { log.push(`✗ ${name}: not found in ${target.name}`); continue; }
    const latest = d.LatestVersion && d.LatestVersion.VersionNumber;
    const active = d.ActiveVersion && d.ActiveVersion.VersionNumber;
    if (latest && latest === active) { log.push(`✓ ${name}: version ${latest} is already active`); continue; }
    try {
      await rest(target.conn, `/tooling/sobjects/FlowDefinition/${d.Id}`, {method: "PATCH", body: {Metadata: {activeVersionNumber: latest}}});
      log.push(`✓ ${name}: version ${latest} activated` + (active ? ` (was ${active})` : ""));
    } catch (e) {
      log.push(`✗ ${name}: ${e.message}`);
    }
  }
  return log.join("\n");
}

// Flows can only be deleted when no version is active.
export async function activeFlows(conn, names) {
  if (!names.length) return [];
  const defs = await query(conn, "SELECT Id, DeveloperName, ActiveVersion.VersionNumber " +
    `FROM FlowDefinition WHERE DeveloperName IN (${inList(names)})`, true);
  return defs.filter(d => d.ActiveVersion && d.ActiveVersion.VersionNumber);
}

export async function deactivateFlows({target, targets}) {
  const active = await activeFlows(target.conn, targets);
  const log = targets.filter(n => !active.some(d => d.DeveloperName === n)).map(n => `✓ ${n}: not active in ${target.name}`);
  for (const d of active) {
    try {
      await rest(target.conn, `/tooling/sobjects/FlowDefinition/${d.Id}`, {method: "PATCH", body: {Metadata: {activeVersionNumber: 0}}});
      log.push(`✓ ${d.DeveloperName}: deactivated (version ${d.ActiveVersion.VersionNumber} was active)`);
    } catch (e) {
      log.push(`✗ ${d.DeveloperName}: ${e.message}`);
    }
  }
  return log.join("\n");
}

// What can stop a flow delete in an org: active version, paused/waiting runs,
// metadata using it. Feeds flowDeleteReport (core/impact.js).
export async function flowDeleteBlockers(conn, names) {
  if (!names.length) return [];
  const [versions, defs] = await Promise.all([
    query(conn, "SELECT Id, VersionNumber, Status, MasterLabel, Definition.DeveloperName FROM Flow " +
      `WHERE Definition.DeveloperName IN (${inList(names)})`, true),
    query(conn, `SELECT Id, DeveloperName, ActiveVersion.VersionNumber FROM FlowDefinition WHERE DeveloperName IN (${inList(names)})`, true)
  ]);
  const out = names.map(name => {
    const def = defs.find(d => d.DeveloperName === name);
    const vs = versions.filter(v => v.Definition && v.Definition.DeveloperName === name)
      .map(v => ({id: v.Id, number: v.VersionNumber, status: v.Status, label: v.MasterLabel})).sort((a, b) => a.number - b.number);
    return {name, found: !!def || vs.length > 0, defId: def && def.Id, versions: vs,
      active: def && def.ActiveVersion && def.ActiveVersion.VersionNumber || 0,
      interviews: [], interviewsGuessed: false, usedBy: [], notes: []};
  });
  const live = out.filter(f => f.found);
  if (!live.length) return out;
  // Paused or waiting runs keep their version in use.
  try {
    const rows = await query(conn, "SELECT Id, InterviewLabel, InterviewStatus, FlowVersionView.FlowDefinitionView.ApiName FROM FlowInterview " +
      `WHERE FlowVersionView.FlowDefinitionView.ApiName IN (${inList(live.map(f => f.name))})`);
    for (const r of rows) {
      const api = r.FlowVersionView && r.FlowVersionView.FlowDefinitionView && r.FlowVersionView.FlowDefinitionView.ApiName;
      const f = live.find(x => x.name === api);
      if (f) f.interviews.push({label: r.InterviewLabel || r.Id, status: r.InterviewStatus || ""});
    }
  } catch {
    // Older orgs: no link from the run to the flow; match on the label.
    try {
      const rows = await query(conn, "SELECT Id, InterviewLabel FROM FlowInterview");
      for (const f of live) {
        const labels = [...new Set(f.versions.map(v => v.label).filter(Boolean))];
        f.interviews = rows.filter(r => labels.some(l => String(r.InterviewLabel || "").startsWith(l))).map(r => ({label: r.InterviewLabel || r.Id, status: ""}));
        f.interviewsGuessed = f.interviews.length > 0;
      }
    } catch (e) {
      for (const f of live) f.notes.push(`Could not check paused runs: ${e.message}`);
    }
  }
  // Metadata that still uses a version or the definition.
  const ids = new Map();
  for (const f of live) {
    if (f.defId) ids.set(f.defId.slice(0, 15), f);
    for (const v of f.versions) ids.set(v.id.slice(0, 15), f);
  }
  try {
    const keys = [...ids.keys()];
    for (let i = 0; i < keys.length; i += 100) {
      const rows = await query(conn, "SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentId FROM MetadataComponentDependency " +
        `WHERE RefMetadataComponentId IN (${inList(keys.slice(i, i + 100))})`, true);
      for (const r of rows) {
        const f = ids.get(String(r.RefMetadataComponentId || "").slice(0, 15));
        if (!f || (r.MetadataComponentType === "Flow" && r.MetadataComponentName === f.name)) continue;
        if (!f.usedBy.some(u => u.type === r.MetadataComponentType && u.name === r.MetadataComponentName)) {
          f.usedBy.push({type: r.MetadataComponentType, name: r.MetadataComponentName});
        }
      }
    }
  } catch (e) {
    for (const f of live) f.notes.push(`Could not check what uses it: ${e.message}`);
  }
  return out;
}

// Delete flows through the Tooling API, one version at a time (the last
// version removes the flow). Used when the Metadata API delete fails.
export async function deleteFlowsTooling({target, targets}) {
  const found = await flowDeleteBlockers(target.conn, targets);
  const log = [];
  for (const f of found) {
    if (!f.found) { log.push(`✓ ${f.name}: not in ${target.name}`); continue; }
    if (f.active) { log.push(`✗ ${f.name}: version ${f.active} is active; deactivate it first`); continue; }
    let ok = 0;
    for (const v of [...f.versions].reverse()) {
      try {
        await rest(target.conn, `/tooling/sobjects/Flow/${v.id}`, {method: "DELETE"});
        ok++;
      } catch (e) {
        log.push(`✗ ${f.name} v${v.number}: ${e.message}`);
      }
    }
    if (ok === f.versions.length) log.push(`✓ ${f.name}: deleted (${ok} version(s))`);
    else if (ok) log.push(`· ${f.name}: ${ok} of ${f.versions.length} version(s) deleted`);
  }
  return log.join("\n");
}

async function userMap(conn) {
  const users = await query(conn, "SELECT Id, Username FROM User WHERE IsActive = true");
  const exact = new Map(users.map(u => [String(u.Username).toLowerCase(), u.Id]));
  const base = new Map();
  for (const u of users) {
    const b = baseUsername(u.Username);
    base.set(b, base.has(b) ? null : u.Id); // null = two users share it
  }
  return {get: name => {
    const n = String(name || "").toLowerCase();
    if (exact.has(n)) return exact.get(n);
    const b = base.get(baseUsername(n));
    return b || undefined;
  }};
}

// ── permission set / group assignments copied by username ─────────────
async function assignPermsets({source, target, targets}) {
  if (!source) throw new Error("The source org is needed to read who has these permission sets.");
  const sets = targets.filter(t => !/ \(group\)$/.test(t));
  const groups = targets.filter(t => / \(group\)$/.test(t)).map(t => t.replace(/ \(group\)$/, ""));
  const conds = [];
  if (sets.length) conds.push(`PermissionSet.Name IN (${inList(sets)})`);
  if (groups.length) conds.push(`PermissionSetGroup.DeveloperName IN (${inList(groups)})`);
  const src = await query(source.conn, "SELECT Assignee.Username, PermissionSet.Name, PermissionSetGroup.DeveloperName FROM PermissionSetAssignment " +
    `WHERE Assignee.IsActive = true AND (${conds.join(" OR ")})`);
  const users = await userMap(target.conn);
  const tSets = sets.length ? await query(target.conn, `SELECT Id, Name FROM PermissionSet WHERE Name IN (${inList(sets)})`) : [];
  const tGroups = groups.length ? await query(target.conn, `SELECT Id, DeveloperName FROM PermissionSetGroup WHERE DeveloperName IN (${inList(groups)})`) : [];
  const existing = await query(target.conn, "SELECT AssigneeId, PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment " +
    `WHERE PermissionSetId IN (${inList(tSets.map(s => s.Id).concat(["000000000000000"]))}) OR PermissionSetGroupId IN (${inList(tGroups.map(s => s.Id).concat(["000000000000000"]))})`);
  const have = new Set(existing.map(a => a.AssigneeId + ":" + (a.PermissionSetGroupId || a.PermissionSetId)));
  const rows = [];
  const noUser = new Set();
  const missingSet = new Set();
  let already = 0;
  for (const a of src) {
    const groupName = a.PermissionSetGroup && a.PermissionSetGroup.DeveloperName;
    const setName = !groupName && a.PermissionSet && a.PermissionSet.Name;
    const tgt = groupName ? tGroups.find(g => g.DeveloperName === groupName) : tSets.find(s => s.Name === setName);
    if (!tgt) { missingSet.add(groupName || setName); continue; }
    const uid = users.get(baseUsername(a.Assignee && a.Assignee.Username));
    if (!uid) { noUser.add(a.Assignee && a.Assignee.Username); continue; }
    if (have.has(uid + ":" + tgt.Id)) { already++; continue; }
    have.add(uid + ":" + tgt.Id);
    rows.push(groupName ? {AssigneeId: uid, PermissionSetGroupId: tgt.Id} : {AssigneeId: uid, PermissionSetId: tgt.Id});
  }
  const res = rows.length ? await insertAll(target.conn, "PermissionSetAssignment", rows) : {ok: 0, failed: []};
  const log = [`✓ Assigned ${res.ok} · already assigned ${already}`];
  if (res.failed.length) log.push(`✗ Failed ${res.failed.length}: ${[...new Set(res.failed)].slice(0, 3).join("; ")}`);
  if (noUser.size) log.push(`⚠ No matching active user in ${target.name}: ${[...noUser].slice(0, 8).join(", ")}${noUser.size > 8 ? "…" : ""}`);
  if (missingSet.size) log.push(`✗ Not in ${target.name} yet: ${[...missingSet].join(", ")}`);
  if (!src.length) log.push("Nobody has these in the source.");
  return log.join("\n");
}

// ── public group / queue members (users) ─────────────────────────────
async function copyGroupMembers({source, target, targets}) {
  if (!source) throw new Error("The source org is needed to read the members.");
  const src = await query(source.conn, "SELECT Group.DeveloperName, UserOrGroupId FROM GroupMember " +
    `WHERE Group.DeveloperName IN (${inList(targets)})`);
  const userIds = [...new Set(src.map(m => m.UserOrGroupId).filter(id => /^005/.test(id)))];
  const srcUsers = userIds.length ? await query(source.conn, `SELECT Id, Username FROM User WHERE Id IN (${inList(userIds)})`) : [];
  const nameOf = new Map(srcUsers.map(u => [u.Id, u.Username]));
  const users = await userMap(target.conn);
  const tGroups = await query(target.conn, `SELECT Id, DeveloperName FROM Group WHERE DeveloperName IN (${inList(targets)})`);
  const existing = tGroups.length ? await query(target.conn, `SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (${inList(tGroups.map(g => g.Id))})`) : [];
  const have = new Set(existing.map(m => m.GroupId + ":" + m.UserOrGroupId));
  const rows = [];
  const noUser = new Set();
  for (const m of src) {
    if (!/^005/.test(m.UserOrGroupId)) continue;
    const g = tGroups.find(x => x.DeveloperName === (m.Group && m.Group.DeveloperName));
    const uid = users.get(baseUsername(nameOf.get(m.UserOrGroupId)));
    if (!g) continue;
    if (!uid) { noUser.add(nameOf.get(m.UserOrGroupId)); continue; }
    if (!have.has(g.Id + ":" + uid)) { have.add(g.Id + ":" + uid); rows.push({GroupId: g.Id, UserOrGroupId: uid}); }
  }
  const res = rows.length ? await insertAll(target.conn, "GroupMember", rows) : {ok: 0, failed: []};
  return [`✓ Added ${res.ok} member(s)` + (src.some(m => !/^005/.test(m.UserOrGroupId)) ? " (role and group members are left for you)" : ""),
    res.failed.length ? `✗ Failed ${res.failed.length}: ${res.failed[0]}` : "",
    noUser.size ? `⚠ No matching user: ${[...noUser].slice(0, 8).join(", ")}` : ""].filter(Boolean).join("\n");
}

// ── custom setting values (org default, profiles, users) ─────────────
async function copyCustomSettings({source, target, targets}) {
  if (!source) throw new Error("The source org is needed to read the values.");
  const log = [];
  for (const obj of targets) {
    try {
      const d = await target.conn.client.request(`/services/data/v${apiVersion}/sobjects/${obj}/describe`, {useCache: false});
      const fields = (d.fields || []).filter(f => f.custom && f.createable).map(f => f.name);
      if (!(d.fields || []).some(f => f.name === "SetupOwnerId")) {
        // List custom setting: rows matched by Name.
        const rows = await query(source.conn, `SELECT Name, ${fields.join(", ") || "Id"} FROM ${obj}`);
        const have = new Map((await query(target.conn, `SELECT Id, Name FROM ${obj}`)).map(r => [r.Name, r.Id]));
        let created = 0;
        let updated = 0;
        for (const r of rows) {
          const body = Object.fromEntries(fields.map(f => [f, r[f]]));
          if (have.has(r.Name)) { await rest(target.conn, `/sobjects/${obj}/${have.get(r.Name)}`, {method: "PATCH", body}); updated++; }
          else { await rest(target.conn, `/sobjects/${obj}`, {method: "POST", body: {...body, Name: r.Name}}); created++; }
        }
        log.push(`✓ ${obj} (list): ${created} created, ${updated} updated`);
        continue;
      }
      const rows = await query(source.conn, `SELECT SetupOwnerId, SetupOwner.Name, ${fields.concat(["Id"]).join(", ")} FROM ${obj}`);
      const tRows = await query(target.conn, `SELECT Id, SetupOwnerId FROM ${obj}`);
      const tOrg = (await query(target.conn, "SELECT Id FROM Organization"))[0];
      const profiles = new Map((await query(target.conn, "SELECT Id, Name FROM Profile")).map(p => [p.Name, p.Id]));
      const srcUsers = new Map((await query(source.conn, `SELECT Id, Username FROM User WHERE Id IN (${inList(rows.map(r => r.SetupOwnerId).filter(id => /^005/.test(id)).concat(["000000000000000"]))})`)).map(u => [u.Id, u.Username]));
      const users = await userMap(target.conn);
      let created = 0;
      let updated = 0;
      const skipped = [];
      for (const r of rows) {
        const id = r.SetupOwnerId || "";
        const owner = /^00D/.test(id) ? tOrg && tOrg.Id : /^00e/.test(id) ? profiles.get(r.SetupOwner && r.SetupOwner.Name) : users.get(baseUsername(srcUsers.get(id)));
        if (!owner) { skipped.push(r.SetupOwner && r.SetupOwner.Name || id); continue; }
        const body = Object.fromEntries(fields.map(f => [f, r[f]]));
        const existing = tRows.find(t => t.SetupOwnerId === owner);
        if (existing) {
          await rest(target.conn, `/sobjects/${obj}/${existing.Id}`, {method: "PATCH", body});
          updated++;
        } else {
          await rest(target.conn, `/sobjects/${obj}`, {method: "POST", body: {...body, SetupOwnerId: owner}});
          created++;
        }
      }
      log.push(`✓ ${obj}: ${created} created, ${updated} updated` + (skipped.length ? `, skipped ${skipped.slice(0, 5).join(", ")} (no match)` : ""));
    } catch (e) {
      log.push(`✗ ${obj}: ${e.message}`);
    }
  }
  return log.join("\n");
}

// ── scheduled Apex: same class, name and timing as the source ─────────
async function scheduleJobs({source, target, targets}) {
  if (!source) throw new Error("The source org is needed to read the schedules.");
  const jobs = await query(source.conn, "SELECT ApexClass.Name, CronTriggerId FROM AsyncApexJob WHERE JobType = 'ScheduledApex' " +
    `AND Status = 'Queued' AND ApexClass.Name IN (${inList(targets)})`);
  const cronIds = [...new Set(jobs.map(j => j.CronTriggerId).filter(Boolean))];
  const crons = cronIds.length ? await query(source.conn, `SELECT Id, CronExpression, CronJobDetail.Name FROM CronTrigger WHERE Id IN (${inList(cronIds)})`) : [];
  const existing = await query(target.conn, "SELECT CronJobDetail.Name FROM CronTrigger WHERE State != 'DELETED'");
  const taken = new Set(existing.map(c => c.CronJobDetail && c.CronJobDetail.Name));
  const log = [];
  for (const cls of targets) {
    const mine = jobs.filter(j => j.ApexClass && j.ApexClass.Name === cls);
    if (!mine.length) { log.push(`⚠ ${cls}: not scheduled in ${source.name}; schedule it by hand if needed`); continue; }
    for (const j of mine) {
      const c = crons.find(x => x.Id === j.CronTriggerId);
      if (!c) continue;
      const name = c.CronJobDetail && c.CronJobDetail.Name || cls;
      if (taken.has(name)) { log.push(`✓ ${name}: already scheduled in ${target.name}`); continue; }
      try {
        await executeAnonymous(target.conn, `System.schedule(${q(name)}, ${q(c.CronExpression)}, new ${cls.replace(/[^\w.]/g, "")}());`);
        log.push(`✓ ${name}: scheduled (${c.CronExpression})`);
      } catch (e) {
        log.push(`✗ ${name}: ${e.message}`);
      }
    }
  }
  return log.join("\n");
}

// Before a deploy: stop the target's scheduled jobs of these classes.
async function pauseJobs({target, targets}) {
  const jobs = await query(target.conn, "SELECT ApexClass.Name, CronTriggerId FROM AsyncApexJob WHERE JobType = 'ScheduledApex' " +
    `AND Status = 'Queued' AND ApexClass.Name IN (${inList(targets)})`);
  const cronIds = [...new Set(jobs.map(j => j.CronTriggerId).filter(Boolean))];
  if (!cronIds.length) return `✓ No scheduled jobs for ${targets.join(", ")} in ${target.name}; nothing to pause.`;
  const crons = await query(target.conn, `SELECT Id, CronExpression, CronJobDetail.Name FROM CronTrigger WHERE Id IN (${inList(cronIds)})`);
  const log = [];
  for (const c of crons) {
    const name = c.CronJobDetail && c.CronJobDetail.Name || c.Id;
    try {
      await executeAnonymous(target.conn, `System.abortJob(${q(c.Id)});`);
      log.push(`✓ ${name}: stopped (was ${c.CronExpression})`);
    } catch (e) {
      log.push(`✗ ${name}: ${e.message}`);
    }
  }
  log.push("After the deploy, run “Schedule Apex jobs” (or schedule them again with the timing above).");
  return log.join("\n");
}

async function runScript({target, step}) {
  await executeAnonymous(target.conn, step.code || "");
  return "✓ Ran without errors.";
}

const ACTIONS = {
  "tab-launcher": resaveTabs,
  "flow-activate": activateFlows,
  "permset-assign": assignPermsets,
  "group-members": copyGroupMembers,
  "custom-settings": copyCustomSettings,
  "schedule-jobs": scheduleJobs,
  "pause-jobs": pauseJobs,
  "flow-deactivate": deactivateFlows,
  "script": runScript
};

// What "Run" will change, shown in the confirm dialog.
export const ACTION_EFFECT = {
  "tab-launcher": "saves each tab twice (description changed, then restored)",
  "flow-activate": "activates the latest version of each flow",
  "permset-assign": "creates permission set assignments for matching users",
  "group-members": "adds matching users to the groups and queues",
  "custom-settings": "creates or updates custom setting values",
  "schedule-jobs": "schedules the Apex classes",
  "pause-jobs": "stops (aborts) the scheduled jobs of these classes in the target",
  "flow-deactivate": "deactivates these flows in the target (no version stays active)",
  "script": "runs the anonymous Apex"
};

export function hasAction(id) {
  return !!ACTIONS[id];
}

export async function runAction(step, {source, target}) {
  const fn = ACTIONS[step.id];
  if (!fn) throw new Error("This step is done by hand.");
  return fn({step, source, target, targets: step.targets || []});
}
