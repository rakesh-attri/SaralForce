// Metadata API layout ↔ Salesforce DX source layout (force-app/main/default),
// so releases and snapshots can be committed to Git and a Git branch can be
// deployed. Pure: works on components (deploy.js componentsFromZip shape)
// and plain file maps.
import {TYPE_BY_NAME, METADATA_TYPES, assembleParentFile, componentsFromZip, compKey} from "./deploy.js";

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
  for (const c of comps.values()) {
    for (const [path, text] of Object.entries(c.files)) {
      const raw = c.raw && c.raw[path];
      const hash = path.indexOf("#");
      if (hash >= 0) {
        if (c.type === "CustomLabel") { labels.push(text.trim()); continue; }
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
      const def = TYPE_BY_NAME[c.type];
      // Types without a -meta.xml companion get the suffix added in source format.
      const needsMeta = def && !def.meta && !def.bundle && !path.endsWith("-meta.xml");
      out.set(joinPath(base, needsMeta ? path + "-meta.xml" : path), raw || text);
    }
  }
  if (labels.length) {
    out.set(joinPath(base, "labels/CustomLabels.labels-meta.xml"),
      `${XML_HEAD}<CustomLabels ${NS}>\n    ${labels.join("\n    ")}\n</CustomLabels>\n`);
  }
  return out;
}

const DIRS = new Set(METADATA_TYPES.filter(t => t.dir).map(t => t.dir));

// Source files (Map relPath under base → bytes) → Metadata API files map.
export function sourceToMdapi(files, decode) {
  const mdapi = new Map();
  const objects = new Map(); // name → {parent, children: []}
  const obj = name => {
    if (!objects.has(name)) objects.set(name, {parent: "", children: []});
    return objects.get(name);
  };
  for (const [path, bytes] of files) {
    const parts = path.split("/");
    if (!DIRS.has(parts[0])) continue;
    if (parts[0] === "objects" && parts.length >= 3) {
      const name = parts[1];
      if (parts.length === 3 && parts[2] === `${name}.object-meta.xml`) { obj(name).parent = decode(bytes); continue; }
      const child = CHILD_BY_DIR[parts[2]];
      if (child && parts.length === 4) obj(name).children.push(docToChild(CHILD_SOURCE[child.type][0], decode(bytes)));
      continue;
    }
    if (parts[0] === "labels") {
      mdapi.set("labels/CustomLabels.labels", bytes);
      continue;
    }
    const def = METADATA_TYPES.find(t => t.dir === parts[0]);
    if (def && !def.meta && !def.bundle && path.endsWith("-meta.xml")) mdapi.set(path.replace(/-meta\.xml$/, ""), bytes);
    else mdapi.set(path, bytes);
  }
  for (const [name, o] of objects) {
    const parentInner = o.parent ? o.parent : "";
    mdapi.set(`objects/${name}.object`, assembleParentFile("CustomObject", parentInner, o.children));
  }
  return mdapi;
}

// Source files → components, ready for compare and deploy.
export function componentsFromSource(files, decode) {
  const mdapi = sourceToMdapi(files, decode);
  const enc = new TextEncoder();
  const asBytes = new Map([...mdapi.entries()].map(([p, v]) => [p, typeof v === "string" ? enc.encode(v) : v]));
  return componentsFromZip(asBytes, decode);
}

// Keys of the given types (presets) in a component map.
export function keysOfTypes(comps, types) {
  const want = new Set(types);
  return [...comps.values()].filter(c => want.has(c.type)).map(c => compKey(c.type, c.fullName));
}
