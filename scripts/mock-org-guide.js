// Mock "Case" business area for Metadata → Org Guide (dev server only):
// a trigger and its handler, a service class with SOQL and DML, a
// before-save and an after-save flow, a subflow running an Apex action, an
// LWC calling Apex and a validation rule. Added to the dev server's tables.
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("Z", "+0000");
const day = 86400e3;

const HANDLER = `public with sharing class CaseTriggerHandler {
    // Routes each trigger event to the service.
    public static void handle(List<Case> cases, Map<Id, Case> oldMap) {
        if (Trigger.isBefore) {
            CaseService.setDefaults(cases);
        } else {
            CaseService.assignPriority(cases);
        }
    }
}`;

const SERVICE = `public without sharing class CaseService {
    public static void setDefaults(List<Case> cases) {
        for (Case c : cases) {
            if (c.Origin == null) c.Origin = 'Web';
        }
    }

    @InvocableMethod(label='Assign case priority')
    public static void assignPriority(List<Case> cases) {
        Set<Id> accountIds = new Set<Id>();
        for (Case c : cases) accountIds.add(c.AccountId);
        Map<Id, Account> accounts = new Map<Id, Account>([SELECT Id, Customer_Tier__c FROM Account WHERE Id IN :accountIds]);
        List<Case> toUpdate = new List<Case>();
        for (Case c : cases) {
            Account a = accounts.get(c.AccountId);
            if (a != null && a.Customer_Tier__c == 'Gold') toUpdate.add(new Case(Id = c.Id, Priority = 'High'));
        }
        update toUpdate;
    }

    @AuraEnabled(cacheable=true)
    public static String getSummary(Id caseId) {
        Case c = [SELECT Subject, Status, Priority FROM Case WHERE Id = :caseId];
        return c.Subject + ' · ' + c.Status;
    }
}`;

const TRIGGER = `trigger CaseTrigger on Case (before insert, before update, after insert, after update) {
    CaseTriggerHandler.handle(Trigger.new, Trigger.oldMap);
}`;

export function addOrgGuideMock(tables) {
  const push = (t, rows) => { tables[t] = [...(tables[t] || []), ...rows]; };
  push("apexclass", [
    {Id: "01pdN0000000CG1AAA", Name: "CaseTriggerHandler", ApiVersion: 68, Status: "Active", NamespacePrefix: null, LengthWithoutComments: 280,
      LastModifiedDate: iso(2 * day), LastModifiedBy: {Name: "Priya Nair"}, Body: HANDLER},
    {Id: "01pdN0000000CG2AAA", Name: "CaseService", ApiVersion: 68, Status: "Active", NamespacePrefix: null, LengthWithoutComments: 940,
      LastModifiedDate: iso(2 * day), LastModifiedBy: {Name: "Priya Nair"}, Body: SERVICE},
  ]);
  push("apextrigger", [{Id: "01qdN0000000CG1AAA", Name: "CaseTrigger", ApiVersion: 68, Status: "Active", TableEnumOrId: "Case",
    NamespacePrefix: null, LastModifiedDate: iso(2 * day), LastModifiedBy: {Name: "Priya Nair"}, Body: TRIGGER}]);

  push("flowdefinition", [
    {Id: "300dN0000000CG1AAA", DeveloperName: "Case_Defaults", MasterLabel: "Case Defaults", NamespacePrefix: null,
      ActiveVersionId: "301dN0000000CG1AAA", LatestVersionId: "301dN0000000CG1AAA", ActiveVersion: {VersionNumber: 1}, LatestVersion: {VersionNumber: 1}, LastModifiedDate: iso(5 * day)},
    {Id: "300dN0000000CG2AAA", DeveloperName: "Case_Route_VIP", MasterLabel: "Route VIP Cases", NamespacePrefix: null,
      ActiveVersionId: "301dN0000000CG2AAA", LatestVersionId: "301dN0000000CG2AAA", ActiveVersion: {VersionNumber: 3}, LatestVersion: {VersionNumber: 3}, LastModifiedDate: iso(3 * day)},
    {Id: "300dN0000000CG3AAA", DeveloperName: "Notify_Support_Team", MasterLabel: "Notify Support Team", NamespacePrefix: null,
      ActiveVersionId: "301dN0000000CG3AAA", LatestVersionId: "301dN0000000CG3AAA", ActiveVersion: {VersionNumber: 2}, LatestVersion: {VersionNumber: 2}, LastModifiedDate: iso(3 * day)},
  ]);
  push("flow", [
    {Id: "301dN0000000CG1AAA", DefinitionId: "300dN0000000CG1AAA", VersionNumber: 1, Status: "Active", ProcessType: "AutoLaunchedFlow", LastModifiedDate: iso(5 * day),
      Metadata: {label: "Case Defaults", processType: "AutoLaunchedFlow", status: "Active",
        start: {object: "Case", recordTriggerType: "Create", triggerType: "RecordBeforeSave", connector: {targetReference: "Has_Subject"}},
        decisions: [{name: "Has_Subject", label: "Subject filled in?", defaultConnector: {targetReference: "Set_Subject"}, defaultConnectorLabel: "No subject",
          rules: [{name: "Yes", label: "Yes", conditions: [{leftValueReference: "$Record.Subject", operator: "IsNull", rightValue: {booleanValue: false}}],
            connector: {targetReference: "Set_SLA"}}]}],
        assignments: [
          {name: "Set_Subject", label: "Use the description as subject", assignmentItems: [{assignToReference: "$Record.Subject", operator: "Assign", value: {elementReference: "$Record.Description"}}],
            connector: {targetReference: "Set_SLA"}},
          {name: "Set_SLA", label: "Set the SLA date", assignmentItems: [{assignToReference: "$Record.SLA_Date__c", operator: "Assign", value: {elementReference: "TodayPlus3"}}]}]}},
    {Id: "301dN0000000CG2AAA", DefinitionId: "300dN0000000CG2AAA", VersionNumber: 3, Status: "Active", ProcessType: "AutoLaunchedFlow", LastModifiedDate: iso(3 * day),
      Metadata: {label: "Route VIP Cases", processType: "AutoLaunchedFlow", status: "Active",
        start: {object: "Case", recordTriggerType: "CreateAndUpdate", triggerType: "RecordAfterSave", connector: {targetReference: "Get_Account"},
          filters: [{field: "Priority", operator: "EqualTo", value: {stringValue: "High"}}]},
        recordLookups: [{name: "Get_Account", label: "Get the case's account", object: "Account",
          filters: [{field: "Id", operator: "EqualTo", value: {elementReference: "$Record.AccountId"}}], connector: {targetReference: "Is_Gold"}}],
        decisions: [{name: "Is_Gold", label: "Gold customer?", defaultConnector: {targetReference: "Notify_Team"}, defaultConnectorLabel: "Other tiers",
          rules: [{name: "Gold", label: "Gold", conditions: [{leftValueReference: "Get_Account.Customer_Tier__c", operator: "EqualTo", rightValue: {stringValue: "Gold"}}],
            connector: {targetReference: "Move_To_VIP_Queue"}}]}],
        recordUpdates: [{name: "Move_To_VIP_Queue", label: "Move to the VIP queue", inputReference: "$Record",
          inputAssignments: [{field: "OwnerId", value: {elementReference: "VipQueueId"}}, {field: "Status", value: {stringValue: "Escalated"}}], connector: {targetReference: "Notify_Team"},
          faultConnector: {targetReference: "Log_Error"}}],
        subflows: [{name: "Notify_Team", label: "Tell the support team", flowName: "Notify_Support_Team"}],
        customErrors: [{name: "Log_Error", label: "Show an error", customErrorMessages: [{errorMessage: "Could not move the case to the VIP queue."}]}]}},
    {Id: "301dN0000000CG3AAA", DefinitionId: "300dN0000000CG3AAA", VersionNumber: 2, Status: "Active", ProcessType: "AutoLaunchedFlow", LastModifiedDate: iso(3 * day),
      Metadata: {label: "Notify Support Team", processType: "AutoLaunchedFlow", status: "Active", startElementReference: "Priority",
        actionCalls: [
          {name: "Priority", label: "Recalculate priority", actionType: "apex", actionName: "CaseService", connector: {targetReference: "Email"}},
          {name: "Email", label: "Email the support team", actionType: "emailAlert", actionName: "Case.Support_Alert"}]}},
  ]);
  push("lightningcomponentbundle", [{Id: "0RbdN0000000CG1AAA", DeveloperName: "caseSummary", MasterLabel: "Case Summary", ApiVersion: 68,
    NamespacePrefix: null, LastModifiedDate: iso(4 * day)}]);
  push("lightningcomponentresource", [
    {LightningComponentBundleId: "0RbdN0000000CG1AAA", FilePath: "lwc/caseSummary/caseSummary.js", Format: "js",
      Source: "import { LightningElement, api, wire } from 'lwc';\nimport getSummary from '@salesforce/apex/CaseService.getSummary';\n\nexport default class CaseSummary extends LightningElement {\n    @api recordId;\n    @wire(getSummary, { caseId: '$recordId' }) summary;\n}\n"},
    {LightningComponentBundleId: "0RbdN0000000CG1AAA", FilePath: "lwc/caseSummary/caseSummary.js-meta.xml", Format: "js",
      Source: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LightningComponentBundle xmlns=\"http://soap.sforce.com/2006/04/metadata\">\n    <apiVersion>68.0</apiVersion>\n    <isExposed>true</isExposed>\n    <targets>\n        <target>lightning__RecordPage</target>\n    </targets>\n</LightningComponentBundle>\n"},
  ]);
  push("validationrule", [{Id: "03ddN0000000CG1AAA", ValidationName: "Closed_Needs_Resolution", Active: true, EntityDefinition: {QualifiedApiName: "Case"},
    ErrorMessage: "Add a resolution before closing the case.", NamespacePrefix: null, LastModifiedDate: iso(10 * day),
    Metadata: {active: true, errorConditionFormula: "AND(ISPICKVAL(Status, \"Closed\"), ISBLANK(Resolution__c))",
      errorMessage: "Add a resolution before closing the case.", errorDisplayField: "Resolution__c"}}]);
}

// Mock AI answers for the Org Guide prompts.
export function orgGuideLlm(system, user) {
  if (/Org Guide\)\. From the facts given/.test(system)) {
    return "WHAT THIS BUSINESS DOES\n- Probably a customer-support team: customers raise Cases, and Gold accounts get faster help.\n\n" +
      "MAIN AREAS\n- Case: support requests, with the most automation.\n- Account: customers, with a tier (Gold or not).\n\n" +
      "HOW A RECORD MOVES\n- A new Case gets a subject and an SLA date before it is saved.\n- High-priority cases from Gold customers go to the VIP queue, and the support team is told.\n\n" +
      "WHERE TO START\n- Read the Route VIP Cases flow, then CaseService.";
  }
  if (/explain Salesforce components for an Org Guide/.test(system)) {
    const ids = [...String(user).matchAll(/^ID: (.+)$/gm)].map(m => m[1].trim());
    const name = id => id.split(":").pop();
    return JSON.stringify({items: ids.map(id => ({
      id,
      eli5: id.startsWith("flow:") ? `Think of ${name(id)} as a checklist robot: every time a case changes, it reads the list and does the next job on it.`
        : id.startsWith("trigger:") ? `${name(id)} is like a doorbell: when a case is saved, it rings and the helper class comes to do the work.`
        : id.startsWith("class:") ? `${name(id)} is the worker in the back room: others ask it to do jobs, like checking a customer's tier.`
        : id.startsWith("rule:") ? `${name(id)} is a door guard: it won't let a case close until someone writes how it was fixed.`
        : `${name(id)} is a little window on the page that shows the case's summary.`,
      plain: `${name(id)} is part of how support cases are handled in this org.`
    }))});
  }
  return null;
}

// Case describe (stages, priority, record types) and two apps with their
// tabs, for the Handbook's departments and "life of a Case".
export function addOrgGuideDescribes(describes, field) {
  const pick = (name, label, values) => field(name, "picklist", label, {picklistValues: values.map(v => ({value: v, label: v, active: true}))});
  describes.Case = {name: "Case", label: "Case", labelPlural: "Cases", keyPrefix: "500", custom: false, queryable: true, createable: true, updateable: true,
    fields: [
      field("Id", "id", "Case ID"), field("CaseNumber", "string", "Case Number", {nameField: true}), field("Subject", "string"),
      pick("Status", "Status", ["New", "Working", "Escalated", "Closed"]), pick("Priority", "Priority", ["High", "Medium", "Low"]),
      pick("Origin", "Case Origin", ["Phone", "Email", "Web"]),
      field("AccountId", "reference", "Account ID", {referenceTo: ["Account"], relationshipName: "Account"}),
      field("OwnerId", "reference", "Owner ID", {referenceTo: ["User", "Group"], relationshipName: "Owner"}),
      field("Resolution__c", "textarea", "Resolution", {custom: true}), field("SLA_Date__c", "date", "SLA Date", {custom: true}),
    ],
    recordTypeInfos: [{name: "Support", active: true, master: false}, {name: "Billing question", active: true, master: false}, {name: "Master", active: true, master: true}],
    childRelationships: []};
}

export function addOrgGuideApps(tables) {
  tables.appdefinition = [
    {DurableId: "06m000000000001AAA", Label: "Service Console", DeveloperName: "Service_Console", NavType: "Console", UiType: "Lightning", Description: "Support agents work their cases here."},
    {DurableId: "06m000000000002AAA", Label: "Sales", DeveloperName: "Sales", NavType: "Standard", UiType: "Lightning", Description: "Account managers and their pipeline."},
  ];
  tables.tabdefinition = [
    {DurableId: "standard-Case", Name: "standard-Case", Label: "Cases", SobjectName: "Case"},
    {DurableId: "standard-Account", Name: "standard-Account", Label: "Accounts", SobjectName: "Account"},
    {DurableId: "standard-Contact", Name: "standard-Contact", Label: "Contacts", SobjectName: "Contact"},
    {DurableId: "standard-Opportunity", Name: "standard-Opportunity", Label: "Opportunities", SobjectName: "Opportunity"},
    {DurableId: "Invoice__c", Name: "Invoice__c", Label: "Invoices", SobjectName: "Invoice__c"},
    {DurableId: "standard-home", Name: "standard-home", Label: "Home", SobjectName: null},
  ];
  tables.apptabmember = [
    {AppDefinitionId: "06m000000000001AAA", TabDefinitionId: "standard-home", SortOrder: 0},
    {AppDefinitionId: "06m000000000001AAA", TabDefinitionId: "standard-Case", SortOrder: 1},
    {AppDefinitionId: "06m000000000001AAA", TabDefinitionId: "standard-Account", SortOrder: 2},
    {AppDefinitionId: "06m000000000001AAA", TabDefinitionId: "standard-Contact", SortOrder: 3},
    {AppDefinitionId: "06m000000000002AAA", TabDefinitionId: "standard-Account", SortOrder: 1},
    {AppDefinitionId: "06m000000000002AAA", TabDefinitionId: "standard-Opportunity", SortOrder: 2},
    {AppDefinitionId: "06m000000000002AAA", TabDefinitionId: "Invoice__c", SortOrder: 3},
  ];
}

// Phase 2: who works on Cases, the Case record page, and created dates.
export function addOrgGuidePeople(tables) {
  const ps = id => (tables.permissionset || []).find(p => p.Id === id) || {};
  const row = (i, parent, flags) => ({Id: `110000000000C${String(i).padStart(2, "0")}AAA`, ParentId: parent, Parent: ps(parent), SobjectType: "Case",
    PermissionsRead: flags.includes("R"), PermissionsCreate: flags.includes("C"), PermissionsEdit: flags.includes("E"),
    PermissionsDelete: flags.includes("D"), PermissionsViewAllRecords: flags.includes("V"), PermissionsModifyAllRecords: flags.includes("M")});
  tables.objectpermissions = [...(tables.objectpermissions || []),
    row(1, "0PS000000000003AAA", "RCEDVM"), row(2, "0PS000000000004AAA", "RCE"), row(3, "0PS000000000001AAA", "R")];
  tables.flexipage = [{Id: "0M0dN0000000CG1AAA", DeveloperName: "Case_Record_Page", MasterLabel: "Case Record Page", Type: "RecordPage",
    EntityDefinition: {QualifiedApiName: "Case"},
    Metadata: {masterLabel: "Case Record Page", type: "RecordPage", sobjectType: "Case", flexiPageRegions: [
      {name: "header", type: "Region", itemInstances: [{componentInstance: {componentName: "force:highlightsPanel"}},
        {componentInstance: {componentName: "runtime_sales_pathassistant:pathAssistant"}}]},
      {name: "main", type: "Region", itemInstances: [{componentInstance: {componentName: "force:detailPanel"}},
        {componentInstance: {componentName: "force:relatedListContainer"}}]},
      {name: "sidebar", type: "Region", itemInstances: [{componentInstance: {componentName: "c:caseSummary"}},
        {componentInstance: {componentName: "flowruntime:interview", componentInstanceProperties: [{name: "flowName", value: "Notify_Support_Team"}]}},
        {componentInstance: {componentName: "runtime_sales_activities:activityPanel"}}]},
    ]}}];
  const ago = d => new Date(Date.now() - d * 86400e3).toISOString().replace("Z", "+0000");
  const stampIt = (t, name, key, created, by) => {
    const r = (tables[t] || []).find(x => x[key] === name);
    if (r) Object.assign(r, {CreatedDate: ago(created), LastModifiedDate: r.LastModifiedDate || ago(created), LastModifiedBy: r.LastModifiedBy || {Name: by}});
  };
  stampIt("flowdefinition", "Case_Route_VIP", "DeveloperName", 3, "Priya Nair");
  stampIt("flowdefinition", "Notify_Support_Team", "DeveloperName", 40, "Priya Nair");
  stampIt("flowdefinition", "Case_Defaults", "DeveloperName", 60, "Rakesh Sharma");
  stampIt("apexclass", "CaseService", "Name", 2, "Priya Nair");
  stampIt("apextrigger", "CaseTrigger", "Name", 45, "Priya Nair");
  stampIt("validationrule", "Closed_Needs_Resolution", "ValidationName", 50, "Rakesh Sharma");
}

// Mock "Ask the org" answer: cites what the context gave it.
export function askOrgLlm(system, user) {
  if (!/Ask the org, in an Org Handbook/.test(system)) return null;
  const refs = [...new Set([...String(user).matchAll(/\[((?:flow|rule|process|trigger):[^\]]+)\]/g)].map(m => m[1]))].slice(0, 3);
  const q = (String(user).match(/QUESTION: (.*)$/m) || [])[1] || "";
  return `Here's what happens, from this org's handbook (you asked: "${q}"):\n\n` +
    refs.map(r => `- **${r.split(":")[0]}** [${r}] is involved.`).join("\n") +
    "\n\nAsk me about any of those for the details.";
}
