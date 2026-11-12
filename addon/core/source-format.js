// Metadata API layout ↔ Salesforce DX source layout (force-app/main/default),
// so releases and snapshots can be committed to Git and a Git branch can be
// deployed. Pure: works on components (deploy.js componentsFromZip shape)
// and plain file maps.
import {TYPE_BY_NAME, METADATA_TYPES, assembleParentFile, componentsFromZip, compKey, pathToComponent} from "./deploy.js";

// Parent files kept whole in source format (workflows, sharing rules…):
// their children are put back into one file.
const WHOLE_PARENTS = new Set(["Workflow", "SharingRules", "AssignmentRules", "AutoResponseRules", "EscalationRules", "MatchingRules"]);
import {writeZip} from "./zip.js";

// Folder meta files: mdapi "reports/Sales-meta.xml" ↔ DX "reports/Sales.reportFolder-meta.xml".
const FOLDER_SUFFIX = {reports: "reportFolder", dashboards: "dashboardFolder", email: "emailFolder", documents: "documentFolder"};

// Child types of objects: source folder and file suffix.
const CHILD_SOURCE = {
  CustomField: ["fields", "field"],
  ValidationRule: ["validationRules", "validationRule"],
  RecordType: ["recordTypes", "recordType"],
  ListView: ["listViews", "listView"],
  WebLink: ["webLinks", "webLink"],
  CompactLayout: ["compactLayouts", "compactLayout"],
  FieldSet: ["fieldSets", "fieldSet"],
  BusinessProcess: ["businessProcesses", "businessProcess"]
};
const CHILD_BY_DIR = Object.fromEntries(Object.entries(CHILD_SOURCE).map(([t, [dir, suffix]]) => [dir, {type: t, suffix}]));

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

function joinPath(base, rel) {
  const b = String(base || "").replace(/^\/+|\/+$/g, "");
  return b ? b + "/" + rel : rel;
}

// <fields>…</fields> → full CustomField document, and back.
function childToDoc(type, text) {
  const inner = String(text).trim().replace(/^<[\w]+>/, "").replace(/<\/[\w]+>$/, "");
  return `${XML_HEAD}<${type} ${NS}>${inner}</${type}>\n`;
}

function docToChild(tag, xml) {
  const body = String(xml).replace(/^\s*<\?xml[^>]*\?>\s*/, "").trim();
  const inner = body.replace(/^<[\w]+[^>]*>/, "").replace(/<\/[\w]+>\s*$/, "");
  return `<${tag}>${inner}</${tag}>`;
}

// comps → Map(sourcePath → string | Uint8Array)
export function toSourceFiles(comps, base = "force-app/main/default") {
  const out = new Map();
  const labels = [];
  const wholes = new Map(); // mdapi parent path → {type, parentText, children[]}
  for (const c of comps.values()) {
    for (const [path, text] of Object.entries(c.files)) {
      const raw = c.raw && c.raw[path];
      const hash = path.indexOf("#");
      if (hash >= 0) {
        if (c.type === "CustomLabel") { labels.push(text.trim()); continue; }
        const parentType = TYPE_BY_NAME[c.type] && TYPE_BY_NAME[c.type].parent;
        if (WHOLE_PARENTS.has(parentType)) {
          const p = path.slice(0, hash);
          if (!wholes.has(p)) wholes.set(p, {type: parentType, parentText: "", children: []});
          wholes.get(p).children.push(text);
          continue;
        }
        const map = CHILD_SOURCE[c.type];
        if (!map) continue;
        const [obj, name] = c.fullName.split(".");
        out.set(joinPath(base, `objects/${obj}/${map[0]}/${name}.${map[1]}-meta.xml`), childToDoc(c.type, text));
        continue;
      }
      if (c.type === "CustomObject") {
        out.set(joinPath(base, `objects/${c.fullName}/${c.fullName}.object-meta.xml`), text);
        continue;
      }
      if (WHOLE_PARENTS.has(c.type)) {
        if (!wholes.has(path)) wholes.set(path, {type: c.type, parentText: "", children: []});
        wholes.get(path).parentText = text;
        continue;
      }
      const def = TYPE_BY_NAME[c.type];
      const dir = path.split("/")[0];
      if (def && def.folder && FOLDER_SUFFIX[dir] && /^[^/]+\/[^/]+-meta\.xml$/.test(path) && !c.fullName.includes("/")) {
        out.set(joinPath(base, path.replace(/-meta\.xml$/, `.${FOLDER_SUFFIX[dir]}-meta.xml`)), raw || text);
        continue;
      }
      // Types without a -meta.xml companion get the suffix added in source format.
      const needsMeta = def && !def.meta && !def.bundle && !path.endsWith("-meta.xml");
      out.set(joinPath(base, needsMeta ? path + "-meta.xml" : path), raw || text);
    }
  }
  for (const [p, w] of wholes) out.set(joinPath(base, p + "-meta.xml"), assembleParentFile(w.type, w.parentText, w.children));
  if (labels.length) {
    out.set(joinPath(base, "labels/CustomLabels.labels-meta.xml"),
      `${XML_HEAD}<CustomLabels ${NS}>\n    ${labels.join("\n    ")}\n</CustomLabels>\n`);
  }
  return out;
}

// Files that live in a component folder in Git but are not part of the
// bundle (Jest tests and mocks, editor and lint config): Salesforce rejects
// them. The same files the default .forceignore of an SFDX project excludes.
// .forceignore (gitignore syntax, paths from the project root) → path => ignored?
// Supports comments, blank lines, "!" negation, "*", "?", "**/", a leading "/"
// (anchored) and a trailing "/" (folders only). The last matching rule wins.
export function forceIgnoreMatcher(text) {
  const rules = [];
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const neg = line.startsWith("!");
    if (neg) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\//, "");
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "*" && line[i + 1] === "*") {
        if (line[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; }
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += /[a-zA-Z0-9_/-]/.test(c) ? c : "\\" + c;
    }
    rules.push({neg, re: new RegExp((anchored ? "^" : "(?:^|/)") + re + (dirOnly ? "/" : "(?:/|$)"))});
  }
  if (!rules.length) return () => false;
  return path => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.neg;
    return ignored;
  };
}

export function isLocalOnlyFile(path) {
  const parts = String(path).split("/");
  if (parts[0] !== "lwc" && parts[0] !== "aura") return false;
  const file = parts[parts.length - 1];
  return parts.includes("__tests__") || parts.includes("__mocks__") || file === "jsconfig.json" || file === ".eslintrc.json";
}

// Folders of known types (grows when the org's types are loaded).
const isTypeDir = dir => METADATA_TYPES.some(t => t.dir === dir);

// Source files (Map relPath under base → bytes) → Metadata API files map.
// ignore: path (relative to the files) => true to leave it out (.forceignore).
// mdapi.skipped: object subfolders that aren't a known child type (dropped).
export function sourceToMdapi(files, decode, {ignore = null} = {}) {
  const mdapi = new Map();
  mdapi.skipped = [];
  mdapi.ignored = 0;
  const resourceDirs = new Map(); // name → Map(inner path → bytes)
  const objects = new Map(); // name → {parent, children: []}
  const obj = name => {
    if (!objects.has(name)) objects.set(name, {parent: "", children: []});
    return objects.get(name);
  };
  for (const [path, bytes] of files) {
    const parts = path.split("/");
    if (!isTypeDir(parts[0])) continue;
    if (isLocalOnlyFile(path)) continue;
    if (ignore && ignore(path)) { mdapi.ignored++; continue; }
    if (parts[0] === "objects" && parts.length >= 3) {
      const name = parts[1];
      if (parts.length === 3 && parts[2] === `${name}.object-meta.xml`) { obj(name).parent = decode(bytes); continue; }
      const child = CHILD_BY_DIR[parts[2]];
      if (child && parts.length === 4) obj(name).children.push(docToChild(CHILD_SOURCE[child.type][0], decode(bytes)));
      else mdapi.skipped.push(path);
      continue;
    }
    if (parts[0] === "labels") {
      mdapi.set("labels/CustomLabels.labels", bytes);
      continue;
    }
    if (parts[0] === "staticresources") {
      // DX keeps the content as Name.<ext> or an expanded Name/ folder.
      if (parts.length > 2) {
        if (!resourceDirs.has(parts[1])) resourceDirs.set(parts[1], new Map());
        resourceDirs.get(parts[1]).set(parts.slice(2).join("/"), bytes);
      } else if (path.endsWith(".resource-meta.xml")) mdapi.set(path, bytes);
      else mdapi.set(`staticresources/${parts[1].replace(/\.[^.]+$/, "")}.resource`, bytes);
      continue;
    }
    const folderSuffix = FOLDER_SUFFIX[parts[0]];
    if (folderSuffix && parts.length === 2 && path.endsWith(`.${folderSuffix}-meta.xml`)) {
      mdapi.set(path.replace(`.${folderSuffix}-meta.xml`, "-meta.xml"), bytes);
      continue;
    }
    const def = METADATA_TYPES.find(t => t.dir === parts[0]);
    if (def && !def.meta && !def.bundle && path.endsWith("-meta.xml")) mdapi.set(path.replace(/-meta\.xml$/, ""), bytes);
    else mdapi.set(path, bytes);
  }
  for (const [name, inner] of resourceDirs) mdapi.set(`staticresources/${name}.resource`, writeZip(inner));
  for (const [name, o] of objects) {
    const parentInner = o.parent ? o.parent : "";
    mdapi.set(`objects/${name}.object`, assembleParentFile("CustomObject", parentInner, o.children));
  }
  return mdapi;
}

// Source files → components, ready for compare and deploy.
// comps.skipped / comps.ignored: as sourceToMdapi reports them.
export function componentsFromSource(files, decode, opts = {}) {
  const mdapi = sourceToMdapi(files, decode, opts);
  const enc = new TextEncoder();
  const asBytes = new Map([...mdapi.entries()].map(([p, v]) => [p, typeof v === "string" ? enc.encode(v) : v]));
  const comps = componentsFromZip(asBytes, decode);
  comps.skipped = mdapi.skipped;
  comps.ignored = mdapi.ignored;
  return comps;
}

// Keys of the given types (presets) in a component map.
export function keysOfTypes(comps, types) {
  const want = new Set(types);
  return [...comps.values()].filter(c => want.has(c.type)).map(c => compKey(c.type, c.fullName));
}

// The component a DX path belongs to ({type, fullName}) or null.
export function sourcePathType(rel) {
  const parts = String(rel).split("/");
  if (parts[0] === "objects" && parts.length >= 3) {
    if (parts.length === 3) return {type: "CustomObject", fullName: parts[1]};
    const child = CHILD_BY_DIR[parts[2]];
    if (child && parts.length === 4) return {type: child.type, fullName: parts[1] + "." + parts[3].replace(/\.[^.]+-meta\.xml$/, "")};
    return null;
  }
  if (parts[0] === "labels") return {type: "CustomLabel", fullName: "*"};
  if (parts[0] === "staticresources" && parts.length >= 2) return {type: "StaticResource", fullName: parts[1].replace(/\.resource-meta\.xml$/, "").replace(/\.[^.]+$/, "")};
  const folderSuffix = FOLDER_SUFFIX[parts[0]];
  if (folderSuffix && parts.length === 2 && rel.endsWith(`.${folderSuffix}-meta.xml`)) {
    const def = METADATA_TYPES.find(t => t.dir === parts[0]);
    return def ? {type: def.name, fullName: parts[1].replace(`.${folderSuffix}-meta.xml`, "")} : null;
  }
  const def = METADATA_TYPES.find(t => t.dir === parts[0]);
  const mdapi = def && !def.meta && !def.bundle ? rel.replace(/-meta\.xml$/, "") : rel;
  return pathToComponent(mdapi);
}
