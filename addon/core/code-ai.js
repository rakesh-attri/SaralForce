// Pure helpers for AI-written Apex classes, triggers, Visualforce pages and
// Aura components (LWC has its own in lwc-ai.js): which files a kind may
// contain, mapping the model's JSON to draft files, and pre-deploy checks.
// No chrome/window/DOM access so they can be unit-tested.

export const AI_CODE_KINDS = ["apex", "triggers", "pages", "aura"];

const CLASS_PATH = /^classes\/([A-Za-z][A-Za-z0-9_]{0,39})\.cls$/;
const AURA_FILES = [
  ["Controller.js", "CONTROLLER", "JS", "js"], ["Helper.js", "HELPER", "JS", "js"], ["Renderer.js", "RENDERER", "JS", "js"],
  [".cmp", "COMPONENT", "XML", "markup"], [".css", "STYLE", "CSS", "css"], [".design", "DESIGN", "XML", "markup"],
  [".svg", "SVG", "SVG", "markup"], [".auradoc", "DOCUMENTATION", "XML", "markup"],
];

// Extra Apex classes: tests go after a new class; handlers/controllers a
// trigger, page or component needs go before it.
export function classRole(kind) {
  return kind === "apex" ? "extra" : kind === "triggers" ? "handler" : "apex";
}

// The main file every draft of this kind must have.
export function mainPath(kind, name) {
  if (kind === "apex") return `classes/${name}.cls`;
  if (kind === "triggers") return `triggers/${name}.trigger`;
  if (kind === "pages") return `pages/${name}.page`;
  if (kind === "aura") return `aura/${name}/${name}.cmp`;
  return null;
}

// Paths the model is told to use (shown in the prompt).
export function expectedPaths(kind, name) {
  const extra = "classes/<ClassName>.cls";
  if (kind === "apex") return [mainPath(kind, name), `${extra} (optional, e.g. ${name}Test)`];
  if (kind === "triggers") return [mainPath(kind, name), `${extra} (handler class, recommended)`];
  if (kind === "pages") return [mainPath(kind, name), `${extra} (controller or extension, only if needed)`];
  return [`aura/${name}/${name}.cmp`, `aura/${name}/${name}Controller.js`, `aura/${name}/${name}Helper.js (optional)`,
    `aura/${name}/${name}.css (optional)`, `aura/${name}/${name}.design (optional)`, `${extra} (Apex controller, only if needed)`];
}

function clean(s) {
  const t = typeof s === "string" ? s.replace(/\r\n/g, "\n") : "";
  return t && !t.endsWith("\n") ? t + "\n" : t;
}

// One draft file for an allowed path of this kind, or null.
function fileFor(kind, name, path, content) {
  const body = clean(content);
  if (!body.trim()) return null;
  const cls = CLASS_PATH.exec(path);
  if (path === mainPath(kind, name) && kind !== "aura") {
    return {path, lang: kind === "pages" ? "markup" : "apex", content: body};
  }
  if (cls) {
    if (kind === "apex" && cls[1] === name) return {path, lang: "apex", content: body};
    return {path, lang: "apex", format: "apex", role: classRole(kind), name: cls[1], content: body};
  }
  if (kind === "aura" && path.startsWith(`aura/${name}/${name}`)) {
    const rest = path.slice(`aura/${name}/${name}`.length);
    const def = AURA_FILES.find(([suffix]) => rest === suffix);
    if (def) return {path, defType: def[1], format: def[2], lang: def[3], content: body};
  }
  return null;
}

// Model reply → draft files. Accepts files as [{path, content}] or
// {path: content}; anything outside the kind's allowed paths is dropped.
export function normalizeCodeReply(kind, reply, name) {
  const raw = reply && reply.files;
  const pairs = Array.isArray(raw)
    ? raw.map(x => [String((x && x.path) || ""), x && (x.content || x.body)])
    : raw && typeof raw === "object" ? Object.entries(raw) : [];
  const out = [];
  for (const [path, content] of pairs) {
    const f = fileFor(kind, name, path.trim().replace(/^\/+/, ""), content);
    if (f && !out.some(x => x.path === f.path)) out.push(f);
  }
  const main = mainPath(kind, name);
  out.sort((a, b) => (a.path === main ? -1 : b.path === main ? 1 : (a.role ? 1 : 0) - (b.role ? 1 : 0)));
  return out;
}

// Strip strings and comments so brace counting ignores them.
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"");
}

function balanced(src) {
  let depth = 0;
  for (const c of codeOnly(src)) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// Problems that would make the draft fail to save. Empty = OK.
export function checkCodeBundle(kind, files, name, form = {}) {
  const problems = [];
  const main = files.find(x => x.path === mainPath(kind, name));
  const short = p => p.split("/").pop();
  if (!main) problems.push(`Missing ${mainPath(kind, name)}.`);
  for (const f of files.filter(x => CLASS_PATH.test(x.path))) {
    const cls = CLASS_PATH.exec(f.path)[1];
    if (!new RegExp(`\\b(class|interface|enum)\\s+${cls}\\b`, "i").test(codeOnly(f.content))) problems.push(`${short(f.path)} must declare class ${cls}.`);
    if (!balanced(f.content)) problems.push(`${short(f.path)} has unbalanced braces.`);
  }
  if (main && kind === "triggers") {
    const m = /\btrigger\s+([A-Za-z0-9_]+)\s+on\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/i.exec(main.content);
    if (!m) problems.push(`The trigger must start with: trigger ${name} on ${form.object || "<Object>"} (<events>).`);
    else {
      if (m[1] !== name) problems.push(`The trigger must be named ${name}.`);
      if (form.object && m[2].toLowerCase() !== String(form.object).toLowerCase()) problems.push(`The trigger must be on ${form.object}.`);
    }
    if (!balanced(main.content)) problems.push(`${short(main.path)} has unbalanced braces.`);
  }
  if (main && kind === "pages" && !/^\s*(<!--[\s\S]*?-->\s*)*<apex:page[\s>]/.test(main.content)) problems.push("The page must start with <apex:page>.");
  if (main && kind === "aura") {
    if (!/^\s*(<!--[\s\S]*?-->\s*)*<aura:component[\s>]/.test(main.content)) problems.push("The .cmp must start with <aura:component>.");
    const ctrl = /\bcontroller\s*=\s*"([A-Za-z0-9_]+)"/.exec(main.content);
    const returned = files.filter(x => x.role).map(x => x.name);
    if (ctrl && form.knownClasses && !returned.includes(ctrl[1]) && !form.knownClasses.includes(ctrl[1])) {
      problems.push(`The component uses controller="${ctrl[1]}" but that Apex class was not returned.`);
    }
    for (const f of files.filter(x => x.format === "JS")) {
      if (!/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\(\s*\{/.test(f.content)) problems.push(`${short(f.path)} must be an object literal wrapped in ({ … }).`);
      if (!balanced(f.content)) problems.push(`${short(f.path)} has unbalanced braces.`);
    }
  }
  return problems;
}
