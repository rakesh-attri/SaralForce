// Sandbox Manager (pure): sandboxes as rows from Tooling SandboxInfo +
// SandboxProcess, Salesforce's refresh intervals, login URLs, request bodies
// for create / clone / refresh, and the helpers behind backups and the
// post-refresh checklist. The calls live in inspector/shared/sandbox-api.js.

const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const DAY = 86400e3;
const t = s => (s ? Date.parse(String(s).replace(/\+0000$/, "Z")) || 0 : 0);

// License types: label, short tag and the minimum days between refreshes.
export const LICENSES = {
  "DEVELOPER": {label: "Developer", tag: "DEVELOPER", refreshDays: 1, tone: "info"},
  "DEVELOPER PRO": {label: "Developer Pro", tag: "DEV PRO", refreshDays: 1, tone: "violet"},
  "PARTIAL": {label: "Partial Copy", tag: "PARTIAL", refreshDays: 5, tone: "warn"},
  "FULL": {label: "Full Copy", tag: "FULL", refreshDays: 29, tone: "ok"},
};
export const licenseOf = l => LICENSES[String(l || "").toUpperCase()] || {label: l || "?", tag: String(l || "?").toUpperCase(), refreshDays: 1, tone: "info"};

// SandboxProcess.Status → a group for filters and a tone.
export function statusGroup(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "unknown";
  if (s === "completed") return "ready";
  if (s === "pending activation") return "activation";
  if (/delet|discard/.test(s)) return "deleted";
  if (/stop|fail|error|suspend|lock/.test(s)) return "problem";
  return "processing"; // Pending, Processing, Activating, Sampling, Copying, …
}
export const STATUS_GROUPS = {
  ready: {label: "Ready", tone: "ok"}, processing: {label: "Processing", tone: "info"}, activation: {label: "Pending activation", tone: "warn"},
  deleted: {label: "Deleted", tone: "off"}, problem: {label: "Problem", tone: "err"}, unknown: {label: "Unknown", tone: "off"},
};

// Sandbox name rules: 1–10 letters and digits, starting with a letter.
export function sandboxNameError(name, existing = []) {
  const n = String(name || "").trim();
  if (!n) return "Give the sandbox a name.";
  if (!/^[A-Za-z]/.test(n)) return "The name must start with a letter.";
  if (!/^[A-Za-z0-9]+$/.test(n)) return "Only letters and digits: no spaces, dashes or underscores.";
  if (n.length > 10) return "10 characters at most.";
  if (asList(existing).some(e => String(e).toLowerCase() === n.toLowerCase())) return "A sandbox with this name already exists.";
  return null;
}

// One row per sandbox: its settings, its latest process and its history.
export function mergeSandboxes(infos, processes) {
  const byInfo = new Map();
  for (const p of asList(processes)) {
    const k = p.SandboxInfoId;
    if (!k) continue;
    (byInfo.get(k) || byInfo.set(k, []).get(k)).push(p);
  }
  const when = p => t(p.StartDate) || t(p.CreatedDate) || t(p.EndDate);
  return asList(infos).map(i => {
    const hist = (byInfo.get(i.Id) || []).slice().sort((a, b) => when(b) - when(a));
    const p = hist[0] || null;
    // The copy in use: the newest completed refresh (one still copying or
    // waiting for activation hasn't replaced it yet).
    const live = hist.find(x => statusGroup(x.Status) === "ready");
    const lastRefresh = live ? (t(live.ActivatedDate) || t(live.EndDate) || t(live.StartDate)) : t(i.CreatedDate);
    return {
      id: i.Id, name: i.SandboxName, license: String(i.LicenseType || "").toUpperCase(), description: i.Description || "",
      autoActivate: !!i.AutoActivate, apexClassId: i.ApexClassId || null, groupId: i.ActivationUserGroupId || null,
      sourceId: i.SourceId || null, templateId: i.TemplateId || null, historyDays: i.HistoryDays == null ? null : i.HistoryDays,
      copyChatter: !!i.CopyChatter, created: t(i.CreatedDate),
      process: p ? {id: p.Id, status: p.Status || "", group: statusGroup(p.Status), progress: p.CopyProgress == null ? null : Number(p.CopyProgress),
        started: t(p.StartDate), ended: t(p.EndDate), activated: t(p.ActivatedDate), orgId: p.SandboxOrganization || null,
        description: p.Description || ""} : null,
      history: hist.map(x => ({id: x.Id, status: x.Status, started: t(x.StartDate), ended: t(x.EndDate), activated: t(x.ActivatedDate), progress: x.CopyProgress})),
      lastRefresh,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export const ageDays = (row, now = Date.now()) => (row.lastRefresh ? Math.floor((now - row.lastRefresh) / DAY) : null);
export const ageTone = days => (days == null ? "off" : days > 90 ? "err" : days > 30 ? "warn" : "ok");

export function staleRows(rows, {days = 30, now = Date.now()} = {}) {
  return asList(rows).filter(r => r.process && r.process.group === "ready" && ageDays(r, now) > days);
}

// When Salesforce lets this sandbox be refreshed again.
export function nextRefresh(row, now = Date.now()) {
  const last = row.process ? (row.process.started || row.lastRefresh) : row.created;
  const at = last ? last + licenseOf(row.license).refreshDays * DAY : 0;
  return {at, allowed: !at || at <= now, days: licenseOf(row.license).refreshDays};
}

export function statsOf(rows) {
  const s = {total: 0, DEVELOPER: 0, "DEVELOPER PRO": 0, PARTIAL: 0, FULL: 0, processing: 0, activation: 0};
  for (const r of asList(rows)) {
    if (r.process && r.process.group === "deleted") continue;
    s.total++;
    if (s[r.license] != null) s[r.license]++;
    if (r.process && r.process.group === "processing") s.processing++;
    if (r.process && r.process.group === "activation") s.activation++;
  }
  return s;
}

// "acme.my.salesforce.com" / "acme.lightning.force.com" → "acme".
export function myDomainOf(host) {
  const h = String(host || "").toLowerCase();
  const m = /^([a-z0-9-]+?)(?:--[a-z0-9]+)?\.(?:my\.salesforce\.com|lightning\.force\.com|my\.site\.com|sandbox\.my\.salesforce\.com)/.exec(h);
  return m ? m[1] : "";
}

// Login URL of a sandbox: enhanced domains or test.salesforce.com.
export function loginUrl(row, {style = "enhanced", prodHost = ""} = {}) {
  const dom = myDomainOf(prodHost);
  if (style === "enhanced" && dom) return `https://${dom}--${String(row.name).toLowerCase()}.sandbox.my.salesforce.com`;
  return "https://test.salesforce.com";
}
export const sandboxHost = (row, prodHost) => {
  const dom = myDomainOf(prodHost);
  return dom ? `${dom}--${String(row.name).toLowerCase()}.sandbox.my.salesforce.com` : "";
};

// Request bodies. form: {name, license, description, autoActivate, apexClassId,
// groupId, templateId, historyDays, copyChatter, sourceId}.
export function sandboxBody(form, mode = "create") {
  const f = form || {};
  const lic = String(f.license || "DEVELOPER").toUpperCase();
  const b = {
    AutoActivate: !!f.autoActivate,
    Description: String(f.description || "").slice(0, 1000),
    ApexClassId: f.apexClassId || null,
    ActivationUserGroupId: f.groupId || null,
  };
  if (mode !== "refresh") b.SandboxName = String(f.name || "").trim();
  if (mode === "clone") {
    b.SourceId = f.sourceId;
  } else {
    b.LicenseType = lic;
    if (lic === "PARTIAL" || lic === "FULL") b.TemplateId = f.templateId || null;
    if (lic === "FULL") {
      b.HistoryDays = f.historyDays == null || f.historyDays === "" ? 0 : Number(f.historyDays);
      b.CopyChatter = !!f.copyChatter;
    }
  }
  return b;
}

// ── Post-refresh helpers ─────────────────────────────────────────────
export const stripInvalid = email => String(email || "").replace(/\.invalid$/i, "");
export const isInvalidEmail = email => /\.invalid$/i.test(String(email || ""));

// Does an endpoint look like production? Uses the production My Domain and
// common naming. → "prod" | "sandbox" | "unknown".
export function endpointKind(url, {prodHost = ""} = {}) {
  let host = "";
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (e) { host = String(url || "").toLowerCase(); }
  if (!host) return "unknown";
  if (/(^|[.-])(sandbox|sbx|test|uat|qa|dev|stag(e|ing)|preprod|sit|demo|mock|localhost)([.-]|$)|--/.test(host)) return "sandbox";
  const dom = myDomainOf(prodHost);
  if (dom && host.startsWith(dom + ".")) return "prod";
  if (/(^|[.-])(prod|production|live|api|www)([.-]|$)/.test(host)) return "prod";
  return "unknown";
}

// Why an active flow could reach real people or systems from a sandbox.
export function flowOutsideReasons(meta) {
  const reasons = [];
  for (const a of asList(meta && meta.actionCalls)) {
    const tpe = String(a.actionType || "").toLowerCase();
    if (tpe === "emailalert") reasons.push(`email alert "${a.label || a.actionName}"`);
    else if (tpe === "emailsimple" || tpe === "email") reasons.push(`sends email "${a.label || a.actionName}"`);
    else if (tpe === "externalservice") reasons.push(`calls an outside service "${a.label || a.actionName}"`);
    else if (tpe === "apex") reasons.push(`runs Apex ${String(a.actionName || "").split(".")[0]} (may call out)`);
    else if (/chatter|slack|sms|notification|customnotification/.test(tpe)) reasons.push(`sends a ${tpe.replace(/action$/, "")} "${a.label || a.actionName}"`);
  }
  if ((meta && meta.start && meta.start.schedule) || (meta && meta.processType === "AutoLaunchedFlow" && meta.start && meta.start.triggerType === "Scheduled")) {
    if (reasons.length) reasons.push("runs on a schedule");
  }
  return [...new Set(reasons)];
}

// ── Data restore ─────────────────────────────────────────────────────
// objects: [{name, refs: [{field, to: [objectNames]}]}] → names, parents first
// (only references between the restored objects count; cycles are broken).
export function restoreOrder(objects) {
  const list = asList(objects);
  const names = new Set(list.map(o => o.name));
  const deps = new Map(list.map(o => [o.name, new Set(asList(o.refs).flatMap(r => asList(r.to)).filter(n => names.has(n) && n !== o.name))]));
  const out = [];
  const state = new Map();
  const visit = n => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) return; // cycle: the later object's lookup is left out of the first pass
    state.set(n, 1);
    for (const d of deps.get(n) || []) visit(d);
    state.set(n, 2);
    out.push(n);
  };
  for (const o of list) visit(o.name);
  return out;
}

// One record for insert: only createable fields, lookups to restored records
// pointed at their new ids, lookups to records not restored kept as they were.
export function restoreRecord(row, {fields, refs, idMap}) {
  const rec = {};
  const refField = new Map(asList(refs).map(r => [r.field, r]));
  for (const f of asList(fields)) {
    if (!(f in row)) continue;
    let v = row[f];
    if (v === "" || v == null) continue;
    if (refField.has(f)) v = (idMap && idMap.get(v)) || v;
    rec[f] = v;
  }
  return rec;
}

// Old → new ids from an insert's results (same order as the rows sent).
export function addIds(idMap, rows, results) {
  asList(results).forEach((r, i) => {
    const old = rows[i] && rows[i].Id;
    if (old && r && r.success && r.id) idMap.set(old, r.id);
  });
  return idMap;
}
