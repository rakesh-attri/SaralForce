// Deploy / validation failures → a few root causes, each with a plain
// explanation, a fix and (when SaralForce can) an action. Pure.
//
// One Salesforce cause often fails dozens of rows: a Lightning component that
// calls a missing Apex class reports it once per reference. Rows with the same
// cause become one group; a group whose missing item itself failed in this
// deploy is a knock-on of that item's group.
import {compKey, typeLabel} from "./deploy.js";

export const CATEGORIES = {
  missing: "Missing dependency",
  reference: "Missing user or record",
  compile: "Apex compile error",
  feature: "Org feature or setting",
  change: "Can't change in place",
  access: "Access or lock",
  conflict: "Name conflict",
  package: "Package problem",
  other: "Other"
};

// Types that are data or setup records, not metadata a deploy can carry.
const RECORD_TYPES = new Set(["User", "Group", "Queue", "Role", "UserRole", "BusinessHours", "Organization", "Community", "Network", "Folder", "RecordType"]);

const MISSING_FIX = "Add it to this deploy (Apex with its test class), or deploy it to the target first.";

// Words Salesforce uses for a type in "Page X does not exist" / "The X External
// Credential doesn't exist." → metadata type ("" when unknown).
const TYPE_WORDS = {
  "page": "ApexPage", "visualforce page": "ApexPage", "class": "ApexClass", "apex class": "ApexClass", "trigger": "ApexTrigger",
  "component": "ApexComponent", "flow": "Flow", "field": "CustomField", "object": "CustomObject", "tab": "CustomTab",
  "label": "CustomLabel", "custom label": "CustomLabel", "static resource": "StaticResource", "permission set": "PermissionSet",
  "custom permission": "CustomPermission", "external credential": "ExternalCredential", "named credential": "NamedCredential",
  "lightning web component": "LightningComponentBundle", "aura component": "AuraDefinitionBundle", "record type": "RecordType",
  "email template": "EmailTemplate", "report type": "ReportType", "queue": "Queue", "group": "Group", "role": "Role",
  "custom metadata type": "CustomObject", "platform event": "CustomObject"
};
const typeWord = w => TYPE_WORDS[String(w || "").toLowerCase().trim()] || "";
const WHY_REFERRED = {
  ApexPage: "Apex refers to this Visualforce page (Page.Name or a PageReference), but the target doesn't have it and this deploy doesn't include it.",
  ExternalCredential: "A named credential uses this external credential, but the target doesn't have it and this deploy doesn't include it."
};

// [id, category, regex, ref(match) → {type, name}|null, title(ref, match), why, fix]
const RULES = [
  ["apex-action", "missing", /Unable to find Apex action class referenced as '([^']+)'/i,
    m => ({type: "ApexClass", name: m[1]}), r => `Missing Apex class ${r.name}`,
    "A Lightning component calls this Apex class (@AuraEnabled), but the target doesn't have it and this deploy doesn't include it.", MISSING_FIX],
  ["psg-ps", "missing", /Cannot create Permission Set Group Components since the following permission set[^:]*:\s*([A-Za-z]\w*)/i,
    m => ({type: "PermissionSet", name: m[1]}), r => `Missing permission set ${r.name}`,
    "The permission set group includes a permission set the target doesn't have.", MISSING_FIX],
  ["psg", "missing", /Cannot create Permission Set Group Components/i,
    () => null, () => "Permission set group needs permission sets the target doesn't have",
    "The group includes permission sets that are not in the target (or failed in this deploy).", "Add those permission sets to this deploy, or deploy them first."],
  ["entity", "missing", /Entity of type '(\w+)' named '([^']+)' cannot be found/i,
    m => ({type: m[1], name: m[2]}), r => `Missing ${typeLabel(r.type).toLowerCase()} ${r.name}`,
    "This item points at another one the target doesn't have.", MISSING_FIX],
  ["no-named", "missing", /(?:In field:\s*(\w+)\s*-\s*)?no (\w+) named ([^\s,;]+) found/i,
    m => ({type: m[2], name: m[3].replace(/\.$/, ""), field: m[1] || ""}),
    r => RECORD_TYPES.has(r.type) ? `${r.type} ${r.name} doesn't exist in the target` : `Missing ${typeLabel(r.type).toLowerCase()} ${r.name}`,
    "", ""],
  ["field", "missing", /(?:Field|Column)\s+['"]?([\w]+(?:\.[\w]+)?)['"]?\s+does not exist|No such column '(\w+)' on (?:entity|sobject of type) '?(\w+)'?/i,
    m => m[1] ? {type: "CustomField", name: m[1]} : {type: "CustomField", name: `${m[3]}.${m[2]}`}, r => `Missing field ${r.name}`,
    "Something in this deploy uses a field the target doesn't have.", MISSING_FIX],
  ["type-name-missing", "missing", /\b(Visualforce page|Apex class|Page|Class|Component|Trigger|Flow|Field|Object|Tab|Custom label|Label|Static resource|Permission set|Custom permission|Record type|Email template)\s+([\w.]+)\s+(?:does not|doesn't) exist/i,
    m => ({type: typeWord(m[1]), name: m[2]}), r => `Missing ${r.type ? typeLabel(r.type).toLowerCase() : "item"} ${r.name}`,
    "", MISSING_FIX],
  ["name-type-missing", "missing", /\bThe\s+([\w.]+)\s+([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3})\s+(?:does not|doesn't) exist/,
    m => ({type: typeWord(m[2]), name: m[1], word: m[2]}), r => `Missing ${r.type ? typeLabel(r.type).toLowerCase() : r.word.toLowerCase()} ${r.name}`,
    "", MISSING_FIX],
  ["invalid-type", "missing", /Invalid type:\s*([\w.]+)/i,
    m => ({type: "", name: m[1]}), r => `Unknown type ${r.name}`,
    "Apex refers to a class or object the target doesn't have.", MISSING_FIX],
  ["no-variable", "compile", /Variable does not exist:\s*([\w.]+)/i,
    m => ({type: "", name: m[1].split(".")[0]}), r => `Apex uses ${r.name}, which doesn't exist`,
    "Usually a class, field or variable that the target doesn't have, or a typo.", "If it's a class or field, add it to this deploy; otherwise fix the name in the code."],
  ["no-method", "compile", /Method does not exist or incorrect signature/i,
    () => null, () => "Apex calls a method that doesn't exist",
    "The called method isn't there, or its parameters differ (often the other class isn't deployed in its new version).", "Deploy the class that defines the method with it, or fix the call."],
  ["apex-syntax", "compile", /Unexpected token|Missing ';'|expecting (?:a|an|one)\b|Illegal assignment|Missing return statement|Duplicate variable|Non-void method|Unreachable statement|Incompatible types/i,
    () => null, () => "Apex doesn't compile",
    "Salesforce could not compile this code.", "Open the file at the line shown and fix the code, then validate again."],
  ["feature", "feature", /Not available for deploy for this organization|is not (?:enabled|available) (?:in|for) (?:this|your) org|requires the .* (?:feature|permission) to be enabled|feature is not enabled/i,
    () => null, () => "A feature isn't turned on in the target",
    "This metadata needs an org feature, license or setting the target doesn't have enabled.", "Turn on the feature in the target's Setup (or ask Salesforce support), then validate again."],
  ["change", "change", /Cannot change (?:the )?(?:type|field type|length|precision)|cannot be changed|Cannot update a field to a .* from|Cannot change which/i,
    () => null, () => "This change can't be deployed in place",
    "Salesforce won't change this property of an existing item through a deploy.", "Change it by hand in the target (or delete and re-create it, if the data allows), as a pre-deployment step."],
  ["cross-ref", "access", /insufficient access rights on cross-reference id/i,
    () => null, () => "Salesforce refused a reference",
    "Something still points at what you are changing (an active or paused flow, or a record, user or queue ID the target doesn't have). It is not about your admin rights.", "See the help below the errors for flow deletes; otherwise check the IDs the item refers to."],
  ["locked", "access", /UNABLE_TO_LOCK_ROW|unable to obtain exclusive access/i,
    () => null, () => "The target was busy",
    "Another deploy or a running job held a lock on the same records or metadata.", "Wait a minute and validate again."],
  ["access", "access", /INSUFFICIENT_ACCESS|insufficient access|You do not have (?:the )?(?:permission|access)/i,
    () => null, () => "Missing access in the target",
    "The user you are deploying as lacks a permission this item needs.", "Use a System Administrator in the target, or add the missing permission."],
  ["duplicate", "conflict", /duplicate value found|already exists|is already in use|DUPLICATE_DEVELOPER_NAME|duplicate name/i,
    () => null, () => "The name is already taken in the target",
    "Another item in the target already uses this API name (possibly of a different type or in a managed package).", "Rename it in the source, or remove the other item in the target."],
  ["not-in-zip", "package", /named in package\.xml, but was not found in zipped directory/i,
    () => null, () => "Listed in package.xml but missing from the files",
    "The package names a component whose file isn't in it.", "Compare again (it may have been deleted in the source), or remove it from the package."],
  ["generic-missing", "missing", /does not exist|doesn't exist|cannot be found|could not be found|not found|is not defined/i,
    () => null, () => "",
    "Something in this deploy refers to an item the target doesn't have.", "Find the item Salesforce names below and add it to this deploy, or remove the reference."]
];

// When no rule knows the message.
export const OTHER_WHY = "SaralForce doesn't recognise this message yet.";
export const OTHER_FIX = "Read what Salesforce says below, or press “Ask AI” about it.";

const NO_NAMED_WHY = ref => RECORD_TYPES.has(ref.type)
  ? `The item${ref.field ? `'s ${ref.field}` : ""} names a ${ref.type.toLowerCase()} that the target doesn't have. Sandbox usernames end in the sandbox name, so they rarely match production.`
  : "This item points at another one the target doesn't have.";
const NO_NAMED_FIX = ref => RECORD_TYPES.has(ref.type)
  ? `Change ${ref.field || "the value"} to a ${ref.type.toLowerCase()} that exists in the target (in the source, then compare again), or create it in the target first.`
  : MISSING_FIX;

// Same message with names, numbers and IDs taken out: groups the unknown ones.
export function normalizeProblem(text) {
  return String(text || "").replace(/'[^']*'|"[^"]*"/g, "'…'").replace(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b(?=\W|$)/g, "<id>")
    .replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function classifyProblem(problem) {
  for (const [id, category, re, ref, title, why, fix] of RULES) {
    const m = re.exec(problem || "");
    if (!m) continue;
    const r = ref(m);
    // "no User named …" is a missing record, not missing metadata.
    const cat = id === "no-named" && RECORD_TYPES.has(r.type) ? "reference" : category;
    const whyText = id === "no-named" ? NO_NAMED_WHY(r) : why || (r && WHY_REFERRED[r.type]) ||
      (r ? "Something in this deploy refers to it, but the target doesn't have it and this deploy doesn't include it." : "");
    return {id, category: cat, ref: r, title: title(r || {}, m), why: whyText, fix: id === "no-named" ? NO_NAMED_FIX(r) : fix};
  }
  return {id: "other", category: "other", ref: null, title: "", why: OTHER_WHY, fix: OTHER_FIX};
}

// Keys a referenced item could have (an untyped name may be a class or an object).
function refKeys(ref) {
  if (!ref || !ref.name) return [];
  if (ref.type) return [compKey(ref.type, ref.name)];
  return ["ApexClass", "CustomObject", "ApexPage"].map(t => compKey(t, ref.name));
}

// summary: summarizeDeployResult. deployKeys: what was sent. sourceKeys: what
// the source has and could be added (new in the target, not selected).
// → {groups (roots, each with .children), total, rootCount, failedKeys}
export function analyzeFailures(summary, {deployKeys = [], sourceKeys = []} = {}) {
  const failures = (summary && summary.componentFailures) || [];
  const failedKeys = new Set(failures.map(f => compKey(f.type, f.fullName)));
  const inDeploy = new Set(deployKeys);
  const addable = new Set(sourceKeys);
  const byKey = new Map();
  for (const f of failures) {
    const c = classifyProblem(f.problem);
    const keys = refKeys(c.ref);
    const gid = c.ref && c.ref.name ? `${c.id}|${(c.ref.type || "?")}:${c.ref.name}`
      : c.category === "compile" ? `${c.id}|${compKey(f.type, f.fullName)}` : `${c.id}|${normalizeProblem(f.problem)}`;
    if (!byKey.has(gid)) {
      const failedRef = keys.find(k => failedKeys.has(k)) || "";
      const addKey = !failedRef && keys.find(k => addable.has(k) && !inDeploy.has(k)) || "";
      byKey.set(gid, {key: gid, rule: c.id, category: c.category, categoryLabel: CATEGORIES[c.category],
        title: c.title || (f.problem || "").slice(0, 120), why: c.why, fix: c.fix, ref: c.ref,
        refStatus: failedRef ? "failed" : addKey ? "addable" : keys.some(k => inDeploy.has(k)) ? "in-deploy" : keys.length ? "absent" : "",
        failedRef, addKey, sample: f.problem || "", components: new Map(), count: 0, children: []});
    }
    const g = byKey.get(gid);
    g.count++;
    const ck = compKey(f.type, f.fullName);
    const comp = g.components.get(ck) || {type: f.type, fullName: f.fullName, count: 0, lines: []};
    comp.count++;
    if (f.line) comp.lines.push(f.line);
    g.components.set(ck, comp);
  }
  const groups = [...byKey.values()].map(g => ({...g, components: [...g.components.values()]}));
  // Knock-on: the missing item failed here → nest under the group that failed it.
  const ownerOf = key => groups.find(g => g.components.some(c => compKey(c.type, c.fullName) === key));
  const parent = new Map();
  for (const g of groups) {
    if (!g.failedRef) continue;
    const p = ownerOf(g.failedRef);
    if (p && p !== g && parent.get(p.key) !== g.key) parent.set(g.key, p.key);
  }
  // Follow chains to the top, so nesting is one level deep.
  const top = key => { let k = key; const seen = new Set(); while (parent.has(k) && !seen.has(k)) { seen.add(k); k = parent.get(k); } return k; };
  const roots = [];
  const index = new Map(groups.map(g => [g.key, g]));
  for (const g of groups) {
    if (parent.has(g.key)) index.get(top(g.key)).children.push(g);
    else roots.push(g);
  }
  const weight = g => g.count + g.children.reduce((n, c) => n + c.count, 0);
  roots.sort((a, b) => weight(b) - weight(a) || a.title.localeCompare(b.title));
  for (const r of roots) { r.total = weight(r); r.children.sort((a, b) => b.count - a.count); }
  return {groups: roots, total: failures.length, rootCount: roots.length, failedKeys: [...failedKeys]};
}

// One group as text, for a ticket or the AI prompt.
export function groupText(g, {withComponents = true} = {}) {
  const comps = g.components.map(c => `${typeLabel(c.type)} ${c.fullName}${c.count > 1 ? ` (×${c.count})` : ""}`);
  const lines = [`[${g.categoryLabel}] ${g.title} · ${g.total || g.count} error(s)`];
  if (withComponents) lines.push("Affected: " + comps.slice(0, 10).join(", ") + (comps.length > 10 ? ` +${comps.length - 10} more` : ""));
  if (g.why) lines.push("Why: " + g.why);
  if (g.fix) lines.push("Fix: " + g.fix);
  lines.push("Salesforce says: " + g.sample);
  for (const c of g.children || []) lines.push(`  ↳ also fails because of this: ${c.title} (${c.count})`);
  return lines.join("\n");
}

// For "Explain failures": root causes first (one line each instead of one per
// row), then a few raw messages, failing tests and coverage. Shorter and
// clearer for the AI than the raw list.
export function failuresPromptText(summary, analysis, {maxGroups = 15, maxRaw = 15} = {}) {
  const s = summary || {};
  const lines = [];
  if (s.errorMessage) lines.push("Deploy error: " + s.errorMessage);
  const a = analysis || analyzeFailures(s);
  if (a.total) {
    lines.push(`${a.total} component error(s), ${a.rootCount} root cause(s):`);
    for (const g of a.groups.slice(0, maxGroups)) lines.push("", groupText(g));
    const raw = (s.componentFailures || []).slice(0, maxRaw);
    lines.push("", "First raw messages:", ...raw.map(f => `${f.type} ${f.fullName}${f.line ? ` line ${f.line}` : ""}: ${f.problem}`));
  }
  for (const t of (s.testFailures || []).slice(0, 20)) lines.push(`Test ${t.className}.${t.method}: ${t.message}\n${String(t.stackTrace || "").slice(0, 600)}`);
  for (const w of (s.coverageWarnings || []).slice(0, 20)) lines.push(`Coverage warning ${w.name}: ${w.message}`);
  return lines.join("\n");
}
