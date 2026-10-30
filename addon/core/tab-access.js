// Can the running user find an object's tab in the App Launcher? Pure
// interpretation of facts read from the org (see inspector/shared/tab-access.js):
//   tab          {exists, label}
//   tabSettings  [{visibility, parent, ownedByProfile}]   PermissionSetTabSetting rows
//   objectPerms  [{read, parent}]                        ObjectPermissions rows
//   viewAllData  true when a profile / permission set grants View or Modify All Data
//   inLauncher   true / false / null (unknown)           UserAppMenuItem or /tabs
//   app          {label, onApp} | null                    chosen Lightning app

export function bestTabSetting(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find(r => r.visibility === "DefaultOn") ||
    list.find(r => r.visibility === "DefaultOff") || list[0] || null;
}

export function explainTabAccess(facts) {
  const f = facts || {};
  const items = [];
  // exists null = could not check (not counted as missing).
  const tabOk = !!f.tab && f.tab.exists !== false;
  items.push({
    key: "tab", ok: tabOk, label: "Tab exists",
    detail: !tabOk ? "The object has no tab yet." : f.tab.exists === null ? "Could not check — assumed present." : (f.tab.label || ""),
    fix: tabOk ? null : "create-tab"
  });
  const best = bestTabSetting(f.tabSettings);
  const visible = !!best && (best.visibility === "DefaultOn" || best.visibility === "DefaultOff");
  items.push({
    key: "visible", ok: visible, label: "Tab visible to you",
    detail: visible
      ? `${best.visibility === "DefaultOn" ? "Default On" : "Default Off (available)"} via ${best.ownedByProfile ? "your profile" : `permission set ${best.parent}`}`
      : best ? `Hidden on ${best.ownedByProfile ? "your profile" : best.parent}` : "No tab setting on your profile or permission sets (Salesforce treats it as hidden).",
    fix: visible ? null : "make-visible"
  });
  const permRow = (f.objectPerms || []).find(r => r.read);
  const objOk = !!permRow || !!f.viewAllData;
  items.push({
    key: "object", ok: objOk, label: "Object access",
    detail: permRow ? `Read via ${permRow.parent}` : f.viewAllData ? "View All Data" : "No Read access to the object.",
    fix: objOk ? null : "grant-object"
  });
  if (f.inLauncher !== null && f.inLauncher !== undefined) {
    items.push({
      key: "launcher", ok: !!f.inLauncher, label: "In your App Launcher",
      detail: f.inLauncher ? "Search for it in the 9 dots (refresh Salesforce once)."
        : (tabOk && visible && objOk) ? "Settings are right but Salesforce has not applied them yet — use Fix it; if it stays ✕, Save in Setup opens the tab's edit page: click Save there."
          : "Fix the items above first.",
      fix: f.inLauncher ? null : "resave-tab"
    });
  }
  if (f.app) {
    items.push({
      key: "app", ok: !!f.app.onApp, label: `In app "${f.app.label}"`,
      detail: !f.app.onApp ? "Not on this app's navigation bar."
        : f.inLauncher === false ? "Added to the app — it shows in the nav bar once the tab is available to you (item above)."
          : "On the app. Not in your nav bar? If you personalized this app's nav bar, add it with the pencil (Edit) at the end of the nav bar.",
      fix: f.app.onApp ? null : "add-to-app"
    });
  }
  return {ok: items.every(i => i.ok), items};
}

// Plain text of the facts, for "Copy details".
export function tabAccessReport(objectName, facts, result) {
  const lines = [`Object: ${objectName}`];
  for (const i of (result || explainTabAccess(facts)).items) lines.push(`${i.ok ? "OK " : "NO "} ${i.label} — ${i.detail}`);
  lines.push("", "Tab settings: " + JSON.stringify((facts && facts.tabSettings) || []));
  lines.push("Object permissions: " + JSON.stringify((facts && facts.objectPerms) || []));
  lines.push(`View All Data: ${!!(facts && facts.viewAllData)}  In launcher: ${facts && facts.inLauncher}`);
  if (facts && facts.notes && facts.notes.length) lines.push("Notes: " + facts.notes.join(" | "));
  return lines.join("\n");
}
