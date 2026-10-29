// Mock org data for the Access and Metadata tabs (dev server only).
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("Z", "+0000");

const PERMS = ["PermissionsApiEnabled", "PermissionsRunReports", "PermissionsExportReport", "PermissionsViewSetup",
  "PermissionsModifyAllData", "PermissionsViewAllData", "PermissionsManageUsers", "PermissionsAuthorApex",
  "PermissionsCustomizeApplication", "PermissionsResetPasswords"];

const perms = on => Object.fromEntries(PERMS.map(p => [p, on.includes(p)]));

export function accessTables({users, profiles}) {
  const permissionSets = [
    {Id: "0PS000000000001AAA", Name: "Sales_Ops", Label: "Sales Ops", IsOwnedByProfile: false, Type: "Regular", PermissionSetGroupId: null,
      License: {Name: "Salesforce"}, ...perms(["PermissionsRunReports", "PermissionsExportReport"])},
    {Id: "0PS000000000002AAA", Name: "API_Access", Label: "API Access", IsOwnedByProfile: false, Type: "Regular", PermissionSetGroupId: null,
      ...perms(["PermissionsApiEnabled"])},
    {Id: "0PS000000000003AAA", Name: "X00ex00000018ozh_128_09_04_12_1", Label: "00ex00000018ozh", IsOwnedByProfile: true, Type: "Profile",
      ProfileId: profiles[0].Id, Profile: {Name: profiles[0].Name}, PermissionSetGroupId: null,
      ...perms(PERMS)},
    {Id: "0PS000000000004AAA", Name: "X00ex00000018ozi_128_09_04_12_2", Label: "00ex00000018ozi", IsOwnedByProfile: true, Type: "Profile",
      ProfileId: profiles[1].Id, Profile: {Name: profiles[1].Name}, PermissionSetGroupId: null,
      ...perms(["PermissionsApiEnabled", "PermissionsRunReports"])},
    {Id: "0PS000000000005AAA", Name: "Dev_Tools", Label: "Dev Tools", IsOwnedByProfile: false, Type: "Regular", PermissionSetGroupId: null,
      ...perms(["PermissionsAuthorApex", "PermissionsViewSetup", "PermissionsCustomizeApplication"])},
    {Id: "0PS000000000006AAA", Name: "Sales_Bundle_Agg", Label: "Sales Bundle", IsOwnedByProfile: false, Type: "Group", PermissionSetGroupId: "0PG000000000001AAA",
      ...perms(["PermissionsRunReports", "PermissionsExportReport", "PermissionsApiEnabled"])},
  ];
  const ps = id => permissionSets.find(p => p.Id === id);
  const assign = (i, userId, psId, extra = {}) => {
    const u = users.find(x => x.Id === userId);
    return {Id: `0Pa00000000000${i}AAA`, AssigneeId: userId, Assignee: {Id: u.Id, Name: u.Name, Username: u.Username, IsActive: u.IsActive},
      PermissionSetId: psId, PermissionSet: ps(psId), PermissionSetGroupId: null, PermissionSetGroup: null, ...extra};
  };
  const [me, priya, anita] = users;
  const permissionSetAssignments = [
    assign(1, me.Id, "0PS000000000003AAA"),
    assign(2, me.Id, "0PS000000000005AAA"),
    assign(3, priya.Id, "0PS000000000004AAA"),
    assign(4, priya.Id, "0PS000000000001AAA"),
    assign(5, priya.Id, "0PS000000000006AAA", {PermissionSetGroupId: "0PG000000000001AAA", PermissionSetGroup: {MasterLabel: "Sales Bundle"}}),
    assign(6, anita.Id, "0PS000000000004AAA"),
    assign(7, anita.Id, "0PS000000000002AAA"),
  ];
  const obj = (i, parent, type, flags) => ({Id: `110000000000${String(i).padStart(3, "0")}AAA`, ParentId: parent, SobjectType: type,
    PermissionsRead: flags.includes("R"), PermissionsCreate: flags.includes("C"), PermissionsEdit: flags.includes("E"),
    PermissionsDelete: flags.includes("D"), PermissionsViewAllRecords: flags.includes("V"), PermissionsModifyAllRecords: flags.includes("M")});
  const objectPermissions = [
    obj(1, "0PS000000000003AAA", "Account", "RCEDVM"), obj(2, "0PS000000000003AAA", "Contact", "RCEDVM"),
    obj(3, "0PS000000000003AAA", "Invoice__c", "RCEDVM"), obj(4, "0PS000000000004AAA", "Account", "RCE"),
    obj(5, "0PS000000000004AAA", "Contact", "RCE"), obj(6, "0PS000000000001AAA", "Account", "RCED"),
    obj(7, "0PS000000000001AAA", "Invoice__c", "R"), obj(8, "0PS000000000006AAA", "Invoice__c", "RCE"),
    obj(9, "0PS000000000002AAA", "Account", "R"),
  ];
  const fieldPermissions = [
    {ParentId: "0PS000000000003AAA", Parent: ps("0PS000000000003AAA"), SobjectType: "Account", Field: "Account.AnnualRevenue", PermissionsRead: true, PermissionsEdit: true},
    {ParentId: "0PS000000000004AAA", Parent: ps("0PS000000000004AAA"), SobjectType: "Account", Field: "Account.AnnualRevenue", PermissionsRead: true, PermissionsEdit: false},
    {ParentId: "0PS000000000001AAA", Parent: ps("0PS000000000001AAA"), SobjectType: "Account", Field: "Account.Customer_Tier__c", PermissionsRead: true, PermissionsEdit: true},
  ];
  return {
    permissionset: permissionSets,
    permissionsetassignment: permissionSetAssignments,
    permissionsetgroup: [{Id: "0PG000000000001AAA", DeveloperName: "Sales_Bundle", MasterLabel: "Sales Bundle"}],
    objectpermissions: objectPermissions,
    fieldpermissions: fieldPermissions,
    permissionsettabsetting: [
      {ParentId: "0PS000000000001AAA", Name: "Invoice__c", Visibility: "DefaultOn"},
      {ParentId: "0PS000000000005AAA", Name: "Invoice__c", Visibility: "DefaultOff"},
    ],
    setupentityaccess: [
      {ParentId: "0PS000000000001AAA", SetupEntityId: "02u000000000001AAA", SetupEntityType: "TabSet"},
      {ParentId: "0PS000000000005AAA", SetupEntityId: "02u000000000002AAA", SetupEntityType: "TabSet"},
    ],
    appmenuitem: [
      {ApplicationId: "02u000000000001AAA", Label: "Sales"},
      {ApplicationId: "02u000000000002AAA", Label: "Service Console"},
    ],
    groupmember: [],
    processinstanceworkitem: [
      {Id: "04idN0000000001AAA", ActorId: me.Id, Actor: {Name: me.Name}, CreatedDate: iso(2 * 86400e3), ElapsedTimeInDays: 2.3,
        ProcessInstance: {Id: "04gdN0000000001AAA", TargetObjectId: "001dN0000000000001", TargetObject: {Name: "Globex Industries", Type: "Account"},
          ProcessDefinition: {Name: "Large Deal Approval"}, SubmittedBy: {Name: priya.Name}, Status: "Pending"}},
      {Id: "04idN0000000002AAA", ActorId: anita.Id, Actor: {Name: anita.Name}, CreatedDate: iso(5 * 86400e3), ElapsedTimeInDays: 5.1,
        ProcessInstance: {Id: "04gdN0000000002AAA", TargetObjectId: "001dN0000000000002", TargetObject: {Name: "Initech", Type: "Account"},
          ProcessDefinition: {Name: "Discount Approval"}, SubmittedBy: {Name: me.Name}, Status: "Pending"}},
    ],
    processinstance: [
      {Id: "04gdN0000000002AAA", Status: "Pending", CreatedDate: iso(5 * 86400e3), CompletedDate: null, SubmittedById: me.Id,
        TargetObjectId: "001dN0000000000002", TargetObject: {Name: "Initech", Type: "Account"}, ProcessDefinition: {Name: "Discount Approval"}},
      {Id: "04gdN0000000003AAA", Status: "Approved", CreatedDate: iso(20 * 86400e3), CompletedDate: iso(19 * 86400e3), SubmittedById: me.Id,
        TargetObjectId: "001dN0000000000003", TargetObject: {Name: "Umbrella Health", Type: "Account"}, ProcessDefinition: {Name: "Discount Approval"}},
    ],
    recentlyviewed: [
      {Id: "001dN0000000000001", Name: "Globex Industries", Type: "Account"},
      {Id: "001dN0000000000004", Name: "Stark Logistics", Type: "Account"},
      {Id: "500dN0000000000001", Name: "00001026", Type: "Case"},
    ],
  };
}

export const permissionSetDescribe = {
  name: "PermissionSet", label: "Permission Set", custom: false, queryable: true,
  fields: [{name: "Id", type: "id"}, {name: "Name", type: "string"}, {name: "Label", type: "string"},
    ...PERMS.map(name => ({name, type: "boolean", label: name}))],
};

const CLASS_BODY = `public with sharing class InvoiceService {
    // Marks overdue invoices and notifies the account owner.
    public static Integer markOverdue(List<Invoice__c> invoices) {
        Integer count = 0;
        for (Invoice__c inv : invoices) {
            if (inv.Due_Date__c < Date.today() && inv.Status__c != 'Paid') {
                inv.Status__c = 'Overdue';
                count++;
            }
        }
        update invoices;
        return count;
    }
}`;

export function metadataTables(apexClasses) {
  return {
    apexclass: apexClasses.map(c => ({...c, Body: CLASS_BODY.replace("InvoiceService", c.Name),
      LastModifiedDate: iso(3 * 86400e3), LastModifiedBy: {Name: "Rakesh Sharma"}})),
    apextrigger: [{Id: "01qdN000000001AAA1", Name: "AccountTrigger", ApiVersion: 67, Status: "Active", TableEnumOrId: "Account",
      NamespacePrefix: null, LastModifiedDate: iso(86400e3), LastModifiedBy: {Name: "Rakesh Sharma"},
      Body: "trigger AccountTrigger on Account (before insert, before update) {\n    AccountTriggerHandler.run(Trigger.new);\n}"}],
    apexpage: [{Id: "066dN000000001AAA1", Name: "InvoicePdf", MasterLabel: "Invoice PDF", ApiVersion: 67, NamespacePrefix: null,
      LastModifiedDate: iso(9 * 86400e3), Markup: "<apex:page renderAs=\"pdf\" standardController=\"Invoice__c\">\n  <h1>{!Invoice__c.Name}</h1>\n</apex:page>"}],
    lightningcomponentbundle: [{Id: "0RbdN000000002AAA1", DeveloperName: "nxtPay_TouchNetPaymentPage", MasterLabel: "TouchNet Payment Page", ApiVersion: 65, NamespacePrefix: null, LastModifiedDate: iso(3 * 86400e3),
      Metadata: {apiVersion: 65, isExposed: true, masterLabel: "TouchNet Payment Page", description: "TouchNet hosted payment checkout page for the Account payment experience.",
        targets: {target: ["lightningCommunity__Page", "lightningCommunity__Default", "lightning__RecordPage", "lightning__AppPage", "lightning__HomePage"]}}},
      {Id: "0RbdN000000001AAA1", DeveloperName: "invoiceList", MasterLabel: "Invoice List", ApiVersion: 67, NamespacePrefix: null, LastModifiedDate: iso(2 * 86400e3),
      Metadata: {apiVersion: 67, isExposed: true, masterLabel: "Invoice List", description: "Open invoices for the account on a record page.", targets: {target: ["lightning__RecordPage", "lightning__AppPage"]}}}],
    lightningcomponentresource: [
      {LightningComponentBundleId: "0RbdN000000002AAA1", FilePath: "lwc/nxtPay_TouchNetPaymentPage/nxtPay_TouchNetPaymentPage.html", Format: "html", Source: "<template>\n    <lightning-card title=\"Pay\"></lightning-card>\n</template>\n"},
      {LightningComponentBundleId: "0RbdN000000002AAA1", FilePath: "lwc/nxtPay_TouchNetPaymentPage/nxtPay_TouchNetPaymentPage.js", Format: "js", Source: "import { LightningElement } from 'lwc';\nimport getContext from '@salesforce/apex/NxtPay_AccountPaymentController.getContext';\nexport default class TouchNetPaymentPage extends LightningElement {}\n"},
      {LightningComponentBundleId: "0RbdN000000002AAA1", FilePath: "lwc/nxtPay_TouchNetPaymentPage/nxtPay_TouchNetPaymentPageHelper.js", Format: "js", Source: "export default class TouchNetPaymentPageHelper {\n    static storePaymentContext({ transactionId }) {\n        sessionStorage.setItem('nxtPayTransactionId', transactionId);\n    }\n}\n"},
      {LightningComponentBundleId: "0RbdN000000002AAA1", FilePath: "lwc/nxtPay_TouchNetPaymentPage/nxtPay_TouchNetPaymentPage.css", Format: "css", Source: ":host {\n    display: block;\n}\n"},
      {LightningComponentBundleId: "0RbdN000000002AAA1", FilePath: "lwc/nxtPay_TouchNetPaymentPage/nxtPay_TouchNetPaymentPage.js-meta.xml", Format: "js", Source: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LightningComponentBundle xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <apiVersion>65.0</apiVersion>\n</LightningComponentBundle>\n"},
      {LightningComponentBundleId: "0RbdN000000001AAA1", FilePath: "lwc/invoiceList/invoiceList.js", Format: "js", Source: "import { LightningElement, api, wire } from 'lwc';\nimport { refreshApex } from '@salesforce/apex';\nimport getInvoices from '@salesforce/apex/InvoiceService.getOpen';\nimport { ShowToastEvent } from 'lightning/platformShowToastEvent';\n\nexport default class InvoiceList extends LightningElement {\n    @api recordId;\n    @api title = 'Open invoices';\n    rows;\n\n    @wire(getInvoices, { accountId: '$recordId', maxRows: 50 })\n    wired(result) { this.rows = result.data; }\n\n    handleSelect(event) {\n        this.dispatchEvent(new CustomEvent('select', { detail: event.detail }));\n    }\n}\n"},
      {LightningComponentBundleId: "0RbdN000000001AAA1", FilePath: "lwc/invoiceList/invoiceList.html", Format: "html", Source: "<template>\n    <lightning-card title={title} icon-name=\"custom:custom17\">\n        <template for:each={rows} for:item=\"row\">\n            <c-invoice-row key={row.Id} invoice={row} onselect={handleSelect}></c-invoice-row>\n        </template>\n        <lightning-button slot=\"actions\" label=\"Refresh\"></lightning-button>\n    </lightning-card>\n</template>\n"},
      {LightningComponentBundleId: "0RbdN000000001AAA1", FilePath: "lwc/invoiceList/invoiceList.css", Format: "css", Source: ":host {\n    display: block;\n}\n"},
      {LightningComponentBundleId: "0RbdN000000001AAA1", FilePath: "lwc/invoiceList/invoiceList.js-meta.xml", Format: "js", Source: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LightningComponentBundle xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <apiVersion>67.0</apiVersion>\n    <isExposed>true</isExposed>\n    <masterLabel>Invoice List</masterLabel>\n    <targets>\n        <target>lightning__RecordPage</target>\n        <target>lightning__AppPage</target>\n    </targets>\n</LightningComponentBundle>\n"},
    ],
    auradefinitionbundle: [{Id: "0AbdN000000001AAA1", DeveloperName: "accountInvoices", MasterLabel: "Account Invoices", ApiVersion: 67, NamespacePrefix: null, LastModifiedDate: iso(6 * 86400e3)}],
    auradefinition: [
      {AuraDefinitionBundleId: "0AbdN000000001AAA1", DefType: "COMPONENT", Format: "XML", Source: "<aura:component implements=\"force:hasRecordId,flexipage:availableForRecordHome\" controller=\"InvoiceService\" access=\"global\">\n    <aura:attribute name=\"invoices\" type=\"List\" default=\"[]\"/>\n    <aura:attribute name=\"loading\" type=\"Boolean\" default=\"true\"/>\n    <aura:handler name=\"init\" value=\"{!this}\" action=\"{!c.init}\"/>\n    <aura:registerEvent name=\"invoicePicked\" type=\"c:InvoicePicked\"/>\n    <lightning:card title=\"Account invoices\">\n        <lightning:datatable keyField=\"Id\" data=\"{!v.invoices}\" columns=\"{!v.columns}\"/>\n        <lightning:button label=\"Refresh\" onclick=\"{!c.refresh}\"/>\n    </lightning:card>\n</aura:component>\n"},
      {AuraDefinitionBundleId: "0AbdN000000001AAA1", DefType: "CONTROLLER", Format: "JS", Source: "({\n    init: function (component, event, helper) {\n        helper.load(component);\n    },\n    refresh : function (component, event, helper) {\n        helper.load(component);\n    }\n})\n"},
      {AuraDefinitionBundleId: "0AbdN000000001AAA1", DefType: "HELPER", Format: "JS", Source: "({\n    load: function (component) {\n        var action = component.get('c.getOpen');\n        $A.enqueueAction(action);\n    }\n})\n"},
    ],
    flowdefinition: [{Id: "300dN000000001AAA1", DeveloperName: "Case_Escalation", MasterLabel: "Case Escalation", NamespacePrefix: null,
      ActiveVersionId: "301dN000000002AAA1", LatestVersionId: "301dN000000002AAA1", ActiveVersion: {VersionNumber: 2}, LatestVersion: {VersionNumber: 2},
      LastModifiedDate: iso(4 * 86400e3)}],
    flow: [
      {Id: "301dN000000002AAA1", DefinitionId: "300dN000000001AAA1", VersionNumber: 2, Status: "Active", ProcessType: "AutoLaunchedFlow", LastModifiedDate: iso(4 * 86400e3),
        Metadata: {label: "Case Escalation", processType: "AutoLaunchedFlow", status: "Active",
          start: {object: "Case", recordTriggerType: "Update", triggerType: "RecordAfterSave", connector: {targetReference: "Get_Account"},
            filters: [{field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}]},
          recordLookups: [{name: "Get_Account", label: "Get the case account", object: "Account",
            filters: [{field: "Id", operator: "EqualTo", value: {elementReference: "$Record.AccountId"}}], connector: {targetReference: "Is_VIP"}}],
          decisions: [{name: "Is_VIP", label: "Is VIP account?", defaultConnector: {targetReference: "Notify"}, defaultConnectorLabel: "Regular account",
            rules: [{name: "VIP", label: "VIP", conditions: [{leftValueReference: "Get_Account.Customer_Tier__c", operator: "EqualTo", rightValue: {stringValue: "Gold"}}],
              connector: {targetReference: "Escalate"}}]}],
          recordUpdates: [{name: "Escalate", label: "Escalate case", inputReference: "$Record",
            inputAssignments: [{field: "Status", value: {stringValue: "Escalated"}}, {field: "OwnerId", value: {elementReference: "$Label.VipQueueId"}}],
            connector: {targetReference: "Notify"}}],
          actionCalls: [{name: "Notify", label: "Email account owner", actionType: "emailAlert", actionName: "Case.Escalation_Alert"}]}},
      {Id: "301dN000000001AAA1", DefinitionId: "300dN000000001AAA1", VersionNumber: 1, Status: "Obsolete", ProcessType: "AutoLaunchedFlow", LastModifiedDate: iso(30 * 86400e3)},
    ],
    validationrule: [
      {Id: "03ddN000000001AAA1", ValidationName: "Revenue_Not_Negative", Active: true, EntityDefinition: {QualifiedApiName: "Account"},
        ErrorMessage: "Annual revenue cannot be negative.", NamespacePrefix: null, LastModifiedDate: iso(20 * 86400e3),
        Metadata: {active: true, errorConditionFormula: "AnnualRevenue < 0", errorMessage: "Annual revenue cannot be negative.", errorDisplayField: "AnnualRevenue",
          description: "Stops negative revenue being saved."}},
      {Id: "03ddN000000002AAA1", ValidationName: "Energy_Needs_Phone", Active: true, EntityDefinition: {QualifiedApiName: "Account"},
        ErrorMessage: "Energy accounts need a phone number.", NamespacePrefix: null, LastModifiedDate: iso(9 * 86400e3),
        Metadata: {active: true, errorConditionFormula: 'AND(\n  ISPICKVAL(Industry, "Energy"),\n  ISBLANK(Phone),\n  NOT($Permission.Bypass_Validation)\n)',
          errorMessage: "Energy accounts need a phone number.", errorDisplayField: "Phone", description: "Sales ops needs a contact number for every energy account."}},
      {Id: "03ddN000000003AAA1", ValidationName: "Invalid_OrgID", Active: true, EntityDefinition: {QualifiedApiName: "CHANNEL_ORDERS__Customer__c"},
        ErrorMessage: "(deprecated)", NamespacePrefix: "CHANNEL_ORDERS", LastModifiedDate: iso(200 * 86400e3),
        Metadata: {active: true, errorConditionFormula: "false", errorMessage: "(deprecated)", errorDisplayField: "CHANNEL_ORDERS__Customer_Org_ID__c", description: "Deprecated"}},
    ],
    customfield: [{Id: "00NdN000000001AAA1", TableEnumOrId: "Account", DeveloperName: "Customer_Tier"}],
    metadatacomponentdependency: [
      {RefMetadataComponentId: "00NdN000000001AAA1", MetadataComponentName: "AccountTriggerHandler", MetadataComponentType: "ApexClass"},
      {RefMetadataComponentId: "00NdN000000001AAA1", MetadataComponentName: "Account-Account Layout", MetadataComponentType: "Layout"},
    ],
  };
}

// Minimal WHERE support for the mock: `a.b = 'x'`, `a = true/false` and
// `a IN ('x','y')` joined by AND. Unknown conditions are ignored.
export function applyWhere(q, records) {
  const where = /\bwhere\b([\s\S]*?)(\border\s+by\b|\blimit\b|\bgroup\s+by\b|$)/i.exec(q);
  if (!where) return records;
  const get = (r, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), r);
  const conds = [];
  const eq = /([A-Za-z_][\w.]*)\s*=\s*('(?:[^'\\]|\\.)*'|true|false)/gi;
  let m;
  while ((m = eq.exec(where[1]))) {
    const v = m[2].startsWith("'") ? m[2].slice(1, -1) : m[2].toLowerCase() === "true";
    conds.push([m[1], [v]]);
  }
  const inRe = /([A-Za-z_][\w.]*)\s+IN\s*\(([^)]*)\)/gi;
  while ((m = inRe.exec(where[1]))) {
    if (/select/i.test(m[2])) continue;
    conds.push([m[1], m[2].split(",").map(s => s.trim().replace(/^'|'$/g, ""))]);
  }
  return records.filter(r => conds.every(([path, values]) => {
    const v = get(r, path);
    return v === undefined || values.includes(v);
  }));
}
