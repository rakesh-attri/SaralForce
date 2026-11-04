// Release Center shared state. Lives for the page session (not in the
// sidebar snapshot: compare results hold whole files), so switching
// between Compare / Changes / Package / Deploy keeps the work.
import {listOrgs} from "../shared/deploy-api.js";
import {githubConfig, readBranch} from "../shared/github.js";
import {componentsFromSource} from "../../core/source-format.js";
import {bytesToText} from "../../core/zip.js";

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

export function releaseState() {
  return state;
}

export function setRelease(patch) {
  const p = typeof patch === "function" ? patch(state) : patch;
  Object.assign(state, p);
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
    setRelease({orgs, orgsBusy: false, sourceHost, targetHost});
  } catch (e) {
    setRelease({orgsBusy: false, orgsError: e.message || String(e)});
  }
}

// The configured GitHub branch, usable as a source (compare, deploy).
function gitOrgs() {
  const cfg = githubConfig();
  if (!cfg) return [];
  return [{host: `git:${cfg.repo}@${cfg.branch}`, name: `GitHub ${cfg.repo} (${cfg.branch})`, isGit: true, isSandbox: true, isCurrent: false, conn: null, git: cfg}];
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

export function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  const date = d.toLocaleDateString(undefined, {day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined});
  return days < 1 ? "today " + d.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"}) : date;
}
