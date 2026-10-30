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
  NumLinesCovered: [92, 61, 40, 15][i], NumLinesUncovered: [8, 39, 60, 85][i], LastModifiedDate: iso(7200e3),
  Coverage: {coveredLines: [1, 3, 4, 5, 6, 11, 12], uncoveredLines: [7, 8]}
}));
// One mock test job: two classes, one failing method.
const TEST_JOB = "7070000000JOB01AAA";
const testQueue = [
  {Id: "709000000000001AAA", ParentJobId: TEST_JOB, ApexClassId: "01pdN0000000040AAA", ApexClass: {Name: "PaymentGatewayTest"}, Status: "Completed"},
  {Id: "709000000000002AAA", ParentJobId: TEST_JOB, ApexClassId: "01pdN0000000050AAA", ApexClass: {Name: "InvoiceServiceTest"}, Status: "Completed"}
];
const testResults = [
  {Id: "07M000000000001AAA", AsyncApexJobId: TEST_JOB, ApexClassId: "01pdN0000000040AAA", ApexClass: {Name: "PaymentGatewayTest"}, MethodName: "chargesCard", Outcome: "Pass", RunTime: 41},
  {Id: "07M000000000002AAA", AsyncApexJobId: TEST_JOB, ApexClassId: "01pdN0000000040AAA", ApexClass: {Name: "PaymentGatewayTest"}, MethodName: "refundsCard", Outcome: "Pass", RunTime: 37},
  {Id: "07M000000000003AAA", AsyncApexJobId: TEST_JOB, ApexClassId: "01pdN0000000050AAA", ApexClass: {Name: "InvoiceServiceTest"}, MethodName: "marksOverdue", Outcome: "Fail", RunTime: 58,
    Message: "System.AssertException: Assertion Failed: Expected: 1, Actual: 0", StackTrace: "Class.InvoiceService.markOverdue: line 7, column 1\nClass.InvoiceServiceTest.marksOverdue: line 9, column 1"},
  {Id: "07M000000000004AAA", AsyncApexJobId: TEST_JOB, ApexClassId: "01pdN0000000050AAA", ApexClass: {Name: "InvoiceServiceTest"}, MethodName: "skipsPaid", Outcome: "Pass", RunTime: 22}
];
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
    field("Id", "id", "Account ID"), field("Name", "string", "Account Name", {nillable: false, nameField: true}), field("Industry", "picklist", "Industry", {picklistValues: ["Manufacturing", "Energy", "Technology", "Healthcare", "Retail"].map(v => ({value: v, label: v, active: true}))}),
    field("AnnualRevenue", "currency", "Annual Revenue"), field("Phone", "phone"), field("BillingCity", "string", "Billing City"),
    field("OwnerId", "reference", "Owner ID", {referenceTo: ["User"], relationshipName: "Owner"}), field("CreatedDate", "datetime", "Created Date"),
    field("LastModifiedDate", "datetime", "Last Modified Date"), field("Customer_Tier__c", "picklist", "Customer Tier", {picklistValues: [{value: "Gold", label: "Gold", active: true}]})
  ], childRelationships: [{relationshipName: "Contacts", childSObject: "Contact", field: "AccountId"}, {relationshipName: "Opportunities", childSObject: "Opportunity", field: "AccountId"}, {relationshipName: "Histories", childSObject: "AccountHistory", field: "AccountId"}]},
  Invoice__c: {name: "Invoice__c", label: "Invoice", labelPlural: "Invoices", keyPrefix: "a01", custom: true, queryable: true, fields: [
    field("Id", "id", "Record ID"), field("Name", "string", "Invoice Number", {nameField: true, autoNumber: true}),
    field("Amount__c", "currency", "Amount", {custom: true}), field("Due_Date__c", "date", "Due Date", {custom: true}),
    field("Status__c", "picklist", "Status", {custom: true, picklistValues: ["Draft", "Sent", "Paid"].map(v => ({value: v, label: v, active: true}))}),
    field("Account__c", "reference", "Account", {custom: true, referenceTo: ["Account"], relationshipName: "Account__r", relationshipOrder: null})
  ]},
  User: {name: "User", label: "User", labelPlural: "Users", keyPrefix: "005", custom: false, queryable: true, fields: [
    field("Id", "id", "User ID"), field("Name", "string", "Full Name"), field("Username", "string"), field("Email", "email"), field("Alias", "string"),
    field("IsActive", "boolean", "Active"), field("ProfileId", "reference", "Profile ID", {referenceTo: ["Profile"], relationshipName: "Profile"}),
    field("UserRoleId", "reference", "Role ID", {referenceTo: ["UserRole"], relationshipName: "UserRole"}), field("LastLoginDate", "datetime", "Last Login")
  ]}
};
const sobjectList = ["Account", "Contact", "Opportunity", "Case", "Lead", "User", "Profile", "Support_Ticket__c", "Invoice__c", "Feature_Flag__mdt"]
  .map(name => ({name, label: name.replace(/__c$/, "").replace(/_/g, " "), labelPlural: name.replace(/__c$/, "").replace(/_/g, " ") + "s", custom: name.endsWith("__c"), queryable: true, keyPrefix: describes[name]?.keyPrefix || null, layoutable: true, createable: true}));

// Large table for result paging and "Fetch more" (Salesforce pages by 2000).
const contacts = Array.from({length: 45000}, (_, i) => ({Id: "003" + String(i).padStart(12, "0") + "AAA", LastName: "Contact " + (i + 1), Name: "Contact " + (i + 1), Email: "c" + (i + 1) + "@demo.test",
  AccountId: i < 3 ? accounts[0].Id : null, CreatedDate: iso((i + 1) * 3600e3)}));
// Field history of the first account.
const accountHistory = [
  {Id: "017000000000001AAA", AccountId: accounts[0].Id, Field: "Industry", OldValue: "Technology", NewValue: "Manufacturing", CreatedDate: iso(2 * 86400e3), CreatedBy: {Name: "Priya Nair"}},
  {Id: "017000000000002AAA", AccountId: accounts[0].Id, Field: "AnnualRevenue", OldValue: 2000000, NewValue: 2500000, CreatedDate: iso(5 * 86400e3), CreatedBy: {Name: "Rakesh Sharma"}},
  {Id: "017000000000003AAA", AccountId: accounts[0].Id, Field: "created", OldValue: null, NewValue: null, CreatedDate: iso(30 * 86400e3), CreatedBy: {Name: "Rakesh Sharma"}}
];
const PAGE = 2000;

const tables = {
  contact: contacts, accounthistory: accountHistory, opportunity: [], user: users, account: accounts, profile: profiles, userrole: roles, apexclass: apexClasses, apexcodecoverageaggregate: coverage, apexlog: logs, apextestqueueitem: testQueue, apextestresult: testResults,
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

// Bundle files need ids so edits PATCH them in place.
let lastMemberBody = "";
for (const t of ["lightningcomponentresource", "auradefinition"]) {
  (tables[t] || []).forEach((r, i) => { if (!r.Id) r.Id = `0Rd${t === "auradefinition" ? "A" : "L"}N${String(i).padStart(10, "0")}AAA`; });
}

function soqlResult(q) {
  const from = /\bfrom\s+([A-Za-z0-9_]+)/i.exec(q);
  const obj = from ? from[1].toLowerCase() : "";
  if (/^\s*select\s+count\(\)/i.test(q)) {
    return {totalSize: applyWhere(q, tables[obj] || []).length, done: true, records: []};
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

// Apex SOAP executeAnonymous: a script containing "oops" fails to compile on
// its 2nd line; anything else succeeds and returns a log with limit usage.
function mockExecuteAnonymous(req, res) {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    const code = (/<apex:String>([\s\S]*?)<\/apex:String>/.exec(raw) || [])[1] || "";
    const wantsLog = /DebuggingHeader/.test(raw);
    const bad = /oops/.test(code);
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const log = [
      "67.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO",
      "12:00:00.0 (100)|EXECUTION_STARTED",
      "12:00:00.0 (200)|USER_DEBUG|[1]|DEBUG|Hello from the mock org",
      "12:00:00.0 (300)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Account",
      "12:00:00.0 (400)|LIMIT_USAGE_FOR_NS|(default)|",
      "  Number of SOQL queries: 1 out of 100",
      "  Number of query rows: 6 out of 50000",
      "  Number of DML statements: 0 out of 150",
      "  Maximum CPU time: 8200 out of 10000",
      "  Maximum heap size: 0 out of 6000000",
      "",
      "12:00:00.0 (500)|EXECUTION_FINISHED",
    ].join("\n");
    const result = bad
      ? "<column>9</column><compileProblem>Unexpected token &apos;oops&apos;.</compileProblem><compiled>false</compiled><exceptionMessage xsi:nil=\"true\"/><exceptionStackTrace xsi:nil=\"true\"/><line>2</line><success>false</success>"
      : "<column>-1</column><compileProblem xsi:nil=\"true\"/><compiled>true</compiled><exceptionMessage xsi:nil=\"true\"/><exceptionStackTrace xsi:nil=\"true\"/><line>-1</line><success>true</success>";
    res.writeHead(200, {"Content-Type": "text/xml; charset=utf-8", "Access-Control-Allow-Origin": "*"});
    res.end(`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/08/apex" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Header>${wantsLog && !bad ? `<DebuggingInfo><debugLog>${esc(log)}</debugLog></DebuggingInfo>` : ""}</soapenv:Header><soapenv:Body><executeAnonymousResponse><result>${result}</result></executeAnonymousResponse></soapenv:Body></soapenv:Envelope>`);
  });
}

function api(req, res, url) {
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"});
    return res.end();
  }
  if (/\/tooling\/runTestsAsynchronous\/?$/.test(p) && req.method === "POST") return json(res, 200, TEST_JOB);
  if (p.startsWith("/services/Soap/s/") && req.method === "POST") return mockExecuteAnonymous(req, res);
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
    const d = describes[describe[1]] || {name: describe[1], label: describe[1], labelPlural: describe[1] + "s", custom: describe[1].endsWith("__c"), queryable: true, fields: [field("Id", "id"), field("Name", "string", "Name", {nameField: true})]};
    return json(res, 200, d);
  }
  if (/\/ApexLog\/[^/]+\/Body\/?$/.test(p)) {
    res.writeHead(200, {"Content-Type": "text/plain"});
    return res.end(LOG_BODY);
  }
  // Compile-and-save (MetadataContainer) for editing existing Apex/pages:
  // a member body containing "COMPILE_ERROR" fails like a real compile error.
  const sob = /\/tooling\/sobjects\/([A-Za-z]+)\/?([a-zA-Z0-9]{15,18})?\/?$/.exec(p);
  if (sob && req.method === "POST" && /^Apex(Class|Trigger|Page)Member$/.test(sob[1])) {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      try { lastMemberBody = String(JSON.parse(raw || "{}").Body || ""); } catch { lastMemberBody = ""; }
      json(res, 201, {id: "1drdN000000MEMAAA", success: true, errors: []});
    });
    return undefined;
  }
  if (sob && req.method === "GET" && sob[1] === "ContainerAsyncRequest") {
    const line = lastMemberBody.split("\n").findIndex(l => l.includes("COMPILE_ERROR")) + 1;
    return json(res, 200, line
      ? {Id: sob[2], State: "Failed", DeployDetails: {componentFailures: [{fileName: "classes/Demo.cls", lineNumber: line, columnNumber: 5,
        problem: "Variable does not exist: COMPILE_ERROR", problemType: "Error"}]}}
      : {Id: sob[2], State: "Completed"});
  }
  // Object Builder field access: permission set, object/field permissions,
  // assignment. Counted per type at /mock-perm.
  const perm = /\/data\/v[\d.]+\/sobjects\/(PermissionSet|ObjectPermissions|FieldPermissions|PermissionSetAssignment)\/?$/.exec(p);
  if (perm && req.method === "POST") {
    permPosts[perm[1]] = (permPosts[perm[1]] || 0) + 1;
    return json(res, 201, {id: "0PS" + String(Object.values(permPosts).reduce((a, b) => a + b, 0)).padStart(12, "0") + "AAA", success: true, errors: []});
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
const permPosts = {};
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
  const fixing = /deploy error to fix/.test(user);
  // Code drafts: fix the first file (drop a COMPILE_ERROR line, else add a note).
  if (!/^Kind: lwc$/m.test(user)) {
    const m = /=== ([^\n]+?) ===\n([\s\S]*?)(?=\n=== |$)/.exec(user);
    if (m && !/\.css$/.test(m[1])) {
      const fixed = m[2].split("\n").filter(l => !l.includes("COMPILE_ERROR")).join("\n");
      const content = fixed !== m[2] ? fixed : m[2].replace(/\{/, "{\n    // Reviewed by AI: null-safe and bulk-safe.");
      return JSON.stringify({files: {[m[1]]: content},
        explanation: fixed !== m[2] ? "Removed the line that referenced an undefined variable." : "Added a review note; the logic already looked bulk-safe."});
    }
  }
  const path = (/=== (lwc\/[^ ]+\.css) ===/.exec(user) || [])[1] || `lwc/${name}/${name}.css`;
  return JSON.stringify({files: {[path]: ":host {\n    display: block;\n}\n\nlightning-card {\n    --slds-c-card-spacing-block: 0.75rem;\n}"},
    explanation: fixing ? "Fixed the reported error by tidying the stylesheet." : "Tightened the card spacing in the stylesheet."});
}

// Object Builder: a plan using the newer field types; a refinement keeps the
// current plan (embedded in the user message) and adds a Priority picklist.
function mockObjectPlan(user, refine) {
  if (refine) {
    const m = /\{[\s\S]*\}/.exec(user);
    let plan = null;
    try { plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; }
    if (plan && Array.isArray(plan.fields)) {
      plan.fields.push({label: "Priority", name: "Priority__c", type: "Picklist", values: ["Low", "Medium", "High"], description: "How urgent it is"});
      return JSON.stringify(plan);
    }
  }
  return JSON.stringify({
    object: {label: "Order", pluralLabel: "Orders", name: "Order__c", description: "Customer orders", enableHistory: true,
      nameField: {label: "Order Number", type: "AutoNumber", format: "ORD-{00000}"}, sharingModel: "ReadWrite"},
    fields: [
      {label: "Quantity", name: "Quantity__c", type: "Number", precision: 18, scale: 0, description: "Units ordered"},
      {label: "Unit Price", name: "Unit_Price__c", type: "Currency", precision: 18, scale: 2, description: "Price per unit"},
      {label: "Total", name: "Total__c", type: "Formula", returnType: "Currency", formula: "Quantity__c * Unit_Price__c", description: "Quantity × price"},
      {label: "Category", name: "Category__c", type: "Picklist", values: ["Hardware", "Software"], description: "What was ordered", trackHistory: true},
      {label: "Item", name: "Item__c", type: "Picklist", values: ["Laptop", "Phone", "License"], controllingField: "Category__c",
        dependencies: {Hardware: ["Laptop", "Phone"], Software: ["License"]}, description: "Item for the category"},
      {label: "Delivery Time", name: "Delivery_Time__c", type: "Time", description: "Preferred delivery time"}
    ],
    validationRules: [{name: "Quantity_Positive", formula: "Quantity__c <= 0", message: "Quantity must be at least 1", field: "Quantity__c"}],
    listViews: [{name: "All_Orders", label: "All Orders", columns: ["NAME", "Quantity__c", "Total__c"]}],
    compactLayout: {fields: ["Name", "Total__c", "Category__c"]}
  });
}

function mockLlm(req, res) {
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* keep empty */ }
    lastLlmRequest = body;
    const system = String(((body.messages || [])[0] || {}).content || "");
    const msgs = body.messages || [];
    const user = String((msgs[msgs.length - 1] || {}).content || "");
    const content = /design custom objects|refine their custom object design/.test(system)
      ? mockObjectPlan(user, /refine their custom object design/.test(system))
      : /Write ONE complete, deployable piece of metadata/.test(system)
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
    if (body.stream) {
      // Server-sent events in a few chunks, like a real streaming provider.
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"});
      for (let i = 0; i < content.length; i += 400) {
        res.write(`data: ${JSON.stringify({id: "mock", object: "chat.completion.chunk", choices: [{index: 0, delta: {content: content.slice(i, i + 400)}}]})}\n\n`);
      }
      res.write(`data: ${JSON.stringify({id: "mock", choices: [{index: 0, delta: {}, finish_reason: "stop"}]})}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    json(res, 200, {id: "mock", object: "chat.completion", choices: [{index: 0, message: {role: "assistant", content}, finish_reason: "stop"}]});
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/mock-perm") return json(res, 200, permPosts);
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
