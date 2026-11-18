// Mock production org (127.0.0.3, session FAKE_SESSION_PROD) for SandShift →
// Sandboxes, plus what backups / the post-refresh checklist need in any mock
// org: Bulk API query jobs, composite inserts / updates and anonymous Apex.
const PROD_SESSION = "FAKE_SESSION_PROD";
const iso = ms => new Date(ms).toISOString().replace("Z", "+0000");
const DAY = 86400e3;

let seq = 10;
let infos;
let procs;
function reset() {
  const now = Date.now();
  infos = [
    {Id: "0GQ000000000001AAA", SandboxName: "Dev", LicenseType: "PARTIAL", Description: "Shared dev + test data", AutoActivate: false, ApexClassId: null,
      ActivationUserGroupId: null, SourceId: null, TemplateId: null, HistoryDays: null, CopyChatter: false, CreatedDate: iso(now - 200 * DAY)},
    {Id: "0GQ000000000002AAA", SandboxName: "NxtPayDev", LicenseType: "DEVELOPER", Description: "", AutoActivate: true, CreatedDate: iso(now - 300 * DAY)},
    {Id: "0GQ000000000003AAA", SandboxName: "UAT", LicenseType: "FULL", Description: "User acceptance testing", AutoActivate: false, HistoryDays: 30,
      CopyChatter: false, CreatedDate: iso(now - 400 * DAY)},
    {Id: "0GQ000000000004AAA", SandboxName: "QA", LicenseType: "DEVELOPER PRO", Description: "QA automation", AutoActivate: true, CreatedDate: iso(now - 90 * DAY)},
  ];
  procs = [
    {Id: "0GR000000000001AAA", SandboxInfoId: infos[0].Id, Status: "Completed", CopyProgress: 100, StartDate: iso(now - 49 * DAY), EndDate: iso(now - 48.6 * DAY),
      ActivatedDate: iso(now - 48 * DAY), SandboxOrganization: "00D5g000000DemoAAA", CreatedDate: iso(now - 49 * DAY)},
    {Id: "0GR000000000002AAA", SandboxInfoId: infos[1].Id, Status: "Completed", CopyProgress: 100, StartDate: iso(now - 54 * DAY), EndDate: iso(now - 54 * DAY),
      ActivatedDate: iso(now - 54 * DAY), SandboxOrganization: "00D5g000000NxtpAAA", CreatedDate: iso(now - 54 * DAY)},
    {Id: "0GR000000000003AAA", SandboxInfoId: infos[2].Id, Status: "Completed", CopyProgress: 100, StartDate: iso(now - 120 * DAY), EndDate: iso(now - 118 * DAY),
      ActivatedDate: iso(now - 118 * DAY), SandboxOrganization: "00D5g000000UatAAA", CreatedDate: iso(now - 120 * DAY)},
    {Id: "0GR000000000004AAA", SandboxInfoId: infos[2].Id, Status: "Pending Activation", CopyProgress: 100, StartDate: iso(now - 2 * DAY), EndDate: iso(now - 0.3 * DAY),
      SandboxOrganization: "00D5g000000UatAAA", CreatedDate: iso(now - 2 * DAY)},
    {Id: "0GR000000000005AAA", SandboxInfoId: infos[3].Id, Status: "Processing", CopyProgress: 40, StartDate: iso(now - 0.05 * DAY),
      SandboxOrganization: null, CreatedDate: iso(now - 0.05 * DAY)},
  ];
}
reset();

// Running copies move on each time the list is read.
function tick() {
  for (const p of procs) {
    if (p.Status !== "Processing") continue;
    p.CopyProgress = Math.min(100, (p.CopyProgress || 0) + 30);
    if (p.CopyProgress >= 100) {
      const info = infos.find(i => i.Id === p.SandboxInfoId) || {};
      p.EndDate = iso(Date.now());
      if (info.AutoActivate) { p.Status = "Completed"; p.ActivatedDate = iso(Date.now()); } else p.Status = "Pending Activation";
    }
  }
}

const newProc = info => {
  const p = {Id: "0GR0000000000" + String(++seq).padStart(2, "0") + "AAA", SandboxInfoId: info.Id, Status: "Processing", CopyProgress: 0,
    StartDate: iso(Date.now()), SandboxOrganization: null, CreatedDate: iso(Date.now())};
  procs.unshift(p);
  return p;
};

function body(req) {
  return new Promise(resolve => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

const bulkJobs = new Map();

export function sandboxRest(req, res, url, json, {soqlResult}) {
  const p = url.pathname;
  const auth = String(req.headers.authorization || "");
  const isProd = auth.includes(PROD_SESSION);
  const send = records => json(res, 200, {totalSize: records.length, done: true, records});

  // ── Any org: Bulk API 2.0 query jobs (backups) ──
  if (/\/jobs\/query\/?$/.test(p) && req.method === "POST") {
    body(req).then(b => {
      const id = "750" + String(++seq).padStart(15, "0");
      bulkJobs.set(id, {soql: b.query || "", tooling: false});
      json(res, 200, {id, state: "UploadComplete", operation: "query"});
    });
    return true;
  }
  const jobRes = /\/jobs\/query\/([^/]+)(\/results)?\/?$/.exec(p);
  if (jobRes && req.method === "GET") {
    const job = bulkJobs.get(jobRes[1]);
    if (!job) return json(res, 404, [{errorCode: "NOT_FOUND", message: "No such job"}]) || true;
    const records = (soqlResult(job.soql, false).records || []);
    if (!jobRes[2]) { json(res, 200, {id: jobRes[1], state: "JobComplete", numberRecordsProcessed: records.length}); return true; }
    const fields = (/select\s+([\s\S]+?)\s+from/i.exec(job.soql) || [])[1].split(",").map(s => s.trim());
    const cell = v => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, "\"\"")}"` : String(v));
    const csv = [fields.join(","), ...records.map(r => fields.map(f => cell(r[f])).join(","))].join("\n") + "\n";
    res.writeHead(200, {"Content-Type": "text/csv", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Sforce-Locator", "Sforce-Locator": "null"});
    res.end(csv);
    return true;
  }
  // ── Any org: composite inserts / updates (restore, .invalid fixes) ──
  if (/\/composite\/sobjects\/?$/.test(p) && (req.method === "POST" || req.method === "PATCH") && !auth.includes("FAKE_SESSION_2")) {
    body(req).then(b => json(res, 200, (b.records || []).map(r => (req.method === "POST"
      ? {id: (String((r.attributes || {}).type || "a00").slice(0, 3).replace(/[^A-Za-z0-9]/g, "0") + String(++seq).padStart(12, "0") + "AAA"), success: true, errors: []}
      : {id: r.Id, success: true, errors: []}))));
    return true;
  }
  // ── Any org: anonymous Apex (deliverability check, aborting jobs) ──
  if (/\/tooling\/executeAnonymous\/?$/.test(p) && !auth.includes("FAKE_SESSION_2")) {
    const code = url.searchParams.get("anonymousBody") || "";
    if (/reserveSingleEmailCapacity/.test(code)) {
      json(res, 200, {compiled: true, success: false, compileProblem: null,
        exceptionMessage: "System.NoAccessException: The organization is not permitted to send email (NO_MASS_MAIL_PERMISSION)", line: 1, column: 1});
      return true;
    }
    json(res, 200, {compiled: true, success: true, compileProblem: null, exceptionMessage: null, line: -1, column: -1});
    return true;
  }
  if (!isProd) return false;

  // ── Production org ──
  if (p === "/services/oauth2/userinfo") {
    json(res, 200, {user_id: "005P00000000001AAA", organization_id: "00D5g000000ProdAAA", name: "Rakesh Sharma", preferred_username: "rakesh@saralforce.prod"});
    return true;
  }
  const q = url.searchParams.get("q") || "";
  if (/\/(query|queryAll)\/?$/.test(p)) {
    if (/FROM Organization/i.test(q)) {
      send([{attributes: {type: "Organization"}, Id: "00D5g000000ProdAAA", Name: "SaralForce Production", IsSandbox: false, OrganizationType: "Enterprise Edition", InstanceName: "NA200"}]);
    } else if (/FROM SandboxInfo/i.test(q)) {
      send(infos);
    } else if (/FROM SandboxProcess/i.test(q)) {
      tick();
      send(procs);
    } else if (/FROM Group WHERE Type = 'Regular'/i.test(q)) {
      send([{Id: "00GP00000000001AAA", Name: "Project Team", DeveloperName: "Project_Team"}, {Id: "00GP00000000002AAA", Name: "QA Testers", DeveloperName: "QA_Testers"}]);
    } else if (/FROM AsyncApexJob/i.test(q)) {
      send([{ApexClass: {Name: "InvoiceReminderJob"}, CronTriggerId: "08eP00000000001AAA"}]);
    } else if (/FROM CronTrigger/i.test(q)) {
      send([{Id: "08eP00000000001AAA", CronExpression: "0 0 6 * * ?", CronJobDetail: {Name: "Invoice reminders"}}]);
    } else if (/FROM ApexClass/i.test(q)) {
      send([{Id: "01pP00000000001AAA", Name: "SandboxSetup", Body: "global class SandboxSetup implements SandboxPostCopy { global void runApexClass(SandboxContext c) {} }"}]);
    } else send([]);
    return true;
  }
  if (/\/search\/?$/.test(p)) { json(res, 200, {searchRecords: [{attributes: {type: "ApexClass"}, Id: "01pP00000000001AAA", Name: "SandboxSetup"}]}); return true; }
  if (/\/tooling\/sobjects\/SandboxInfo\/?$/.test(p) && req.method === "POST") {
    body(req).then(b => {
      if (infos.some(i => i.SandboxName.toLowerCase() === String(b.SandboxName || "").toLowerCase())) {
        json(res, 400, [{errorCode: "DUPLICATE_VALUE", message: "A sandbox with this name already exists."}]);
        return;
      }
      const src = b.SourceId && infos.find(i => i.Id === b.SourceId);
      const info = {Id: "0GQ0000000000" + String(++seq).padStart(2, "0") + "AAA", SandboxName: b.SandboxName, LicenseType: src ? src.LicenseType : b.LicenseType,
        Description: b.Description || "", AutoActivate: !!b.AutoActivate, ApexClassId: b.ApexClassId || null, ActivationUserGroupId: b.ActivationUserGroupId || null,
        SourceId: b.SourceId || null, TemplateId: b.TemplateId || null, HistoryDays: b.HistoryDays == null ? null : b.HistoryDays, CopyChatter: !!b.CopyChatter, CreatedDate: iso(Date.now())};
      infos.push(info);
      newProc(info);
      json(res, 201, {id: info.Id, success: true, errors: []});
    });
    return true;
  }
  const one = /\/tooling\/sobjects\/(SandboxInfo|SandboxProcess)\/([^/]+)\/?$/.exec(p);
  if (one) {
    const [, type, id] = one;
    if (type === "SandboxInfo" && req.method === "PATCH") {
      body(req).then(b => {
        const info = infos.find(i => i.Id === id);
        if (!info) { json(res, 404, [{errorCode: "NOT_FOUND", message: "No such sandbox"}]); return; }
        Object.assign(info, {AutoActivate: !!b.AutoActivate, Description: b.Description != null ? b.Description : info.Description, ApexClassId: b.ApexClassId || null,
          ActivationUserGroupId: b.ActivationUserGroupId || null});
        newProc(info);
        res.writeHead(204, {"Access-Control-Allow-Origin": "*"});
        res.end();
      });
      return true;
    }
    if (type === "SandboxInfo" && req.method === "DELETE") {
      const info = infos.find(i => i.Id === id);
      if (info) procs.unshift({Id: "0GR0000000000" + String(++seq).padStart(2, "0") + "AAA", SandboxInfoId: id, Status: "Deleted", StartDate: iso(Date.now()), CreatedDate: iso(Date.now())});
      res.writeHead(204, {"Access-Control-Allow-Origin": "*"});
      res.end();
      return true;
    }
    if (type === "SandboxProcess" && req.method === "PATCH") {
      body(req).then(b => {
        const pr = procs.find(x => x.Id === id);
        if (!pr || pr.Status !== "Pending Activation") { json(res, 400, [{errorCode: "INVALID_STATUS", message: "Only a sandbox pending activation can be activated or discarded."}]); return; }
        if (b.RefreshAction === "ACTIVATE") { pr.Status = "Completed"; pr.ActivatedDate = iso(Date.now()); }
        else if (b.RefreshAction === "DISCARD") { pr.Status = "Discarded"; }
        res.writeHead(204, {"Access-Control-Allow-Origin": "*"});
        res.end();
      });
      return true;
    }
  }
  json(res, 200, {totalSize: 0, done: true, records: []});
  return true;
}

export function resetSandboxes() { reset(); bulkJobs.clear(); }

// Post-refresh findings in the demo org: jobs, endpoints, a .invalid user.
export function addSandboxChecklistMock(tables) {
  const now = Date.now();
  tables.crontrigger = [
    {Id: "08e000000000001AAA", CronJobDetail: {Name: "Invoice reminders", JobType: "7"}, CronExpression: "0 0 6 * * ?", NextFireTime: iso(now + 0.5 * DAY), State: "WAITING"},
    {Id: "08e000000000002AAA", CronJobDetail: {Name: "ERP nightly sync", JobType: "7"}, CronExpression: "0 30 1 * * ?", NextFireTime: iso(now + 0.6 * DAY), State: "WAITING"},
  ];
  tables.namedcredential = [{Id: "0XA000000000001AAA", DeveloperName: "Payment_Gateway", MasterLabel: "Payment Gateway", Endpoint: "https://api.payments.com/v2"},
    {Id: "0XA000000000002AAA", DeveloperName: "Tax_Service", MasterLabel: "Tax Service", Endpoint: "https://sandbox.taxes.example.com"}];
  tables.remoteproxy = [{Id: "0rp000000000001AAA", SiteName: "ERP", EndpointUrl: "https://erp.acme-prod.com", IsActive: true}];
  (tables.user || []).push({Id: "005dN00000EINT1AAA", Name: "Integration User", Username: "integration@demo.saralforce", Email: "integration@demo.example.invalid",
    Alias: "integ", IsActive: true, ProfileId: "00e000000000001AAA", Profile: {Name: "System Administrator"}, UserType: "Standard"});
}
