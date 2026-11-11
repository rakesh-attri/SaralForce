// Release Center shared state. Lives for the page session (not in the
// sidebar snapshot: compare results hold whole files), so switching
// between Compare / Changes / Package / Deploy keeps the work.
import {listOrgs, loadCatalog} from "../shared/deploy-api.js";
import {putSession, getSession, pruneSessions} from "../shared/release-store.js";
import {githubConfig, readBranch} from "../shared/github.js";
import {componentsFromSource} from "../../core/source-format.js";
import {bytesToText} from "../../core/zip.js";
import {getEffectiveTimeZone} from "../../sf-time.js";
import {kickSfTzFetch} from "../shared/format.js";
import {whenInZone, daysAgoInZone, zoneMidnight, dateInZone} from "../../core/zone-date.js";

const ORGS_KEY = "sfoc_release_orgs";

function loadPicks() {
  try { return JSON.parse(localStorage.getItem(ORGS_KEY) || "{}"); } catch (e) { return {}; }
}

const picks = loadPicks();

const state = {
  orgs: null,          // [{host, name, isSandbox, isCurrent, conn, …}]
  orgsBusy: false,
  orgsError: "",
  sourceHost: picks.sourceHost || "",
  targetHost: picks.targetHost || "",
  compare: null,       // {sourceHost, targetHost, rows, sourceComps, edges, at, scope}
  compareOnly: null,   // keys handed over from Changes
  selected: new Set(), // compare row keys (deleted rows = destructive)
  deploy: null,        // running / finished deploy {phase, summary, error, …}
  validation: null     // last passed validation {id, targetHost, at, items}
};

const subs = new Set();

// ── Kept across minimize / maximize (same Salesforce page load) ──
const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const BOOT = params.get("hostBoot") || "";
const SESSION_ID = BOOT ? `release:${params.get("host") || ""}:${BOOT}` : "";
const PERSIST = ["compare", "compareOnly", "selected", "deploy", "validation", "pendingPlan", "releaseNotes", "gitBranch", "runbook", "deployFrom", "stepsAsked"];
let saveTimer = null;
let restoring = !!SESSION_ID;

function persistSoon() {
  if (!SESSION_ID || restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = {};
    for (const k of PERSIST) value[k] = state[k];
    putSession(SESSION_ID, value).catch(() => { /* storage full: work stays in memory */ });
  }, 300);
}

// Restore once per document, before anything new is computed.
export const sessionRestored = !SESSION_ID ? Promise.resolve(false) : getSession(SESSION_ID).then(value => {
  restoring = false;
  pruneSessions().catch(() => {});
  if (!value) return false;
  // Closed while still preparing (nothing sent to Salesforce yet): don't
  // restore it as running, or the Deploy screen would stay locked.
  if (value.deploy && !value.deploy.finished && !value.deploy.id) {
    value.deploy = {...value.deploy, finished: true, error: "Interrupted before it reached Salesforce (the panel was closed). Nothing was deployed; run it again."};
  }
  const patch = {};
  for (const k of PERSIST) if (value[k] != null && state[k] == null || (k === "selected" && value[k] && value[k].size)) patch[k] = value[k];
  if (Object.keys(patch).length) setRelease({...patch, restored: true});
  return true;
}).catch(() => { restoring = false; return false; });

export function releaseState() {
  return state;
}

export function setRelease(patch) {
  const p = typeof patch === "function" ? patch(state) : patch;
  Object.assign(state, p);
  if (PERSIST.some(k => k in p)) persistSoon();
  if ("sourceHost" in p || "targetHost" in p) {
    try { localStorage.setItem(ORGS_KEY, JSON.stringify({sourceHost: state.sourceHost, targetHost: state.targetHost})); } catch (e) { /* quota */ }
  }
  subs.forEach(f => f());
}

export function useRelease() {
  const [, force] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    subs.add(force);
    return () => { subs.delete(force); };
  }, []);
  return state;
}

export async function loadOrgs(refresh = false) {
  if (state.orgsBusy) return;
  setRelease({orgsBusy: true, orgsError: ""});
  try {
    const orgs = [...await listOrgs({refresh}), ...gitOrgs()];
    const current = orgs.find(o => o.isCurrent) || orgs[0];
    const has = host => orgs.some(o => o.host === host);
    const sourceHost = has(state.sourceHost) ? state.sourceHost : (current ? current.host : "");
    const other = orgs.find(o => o.host !== sourceHost && !o.isGit);
    const targetOk = has(state.targetHost) && state.targetHost !== sourceHost && !state.targetHost.startsWith("git:");
    const targetHost = targetOk ? state.targetHost : (other ? other.host : "");
    // Every metadata type the orgs can deploy (adds to the built-in list).
    await Promise.all(orgs.filter(o => o.conn && (o.host === sourceHost || o.host === targetHost)).map(o => loadCatalog(o.conn)));
    setRelease({orgs, orgsBusy: false, sourceHost, targetHost, catalogAt: Date.now()});
  } catch (e) {
    setRelease({orgsBusy: false, orgsError: e.message || String(e)});
  }
}

// The configured GitHub branch, usable as a source (compare, deploy).
function gitOrgs() {
  const cfg = githubConfig();
  if (!cfg) return [];
  const branch = state.gitBranch || cfg.branch;
  const git = {...cfg, branch};
  return [{host: `git:${cfg.repo}@${branch}`, name: `GitHub ${cfg.repo} (${branch})`, isGit: true, isSandbox: true, isCurrent: false, conn: null, git}];
}

// Use another branch of the repository as the source (feature, release…).
export async function setGitBranch(branch) {
  state.gitBranch = branch;
  const orgs = (state.orgs || []).filter(o => !o.isGit);
  const git = gitOrgs();
  setRelease({orgs: [...orgs, ...git], sourceHost: git[0] ? git[0].host : state.sourceHost, compare: null, selected: new Set()});
}

// Components on the GitHub branch (source format), cached per load.
const gitCache = new Map();
export async function gitComponents(org, onStatus, {fresh = false} = {}) {
  const key = org.host;
  if (!fresh && gitCache.has(key)) return gitCache.get(key);
  const {files} = await readBranch(org.git, {onStatus});
  const comps = componentsFromSource(files, bytesToText);
  gitCache.set(key, comps);
  return comps;
}

export function orgByHost(host) {
  return (state.orgs || []).find(o => o.host === host) || null;
}

export function orgLabel(org) {
  if (!org) return "—";
  if (org.isGit) return org.name;
  return `${org.name}${org.isSandbox ? " (sandbox)" : " (production)"}`;
}

export function downloadBytes(name, bytes, type = "application/zip") {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Dates follow the Salesforce user's time zone (as the rest of SaralForce).
export function orgZone() {
  kickSfTzFetch();
  return getEffectiveTimeZone();
}

// Some types list 1970 (or no date) for "unknown": show nothing then.
export function fmtWhen(iso) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1)) return "";
  return whenInZone(iso, orgZone());
}

// "YYYY-MM-DD" for today minus n days, in the org's zone.
export function orgDaysAgo(n) {
  return daysAgoInZone(n, orgZone());
}

// Start of a "YYYY-MM-DD" day in the org's zone (epoch ms).
export function orgDayStart(dateStr) {
  return zoneMidnight(dateStr, orgZone());
}

export function orgDate(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? dateInZone(ms, orgZone()) : "";
}
