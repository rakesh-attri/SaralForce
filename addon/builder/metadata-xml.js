// Pure Metadata API XML builders for the Object Builder. No DOM, no network,
// no React — every function returns a string so it can be unit-tested in Node.
import {normalizeFieldType, supportsRequired, resolveNameField, CALCULATED_TYPES, FORMULA_RETURN_TYPES} from "../core/object-builder-rules.js";

export function escXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Valid CustomTab motifs: format MUST be "CustomNN: IconName" (bare "CustomNN"
// is rejected). Object tabs allow ONLY customObject + motif (+ optional
// description) — <label> on object tabs causes a deployment error.
export const TAB_MOTIFS = [
  "Custom1: Heart", "Custom2: Fan", "Custom3: Sun", "Custom4: Hexagon",
  "Custom5: Leaf", "Custom6: Triangle", "Custom7: Square", "Custom8: Diamond",
  "Custom9: Lightbulb", "Custom10: Cup", "Custom11: Star", "Custom12: Music",
  "Custom13: Phone", "Custom14: Flag", "Custom15: Airplane", "Custom16: Trophy",
  "Custom17: Envelope", "Custom18: Umbrella", "Custom19: Bell", "Custom20: Book",
  "Custom21: Camera", "Custom22: Clock", "Custom23: Cloud", "Custom24: Compass",
  "Custom25: Computer", "Custom26: CreditCard", "Custom27: Desk", "Custom28: Globe",
  "Custom29: Keys", "Custom30: Map", "Custom31: Pencil", "Custom32: People",
  "Custom33: Puzzle", "Custom34: Truck", "Custom35: Wrench", "Custom36: Briefcase",
  "Custom37: Calculator", "Custom38: Car", "Custom39: Telescope", "Custom40: Factory",
  "Custom41: Building", "Custom42: Bank", "Custom43: Bridge", "Custom44: Castle",
  "Custom45: Medal", "Custom46: Computer", "Custom47: Chip", "Custom48: Trophy",
  "Custom49: CD/DVD", "Custom50: Bigtop", "Custom51: Apple", "Custom52: Balls",
  "Custom53: Bell", "Custom54: Boat", "Custom55: Books", "Custom56: Bottle",
  "Custom57: Desert", "Custom58: Caduceus", "Custom59: Can", "Custom60: Umbrella",
  "Custom61: Castle", "Custom62: Chalkboard", "Custom63: Chip", "Custom64: Compass",
  "Custom65: Cup", "Custom66: Dice", "Custom67: Gears", "Custom68: Globe",
  "Custom69: Guitar", "Custom70: Handsaw", "Custom71: Headset", "Custom72: Helicopter",
  "Custom73: HighwaySign", "Custom74: HotAirBalloon", "Custom75: IPPhone",
  "Custom76: Keys", "Custom77: Locked", "Custom78: Map", "Custom79: MeasuringTape",
  "Custom80: Motorcycle", "Custom81: MusicalNote", "Custom82: Whistle",
  "Custom83: Pencil", "Custom84: Presenter", "Custom85: RealEstateSign",
  "Custom86: RedCross", "Custom87: Safe", "Custom88: Sailboat", "Custom89: Saxophone",
  "Custom90: Scales", "Custom91: Shield", "Custom92: Ship", "Custom93: ShoppingCart",
  "Custom94: Stethoscope", "Custom95: Stopwatch", "Custom96: StreetSign",
  "Custom97: Thermometer", "Custom98: Truck", "Custom99: TVCRT",
  "Custom100: TVWidescreen"
];

export function pickTabMotif(objectName) {
  let hash = 0;
  for (let i = 0; i < objectName.length; i++) {
    hash = ((hash << 5) - hash + objectName.charCodeAt(i)) | 0;
  }
  return TAB_MOTIFS[Math.abs(hash) % TAB_MOTIFS.length];
}

// Metadata API relationshipName is the child-relationship developer name on
// the PARENT (relatedTo) object — it must be unique across that parent.
// "Assigned_To" already exists on User for many orgs → always prefix the
// child object name: IT_Asset__c.Assigned_To__c → IT_Asset_Assigned_To.
export function safeRelationshipName(fieldDef, objectName) {
  const sanitize = s => String(s || "")
    .replace(/__(?:c|r)$/i, "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  let rel = sanitize(fieldDef.relationshipName);
  if (!rel || !/^[A-Za-z]/.test(rel)) {
    rel = sanitize(fieldDef.name);
  }
  if (!rel) rel = "Rel";
  const objBase = sanitize(objectName);
  if (objBase) {
    const lower = rel.toLowerCase();
    const objLower = objBase.toLowerCase();
    if (lower !== objLower && !lower.startsWith(objLower + "_")) {
      rel = objBase + "_" + rel;
    }
  }
  // relationshipName max length is 40 in Metadata API.
  if (rel.length > 40) {
    if (objBase && objBase.length < 30) {
      const tailLen = Math.max(8, 40 - objBase.length - 1);
      rel = objBase + "_" + rel.slice(-tailLen);
      rel = rel.replace(/_+$/g, "").replace(/^_+/g, "");
      if (rel.length > 40) rel = rel.slice(0, 40).replace(/_+$/g, "");
    } else {
      rel = rel.slice(0, 40).replace(/_+$/g, "");
    }
  }
  if (!rel || !/^[A-Za-z]/.test(rel)) rel = "Rel" + rel.replace(/[^A-Za-z0-9]/g, "");
  if (!rel) rel = "RelField";
  return rel;
}

export function buildObjectXml(objectDef) {
  // Prompt/plan contract is object.nameField.{label,type,format}; the flat
  // nameFieldType/nameFieldLabel/displayFormat keys are a legacy fallback.
  const nameField = resolveNameField(objectDef);
  const nameFieldXml = nameField.type === "AutoNumber"
    ? `<met:nameField><met:displayFormat>${escXml(nameField.displayFormat)}</met:displayFormat><met:label>${escXml(nameField.label)}</met:label><met:type>AutoNumber</met:type></met:nameField>`
    : `<met:nameField><met:label>${escXml(nameField.label)}</met:label><met:type>Text</met:type></met:nameField>`;

  const parts = [
    `<met:metadata xsi:type="met:CustomObject">`,
    `  <met:fullName>${escXml(objectDef.name)}</met:fullName>`,
    `  <met:label>${escXml(objectDef.label)}</met:label>`,
    `  <met:pluralLabel>${escXml(objectDef.pluralLabel || objectDef.label + "s")}</met:pluralLabel>`,
    `  <met:deploymentStatus>Deployed</met:deploymentStatus>`,
    `  <met:sharingModel>${escXml(objectDef.sharingModel || "ReadWrite")}</met:sharingModel>`,
  ];
  if (objectDef.description) {
    parts.push(`  <met:description>${escXml(objectDef.description)}</met:description>`);
  }
  // Optional object features (Plan → Object settings). Omitted = Salesforce default.
  for (const [key, tag] of [["enableHistory", "enableHistory"], ["enableReports", "enableReports"],
    ["enableActivities", "enableActivities"], ["enableSearch", "enableSearch"], ["enableFeeds", "enableFeeds"],
    ["enableBulkApi", "enableBulkApi"], ["enableSharing", "enableSharing"], ["enableStreamingApi", "enableStreamingApi"]]) {
    if (typeof objectDef[key] === "boolean") parts.push(`  <met:${tag}>${objectDef[key] ? "true" : "false"}</met:${tag}>`);
  }
  parts.push(`  ${nameFieldXml}`);
  parts.push(`</met:metadata>`);
  return parts.join("\n");
}

export function buildFieldXml(objectName, fieldDef) {
  const fullName = `${objectName}.${fieldDef.name}`;
  const type = normalizeFieldType(fieldDef.type);
  if (!type) throw new Error(`Unsupported field type: ${fieldDef.type}`);
  const special = buildSpecialFieldXml(objectName, fieldDef);
  if (special) return special;
  const parts = [
    `<met:metadata xsi:type="met:CustomField">`,
    `  <met:fullName>${escXml(fullName)}</met:fullName>`,
    `  <met:label>${escXml(fieldDef.label)}</met:label>`,
    `  <met:type>${type}</met:type>`,
  ];

  if (fieldDef.description) {
    parts.push(`  <met:description>${escXml(fieldDef.description)}</met:description>`);
  }

  const required = !!fieldDef.required && fieldDef.required !== "false" && supportsRequired(type);
  if (required) parts.push(`  <met:required>true</met:required>`);
  if (fieldDef.trackHistory && !CALCULATED_TYPES.has(type)) parts.push(`  <met:trackHistory>true</met:trackHistory>`);
  if (fieldDef.inlineHelpText) parts.push(`  <met:inlineHelpText>${escXml(fieldDef.inlineHelpText)}</met:inlineHelpText>`);

  switch (type) {
    case "Text":
      parts.push(`  <met:length>${fieldDef.length || 255}</met:length>`);
      if (fieldDef.unique) parts.push(`  <met:unique>true</met:unique>`);
      if (fieldDef.externalId) parts.push(`  <met:externalId>true</met:externalId>`);
      break;
    case "TextArea":
      break;
    case "LongTextArea":
      parts.push(`  <met:length>${fieldDef.length || 32768}</met:length>`);
      parts.push(`  <met:visibleLines>${fieldDef.visibleLines || 6}</met:visibleLines>`);
      break;
    case "Number":
    case "Currency":
    case "Percent":
      parts.push(`  <met:precision>${parseInt(fieldDef.precision) || 18}</met:precision>`);
      parts.push(`  <met:scale>${parseInt(fieldDef.scale) || 0}</met:scale>`);
      if (type === "Number") {
        if (fieldDef.unique) parts.push(`  <met:unique>true</met:unique>`);
        if (fieldDef.externalId) parts.push(`  <met:externalId>true</met:externalId>`);
      }
      break;
    case "Date":
    case "DateTime":
    case "Email":
    case "Phone":
    case "Url":
      break;
    case "Checkbox":
      parts.push(`  <met:defaultValue>${fieldDef.defaultValue === true || fieldDef.defaultValue === "true" ? "true" : "false"}</met:defaultValue>`);
      break;
    case "Picklist":
    case "MultiselectPicklist": {
      // Global value set: the values live in the org-wide set.
      if (fieldDef.globalValueSet) {
        parts.push(`  <met:valueSet>`);
        parts.push(`    <met:restricted>true</met:restricted>`);
        parts.push(`    <met:valueSetName>${escXml(fieldDef.globalValueSet)}</met:valueSetName>`);
        parts.push(`  </met:valueSet>`);
        if (type === "MultiselectPicklist") parts.push(`  <met:visibleLines>${parseInt(fieldDef.visibleLines) || 4}</met:visibleLines>`);
        break;
      }
      // Empty/null values or a defaultValue outside the set →
      // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST on create.
      const raw = Array.isArray(fieldDef.values) ? fieldDef.values : [];
      const values = [];
      const seen = new Set();
      for (const v of raw) {
        const s = String(v == null ? "" : v).trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(s);
      }
      if (!values.length) {
        throw new Error(
          `Picklist field "${fieldDef.name}" has no values — provide 2-5 options`
        );
      }
      let defVal = String(fieldDef.defaultValue == null ? "" : fieldDef.defaultValue).trim();
      if (defVal && !values.some(v => v.toLowerCase() === defVal.toLowerCase())) {
        defVal = "";
      }
      if (!defVal) defVal = values[0];
      parts.push(`  <met:valueSet>`);
      // Dependent picklist: which values show for each controlling value.
      if (fieldDef.controllingField) {
        parts.push(`    <met:controllingField>${escXml(fieldDef.controllingField)}</met:controllingField>`);
      }
      parts.push(`    <met:valueSetDefinition>`);
      parts.push(`      <met:sorted>${fieldDef.sortValues ? "true" : "false"}</met:sorted>`);
      for (const v of values) {
        const isDefault = v.toLowerCase() === defVal.toLowerCase();
        parts.push(`      <met:value>`);
        parts.push(`        <met:fullName>${escXml(v)}</met:fullName>`);
        parts.push(`        <met:default>${isDefault ? "true" : "false"}</met:default>`);
        parts.push(`        <met:label>${escXml(v)}</met:label>`);
        parts.push(`      </met:value>`);
      }
      parts.push(`    </met:valueSetDefinition>`);
      if (fieldDef.controllingField && fieldDef.dependencies && typeof fieldDef.dependencies === "object") {
        // valueSettings: one entry per dependent value, listing the
        // controlling values it is available for.
        const byValue = new Map();
        for (const [ctrlValue, deps] of Object.entries(fieldDef.dependencies)) {
          for (const d of Array.isArray(deps) ? deps : []) {
            const match = values.find(v => v.toLowerCase() === String(d).trim().toLowerCase());
            if (!match) continue;
            if (!byValue.has(match)) byValue.set(match, []);
            byValue.get(match).push(ctrlValue);
          }
        }
        for (const [v, ctrls] of byValue) {
          parts.push(`    <met:valueSettings>`);
          // A checkbox controller's values are "checked" / "unchecked".
          const ctrlName = c => ({true: "checked", false: "unchecked"})[String(c).toLowerCase()] || c;
          for (const c of ctrls) parts.push(`      <met:controllingFieldValue>${escXml(ctrlName(c))}</met:controllingFieldValue>`);
          parts.push(`      <met:valueName>${escXml(v)}</met:valueName>`);
          parts.push(`    </met:valueSettings>`);
        }
      }
      parts.push(`  </met:valueSet>`);
      if (type === "MultiselectPicklist") {
        parts.push(`  <met:visibleLines>${parseInt(fieldDef.visibleLines) || 4}</met:visibleLines>`);
      }
      break;
    }
    case "Lookup":
    case "MasterDetail": {
      const relName = safeRelationshipName(fieldDef, objectName);
      parts.push(`  <met:relationshipLabel>${escXml(fieldDef.label)}</met:relationshipLabel>`);
      parts.push(`  <met:relationshipName>${escXml(relName)}</met:relationshipName>`);
      parts.push(`  <met:referenceTo>${escXml(fieldDef.relatedTo)}</met:referenceTo>`);
      // A required lookup cannot keep the default SetNull delete
      // constraint, so pair it with Restrict.
      if (type === "Lookup" && (required || fieldDef.deleteConstraint === "Restrict")) {
        parts.push(`  <met:deleteConstraint>Restrict</met:deleteConstraint>`);
      }
      break;
    }
    case "Formula":
    case "Summary":
    case "AutoNumber":
    case "Location":
    case "Time":
    case "Html":
    case "EncryptedText":
      break;
    default:
      throw new Error(`Unsupported field type: ${fieldDef.type}`);
  }

  parts.push(`</met:metadata>`);
  return parts.join("\n");
}

// The types below are written by buildFieldXml's caller-facing wrapper: the
// <met:type> they need differs from the plan type (a Formula field's type is
// its return type), so they are assembled here.
export function buildSpecialFieldXml(objectName, fieldDef) {
  const type = normalizeFieldType(fieldDef.type);
  const head = (xmlType) => [
    `<met:metadata xsi:type="met:CustomField">`,
    `  <met:fullName>${escXml(`${objectName}.${fieldDef.name}`)}</met:fullName>`,
    `  <met:label>${escXml(fieldDef.label)}</met:label>`,
    `  <met:type>${xmlType}</met:type>`,
    ...(fieldDef.description ? [`  <met:description>${escXml(fieldDef.description)}</met:description>`] : []),
    ...(fieldDef.inlineHelpText ? [`  <met:inlineHelpText>${escXml(fieldDef.inlineHelpText)}</met:inlineHelpText>`] : []),
  ];
  const required = !!fieldDef.required && fieldDef.required !== "false" && supportsRequired(type);
  const track = fieldDef.trackHistory ? [`  <met:trackHistory>true</met:trackHistory>`] : [];
  let parts;
  switch (type) {
    case "Formula": {
      const rt = FORMULA_RETURN_TYPES.includes(fieldDef.returnType) ? fieldDef.returnType : "Text";
      parts = head(rt);
      parts.push(`  <met:formula>${escXml(fieldDef.formula)}</met:formula>`);
      parts.push(`  <met:formulaTreatBlanksAs>${fieldDef.treatBlanksAs === "BlankAsBlank" ? "BlankAsBlank" : "BlankAsZero"}</met:formulaTreatBlanksAs>`);
      if (["Number", "Currency", "Percent"].includes(rt)) {
        parts.push(`  <met:precision>${parseInt(fieldDef.precision) || 18}</met:precision>`);
        parts.push(`  <met:scale>${parseInt(fieldDef.scale) || (rt === "Number" ? 0 : 2)}</met:scale>`);
      }
      break;
    }
    case "Summary": {
      parts = head("Summary");
      const op = String(fieldDef.summaryOperation || "count").toLowerCase();
      parts.push(`  <met:summaryForeignKey>${escXml(fieldDef.summaryForeignKey)}</met:summaryForeignKey>`);
      parts.push(`  <met:summaryOperation>${op}</met:summaryOperation>`);
      if (op !== "count") parts.push(`  <met:summarizedField>${escXml(fieldDef.summarizedField)}</met:summarizedField>`);
      break;
    }
    case "AutoNumber":
      parts = head("AutoNumber");
      parts.push(`  <met:displayFormat>${escXml(fieldDef.displayFormat || "{0000}")}</met:displayFormat>`);
      parts.push(`  <met:startingNumber>${parseInt(fieldDef.startingNumber) || 1}</met:startingNumber>`);
      if (fieldDef.externalId) parts.push(`  <met:externalId>true</met:externalId>`);
      break;
    case "Location":
      parts = head("Location");
      parts.push(`  <met:displayLocationInDecimal>${fieldDef.displayLocationInDecimal === false ? "false" : "true"}</met:displayLocationInDecimal>`);
      parts.push(`  <met:scale>${Number.isInteger(Number(fieldDef.scale)) ? Number(fieldDef.scale) : 5}</met:scale>`);
      if (required) parts.push(`  <met:required>true</met:required>`);
      parts.push(...track);
      break;
    case "Time":
      parts = head("Time");
      if (required) parts.push(`  <met:required>true</met:required>`);
      parts.push(...track);
      break;
    case "Html":
      parts = head("Html");
      parts.push(`  <met:length>${parseInt(fieldDef.length) || 32768}</met:length>`);
      parts.push(`  <met:visibleLines>${parseInt(fieldDef.visibleLines) || 25}</met:visibleLines>`);
      parts.push(...track);
      break;
    case "EncryptedText":
      parts = head("EncryptedText");
      parts.push(`  <met:length>${Math.min(175, parseInt(fieldDef.length) || 175)}</met:length>`);
      parts.push(`  <met:maskChar>${fieldDef.maskChar === "X" ? "X" : "asterisk"}</met:maskChar>`);
      parts.push(`  <met:maskType>${fieldDef.maskType || "all"}</met:maskType>`);
      if (required) parts.push(`  <met:required>true</met:required>`);
      parts.push(...track);
      break;
    default:
      return null;
  }
  parts.push(`</met:metadata>`);
  return parts.join("\n");
}

// Any field: special types first, the classic types otherwise.
export function buildAnyFieldXml(objectName, fieldDef) {
  return buildSpecialFieldXml(objectName, fieldDef) || buildFieldXml(objectName, fieldDef);
}

export function buildValidationRuleXml(objectName, rule) {
  return [
    `<met:metadata xsi:type="met:ValidationRule">`,
    `  <met:fullName>${escXml(`${objectName}.${rule.name}`)}</met:fullName>`,
    `  <met:active>${rule.active === false ? "false" : "true"}</met:active>`,
    ...(rule.description ? [`  <met:description>${escXml(rule.description)}</met:description>`] : []),
    `  <met:errorConditionFormula>${escXml(rule.formula)}</met:errorConditionFormula>`,
    ...(rule.field ? [`  <met:errorDisplayField>${escXml(rule.field)}</met:errorDisplayField>`] : []),
    `  <met:errorMessage>${escXml(rule.message)}</met:errorMessage>`,
    `</met:metadata>`,
  ].join("\n");
}

export function buildListViewXml(objectName, view) {
  const cols = (view.columns && view.columns.length ? view.columns : ["NAME"]);
  return [
    `<met:metadata xsi:type="met:ListView">`,
    `  <met:fullName>${escXml(`${objectName}.${view.name}`)}</met:fullName>`,
    ...cols.map(c => `  <met:columns>${escXml(c)}</met:columns>`),
    `  <met:filterScope>${view.filterScope === "Mine" ? "Mine" : "Everything"}</met:filterScope>`,
    `  <met:label>${escXml(view.label || view.name)}</met:label>`,
    `</met:metadata>`,
  ].join("\n");
}

export function buildCompactLayoutXml(objectName, layout) {
  const fields = (layout.fields && layout.fields.length ? layout.fields : ["Name"]).slice(0, 10);
  return [
    `<met:metadata xsi:type="met:CompactLayout">`,
    `  <met:fullName>${escXml(`${objectName}.${layout.name || "SaralForce_Compact"}`)}</met:fullName>`,
    ...fields.map(f => `  <met:fields>${escXml(f)}</met:fields>`),
    `  <met:label>${escXml(layout.label || "SaralForce Compact")}</met:label>`,
    `</met:metadata>`,
  ].join("\n");
}

export function buildRecordTypeXml(objectName, rt) {
  // Standalone RecordType create: fullName is ObjectApi.DeveloperName
  // (DeveloperName has NO __c suffix). Omit businessProcess — custom
  // objects have none. Deployed via metadataCreate (createMetadata).
  const parts = [
    `<met:metadata xsi:type="met:RecordType">`,
    `  <met:fullName>${escXml(objectName)}.${escXml(rt.name)}</met:fullName>`,
    `  <met:label>${escXml(rt.label)}</met:label>`,
    `  <met:active>${rt.active === false ? "false" : "true"}</met:active>`,
  ];
  if (rt.description) {
    parts.push(`  <met:description>${escXml(rt.description)}</met:description>`);
  }
  parts.push(`</met:metadata>`);
  return parts.join("\n");
}

export function buildTabXml(objectName, objectLabel) {
  const motif = pickTabMotif(objectName);
  // NOTE: object tabs must NOT include <met:label> — only customObject +
  // motif (+ optional description). Label causes deployment errors.
  // fullName for an object tab is the object API name.
  return `<met:metadata xsi:type="met:CustomTab">\n` +
    `  <met:fullName>${escXml(objectName)}</met:fullName>\n` +
    `  <met:customObject>true</met:customObject>\n` +
    `  <met:motif>${escXml(motif)}</met:motif>\n` +
    `  <met:description>${escXml("Tab for " + objectLabel)}</met:description>\n` +
    `</met:metadata>`;
}

// ── Profile (partial updateMetadata) fragments ──

export function buildTabVisibilityXml(objectName) {
  return `<met:tabVisibilities><met:tab>${escXml(objectName)}</met:tab>` +
    `<met:visibility>DefaultOn</met:visibility></met:tabVisibilities>`;
}

export function buildRecordTypeVisibilityXml(objectName, rtName) {
  return `<met:recordTypeVisibilities>` +
    `<met:default>false</met:default>` +
    `<met:recordType>${escXml(objectName)}.${escXml(rtName)}</met:recordType>` +
    `<met:visible>true</met:visible></met:recordTypeVisibilities>`;
}

// `parts` are already-escaped child fragments (see the two builders above).
export function buildProfileXml(fullName, parts) {
  return `<met:metadata xsi:type="met:Profile">` +
    `<met:fullName>${escXml(fullName)}</met:fullName>` +
    `${parts.join("")}</met:metadata>`;
}

// Fresh Layout for createMetadata; `sectionsXml` is serialized met: XML.
export function buildLayoutXml(fullName, sectionsXml) {
  return `<met:metadata xsi:type="met:Layout">` +
    `<met:fullName>${escXml(fullName)}</met:fullName>` +
    `${sectionsXml}</met:metadata>`;
}

// updateMetadata payload; `childrenXml` is serialized met: XML.
export function buildUpdateMetadataXml(xsiType, fullName, childrenXml) {
  return `<met:metadata xsi:type="met:${xsiType}">` +
    `<met:fullName>${escXml(fullName)}</met:fullName>${childrenXml}</met:metadata>`;
}

export function buildReadMetadataBody(type, fullName) {
  return `<met:readMetadata><met:type>${escXml(type)}</met:type>` +
    `<met:fullNames>${escXml(fullName)}</met:fullNames></met:readMetadata>`;
}

export function buildListMetadataBody(type) {
  return `<met:listMetadata><met:queries><met:type>${escXml(type)}</met:type></met:queries></met:listMetadata>`;
}
