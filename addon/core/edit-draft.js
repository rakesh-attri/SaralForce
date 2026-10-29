// Pure helpers for editing EXISTING metadata in the draft editor: turning
// org source into an edit draft, working out what changed, and reading
// compile results. No chrome/window/DOM access so they can be unit-tested.

export const EDITABLE_KINDS = ["apex", "triggers", "pages", "lwc", "aura"];

// Kinds saved through a MetadataContainer (compiled server-side; the
// Tooling API refuses these in production orgs).
export const CONTAINER_MEMBER = {apex: "ApexClassMember", triggers: "ApexTriggerMember", pages: "ApexPageMember"};

export const SANDBOX_ONLY_NOTE = "Apex classes and triggers can only be changed this way in sandboxes and developer orgs.";

const AURA_SUFFIX = {
  COMPONENT: ".cmp", APPLICATION: ".app", EVENT: ".evt", INTERFACE: ".intf", TOKENS: ".tokens",
  CONTROLLER: "Controller.js", HELPER: "Helper.js", RENDERER: "Renderer.js", STYLE: ".css",
  DESIGN: ".design", SVG: ".svg", DOCUMENTATION: ".auradoc",
};

function langForPath(path) {
  if (/\.(cls|trigger)$/.test(path)) return "apex";
  if (/\.js$/.test(path)) return "js";
  if (/\.css$/.test(path)) return "css";
  return "markup";
}

export function auraPath(name, defType) {
  return `aura/${name}/${name}${AURA_SUFFIX[defType] || "." + String(defType || "txt").toLowerCase()}`;
}

// Org source → edit draft. row: the list row (Id, Name/DeveloperName,
// LastModifiedDate, TableEnumOrId…). files: [{path, content, resourceId?,
// format?, defType?, readOnly?}] as loaded from the org.
export function editDraftFromSource(kind, row, files) {
  const name = row.Name || row.DeveloperName;
  const title = kind === "apex" ? `${name}.cls` : kind === "triggers" ? `${name}.trigger` : kind === "pages" ? `${name}.page` : name;
  return {
    id: `e${String(row.Id).slice(-8)}${Date.now().toString(36)}`,
    mode: "edit",
    kind,
    name,
    title,
    existing: {id: row.Id, lastModified: row.LastModifiedDate || null},
    form: {object: row.TableEnumOrId || undefined, apiVersion: row.ApiVersion ? String(row.ApiVersion) : undefined, label: row.MasterLabel || undefined},
    createdAt: Date.now(),
    files: files.map(f => ({...f, lang: f.lang || langForPath(f.path), original: f.content})),
  };
}

// Files to send on save: changed ones that already exist in the org, and
// files the editor or AI added (no original). Read-only files never count.
export function changedFiles(draft) {
  return draft.files.filter(f => !f.readOnly && !f.generated && (f.original == null || f.content !== f.original));
}

// New Apex classes added to an edit draft (by AI) are created, not updated.
export function newApexClasses(draft) {
  return changedFiles(draft).filter(f => f.original == null && /^classes\/[A-Za-z][A-Za-z0-9_]*\.cls$/.test(f.path));
}

// ContainerAsyncRequest → {done, ok, errors: ["File line N: problem"]}.
export function readCompileResult(req) {
  const state = req && req.State;
  if (!state || state === "Queued") return {done: false, ok: false, errors: []};
  if (state === "Completed") return {done: true, ok: true, errors: []};
  const details = (req.DeployDetails && (req.DeployDetails.componentFailures || req.DeployDetails.allComponentMessages)) || [];
  const errors = [].concat(details)
    .filter(d => d && (d.problem || d.problemType === "Error"))
    .map(d => `${d.fileName || d.fullName || "Source"}${d.lineNumber ? ` line ${d.lineNumber}` : ""}${d.columnNumber ? `:${d.columnNumber}` : ""}: ${d.problem || "error"}`);
  if (!errors.length && req.ErrorMsg) errors.push(req.ErrorMsg);
  if (!errors.length) errors.push(`Save ${state.toLowerCase()} without details.`);
  return {done: true, ok: false, errors};
}

// MetadataContainer names must be unique and at most 32 characters.
export function containerName(now = Date.now()) {
  return ("SaralForce_" + now.toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 32);
}
