import {test} from "node:test";
import assert from "node:assert/strict";
import {
  escXml, pickTabMotif, TAB_MOTIFS, safeRelationshipName, buildObjectXml, buildFieldXml,
  buildRecordTypeXml, buildTabXml, buildTabVisibilityXml, buildRecordTypeVisibilityXml,
  buildProfileXml, buildLayoutXml, buildUpdateMetadataXml, buildReadMetadataBody, buildListMetadataBody
} from "../../addon/builder/metadata-xml.js";

// Expected strings were captured from the App-class builders in
// addon/object-creator.js before they moved to builder/metadata-xml.js, so
// these tests pin the extraction as byte-identical.

const fieldFixtures = {
  text: ["Invoice__c", {name: "Code__c", label: "Code", type: "Text", length: 80, unique: true, externalId: true, description: "Unique code"}],
  textDefaultLength: ["Invoice__c", {name: "Memo__c", label: "Memo", type: "Text"}],
  number: ["Invoice__c", {name: "Amount__c", label: "Amount", type: "Number", precision: 10, scale: 2, required: true}],
  currencyDefaults: ["Invoice__c", {name: "Total__c", label: "Total", type: "Currency"}],
  picklist: ["Invoice__c", {name: "Status__c", label: "Status", type: "Picklist", values: ["Open", " Closed ", "", "open", "Paid"], defaultValue: "Paid", sortValues: true}],
  multiPicklist: ["Invoice__c", {name: "Tags__c", label: "Tags", type: "MultiselectPicklist", values: ["A", "B"], defaultValue: "Z"}],
  lookupRequired: ["Invoice__c", {name: "Account__c", label: "Account", type: "Lookup", relatedTo: "Account", required: true}],
  lookupOptional: ["Invoice__c", {name: "Owner_Contact__c", label: "Owner Contact", type: "Lookup", relatedTo: "Contact", relationshipName: "Owner_Contacts"}],
  masterDetail: ["Invoice_Line__c", {name: "Invoice__c", label: "Invoice", type: "Master-Detail", relatedTo: "Invoice__c", required: true}],
  checkbox: ["Invoice__c", {name: "Paid__c", label: "Paid", type: "Checkbox", defaultValue: "true", required: true}],
  escaping: ["Invoice__c", {name: "Note__c", label: "Q&A <\"Tom's\">", type: "LongTextArea", description: "a < b && c > \"d\" 'e'"}]
};
const objectFixtures = {
  autoNumber: {name: "Invoice__c", label: "Invoice", pluralLabel: "Invoices", sharingModel: "Private", description: "Billing", nameField: {label: "Invoice Number", type: "AutoNumber", format: "INV-{0000}"}},
  textName: {name: "Asset_Tag__c", label: "Asset Tag", nameField: {label: "Tag Name", type: "Text"}},
  escaping: {name: "R_D__c", label: "R&D <Lab>", description: "\"Tom's\" & <co>", nameField: {label: "R&D Name", type: "Text"}}
};
const recordTypeFixtures = {
  basic: ["Invoice__c", {name: "Standard", label: "Standard & <Co>", description: "Default 'RT'"}],
  inactive: ["Invoice__c", {name: "Legacy", label: "Legacy", active: false}]
};
const tabFixtures = {
  basic: ["Invoice__c", "Invoice"],
  escaping: ["R_D__c", "R&D <Lab> \"x\" 'y'"]
};

test("Text field with length, unique, externalId and description", () => {
  assert.equal(buildFieldXml(...fieldFixtures.text), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Code__c</met:fullName>",
    "  <met:label>Code</met:label>",
    "  <met:type>Text</met:type>",
    "  <met:description>Unique code</met:description>",
    "  <met:length>80</met:length>",
    "  <met:unique>true</met:unique>",
    "  <met:externalId>true</met:externalId>",
    "</met:metadata>"
  ].join("\n"));
});

test("Text field defaults length to 255", () => {
  assert.equal(buildFieldXml(...fieldFixtures.textDefaultLength), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Memo__c</met:fullName>",
    "  <met:label>Memo</met:label>",
    "  <met:type>Text</met:type>",
    "  <met:length>255</met:length>",
    "</met:metadata>"
  ].join("\n"));
});

test("Number field with precision/scale and required", () => {
  assert.equal(buildFieldXml(...fieldFixtures.number), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Amount__c</met:fullName>",
    "  <met:label>Amount</met:label>",
    "  <met:type>Number</met:type>",
    "  <met:required>true</met:required>",
    "  <met:precision>10</met:precision>",
    "  <met:scale>2</met:scale>",
    "</met:metadata>"
  ].join("\n"));
});

test("Currency field defaults precision 18 / scale 0", () => {
  assert.equal(buildFieldXml(...fieldFixtures.currencyDefaults), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Total__c</met:fullName>",
    "  <met:label>Total</met:label>",
    "  <met:type>Currency</met:type>",
    "  <met:precision>18</met:precision>",
    "  <met:scale>0</met:scale>",
    "</met:metadata>"
  ].join("\n"));
});

test("Picklist trims, de-dupes (case-insensitive), drops blanks and keeps a valid default", () => {
  assert.equal(buildFieldXml(...fieldFixtures.picklist), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Status__c</met:fullName>",
    "  <met:label>Status</met:label>",
    "  <met:type>Picklist</met:type>",
    "  <met:valueSet>",
    "    <met:valueSetDefinition>",
    "      <met:sorted>true</met:sorted>",
    "      <met:value>",
    "        <met:fullName>Open</met:fullName>",
    "        <met:default>false</met:default>",
    "        <met:label>Open</met:label>",
    "      </met:value>",
    "      <met:value>",
    "        <met:fullName>Closed</met:fullName>",
    "        <met:default>false</met:default>",
    "        <met:label>Closed</met:label>",
    "      </met:value>",
    "      <met:value>",
    "        <met:fullName>Paid</met:fullName>",
    "        <met:default>true</met:default>",
    "        <met:label>Paid</met:label>",
    "      </met:value>",
    "    </met:valueSetDefinition>",
    "  </met:valueSet>",
    "</met:metadata>"
  ].join("\n"));
});

test("MultiselectPicklist falls back to first value when default is not in the set", () => {
  assert.equal(buildFieldXml(...fieldFixtures.multiPicklist), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Tags__c</met:fullName>",
    "  <met:label>Tags</met:label>",
    "  <met:type>MultiselectPicklist</met:type>",
    "  <met:valueSet>",
    "    <met:valueSetDefinition>",
    "      <met:sorted>false</met:sorted>",
    "      <met:value>",
    "        <met:fullName>A</met:fullName>",
    "        <met:default>true</met:default>",
    "        <met:label>A</met:label>",
    "      </met:value>",
    "      <met:value>",
    "        <met:fullName>B</met:fullName>",
    "        <met:default>false</met:default>",
    "        <met:label>B</met:label>",
    "      </met:value>",
    "    </met:valueSetDefinition>",
    "  </met:valueSet>",
    "  <met:visibleLines>4</met:visibleLines>",
    "</met:metadata>"
  ].join("\n"));
});

test("required Lookup gets deleteConstraint Restrict and an object-prefixed relationshipName", () => {
  assert.equal(buildFieldXml(...fieldFixtures.lookupRequired), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Account__c</met:fullName>",
    "  <met:label>Account</met:label>",
    "  <met:type>Lookup</met:type>",
    "  <met:required>true</met:required>",
    "  <met:relationshipLabel>Account</met:relationshipLabel>",
    "  <met:relationshipName>Invoice_Account</met:relationshipName>",
    "  <met:referenceTo>Account</met:referenceTo>",
    "  <met:deleteConstraint>Restrict</met:deleteConstraint>",
    "</met:metadata>"
  ].join("\n"));
});

test("optional Lookup keeps SetNull (no deleteConstraint) and prefixes a given relationshipName", () => {
  assert.equal(buildFieldXml(...fieldFixtures.lookupOptional), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Owner_Contact__c</met:fullName>",
    "  <met:label>Owner Contact</met:label>",
    "  <met:type>Lookup</met:type>",
    "  <met:relationshipLabel>Owner Contact</met:relationshipLabel>",
    "  <met:relationshipName>Invoice_Owner_Contacts</met:relationshipName>",
    "  <met:referenceTo>Contact</met:referenceTo>",
    "</met:metadata>"
  ].join("\n"));
});

test("MasterDetail (from a \"Master-Detail\" alias) is never marked required in XML", () => {
  assert.equal(buildFieldXml(...fieldFixtures.masterDetail), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice_Line__c.Invoice__c</met:fullName>",
    "  <met:label>Invoice</met:label>",
    "  <met:type>MasterDetail</met:type>",
    "  <met:relationshipLabel>Invoice</met:relationshipLabel>",
    "  <met:relationshipName>Invoice_Line_Invoice</met:relationshipName>",
    "  <met:referenceTo>Invoice__c</met:referenceTo>",
    "</met:metadata>"
  ].join("\n"));
});

test("Checkbox emits defaultValue and ignores required", () => {
  assert.equal(buildFieldXml(...fieldFixtures.checkbox), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Paid__c</met:fullName>",
    "  <met:label>Paid</met:label>",
    "  <met:type>Checkbox</met:type>",
    "  <met:defaultValue>true</met:defaultValue>",
    "</met:metadata>"
  ].join("\n"));
});

test("escapes <&\"'> in field label and description", () => {
  assert.equal(buildFieldXml(...fieldFixtures.escaping), [
    "<met:metadata xsi:type=\"met:CustomField\">",
    "  <met:fullName>Invoice__c.Note__c</met:fullName>",
    "  <met:label>Q&amp;A &lt;&quot;Tom&apos;s&quot;&gt;</met:label>",
    "  <met:type>LongTextArea</met:type>",
    "  <met:description>a &lt; b &amp;&amp; c &gt; &quot;d&quot; &apos;e&apos;</met:description>",
    "  <met:length>32768</met:length>",
    "  <met:visibleLines>6</met:visibleLines>",
    "</met:metadata>"
  ].join("\n"));
});

test("CustomObject with AutoNumber name field, description and sharing model", () => {
  assert.equal(buildObjectXml(objectFixtures.autoNumber), [
    "<met:metadata xsi:type=\"met:CustomObject\">",
    "  <met:fullName>Invoice__c</met:fullName>",
    "  <met:label>Invoice</met:label>",
    "  <met:pluralLabel>Invoices</met:pluralLabel>",
    "  <met:deploymentStatus>Deployed</met:deploymentStatus>",
    "  <met:sharingModel>Private</met:sharingModel>",
    "  <met:description>Billing</met:description>",
    "  <met:nameField><met:displayFormat>INV-{0000}</met:displayFormat><met:label>Invoice Number</met:label><met:type>AutoNumber</met:type></met:nameField>",
    "</met:metadata>"
  ].join("\n"));
});

test("CustomObject with Text name field and default plural/sharing", () => {
  assert.equal(buildObjectXml(objectFixtures.textName), [
    "<met:metadata xsi:type=\"met:CustomObject\">",
    "  <met:fullName>Asset_Tag__c</met:fullName>",
    "  <met:label>Asset Tag</met:label>",
    "  <met:pluralLabel>Asset Tags</met:pluralLabel>",
    "  <met:deploymentStatus>Deployed</met:deploymentStatus>",
    "  <met:sharingModel>ReadWrite</met:sharingModel>",
    "  <met:nameField><met:label>Tag Name</met:label><met:type>Text</met:type></met:nameField>",
    "</met:metadata>"
  ].join("\n"));
});

test("escapes <&\"'> in object label, plural and description", () => {
  assert.equal(buildObjectXml(objectFixtures.escaping), [
    "<met:metadata xsi:type=\"met:CustomObject\">",
    "  <met:fullName>R_D__c</met:fullName>",
    "  <met:label>R&amp;D &lt;Lab&gt;</met:label>",
    "  <met:pluralLabel>R&amp;D &lt;Lab&gt;s</met:pluralLabel>",
    "  <met:deploymentStatus>Deployed</met:deploymentStatus>",
    "  <met:sharingModel>ReadWrite</met:sharingModel>",
    "  <met:description>&quot;Tom&apos;s&quot; &amp; &lt;co&gt;</met:description>",
    "  <met:nameField><met:label>R&amp;D Name</met:label><met:type>Text</met:type></met:nameField>",
    "</met:metadata>"
  ].join("\n"));
});

test("RecordType with escaped label and description", () => {
  assert.equal(buildRecordTypeXml(...recordTypeFixtures.basic), [
    "<met:metadata xsi:type=\"met:RecordType\">",
    "  <met:fullName>Invoice__c.Standard</met:fullName>",
    "  <met:label>Standard &amp; &lt;Co&gt;</met:label>",
    "  <met:active>true</met:active>",
    "  <met:description>Default &apos;RT&apos;</met:description>",
    "</met:metadata>"
  ].join("\n"));
});

test("inactive RecordType", () => {
  assert.equal(buildRecordTypeXml(...recordTypeFixtures.inactive), [
    "<met:metadata xsi:type=\"met:RecordType\">",
    "  <met:fullName>Invoice__c.Legacy</met:fullName>",
    "  <met:label>Legacy</met:label>",
    "  <met:active>false</met:active>",
    "</met:metadata>"
  ].join("\n"));
});

test("CustomTab with deterministic motif and description", () => {
  assert.equal(buildTabXml(...tabFixtures.basic), [
    "<met:metadata xsi:type=\"met:CustomTab\">",
    "  <met:fullName>Invoice__c</met:fullName>",
    "  <met:customObject>true</met:customObject>",
    "  <met:motif>Custom23: Cloud</met:motif>",
    "  <met:description>Tab for Invoice</met:description>",
    "</met:metadata>"
  ].join("\n"));
});

test("CustomTab escapes the label inside the description", () => {
  assert.equal(buildTabXml(...tabFixtures.escaping), [
    "<met:metadata xsi:type=\"met:CustomTab\">",
    "  <met:fullName>R_D__c</met:fullName>",
    "  <met:customObject>true</met:customObject>",
    "  <met:motif>Custom93: ShoppingCart</met:motif>",
    "  <met:description>Tab for R&amp;D &lt;Lab&gt; &quot;x&quot; &apos;y&apos;</met:description>",
    "</met:metadata>"
  ].join("\n"));
});

test("escXml escapes the five XML specials and maps empty input to \"\"", () => {
  assert.equal(escXml(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
  assert.equal(escXml(""), "");
  assert.equal(escXml(null), "");
  assert.equal(escXml(undefined), "");
  assert.equal(escXml(42), "42");
});

test("buildFieldXml does not mutate its input", () => {
  const def = structuredClone(fieldFixtures.picklist[1]);
  const before = JSON.stringify(def);
  buildFieldXml("Invoice__c", def);
  assert.equal(JSON.stringify(def), before);
});

test("buildFieldXml rejects unsupported types and empty picklists", () => {
  assert.throws(() => buildFieldXml("A__c", {name: "X__c", label: "X", type: "Geolocation"}), /Unsupported field type: Geolocation/);
  assert.throws(() => buildFieldXml("A__c", {name: "P__c", label: "P", type: "Picklist", values: ["", "  "]}), /Picklist field "P__c" has no values/);
});

test("pickTabMotif is deterministic and always a valid motif", () => {
  assert.equal(pickTabMotif("Invoice__c"), pickTabMotif("Invoice__c"));
  for (const name of ["A__c", "Invoice__c", "R_D__c", "Very_Long_Object_Name_With_Many_Parts__c"]) {
    assert.ok(TAB_MOTIFS.includes(pickTabMotif(name)));
  }
});

test("safeRelationshipName prefixes the child object and caps at 40 chars", () => {
  assert.equal(safeRelationshipName({name: "Assigned_To__c"}, "IT_Asset__c"), "IT_Asset_Assigned_To");
  assert.equal(safeRelationshipName({name: "X__c", relationshipName: "IT_Asset_Owner"}, "IT_Asset__c"), "IT_Asset_Owner");
  const long = safeRelationshipName({name: "An_Extremely_Long_Relationship_Field_Name__c"}, "Customer_Order__c");
  assert.ok(long.length <= 40, long);
  assert.ok(long.startsWith("Customer_Order_"), long);
});

test("profile / layout / read / list fragments", () => {
  assert.equal(buildTabVisibilityXml("R&D__c"),
    "<met:tabVisibilities><met:tab>R&amp;D__c</met:tab><met:visibility>DefaultOn</met:visibility></met:tabVisibilities>");
  assert.equal(buildRecordTypeVisibilityXml("R&D__c", "A<b>"),
    "<met:recordTypeVisibilities><met:default>false</met:default><met:recordType>R&amp;D__c.A&lt;b&gt;</met:recordType><met:visible>true</met:visible></met:recordTypeVisibilities>");
  assert.equal(buildProfileXml("Admin's", ["<met:a/>", "<met:b/>"]),
    "<met:metadata xsi:type=\"met:Profile\"><met:fullName>Admin&apos;s</met:fullName><met:a/><met:b/></met:metadata>");
  assert.equal(buildLayoutXml("X__c.ForceForge_Layout", "<met:layoutSections/>"),
    "<met:metadata xsi:type=\"met:Layout\"><met:fullName>X__c.ForceForge_Layout</met:fullName><met:layoutSections/></met:metadata>");
  assert.equal(buildUpdateMetadataXml("Layout", "X__c-X Layout", "<met:a/>"),
    "<met:metadata xsi:type=\"met:Layout\"><met:fullName>X__c-X Layout</met:fullName><met:a/></met:metadata>");
  assert.equal(buildReadMetadataBody("Profile", "A&B"),
    "<met:readMetadata><met:type>Profile</met:type><met:fullNames>A&amp;B</met:fullNames></met:readMetadata>");
  assert.equal(buildListMetadataBody("CustomTab"),
    "<met:listMetadata><met:queries><met:type>CustomTab</met:type></met:queries></met:listMetadata>");
});
