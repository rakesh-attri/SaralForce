// Local UI preview: serves addon/ plus a mock Salesforce org so the panel can
// be opened and screenshotted without an extension install or a real org.
//
//   npm run dev        -> http://127.0.0.1:8321/smoke.html?host=127.0.0.1
//
// test/smoke.html fakes chrome.* and rewrites https://127.0.0.1/... API calls
// to this server. The panel iframe (object-creator.html) is served the same
// harness page so it gets the shim too. Dev-only: never shipped.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {accessTables, metadataTables, permissionSetDescribe, applyWhere} from "./mock-access-metadata.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = path.join(root, "addon");
const harness = path.join(root, "test", "smoke.html");
const PORT = Number(process.env.PORT || 8321);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".ico": "image/x-icon"
};

// ─── Mock org data ───────────────────────────────────────────────
const ORG_ID = "00D5g000000DemoAAA";
const ME = "005dN00000AKqG1QAL";
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString().replace("Z", "+0000");

const users = [
  {Id: ME, Name: "Rakesh Sharma", Username: "rakesh@demo.saralforce", Email: "rakesh@demo.example", Alias: "RShar", IsActive: true, ProfileId: "00e000000000001AAA", Profile: {Name: "System Administrator"}, UserRoleId: "00E000000000001AAA", UserRole: {Name: "CEO"}, LastLoginDate: iso(3600e3), TimeZoneSidKey: "Asia/Kolkata", LanguageLocaleKey: "en_US", UserType: "Standard"},
  {Id: "005dN00000BQmH2RBM", Name: "Priya Nair", Username: "priya@demo.saralforce", Email: "priya@demo.example", Alias: "PNair", IsActive: true, ProfileId: "00e000000000002AAA", Profile: {Name: "Standard User"}, UserRoleId: "00E000000000002AAA", UserRole: {Name: "Sales Manager"}, LastLoginDate: iso(86400e3), UserType: "Standard"},
  {Id: "005dN00000CRnJ3SCN", Name: "Anita Desai", Username: "anita@demo.saralforce", Email: "anita@demo.example", Alias: "ADesai", IsActive: true, ProfileId: "00e000000000002AAA", Profile: {Name: "Standard User"}, UserRoleId: null, UserRole: null, LastLoginDate: iso(5 * 86400e3), UserType: "Standard"},
  {Id: "005dN00000DSkK4TDO", Name: "Vikram Rao", Username: "vikram@demo.saralforce", Email: "vikram@demo.example", Alias: "VRao", IsActive: false, ProfileId: "00e000000000003AAA", Profile: {Name: "Marketing User"}, UserRoleId: null, UserRole: null, LastLoginDate: null, UserType: "Standard"}
];
const accounts = ["Acme Corporation", "Globex Industries", "Initech", "Umbrella Health", "Stark Logistics", "Wayne Retail"].map((Name, i) => ({
  Id: `001dN0000${String(i).padStart(9, "0")}AAA`.slice(0, 18), Name, Industry: ["Manufacturing", "Energy", "Technology", "Healthcare", "Transportation", "Retail"][i],
  AnnualRevenue: (i + 2) * 1250000, Phone: `+91 98${i}00 1234${i}`, BillingCity: ["Jaipur", "Pune", "Bengaluru", "Mumbai", "Chennai", "Delhi"][i],
  OwnerId: ME, CreatedDate: iso((i + 1) * 86400e3 * 7), LastModifiedDate: iso((i + 1) * 3600e3)
}));
const profiles = [
  {Id: "00e000000000001AAA", Name: "System Administrator"}, {Id: "00e000000000002AAA", Name: "Standard User"},
  {Id: "00e000000000003AAA", Name: "Marketing User"}, {Id: "00e000000000004AAA", Name: "Read Only"}
];
const roles = [{Id: "00E000000000001AAA", Name: "CEO"}, {Id: "00E000000000002AAA", Name: "Sales Manager"}];
const apexClasses = ["PaymentGateway", "InvoiceService", "AccountTriggerHandler", "LeadRouter", "PaymentGatewayTest", "InvoiceServiceTest"]
  .map((Name, i) => ({Id: `01pdN00000000${i}0AAA`, Name, NamespacePrefix: null, ApiVersion: 67, Status: "Active", LengthWithoutComments: 800 + i * 140}));
const coverage = apexClasses.filter(c => !c.Name.endsWith("Test")).map((c, i) => ({
  Id: `715dN0000000${i}00AAA`, ApexClassOrTriggerId: c.Id, ApexClassOrTrigger: {Name: c.Name},
  NumLinesCovered: [92, 61, 40, 15][i], NumLinesUncovered: [8, 39, 60, 85][i], LastModifiedDate: iso(7200e3)
}));
const logs = [0, 1, 2, 3, 4].map(i => ({
  Id: `07LdN0000000${i}00AAA`, LogUserId: ME, LogUser: {Name: "Rakesh Sharma"}, Request: "API", Operation: ["/apex/execute", "Trigger", "Batch Apex", "VF Page", "API"][i],
  Application: "Unknown", Status: i === 1 ? "Attempt to de-reference a null object" : "Success", DurationMilliseconds: 120 + i * 37,
  LogLength: 4200 + i * 900, StartTime: iso((i + 1) * 900e3), Location: "Monitoring"
}));
const LOG_BODY = [
  "67.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO",
  "12:00:00.0 (100)|EXECUTION_STARTED",
  "12:00:00.0 (200)|CODE_UNIT_STARTED|[EXTERNAL]|01pdN000000000AAA|PaymentGateway.run",
  "12:00:00.0 (300)|USER_DEBUG|[12]|DEBUG|Charging invoice INV-0042",
  "12:00:00.0 (400)|SOQL_EXECUTE_BEGIN|[15]|Aggregations:0|SELECT Id FROM Account LIMIT 1",
  "12:00:00.0 (500)|EXCEPTION_THROWN|[22]|System.NullPointerException: Attempt to de-reference a null object",
  "12:00:00.0 (600)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object",
  "12:00:00.0 (700)|CODE_UNIT_FINISHED|PaymentGateway.run",
  "12:00:00.0 (800)|EXECUTION_FINISHED"
].join("\n");

const field = (name, type, label, extra = {}) => ({
  name, type, label: label || name.replace(/__c$/, "").replace(/_/g, " "), custom: name.endsWith("__c"), nillable: true,
  updateable: !["Id", "CreatedDate", "LastModifiedDate"].includes(name), createable: true, calculated: false,
  referenceTo: [], relationshipName: null, picklistValues: [], length: type === "string" ? 255 : 0, externalId: false, unique: false, ...extra
});
const describes = {
  PermissionSet: permissionSetDescribe,
  Feature_Flag__mdt: {name: "Feature_Flag__mdt", label: "Feature Flag", labelPlural: "Feature Flags", custom: true, queryable: true, fields: [
    field("Id", "id"), field("DeveloperName", "string", "Custom Metadata Record Name"), field("MasterLabel", "string", "Label"),
    field("Enabled__c", "boolean", "Enabled", {custom: true, nillable: false}), field("Rollout_Percent__c", "percent", "Rollout %", {custom: true}),
    field("Owner_Team__c", "picklist", "Owner Team", {custom: true, picklistValues: ["Sales", "Service", "Platform"].map(v => ({value: v, label: v, active: true}))})
  ]},
  Account: {name: "Account", label: "Account", labelPlural: "Accounts", keyPrefix: "001", custom: false, queryable: true, createable: true, updateable: true, fields: [
    field("Id", "id", "Account ID"), field("Name", "string", "Account Name", {nillable: false}), field("Industry", "picklist", "Industry", {picklistValues: ["Manufacturing", "Energy", "Technology", "Healthcare", "Retail"].map(v => ({value: v, label: v, active: true}))}),
    field("AnnualRevenue", "currency", "Annual Revenue"), field("Phone", "phone"), field("BillingCity", "string", "Billing City"),
    field("OwnerId", "reference", "Owner ID", {referenceTo: ["User"], relationshipName: "Owner"}), field("CreatedDate", "datetime", "Created Date"),
    field("LastModifiedDate", "datetime", "Last Modified Date"), field("Customer_Tier__c", "picklist", "Customer Tier", {picklistValues: [{value: "Gold", label: "Gold", active: true}]})
  ], childRelationships: [{relationshipName: "Contacts", childSObject: "Contact", field: "AccountId"}, {relationshipName: "Opportunities", childSObject: "Opportunity", field: "AccountId"}]},
  User: {name: "User", label: "User", labelPlural: "Users", keyPrefix: "005", custom: false, queryable: true, fields: [
    field("Id", "id", "User ID"), field("Name", "string", "Full Name"), field("Username", "string"), field("Email", "email"), field("Alias", "string"),
    field("IsActive", "boolean", "Active"), field("ProfileId", "reference", "Profile ID", {referenceTo: ["Profile"], relationshipName: "Profile"}),
    field("UserRoleId", "reference", "Role ID", {referenceTo: ["UserRole"], relationshipName: "UserRole"}), field("LastLoginDate", "datetime", "Last Login")
  ]}
};
const sobjectList = ["Account", "Contact", "Opportunity", "Case", "Lead", "User", "Profile", "Support_Ticket__c", "Invoice__c", "Feature_Flag__mdt"]
  .map(name => ({name, label: name.replace(/__c$/, "").replace(/_/g, " "), labelPlural: name.replace(/__c$/, "").replace(/_/g, " ") + "s", custom: name.endsWith("__c"), queryable: true, keyPrefix: describes[name]?.keyPrefix || null, layoutable: true, createable: true}));

// Large table for result paging and "Fetch more" (Salesforce pages by 2000).
const contacts = Array.from({length: 45000}, (_, i) => ({Id: "003" + String(i).padStart(12, "0") + "AAA", LastName: "Contact " + (i + 1), Email: "c" + (i + 1) + "@demo.test"}));
const PAGE = 2000;

const tables = {
  contact: contacts, user: users, account: accounts, profile: profiles, userrole: roles, apexclass: apexClasses, apexcodecoverageaggregate: coverage, apexlog: logs,
  organization: [{Id: ORG_ID, Name: "SaralForce Demo Org", IsSandbox: true, InstanceName: "IND42", OrganizationType: "Developer Edition", TrialExpirationDate: null, LanguageLocaleKey: "en_US", TimeZoneSidKey: "Asia/Kolkata", CreatedDate: iso(400 * 86400e3)}],
  permissionset: [{Id: "0PS000000000001AAA", Name: "Sales_Ops", Label: "Sales Ops", IsOwnedByProfile: false, License: {Name: "Salesforce"}}, {Id: "0PS000000000002AAA", Name: "API_Access", Label: "API Access", IsOwnedByProfile: false}],
  loginhistory: [0, 1, 2].map(i => ({Id: `0Ya00000000000${i}AAA`, UserId: ME, LoginTime: iso((i + 1) * 3600e3), SourceIp: `203.0.113.${10 + i}`, Status: "Success", Application: "Browser", Browser: "Chrome", Platform: "Windows"})),
  setupaudittrail: [0, 1, 2].map(i => ({Id: `0Ym00000000000${i}AAA`, Action: ["createdCustomObject", "changedProfile", "permSetAssign"][i], Display: ["Created custom object: Support Ticket", "Changed profile Standard User", "Assigned permission set Sales Ops"][i], Section: "Customize", CreatedDate: iso((i + 1) * 7200e3), CreatedBy: {Name: "Rakesh Sharma"}})),
  customapplication: [{Id: "02u000000000001AAA", DeveloperName: "Sales", MasterLabel: "Sales", NavType: "Standard", UiType: "Lightning"}, {Id: "02u000000000002AAA", DeveloperName: "Service_Console", MasterLabel: "Service Console", NavType: "Console", UiType: "Lightning"}],
  entitydefinition: sobjectList.map(o => ({QualifiedApiName: o.name, Label: o.label, DurableId: o.name, KeyPrefix: o.keyPrefix})),
  feature_flag__mdt: [
    {Id: "m00dN0000000001AAA", DeveloperName: "Checkout_v2", MasterLabel: "Checkout v2", NamespacePrefix: null, Enabled__c: true, Rollout_Percent__c: 25, Owner_Team__c: "Sales"},
    {Id: "m00dN0000000002AAA", DeveloperName: "New_Case_Form", MasterLabel: "New Case Form", NamespacePrefix: null, Enabled__c: false, Rollout_Percent__c: 0, Owner_Team__c: "Service"}
  ],
  ...accessTables({users, profiles}),
  ...metadataTables(apexClasses)
};

function soqlResult(q) {
  const from = /\bfrom\s+([A-Za-z0-9_]+)/i.exec(q);
  const obj = from ? from[1].toLowerCase() : "";
  if (/^\s*select\s+count\(\)/i.test(q)) {
    return {totalSize: (tables[obj] || []).length, done: true, records: []};
  }
  const limit = /\blimit\s+(\d+)/i.exec(q);
  let records = applyWhere(q, tables[obj] || []);
  if (limit) records = records.slice(0, Number(limit[1]));
  return soqlPage(q, records, 0, from ? from[1] : "SObject");
}

function soqlPage(q, records, offset, type) {
  const page = records.slice(offset, offset + PAGE).map(r => ({attributes: {type}, ...r}));
  const more = offset + PAGE < records.length;
  return {totalSize: records.length, done: !more, records: page,
    ...(more ? {nextRecordsUrl: "/services/data/v67.0/query/mock-" + (offset + PAGE) + "?q=" + encodeURIComponent(q)} : {})};
}

function limitsBody() {
  const l = (Max, used) => ({Max, Remaining: Max - used});
  return {DailyApiRequests: l(15000, 1840), DataStorageMB: l(5, 2), FileStorageMB: l(20, 7), DailyAsyncApexExecutions: l(250000, 1200), DailyBulkV2QueryJobs: l(10000, 4), SingleEmail: l(5000, 12)};
}

function json(res, status, body) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*"});
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function soapUserInfo(res) {
  res.writeHead(200, {"Content-Type": "text/xml; charset=utf-8"});
  res.end(`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="urn:partner.soap.sforce.com"><soapenv:Body><getUserInfoResponse><result><organizationId>${ORG_ID}</organizationId><organizationName>SaralForce Demo Org</organizationName><userFullName>Rakesh Sharma</userFullName><userId>${ME}</userId><userName>rakesh@demo.saralforce</userName><userTimeZone>Asia/Kolkata</userTimeZone></result></getUserInfoResponse></soapenv:Body></soapenv:Envelope>`);
}

function api(req, res, url) {
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"});
    return res.end();
  }
  if (p.startsWith("/services/Soap/m/") && req.method === "POST") {
    res.writeHead(200, {"Content-Type": "text/xml; charset=utf-8", "Access-Control-Allow-Origin": "*"});
    return res.end('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body><createMetadataResponse><result><fullName>Mock__mdt</fullName><success>true</success></result></createMetadataResponse></soapenv:Body></soapenv:Envelope>');
  }
  if (p.startsWith("/services/Soap/")) return soapUserInfo(res);
  if (/^\/services\/data\/?$/.test(p)) return json(res, 200, ["66.0", "67.0", "68.0"].map(version => ({version, url: `/services/data/v${version}`})));
  if (p === "/services/oauth2/userinfo") {
    return json(res, 200, {user_id: ME, organization_id: ORG_ID, name: "Rakesh Sharma", preferred_username: "rakesh@demo.saralforce", nickname: "rakesh"});
  }
  const cursor = /\/query\/mock-(\d+)$/.exec(p);
  if (cursor) {
    const q = url.searchParams.get("q") || "";
    const from = /\bfrom\s+([A-Za-z0-9_]+)/i.exec(q);
    const limit = /\blimit\s+(\d+)/i.exec(q);
    let records = applyWhere(q, tables[from ? from[1].toLowerCase() : ""] || []);
    if (limit) records = records.slice(0, Number(limit[1]));
    return json(res, 200, soqlPage(q, records, Number(cursor[1]), from ? from[1] : "SObject"));
  }
  if (/\/(query|queryAll)\/?$/.test(p)) return json(res, 200, soqlResult(url.searchParams.get("q") || ""));
  if (/\/limits\/?$/.test(p)) return json(res, 200, limitsBody());
  if (/\/sobjects\/?$/.test(p)) return json(res, 200, {encoding: "UTF-8", maxBatchSize: 200, sobjects: sobjectList});
  const describe = /\/sobjects\/([A-Za-z0-9_]+)\/describe\/?$/.exec(p);
  if (describe) {
    const d = describes[describe[1]] || {name: describe[1], label: describe[1], labelPlural: describe[1] + "s", custom: describe[1].endsWith("__c"), queryable: true, fields: [field("Id", "id"), field("Name", "string")]};
    return json(res, 200, d);
  }
  if (/\/ApexLog\/[^/]+\/Body\/?$/.test(p)) {
    res.writeHead(200, {"Content-Type": "text/plain"});
    return res.end(LOG_BODY);
  }
  const record = /\/sobjects\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})\/?$/.exec(p);
  if (record && req.method === "GET") {
    const rows = tables[record[1].toLowerCase()] || [];
    return json(res, 200, rows.find(r => r.Id === record[2]) || {attributes: {type: record[1]}, Id: record[2], Name: "Demo record"});
  }
  if (p.includes("/ui-api/")) return json(res, 200, {fields: {}, layouts: {}, records: {}});
  if (req.method === "GET") return json(res, 200, {});
  // Writes succeed without changing anything.
  return json(res, req.method === "DELETE" ? 204 : 200, req.method === "DELETE" ? undefined : {id: "a00dN000000NEWAAA", success: true, errors: []});
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {"Content-Type": "text/plain"});
      return res.end("Not found");
    }
    res.writeHead(200, {"Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store"});
    res.end(data);
  });
}

// Canned OpenAI-compatible endpoint so AI features can be exercised without
// a real key: set provider "OpenAI Compatible", base URL
// http://127.0.0.1:<PORT>/mock-llm/v1 and any key.
let lastLlmRequest = null;
// Canned LWC bundle for "Build with AI" (valid enough to pass checkLwcBundle).
function mockLwcBundle(name) {
  const cls = name.charAt(0).toUpperCase() + name.slice(1);
  return JSON.stringify({
    label: "Open Cases", description: "Open cases of the account on its record page.", targets: ["lightning__RecordPage"],
    files: {
      html: `<template>\n    <lightning-card title="Open Cases" icon-name="standard:case">\n        <lightning-datatable key-field="Id" data={cases} columns={columns} hide-checkbox-column></lightning-datatable>\n    </lightning-card>\n</template>`,
      js: `import { LightningElement, api, wire } from 'lwc';\nimport getOpenCases from '@salesforce/apex/OpenCasesController.getOpenCases';\n\n` +
        `export default class ${cls} extends LightningElement {\n    @api recordId;\n    columns = [\n        { label: 'Case', fieldName: 'CaseNumber' },\n        { label: 'Subject', fieldName: 'Subject' }\n    ];\n` +
        `    cases = [];\n\n    @wire(getOpenCases, { accountId: '$recordId' })\n    wired({ data }) {\n        if (data) this.cases = data;\n    }\n}`,
      css: ":host {\n    display: block;\n}",
    },
    apex: [{name: "OpenCasesController", body: "public with sharing class OpenCasesController {\n    @AuraEnabled(cacheable=true)\n" +
      "    public static List<Case> getOpenCases(Id accountId) {\n        return [SELECT Id, CaseNumber, Subject FROM Case WHERE AccountId = :accountId AND IsClosed = false WITH SECURITY_ENFORCED LIMIT 50];\n    }\n}"}],
    explanation: "Shows the account's open cases in a table. Add it to an Account record page in Lightning App Builder.",
  });
}

// Canned Apex class / trigger / page / Aura reply for "Build with AI".
function mockCode(user) {
  const name = (/\nName: ([A-Za-z0-9_]+)/.exec("\n" + user) || [])[1] || "Demo";
  const object = (/\nObject: ([A-Za-z0-9_]+)/.exec("\n" + user) || [])[1] || "Account";
  const kind = (/^Kind: (.*)$/m.exec(user) || [])[1] || "";
  const files = /trigger/.test(kind) ? {
    [`triggers/${name}.trigger`]: `trigger ${name} on ${object} (before update) {\n    ${object}Escalation.run(Trigger.new, Trigger.oldMap);\n}`,
    [`classes/${object}Escalation.cls`]: `public with sharing class ${object}Escalation {\n    public static void run(List<${object}> rows, Map<Id, ${object}> oldMap) {\n        for (${object} r : rows) {\n            // Bulk-safe: no SOQL or DML in the loop.\n        }\n    }\n}`,
  } : /Visualforce/.test(kind) ? {
    [`pages/${name}.page`]: `<apex:page standardController="${object}" renderAs="pdf" lightningStylesheets="true">\n    <h1>{!${object}.Name}</h1>\n</apex:page>`,
  } : /Aura/.test(kind) ? {
    [`aura/${name}/${name}.cmp`]: `<aura:component implements="flexipage:availableForRecordHome,force:hasRecordId" access="global">\n    <lightning:card title="Contacts"><p class="slds-p-horizontal_small">{!v.recordId}</p></lightning:card>\n</aura:component>`,
    [`aura/${name}/${name}Controller.js`]: "({\n    init: function (component, event, helper) {\n    }\n})",
  } : {
    [`classes/${name}.cls`]: `public with sharing class ${name} {\n    public static Integer closeStale() {\n        List<Opportunity> rows = [SELECT Id FROM Opportunity WHERE IsClosed = false AND CreatedDate < LAST_N_DAYS:90 WITH SECURITY_ENFORCED LIMIT 200];\n        for (Opportunity o : rows) { o.StageName = 'Closed Lost'; }\n        update rows;\n        return rows.size();\n    }\n}`,
    [`classes/${name}Test.cls`]: `@IsTest\nprivate class ${name}Test {\n    @IsTest static void closesStale() {\n        Test.startTest();\n        Integer n = ${name}.closeStale();\n        Test.stopTest();\n        System.assert(n >= 0, 'Count should not be negative');\n    }\n}`,
  };
  return JSON.stringify({files: Object.entries(files).map(([path, content]) => ({path, content})), label: "",
    description: "Generated by the mock AI.", explanation: "Mock AI wrote this so the preview can show the flow. Review the files, then deploy."});
}

// Canned edit for "Ask AI to change" / "Fix with AI": restyle the CSS file.
function mockRevision(user) {
  const name = (/\nName: ([A-Za-z0-9_]+)/.exec("\n" + user) || [])[1] || "c";
  const path = (/=== (lwc\/[^ ]+\.css) ===/.exec(user) || [])[1] || `lwc/${name}/${name}.css`;
  const fixing = /deploy error to fix/.test(user);
  return JSON.stringify({files: {[path]: ":host {\n    display: block;\n}\n\nlightning-card {\n    --slds-c-card-spacing-block: 0.75rem;\n}"},
    explanation: fixing ? "Fixed the reported error by tidying the stylesheet." : "Tightened the card spacing in the stylesheet."});
}

function mockLlm(req, res) {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* keep empty */ }
    lastLlmRequest = body;
    const system = String(((body.messages || [])[0] || {}).content || "");
    const user = String(((body.messages || [])[1] || {}).content || "");
    const content = /Write ONE complete, deployable piece of metadata/.test(system)
      ? mockCode(user)
      : /Write ONE complete, deployable component/.test(system)
      ? mockLwcBundle((/Component folder name: ([A-Za-z0-9]+)/.exec(user) || [])[1] || "openCases")
      : /editing a draft before it is deployed/.test(system)
      ? mockRevision(user)
      : /writing validation rules/.test(system)
      ? JSON.stringify({ruleName: "Close_Date_Not_Past", formula: "AND(\n  ISPICKVAL(Industry, \"Energy\"),\n  ISBLANK(Phone),\n  NOT($Permission.Bypass_Validation),\n  $Profile.Name <> \"System Administrator\"\n)",
        errorMessage: "Energy accounts need a phone number.", errorDisplayField: "Phone", description: "Phone required for energy accounts; admins can skip it.",
        explanation: "Blocks saving an Energy account with no phone, unless you are a System Administrator."})
      : /request into ONE valid SOQL/.test(system)
      ? JSON.stringify({query: "SELECT Id, Name, Industry FROM Account WHERE Industry = 'Energy' LIMIT 200", explanation: "Accounts in the Energy industry, up to 200."})
      : /suggest|fix/i.test(system) && /fixedQuery/.test(system)
      ? JSON.stringify({explanation: "Mock fix.", fixedQuery: "SELECT Id, Name FROM Account LIMIT 50"})
      : "Returns the Id and Name of up to 50 Account records. There is no filter, so any 50 accounts may come back.";
    json(res, 200, {id: "mock", object: "chat.completion", choices: [{index: 0, message: {role: "assistant", content}, finish_reason: "stop"}]});
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/services/")) return api(req, res, url);
  if (url.pathname === "/mock-llm/last") return json(res, 200, lastLlmRequest);
  if (url.pathname.startsWith("/mock-llm/")) {
    if (req.method === "OPTIONS") return api(req, res, url);
    return mockLlm(req, res);
  }
  // The harness stands in for both the Salesforce page and the panel page.
  // /lightning/r/<Object>/<Id>/view mimics a record page for record-aware
  // features such as Show API Names.
  if (url.pathname === "/" || url.pathname === "/smoke.html" || url.pathname === "/object-creator.html" ||
      url.pathname.startsWith("/lightning/")) {
    return serveFile(res, harness);
  }
  const filePath = path.normalize(path.join(addonDir, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(addonDir)) {
    res.writeHead(403);
    return res.end();
  }
  serveFile(res, filePath);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`SaralForce preview: http://127.0.0.1:${PORT}/smoke.html?host=127.0.0.1`);
});
