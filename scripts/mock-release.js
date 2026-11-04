// Release Center mock: two orgs (this demo org = source, "localhost" = a
// UAT sandbox) with real retrieve / deploy zips, quick deploy and cancel.
// Dev-only (scripts/dev-server.js). Failures can be forced with
// GET /mock-release?fail=component|test|none ; GET /mock-release shows state.
import {writeZip, readZip, base64ToBytes, bytesToBase64, bytesToText} from "../addon/core/zip.js";
import {parsePackageXml, splitParentFile, pathToComponent} from "../addon/core/deploy.js";

export const ORG2_SESSION = "FAKE_SESSION_2";
const day = 86400e3;
const when = ago => new Date(Date.now() - ago).toISOString();
const meta = (type, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>67.0</apiVersion>${extra}\n    <status>Active</status>\n</${type}>\n`;
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

function comp(by, ago, files) {
  return {by, at: when(ago), files};
}

function baseObject(fields, rules = "") {
  return {label: "<label>Invoice</label>\n    <pluralLabel>Invoices</pluralLabel>\n    <sharingModel>ReadWrite</sharingModel>", fields, rules};
}

function makeOrgs() {
  const source = {
    name: "SaralForce Demo Org",
    ApexClass: {
      InvoiceService: comp("Rakesh Sharma", 2 * day, {"classes/InvoiceService.cls": INVOICE_V2, "classes/InvoiceService.cls-meta.xml": meta("ApexClass")}),
      InvoiceTax: comp("Rakesh Sharma", 1 * day, {"classes/InvoiceTax.cls": "public class InvoiceTax {\n    public static Decimal apply(Decimal a) { return a * 1.18; }\n}\n", "classes/InvoiceTax.cls-meta.xml": meta("ApexClass")}),
      InvoiceServiceTest: comp("Priya Nair", 3 * day, {"classes/InvoiceServiceTest.cls": TEST, "classes/InvoiceServiceTest.cls-meta.xml": meta("ApexClass")}),
      InvoiceReminderJob: comp("Priya Nair", 1 * day, {"classes/InvoiceReminderJob.cls": "public class InvoiceReminderJob implements Schedulable {\n    public void execute(SchedulableContext sc) {}\n}\n", "classes/InvoiceReminderJob.cls-meta.xml": meta("ApexClass")})
    },
    PermissionSet: {
      Invoice_Manager: comp("Rakesh Sharma", 1 * day, {"permissionsets/Invoice_Manager.permissionset": meta("PermissionSet", "\n    <label>Invoice Manager</label>").replace("<apiVersion>67.0</apiVersion>", "").replace("<status>Active</status>", "")})
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
      "Invoice__c-Invoice Layout": comp("Rakesh Sharma", 2 * day, {"layouts/Invoice__c-Invoice Layout.layout": meta("Layout", "\n    <layoutSections>\n        <layoutColumns>\n            <layoutItems>\n                <field>Amount__c</field>\n            </layoutItems>\n            <layoutItems>\n                <field>Status__c</field>\n            </layoutItems>\n        </layoutColumns>\n    </layoutSections>").replace("<apiVersion>67.0</apiVersion>", "").replace("<status>Active</status>", "")})
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
      Invoice_Approval: comp("Deploy User", 30 * day, {"flows/Invoice_Approval.flow": meta("Flow", "\n    <label>Invoice Approval</label>\n    <processType>AutoLaunchedFlow</processType>\n    <description>Routes invoices over 5,000 to finance</description>")})
    },
    CustomObject: {
      Invoice__c: comp("Deploy User", 30 * day, baseObject({
        Amount__c: field("Amount__c", "Currency", "        <precision>18</precision>\n        <scale>2</scale>\n")
      }))
    },
    Layout: {}
  };
  return {source, target};
}

let orgs = makeOrgs();
let failMode = "none";
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

function listRows(org, type) {
  const rows = [];
  if (type === "CustomField" || type === "ValidationRule") {
    for (const [obj, c] of Object.entries(org.CustomObject || {})) {
      const names = Object.keys(type === "CustomField" ? c.files.fields : (c.files.rules || {}));
      for (const n of names) rows.push({fullName: `${obj}.${n}`, by: c.by, at: c.at});
    }
    return rows;
  }
  for (const [name, c] of Object.entries(org[type] || {})) rows.push({fullName: name, by: c.by, at: c.at});
  return rows;
}

const RELEASE_TYPES = new Set(["ApexClass", "ApexTrigger", "LightningComponentBundle", "Flow", "CustomObject", "CustomField", "ValidationRule", "Layout"]);

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
      const c = (org[type] || {})[n];
      if (c) for (const [p, t] of Object.entries(c.files)) files.set(p, t);
    }
  }
  for (const [name, e] of objects) {
    files.set(`objects/${name}.object`, objectXml(org.CustomObject[name].files, [...e.fields], [...e.rules], e.parent));
  }
  const pkgTypes = Object.entries(members).map(([t, ns]) => `<types>${ns.map(m => `<members>${m}</members>`).join("")}<name>${t}</name></types>`).join("");
  files.set("package.xml", `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${pkgTypes}<version>67.0</version></Package>`);
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
  if (done && failC) {
    details += `<componentFailures><componentType>ApexClass</componentType><fileName>classes/InvoiceService.cls</fileName><fullName>InvoiceService</fullName><lineNumber>11</lineNumber><problem>Variable does not exist: InvoiceTax</problem><problemType>Error</problemType></componentFailures>`;
  }
  if (tests) {
    details += "<runTestResult>" + (done && failT
      ? "<failures><methodName>totals</methodName><name>InvoiceServiceTest</name><message>System.AssertException: Assertion Failed: Expected: 0, Actual: null</message><stackTrace>Class.InvoiceServiceTest.totals: line 4, column 1</stackTrace></failures><numFailures>1</numFailures>"
      : "<numFailures>0</numFailures>") +
      "<codeCoverage><name>InvoiceService</name><numLocations>10</numLocations><numLocationsNotCovered>1</numLocationsNotCovered></codeCoverage><numTestsRun>1</numTestsRun></runTestResult>";
  }
  return env(`<checkDeployStatusResponse><result><checkOnly>${d.checkOnly}</checkOnly><details>${details}</details><done>${done}</done><id>${d.id}</id>` +
    `<numberComponentErrors>${done && failC ? 1 : 0}</numberComponentErrors><numberComponentsDeployed>${done ? total - (failC ? 1 : 0) : Math.floor(total / 2)}</numberComponentsDeployed><numberComponentsTotal>${total}</numberComponentsTotal>` +
    `<numberTestErrors>${done && failT ? 1 : 0}</numberTestErrors><numberTestsCompleted>${done ? tests - (failT ? 1 : 0) : 0}</numberTestsCompleted><numberTestsTotal>${tests}</numberTestsTotal>` +
    `${done ? "" : "<stateDetail>Running tests in UAT…</stateDetail>"}<status>${status}</status><success>${success}</success></result></checkDeployStatusResponse>`);
}

// Returns true when the request was answered here.
export async function releaseSoap(raw, res) {
  const org = raw.includes(ORG2_SESSION) ? orgs.target : orgs.source;
  const send = xml => { res.writeHead(200, {"Content-Type": "text/xml; charset=utf-8", "Access-Control-Allow-Origin": "*"}); res.end(xml); };
  if (/<met:listMetadata>/.test(raw)) {
    const types = [...raw.matchAll(/<met:type>([^<]+)<\/met:type>/g)].map(m => m[1]);
    if (!types.some(t => RELEASE_TYPES.has(t)) && org === orgs.source) return false;
    const rows = types.flatMap(t => RELEASE_TYPES.has(t) ? listRows(org, t).map(r => ({...r, type: t})) : []);
    send(env("<listMetadataResponse>" + rows.map(r => `<result><createdByName>${r.by}</createdByName><createdDate>${r.at}</createdDate><fileName>x</fileName><fullName>${r.fullName}</fullName>` +
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
      failComponent: failMode === "component" || (files.has("classes/InvoiceService.cls") && !hasTax),
      failTest: failMode === "test" && testLevel !== "NoTestRun"};
    deploys.set(d.id, d);
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
    json(res, 200, {failMode, manual, target: Object.fromEntries(Object.entries(orgs.target).filter(([k]) => k !== "name").map(([k, v]) => [k, Object.keys(v)]))});
    return true;
  }
  if (/\/chatter\/users\/me\/?$/.test(url.pathname)) {
    json(res, 200, {username: isOrg2 ? "rakesh@demo.saralforce.uat" : "rakesh@demo.saralforce", name: "Rakesh Sharma"});
    return true;
  }
  const send = recs => { json(res, 200, {totalSize: recs.length, done: true, records: recs}); return true; };
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
  if (isOrg2 && /\/tooling\/sobjects\/FlowDefinition\//.test(url.pathname) && req.method === "PATCH") {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      manual.flowActive = (JSON.parse(raw || "{}").Metadata || {}).activeVersionNumber || manual.flowActive;
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
    if (/FROM FlowDefinitionView/i.test(q)) return send([{ApiName: "Invoice_Approval", IsActive: true}]);
    if (!isOrg2 && /ScheduledApex/.test(q)) return send([{ApexClass: {Name: "InvoiceReminderJob"}, CronTriggerId: "08eS00000000001AAA"}]);
    if (!isOrg2 && /FROM CronTrigger WHERE Id IN/i.test(q)) return send([{Id: "08eS00000000001AAA", CronExpression: "0 0 6 * * ?", CronJobDetail: {Name: "Invoice reminders"}}]);
    if (isOrg2 && /FROM User WHERE IsActive/i.test(q)) return send([{Id: "005U00000000001AAA", Username: "priya@demo.saralforce.uat"}, {Id: "005U00000000002AAA", Username: "rakesh@demo.saralforce.uat"}]);
    if (isOrg2 && /FROM PermissionSet WHERE Name IN/i.test(q)) return send(orgs.target.PermissionSet && orgs.target.PermissionSet.Invoice_Manager ? [{Id: "0PSU00000000001AAA", Name: "Invoice_Manager"}] : []);
    if (isOrg2 && /FROM PermissionSetAssignment/i.test(q)) return send(manual.psa);
    if (isOrg2 && /FROM FlowDefinition/i.test(q)) return send([{Id: "300U00000000001AAA", DeveloperName: "Invoice_Approval", LatestVersion: {VersionNumber: 3}, ActiveVersion: {VersionNumber: manual.flowActive}}]);
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
