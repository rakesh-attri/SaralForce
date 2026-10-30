// Object Builder plan helpers: per-type defaults for the plan editor and
// turning an org describe into a plan (Edit existing object).
import {normalizeFieldType} from "./object-builder-rules.js";

// Props a field needs when it is added as, or switched to, `type`. Only keys
// the field does not already have are filled in.
export function fieldDefaults(type, field = {}) {
  const t = normalizeFieldType(type) || type;
  const d = {};
  const need = (k, v) => { if (field[k] === undefined || field[k] === null || field[k] === "") d[k] = v; };
  switch (t) {
    case "Text": need("length", 255); break;
    case "LongTextArea": need("length", 32768); need("visibleLines", 6); break;
    case "Html": need("length", 32768); need("visibleLines", 25); break;
    case "Number": need("precision", 18); need("scale", 0); break;
    case "Currency":
    case "Percent": need("precision", 18); need("scale", 2); break;
    case "Picklist":
    case "MultiselectPicklist":
      if (!field.globalValueSet && !(Array.isArray(field.values) && field.values.length)) d.values = ["Option 1", "Option 2"];
      break;
    case "Lookup":
    case "MasterDetail": need("relatedTo", "Account"); break;
    case "Formula": need("returnType", "Text"); need("formula", ""); break;
    case "Summary": need("summaryOperation", "count"); need("summaryForeignKey", ""); break;
    case "AutoNumber": need("displayFormat", "A-{0000}"); need("startingNumber", 1); break;
    case "Location": need("scale", 5); break;
    case "EncryptedText": need("length", 175); need("maskType", "all"); break;
    default: break;
  }
  return d;
}

// Describe field → plan type. Null for fields the builder cannot represent.
export function describeFieldType(f) {
  if (!f) return null;
  if (f.calculated && f.calculatedFormula) return "Formula";
  if (f.calculated && f.type !== "string") return "Summary";
  if (f.autoNumber) return "AutoNumber";
  switch (f.type) {
    case "string": return "Text";
    case "encryptedstring": return "EncryptedText";
    case "textarea":
      if (f.extraTypeInfo === "richtextarea") return "Html";
      return f.length > 255 ? "LongTextArea" : "TextArea";
    case "double":
    case "int": return "Number";
    case "currency": return "Currency";
    case "percent": return "Percent";
    case "date": return "Date";
    case "datetime": return "DateTime";
    case "time": return "Time";
    case "boolean": return "Checkbox";
    case "picklist": return "Picklist";
    case "multipicklist": return "MultiselectPicklist";
    case "email": return "Email";
    case "phone": return "Phone";
    case "url": return "Url";
    case "location": return "Location";
    case "reference":
      return f.relationshipOrder !== null && f.relationshipOrder !== undefined || f.cascadeDelete ? "MasterDetail" : "Lookup";
    default: return null;
  }
}

// A plan for an object that already exists: its custom fields are listed
// (marked existing, never redeployed) so new fields can be added beside them.
export function describeToProposal(describe) {
  const fields = (describe.fields || [])
    .filter(f => f.custom && /__c$/.test(f.name) && f.type !== "address" && !f.compoundFieldName)
    .map(f => {
      const type = describeFieldType(f);
      if (!type) return null;
      const out = {
        label: f.label, name: f.name, type, existing: true,
        required: !f.nillable && !f.defaultedOnCreate && type !== "Checkbox", description: f.inlineHelpText || ""
      };
      if (type === "Picklist" || type === "MultiselectPicklist") out.values = (f.picklistValues || []).map(p => p.value);
      if (type === "Lookup" || type === "MasterDetail") out.relatedTo = (f.referenceTo || [])[0] || "";
      if (type === "Formula") out.formula = f.calculatedFormula;
      return out;
    })
    .filter(Boolean);
  const nameField = (describe.fields || []).find(f => f.nameField);
  return {
    existing: true,
    object: {
      label: describe.label,
      pluralLabel: describe.labelPlural,
      name: describe.name,
      description: "",
      nameField: {label: nameField ? nameField.label : "Name", type: nameField && nameField.autoNumber ? "AutoNumber" : "Text"}
    },
    fields,
    // Every other field the object has (standard, compound, unsupported
    // types): formulas, rules and list views may reference them.
    orgFields: (describe.fields || []).filter(f => f.name && !fields.some(x => x.name === f.name))
      .map(f => ({name: f.name, label: f.label || f.name}))
  };
}

// Permission set for "Field access → New permission set": Name is a
// DeveloperName (max 80, no "__"), Label is readable.
export function permissionSetNameFor(objectName) {
  const base = String(objectName || "Object").replace(/__c$/i, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "Object";
  const name = (/^[A-Za-z]/.test(base) ? base : "X" + base).slice(0, 73) + "_Access";
  return {name, label: `${base.replace(/_/g, " ")} Access`.slice(0, 80)};
}

// Types whose details must be filled in before they are useful.
export const NEEDS_DETAILS = new Set(["Picklist", "MultiselectPicklist", "Formula", "Summary", "Lookup", "MasterDetail", "AutoNumber"]);

// One-line summary of a field's settings for the plan table ("3 values: A, B, C").
export function fieldDetailSummary(field) {
  if (!field) return null;
  const type = normalizeFieldType(field.type);
  const cut = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  switch (type) {
    case "Picklist":
    case "MultiselectPicklist": {
      if (field.globalValueSet) return `Global value set: ${field.globalValueSet}`;
      const vals = (Array.isArray(field.values) ? field.values : []).filter(v => String(v).trim());
      if (!vals.length) return "No values yet — add them";
      return cut(`${vals.length} value${vals.length === 1 ? "" : "s"}: ${vals.join(", ")}`) +
        (field.controllingField ? ` · depends on ${field.controllingField}` : "");
    }
    case "Formula":
      return field.formula ? cut(`${field.returnType || "Text"} = ${field.formula}`) : "No formula yet — add it";
    case "Summary": {
      const op = String(field.summaryOperation || "count").toUpperCase();
      return field.summaryForeignKey ? cut(`${op} of ${op === "COUNT" ? field.summaryForeignKey.split(".")[0] : field.summarizedField || "?"}`) : "Choose the child relationship";
    }
    case "Lookup":
    case "MasterDetail":
      return field.relatedTo ? `→ ${field.relatedTo}` : "Choose the related object";
    case "AutoNumber":
      return field.displayFormat || null;
    default:
      return null;
  }
}
