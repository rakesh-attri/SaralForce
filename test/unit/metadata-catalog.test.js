import {test} from "node:test";
import assert from "node:assert/strict";
import {
  registerTypes, settingsMembers, pathToComponent, componentsFromZip, buildDeployEntries, presetTypes, otherTypes,
  TYPE_BY_NAME, TYPE_PICK, ALL_TYPES, allTypes, expandMemberKeys, parsePackageXml, mergeParentXml
} from "../../addon/core/deploy.js";
import {toSourceFiles, componentsFromSource} from "../../addon/core/source-format.js";

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

registerTypes([
  {xmlName: "OmniScript", directoryName: "omniScripts", suffix: "os", metaFile: false, inFolder: false},
  {xmlName: "LightningTypeBundle", directoryName: "lightningTypes", metaFile: false, inFolder: false},
  {xmlName: "CaseSettings", directoryName: "settings", suffix: "settings", metaFile: false, inFolder: false},
  {xmlName: "Workflow", directoryName: "workflows", suffix: "workflow", metaFile: false, inFolder: false, childXmlNames: ["WorkflowRule", "WorkflowAlert"]}
]);

test("describeMetadata types join the catalog", () => {
  assert.equal(TYPE_BY_NAME.OmniScript.dir, "omniScripts");
  assert.equal(TYPE_BY_NAME.OmniScript.label, "Omni script");
  assert.equal(TYPE_BY_NAME.LightningTypeBundle.bundle, true);
  assert.ok(settingsMembers().includes("Case"));
  assert.ok(!TYPE_BY_NAME.CaseSettings, "settings are members of Settings, not types");
  assert.ok(otherTypes().includes("LightningTypeBundle"));
  assert.ok(!otherTypes().includes("OmniScript"), "in the OmniStudio preset");
  assert.deepEqual(presetTypes(["omni", TYPE_PICK + "LightningTypeBundle"]).sort(), ["LightningTypeBundle", "OmniScript"]);
});

test("paths of the new types map to components", () => {
  assert.deepEqual(pathToComponent("workflows/Case.workflow"), {type: "Workflow", fullName: "Case"});
  assert.deepEqual(pathToComponent("settings/Case.settings"), {type: "Settings", fullName: "Case"});
  assert.deepEqual(pathToComponent("experiences/site1/config/main.json"), {type: "ExperienceBundle", fullName: "site1"});
  assert.deepEqual(pathToComponent("experiences/site1.site-meta.xml"), {type: "ExperienceBundle", fullName: "site1"});
  assert.deepEqual(pathToComponent("digitalExperiences/site/My_Site/sfdc_cms__view/home/content.json"), {type: "DigitalExperienceBundle", fullName: "site/My_Site"});
  assert.deepEqual(pathToComponent("documents/Shared/logo.png"), {type: "Document", fullName: "Shared/logo.png"});
  assert.deepEqual(pathToComponent("omniScripts/Onboarding_English_1.os"), {type: "OmniScript", fullName: "Onboarding_English_1"});
});

const WF = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <alerts><fullName>Tell_Owner</fullName><template>x</template></alerts>
    <rules><fullName>Escalate_VIP</fullName><active>true</active></rules>
    <rules><fullName>Notify</fullName><active>false</active></rules>
</Workflow>
`;

test("workflow files split into rules and alerts, and deploy only what's picked", () => {
  const comps = componentsFromZip(new Map([["workflows/Case.workflow", enc(WF)]]), dec);
  assert.deepEqual([...comps.keys()].sort(), ["WorkflowAlert:Case.Tell_Owner", "WorkflowRule:Case.Escalate_VIP", "WorkflowRule:Case.Notify"]);
  const {entries, included} = buildDeployEntries(["WorkflowRule:Case.Escalate_VIP"], comps, "68.0");
  const files = new Map(entries);
  const wf = files.get("workflows/Case.workflow");
  assert.match(wf, /^<\?xml[\s\S]*<Workflow xmlns/);
  assert.match(wf, /Escalate_VIP/);
  assert.doesNotMatch(wf, /Notify|Tell_Owner/);
  assert.deepEqual(parsePackageXml(files.get("package.xml")), {WorkflowRule: ["Case.Escalate_VIP"]});
  assert.deepEqual(included, ["WorkflowRule:Case.Escalate_VIP"]);
  // "Workflow: Case" in a package brings every rule and alert of Case.
  assert.equal(expandMemberKeys({Workflow: ["Case"]}, comps).filter(k => k !== "Workflow:Case").length, 3);
  // Two retrieve parts of the same workflow merge.
  const merged = mergeParentXml(WF, WF.replace("Notify", "Another"));
  assert.match(merged, /<Workflow xmlns/);
  assert.equal((merged.match(/<rules>/g) || []).length, 3);
});

test("workflows and settings survive a Git round trip", () => {
  const comps = componentsFromZip(new Map([
    ["workflows/Case.workflow", enc(WF)],
    ["settings/Case.settings", enc('<?xml version="1.0"?>\n<CaseSettings xmlns="http://soap.sforce.com/2006/04/metadata"><enableCaseFeed>true</enableCaseFeed></CaseSettings>\n')]
  ]), dec);
  const src = toSourceFiles(comps, "");
  assert.ok(src.has("workflows/Case.workflow-meta.xml"));
  assert.ok(src.has("settings/Case.settings-meta.xml"));
  const back = componentsFromSource(new Map([...src.entries()].map(([p, v]) => [p, typeof v === "string" ? enc(v) : v])), dec);
  assert.deepEqual([...back.keys()].sort(), [...comps.keys()].sort());
});

test("All types picks every listable type, without the internal file types", () => {
  const all = presetTypes([ALL_TYPES]);
  assert.deepEqual(all, allTypes());
  assert.ok(all.includes("ApexClass") && all.includes("OmniScript") && all.includes("WorkflowRule") && all.includes("Settings"));
  assert.ok(!all.includes("Workflow") && !all.includes("CustomLabels"), "parent files come with their children");
});

test("profiles from two retrieve parts are pieced together in Salesforce's order", () => {
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  const a = head + "    <custom>false</custom>\n    <fieldPermissions>\n        <editable>true</editable>\n        <field>B__c.X__c</field>\n    </fieldPermissions>\n</Profile>\n";
  const b = head + "    <custom>false</custom>\n    <fieldPermissions>\n        <editable>false</editable>\n        <field>A__c.Y__c</field>\n    </fieldPermissions>\n</Profile>\n";
  const merged = mergeParentXml(a, b);
  assert.equal((merged.match(/<custom>/g) || []).length, 1);
  assert.ok(merged.indexOf("A__c.Y__c") < merged.indexOf("B__c.X__c"));
  assert.ok(merged.indexOf("<custom>") < merged.indexOf("A__c.Y__c"));
});

const MR = `<?xml version="1.0" encoding="UTF-8"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
    <matchingRules>
        <fullName>Standard_Account_Match</fullName>
        <ruleStatus>Active</ruleStatus>
    </matchingRules>
    <matchingRules>
        <fullName>TestRule1</fullName>
        <ruleStatus>Inactive</ruleStatus>
    </matchingRules>
</MatchingRules>
`;

test("matching, assignment and escalation rules are compared and deployed one rule at a time", () => {
  const comps = componentsFromZip(new Map([
    ["matchingRules/Account.matchingRule", enc(MR)],
    ["assignmentRules/Case.assignmentRules", enc('<?xml version="1.0"?>\n<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">\n    <assignmentRule>\n        <fullName>Standard</fullName>\n        <active>true</active>\n    </assignmentRule>\n</AssignmentRules>\n')],
    ["escalationRules/Case.escalationRules", enc('<?xml version="1.0"?>\n<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">\n    <escalationRule>\n        <fullName>Urgent</fullName>\n        <active>false</active>\n    </escalationRule>\n</EscalationRules>\n')]
  ]), dec);
  assert.deepEqual([...comps.keys()].sort(), ["AssignmentRule:Case.Standard", "EscalationRule:Case.Urgent", "MatchingRule:Account.Standard_Account_Match", "MatchingRule:Account.TestRule1"]);
  const {entries} = buildDeployEntries(["MatchingRule:Account.TestRule1"], comps, "68.0");
  const files = new Map(entries);
  const mr = files.get("matchingRules/Account.matchingRule");
  assert.match(mr, /<MatchingRules xmlns/);
  assert.match(mr, /TestRule1/);
  assert.doesNotMatch(mr, /Standard_Account_Match/);
  assert.deepEqual(parsePackageXml(files.get("package.xml")), {MatchingRule: ["Account.TestRule1"]});
  // Two retrieve parts merge into one file.
  assert.equal((mergeParentXml(MR, MR.replace("TestRule1", "Other")).match(/<matchingRules>/g) || []).length, 3);
  // The rule types are listable; their files are not offered on their own.
  for (const t of ["MatchingRule", "AssignmentRule", "EscalationRule", "AutoResponseRule"]) assert.ok(allTypes().includes(t), t);
  for (const t of ["MatchingRules", "AssignmentRules", "EscalationRules", "AutoResponseRules"]) assert.ok(!allTypes().includes(t), t);
});

test("deprecated types stay out of All types", () => {
  registerTypes([{xmlName: "FlowDefinition", directoryName: "flowDefinitions", suffix: "flowDefinition", metaFile: false, inFolder: false}]);
  assert.ok(TYPE_BY_NAME.FlowDefinition);
  assert.ok(!allTypes().includes("FlowDefinition"));
  assert.ok(allTypes().includes("Flow"));
});

test("renamed items show their Setup label next to the API name", async () => {
  const {componentLabel, labelDiffers, classifyComponents} = await import("../../addon/core/deploy.js");
  const dup = '<?xml version="1.0" encoding="UTF-8"?>\n<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">\n    <actionOnInsert>Allow</actionOnInsert>\n    <masterLabel>TestRule2</masterLabel>\n</DuplicateRule>\n';
  assert.equal(componentLabel(dup), "TestRule2");
  assert.equal(componentLabel('<Flow xmlns="x">\n    <actionCalls>\n        <label>Send mail</label>\n    </actionCalls>\n    <label>Invoice &amp; Tax</label>\n</Flow>'), "Invoice & Tax");
  assert.equal(labelDiffers("TestRule2", "Account.TestRule"), true);
  assert.equal(labelDiffers("Invoice Approval", "Invoice_Approval"), false);
  assert.equal(labelDiffers("Amount", "Invoice__c.Amount__c"), false);
  const comps = new Map([["DuplicateRule:Account.TestRule", {type: "DuplicateRule", fullName: "Account.TestRule", files: {"duplicateRules/Account.TestRule.duplicateRule": dup}}]]);
  assert.equal(classifyComponents(comps, new Map())[0].label, "TestRule2");
});
