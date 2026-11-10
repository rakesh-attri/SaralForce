// Manual steps: what the Metadata API does not do for you in a release,
// detected from what is being deployed. Pure; actions live in
// inspector/shared/manual-actions.js.
//
// ctx = {items: [keys], deletes: [keys], texts: Map(key → source text),
//        before: Map(key → target text before the deploy)}
import {splitKey, typeLabel} from "./deploy.js";

const names = (keys, type) => keys.filter(k => splitKey(k).type === type).map(k => splitKey(k).fullName);
const textOf = (ctx, key) => (ctx.texts && ctx.texts.get(key)) || "";
const tag = (xml, t) => ((new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml || "") || [])[1] || "");

// Each entry: id, phase ("pre" | "post"), auto (SaralForce can do it),
// setup (Setup path for the guided way), detect(ctx) → targets ([] = none).
export const STEP_CATALOG = [
  {
    id: "backup-data", phase: "pre", auto: false, setup: "",
    title: "Back up data before deleting fields or objects",
    why: "Deleting a field or object also deletes its data. Export it first (Export tab) in case you need it back.",
    detect: ctx => (ctx.deletes || []).filter(k => /^(CustomField|CustomObject):/.test(k)).map(k => splitKey(k).fullName)
  },
  {
    id: "enable-features", phase: "pre", auto: false, setup: "/lightning/setup/CompanyProfileInfo/home",
    title: "Turn on org features the code needs",
    why: "Some features are org settings, not metadata. The deploy fails if the target doesn't have them.",
    detect: ctx => {
      const found = new Set();
      for (const k of ctx.items || []) {
        const t = textOf(ctx, k);
        if (/\bCurrencyIsoCode\b/.test(t)) found.add("Multiple currencies (CurrencyIsoCode is used)");
        if (/\bIsPersonAccount\b|\bPersonContactId\b/.test(t)) found.add("Person accounts");
        if (/\bTerritory2\b/.test(t)) found.add("Enterprise Territory Management");
        if (/\bQuote\b.*__r|\bFROM\s+Quote\b/i.test(t)) found.add("Quotes");
      }
      return [...found];
    }
  },
  {
    id: "pause-jobs", phase: "pre", auto: true, setup: "/lightning/setup/ScheduledJobs/home",
    title: "Pause scheduled jobs of the classes you deploy",
    why: "Salesforce rejects a deploy of an Apex class that has scheduled jobs (unless “Allow deployments of components when corresponding Apex jobs are pending or in progress” is on in Deployment Settings). SaralForce stops those jobs in the target and lists their timing; “Schedule Apex jobs” after the deploy puts them back.",
    detect: ctx => names(ctx.items || [], "ApexClass").filter(n => /\bimplements\b[^{]*\bSchedulable\b/i.test(textOf(ctx, "ApexClass:" + n)))
  },
  {
    id: "flow-deactivate", phase: "pre", auto: true, setup: "/lightning/setup/Flows/home",
    title: "Deactivate flows you are deleting",
    why: "Salesforce can't delete a flow while a version is active or still in use (paused runs, queued scheduled paths, other metadata calling it). SaralForce deactivates them in the target; Deploy also checks what uses them before deleting.",
    detect: ctx => names(ctx.deletes || [], "Flow")
  },
  {
    id: "rule-users", phase: "pre", auto: false, setup: "/lightning/setup/Queues/home",
    title: "Create the users and queues these rules send work to",
    why: "Assignment, escalation and approval rules name users and queues. The deploy fails if the target doesn't have them; queues and users are not metadata here.",
    detect: ctx => ["AssignmentRules", "EscalationRules", "ApprovalProcess"].flatMap(t => names(ctx.items || [], t)
      .filter(n => { const x = textOf(ctx, t + ":" + n); return !x || /<(assignedTo|approver|queue)>/i.test(x); }).map(n => n + " (" + typeLabel(t) + ")"))
  },
  {
    id: "tab-launcher", phase: "post", auto: true, setup: "/lightning/setup/CustomTabs/home",
    title: "Make new tabs show in the App Launcher",
    why: "Salesforce applies tab visibility only after the tab is saved in the target. SaralForce saves each tab again for you.",
    detect: ctx => names(ctx.items || [], "CustomTab")
  },
  {
    id: "flow-activate", phase: "post", auto: true, setup: "/lightning/setup/Flows/home",
    title: "Activate deployed flows",
    why: "In production, flows arrive inactive unless “Deploy processes and flows as active” is on. SaralForce activates the latest version.",
    detect: ctx => names(ctx.items || [], "Flow")
  },
  {
    id: "permset-assign", phase: "post", auto: true, setup: "/lightning/setup/PermSets/home",
    title: "Assign permission sets to the same users",
    why: "Assignments are data, not metadata. SaralForce copies them from the source, matching users by username (sandbox suffix ignored).",
    detect: ctx => [...names(ctx.items || [], "PermissionSet"), ...names(ctx.items || [], "PermissionSetGroup").map(n => n + " (group)")]
  },
  {
    id: "group-members", phase: "post", auto: true, setup: "/lightning/setup/PublicGroups/home",
    title: "Add members to public groups and queues",
    why: "Group and queue members are data. SaralForce copies user members from the source.",
    detect: ctx => [...names(ctx.items || [], "Group"), ...names(ctx.items || [], "Queue")]
  },
  {
    id: "custom-settings", phase: "post", auto: true, setup: "/lightning/setup/CustomSettings/home",
    title: "Load custom setting values",
    why: "Custom settings deploy empty. SaralForce copies the org default, profile and user values from the source.",
    detect: ctx => names(ctx.items || [], "CustomObject").filter(n => /<customSettingsType>/.test(textOf(ctx, "CustomObject:" + n)))
  },
  {
    id: "schedule-jobs", phase: "post", auto: true, setup: "/lightning/setup/ScheduledJobs/home",
    title: "Schedule Apex jobs",
    why: "Scheduled jobs don't deploy. SaralForce schedules the same classes with the same timing as the source.",
    detect: ctx => names(ctx.items || [], "ApexClass").filter(n => /\bimplements\b[^{]*\bSchedulable\b/i.test(textOf(ctx, "ApexClass:" + n)))
  },
  {
    id: "flexipage-activate", phase: "post", auto: false, setup: "/lightning/setup/FlexiPageList/home",
    title: "Activate Lightning pages",
    why: "A new record page has to be activated (org default, app or profile) in Lightning App Builder before users see it.",
    detect: ctx => names(ctx.items || [], "FlexiPage")
  },
  {
    id: "sharing-recalc", phase: "post", auto: false, setup: "/lightning/setup/SecuritySharing/home",
    title: "Check sharing recalculation",
    why: "The sharing model changed. Salesforce recalculates sharing in the background; large objects can take a while.",
    detect: ctx => names(ctx.items || [], "CustomObject").filter(n => {
      const key = "CustomObject:" + n;
      const now = tag(textOf(ctx, key), "sharingModel");
      const was = tag(ctx.before && ctx.before.get(key), "sharingModel");
      return now && was && now !== was;
    })
  },
  {
    id: "secrets", phase: "post", auto: false, setup: "/lightning/setup/NamedCredential/home",
    title: "Enter secrets and passwords",
    why: "Passwords, client secrets and certificates are never deployed. Enter them in the target by hand.",
    detect: ctx => ["NamedCredential", "ExternalCredential", "ConnectedApp", "AuthProvider", "ExternalClientApplication", "ExternalDataSource"]
      .flatMap(t => names(ctx.items || [], t).map(n => `${typeLabel(t)} ${n}`))
  },
  {
    id: "org-wide-email", phase: "post", auto: false, setup: "/lightning/setup/OrgWideEmailAddresses/home",
    title: "Verify org-wide email addresses",
    why: "Code or flows send from an org-wide address; it must exist and be verified in the target.",
    detect: ctx => (ctx.items || []).filter(k => /OrgWideEmailAddress|setOrgWideEmailAddressId|<senderAddress>/.test(textOf(ctx, k))).map(k => splitKey(k).fullName)
  },
  {
    id: "email-deliverability", phase: "post", auto: false, setup: "/lightning/setup/OrgEmailSettings/home",
    title: "Check email deliverability",
    why: "Sandboxes start with “System email only”. Set Access level to “All email” to test email templates and alerts.",
    detect: ctx => names(ctx.items || [], "EmailTemplate").length ? ["Email templates in this release"] : []
  }
];

// Steps for a release: [{key, id, phase, title, why, targets, auto, setup, status}]
export function detectSteps(ctx) {
  const out = [];
  for (const s of STEP_CATALOG) {
    const targets = s.detect(ctx) || [];
    if (!targets.length) continue;
    out.push({key: s.id, id: s.id, phase: s.phase, title: s.title, why: s.why, targets, auto: s.auto, setup: s.setup, status: "todo", log: ""});
  }
  return out;
}

// Merge freshly detected steps with saved progress (keeps status, logs and
// steps the user or AI added).
export function mergeRunbook(saved, detected) {
  const byKey = new Map((saved || []).map(s => [s.key, s]));
  const out = detected.map(d => byKey.has(d.key) ? {...d, status: byKey.get(d.key).status, log: byKey.get(d.key).log, note: byKey.get(d.key).note} : d);
  for (const s of saved || []) if (!out.some(o => o.key === s.key) && (s.custom || s.id === "script")) out.push(s);
  return sortRunbook(out);
}

export function sortRunbook(steps) {
  const rank = s => (s.phase === "pre" ? 0 : 1);
  return steps.map((s, i) => ({s, i})).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s);
}

// "Before the deploy" steps not done or skipped yet.
export function pendingPreSteps(steps) {
  return (steps || []).filter(s => s.phase === "pre" && s.status !== "done" && s.status !== "skipped");
}

export function runbookProgress(steps) {
  const done = steps.filter(s => s.status === "done" || s.status === "skipped").length;
  return {done, total: steps.length};
}

// Username in another org of the same company: sandboxes add ".suffix".
export function baseUsername(u) {
  const s = String(u || "").toLowerCase();
  const at = s.indexOf("@");
  if (at < 0) return s;
  const domain = s.slice(at + 1);
  const parts = domain.split(".");
  // Strip a trailing sandbox suffix when the rest still looks like a domain.
  const tld = /^(com|org|net|io|co|in|edu|gov|uk|de|fr|au|ca|biz|info|us|eu|app|dev)$/;
  while (parts.length > 2 && !tld.test(parts[parts.length - 1])) parts.pop();
  return s.slice(0, at + 1) + parts.join(".");
}

// Text for the AI runbook prompt.
export function stepsForPrompt(steps, auditLines = []) {
  const lines = steps.map(s => `- [${s.phase}] ${s.title}: ${s.targets.join(", ")}`);
  if (auditLines.length) lines.push("", "Setup audit trail in the source since the last release:", ...auditLines.slice(0, 80).map(a => "- " + a));
  return lines.join("\n");
}

// AI reply → custom steps (guided).
export function stepsFromAi(list) {
  return (Array.isArray(list) ? list : []).filter(x => x && x.title).slice(0, 25).map((x, i) => ({
    key: "ai-" + i + "-" + String(x.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40),
    id: "ai", custom: true, phase: x.phase === "pre" ? "pre" : "post",
    title: String(x.title).slice(0, 140), why: String(x.detail || "").slice(0, 600),
    targets: [], auto: false, setup: /^\/lightning\/setup\//.test(x.setupPath || "") ? x.setupPath : "", status: "todo", log: ""
  }));
}
