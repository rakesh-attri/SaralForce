// Release Center logic: metadata type catalog, zip ↔ component mapping,
// org compare, package / destructive changes, dependency gaps, test levels
// and deploy result summaries. Pure: no fetch, DOM or chrome access.

import {buildPackageXml} from "./metadata.js";
import {crc32} from "./zip.js";

// ── Metadata type catalog ─────────────────────────────────────────────
// dir / suffix follow the Metadata API (mdapi) zip layout. `meta`: the
// file has a -meta.xml companion. `bundle`: every file in dir/<name>/.
// `folder`: the type lives in folders (listMetadata needs the folder).
// `parent` + `tag`: a child type stored inside its parent's file.
export const METADATA_TYPES = [
  {name: "ApexClass", label: "Apex class", dir: "classes", suffix: "cls", meta: true},
  {name: "ApexTrigger", label: "Apex trigger", dir: "triggers", suffix: "trigger", meta: true},
  {name: "ApexPage", label: "Visualforce page", dir: "pages", suffix: "page", meta: true},
  {name: "ApexComponent", label: "Visualforce component", dir: "components", suffix: "component", meta: true},
  {name: "LightningComponentBundle", label: "LWC", dir: "lwc", bundle: true},
  {name: "AuraDefinitionBundle", label: "Aura component", dir: "aura", bundle: true},
  {name: "StaticResource", label: "Static resource", dir: "staticresources", suffix: "resource", meta: true},
  {name: "Flow", label: "Flow", dir: "flows", suffix: "flow"},
  {name: "CustomObject", label: "Custom object", dir: "objects", suffix: "object"},
  {name: "CustomField", label: "Field", parent: "CustomObject", tag: "fields"},
  {name: "ValidationRule", label: "Validation rule", parent: "CustomObject", tag: "validationRules"},
  {name: "RecordType", label: "Record type", parent: "CustomObject", tag: "recordTypes"},
  {name: "ListView", label: "List view", parent: "CustomObject", tag: "listViews"},
  {name: "WebLink", label: "Button / link", parent: "CustomObject", tag: "webLinks"},
  {name: "CompactLayout", label: "Compact layout", parent: "CustomObject", tag: "compactLayouts"},
  {name: "FieldSet", label: "Field set", parent: "CustomObject", tag: "fieldSets"},
  {name: "BusinessProcess", label: "Business process", parent: "CustomObject", tag: "businessProcesses"},
  {name: "Layout", label: "Page layout", dir: "layouts", suffix: "layout"},
  {name: "FlexiPage", label: "Lightning page", dir: "flexipages", suffix: "flexipage"},
  {name: "QuickAction", label: "Quick action", dir: "quickActions", suffix: "quickAction"},
  {name: "CustomTab", label: "Tab", dir: "tabs", suffix: "tab"},
  {name: "CustomApplication", label: "App", dir: "applications", suffix: "app"},
  {name: "PermissionSet", label: "Permission set", dir: "permissionsets", suffix: "permissionset"},
  {name: "PermissionSetGroup", label: "Permission set group", dir: "permissionsetgroups", suffix: "permissionsetgroup"},
  {name: "Profile", label: "Profile", dir: "profiles", suffix: "profile"},
  {name: "CustomPermission", label: "Custom permission", dir: "customPermissions", suffix: "customPermission"},
  {name: "CustomMetadata", label: "Custom metadata record", dir: "customMetadata", suffix: "md"},
  {name: "CustomLabels", label: "Custom labels file", dir: "labels", suffix: "labels", hidden: true},
  {name: "CustomLabel", label: "Custom label", parent: "CustomLabels", tag: "labels"},
  {name: "GlobalValueSet", label: "Global value set", dir: "globalValueSets", suffix: "globalValueSet"},
  {name: "StandardValueSet", label: "Standard value set", dir: "standardValueSets", suffix: "standardValueSet"},
  {name: "EmailTemplate", label: "Email template", dir: "email", suffix: "email", meta: true, folder: "EmailFolder"},
  {name: "Report", label: "Report", dir: "reports", suffix: "report", folder: "ReportFolder"},
  {name: "Dashboard", label: "Dashboard", dir: "dashboards", suffix: "dashboard", folder: "DashboardFolder"},
  {name: "RemoteSiteSetting", label: "Remote site", dir: "remoteSiteSettings", suffix: "remoteSite"},
  {name: "NamedCredential", label: "Named credential", dir: "namedCredentials", suffix: "namedCredential"},
  {name: "ExternalCredential", label: "External credential", dir: "externalCredentials", suffix: "externalCredential"},
  {name: "ConnectedApp", label: "Connected app", dir: "connectedApps", suffix: "connectedApp"},
  {name: "ApprovalProcess", label: "Approval process", dir: "approvalProcesses", suffix: "approvalProcess"},
  {name: "PathAssistant", label: "Path", dir: "pathAssistants", suffix: "pathAssistant"},
  {name: "DuplicateRule", label: "Duplicate rule", dir: "duplicateRules", suffix: "duplicateRule"},
  {name: "CustomNotificationType", label: "Notification type", dir: "notificationtypes", suffix: "notiftype"},
  {name: "LightningMessageChannel", label: "Message channel", dir: "messageChannels", suffix: "messageChannel"},
  {name: "Queue", label: "Queue", dir: "queues", suffix: "queue"},
  {name: "Group", label: "Public group", dir: "groups", suffix: "group"},
  {name: "Role", label: "Role", dir: "roles", suffix: "role"}
];

export const TYPE_BY_NAME = Object.fromEntries(METADATA_TYPES.map(t => [t.name, t]));
const TYPE_BY_DIR = Object.fromEntries(METADATA_TYPES.filter(t => t.dir).map(t => [t.dir, t]));
const CHILD_TYPES = METADATA_TYPES.filter(t => t.parent);

export function typeLabel(name) {
  return (TYPE_BY_NAME[name] && TYPE_BY_NAME[name].label) || name;
}

export const TYPE_PRESETS = [
  {id: "apex", label: "Apex", types: ["ApexClass", "ApexTrigger", "ApexPage", "ApexComponent"]},
  {id: "ui", label: "LWC & Aura", types: ["LightningComponentBundle", "AuraDefinitionBundle", "StaticResource", "LightningMessageChannel"]},
  {id: "flows", label: "Flows", types: ["Flow"]},
  {id: "objects", label: "Objects & fields", types: ["CustomObject", "CustomField", "ValidationRule", "RecordType", "ListView", "WebLink", "CompactLayout", "FieldSet", "BusinessProcess", "GlobalValueSet"]},
  {id: "pages", label: "Layouts & pages", types: ["Layout", "FlexiPage", "QuickAction", "CustomTab", "CustomApplication", "PathAssistant"]},
  {id: "security", label: "Security", types: ["PermissionSet", "PermissionSetGroup", "CustomPermission", "Profile"]},
  {id: "config", label: "Config & labels", types: ["CustomMetadata", "CustomLabel", "RemoteSiteSetting", "NamedCredential", "ExternalCredential", "CustomNotificationType", "DuplicateRule", "ApprovalProcess"]},
  {id: "content", label: "Email & reports", types: ["EmailTemplate", "Report", "Dashboard"]}
];

export function presetTypes(ids) {
  const out = new Set();
  for (const p of TYPE_PRESETS) if (ids.includes(p.id)) p.types.forEach(t => out.add(t));
  return [...out];
}

// Types listMetadata can be asked for directly (child types live in their
// parent file but are listable by name; CustomLabels is internal only).
export function listableTypes(types) {
  return types.filter(t => TYPE_BY_NAME[t] && !TYPE_BY_NAME[t].hidden);
}

// Groups of at most 3 queries per listMetadata call (API limit).
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// listMetadata rows → only components we can move (skip managed ones).
export function keepListRow(row) {
  if (!row || !row.fullName) return false;
  const st = row.manageableState;
  if (st && st !== "unmanaged") return false;
  if (row.namespacePrefix) return false;
  return true;
}

export function compKey(type, fullName) {
  return type + ":" + fullName;
}

export function splitKey(key) {
  const i = key.indexOf(":");
  return {type: key.slice(0, i), fullName: key.slice(i + 1)};
}

// ── Zip ↔ components ──────────────────────────────────────────────────
// path inside an mdapi zip → {type, fullName} (null for package.xml etc.)
export function pathToComponent(path) {
  const clean = path.replace(/^unpackaged\//, "");
  if (!clean.includes("/")) return null;
  const parts = clean.split("/");
  const t = TYPE_BY_DIR[parts[0]];
  if (!t) return null;
  if (t.bundle) return {type: t.name, fullName: parts[1]};
  let rest = parts.slice(1).join("/").replace(/-meta\.xml$/, "");
  if (t.suffix && rest.endsWith("." + t.suffix)) rest = rest.slice(0, -(t.suffix.length + 1));
  return {type: t.name, fullName: rest};
}

// Top-level child elements of an XML document's root:
// [{tag, start, end}] where start/end index the full element text.
export function topLevelElements(xml) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;
  let depth = 0;
  let cur = null;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    const closing = m[1] === "/";
    const selfClosing = m[3] === "/";
    if (!closing) {
      if (depth === 1 && !cur) cur = {tag: m[2], start: m.index};
      if (selfClosing) {
        if (depth === 1 && cur) { cur.end = re.lastIndex; out.push(cur); cur = null; }
      } else depth++;
    } else {
      depth--;
      if (depth === 1 && cur) { cur.end = re.lastIndex; out.push(cur); cur = null; }
    }
  }
  return out;
}

function innerFullName(text) {
  const m = /<fullName>([^<]*)<\/fullName>/.exec(text);
  return m ? m[1] : "";
}

// Split a parent file (objects/X.object, labels/CustomLabels.labels) into
// the parent plus its child components.
export function splitParentFile(parentType, parentName, xml) {
  const kids = CHILD_TYPES.filter(c => c.parent === parentType);
  const byTag = Object.fromEntries(kids.map(k => [k.tag, k]));
  const els = topLevelElements(xml);
  const children = [];
  let parentText = "";
  let last = 0;
  for (const el of els) {
    const kid = byTag[el.tag];
    if (!kid) continue;
    const text = xml.slice(el.start, el.end);
    const name = innerFullName(text);
    const fullName = parentType === "CustomLabels" ? name : parentName + "." + name;
    children.push({type: kid.name, fullName, text});
    parentText += xml.slice(last, el.start);
    last = el.end;
  }
  parentText += xml.slice(last);
  return {parentText, children};
}

const TEXT_EXT = /\.(cls|trigger|page|component|xml|js|html|css|cmp|app|evt|intf|design|svg|auradoc|tokens|json|txt|email|md|object|layout|flow|labels|[a-zA-Z]+-meta\.xml)$/;

// Zip files (Map path → Uint8Array) → Map(compKey → {type, fullName, files: {path: text}}).
export function componentsFromZip(files, decode) {
  const comps = new Map();
  const add = (type, fullName, path, text, bytes) => {
    const key = compKey(type, fullName);
    if (!comps.has(key)) comps.set(key, {type, fullName, files: {}, raw: {}});
    comps.get(key).files[path] = text;
    if (bytes) comps.get(key).raw[path] = bytes;
  };
  for (const [path, bytes] of files) {
    const c = pathToComponent(path);
    if (!c) continue;
    const isText = TEXT_EXT.test(path) || !/\.[a-z0-9]+$/i.test(path);
    const text = isText ? decode(bytes) : `binary ${bytes.length} bytes, crc ${crc32(bytes).toString(16)}`;
    if (c.type === "CustomObject" || c.type === "CustomLabels") {
      const {parentText, children} = splitParentFile(c.type, c.fullName, text);
      for (const kid of children) add(kid.type, kid.fullName, `${path}#${kid.type}/${kid.fullName}`, kid.text);
      if (c.type === "CustomObject" && hasOwnContent(parentText)) add(c.type, c.fullName, path, parentText);
      continue;
    }
    add(c.type, c.fullName, path, text, bytes);
  }
  return comps;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

// Rebuild a parent file (objects/X.object) from the chosen parts. Top-level
// elements are sorted by tag, the order Salesforce itself writes (and the
// schema order the deploy expects).
export function assembleParentFile(rootTag, parentText, childTexts) {
  const parts = [];
  if (parentText) {
    for (const el of topLevelElements(parentText)) parts.push({tag: el.tag, text: parentText.slice(el.start, el.end)});
  }
  for (const t of childTexts) {
    const m = /^<([A-Za-z_][\w.:-]*)/.exec(t.trim());
    parts.push({tag: m ? m[1] : "", text: t.trim()});
  }
  const sorted = parts.map((p, i) => ({...p, i})).sort((a, b) => a.tag.localeCompare(b.tag) || a.i - b.i);
  return XML_HEAD + `<${rootTag} xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    sorted.map(p => "    " + p.text.trim()).join("\n") + `\n</${rootTag}>\n`;
}

// Zip entries for deploying exactly `keys` from `comps` (componentsFromZip):
// [[path, Uint8Array|string]] incl. package.xml and destructive changes.
export function buildDeployEntries(keys, comps, apiVersion, {destructive = null} = {}) {
  const entries = new Map();
  const parents = new Map(); // parent path → {rootTag, parentText, children[]}
  const included = [];
  for (const key of keys) {
    const c = comps.get(key);
    if (!c) continue;
    included.push(key);
    for (const [path, text] of Object.entries(c.files)) {
      const hash = path.indexOf("#");
      if (hash >= 0) {
        const p = path.slice(0, hash);
        const rootTag = p.startsWith("labels/") ? "CustomLabels" : "CustomObject";
        if (!parents.has(p)) parents.set(p, {rootTag, parentText: "", children: []});
        parents.get(p).children.push(text);
      } else if (c.type === "CustomObject") {
        if (!parents.has(path)) parents.set(path, {rootTag: "CustomObject", parentText: "", children: []});
        parents.get(path).parentText = text;
      } else {
        entries.set(path, (c.raw && c.raw[path]) || text);
      }
    }
  }
  for (const [path, p] of parents) entries.set(path, assembleParentFile(p.rootTag, p.parentText, p.children));
  entries.set("package.xml", buildPackageXml(membersFromKeys(included), apiVersion));
  for (const [path, text] of Object.entries(deployExtraFiles(destructive, apiVersion))) entries.set(path, text);
  return {entries: [...entries.entries()], included};
}

function hasOwnContent(xml) {
  return topLevelElements(xml).length > 0;
}

// Text used to decide Changed vs Same: line endings, trailing spaces,
// blank lines and <packageVersions> (installed package versions) ignored.
export function normalizeForCompare(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/<packageVersions>[\s\S]*?<\/packageVersions>\s*/g, "")
    .split("\n").map(l => l.replace(/\s+$/, "")).filter(l => l.trim() !== "")
    .join("\n");
}

// One comparable text per component (files in path order, with headers
// for multi-file components so the diff shows which file changed).
export function componentText(comp) {
  if (!comp) return "";
  const paths = Object.keys(comp.files).sort();
  if (paths.length === 1) return normalizeForCompare(comp.files[paths[0]]);
  return paths.map(p => `// ── ${p.replace(/#.*$/, "")} ──\n` + normalizeForCompare(comp.files[p])).join("\n");
}

// source / target: Map(compKey → comp). Returns rows sorted by type, name.
// status: "new" (only in source), "deleted" (only in target), "changed", "same".
export function classifyComponents(source, target, {sourceInfo = {}, targetInfo = {}} = {}) {
  const keys = new Set([...source.keys(), ...target.keys()]);
  const rows = [];
  for (const key of keys) {
    const s = source.get(key);
    const t = target.get(key);
    const {type, fullName} = s || t;
    const sText = componentText(s);
    const tText = componentText(t);
    const status = s && !t ? "new" : !s && t ? "deleted" : sText === tText ? "same" : "changed";
    rows.push({key, type, fullName, status, sourceText: sText, targetText: tText,
      source: sourceInfo[key] || null, target: targetInfo[key] || null});
  }
  rows.sort((a, b) => a.type.localeCompare(b.type) || a.fullName.localeCompare(b.fullName));
  return rows;
}

export function compareCounts(rows) {
  const out = {new: 0, changed: 0, deleted: 0, same: 0};
  for (const r of rows) out[r.status]++;
  return out;
}

// ── Package / destructive changes ─────────────────────────────────────
export function membersFromKeys(keys) {
  const out = {};
  for (const key of keys) {
    const {type, fullName} = splitKey(key);
    (out[type] = out[type] || []).push(fullName);
  }
  for (const t of Object.keys(out)) out[t] = [...new Set(out[t])].sort();
  return out;
}

export function keysFromMembers(members) {
  const out = [];
  for (const [type, names] of Object.entries(members || {})) {
    for (const n of names || []) out.push(compKey(type, n));
  }
  return out;
}

export function mergeMembers(...sets) {
  const out = {};
  for (const set of sets) {
    for (const [type, names] of Object.entries(set || {})) {
      out[type] = [...new Set([...(out[type] || []), ...(names || [])])].sort();
    }
  }
  return out;
}

function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// package.xml / destructiveChanges.xml text → {type: [members]}.
export function parsePackageXml(xml) {
  const out = {};
  const re = /<types>([\s\S]*?)<\/types>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const name = (/<name>([^<]*)<\/name>/.exec(m[1]) || [])[1];
    if (!name) continue;
    const members = [...m[1].matchAll(/<members>([^<]*)<\/members>/g)].map(x => xmlUnescape(x[1].trim()));
    out[name.trim()] = [...new Set([...(out[name.trim()] || []), ...members])].sort();
  }
  return out;
}

export function emptyPackageXml(apiVersion) {
  return buildPackageXml({}, apiVersion);
}

// Files for a deploy zip built on top of a retrieved zip: package.xml from
// the retrieve plus destructiveChanges(Post).xml when there are deletes.
export function deployExtraFiles(destructive, apiVersion, {post = true} = {}) {
  const extra = {};
  const count = Object.values(destructive || {}).reduce((n, l) => n + l.length, 0);
  if (count) extra[post ? "destructiveChangesPost.xml" : "destructiveChanges.xml"] = buildPackageXml(destructive, apiVersion);
  return extra;
}

// Retrieves are capped at 10,000 files; keep chunks well under that.
export function chunkMembers(members, size = 2500) {
  const keys = keysFromMembers(members);
  return chunk(keys, size).map(membersFromKeys);
}

// ── Dependency gaps ───────────────────────────────────────────────────
// rows: compare rows; selected: Set(keys). Finds components the selection
// needs that are missing in the target and not selected:
//  - child (field, rule…) of an object that is new in the target;
//  - fields / objects named in selected layouts, permission sets, profiles, tabs;
//  - custom objects and fields named in selected Apex;
//  - extra edges from MetadataComponentDependency ([{from, to}] keys).
export function dependencyGaps(rows, selected, {edges = []} = {}) {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const missing = new Map();
  const isGap = key => {
    const r = byKey.get(key);
    return r && r.status === "new" && !selected.has(key);
  };
  const need = (key, by) => {
    if (!isGap(key)) return;
    if (!missing.has(key)) missing.set(key, new Set());
    missing.get(key).add(by);
  };
  const newFieldsByName = new Map();
  for (const r of rows) {
    if (r.type === "CustomField" && r.status === "new") {
      const f = r.fullName.split(".")[1];
      if (!newFieldsByName.has(f)) newFieldsByName.set(f, []);
      newFieldsByName.get(f).push(r.key);
    }
  }
  for (const key of selected) {
    const r = byKey.get(key);
    if (!r) continue;
    const t = TYPE_BY_NAME[r.type];
    if (t && t.parent === "CustomObject") need(compKey("CustomObject", r.fullName.split(".")[0]), key);
    const text = r.sourceText || "";
    if (r.type === "Layout") {
      const obj = r.fullName.split("-")[0];
      for (const m of text.matchAll(/<field>([^<]+)<\/field>/g)) need(compKey("CustomField", obj + "." + m[1]), key);
    }
    if (r.type === "PermissionSet" || r.type === "Profile") {
      for (const m of text.matchAll(/<field>([^<]+\.[^<]+)<\/field>/g)) need(compKey("CustomField", m[1]), key);
      for (const m of text.matchAll(/<object>([^<]+)<\/object>/g)) need(compKey("CustomObject", m[1]), key);
      for (const m of text.matchAll(/<apexClass>([^<]+)<\/apexClass>/g)) need(compKey("ApexClass", m[1]), key);
      for (const m of text.matchAll(/<tab>([^<]+)<\/tab>/g)) need(compKey("CustomTab", m[1]), key);
    }
    if (r.type === "CustomTab") {
      need(compKey("CustomObject", r.fullName), key);
    }
    if (r.type === "CustomApplication") {
      for (const m of text.matchAll(/<tabs>([^<]+)<\/tabs>/g)) need(compKey("CustomTab", m[1]), key);
    }
    if (r.type === "ApexClass" || r.type === "ApexTrigger") {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const m of new Set([...code.matchAll(/\b([A-Za-z]\w*__(?:c|mdt|e))\b/g)].map(x => x[1]))) {
        need(compKey("CustomObject", m), key);
        const fields = newFieldsByName.get(m) || [];
        if (fields.length === 1) need(fields[0], key);
      }
    }
  }
  for (const e of edges) if (selected.has(e.from)) need(e.to, e.from);
  return [...missing.entries()].map(([key, by]) => ({key, ...splitKey(key), neededBy: [...by]}));
}

// ── Test levels ───────────────────────────────────────────────────────
export const TEST_LEVELS = [
  {id: "Default", label: "Default", hint: "Salesforce decides: no tests in sandboxes, local tests in production when Apex changes"},
  {id: "NoTestRun", label: "No tests", hint: "Fastest; sandboxes and developer orgs only"},
  {id: "RunSpecifiedTests", label: "Specified tests", hint: "Only the test classes you pick (each changed class needs 75% coverage)"},
  {id: "RunLocalTests", label: "Local tests", hint: "Every test in the org except managed packages"},
  {id: "RunAllTestsInOrg", label: "All tests", hint: "Every test, including managed packages (slowest)"}
];

export function allowedTestLevels(isProduction) {
  return TEST_LEVELS.filter(l => !(isProduction && l.id === "NoTestRun"));
}

export function defaultTestLevel(isProduction, hasApex) {
  if (isProduction && hasApex) return "RunLocalTests";
  return isProduction ? "Default" : "NoTestRun";
}

export function hasApexChanges(members) {
  return ["ApexClass", "ApexTrigger"].some(t => (members[t] || []).length > 0);
}

// Test class names that likely cover the changed classes: tests that
// mention a changed class name. tests: [{name, body}].
export function suggestTests(changedClasses, tests) {
  const names = changedClasses.filter(Boolean);
  if (!names.length) return [];
  const res = names.map(n => new RegExp("\\b" + n.replace(/[^\w]/g, "") + "\\b"));
  return tests.filter(t => res.some(re => re.test(t.body || ""))).map(t => t.name).sort();
}

// ── Deploy results ────────────────────────────────────────────────────
function arr(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function bool(x) {
  return x === true || x === "true";
}

// obj: a DeployResult converted to a plain object (see deploy-api.js).
export function summarizeDeployResult(obj) {
  const r = obj || {};
  const details = r.details || {};
  const rtr = details.runTestResult || {};
  const componentFailures = arr(details.componentFailures).map(f => ({
    type: f.componentType || "",
    fullName: f.fullName || "",
    fileName: f.fileName || "",
    line: f.lineNumber ? num(f.lineNumber) : null,
    column: f.columnNumber ? num(f.columnNumber) : null,
    problem: f.problem || "",
    problemType: f.problemType || "Error"
  }));
  const testFailures = arr(rtr.failures).map(f => ({
    className: f.name || "",
    method: f.methodName || "",
    message: f.message || "",
    stackTrace: f.stackTrace || "",
    time: f.time ? num(f.time) : null
  }));
  const coverageWarnings = arr(rtr.codeCoverageWarnings).map(w => ({name: w.name || "", message: w.message || ""}));
  const coverage = arr(rtr.codeCoverage).map(c => {
    const total = num(c.numLocations);
    const notCovered = num(c.numLocationsNotCovered);
    return {name: c.name || "", type: c.type || "Class", total, covered: total - notCovered,
      percent: total ? Math.round(((total - notCovered) / total) * 100) : 100};
  });
  const components = {total: num(r.numberComponentsTotal), deployed: num(r.numberComponentsDeployed), errors: num(r.numberComponentErrors)};
  const tests = {total: num(r.numberTestsTotal), completed: num(r.numberTestsCompleted), errors: num(r.numberTestErrors)};
  const done = bool(r.done);
  const status = r.status || (done ? (bool(r.success) ? "Succeeded" : "Failed") : "Pending");
  const steps = components.total + tests.total;
  const progress = steps ? Math.round(((components.deployed + components.errors + tests.completed + tests.errors) / steps) * 100) : (done ? 100 : 0);
  return {
    id: r.id || "",
    done,
    success: bool(r.success),
    status,
    checkOnly: bool(r.checkOnly),
    stateDetail: r.stateDetail || "",
    errorMessage: r.errorMessage || "",
    components,
    tests,
    progress: Math.min(100, progress),
    componentFailures,
    testFailures,
    coverageWarnings,
    lowCoverage: coverage.filter(c => c.total && c.percent < 75),
    canQuickDeploy: bool(r.checkOnly) && bool(r.success) && status === "Succeeded"
  };
}

// Text sent to AI (no secrets: only component names, problems and traces).
export function failuresForPrompt(summary, {max = 40} = {}) {
  const lines = [];
  if (summary.errorMessage) lines.push("Deploy error: " + summary.errorMessage);
  for (const f of summary.componentFailures.slice(0, max)) {
    lines.push(`Component ${f.type} ${f.fullName}${f.line ? ` line ${f.line}` : ""}: ${f.problem}`);
  }
  for (const t of summary.testFailures.slice(0, max)) {
    lines.push(`Test ${t.className}.${t.method}: ${t.message}\n${String(t.stackTrace).slice(0, 600)}`);
  }
  for (const w of summary.coverageWarnings.slice(0, 20)) lines.push(`Coverage warning ${w.name}: ${w.message}`);
  return lines.join("\n");
}

// Short diff summary for AI release notes (limited size).
export function changesForPrompt(rows, {maxChars = 12000} = {}) {
  let out = "";
  for (const r of rows) {
    const head = `\n## ${r.status.toUpperCase()} ${r.type} ${r.fullName}\n`;
    let body = "";
    if (r.status === "changed") body = briefDiff(r.targetText, r.sourceText);
    else if (r.status === "new") body = String(r.sourceText).slice(0, 600);
    if (out.length + head.length + body.length > maxChars) {
      out += `\n(… ${rows.length} components in total; the rest are omitted)`;
      break;
    }
    out += head + body;
  }
  return out.trim();
}

function briefDiff(before, after) {
  const a = new Set(String(before).split("\n"));
  const b = new Set(String(after).split("\n"));
  const added = [...b].filter(l => !a.has(l)).slice(0, 15).map(l => "+ " + l.trim());
  const removed = [...a].filter(l => !b.has(l)).slice(0, 15).map(l => "- " + l.trim());
  return [...removed, ...added].join("\n");
}

export function isProductionOrg(org) {
  return !!org && org.isSandbox === false;
}
