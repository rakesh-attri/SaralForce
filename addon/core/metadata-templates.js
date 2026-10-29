// Starter templates for new metadata (Metadata tab → New). Pure functions:
// each returns the files/records the Tooling API needs, so they can be
// previewed, edited and unit-tested before anything is deployed.

export const LWC_TARGETS = [
  "lightning__AppPage", "lightning__HomePage", "lightning__RecordPage", "lightning__Tab", "lightning__Inbox",
  "lightning__UtilityBar", "lightning__FlowScreen", "lightning__RecordAction", "lightning__GlobalAction",
  "lightning__UrlAddressable", "lightning__Dashboard", "lightningCommunity__Page", "lightningCommunity__Default",
  "lightningSnapin__ChatMessage", "lightningStatic__Email",
];

export const AURA_INTERFACES = [
  "flexipage:availableForAllPageTypes", "flexipage:availableForRecordHome", "force:hasRecordId",
  "force:hasSObjectName", "force:appHostable", "forceCommunity:availableForAllPageTypes",
  "force:lightningQuickAction", "lightning:actionOverride", "lightning:availableForFlowScreens",
];

export const APEX_TEMPLATES = [
  ["empty", "Empty class"], ["service", "Service class"], ["batch", "Batch Apex"], ["queueable", "Queueable"],
  ["schedulable", "Schedulable"], ["invocable", "Invocable action (for Flow)"], ["rest", "REST resource"],
  ["controller", "LWC / Aura controller"], ["test", "Test class"],
];

export const TRIGGER_EVENTS = ["before insert", "before update", "before delete", "after insert", "after update", "after delete", "after undelete"];

export const FLOW_KINDS = [
  ["autolaunched", "Autolaunched (no trigger)"], ["record", "Record-triggered"], ["screen", "Screen flow"], ["scheduled", "Schedule-triggered"],
];

const RESERVED = new Set(["abstract", "class", "trigger", "test", "system", "object", "string", "integer", "list", "map", "set", "void", "new", "this", "super", "public", "private", "global"]);

// null when valid, otherwise a short message. kind: apex | trigger | page |
// lwc | aura | flow | rule.
export function validateName(name, kind) {
  const n = String(name || "");
  if (!n) return "Name is required.";
  if (n.length > (kind === "flow" || kind === "rule" ? 80 : 40)) return "Name is too long.";
  if (kind === "lwc") {
    if (!/^[a-z][A-Za-z0-9]*$/.test(n)) return "Use camelCase: start with a lowercase letter, letters and digits only.";
    return null;
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n)) return "Start with a letter; use letters, digits and underscores only.";
  if (/__/.test(n) || /_$/.test(n)) return "No double underscores and no trailing underscore.";
  if ((kind === "apex" || kind === "trigger") && RESERVED.has(n.toLowerCase())) return `"${n}" is a reserved word.`;
  return null;
}

// "invoice list" / "invoice_list" → "InvoiceList"; first char upper-cased.
export function pascalCase(s) {
  return String(s || "").replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, c => c.toUpperCase());
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function apexClassSource(name, template = "empty") {
  switch (template) {
  case "service":
    return `public with sharing class ${name} {

    public static List<Account> getRecentAccounts(Integer maxRows) {
        return [
            SELECT Id, Name, CreatedDate
            FROM Account
            WITH SECURITY_ENFORCED
            ORDER BY CreatedDate DESC
            LIMIT :maxRows
        ];
    }
}
`;
  case "batch":
    return `public with sharing class ${name} implements Database.Batchable<SObject>, Database.Stateful {

    private Integer processed = 0;

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator('SELECT Id FROM Account');
    }

    public void execute(Database.BatchableContext bc, List<SObject> scope) {
        processed += scope.size();
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('${name} processed ' + processed + ' records');
    }
}
`;
  case "queueable":
    return `public with sharing class ${name} implements Queueable {

    private final Set<Id> recordIds;

    public ${name}(Set<Id> recordIds) {
        this.recordIds = recordIds;
    }

    public void execute(QueueableContext context) {
        System.debug('${name} running for ' + recordIds.size() + ' records');
    }
}
`;
  case "schedulable":
    return `public with sharing class ${name} implements Schedulable {

    // System.schedule('${name}', '0 0 2 * * ?', new ${name}());
    public void execute(SchedulableContext context) {
        System.debug('${name} ran at ' + System.now());
    }
}
`;
  case "invocable":
    return `public with sharing class ${name} {

    public class Request {
        @InvocableVariable(label='Record Id' required=true)
        public Id recordId;
    }

    public class Result {
        @InvocableVariable(label='Message')
        public String message;
    }

    @InvocableMethod(label='${name}' description='Called from Flow')
    public static List<Result> run(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            Result res = new Result();
            res.message = 'Processed ' + req.recordId;
            results.add(res);
        }
        return results;
    }
}
`;
  case "rest":
    return `@RestResource(urlMapping='/${name.toLowerCase()}/*')
global with sharing class ${name} {

    @HttpGet
    global static String doGet() {
        RestRequest req = RestContext.request;
        String recordId = req.requestURI.substringAfterLast('/');
        return 'Requested ' + recordId;
    }
}
`;
  case "controller":
    return `public with sharing class ${name} {

    @AuraEnabled(cacheable=true)
    public static List<Account> getAccounts(String searchKey) {
        String key = '%' + String.escapeSingleQuotes(searchKey == null ? '' : searchKey) + '%';
        return [
            SELECT Id, Name
            FROM Account
            WHERE Name LIKE :key
            WITH SECURITY_ENFORCED
            ORDER BY Name
            LIMIT 50
        ];
    }
}
`;
  case "test":
    return `@IsTest
private class ${name} {

    @TestSetup
    static void setup() {
        insert new Account(Name = 'Test Account');
    }

    @IsTest
    static void itWorks() {
        Test.startTest();
        List<Account> rows = [SELECT Id FROM Account];
        Test.stopTest();
        System.assertEquals(1, rows.size(), 'One account expected');
    }
}
`;
  default:
    return `public with sharing class ${name} {

    public ${name}() {
    }
}
`;
  }
}

export function apexTriggerSource(name, object, events, withHandler) {
  const ev = (events && events.length ? events : ["before insert"]).join(", ");
  if (!withHandler) {
    return `trigger ${name} on ${object} (${ev}) {
    for (${object} record : Trigger.new) {
        // Add logic here
    }
}
`;
  }
  return `trigger ${name} on ${object} (${ev}) {
    // Keep logic out of the trigger: one handler class per object.
    ${object.replace(/__c$/, "").replace(/_/g, "")}TriggerHandler.run(Trigger.operationType, Trigger.new, Trigger.oldMap);
}
`;
}

export function triggerHandlerSource(object) {
  const type = object;
  const cls = `${object.replace(/__c$/, "").replace(/_/g, "")}TriggerHandler`;
  return `public with sharing class ${cls} {

    public static void run(System.TriggerOperation op, List<${type}> newList, Map<Id, ${type}> oldMap) {
        switch on op {
            when BEFORE_INSERT { }
            when BEFORE_UPDATE { }
            when AFTER_INSERT { }
            when AFTER_UPDATE { }
            when else { }
        }
    }
}
`;
}

export function visualforceSource({label, controller}) {
  const attrs = controller ? ` standardController="${xmlEscape(controller)}"` : "";
  return `<apex:page${attrs} lightningStylesheets="true">
    <apex:slds />
    <div class="slds-scope">
        <h1 class="slds-text-heading_medium">${xmlEscape(label || "New page")}</h1>
${controller ? `        <p>{!${controller}.Name}</p>\n` : ""}    </div>
</apex:page>
`;
}

export function lwcMetaXml({apiVersion, exposed, label, description, targets}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">',
    `    <apiVersion>${xmlEscape(apiVersion)}</apiVersion>`,
    `    <isExposed>${exposed ? "true" : "false"}</isExposed>`,
  ];
  if (label) lines.push(`    <masterLabel>${xmlEscape(label)}</masterLabel>`);
  if (description) lines.push(`    <description>${xmlEscape(description)}</description>`);
  if (exposed && targets && targets.length) {
    lines.push("    <targets>");
    for (const t of targets) lines.push(`        <target>${xmlEscape(t)}</target>`);
    lines.push("    </targets>");
  }
  lines.push("</LightningComponentBundle>");
  return lines.join("\n") + "\n";
}

// ─── LWC / Aura starter templates ────────────────────────────────────
export const LWC_TEMPLATES = [
  ["card", "Basic card"], ["record", "Record details (view)"], ["form", "Record form (create / edit)"],
  ["datatable", "Data table with search (Apex)"], ["action", "Quick action (screen)"],
];

export const AURA_TEMPLATES = [
  ["card", "Basic card"], ["record", "Record details (view)"], ["action", "Quick action"], ["apex", "Data table (Apex)"],
];

// Templates that read or write records of one object.
export const TEMPLATES_NEEDING_OBJECT = new Set(["record", "form", "datatable", "action", "apex"]);

// Suggested LWC targets per template (used until the user picks their own).
export const LWC_TEMPLATE_TARGETS = {
  card: ["lightning__AppPage", "lightning__HomePage", "lightning__RecordPage"],
  record: ["lightning__RecordPage"],
  form: ["lightning__AppPage", "lightning__HomePage", "lightning__RecordPage"],
  datatable: ["lightning__AppPage", "lightning__HomePage", "lightning__Tab"],
  action: ["lightning__RecordAction"],
};

// "Name, Industry ,Phone" → ["Name", "Industry", "Phone"] (valid API names only).
export function fieldList(text) {
  const out = String(text || "Name").split(/[\s,;]+/).map(f => f.trim()).filter(f => /^[A-Za-z][\w.]*$/.test(f));
  return out.length ? [...new Set(out)] : ["Name"];
}

// "Annual_Revenue__c" → "Annual Revenue"; "BillingCity" → "Billing City".
export function fieldLabel(api) {
  return String(api).replace(/__c$/, "").replace(/__r\./, " ").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function apexController(cls, object, fields) {
  const select = [...new Set(["Id", ...fields])].join(", ");
  const search = fields.includes("Name") ? "Name" : null;
  return `public with sharing class ${cls} {

    @AuraEnabled(cacheable=true)
    public static List<${object}> getRecords(String searchKey) {
${search ? `        String key = '%' + String.escapeSingleQuotes(searchKey == null ? '' : searchKey.trim()) + '%';
        return [
            SELECT ${select}
            FROM ${object}
            WHERE ${search} LIKE :key
            WITH SECURITY_ENFORCED
            ORDER BY ${search}
            LIMIT 200
        ];` : `        return [
            SELECT ${select}
            FROM ${object}
            WITH SECURITY_ENFORCED
            ORDER BY CreatedDate DESC
            LIMIT 200
        ];`}
    }
}
`;
}

function apexControllerTest(cls, object) {
  return `@IsTest
private class ${cls}Test {

    @IsTest
    static void returnsRecords() {
        ${object === "Account" ? "insert new Account(Name = 'Test Account');\n        " : ""}Test.startTest();
        List<${object}> rows = ${cls}.getRecords('Test');
        Test.stopTest();
        System.assertNotEquals(null, rows, 'Query should return a list');
    }
}
`;
}

// LWC bundle files. Paths match the Tooling API LightningComponentResource
// FilePath (lwc/<name>/<file>). The js-meta.xml is generated from the form;
// Apex helpers a template needs come along as role "apex" class files.
export function lwcFiles({name, label, description, exposed, targets = [], css, svg, apiVersion, template = "card", object, fields}) {
  const cls = pascalCase(name);
  const title = label || cls.replace(/([a-z])([A-Z])/g, "$1 $2");
  const obj = object || "Account";
  const flds = fieldList(fields);
  const t = xmlEscape(title);
  let html;
  let js;
  const apex = [];
  switch (template) {
  case "record":
    html = `<template>
    <lightning-card title="${t}" icon-name="standard:record">
        <div class="slds-var-p-horizontal_medium">
            <lightning-record-view-form record-id={recordId} object-api-name={objectApiName} density="comfy">
                <div class="slds-grid slds-wrap slds-gutters_small">
${flds.map(f => `                    <div class="slds-col slds-size_1-of-2">
                        <lightning-output-field field-name="${f}"></lightning-output-field>
                    </div>`).join("\n")}
                </div>
            </lightning-record-view-form>
        </div>
    </lightning-card>
</template>
`;
    js = `import { LightningElement, api } from 'lwc';

export default class ${cls} extends LightningElement {
    // Set automatically on record pages.
    @api recordId;
    @api objectApiName = '${obj}';
}
`;
    break;
  case "form":
    html = `<template>
    <lightning-card title="${t}" icon-name="standard:record_create">
        <div class="slds-var-p-horizontal_medium">
            <lightning-record-edit-form object-api-name="${obj}" record-id={recordId}
                onsuccess={handleSuccess} onerror={handleError}>
                <lightning-messages></lightning-messages>
                <div class="slds-grid slds-wrap slds-gutters_small">
${flds.map(f => `                    <div class="slds-col slds-size_1-of-2">
                        <lightning-input-field field-name="${f}"></lightning-input-field>
                    </div>`).join("\n")}
                </div>
                <div class="slds-var-m-top_medium slds-text-align_right">
                    <lightning-button label="Reset" onclick={handleReset} class="slds-var-m-right_x-small"></lightning-button>
                    <lightning-button variant="brand" type="submit" label="Save"></lightning-button>
                </div>
            </lightning-record-edit-form>
        </div>
    </lightning-card>
</template>
`;
    js = `import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class ${cls} extends LightningElement {
    // Empty = create a new ${obj}; set on record pages = edit that record.
    @api recordId;

    handleSuccess(event) {
        this.dispatchEvent(new ShowToastEvent({
            title: 'Saved',
            message: 'Record ' + event.detail.id + ' saved.',
            variant: 'success'
        }));
    }

    handleError(event) {
        this.dispatchEvent(new ShowToastEvent({
            title: 'Could not save',
            message: event.detail && event.detail.message ? event.detail.message : 'Check the highlighted fields.',
            variant: 'error'
        }));
    }

    handleReset() {
        this.template.querySelectorAll('lightning-input-field').forEach(field => field.reset());
    }
}
`;
    break;
  case "datatable": {
    const ctrl = `${cls}Controller`;
    apex.push({name: ctrl, content: apexController(ctrl, obj, flds)}, {name: `${ctrl}Test`, content: apexControllerTest(ctrl, obj)});
    html = `<template>
    <lightning-card title="${t}" icon-name="standard:table">
        <lightning-button-icon slot="actions" icon-name="utility:refresh" alternative-text="Refresh"
            onclick={handleRefresh}></lightning-button-icon>
        <div class="slds-var-p-horizontal_medium">
            <lightning-input type="search" label="Search" placeholder="Search…" value={searchKey}
                onchange={handleSearch}></lightning-input>
        </div>
        <div class="slds-var-m-top_small">
            <template lwc:if={error}>
                <p class="slds-var-p-around_medium slds-text-color_error">{error}</p>
            </template>
            <template lwc:elseif={hasRows}>
                <lightning-datatable key-field="Id" data={rows} columns={columns} hide-checkbox-column></lightning-datatable>
            </template>
            <template lwc:else>
                <p class="slds-var-p-around_medium slds-text-color_weak">No records found.</p>
            </template>
        </div>
    </lightning-card>
</template>
`;
    js = `import { LightningElement, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import getRecords from '@salesforce/apex/${ctrl}.getRecords';

const COLUMNS = [
${flds.map(f => `    { label: '${fieldLabel(f)}', fieldName: '${f}' }`).join(",\n")}
];

export default class ${cls} extends LightningElement {
    columns = COLUMNS;
    searchKey = '';
    rows = [];
    error;
    wiredResult;
    delayTimeout;

    @wire(getRecords, { searchKey: '$searchKey' })
    wiredRecords(result) {
        this.wiredResult = result;
        if (result.data) {
            this.rows = result.data;
            this.error = undefined;
        } else if (result.error) {
            this.error = result.error.body ? result.error.body.message : 'Could not load records.';
            this.rows = [];
        }
    }

    get hasRows() {
        return this.rows.length > 0;
    }

    handleSearch(event) {
        // Wait until typing pauses before querying again.
        window.clearTimeout(this.delayTimeout);
        const value = event.target.value;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.delayTimeout = setTimeout(() => { this.searchKey = value; }, 300);
    }

    handleRefresh() {
        return refreshApex(this.wiredResult);
    }
}
`;
    break;
  }
  case "action":
    html = `<template>
    <lightning-quick-action-panel header="${t}">
        <lightning-record-edit-form object-api-name="${obj}" record-id={recordId} onsuccess={handleSuccess}>
            <lightning-messages></lightning-messages>
${flds.map(f => `            <lightning-input-field field-name="${f}"></lightning-input-field>`).join("\n")}
            <div class="slds-var-m-top_medium slds-text-align_right">
                <lightning-button label="Cancel" onclick={handleCancel} class="slds-var-m-right_x-small"></lightning-button>
                <lightning-button variant="brand" type="submit" label="Save"></lightning-button>
            </div>
        </lightning-record-edit-form>
    </lightning-quick-action-panel>
</template>
`;
    js = `import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class ${cls} extends LightningElement {
    @api recordId;

    handleSuccess() {
        this.dispatchEvent(new ShowToastEvent({ title: 'Saved', message: '${t.replace(/'/g, "\\'")} done.', variant: 'success' }));
        this.dispatchEvent(new CloseActionScreenEvent());
    }

    handleCancel() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}
`;
    break;
  default:
    html = `<template>
    <lightning-card title={title} icon-name="custom:custom14">
        <div class="slds-var-p-horizontal_medium">
            <p>{message}</p>
            <slot></slot>
        </div>
        <div slot="footer">
            <lightning-button variant="brand" label="Say hello" onclick={handleClick}></lightning-button>
        </div>
    </lightning-card>
</template>
`;
    js = `import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class ${cls} extends LightningElement {
    // Editable in Lightning App Builder when exposed.
    @api title = '${t.replace(/'/g, "\\'")}';
    message = 'Ready to build.';

    handleClick() {
        this.message = 'Clicked at ' + new Date().toLocaleTimeString();
        this.dispatchEvent(new ShowToastEvent({ title: this.title, message: 'Hello!', variant: 'success' }));
    }
}
`;
  }
  const files = [
    {path: `lwc/${name}/${name}.html`, format: "html", content: html},
    {path: `lwc/${name}/${name}.js`, format: "js", content: js},
  ];
  if (css) files.push({path: `lwc/${name}/${name}.css`, format: "css", content: ":host {\n    display: block;\n}\n"});
  if (svg) {
    files.push({path: `lwc/${name}/${name}.svg`, format: "svg", content: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="12" fill="#2878F0"/>
    <text x="32" y="41" font-size="26" text-anchor="middle" fill="#fff" font-family="Arial">${xmlEscape(cls.slice(0, 2))}</text>
</svg>
`});
  }
  files.push({path: `lwc/${name}/${name}.js-meta.xml`, format: "xml", generated: true,
    content: lwcMetaXml({apiVersion, exposed, label: title, description, targets})});
  for (const a of apex) files.push({path: `classes/${a.name}.cls`, format: "apex", role: "apex", name: a.name, content: a.content});
  return files;
}

// Aura bundle definitions (DefType + Format as the Tooling API expects).
export function auraFiles({name, label, description, interfaces = [], style, template = "card", object, fields}) {
  const title = xmlEscape(label || name);
  const obj = object || "Account";
  const flds = fieldList(fields);
  const ifaces = new Set(interfaces);
  if (template === "record" || template === "action") ifaces.add("force:hasRecordId");
  if (template === "record") ifaces.add("flexipage:availableForRecordHome");
  if (template === "action") ifaces.add("force:lightningQuickAction");
  const desc = description ? ` description="${xmlEscape(description)}"` : "";
  const impl = ifaces.size ? ` implements="${[...ifaces].join(",")}"` : "";
  const files = [];
  const apex = [];
  let cmp;
  let ctrl;
  let helper = null;
  switch (template) {
  case "record":
    cmp = `<aura:component${impl} access="global"${desc}>
    <lightning:card title="${title}" iconName="standard:record">
        <div class="slds-p-horizontal_small">
            <lightning:recordViewForm recordId="{!v.recordId}" objectApiName="${obj}">
${flds.map(f => `                <lightning:outputField fieldName="${f}"/>`).join("\n")}
            </lightning:recordViewForm>
        </div>
    </lightning:card>
</aura:component>
`;
    ctrl = "({\n})\n";
    break;
  case "action":
    cmp = `<aura:component${impl} access="global"${desc}>
    <lightning:recordEditForm recordId="{!v.recordId}" objectApiName="${obj}" onsuccess="{!c.handleSuccess}">
        <lightning:messages/>
${flds.map(f => `        <lightning:inputField fieldName="${f}"/>`).join("\n")}
        <div class="slds-m-top_medium slds-text-align_right">
            <lightning:button label="Cancel" onclick="{!c.handleCancel}"/>
            <lightning:button variant="brand" type="submit" label="Save"/>
        </div>
    </lightning:recordEditForm>
</aura:component>
`;
    ctrl = `({
    handleSuccess: function (component, event, helper) {
        $A.get("e.force:showToast").setParams({ title: "Saved", message: "${title} done.", type: "success" }).fire();
        $A.get("e.force:closeQuickAction").fire();
    },
    handleCancel: function (component, event, helper) {
        $A.get("e.force:closeQuickAction").fire();
    }
})
`;
    break;
  case "apex": {
    const ctrlCls = `${pascalCase(name)}Controller`;
    apex.push({name: ctrlCls, content: apexController(ctrlCls, obj, flds)}, {name: `${ctrlCls}Test`, content: apexControllerTest(ctrlCls, obj)});
    cmp = `<aura:component${impl || ' implements="flexipage:availableForAllPageTypes"'} controller="${ctrlCls}" access="global"${desc}>
    <aura:attribute name="rows" type="List" default="[]"/>
    <aura:attribute name="columns" type="List" default="[]"/>
    <aura:attribute name="searchKey" type="String" default=""/>
    <aura:handler name="init" value="{!this}" action="{!c.init}"/>
    <lightning:card title="${title}" iconName="standard:table">
        <div class="slds-p-horizontal_small">
            <lightning:input type="search" label="Search" value="{!v.searchKey}" onchange="{!c.handleSearch}"/>
        </div>
        <lightning:datatable keyField="Id" data="{!v.rows}" columns="{!v.columns}" hideCheckboxColumn="true"/>
    </lightning:card>
</aura:component>
`;
    ctrl = `({
    init: function (component, event, helper) {
        component.set("v.columns", [
${flds.map(f => `            { label: "${fieldLabel(f)}", fieldName: "${f}" }`).join(",\n")}
        ]);
        helper.load(component);
    },
    handleSearch: function (component, event, helper) {
        helper.load(component);
    }
})
`;
    helper = `({
    load: function (component) {
        var action = component.get("c.getRecords");
        action.setParams({ searchKey: component.get("v.searchKey") });
        action.setCallback(this, function (response) {
            if (response.getState() === "SUCCESS") {
                component.set("v.rows", response.getReturnValue());
            } else {
                var errors = response.getError();
                console.error(errors && errors[0] ? errors[0].message : "Unknown error");
            }
        });
        $A.enqueueAction(action);
    }
})
`;
    break;
  }
  default:
    cmp = `<aura:component${impl || ' implements="flexipage:availableForAllPageTypes"'} access="global"${desc}>
    <aura:attribute name="message" type="String" default="Ready to build."/>
    <lightning:card title="${title}" iconName="custom:custom14">
        <p class="slds-p-horizontal_small">{!v.message}</p>
        <aura:set attribute="footer">
            <lightning:button variant="brand" label="Say hello" onclick="{!c.handleClick}"/>
        </aura:set>
    </lightning:card>
</aura:component>
`;
    ctrl = `({
    handleClick: function (component, event, helper) {
        component.set("v.message", "Clicked at " + new Date().toLocaleTimeString());
    }
})
`;
  }
  files.push({path: `aura/${name}/${name}.cmp`, defType: "COMPONENT", format: "XML", content: cmp});
  files.push({path: `aura/${name}/${name}Controller.js`, defType: "CONTROLLER", format: "JS", content: ctrl});
  if (helper) files.push({path: `aura/${name}/${name}Helper.js`, defType: "HELPER", format: "JS", content: helper});
  if (style) files.push({path: `aura/${name}/${name}.css`, defType: "STYLE", format: "CSS", content: ".THIS {\n}\n"});
  for (const a of apex) files.push({path: `classes/${a.name}.cls`, format: "apex", role: "apex", name: a.name, content: a.content});
  return files;
}

// Minimal Draft flow metadata (Tooling API Flow.Metadata). It saves as a
// draft so it can be finished in Flow Builder.
export function flowMetadata({label, kind = "autolaunched", object, when = "CreateAndUpdate", timing = "RecordAfterSave", description, apiVersion}) {
  const meta = {
    label: label || "New Flow",
    processType: kind === "screen" ? "Flow" : "AutoLaunchedFlow",
    status: "Draft",
    apiVersion: Number(apiVersion) || undefined,
    interviewLabel: `${label || "New Flow"} {!$Flow.CurrentDateTime}`,
    start: {locationX: 50, locationY: 0},
    processMetadataValues: [
      {name: "BuilderType", value: {stringValue: "LightningFlowBuilder"}},
      {name: "CanvasMode", value: {stringValue: "AUTO_LAYOUT_CANVAS"}},
    ],
  };
  if (description) meta.description = description;
  if (kind === "record") {
    meta.start = {...meta.start, object, recordTriggerType: when, triggerType: timing};
  } else if (kind === "scheduled") {
    const d = new Date(Date.now() + 86400e3);
    meta.start = {...meta.start, triggerType: "Scheduled",
      schedule: {frequency: "Daily", startDate: d.toISOString().slice(0, 10), startTime: "02:00:00.000Z"}};
  }
  if (kind === "screen") {
    meta.screens = [{name: "Welcome", label: "Welcome", locationX: 176, locationY: 134, allowBack: true, allowFinish: true, allowPause: false,
      showFooter: true, showHeader: true,
      fields: [{name: "Intro", fieldText: `<p>${xmlEscape(label || "New Flow")}</p>`, fieldType: "DisplayText"}]}];
    meta.start.connector = {targetReference: "Welcome"};
  }
  return meta;
}

export function validationRuleMetadata({formula, message, field, active = true, description}) {
  const meta = {active: !!active, errorConditionFormula: formula, errorMessage: message};
  if (field) meta.errorDisplayField = field;
  if (description) meta.description = description;
  return meta;
}

const NAME_KIND = {apex: "apex", triggers: "trigger", pages: "page", lwc: "lwc", aura: "aura", flows: "flow", rules: "rule", cmdt: "rule"};
const OBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// Field errors for the New dialog: {fieldKey: message}; empty when valid.
export function validateForm(kind, form) {
  const f = form || {};
  const errors = {};
  const nameErr = validateName(f.name, NAME_KIND[kind]);
  if (nameErr) errors.name = nameErr;
  if ((kind === "triggers" || kind === "rules" || (kind === "flows" && f.flowKind === "record")) && !OBJECT_RE.test(f.object || "")) {
    errors.object = "Pick the object.";
  }
  // An AI draft brings its own events/template choices.
  const aiBundle = Array.isArray(f.aiFiles) && f.aiFiles.length > 0;
  if (kind === "triggers" && !aiBundle && !(f.events && f.events.length)) errors.events = "Pick at least one event.";
  if (kind === "flows" && !String(f.label || "").trim()) errors.label = "Label is required.";
  if (kind === "rules") {
    if (!String(f.formula || "").trim()) errors.formula = "Formula is required.";
    if (!String(f.message || "").trim()) errors.message = "Error message is required.";
  }
  if (kind === "lwc" && f.exposed && !(f.targets && f.targets.length)) errors.targets = "Exposed components need at least one target.";
  if ((kind === "lwc" || kind === "aura") && !aiBundle && TEMPLATES_NEEDING_OBJECT.has(f.template) && !OBJECT_RE.test(f.object || "")) {
    errors.object = "This template needs an object.";
  }
  if (kind === "cmdt") {
    if (!String(f.label || "").trim()) errors.label = "Label is required.";
    const rows = (f.fields || []).filter(r => String(r.label || "").trim());
    const names = rows.map(r => r.name || "");
    const bad = rows.find(r => validateName(r.name, "rule"));
    if (bad) errors.fields = `Field "${bad.label}": ${validateName(bad.name, "rule")}`;
    else if (new Set(names.map(n => n.toLowerCase())).size !== names.length) errors.fields = "Two fields have the same API name.";
  }
  return errors;
}

const LWC_LANG = {html: "markup", js: "js", css: "css", svg: "markup", xml: "markup", apex: "apex"};

// Draft for the editor: the files to create, generated from the form.
export function buildDraft(kind, form) {
  const f = {...form};
  const name = f.name;
  const base = {kind, name, form: f, createdAt: Date.now()};
  // An AI-written Apex class / trigger / page / Aura component replaces the
  // template; LWC handles its generated meta file below.
  if (kind !== "lwc" && Array.isArray(f.aiFiles) && f.aiFiles.length) {
    const form = {...f};
    delete form.aiFiles;
    const title = kind === "apex" ? `${name}.cls` : kind === "triggers" ? `${name}.trigger` : kind === "pages" ? `${name}.page` : name;
    return {...base, form, title, files: f.aiFiles.map(x => ({...x}))};
  }
  switch (kind) {
  case "apex":
    return {...base, title: `${name}.cls`, files: [{path: `classes/${name}.cls`, lang: "apex", content: apexClassSource(name, f.template)}]};
  case "triggers": {
    const files = [{path: `triggers/${name}.trigger`, lang: "apex", content: apexTriggerSource(name, f.object, f.events, f.handler)}];
    if (f.handler) {
      const cls = `${f.object.replace(/__c$/, "").replace(/_/g, "")}TriggerHandler`;
      files.push({path: `classes/${cls}.cls`, lang: "apex", role: "handler", name: cls, content: triggerHandlerSource(f.object)});
    }
    return {...base, title: `${name}.trigger`, files};
  }
  case "pages":
    return {...base, title: `${name}.page`, files: [{path: `pages/${name}.page`, lang: "markup", content: visualforceSource({label: f.label, controller: f.controller})}]};
  case "lwc": {
    // An AI-written bundle (form.aiFiles) replaces the template files; the
    // js-meta.xml is still generated from the form.
    const files = Array.isArray(f.aiFiles) && f.aiFiles.length
      ? [...f.aiFiles.filter(x => x.role !== "apex"),
        {path: `lwc/${name}/${name}.js-meta.xml`, format: "xml", generated: true,
          content: lwcMetaXml({apiVersion: f.apiVersion, exposed: f.exposed, label: f.label || pascalCase(name), description: f.description, targets: f.targets || []})},
        ...f.aiFiles.filter(x => x.role === "apex")]
      : lwcFiles({...f, name});
    // The draft keeps its files; no need to store the AI copy twice.
    const formRest = {...f};
    delete formRest.aiFiles;
    return {...base, form: formRest, title: name, files: files.map(x => ({...x, lang: LWC_LANG[x.format] || "text", readOnly: !!x.generated}))};
  }
  case "aura":
    return {...base, title: name, files: auraFiles({...f, name}).map(x => ({...x, lang: x.role === "apex" ? "apex" : x.format === "JS" ? "js" : x.format === "CSS" ? "css" : "markup"}))};
  case "flows":
    return {...base, title: `${name}.flow`, files: [{path: `flows/${name}.flow-meta.json`, lang: "json",
      content: JSON.stringify(flowMetadata({...f, kind: f.flowKind}), null, 2)}]};
  case "rules":
    return {...base, title: `${f.object}.${name}`, files: [{path: `objects/${f.object}/validationRules/${name}.json`, lang: "json",
      content: JSON.stringify(validationRuleMetadata(f), null, 2)}]};
  case "cmdt": {
    const def = {
      name, label: f.label, pluralLabel: f.pluralLabel || f.label, visibility: f.visibility || "Public",
      description: f.description || undefined,
      fields: (f.fields || []).filter(r => String(r.label || "").trim())
        .map(r => ({label: r.label.trim(), name: r.name, type: r.type || "Text", required: !!r.required})),
    };
    return {...base, title: `${name}__mdt`, files: [{path: `objects/${name}__mdt.json`, lang: "json",
      content: JSON.stringify(def, null, 2)}]};
  }
  default:
    throw new Error("Unknown metadata kind: " + kind);
  }
}
