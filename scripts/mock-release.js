// Release Center mock: two orgs (this demo org = source, "localhost" = a
// UAT sandbox) with real retrieve / deploy zips, quick deploy and cancel.
// Dev-only (scripts/dev-server.js). Failures can be forced with
// GET /mock-release?fail=component|test|none ; GET /mock-release shows state.
import {writeZip, readZip, base64ToBytes, bytesToBase64, bytesToText} from "../addon/core/zip.js";
import {parsePackageXml, splitParentFile, pathToComponent, registerTypes, assembleParentFile, TYPE_BY_NAME} from "../addon/core/deploy.js";
import {permissionSetDescribe} from "./mock-access-metadata.js";

// UAT's profiles and permission sets for the Access compare across orgs:
// the same System Administrator profile, without Modify / View All Data and
// with read-only Invoice__c.
const UAT_PERMS = ["PermissionsApiEnabled", "PermissionsRunReports", "PermissionsExportReport", "PermissionsViewSetup",
  "PermissionsModifyAllData", "PermissionsViewAllData", "PermissionsManageUsers", "PermissionsAuthorApex",
  "PermissionsCustomizeApplication", "PermissionsResetPasswords"];
const uatPerms = off => Object.fromEntries(UAT_PERMS.map(p => [p, !off.includes(p)]));
const UAT_SETS = [
  {Id: "0PSU00000000003AAA", Name: "X00eU0000001", Label: "00eU0000001", IsOwnedByProfile: true, Type: "Profile", Profile: {Name: "System Administrator"},
    PermissionSetGroupId: null, ...uatPerms(["PermissionsModifyAllData", "PermissionsViewAllData"])},
  {Id: "0PSU00000000001AAA", Name: "Sales_Ops", Label: "Sales Ops", IsOwnedByProfile: false, Type: "Regular", PermissionSetGroupId: null,
    ...uatPerms(UAT_PERMS.filter(p => p !== "PermissionsRunReports"))}
];
const UAT_OBJ = [
  {ParentId: "0PSU00000000003AAA", SobjectType: "Account", PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: true, PermissionsViewAllRecords: true, PermissionsModifyAllRecords: true},
  {ParentId: "0PSU00000000003AAA", SobjectType: "Invoice__c", PermissionsRead: true, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false}
];

// What describeMetadata returns here: a few types beyond the built-in list.
const DESCRIBE = [
  {xmlName: "ApexClass", directoryName: "classes", suffix: "cls", metaFile: true, inFolder: false},
  {xmlName: "Workflow", directoryName: "workflows", suffix: "workflow", metaFile: false, inFolder: false,
    childXmlNames: ["WorkflowRule", "WorkflowAlert", "WorkflowFieldUpdate", "WorkflowOutboundMessage", "WorkflowTask"]},
  {xmlName: "CaseSettings", directoryName: "settings", suffix: "settings", metaFile: false, inFolder: false},
  {xmlName: "AccountSettings", directoryName: "settings", suffix: "settings", metaFile: false, inFolder: false},
  {xmlName: "ExperienceBundle", directoryName: "experiences", metaFile: false, inFolder: false},
  {xmlName: "OmniScript", directoryName: "omniScripts", suffix: "os", metaFile: false, inFolder: false},
  {xmlName: "DecisionTable", directoryName: "decisionTables", suffix: "decisionTable", metaFile: false, inFolder: false},
  {xmlName: "Document", directoryName: "documents", metaFile: true, inFolder: true},
  {xmlName: "FlowDefinition", directoryName: "flowDefinitions", suffix: "flowDefinition", metaFile: false, inFolder: false},
  {xmlName: "MatchingRules", directoryName: "matchingRules", suffix: "matchingRule", metaFile: false, inFolder: false, childXmlNames: ["MatchingRule"]}
];
registerTypes(DESCRIBE);
const describeXml = () => "<describeMetadataResponse><result>" + DESCRIBE.map(d => "<metadataObjects>" +
  [].concat(d.childXmlNames || []).map(c => `<childXmlNames>${c}</childXmlNames>`).join("") +
  `<directoryName>${d.directoryName}</directoryName><inFolder>${d.inFolder}</inFolder><metaFile>${d.metaFile}</metaFile>` +
  (d.suffix ? `<suffix>${d.suffix}</suffix>` : "") + `<xmlName>${d.xmlName}</xmlName></metadataObjects>`).join("") +
  "<organizationNamespace></organizationNamespace><partialSaveAllowed>true</partialSaveAllowed><testRequired>false</testRequired></result></describeMetadataResponse>";

const wfRule = (name, active, formula) => `<rules>\n        <fullName>${name}</fullName>\n        <active>${active}</active>\n        <formula>${formula}</formula>\n        <triggerType>onCreateOrTriggeringUpdate</triggerType>\n    </rules>`;
const workflowXml = rules => `<?xml version="1.0" encoding="UTF-8"?>\n<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${rules.join("\n    ")}\n</Workflow>\n`;
const settingsXml = (type, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${body}\n</${type}>\n`;

export const ORG2_SESSION = "FAKE_SESSION_2";
const day = 86400e3;
const when = ago => new Date(Date.now() - ago).toISOString();
const meta = (type, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>68.0</apiVersion>${extra}\n    <status>Active</status>\n</${type}>\n`;
const field = (name, type, extra = "") => `<fields>\n        <fullName>${name}</fullName>\n        <label>${name.replace(/__c$/, "").replace(/_/g, " ")}</label>\n${extra}        <type>${type}</type>\n    </fields>`;

const INVOICE_V1 = `public with sharing class InvoiceService {
    public static Decimal total(List<Invoice__c> rows) {
        Decimal sum = 0;
        for (Invoice__c r : rows) sum += r.Amount__c;
        return sum;
    }
}
`;
const INVOICE_V2 = `public with sharing class InvoiceService {
    public static Decimal total(List<Invoice__c> rows) {
        Decimal sum = 0;
        for (Invoice__c r : [SELECT Amount__c, Status__c FROM Invoice__c WHERE Id IN :rows WITH USER_MODE]) {
            if (r.Status__c != 'Void') sum += r.Amount__c;
        }
        return sum;
    }

    public static Decimal withTax(Decimal amount) {
        return InvoiceTax.apply(amount);
    }
}
`;
const TEST = `@isTest
private class InvoiceServiceTest {
    @isTest static void totals() {
        System.assertEquals(0, InvoiceService.total(new List<Invoice__c>()));
    }
}
`;
const TRIGGER = "trigger InvoiceTrigger on Invoice__c (before insert) {\n    // keep totals in sync\n}\n";

function comp(by, ago, files, createdAgo) {
  return {by, at: when(ago), created: when(createdAgo == null ? 200 * day : createdAgo), files};
}

function baseObject(fields, rules = "") {
  return {label: "<label>Invoice</label>\n    <pluralLabel>Invoices</pluralLabel>\n    <sharingModel>ReadWrite</sharingModel>", fields, rules};
}

const fp = (field, editable) => `<fieldPermissions>\n        <editable>${editable}</editable>\n        <field>${field}</field>\n        <readable>true</readable>\n    </fieldPermissions>`;
const profileXml = els => `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${els.join("\n    ")}\n</Profile>\n`;
const mrule = (name, method, status) => `<matchingRules>\n        <fullName>${name}</fullName>\n        <label>${name.replace(/_/g, " ")}</label>\n        <matchingRuleItems>\n            <fieldName>Name</fieldName>\n            <matchingMethod>${method}</matchingMethod>\n        </matchingRuleItems>\n        <ruleStatus>${status}</ruleStatus>\n    </matchingRules>`;
const matchXml = rules => `<?xml version="1.0" encoding="UTF-8"?>\n<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${rules.join("\n    ")}\n</MatchingRules>\n`;

const critRule = (name, access, role, field, value) => `<sharingCriteriaRules>\n        <fullName>${name}</fullName>\n        <accessLevel>${access}</accessLevel>\n        <label>${name.replace(/_/g, " ")}</label>\n        <sharedTo>\n            <roleAndSubordinates>${role}</roleAndSubordinates>\n        </sharedTo>\n        <criteriaItems>\n            <field>${field}</field>\n            <operation>equals</operation>\n            <value>${value}</value>\n        </criteriaItems>\n    </sharingCriteriaRules>`;
const ownerRule = (name, access) => `<sharingOwnerRules>\n        <fullName>${name}</fullName>\n        <accessLevel>${access}</accessLevel>\n        <label>${name.replace(/_/g, " ")}</label>\n        <sharedFrom>\n            <group>Support_Team</group>\n        </sharedFrom>\n        <sharedTo>\n            <allInternalUsers></allInternalUsers>\n        </sharedTo>\n    </sharingOwnerRules>`;
const sharingXml = rules => `<?xml version="1.0" encoding="UTF-8"?>\n<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${rules.join("\n    ")}\n</SharingRules>\n`;

const sharingSetXml = (profiles, obj, access) => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<SharingSet xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n" +
  `    <accessMappings>\n        <accessLevel>${access}</accessLevel>\n        <object>${obj}</object>\n        <objectField>Contact.Id</objectField>\n        <userField>Contact.Id</userField>\n    </accessMappings>\n` +
  profiles.map(p => `    <profiles>${p}</profiles>\n`).join("") + "</SharingSet>\n";
const restrictionXml = (label, obj, filter) => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<RestrictionRule xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n" +
  `    <active>true</active>\n    <enforcementType>Restrict</enforcementType>\n    <masterLabel>${label}</masterLabel>\n    <recordFilter>${filter}</recordFilter>\n` +
  `    <targetEntity>${obj}</targetEntity>\n    <userCriteria>$User.IsActive = true</userCriteria>\n    <version>1</version>\n</RestrictionRule>\n`;

function makeOrgs() {
  const source = {
    name: "SaralForce Demo Org",
    ApexClass: {
      InvoiceService: comp("Rakesh Sharma", 2 * day, {"classes/InvoiceService.cls": INVOICE_V2, "classes/InvoiceService.cls-meta.xml": meta("ApexClass")}),
      InvoiceTax: comp("Rakesh Sharma", 1 * day, {"classes/InvoiceTax.cls": "public class InvoiceTax {\n    public static Decimal apply(Decimal a) { return a * 1.18; }\n}\n", "classes/InvoiceTax.cls-meta.xml": meta("ApexClass")}),
      InvoiceServiceTest: comp("Priya Nair", 3 * day, {"classes/InvoiceServiceTest.cls": TEST, "classes/InvoiceServiceTest.cls-meta.xml": meta("ApexClass")}),
      InvoiceReminderJob: comp("Priya Nair", 1 * day, {"classes/InvoiceReminderJob.cls": "public class InvoiceReminderJob implements Schedulable {\n    public void execute(SchedulableContext sc) {}\n}\n", "classes/InvoiceReminderJob.cls-meta.xml": meta("ApexClass")})
    },
    Workflow: {
      Case: comp("Priya Nair", 1 * day, {"workflows/Case.workflow": workflowXml([wfRule("Escalate_VIP", true, "ISPICKVAL(Priority, 'High')"), wfRule("Notify_Owner", true, "ISNEW()")])})
    },
    Settings: {
      Case: comp("Rakesh Sharma", 1 * day, {"settings/Case.settings": settingsXml("CaseSettings", "<enableCaseFeed>true</enableCaseFeed>\n    <keepRecordTypeOnAssignmentRule>true</keepRecordTypeOnAssignmentRule>")}),
      Account: comp("Rakesh Sharma", 5 * day, {"settings/Account.settings": settingsXml("AccountSettings", "<enableAccountTeams>true</enableAccountTeams>")}),
      Sharing: comp("Rakesh Sharma", 3 * day, {"settings/Sharing.settings": settingsXml("SharingSettings", "<enableExternalSharingModel>true</enableExternalSharingModel>\n    <enableManagerGroups>true</enableManagerGroups>\n    <enableSecureGuestAccess>true</enableSecureGuestAccess>\n    <enableStandardReportVisibility>true</enableStandardReportVisibility>")})
    },
    SharingSet: {
      Customer_Cases: comp("Priya Nair", 4 * day, {"sharingSets/Customer_Cases.sharingSet": sharingSetXml(["Customer Community User", "Customer Community Plus User"], "Case", "Edit")})
    },
    RestrictionRule: {
      Own_Tasks_Only: comp("Priya Nair", 2 * day, {"restrictionRules/Own_Tasks_Only.rule": restrictionXml("Own Tasks Only", "Task", "OwnerId = $User.Id")})
    },
    ExperienceBundle: {
      Customer_Portal1: comp("Priya Nair", 1 * day, {
        "experiences/Customer_Portal1.site-meta.xml": settingsXml("ExperienceBundle", "<label>Customer Portal</label>\n    <type>ChatterNetworkPicasso</type>"),
        "experiences/Customer_Portal1/config/mainAppPage.json": "{\n  \"appPageId\": \"home\",\n  \"theme\": \"Build Your Own (LWR)\"\n}\n"
      })
    },
    OmniScript: {
      Onboarding_English_1: comp("Shivam Ojha", 1 * day, {"omniScripts/Onboarding_English_1.os": settingsXml("OmniScript", "<name>Onboarding</name>\n    <isActive>true</isActive>\n    <versionNumber>1</versionNumber>")})
    },
    NamedCredential: {
      Payment_Gateway: comp("Shivam Ojha", 0.1 * day, {"namedCredentials/Payment_Gateway.namedCredential": meta("NamedCredential", "\n    <endpoint>https://pay.example.com/v2</endpoint>\n    <label>Payment Gateway</label>\n    <principalType>NamedUser</principalType>").replace("<apiVersion>68.0</apiVersion>", "").replace("<status>Active</status>", "")})
    },
    RemoteSiteSetting: {
      PayGateway_Sandbox: comp("Shivam Ojha", 0.05 * day, {"remoteSiteSettings/PayGateway_Sandbox.remoteSite": meta("RemoteSiteSetting", "\n    <isActive>true</isActive>\n    <url>https://sandbox.pay.example.com</url>").replace("<apiVersion>68.0</apiVersion>", "").replace("<status>Active</status>", "")}, 0.05 * day)
    },
    ExternalDataSource: {},
    SharingRules: {Case: comp("Priya Nair", 2 * day, {"sharingRules/Case.sharingRules": sharingXml([critRule("Open_Cases_to_Managers", "Edit", "Sales_Manager", "Status", "Open"), ownerRule("Support_to_All", "Read")])})},
    DuplicateRule: {"Account.TestRule": comp("Shivam Ojha", 0.02 * day, {"duplicateRules/Account.TestRule.duplicateRule": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DuplicateRule xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <actionOnInsert>Allow</actionOnInsert>\n    <isActive>false</isActive>\n    <masterLabel>TestRule2</masterLabel>\n</DuplicateRule>\n"})},
    Profile: {"Sales User": comp("Priya Nair", 1 * day, {"profiles/Sales User.profile": profileXml([fp("Invoice__c.Amount__c", true), "<custom>true</custom>", "<userLicense>Salesforce</userLicense>"])})},
    MatchingRules: {Account: {...comp("Autoproc", 40 * day, {"matchingRules/Account.matchingRule": matchXml([mrule("Standard_Account_Match", "Exact", "Active"), mrule("TestRule1", "FuzzyCompanyName", "Inactive")])}),
      childAt: {"Account.TestRule1": {by: "Shivam Ojha", at: when(0.05 * day)}}}},
    PermissionSet: {
      Invoice_Manager: comp("Rakesh Sharma", 1 * day, {"permissionsets/Invoice_Manager.permissionset": meta("PermissionSet", "\n    <label>Invoice Manager</label>").replace("<apiVersion>68.0</apiVersion>", "").replace("<status>Active</status>", "")})
    },
    ApexTrigger: {
      InvoiceTrigger: comp("Priya Nair", 40 * day, {"triggers/InvoiceTrigger.trigger": TRIGGER, "triggers/InvoiceTrigger.trigger-meta.xml": meta("ApexTrigger")})
    },
    LightningComponentBundle: {
      invoiceCard: comp("Rakesh Sharma", 1 * day, {
        "lwc/invoiceCard/invoiceCard.js": "import { LightningElement, api } from 'lwc';\nexport default class InvoiceCard extends LightningElement {\n    @api recordId;\n}\n",
        "lwc/invoiceCard/invoiceCard.html": "<template>\n    <lightning-card title=\"Invoice\"></lightning-card>\n</template>\n",
        "lwc/invoiceCard/invoiceCard.js-meta.xml": meta("LightningComponentBundle", "\n    <isExposed>true</isExposed>")
      })
    },
    Flow: {
      Invoice_Approval: comp("Priya Nair", 5 * day, {"flows/Invoice_Approval.flow": meta("Flow", "\n    <label>Invoice Approval</label>\n    <processType>AutoLaunchedFlow</processType>\n    <description>Routes invoices over 10,000 to finance</description>")})
    },
    CustomObject: {
      Invoice__c: comp("Rakesh Sharma", 2 * day, baseObject({
        Amount__c: field("Amount__c", "Currency", "        <precision>18</precision>\n        <scale>2</scale>\n"),
        Status__c: field("Status__c", "Picklist", "        <valueSet><valueSetDefinition><value><fullName>Open</fullName><default>true</default><label>Open</label></value><value><fullName>Void</fullName><default>false</default><label>Void</label></value></valueSetDefinition></valueSet>\n")
      }, {Positive_Amount: "<validationRules>\n        <fullName>Positive_Amount</fullName>\n        <active>true</active>\n        <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>\n        <errorMessage>Amount must be positive</errorMessage>\n    </validationRules>"}))
    },
    Layout: {
      "Invoice__c-Invoice Layout": comp("Rakesh Sharma", 2 * day, {"layouts/Invoice__c-Invoice Layout.layout": meta("Layout", "\n    <layoutSections>\n        <layoutColumns>\n            <layoutItems>\n                <field>Amount__c</field>\n            </layoutItems>\n            <layoutItems>\n                <field>Status__c</field>\n            </layoutItems>\n        </layoutColumns>\n    </layoutSections>").replace("<apiVersion>68.0</apiVersion>", "").replace("<status>Active</status>", "")})
    }
  };
  const target = {
    name: "SaralForce UAT",
    ApexClass: {
      InvoiceService: comp("Deploy User", 30 * day, {"classes/InvoiceService.cls": INVOICE_V1, "classes/InvoiceService.cls-meta.xml": meta("ApexClass")}),
      InvoiceServiceTest: comp("Deploy User", 30 * day, {"classes/InvoiceServiceTest.cls": TEST, "classes/InvoiceServiceTest.cls-meta.xml": meta("ApexClass")}),
      LegacyInvoiceUtil: comp("Old Admin", 300 * day, {"classes/LegacyInvoiceUtil.cls": "public class LegacyInvoiceUtil {}\n", "classes/LegacyInvoiceUtil.cls-meta.xml": meta("ApexClass")})
    },
    ApexTrigger: {
      InvoiceTrigger: comp("Deploy User", 40 * day, {"triggers/InvoiceTrigger.trigger": TRIGGER, "triggers/InvoiceTrigger.trigger-meta.xml": meta("ApexTrigger")})
    },
    Flow: {
      Old_Routing: comp("Old Admin", 200 * day, {"flows/Old_Routing.flow": meta("Flow", "\n    <label>Old Routing</label>\n    <processType>AutoLaunchedFlow</processType>")}),
      Invoice_Approval: comp("Deploy User", 30 * day, {"flows/Invoice_Approval.flow": meta("Flow", "\n    <label>Invoice Approval</label>\n    <processType>AutoLaunchedFlow</processType>\n    <description>Routes invoices over 5,000 to finance</description>")})
    },
    CustomObject: {
      Invoice__c: comp("Deploy User", 30 * day, baseObject({
        Amount__c: field("Amount__c", "Currency", "        <precision>18</precision>\n        <scale>2</scale>\n")
      }))
    },
    Layout: {},
    NamedCredential: {
      Payment_Gateway: comp("Deploy User", 30 * day, {"namedCredentials/Payment_Gateway.namedCredential": meta("NamedCredential", "\n    <endpoint>https://pay.example.com/v1</endpoint>\n    <label>Payment Gateway</label>\n    <principalType>NamedUser</principalType>").replace("<apiVersion>68.0</apiVersion>", "").replace("<status>Active</status>", "")})
    },
    RemoteSiteSetting: {},
    ExternalDataSource: {},
    SharingRules: {Case: comp("Deploy User", 30 * day, {"sharingRules/Case.sharingRules": sharingXml([ownerRule("Support_to_All", "Edit")])})},
    Profile: {"Sales User": comp("Deploy User", 30 * day, {"profiles/Sales User.profile": profileXml([fp("Invoice__c.Amount__c", false), "<custom>true</custom>", "<userLicense>Salesforce</userLicense>"])})},
    MatchingRules: {Account: comp("Autoproc", 40 * day, {"matchingRules/Account.matchingRule": matchXml([mrule("Standard_Account_Match", "Exact", "Active")])})},
    Workflow: {
      Case: comp("Deploy User", 30 * day, {"workflows/Case.workflow": workflowXml([wfRule("Escalate_VIP", false, "ISPICKVAL(Priority, 'High')")])})
    },
    Settings: {
      Case: comp("Deploy User", 30 * day, {"settings/Case.settings": settingsXml("CaseSettings", "<enableCaseFeed>false</enableCaseFeed>\n    <keepRecordTypeOnAssignmentRule>true</keepRecordTypeOnAssignmentRule>")}),
      Sharing: comp("Deploy User", 30 * day, {"settings/Sharing.settings": settingsXml("SharingSettings", "<enableExternalSharingModel>true</enableExternalSharingModel>\n    <enableManagerGroups>false</enableManagerGroups>\n    <enableSecureGuestAccess>true</enableSecureGuestAccess>\n    <enableStandardReportVisibility>true</enableStandardReportVisibility>")})
    },
    SharingSet: {
      Customer_Cases: comp("Deploy User", 30 * day, {"sharingSets/Customer_Cases.sharingSet": sharingSetXml(["Customer Community User"], "Case", "Read")})
    },
    RestrictionRule: {},
    ExperienceBundle: {},
    OmniScript: {}
  };
  return {source, target};
}

let orgs = makeOrgs();
let failMode = "none";
let lastDeployPaths = [];
let manual = freshManual();

function freshManual() {
  return {psa: [], flowActive: 2, scheduled: [], anon: [], seq: 0};
}
const retrieves = new Map();
const deploys = new Map();
let seq = 0;

export function resetRelease() {
  orgs = makeOrgs();
  manual = freshManual();
  retrieves.clear();
  deploys.clear();
  failMode = "none";
}

function objectXml(o, fieldNames, ruleNames, withParent) {
  const parts = [];
  if (withParent) parts.push(o.label);
  for (const f of fieldNames) if (o.fields[f]) parts.push(o.fields[f]);
  for (const r of ruleNames) if (o.rules && o.rules[r]) parts.push(o.rules[r]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${parts.join("\n    ")}\n</CustomObject>\n`;
}

// Child types kept in one file per object (not CustomObject: handled above).
const mockParent = type => { const p = (TYPE_BY_NAME[type] || {}).parent; return p && p !== "CustomObject" && p !== "CustomLabels" ? p : ""; };
const parentPath = (parent, obj) => `${TYPE_BY_NAME[parent].dir}/${obj}.${TYPE_BY_NAME[parent].suffix}`;

function listRows(org, type) {
  const rows = [];
  if (type === "CustomField" || type === "ValidationRule") {
    for (const [obj, c] of Object.entries(org.CustomObject || {})) {
      const names = Object.keys(type === "CustomField" ? c.files.fields : (c.files.rules || {}));
      for (const n of names) rows.push({fullName: `${obj}.${n}`, by: c.by, at: c.at});
    }
    return rows;
  }
  const parent = mockParent(type);
  if (parent) {
    for (const [obj, c] of Object.entries(org[parent] || {})) {
      const {children} = splitParentFile(parent, obj, Object.values(c.files)[0]);
      for (const k of children) if (k.type === type) rows.push({fullName: k.fullName, by: c.by, at: c.at, ...((c.childAt || {})[k.fullName] || {})});
    }
    return rows;
  }
  for (const [name, c] of Object.entries(org[type] || {})) rows.push({fullName: name, by: c.by, at: c.at, created: c.created});
  return rows;
}

const RELEASE_TYPES = new Set(["ApexClass", "ApexTrigger", "LightningComponentBundle", "Flow", "CustomObject", "CustomField", "ValidationRule", "Layout",
  "NamedCredential", "RemoteSiteSetting", "ExternalDataSource", "WorkflowRule", "WorkflowAlert", "WorkflowFieldUpdate", "WorkflowOutboundMessage", "WorkflowTask",
  "ExperienceBundle", "OmniScript", "DecisionTable", "Settings", "Profile", "MatchingRule", "DuplicateRule", "SharingRules"]);

function retrieveZip(org, members) {
  const files = new Map();
  const objects = new Map();
  const objEntry = name => {
    if (!objects.has(name)) objects.set(name, {fields: new Set(), rules: new Set(), parent: false});
    return objects.get(name);
  };
  for (const [type, names] of Object.entries(members)) {
    for (const n of names) {
      if (type === "CustomObject") { if (org.CustomObject[n]) { const e = objEntry(n); e.parent = true; Object.keys(org.CustomObject[n].files.fields).forEach(f => e.fields.add(f)); Object.keys(org.CustomObject[n].files.rules || {}).forEach(r => e.rules.add(r)); } continue; }
      if (type === "CustomField" || type === "ValidationRule") {
        const [obj, child] = n.split(".");
        if (org.CustomObject[obj]) objEntry(obj)[type === "CustomField" ? "fields" : "rules"].add(child);
        continue;
      }
      const parent = mockParent(type);
      if (parent) {
        const [obj] = n.split(".");
        const w = (org[parent] || {})[obj];
        if (!w) continue;
        const {children} = splitParentFile(parent, obj, Object.values(w.files)[0]);
        const path = parentPath(parent, obj);
        const have = files.has(path) ? splitParentFile(parent, obj, files.get(path)).children : [];
        const keep = [...have, ...children.filter(k => k.fullName === n && k.type === type)];
        files.set(path, assembleParentFile(parent, "", keep.map(k => k.text)));
        continue;
      }
      const c = (org[type] || {})[n];
      if (n === "*") { for (const all of Object.values(org[type] || {})) for (const [p, t] of Object.entries(all.files)) files.set(p, t); continue; }
      if (c) for (const [p, t] of Object.entries(c.files)) files.set(p, t);
    }
  }
  for (const [name, e] of objects) {
    files.set(`objects/${name}.object`, objectXml(org.CustomObject[name].files, [...e.fields], [...e.rules], e.parent));
  }
  const pkgTypes = Object.entries(members).map(([t, ns]) => `<types>${ns.map(m => `<members>${m}</members>`).join("")}<name>${t}</name></types>`).join("");
  files.set("package.xml", `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${pkgTypes}<version>68.0</version></Package>`);
  return bytesToBase64(writeZip(files));
}

async function applyZip(org, files) {
  for (const [path, bytes] of files) {
    const c = pathToComponent(path);
    if (!c) continue;
    const text = bytesToText(bytes);
    if (c.type === "CustomObject") {
      const {children, parentText} = splitParentFile("CustomObject", c.fullName, text);
      const cur = org.CustomObject[c.fullName] || comp("Rakesh Sharma", 0, baseObject({}));
      for (const k of children) {
        const short = k.fullName.split(".")[1];
        if (k.type === "CustomField") cur.files.fields[short] = k.text;
        if (k.type === "ValidationRule") (cur.files.rules = cur.files.rules || {})[short] = k.text;
      }
      if (/<label>/.test(parentText)) cur.files.label = parentText.replace(/^[\s\S]*?<CustomObject[^>]*>\s*/, "").replace(/\s*<\/CustomObject>\s*$/, "");
      cur.at = when(0); cur.by = "Rakesh Sharma";
      org.CustomObject[c.fullName] = cur;
      continue;
    }
    if (TYPE_BY_NAME[c.type] && TYPE_BY_NAME[c.type].hidden && c.type !== "Settings") {
      org[c.type] = org[c.type] || {};
      const cur = org[c.type][c.fullName] || comp("Rakesh Sharma", 0, {[path]: assembleParentFile(c.type, "", [])});
      const now = splitParentFile(c.type, c.fullName, Object.values(cur.files)[0]).children;
      const incoming = splitParentFile(c.type, c.fullName, text).children;
      const merged = [...now.filter(k => !incoming.some(i => i.fullName === k.fullName && i.type === k.type)), ...incoming];
      cur.files = {[path]: assembleParentFile(c.type, "", merged.map(k => k.text))};
      cur.at = when(0); cur.by = "Rakesh Sharma";
      cur.childAt = {...(cur.childAt || {}), ...Object.fromEntries(incoming.map(k => [k.fullName, {by: "Rakesh Sharma", at: when(0)}]))};
      org[c.type][c.fullName] = cur;
      continue;
    }
    org[c.type] = org[c.type] || {};
    const cur = org[c.type][c.fullName] || comp("Rakesh Sharma", 0, {});
    cur.files[path] = text;
    cur.at = when(0); cur.by = "Rakesh Sharma";
    org[c.type][c.fullName] = cur;
  }
  const destructive = files.get("destructiveChangesPost.xml") || files.get("destructiveChanges.xml");
  if (destructive) {
    for (const [type, names] of Object.entries(parsePackageXml(bytesToText(destructive)))) {
      for (const n of names) {
        if (type === "CustomField" || type === "ValidationRule") {
          const [obj, child] = n.split(".");
          const o = org.CustomObject[obj];
          if (o) delete (type === "CustomField" ? o.files.fields : (o.files.rules || {}))[child];
        } else if (org[type]) delete org[type][n];
      }
    }
  }
}

const env = inner => '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>' + inner + "</soapenv:Body></soapenv:Envelope>";
const tag = (raw, name) => (new RegExp(`<(?:met:)?${name}>([^<]*)<`).exec(raw) || [])[1] || "";

function deployResultXml(d) {
  const done = d.calls >= 2 || d.canceled;
  const failC = d.failComponent;
  const failT = d.failTest;
  const success = done && !failC && !failT && !d.canceled;
  const status = !done ? "InProgress" : d.canceled ? "Canceled" : success ? "Succeeded" : "Failed";
  const total = d.count;
  const tests = d.testLevel && d.testLevel !== "NoTestRun" ? 1 : 0;
  let details = "";
  if (done && d.compileErrors && d.compileErrors.length) {
    details += d.compileErrors.map(e => `<componentFailures><componentType>${e.type}</componentType><fileName>${e.file}</fileName><fullName>${e.name}</fullName><lineNumber>${e.line}</lineNumber><columnNumber>9</columnNumber><problem>${e.problem}</problem><problemType>Error</problemType></componentFailures>`).join("");
  } else if (done && d.extraFails && d.extraFails.length) {
    details += d.extraFails.map(e => `<componentFailures><componentType>${e.type}</componentType><fileName>${e.file}</fileName><fullName>${e.name}</fullName><problem>${e.problem}</problem><problemType>Error</problemType></componentFailures>`).join("");
  } else if (done && d.flowRefFail) {
    details += `<componentFailures><componentType>Flow</componentType><fileName>flows/${d.flowRefFail}.flow</fileName><fullName>${d.flowRefFail}</fullName><problem>insufficient access rights on cross-reference id</problem><problemType>Error</problemType></componentFailures>`;
  } else if (done && failC) {
    details += `<componentFailures><componentType>ApexClass</componentType><fileName>classes/InvoiceService.cls</fileName><fullName>InvoiceService</fullName><lineNumber>11</lineNumber><problem>Variable does not exist: InvoiceTax</problem><problemType>Error</problemType></componentFailures>`;
  }
  if (tests) {
    details += "<runTestResult>" + (done && failT
      ? "<failures><methodName>totals</methodName><name>InvoiceServiceTest</name><message>System.AssertException: Assertion Failed: Expected: 0, Actual: null</message><stackTrace>Class.InvoiceServiceTest.totals: line 4, column 1</stackTrace></failures><numFailures>1</numFailures>"
      : "<numFailures>0</numFailures>") +
      "<codeCoverage><name>InvoiceService</name><numLocations>10</numLocations><numLocationsNotCovered>1</numLocationsNotCovered></codeCoverage><numTestsRun>1</numTestsRun></runTestResult>";
  }
  return env(`<checkDeployStatusResponse><result><checkOnly>${d.checkOnly}</checkOnly><details>${details}</details><done>${done}</done><id>${d.id}</id>` +
    `<numberComponentErrors>${done && failC ? (d.compileErrors && d.compileErrors.length) || (d.extraFails && d.extraFails.length) || 1 : 0}</numberComponentErrors><numberComponentsDeployed>${done ? total - (failC ? 1 : 0) : Math.floor(total / 2)}</numberComponentsDeployed><numberComponentsTotal>${total}</numberComponentsTotal>` +
    `<numberTestErrors>${done && failT ? 1 : 0}</numberTestErrors><numberTestsCompleted>${done ? tests - (failT ? 1 : 0) : 0}</numberTestsCompleted><numberTestsTotal>${tests}</numberTestsTotal>` +
    `${done ? "" : "<stateDetail>Running tests in UAT…</stateDetail>"}<status>${status}</status><success>${success}</success></result></checkDeployStatusResponse>`);
}

function mockCompile(files) {
  const out = [];
  for (const [path, bytes] of files) {
    if (!/\.(cls|trigger|js|cmp|html)$/.test(path)) continue;
    const lines = bytesToText(bytes).split("\n");
    lines.forEach((l, i) => {
      const name = path.split("/").pop().replace(/\.[^.]+$/, "");
      const type = path.startsWith("classes/") ? "ApexClass" : path.startsWith("triggers/") ? "ApexTrigger" : path.startsWith("lwc/") ? "LightningComponentBundle" : "AuraDefinitionBundle";
      if (/COMPILE_ERROR/.test(l)) out.push({file: path, name, type, line: i + 1, problem: "Variable does not exist: COMPILE_ERROR"});
      if (/Missing_Field__c/.test(l)) out.push({file: path, name, type, line: i + 1, problem: "No such column 'Missing_Field__c' on entity 'Account'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name."});
    });
  }
  return out;
}

// Returns true when the request was answered here.
export async function releaseSoap(raw, res) {
  const org = raw.includes(ORG2_SESSION) ? orgs.target : orgs.source;
  const send = xml => { res.writeHead(200, {"Content-Type": "text/xml; charset=utf-8", "Access-Control-Allow-Origin": "*"}); res.end(xml); };
  if (/<met:describeMetadata>/.test(raw)) {
    send(env(describeXml()));
    return true;
  }
  if (/<met:listMetadata>/.test(raw)) {
    const types = [...raw.matchAll(/<met:type>([^<]+)<\/met:type>/g)].map(m => m[1]);
    if (!types.some(t => RELEASE_TYPES.has(t)) && org === orgs.source) return false;
    const rows = types.flatMap(t => RELEASE_TYPES.has(t) ? listRows(org, t).map(r => ({...r, type: t})) : []);
    send(env("<listMetadataResponse>" + rows.map(r => `<result><createdByName>${r.by}</createdByName><createdDate>${r.created || r.at}</createdDate><fileName>x</fileName><fullName>${r.fullName}</fullName>` +
      `<id>ID_${r.type}_${r.fullName}</id><lastModifiedByName>${r.by}</lastModifiedByName><lastModifiedDate>${r.at}</lastModifiedDate><manageableState>unmanaged</manageableState><type>${r.type}</type></result>`).join("") + "</listMetadataResponse>"));
    return true;
  }
  if (/<met:retrieve>/.test(raw)) {
    const body = raw.replace(/met:/g, "");
    const id = "09S" + String(++seq).padStart(12, "0");
    retrieves.set(id, {calls: 0, zip: retrieveZip(org, parsePackageXml(body.slice(body.indexOf("<unpackaged>"))))});
    send(env(`<retrieveResponse><result><done>false</done><id>${id}</id><state>Queued</state></result></retrieveResponse>`));
    return true;
  }
  if (/<met:checkRetrieveStatus>/.test(raw)) {
    const r = retrieves.get(tag(raw, "asyncProcessId"));
    if (!r) return send(env("<checkRetrieveStatusResponse><result><done>true</done><status>Failed</status><errorMessage>Unknown retrieve</errorMessage></result></checkRetrieveStatusResponse>")), true;
    r.calls++;
    const done = r.calls >= 2;
    send(env(`<checkRetrieveStatusResponse><result><done>${done}</done><status>${done ? "Succeeded" : "InProgress"}</status>${done ? `<zipFile>${r.zip}</zipFile>` : ""}</result></checkRetrieveStatusResponse>`));
    return true;
  }
  if (/<met:deploy>/.test(raw)) {
    const files = await readZip(base64ToBytes(tag(raw, "ZipFile")));
    const pkg = parsePackageXml(bytesToText(files.get("package.xml") || new Uint8Array()));
    const count = Object.values(pkg).reduce((n, l) => n + l.length, 0);
    const checkOnly = tag(raw, "checkOnly") === "true";
    const testLevel = tag(raw, "testLevel") || (org === orgs.target ? "NoTestRun" : "");
    const hasTax = files.has("classes/InvoiceTax.cls") || !!org.ApexClass.InvoiceTax;
    const d = {id: "0Af" + String(++seq).padStart(12, "0"), calls: 0, checkOnly, testLevel, count, files, org,
      compileErrors: mockCompile(files),
      failComponent: failMode === "component" || (files.has("classes/InvoiceService.cls") && !hasTax && !!org.ApexClass.InvoiceService),
      failTest: failMode === "test" && testLevel !== "NoTestRun"};
    if (d.compileErrors.length) d.failComponent = true;
    const delXml = files.get("destructiveChangesPost.xml") || files.get("destructiveChanges.xml");
    const delFlows = delXml ? (parsePackageXml(bytesToText(delXml)).Flow || []) : [];
    d.flowRefFail = delFlows.find(n => n === "Old_Routing" && org.Flow && org.Flow[n]) || "";
    if (d.flowRefFail) d.failComponent = true;
    // Like a real org: an LWC whose Apex isn't there fails once per reference,
    // and a site names a sandbox user production doesn't have.
    d.extraFails = [];
    const sends = p => [...files.keys()].some(k => k.startsWith(p));
    if (sends("lwc/invoiceCard/") && !files.has("classes/InvoiceTax.cls") && !(org.ApexClass || {}).InvoiceTax) {
      for (let i = 0; i < 20; i++) d.extraFails.push({type: "LightningComponentBundle", name: "invoiceCard", file: "lwc/invoiceCard/invoiceCard.js", problem: "Unable to find Apex action class referenced as 'InvoiceTax'."});
    }
    if (sends("experiences/Customer_Portal1")) {
      d.extraFails.push({type: "ExperienceBundle", name: "Customer_Portal1", file: "experiences/Customer_Portal1.site-meta.xml", problem: "In field: siteAdmin - no User named priya@demo.saralforce.dev found"});
    }
    if (d.extraFails.length) d.failComponent = true;
    deploys.set(d.id, d);
    lastDeployPaths = [...files.keys()];
    send(env(`<deployResponse><result><done>false</done><id>${d.id}</id><state>Queued</state></result></deployResponse>`));
    return true;
  }
  if (/<met:checkDeployStatus>/.test(raw)) {
    const d = deploys.get(tag(raw, "asyncProcessId"));
    if (!d) return false;
    d.calls++;
    const xml = deployResultXml(d);
    if (d.calls === 2 && !d.checkOnly && !d.canceled && !d.failComponent && !d.failTest && !d.applied) {
      d.applied = true;
      await applyZip(d.org, d.files);
    }
    send(xml);
    return true;
  }
  if (/<met:deployRecentValidation>/.test(raw)) {
    const v = deploys.get(tag(raw, "validationId"));
    if (!v || !v.checkOnly) {
      send(env("<soapenv:Fault><faultcode>INVALID_ID_FIELD</faultcode><faultstring>INVALID_ID_FIELD: No validation found</faultstring></soapenv:Fault>"));
      return true;
    }
    const d = {...v, id: "0Af" + String(++seq).padStart(12, "0"), calls: 0, checkOnly: false, testLevel: "NoTestRun", applied: false};
    deploys.set(d.id, d);
    send(env(`<deployRecentValidationResponse><result>${d.id}</result></deployRecentValidationResponse>`));
    return true;
  }
  if (/<met:cancelDeploy>/.test(raw)) {
    const d = deploys.get(tag(raw, "String"));
    if (d) d.canceled = true;
    send(env(`<cancelDeployResponse><result><done>false</done><id>${d ? d.id : ""}</id></result></cancelDeployResponse>`));
    return true;
  }
  return org === orgs.target ? (send(env("<listMetadataResponse></listMetadataResponse>")), true) : false;
}

// REST for the second org, plus release-only queries on the first.
export function releaseRest(req, res, url, json) {
  const isOrg2 = String(req.headers.authorization || "").includes(ORG2_SESSION);
  const q = url.searchParams.get("q") || "";
  if (url.pathname === "/mock-release") {
    if (url.searchParams.get("fail")) failMode = url.searchParams.get("fail");
    if (url.searchParams.get("reset")) resetRelease();
    // Someone edits a class in UAT after you compared (overwrite check).
    const touch = url.searchParams.get("touch");
    if (touch && orgs.target.ApexClass[touch]) { orgs.target.ApexClass[touch].at = when(0); orgs.target.ApexClass[touch].by = "Priya Nair (UAT)"; }
    json(res, 200, {failMode, manual, lastDeployPaths, target: Object.fromEntries(Object.entries(orgs.target).filter(([k]) => k !== "name").map(([k, v]) => [k, Object.keys(v)]))});
    return true;
  }
  if (/\/chatter\/users\/me\/?$/.test(url.pathname)) {
    json(res, 200, {username: isOrg2 ? "rakesh@demo.saralforce.uat" : "rakesh@demo.saralforce", name: "Rakesh Sharma"});
    return true;
  }
  const send = recs => { json(res, 200, {totalSize: recs.length, done: true, records: recs}); return true; };
  // "Find unused" in the source org: Invoice__c has a used field, an unused
  // one, one nobody uses but that has data, and a formula; Old_Archive__c is
  // an empty object nothing uses.
  if (!isOrg2) {
    const UF = [
      {Id: "00NU0000000AmtAAA", DeveloperName: "Amount", filled: 48},
      {Id: "00NU0000000OldAAA", DeveloperName: "Old_Notes", filled: 0},
      {Id: "00NU0000000LegAAA", DeveloperName: "Legacy_Code", filled: 7},
      {Id: "00NU0000000TaxAAA", DeveloperName: "Tax_Rate", filled: null}
    ];
    if (/\/sobjects\/Invoice__c\/describe\/?$/.test(url.pathname)) {
      const fld = (name, type, extra = {}) => ({name, label: name.replace(/__c$/, "").replace(/_/g, " "), type, filterable: true, calculated: false, ...extra});
      json(res, 200, {name: "Invoice__c", label: "Invoice", custom: true, queryable: true, fields: [fld("Id", "id"), fld("Name", "string"),
        fld("Amount__c", "currency"), fld("Old_Notes__c", "string"), fld("Legacy_Code__c", "string"), fld("Tax_Rate__c", "percent", {calculated: true})]});
      return true;
    }
    if (/FROM CustomField WHERE EntityDefinition\.QualifiedApiName = 'Invoice__c'/i.test(q)) {
      return send(UF.map(x => ({Id: x.Id, DeveloperName: x.DeveloperName, NamespacePrefix: null, CreatedDate: "2025-03-01T10:00:00.000+0000", LastModifiedDate: "2025-06-01T10:00:00.000+0000"})));
    }
    if (/FROM CustomObject WHERE NamespacePrefix = null/i.test(q)) {
      return send([{Id: "01IU0000000InvAAA", DeveloperName: "Invoice", NamespacePrefix: null, CreatedDate: "2024-01-01T10:00:00.000+0000", LastModifiedDate: "2026-11-01T10:00:00.000+0000"},
        {Id: "01IU0000000ArcAAA", DeveloperName: "Old_Archive", NamespacePrefix: null, CreatedDate: "2021-05-01T10:00:00.000+0000", LastModifiedDate: "2021-05-01T10:00:00.000+0000"}]);
    }
    if (/FROM MetadataComponentDependency WHERE RefMetadataComponentId IN/i.test(q)) {
      const recs = [];
      if (q.includes("00NU0000000AmtAAA")) recs.push({MetadataComponentId: "01pU0000000SvcAAA", RefMetadataComponentId: "00NU0000000AmtAAA"});
      if (q.includes("01IU0000000InvAAA")) recs.push({MetadataComponentId: "01pU0000000SvcAAA", RefMetadataComponentId: "01IU0000000InvAAA"});
      return send(recs);
    }
    if (/SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null/i.test(q)) {
      return send(Object.entries(orgs.source.ApexClass).map(([Name, c]) => ({Name, Body: c.files[`classes/${Name}.cls`] || ""})));
    }
    if (/SELECT Name, Body FROM ApexTrigger WHERE NamespacePrefix = null/i.test(q)) return send([]);
    if (/SELECT Name, Markup FROM ApexPage WHERE NamespacePrefix = null/i.test(q)) return send([]);
    const cnt = /^SELECT COUNT\(\) FROM (\w+)(?: WHERE (\w+) )?/i.exec(q);
    if (cnt && /^(Invoice__c|Old_Archive__c)$/.test(cnt[1])) {
      const n = cnt[1] === "Old_Archive__c" ? 0 : !cnt[2] ? 50 : (UF.find(x => x.DeveloperName + "__c" === cnt[2]) || {filled: 0}).filled || 0;
      json(res, 200, {totalSize: n, done: true, records: []});
      return true;
    }
  }
  if (isOrg2 && /\/sobjects\/PermissionSet\/describe\/?$/.test(url.pathname)) { json(res, 200, permissionSetDescribe); return true; }
  if (isOrg2 && /FROM PermissionSet (ORDER BY|WHERE Id IN)/i.test(q)) {
    const ids = [...q.matchAll(/'([^']+)'/g)].map(m => m[1]);
    return send(UAT_SETS.filter(r => !/WHERE Id IN/i.test(q) || ids.includes(r.Id)));
  }
  // Access → Compare users / roles & groups, both orgs.
  {
    const DEMO = !isOrg2;
    const U = DEMO
      ? [{Id: "005dN00000AKqG1QAL", Name: "Rakesh Sharma", Username: "rakesh@demo.saralforce", Email: "rakesh@demo.example", IsActive: true, Profile: {Name: "System Administrator", UserLicense: {Name: "Salesforce"}}, UserRole: {Name: "CEO"}, UserRoleId: "00E000000000001AAA"},
        {Id: "005dN00000BQmH2RBM", Name: "Priya Nair", Username: "priya@demo.saralforce", Email: "priya@demo.example", IsActive: true, Profile: {Name: "Standard User", UserLicense: {Name: "Salesforce"}}, UserRole: {Name: "Sales Manager"}, UserRoleId: "00E000000000002AAA"}]
      : [{Id: "005U00000000001AAA", Name: "Rakesh Sharma", Username: "rakesh@demo.saralforce.uat", Email: "rakesh@demo.example.invalid", IsActive: true, Profile: {Name: "System Administrator", UserLicense: {Name: "Salesforce"}}, UserRole: {Name: "CEO"}, UserRoleId: "00EU0000000001AAA"},
        {Id: "005U00000000002AAA", Name: "Priya Nair", Username: "priya@demo.saralforce.uat", Email: "priya@demo.example.invalid", IsActive: true, Profile: {Name: "Standard User", UserLicense: {Name: "Salesforce"}}, UserRole: null, UserRoleId: null}];
    // Rakesh: the System Administrator profile, plus Dev Tools in the demo org only.
    const PSA = DEMO
      ? [{AssigneeId: "005dN00000AKqG1QAL", PermissionSetId: "0PS000000000003AAA", PermissionSet: {Label: "00ex", IsOwnedByProfile: true, Profile: {Name: "System Administrator"}}},
        {AssigneeId: "005dN00000AKqG1QAL", PermissionSetId: "0PS000000000005AAA", PermissionSet: {Label: "Dev Tools", Name: "Dev_Tools", IsOwnedByProfile: false}}]
      : [{AssigneeId: "005U00000000001AAA", PermissionSetId: "0PSU00000000003AAA", PermissionSet: {Label: "00eU", IsOwnedByProfile: true, Profile: {Name: "System Administrator"}}}];
    const ROLES = DEMO
      ? [{Id: "00E000000000001AAA", Name: "CEO", DeveloperName: "CEO", ParentRole: null, OpportunityAccessForAccountOwner: "All", CaseAccessForAccountOwner: "Edit", ContactAccessForAccountOwner: "Edit"}]
      : [{Id: "00EU0000000001AAA", Name: "CEO", DeveloperName: "CEO", ParentRole: null, OpportunityAccessForAccountOwner: "All", CaseAccessForAccountOwner: "Read", ContactAccessForAccountOwner: "Edit"}];
    const GROUPS = DEMO
      ? [{Id: "00G000000000001AAA", Name: "Support Team", DeveloperName: "Support_Team", Type: "Regular", DoesIncludeBosses: true},
        {Id: "00G000000000002AAA", Name: "Invoice Queue", DeveloperName: "Invoice_Queue", Type: "Queue", Email: "invoices@demo.example"}]
      : [{Id: "00GU0000000001AAA", Name: "Support Team", DeveloperName: "Support_Team", Type: "Regular", DoesIncludeBosses: true}];
    const MEMBERS = DEMO
      ? [{GroupId: "00G000000000001AAA", UserOrGroupId: "005dN00000AKqG1QAL"}, {GroupId: "00G000000000001AAA", UserOrGroupId: "005dN00000BQmH2RBM"},
        {GroupId: "00G000000000002AAA", UserOrGroupId: "005dN00000BQmH2RBM"}]
      : [{GroupId: "00GU0000000001AAA", UserOrGroupId: "005U00000000001AAA"}];
    const ids = () => [...q.matchAll(/'([^']+)'/g)].map(m => m[1]);
    if (/FROM User WHERE UserType = 'Standard' ORDER BY IsActive DESC/i.test(q)) return send(U);
    if (/^SELECT Id, Name, Username, IsActive, Profile\.Name, Profile\.UserLicense\.Name, UserRole\.Name FROM User WHERE Id IN/i.test(q)) return send(U.filter(u => ids().includes(u.Id)));
    if (/^SELECT AssigneeId, PermissionSetId, PermissionSet\.Label/i.test(q)) return send(PSA.filter(a => ids().includes(a.AssigneeId)));
    if (/^SELECT Id, Name, DeveloperName FROM UserRole ORDER BY Name/i.test(q)) return send(ROLES);
    if (/^SELECT Id, Name, DeveloperName, Type FROM Group WHERE Type IN/i.test(q)) return send(GROUPS);
    if (/FROM UserRole WHERE Id IN/i.test(q)) return send(ROLES.filter(r => ids().includes(r.Id)));
    if (/^SELECT Username, UserRoleId FROM User WHERE IsActive = true AND UserRoleId IN/i.test(q)) return send(U.filter(u => ids().includes(u.UserRoleId)));
    if (/^SELECT Id, DeveloperName, Type, DoesIncludeBosses, Email FROM Group WHERE Id IN/i.test(q)) return send(GROUPS.filter(g => ids().includes(g.Id)));
    if (/^SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN/i.test(q)) return send(MEMBERS.filter(m => ids().includes(m.GroupId)));
    if (/^SELECT QueueId, SobjectType FROM QueueSobject/i.test(q)) return send(DEMO ? [{QueueId: "00G000000000002AAA", SobjectType: "Invoice__c"}] : []);
    if (/^SELECT Id, Username FROM User WHERE Id IN/i.test(q)) return send(U.filter(u => ids().includes(u.Id)).map(u => ({Id: u.Id, Username: u.Username})));
  }
  // Access compare extras, both orgs: Apex class / custom permission access,
  // field permissions, sharing defaults.
  if (/FROM SetupEntityAccess WHERE ParentId IN \(/i.test(q) && !/SetupEntityType = 'TabSet'/.test(q)) {
    const ids = [...q.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const rows = isOrg2
      ? [{ParentId: "0PSU00000000003AAA", SetupEntityId: "0CPU00000000001AAA", SetupEntityType: "CustomPermission"}]
      : [{ParentId: "0PS000000000003AAA", SetupEntityId: "01pS00000000001AAA", SetupEntityType: "ApexClass"},
        {ParentId: "0PS000000000003AAA", SetupEntityId: "0CPS00000000001AAA", SetupEntityType: "CustomPermission"}];
    return send(rows.filter(r => ids.includes(r.ParentId)));
  }
  if (/SELECT Id, Name FROM ApexClass WHERE Id IN/i.test(q)) return send([{Id: "01pS00000000001AAA", Name: "InvoiceService"}]);
  if (/SELECT Id, DeveloperName FROM CustomPermission WHERE Id IN/i.test(q)) {
    return send([{Id: isOrg2 ? "0CPU00000000001AAA" : "0CPS00000000001AAA", DeveloperName: "Bypass_Validation"}]);
  }
  if (/^SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN/i.test(q)) {
    const ids = [...q.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const rows = isOrg2
      ? [{ParentId: "0PSU00000000003AAA", Field: "Account.AnnualRevenue", PermissionsRead: true, PermissionsEdit: false}]
      : [{ParentId: "0PS000000000003AAA", Field: "Account.AnnualRevenue", PermissionsRead: true, PermissionsEdit: true},
        {ParentId: "0PS000000000003AAA", Field: "Invoice__c.Amount__c", PermissionsRead: true, PermissionsEdit: true}];
    return send(rows.filter(r => ids.includes(r.ParentId)));
  }
  if (/FROM EntityDefinition WHERE IsCustomizable = true AND InternalSharingModel != null/i.test(q)) {
    // Account differs inside, Case outside; Old_Archive__c only here.
    const owd = (api, label, i, e) => ({QualifiedApiName: api, Label: label, InternalSharingModel: i, ExternalSharingModel: e});
    const same = [owd("Contact", "Contact", "ControlledByParent", "ControlledByParent"), owd("Lead", "Lead", "ReadWriteTransfer", "Private"),
      owd("Opportunity", "Opportunity", "Read", "Private"), owd("User", "User", "Read", "Private"), owd("Invoice__c", "Invoice", "Private", "Private")];
    return send(isOrg2
      ? [owd("Account", "Account", "Read", "Private"), owd("Case", "Case", "ReadWriteTransfer", "Read"), ...same]
      : [owd("Account", "Account", "Private", "Private"), owd("Case", "Case", "ReadWriteTransfer", "Private"), ...same, owd("Old_Archive__c", "Old Archive", "Private", "Private")]);
  }
  if (isOrg2 && /FROM ObjectPermissions WHERE ParentId IN/i.test(q)) {
    const ids = [...q.matchAll(/'([^']+)'/g)].map(m => m[1]);
    return send(UAT_OBJ.filter(r => ids.includes(r.ParentId)));
  }
  if (isOrg2 && /\/composite\/sobjects\/?$/.test(url.pathname) && req.method === "POST") {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const out = (body.records || []).map(r => {
        if (r.attributes && r.attributes.type === "PermissionSetAssignment") manual.psa.push({AssigneeId: r.AssigneeId, PermissionSetId: r.PermissionSetId || null, PermissionSetGroupId: r.PermissionSetGroupId || null});
        return {id: "0Pa" + String(++manual.seq).padStart(12, "0"), success: true, errors: []};
      });
      json(res, 200, out);
    });
    return true;
  }
  if (isOrg2 && /\/tooling\/sobjects\/Flow\/301U00000000009AAA/.test(url.pathname) && req.method === "DELETE") {
    delete orgs.target.Flow.Old_Routing;
    res.writeHead(204, {"Access-Control-Allow-Origin": "*"});
    res.end();
    return true;
  }
  if (isOrg2 && /\/tooling\/sobjects\/FlowDefinition\//.test(url.pathname) && req.method === "PATCH") {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      manual.flowActive = (JSON.parse(raw || "{}").Metadata || {}).activeVersionNumber ?? manual.flowActive;
      res.writeHead(204, {"Access-Control-Allow-Origin": "*"});
      res.end();
    });
    return true;
  }
  if (isOrg2 && /\/tooling\/executeAnonymous\/?$/.test(url.pathname)) {
    const code = url.searchParams.get("anonymousBody") || "";
    manual.anon.push(code);
    const m = /System\.schedule\('([^']+)'/.exec(code);
    if (m) manual.scheduled.push(m[1]);
    if (/FAIL_SCRIPT/.test(code)) { json(res, 200, {compiled: true, success: false, exceptionMessage: "System.DmlException: Insert failed"}); return true; }
    json(res, 200, {compiled: true, success: true});
    return true;
  }
  if (/\/query\/?$/.test(url.pathname)) {
    if (!isOrg2 && /Assignee\.Username/.test(q)) {
      return send([
        {Assignee: {Username: "priya@demo.saralforce"}, PermissionSet: {Name: "Invoice_Manager"}, PermissionSetGroup: null},
        {Assignee: {Username: "rakesh@demo.saralforce"}, PermissionSet: {Name: "Invoice_Manager"}, PermissionSetGroup: null},
        {Assignee: {Username: "ghost@demo.saralforce"}, PermissionSet: {Name: "Invoice_Manager"}, PermissionSetGroup: null}
      ]);
    }
    if (!isOrg2 && /FROM SourceMember/i.test(q)) {
      return send([{MemberType: "ApexClass", MemberName: "NxtPay_OldHelper", IsNameObsolete: true, LastModifiedDate: when(0.04 * day), LastModifiedById: "005S00000000001AAA"}]);
    }
    if (!isOrg2 && /005S00000000001AAA/.test(q) && /FROM User/i.test(q)) return send([{Id: "005S00000000001AAA", Name: "Shivam Ojha"}]);
    if (!isOrg2 && /Action, Display, Section FROM SetupAuditTrail/i.test(q)) {
      return send([
        {CreatedDate: when(0.08 * day), CreatedBy: {Name: "Narendar R"}, Action: "deletedApexClass", Section: "Apex Class", Display: "Deleted Apex Class NxtPay_LegacyBatch"},
        {CreatedDate: when(0.04 * day), CreatedBy: {Name: "Shivam Ojha"}, Action: "deletedApexClass", Section: "Apex Class", Display: "Deleted Apex Class NxtPay_OldHelper"},
        {CreatedDate: when(0.2 * day), CreatedBy: {Name: "Rakesh Sharma"}, Action: "PasswordPolicy", Section: "Password Policies", Display: "Changed minimum password length"}
      ]);
    }
    if (/FROM MetadataComponentDependency WHERE (Ref)?MetadataComponentId/i.test(q)) {
      const id = (/'([^']+)'/.exec(q) || [])[1] || "";
      const dep = (type, name) => ({MetadataComponentId: "ID_" + type + "_" + name, MetadataComponentName: name, MetadataComponentType: type});
      const ref = (type, name) => ({RefMetadataComponentId: "ID_" + type + "_" + name, RefMetadataComponentName: name, RefMetadataComponentType: type});
      const usedBy = {
        "ID_CustomField_Invoice__c.Amount__c": [dep("ApexClass", "InvoiceService"), dep("Layout", "Invoice__c-Invoice Layout"), dep("Flow", "Invoice_Approval"), dep("ValidationRule", "Invoice__c.Positive_Amount")],
        "ID_ApexClass_InvoiceTax": [dep("ApexClass", "InvoiceService")]
      };
      const uses = {"ID_ApexClass_InvoiceService": [ref("ApexClass", "InvoiceTax"), ref("CustomField", "Invoice__c.Amount__c")]};
      return send(/WHERE RefMetadataComponentId/i.test(q) ? (usedBy[id] || []) : (uses[id] || []));
    }
    if (/SELECT Id, Name, Body FROM ApexClass/i.test(q)) {
      const org = isOrg2 ? orgs.target : orgs.source;
      return send(Object.entries(org.ApexClass || {}).map(([Name, c]) => ({Id: "ID_ApexClass_" + Name, Name, Body: c.files["classes/" + Name + ".cls"] || ""})));
    }
    if (/SELECT Id, Name, Body FROM ApexTrigger/i.test(q)) {
      const org = isOrg2 ? orgs.target : orgs.source;
      return send(Object.entries(org.ApexTrigger || {}).map(([Name, c]) => ({Id: "ID_ApexTrigger_" + Name, Name, Body: c.files["triggers/" + Name + ".trigger"] || ""})));
    }
    if (/FROM ApexPage WHERE NamespacePrefix/i.test(q)) return send([]);
    if (/FROM DeployRequest/i.test(q)) {
      const mine = [...deploys.values()].filter(d => d.org === (isOrg2 ? orgs.target : orgs.source));
      return send([...mine.map(d => ({Id: d.id, Status: d.calls >= 2 ? (d.canceled ? "Canceled" : (d.failComponent || d.failTest ? "Failed" : "Succeeded")) : "InProgress",
        CheckOnly: d.checkOnly, StartDate: when(0.01 * day), CompletedDate: when(0.005 * day), CreatedBy: {Name: "Rakesh Sharma"}, NumberComponentsTotal: d.count, NumberComponentErrors: d.failComponent ? 1 : 0, NumberTestsTotal: 0, NumberTestErrors: 0})),
        {Id: "0Af000000000CS1AAA", Status: "Succeeded", CheckOnly: false, StartDate: when(2 * day), CompletedDate: when(2 * day), CreatedBy: {Name: "Change set (Narendar R)"}, NumberComponentsTotal: 4, NumberComponentErrors: 0, NumberTestsTotal: 12, NumberTestErrors: 0}]);
    }
    if (/FROM FlowDefinitionView/i.test(q)) return send([{ApiName: "Invoice_Approval", IsActive: true}]);
    if (!isOrg2 && /ScheduledApex/.test(q)) return send([{ApexClass: {Name: "InvoiceReminderJob"}, CronTriggerId: "08eS00000000001AAA"}]);
    if (!isOrg2 && /FROM CronTrigger WHERE Id IN/i.test(q)) return send([{Id: "08eS00000000001AAA", CronExpression: "0 0 6 * * ?", CronJobDetail: {Name: "Invoice reminders"}}]);
    if (isOrg2 && /FROM User WHERE IsActive/i.test(q)) return send([{Id: "005U00000000001AAA", Username: "priya@demo.saralforce.uat"}, {Id: "005U00000000002AAA", Username: "rakesh@demo.saralforce.uat"}]);
    if (isOrg2 && /FROM PermissionSet WHERE Name IN/i.test(q)) return send(orgs.target.PermissionSet && orgs.target.PermissionSet.Invoice_Manager ? [{Id: "0PSU00000000001AAA", Name: "Invoice_Manager"}] : []);
    if (isOrg2 && /FROM PermissionSetAssignment/i.test(q)) return send(manual.psa);
    if (isOrg2 && /FROM Flow WHERE Definition/i.test(q)) {
      const rows = [];
      if (orgs.target.Flow.Old_Routing) rows.push({Id: "301U00000000009AAA", VersionNumber: 1, Status: "Obsolete", MasterLabel: "Old Routing", Definition: {DeveloperName: "Old_Routing"}});
      if (orgs.target.Flow.Invoice_Approval) [1, 2, 3].forEach(n => rows.push({Id: "301U0000000000" + n + "AAA", VersionNumber: n, Status: n === manual.flowActive ? "Active" : "Obsolete", MasterLabel: "Invoice Approval", Definition: {DeveloperName: "Invoice_Approval"}}));
      return send(rows.filter(r => q.includes("'" + r.Definition.DeveloperName + "'")));
    }
    if (isOrg2 && /FROM FlowDefinition/i.test(q)) {
      const rows = [{Id: "300U00000000001AAA", DeveloperName: "Invoice_Approval", LatestVersion: {VersionNumber: 3}, ActiveVersion: manual.flowActive ? {VersionNumber: manual.flowActive} : null}];
      if (orgs.target.Flow.Old_Routing) rows.push({Id: "300U00000000009AAA", DeveloperName: "Old_Routing", LatestVersion: {VersionNumber: 1}, ActiveVersion: null});
      return send(/DeveloperName IN/i.test(q) ? rows.filter(r => q.includes("'" + r.DeveloperName + "'")) : rows);
    }
    if (isOrg2 && /FROM CronTrigger/i.test(q)) return send(manual.scheduled.map(n => ({CronJobDetail: {Name: n}})));
  }
  if (!/\/query\/?$/.test(url.pathname)) {
    if (isOrg2) { json(res, 404, [{errorCode: "NOT_FOUND", message: "Not in the mock UAT org"}]); return true; }
    return false;
  }
  if (/from\s+organization/i.test(q) && isOrg2) {
    json(res, 200, {totalSize: 1, done: true, records: [{attributes: {type: "Organization"}, Id: "00D5g000000UatAAA", Name: orgs.target.name, IsSandbox: true, OrganizationType: "Enterprise Edition", InstanceName: "CS42"}]});
    return true;
  }
  if (/from\s+MetadataComponentDependency/i.test(q)) {
    const recs = [{MetadataComponentName: "InvoiceService", MetadataComponentType: "ApexClass", RefMetadataComponentName: "InvoiceTax", RefMetadataComponentType: "ApexClass"}];
    json(res, 200, {totalSize: recs.length, done: true, records: recs.filter(r => q.includes(`'${r.MetadataComponentName}'`))});
    return true;
  }
  if (/SELECT Name, Body FROM ApexClass/i.test(q)) {
    const recs = Object.entries(orgs.source.ApexClass).map(([Name, c]) => ({Name, Body: c.files[`classes/${Name}.cls`]})).filter(r => /Test/.test(r.Name));
    json(res, 200, {totalSize: recs.length, done: true, records: recs});
    return true;
  }
  if (isOrg2) { json(res, 200, {totalSize: 0, done: true, records: []}); return true; }
  return false;
}
