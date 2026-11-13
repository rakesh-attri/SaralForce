// Setup's Sharing Settings page, org against org: org-wide defaults, other
// sharing settings, sharing rules, sharing sets and restriction / scoping
// rules. Pure: the reads live in inspector/shared/access-data.js.

// EntityDefinition sharing models in the words Setup uses.
export const SHARE_MODEL = {
  Private: "Private", Read: "Public Read Only", ReadWrite: "Public Read/Write", ReadWriteTransfer: "Public Read/Write/Transfer",
  ControlledByParent: "Controlled by Parent", FullAccess: "Public Full Access", ReadSelect: "Read Only (select)",
  ControlledByCampaign: "Controlled by Campaign", ControlledByLeadOrContact: "Controlled by Lead or Contact",
  None: "No access", Edit: "Public Read/Write", All: "Public Full Access"
};
export const shareModel = v => (v ? SHARE_MODEL[v] || v : "");

export const SHARING_PAGE_PARTS = [
  ["owd", "Org-wide defaults"],
  ["settings", "Other settings"],
  ["rules", "Sharing rules"],
  ["sharingSets", "Sharing sets"],
  ["restrictionRules", "Restriction & scoping rules"]
];

const tagText = (xml, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1].trim() : ""; };
const unescape = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Setup's wording for the SharingSettings fields we know; any other field
// gets a label from its name, so new Salesforce settings still show.
const SETTING_LABELS = {
  enableExternalSharingModel: "External sharing model (separate external defaults)",
  enableManagerGroups: "Manager groups",
  enableStandardReportVisibility: "Standard report visibility",
  enableManualUserRecordSharing: "Manual user record sharing",
  enablePortalUserVisibility: "Portal user visibility",
  enableCommunityUserVisibility: "Site user visibility (Experience Cloud)",
  enableSecureGuestAccess: "Secure guest user record access",
  enableAssetSharing: "Asset sharing",
  enableAccountRoleOptimization: "Account role optimization",
  enablePartnerSuperUserAccess: "Partner super user access",
  enablePortalUserCaseSharing: "Portal user case sharing",
  enableRemoveTMGroupMembership: "Remove territory group membership",
  enableTerritoryForecastManager: "Territory forecast manager",
  enableRestrictAccessLookupRecords: "Require permission to view record names in lookup fields",
  enableDeferSharingCalc: "Defer sharing calculations",
  enableInsightsSharingRules: "Insights sharing rules"
};
export function settingLabel(name) {
  if (SETTING_LABELS[name]) return SETTING_LABELS[name];
  const words = String(name).replace(/^enable/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

// Sharing.settings XML → {fieldName: "On" | "Off" | text}. Only simple
// (one-value) fields: nested blocks are left out.
export function settingsFromXml(xml) {
  const body = String(xml || "").replace(/<\?xml[^>]*>/, "").replace(/^\s*<SharingSettings[^>]*>/, "").replace(/<\/SharingSettings>\s*$/, "");
  const out = {};
  for (const m of body.matchAll(/<([A-Za-z][\w]*)>([^<]*)<\/\1>/g)) {
    const v = m[2].trim();
    out[m[1]] = v === "true" ? "On" : v === "false" ? "Off" : unescape(v);
  }
  return out;
}

const ACCESS = {Read: "Read Only", Edit: "Read/Write", All: "Full Access", None: "No access"};

// SharingSet XML → one entry per object it grants:
// {"Case": "Profiles: A, B · User Contact.Id = Case Contact.Id · Read/Write"}.
export function summarizeSharingSet(xml) {
  const x = String(xml || "");
  const profiles = [...x.matchAll(/<profiles>([\s\S]*?)<\/profiles>/g)].map(m => unescape(m[1].trim())).sort();
  const out = {};
  for (const m of x.matchAll(/<accessMappings>([\s\S]*?)<\/accessMappings>/g)) {
    const b = m[1];
    const obj = tagText(b, "object") || "?";
    out[obj] = [
      profiles.length ? `Profiles: ${profiles.join(", ")}` : "No profiles",
      `User ${tagText(b, "userField")} = ${obj} ${tagText(b, "objectField")}`,
      ACCESS[tagText(b, "accessLevel")] || tagText(b, "accessLevel") || "?"
    ].join(" · ");
  }
  return out;
}

// RestrictionRule XML → {object, label, text}.
export function summarizeRestrictionRule(xml) {
  const x = String(xml || "");
  const scoping = /Scoping/i.test(tagText(x, "enforcementType"));
  return {
    object: tagText(x, "targetEntity") || "?",
    label: unescape(tagText(x, "masterLabel")),
    text: [
      scoping ? "Scoping" : "Restriction",
      tagText(x, "active") === "true" ? "Active" : "Inactive",
      `Users: ${unescape(tagText(x, "userCriteria")) || "all"}`,
      `Records: ${unescape(tagText(x, "recordFilter")) || "all"}`
    ].join(" · ")
  };
}

// The object a row belongs to, for "Manage sharing settings for".
const objOfKey = k => String(k).split(/[.·]/)[0].trim();

function differs(values) {
  const norm = values.map(v => JSON.stringify(v === undefined ? null : v));
  return new Set(norm).size > 1;
}

// sides: [{owd: {Api: {label, internal, external}}, settings: {field: v},
//   rules: {"Obj.Rule": text}, sharingSets: {"Set": {Obj: text}},
//   restrictionRules: {"Name": {object, label, text}}}, …] (left, right).
// objectFilter: an object API name, or "" for the whole page.
export function buildSharingPageMatrix(sides, objectFilter = "") {
  const want = obj => !objectFilter || obj === objectFilter;
  const union = f => [...new Set(sides.flatMap(s => Object.keys(f(s) || {})))];
  const row = (key, label, values, extra = {}) => ({key, label, values, differs: differs(values), ...extra});

  const owdKeys = union(s => s.owd).filter(want);
  const labelOf = k => (sides.map(s => (s.owd || {})[k]).find(Boolean) || {}).label || k;
  const owd = owdKeys.sort((a, b) => labelOf(a).localeCompare(labelOf(b))).map(k =>
    row(k, labelOf(k), sides.map(s => {
      const o = (s.owd || {})[k];
      return o ? [o.internal || "", o.external || ""] : null;
    }), {sub: labelOf(k) !== k ? k : ""}));

  const settings = objectFilter ? [] : union(s => s.settings).map(k => row(k, settingLabel(k), sides.map(s => (s.settings || {})[k] || null)))
    .sort((a, b) => a.label.localeCompare(b.label));

  const rules = union(s => s.rules).filter(k => want(objOfKey(k))).sort((a, b) => a.localeCompare(b))
    .map(k => row(k, k.slice(k.indexOf(".") + 1), sides.map(s => (s.rules || {})[k] || null), {group: objOfKey(k)}));

  const setKeys = [...new Set(sides.flatMap(s => Object.entries(s.sharingSets || {}).flatMap(([n, objs]) => Object.keys(objs || {}).map(o => `${o} · ${n}`))))];
  const sharingSets = setKeys.filter(k => want(objOfKey(k))).sort((a, b) => a.localeCompare(b)).map(k => {
    const [obj, name] = k.split(" · ");
    return row(k, name, sides.map(s => ((s.sharingSets || {})[name] || {})[obj] || null), {group: obj});
  });

  const rrKeys = union(s => s.restrictionRules);
  const rrObj = k => (sides.map(s => (s.restrictionRules || {})[k]).find(Boolean) || {}).object || "?";
  const restrictionRules = rrKeys.filter(k => want(rrObj(k))).sort((a, b) => `${rrObj(a)}.${a}`.localeCompare(`${rrObj(b)}.${b}`)).map(k =>
    row(k, (sides.map(s => (s.restrictionRules || {})[k]).find(Boolean) || {}).label || k,
      sides.map(s => ((s.restrictionRules || {})[k] || {}).text || null), {group: rrObj(k)}));

  return [
    {key: "owd", title: "Org-wide defaults", head: "Object", sub: ["Default internal access", "Default external access"], rows: owd},
    {key: "settings", title: "Other settings", head: "Setting", rows: settings},
    {key: "rules", title: "Sharing rules", head: "Rule", rows: rules},
    {key: "sharingSets", title: "Sharing sets", head: "Sharing set", rows: sharingSets},
    {key: "restrictionRules", title: "Restriction & scoping rules", head: "Rule", rows: restrictionRules}
  ];
}

// Every object named anywhere on the page, for the object picker.
export function sharingPageObjects(sides) {
  const objs = new Map();
  for (const s of sides) {
    for (const [k, o] of Object.entries(s.owd || {})) objs.set(k, (o && o.label) || k);
    for (const k of Object.keys(s.rules || {})) if (!objs.has(objOfKey(k))) objs.set(objOfKey(k), objOfKey(k));
    for (const objsOfSet of Object.values(s.sharingSets || {})) for (const k of Object.keys(objsOfSet || {})) if (!objs.has(k)) objs.set(k, k);
    for (const r of Object.values(s.restrictionRules || {})) if (r && r.object && !objs.has(r.object)) objs.set(r.object, r.object);
  }
  return [...objs].map(([value, label]) => ({value, label})).sort((a, b) => a.label.localeCompare(b.label));
}

// One differing row in plain words, left → right:
// "Only in Production", "Internal: Public Read/Write → Private", "On → Off",
// or for rules only the parts that changed.
export function describeSharingDiff(sectionKey, values, labels) {
  const have = values.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  if (have.length < values.length) {
    return have.length === 1 ? `Only in ${labels[have[0]]}` : `Not in ${labels.filter((_, i) => !have.includes(i)).join(", ")}`;
  }
  const [a, b] = values;
  if (sectionKey === "owd") {
    const names = ["Internal", "External"];
    return names.map((n, j) => (a[j] !== b[j] ? `${n}: ${a[j] || "—"} → ${b[j] || "—"}` : "")).filter(Boolean).join(" · ");
  }
  if (sectionKey === "settings") return `${a} → ${b}`;
  const pa = String(a).split(" · ");
  const pb = String(b).split(" · ");
  const n = Math.max(pa.length, pb.length);
  const changed = [...Array(n).keys()].filter(j => (pa[j] || "") !== (pb[j] || ""));
  return changed.map(j => `${pa[j] || "—"} → ${pb[j] || "—"}`).join(" · ");
}

// "12 differences: 3 org-wide defaults, 2 other settings, 7 sharing rules".
export function sharingPageSummary(sections) {
  const NAMES = {owd: ["org-wide default", "org-wide defaults"], settings: ["other setting", "other settings"],
    rules: ["sharing rule", "sharing rules"], sharingSets: ["sharing set", "sharing sets"],
    restrictionRules: ["restriction or scoping rule", "restriction or scoping rules"]};
  let total = 0;
  const parts = [];
  for (const s of sections) {
    const n = s.rows.filter(r => r.differs).length;
    total += n;
    if (n) parts.push(`${n} ${(NAMES[s.key] || [s.title, s.title])[n === 1 ? 0 : 1]}`);
  }
  return {total, text: total ? `${total} difference${total === 1 ? "" : "s"}: ${parts.join(", ")}` : "No differences: both orgs share records the same way."};
}
