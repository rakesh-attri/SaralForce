// Pure rules for the AI Object Builder: field types, API names, sharing
// models, proposal validation and LLM JSON extraction. No chrome/window/DOM
// access so node --test can import this module directly.

export const FIELD_TYPES = [
  {value: "Text", label: "Text"},
  {value: "TextArea", label: "Text Area"},
  {value: "LongTextArea", label: "Text Area (Long)"},
  {value: "Number", label: "Number"},
  {value: "Currency", label: "Currency"},
  {value: "Percent", label: "Percent"},
  {value: "Date", label: "Date"},
  {value: "DateTime", label: "Date / Time"},
  {value: "Checkbox", label: "Checkbox"},
  {value: "Picklist", label: "Picklist"},
  {value: "MultiselectPicklist", label: "Picklist (Multi-Select)"},
  {value: "Email", label: "Email"},
  {value: "Phone", label: "Phone"},
  {value: "Url", label: "URL"},
  {value: "Lookup", label: "Lookup"},
  {value: "MasterDetail", label: "Master-Detail"},
  {value: "Formula", label: "Formula"},
  {value: "Summary", label: "Roll-Up Summary"},
  {value: "AutoNumber", label: "Auto Number"},
  {value: "Location", label: "Geolocation"},
  {value: "Time", label: "Time"},
  {value: "Html", label: "Text Area (Rich)"},
  {value: "EncryptedText", label: "Text (Encrypted)"}
];

// Return types a Formula field can have.
export const FORMULA_RETURN_TYPES = ["Text", "Number", "Currency", "Percent", "Date", "DateTime", "Time", "Checkbox"];
export const SUMMARY_OPERATIONS = ["count", "sum", "min", "max"];
// Field types whose values Salesforce calculates (read-only for users).
export const CALCULATED_TYPES = new Set(["Formula", "Summary", "AutoNumber"]);

export const FIELD_TYPE_VALUES = FIELD_TYPES.map(ft => ft.value);

// Lowercased, punctuation-free spelling → canonical FIELD_TYPES value.
const FIELD_TYPE_ALIASES = {
  text: "Text",
  string: "Text",
  textarea: "TextArea",
  longtextarea: "LongTextArea",
  textarealong: "LongTextArea",
  longtext: "LongTextArea",
  number: "Number",
  double: "Number",
  integer: "Number",
  currency: "Currency",
  percent: "Percent",
  percentage: "Percent",
  date: "Date",
  datetime: "DateTime",
  checkbox: "Checkbox",
  boolean: "Checkbox",
  picklist: "Picklist",
  multiselectpicklist: "MultiselectPicklist",
  picklistmultiselect: "MultiselectPicklist",
  multipicklist: "MultiselectPicklist",
  email: "Email",
  phone: "Phone",
  url: "Url",
  lookup: "Lookup",
  lookuprelationship: "Lookup",
  masterdetail: "MasterDetail",
  masterdetailrelationship: "MasterDetail",
  formula: "Formula",
  summary: "Summary",
  rollupsummary: "Summary",
  rollup: "Summary",
  autonumber: "AutoNumber",
  location: "Location",
  geolocation: "Location",
  time: "Time",
  html: "Html",
  richtext: "Html",
  richtextarea: "Html",
  textarearich: "Html",
  encrypted: "EncryptedText",
  encryptedtext: "EncryptedText",
  textencrypted: "EncryptedText"
};

// Map AI/user spellings ("Master-Detail", "Date/Time", "Text Area (Long)",
// "Picklist (Multi-Select)", "lookup relationship") onto FIELD_TYPES values.
// Returns null for anything unknown.
export function normalizeFieldType(type) {
  if (type == null) return null;
  const key = String(type).toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  return FIELD_TYPE_ALIASES[key] || null;
}

export function isMasterDetail(field) {
  return !!field && normalizeFieldType(field.type) === "MasterDetail";
}

// Salesforce lets these custom field types be marked required. Not here:
// Checkbox (always has a value), MasterDetail (implicitly required),
// LongTextArea (Setup offers no Required option; enforce with a validation
// rule) and MultiselectPicklist (not confirmed via Metadata API, so left out).
const REQUIRED_TYPES = new Set([
  "Text", "TextArea", "Number", "Currency", "Percent", "Date", "DateTime",
  "Picklist", "Email", "Phone", "Url", "Lookup", "Time", "EncryptedText", "Location"
]);

export function supportsRequired(type) {
  return REQUIRED_TYPES.has(normalizeFieldType(type));
}

// Sharing models valid for a custom object's internal default.
export const SHARING_MODELS = ["Private", "Read", "ReadWrite", "ControlledByParent"];

const SHARING_ALIASES = {
  private: "Private",
  read: "Read",
  readonly: "Read",
  publicread: "Read",
  publicreadonly: "Read",
  readwrite: "ReadWrite",
  publicreadwrite: "ReadWrite",
  controlledbyparent: "ControlledByParent"
};

export function normalizeSharingModel(value) {
  if (value == null || value === "") return null;
  const key = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return SHARING_ALIASES[key] || String(value);
}

// Effective sharing model: MasterDetail children must be ControlledByParent,
// and ControlledByParent is meaningless without a MasterDetail field.
export function resolveSharingModel(proposal) {
  const fields = Array.isArray(proposal?.fields) ? proposal.fields : [];
  const hasMd = fields.some(isMasterDetail);
  const current = normalizeSharingModel(proposal?.object?.sharingModel);
  if (hasMd) return "ControlledByParent";
  if (!current || current === "ControlledByParent") return "ReadWrite";
  return current;
}

export function validateSharingModel(proposal) {
  const errors = [];
  const fields = Array.isArray(proposal?.fields) ? proposal.fields : [];
  const hasMd = fields.some(isMasterDetail);
  const value = proposal?.object?.sharingModel;
  if (value == null || value === "") return errors;
  const sm = normalizeSharingModel(value);
  if (!SHARING_MODELS.includes(sm)) {
    errors.push(`Sharing model "${value}" is not valid for a custom object (use ${SHARING_MODELS.join(", ")})`);
  } else if (hasMd && sm !== "ControlledByParent") {
    errors.push("Objects with a Master-Detail field must use the ControlledByParent sharing model");
  } else if (!hasMd && sm === "ControlledByParent") {
    errors.push("ControlledByParent sharing requires a Master-Detail field");
  }
  return errors;
}

export const API_NAME_MAX_BASE = 40;

// Custom object/field API name check. Returns an error string or null.
export function validateApiName(name, what = "API name") {
  if (typeof name !== "string" || !name) return `${what} is missing`;
  if (!name.endsWith("__c")) return `${what} must end with __c (${name})`;
  const base = name.slice(0, -3);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(base)) {
    return `${what} must start with a letter and use only letters, numbers and underscores (${name})`;
  }
  if (base.includes("__")) return `${what} must not contain "__" before the __c suffix (${name})`;
  if (base.endsWith("_")) return `${what} must not end with "_" before __c (${name})`;
  if (base.length > API_NAME_MAX_BASE) {
    return `${what} is ${base.length} characters before __c; the maximum is ${API_NAME_MAX_BASE} (${name})`;
  }
  return null;
}

// Escape a value for a single-quoted SOQL string literal.
export function escapeSoqlString(value) {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function trimBase(base, max) {
  return base.slice(0, max).replace(/_+$/, "");
}

// Append _2, _3, … (keeping the base within 40 chars) until the name is not
// in `taken` (case-insensitive, full API names).
export function uniqueApiName(base, taken = []) {
  const takenSet = new Set(Array.from(taken || [], n => String(n || "").toLowerCase()));
  let candidate = trimBase(base, API_NAME_MAX_BASE);
  if (!takenSet.has((candidate + "__c").toLowerCase())) return candidate + "__c";
  for (let n = 2; n < 10000; n++) {
    const suffix = "_" + n;
    candidate = trimBase(base, API_NAME_MAX_BASE - suffix.length) + suffix;
    if (!takenSet.has((candidate + "__c").toLowerCase())) return candidate + "__c";
  }
  return candidate + "__c";
}

// Label → API name. Diacritics are folded via NFKD (Café → Cafe), labels
// with no Latin letters/digits fall back to a numbered Field_N name, and the
// result is kept unique within `taken`.
export function suggestApiName(label, taken = []) {
  const ascii = String(label || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  let base = ascii
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join("_");
  if (base && !/^[A-Za-z]/.test(base)) base = "F_" + base;
  if (!base) {
    const takenArr = Array.from(taken || []);
    let n = takenArr.length + 1;
    const lower = new Set(takenArr.map(t => String(t || "").toLowerCase()));
    while (lower.has(`field_${n}__c`)) n++;
    base = "Field_" + n;
  }
  return uniqueApiName(base, taken);
}

// "Retry with new name": Foo__c → Foo_2__c → Foo_3__c, label "Foo" →
// "Foo 2" → "Foo 3" (never "Foo 2 2").
export function nextRetryName(name, label, taken = []) {
  const base = String(name || "").replace(/__c$/, "");
  const m = base.match(/^(.*?)_(\d+)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  const takenSet = new Set(Array.from(taken || [], t => String(t || "").toLowerCase()));
  let nextName;
  for (;; n++) {
    const suffix = "_" + n;
    nextName = trimBase(stem, API_NAME_MAX_BASE - suffix.length) + suffix + "__c";
    if (!takenSet.has(nextName.toLowerCase())) break;
  }
  const rawLabel = String(label || "");
  const prevNum = m ? m[2] : null;
  const lm = rawLabel.match(/^(.*\S)\s+(\d+)$/);
  const labelStem = lm && prevNum && lm[2] === prevNum ? lm[1] : rawLabel;
  return {name: nextName, label: `${labelStem} ${n}`.trim()};
}

// AutoNumber/Text name field from the prompt contract (object.nameField.*),
// falling back to legacy flat keys (nameFieldType/nameFieldLabel/displayFormat).
export const DEFAULT_AUTONUMBER_FORMAT = "{0000}";

export function resolveNameField(objectDef) {
  const obj = objectDef || {};
  const nf = obj.nameField && typeof obj.nameField === "object" ? obj.nameField : {};
  const rawType = String(nf.type || obj.nameFieldType || "Text").toLowerCase().replace(/[^a-z]/g, "");
  const type = rawType === "autonumber" ? "AutoNumber" : "Text";
  const label = nf.label || obj.nameFieldLabel || ((obj.label || "Record") + " Name");
  const result = {type, label};
  if (type === "AutoNumber") {
    result.displayFormat = nf.format || nf.displayFormat || obj.displayFormat || DEFAULT_AUTONUMBER_FORMAT;
  }
  return result;
}

const AUTONUMBER_PLACEHOLDER = /\{0+\}/;

// Canonical copy: field types normalized, sharing model resolved.
// Unknown types are kept as-is so validateProposal can report them.
export function normalizeProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return proposal;
  const out = {...proposal};
  if (Array.isArray(proposal.fields)) {
    out.fields = proposal.fields.map(f => {
      if (!f || typeof f !== "object") return f;
      const t = normalizeFieldType(f.type);
      return t && t !== f.type ? {...f, type: t} : f;
    });
  }
  if (proposal.object && typeof proposal.object === "object") {
    const sm = normalizeSharingModel(proposal.object.sharingModel);
    const known = sm == null || SHARING_MODELS.includes(sm);
    // Unknown values (e.g. FullAccess) stay so validation can flag them.
    out.object = {...proposal.object, sharingModel: known ? resolveSharingModel(out) : proposal.object.sharingModel};
  }
  return out;
}

export function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== "object") return ["Proposal is not a JSON object"];
  if (!proposal.object || typeof proposal.object !== "object") {
    errors.push("Missing 'object' definition");
  } else {
    const obj = proposal.object;
    if (!obj.label) errors.push("Object missing 'label'");
    const nameErr = validateApiName(obj.name, "Object API name");
    if (nameErr) errors.push(nameErr);
    const nf = resolveNameField(obj);
    if (nf.type === "AutoNumber" && !AUTONUMBER_PLACEHOLDER.test(nf.displayFormat)) {
      errors.push(`Name field display format "${nf.displayFormat}" must contain a number placeholder like {0000}`);
    }
    errors.push(...validateSharingModel(proposal));
  }
  if (proposal.recordTypes !== undefined) {
    if (!Array.isArray(proposal.recordTypes)) {
      errors.push("'recordTypes' must be an array");
    } else {
      proposal.recordTypes.forEach((rt, i) => {
        if (!rt.label) errors.push(`Record type ${i + 1} missing 'label'`);
        if (!rt.name) errors.push(`Record type ${i + 1} missing 'name'`);
        else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(rt.name)) {
          errors.push(`Record type ${i + 1} name must be a DeveloperName (letters, numbers, underscores, no __c): ${rt.name}`);
        } else if (rt.name.endsWith("__c")) {
          errors.push(`Record type ${i + 1} name must NOT end with __c (${rt.name})`);
        }
        if (!rt.description) errors.push(`Record type ${i + 1} missing 'description'`);
      });
    }
  }
  if (!proposal.fields || !Array.isArray(proposal.fields) || proposal.fields.length === 0) {
    errors.push("Missing or empty 'fields' array");
  } else {
    const seen = new Map();
    let mdCount = 0;
    proposal.fields.forEach((f, i) => {
      if (!f || typeof f !== "object") {
        errors.push(`Field ${i + 1} is not an object`);
        return;
      }
      if (!f.label) errors.push(`Field ${i + 1} missing 'label'`);
      if (typeof f.name === "string" && f.name.endsWith("__r")) {
        errors.push(`Field ${i + 1} API name must not end with __r — use __c for the field (${f.name})`);
      } else {
        const nameErr = validateApiName(f.name, `Field ${i + 1} API name`);
        if (nameErr) errors.push(nameErr);
      }
      if (typeof f.name === "string" && f.name) {
        const key = f.name.toLowerCase();
        if (seen.has(key)) {
          errors.push(`Field ${i + 1} API name ${f.name} duplicates field ${seen.get(key) + 1}`);
        } else {
          seen.set(key, i);
        }
      }
      // Fields already in the org (editing an existing object) are not
      // redeployed, so only their names matter here.
      if (f.existing) {
        if (normalizeFieldType(f.type) === "MasterDetail") mdCount++;
        return;
      }
      const type = normalizeFieldType(f.type);
      if (!f.type) {
        errors.push(`Field ${i + 1} missing 'type'`);
      } else if (!type) {
        errors.push(`Field ${i + 1} (${f.name}) has unsupported type "${f.type}" (use one of: ${FIELD_TYPE_VALUES.join(", ")})`);
      }
      if (type === "Picklist" || type === "MultiselectPicklist") {
        const vals = Array.isArray(f.values) ? f.values.filter(v => String(v == null ? "" : v).trim()) : [];
        if (vals.length < 1 && !f.globalValueSet) {
          errors.push(`Field ${i + 1} (${f.name}) ${type} requires a non-empty 'values' array or a 'globalValueSet'`);
        }
        if (f.globalValueSet && !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.globalValueSet))) {
          errors.push(`Field ${i + 1} (${f.name}) globalValueSet "${f.globalValueSet}" is not a valid value set name`);
        }
        if (f.controllingField) {
          const ctrl = proposal.fields.find(x => x && x.name === f.controllingField);
          const ctrlType = ctrl ? normalizeFieldType(ctrl.type) : null;
          if (ctrl && ctrlType !== "Picklist" && ctrlType !== "Checkbox") {
            errors.push(`Field ${i + 1} (${f.name}) controlling field ${f.controllingField} must be a Picklist or Checkbox`);
          }
          if (f.globalValueSet) errors.push(`Field ${i + 1} (${f.name}) a dependent picklist can't use a global value set here`);
          if (ctrl && f.dependencies && typeof f.dependencies === "object") {
            const ctrlVals = ctrlType === "Checkbox" ? ["true", "false", "checked", "unchecked"]
              : (Array.isArray(ctrl.values) ? ctrl.values.map(v => String(v).toLowerCase()) : []);
            for (const k of Object.keys(f.dependencies)) {
              if (!ctrlVals.includes(String(k).toLowerCase())) {
                errors.push(`Field ${i + 1} (${f.name}) depends on "${k}", which is not a value of ${f.controllingField}`);
              }
            }
          }
        }
        if (f.defaultValue != null && String(f.defaultValue).trim() &&
            !vals.some(v => String(v).trim().toLowerCase() === String(f.defaultValue).trim().toLowerCase())) {
          errors.push(`Field ${i + 1} (${f.name}) defaultValue "${f.defaultValue}" is not in values`);
        }
      }
      if (type === "Lookup" || type === "MasterDetail") {
        if (!f.relatedTo) {
          errors.push(`Field ${i + 1} (${f.name}) ${type} requires 'relatedTo'`);
        } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.relatedTo))) {
          errors.push(`Field ${i + 1} (${f.name}) relatedTo "${f.relatedTo}" is not a valid object API name`);
        }
      }
      if (type === "MasterDetail") mdCount++;
      if (type === "Formula") {
        if (!String(f.formula || "").trim()) errors.push(`Field ${i + 1} (${f.name}) Formula requires 'formula'`);
        if (!FORMULA_RETURN_TYPES.includes(f.returnType)) {
          errors.push(`Field ${i + 1} (${f.name}) Formula 'returnType' must be one of ${FORMULA_RETURN_TYPES.join(", ")}`);
        }
      }
      if (type === "Summary") {
        const op = String(f.summaryOperation || "").toLowerCase();
        if (!SUMMARY_OPERATIONS.includes(op)) errors.push(`Field ${i + 1} (${f.name}) Roll-Up Summary 'summaryOperation' must be count, sum, min or max`);
        if (!/^\w+\.\w+$/.test(String(f.summaryForeignKey || ""))) {
          errors.push(`Field ${i + 1} (${f.name}) Roll-Up Summary needs 'summaryForeignKey' as ChildObject__c.MasterDetailField__c`);
        }
        if (op !== "count" && !/^\w+\.\w+$/.test(String(f.summarizedField || ""))) {
          errors.push(`Field ${i + 1} (${f.name}) Roll-Up Summary ${op || ""} needs 'summarizedField' as ChildObject__c.Field__c`.replace("  ", " "));
        }
      }
      if (type === "AutoNumber" && f.displayFormat && !AUTONUMBER_PLACEHOLDER.test(f.displayFormat)) {
        errors.push(`Field ${i + 1} (${f.name}) Auto Number format "${f.displayFormat}" must contain {0000}`);
      }
      if (type === "EncryptedText" && f.length && (Number(f.length) < 1 || Number(f.length) > 175)) {
        errors.push(`Field ${i + 1} (${f.name}) Encrypted text length must be 1-175`);
      }
    });
    const known = knownFieldNames(proposal);
    const fieldNames = {has: n => known.has(String(n || "").toLowerCase())};
    const checkRefs = (formula, where) => {
      for (const ref of formulaUnknownFields(formula, known)) {
        const hint = suggestFieldName(ref, proposal);
        errors.push(`${where} uses "${ref}", which is not a field of this object${hint ? ` — did you mean ${hint}?` : ""}`);
      }
    };
    proposal.fields.forEach((f, i) => {
      if (f && !f.existing && normalizeFieldType(f.type) === "Formula" && String(f.formula || "").trim()) {
        checkRefs(f.formula, `Field ${i + 1} (${f.name}) formula`);
      }
    });
    const nameOk = n => /^[A-Za-z][A-Za-z0-9_]*$/.test(String(n || "")) && !/__/.test(String(n)) && !/_$/.test(String(n));
    (Array.isArray(proposal.validationRules) ? proposal.validationRules : []).forEach((r, i) => {
      if (!nameOk(r && r.name)) errors.push(`Validation rule ${i + 1} needs a 'name' (letters, digits, single underscores)`);
      if (!String(r && r.formula || "").trim()) errors.push(`Validation rule ${i + 1} needs a 'formula'`);
      if (!String(r && r.message || "").trim()) errors.push(`Validation rule ${i + 1} needs an error 'message'`);
      if (r && String(r.formula || "").trim()) checkRefs(r.formula, `Validation rule ${r.name || i + 1}`);
      if (r && r.field && !fieldNames.has(r.field)) {
        const hint = suggestFieldName(r.field, proposal);
        errors.push(`Validation rule ${r.name || i + 1} shows its error on "${r.field}", which is not a field of this object${hint ? ` — did you mean ${hint}?` : ""}`);
      }
    });
    (Array.isArray(proposal.listViews) ? proposal.listViews : []).forEach((v, i) => {
      if (!nameOk(v && v.name)) errors.push(`List view ${i + 1} needs a 'name' (letters, digits, single underscores)`);
      for (const c of (v && v.columns) || []) {
        if (c !== "NAME" && !fieldNames.has(c)) errors.push(`List view ${i + 1} column ${c} is not a field of this object`);
      }
    });
    const cl = proposal.compactLayout;
    if (cl && Array.isArray(cl.fields)) {
      for (const c of cl.fields) {
        if (c !== "Name" && !fieldNames.has(c)) errors.push(`Compact layout field ${c} is not a field of this object`);
      }
    }
    if (mdCount > 2) errors.push(`An object can have at most 2 Master-Detail fields (found ${mdCount})`);
  }
  return errors;
}

// Create order: controlling fields before the picklists that depend on
// them, everything else in plan order, roll-up summaries last (they need
// the child relationship to exist).
// Standard fields every custom object has (formulas and list views may use them).
export const STANDARD_OBJECT_FIELDS = ["Id", "Name", "OwnerId", "CreatedDate", "CreatedById", "LastModifiedDate",
  "LastModifiedById", "SystemModstamp", "RecordTypeId", "IsDeleted", "CurrencyIsoCode", "LastActivityDate"];
const FORMULA_WORDS = new Set(["true", "false", "null", "and", "or", "not"]);

// Every field name the plan can reference, lower-cased: its fields, the
// org's other fields (Edit existing object) and the standard ones.
export function knownFieldNames(proposal) {
  const out = new Set(STANDARD_OBJECT_FIELDS.map(n => n.toLowerCase()));
  for (const f of (proposal && proposal.fields) || []) if (f && f.name) out.add(String(f.name).toLowerCase());
  for (const f of (proposal && proposal.orgFields) || []) if (f && f.name) out.add(String(f.name).toLowerCase());
  return out;
}

// Field-like words in a formula that are not fields of the object. Skips
// quoted text, comments, function names (followed by "("), $globals,
// relationship paths (a.b) and TRUE / FALSE / NULL / AND / OR / NOT.
export function formulaUnknownFields(formula, known) {
  const text = String(formula || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
  const out = [];
  const re = /[A-Za-z_$][A-Za-z0-9_.$]*/g;
  let m;
  while ((m = re.exec(text))) {
    const word = m[0];
    const prev = text[m.index - 1];
    if (prev && /[0-9.]/.test(prev)) continue;
    if (word.startsWith("$") || word.includes(".")) continue;
    if (FORMULA_WORDS.has(word.toLowerCase())) continue;
    if (/^\s*\(/.test(text.slice(m.index + word.length))) continue;
    if (!known.has(word.toLowerCase()) && !out.includes(word)) out.push(word);
  }
  return out;
}

// Closest plan field for a mistyped reference: "Amount" → "Amount__c",
// or a field whose label matches.
export function suggestFieldName(ref, proposal) {
  const want = String(ref || "").toLowerCase().replace(/__c$/, "").replace(/[\s_]/g, "");
  if (!want) return null;
  const all = [...((proposal && proposal.fields) || []), ...((proposal && proposal.orgFields) || [])].filter(f => f && f.name);
  const norm = v => String(v || "").toLowerCase().replace(/__c$/, "").replace(/[\s_]/g, "");
  const hit = all.find(f => norm(f.name) === want) || all.find(f => norm(f.label) === want) ||
    all.find(f => norm(f.name).includes(want) || want.includes(norm(f.name)));
  return hit ? hit.name : null;
}

export function sortFieldsForDeploy(fields) {
  const list = (fields || []).slice();
  const byName = new Map(list.map(f => [f.name, f]));
  const out = [];
  const placed = new Set();
  const place = (f, chain = new Set()) => {
    if (!f || placed.has(f.name) || chain.has(f.name)) return;
    chain.add(f.name);
    if (f.controllingField && byName.has(f.controllingField)) place(byName.get(f.controllingField), chain);
    placed.add(f.name);
    out.push(f);
  };
  list.filter(f => normalizeFieldType(f.type) !== "Summary").forEach(f => place(f));
  list.filter(f => normalizeFieldType(f.type) === "Summary").forEach(f => place(f));
  return out;
}

// Index of the "}" closing the object that opens at `start`, or -1.
// String-aware so braces inside JSON strings do not count.
function findBalancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Drop commas that directly precede } or ] (outside strings).
export function stripTrailingCommas(json) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (json[j] === "}" || json[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function tryParseObject(candidate) {
  for (const src of [candidate, stripTrailingCommas(candidate)]) {
    try {
      const v = JSON.parse(src);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch (e) { /* try next */ }
  }
  return null;
}

function firstObjectIn(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = findBalancedEnd(text, start);
    if (end === -1) return null;
    const parsed = tryParseObject(text.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

// First balanced JSON object in an LLM reply (fenced or surrounded by
// prose), tolerating trailing commas. Returns null when none parses.
export function parseJSONFromText(text) {
  if (text == null) return null;
  const s = String(text);
  const fence = /```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(s)) !== null) {
    const parsed = firstObjectIn(m[1]);
    if (parsed) return parsed;
  }
  return firstObjectIn(s.replace(/```[A-Za-z0-9_-]*/g, ""));
}

// Errors that will fail the same way on every retry (bad metadata, local
// build errors). Transient ones (timeouts, propagation) are retried.
export function isNonTransientDeployError(err) {
  if (!err) return false;
  if (err.nonTransient) return true;
  const text = `${err.statusCode || ""} ${err.message || ""}`;
  return /Unsupported field type|has no values|FIELD_INTEGRITY_EXCEPTION|INVALID_TYPE\b|INVALID_FIELD\b|INVALID_NAME|INVALID_VALUE|REQUIRED_FIELD_MISSING|STRING_TOO_LONG|MAX_.*EXCEEDED|LIMIT_EXCEEDED|Element \{[^}]*\}\w+ invalid at this location/i.test(text);
}
