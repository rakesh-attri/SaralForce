// Custom Metadata Types: Metadata API XML for new types (CustomObject
// *__mdt with fields) and new records (CustomMetadata), plus parsing the
// createMetadata result. Pure functions, unit-tested with `node --test`.

export const CMDT_FIELD_TYPES = [
  ["Text", "Text"], ["Checkbox", "Checkbox"], ["Number", "Number"], ["Percent", "Percent"], ["Date", "Date"],
  ["DateTime", "Date/Time"], ["Email", "Email"], ["Phone", "Phone"], ["Url", "URL"], ["TextArea", "Text Area"],
  ["LongTextArea", "Long Text Area"],
];

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// "Feature Flag" → "Feature_Flag"; keeps letters, digits and single underscores.
export function toApiName(label) {
  return String(label || "").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_")
    .replace(/^(\d)/, "X$1");
}

// Type definition → <met:metadata xsi:type="met:CustomObject">…
//   def: {name (without __mdt), label, pluralLabel, visibility, description,
//         fields: [{label, name (without __c), type, required}]}
export function cmdtTypeXml(def) {
  const lines = [
    '<met:metadata xsi:type="met:CustomObject">',
    `  <met:fullName>${esc(def.name)}__mdt</met:fullName>`,
    `  <met:label>${esc(def.label)}</met:label>`,
    `  <met:pluralLabel>${esc(def.pluralLabel || def.label)}</met:pluralLabel>`,
    `  <met:visibility>${esc(def.visibility || "Public")}</met:visibility>`,
  ];
  if (def.description) lines.push(`  <met:description>${esc(def.description)}</met:description>`);
  for (const f of def.fields || []) {
    lines.push("  <met:fields>");
    lines.push(`    <met:fullName>${esc(f.name)}__c</met:fullName>`);
    lines.push(`    <met:label>${esc(f.label)}</met:label>`);
    lines.push(`    <met:type>${esc(f.type)}</met:type>`);
    lines.push("    <met:fieldManageability>DeveloperControlled</met:fieldManageability>");
    if (f.type === "Checkbox") lines.push("    <met:defaultValue>false</met:defaultValue>");
    else if (f.required) lines.push("    <met:required>true</met:required>");
    if (f.type === "Text") lines.push("    <met:length>255</met:length>");
    if (f.type === "Number" || f.type === "Percent") {
      lines.push("    <met:precision>18</met:precision>");
      lines.push("    <met:scale>2</met:scale>");
    }
    if (f.type === "LongTextArea") {
      lines.push("    <met:length>32768</met:length>");
      lines.push("    <met:visibleLines>3</met:visibleLines>");
    }
    lines.push("  </met:fields>");
  }
  lines.push("</met:metadata>");
  return lines.join("\n");
}

const XSD = {boolean: "xsd:boolean", double: "xsd:double", percent: "xsd:double", int: "xsd:int", date: "xsd:date", datetime: "xsd:dateTime"};

// Record → <met:metadata xsi:type="met:CustomMetadata">…
//   typeName: "Feature_Flag__mdt"; rec: {label, name, protected, values: {Field__c: value}}
//   fieldTypes: {Field__c: describe type} picks the xsd type of each value.
export function cmdtRecordXml(typeName, rec, fieldTypes = {}) {
  const lines = [
    '<met:metadata xsi:type="met:CustomMetadata">',
    `  <met:fullName>${esc(String(typeName).replace(/__mdt$/, ""))}.${esc(rec.name)}</met:fullName>`,
    `  <met:label>${esc(rec.label)}</met:label>`,
  ];
  // Updates leave protection as it is (it cannot be read back through SOQL).
  if (rec.protected !== undefined) lines.push(`  <met:protected>${rec.protected ? "true" : "false"}</met:protected>`);
  for (const [field, raw] of Object.entries(rec.values || {})) {
    const t = String(fieldTypes[field] || "string").toLowerCase();
    lines.push("  <met:values>");
    lines.push(`    <met:field>${esc(field)}</met:field>`);
    const empty = raw == null || raw === "";
    if (empty && t !== "boolean") lines.push('    <met:value xsi:nil="true"/>');
    else {
      const v = t === "boolean" ? String(raw === true || raw === "true") : String(raw);
      lines.push(`    <met:value xsi:type="${XSD[t] || "xsd:string"}">${esc(v)}</met:value>`);
    }
    lines.push("  </met:values>");
  }
  lines.push("</met:metadata>");
  return lines.join("\n");
}

export function createMetadataBody(metadataXml) {
  return `<met:createMetadata>\n${metadataXml}\n</met:createMetadata>`;
}

// Create-or-update (records keep their name; every value is replaced).
export function upsertMetadataBody(metadataXml) {
  return `<met:upsertMetadata>\n${metadataXml}\n</met:upsertMetadata>`;
}

export function deleteMetadataBody(type, fullNames) {
  const names = [].concat(fullNames).map(n => `  <met:fullNames>${esc(n)}</met:fullNames>`).join("\n");
  return `<met:deleteMetadata>\n  <met:type>${esc(type)}</met:type>\n${names}\n</met:deleteMetadata>`;
}

// Record for an update: the original row merged with edits, for every
// custom field (upsert replaces all values).
export function mergedRecord(row, edits, fields) {
  const values = {};
  for (const f of fields) values[f.name] = Object.prototype.hasOwnProperty.call(edits, f.name) ? edits[f.name] : row[f.name];
  return {label: edits.MasterLabel != null ? edits.MasterLabel : row.MasterLabel, name: row.DeveloperName, values};
}

// createMetadata / SOAP response → {success, fullName, errors: [message]}.
export function parseCreateResult(xml) {
  const text = String(xml || "");
  const fault = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(text);
  if (fault) return {success: false, fullName: "", errors: [fault[1].trim()]};
  const success = /<(?:\w+:)?success>\s*true\s*<\/(?:\w+:)?success>/.test(text);
  const fullName = (/<(?:\w+:)?fullName>([\s\S]*?)<\/(?:\w+:)?fullName>/.exec(text) || [])[1] || "";
  const errors = [...text.matchAll(/<(?:\w+:)?message>([\s\S]*?)<\/(?:\w+:)?message>/g)].map(m => m[1].trim());
  return {success, fullName, errors: success ? [] : (errors.length ? errors : ["The Metadata API did not report success."])};
}
