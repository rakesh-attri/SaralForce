// GitHub (optional): commit releases and snapshots in Salesforce DX source
// format, and read a branch as a deploy source. Uses the Git Data API with a
// personal access token kept in this browser's extension storage.
import {getSetting, setSetting} from "../../core/storage.js";
import {bytesToBase64, base64ToBytes, textToBytes, bytesToText} from "../../core/zip.js";
import {mergeParentXml} from "../../core/deploy.js";

// Branch names in URLs keep their slashes (release/v3).
const refPath = b => String(b).split("/").map(encodeURIComponent).join("/");

const API = "https://api.github.com";
export const GITHUB_ORIGIN = "https://api.github.com/*";

export function githubConfig() {
  const c = getSetting("githubConfig", null);
  return c && c.token && c.repo ? {branch: "main", base: "force-app/main/default", ...c} : null;
}

export function saveGithubConfig(c) {
  setSetting("githubConfig", c);
}

async function gh(cfg, path, {method = "GET", body} = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: "Bearer " + cfg.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? {"Content-Type": "application/json"} : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error("Could not reach GitHub (" + (e.message || e) + ")");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || ("HTTP " + res.status);
    const limited = rateLimitMessage(res.status, name => res.headers && res.headers.get(name));
    const err = new Error(limited ? limited : res.status === 401 ? "GitHub rejected the token (expired or wrong)." :
      res.status === 404 ? `Not found on GitHub: check the repository name and that the token can see it (${msg}).` : "GitHub: " + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// GitHub's rate limits answer 403 or 429 with x-ratelimit-remaining: 0 (the
// hourly quota) or a retry-after header (too many requests at once).
// header: name → value. Returns the message to show, or "" for other errors.
export function rateLimitMessage(status, header, now = Date.now()) {
  if (status !== 403 && status !== 429) return "";
  const retryAfter = Number(header("retry-after"));
  const reset = Number(header("x-ratelimit-reset"));
  const out = header("x-ratelimit-remaining") === "0";
  if (!out && !(retryAfter > 0)) return "";
  let when = "";
  if (retryAfter > 0) when = `Try again in ${retryAfter < 90 ? Math.ceil(retryAfter) + " second(s)" : Math.ceil(retryAfter / 60) + " minute(s)"}.`;
  else if (reset > 0) {
    const mins = Math.max(1, Math.ceil((reset * 1000 - now) / 60000));
    when = `The limit resets at ${new Date(reset * 1000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})} (in about ${mins} minute(s)).`;
  }
  return ("GitHub rate limit reached: too many requests for this token. " + (when || "Try again in a few minutes.")).trim();
}

// A recursive tree listing GitHub cut short (very large repositories).
const TRUNCATED_WRITE = "This repository is too large for GitHub to list in one request, so SaralForce cannot safely work out what to merge or delete. " +
  "Nothing was committed. Commit with Git instead, or use a smaller repository.";

// Checks the token and repo; returns {fullName, defaultBranch, canPush, private}.
export async function testGithub(cfg) {
  const r = await gh(cfg, `/repos/${cfg.repo}`);
  return {fullName: r.full_name, defaultBranch: r.default_branch, canPush: !!(r.permissions && r.permissions.push), private: !!r.private};
}

export async function listBranches(cfg) {
  // 100 a page; stop at the first short page (at most 2,000 branches).
  const names = [];
  for (let page = 1; page <= 20; page++) {
    const list = (await gh(cfg, `/repos/${cfg.repo}/branches?per_page=100&page=${page}`)) || [];
    names.push(...list.map(b => b.name));
    if (list.length < 100) break;
  }
  return names;
}

async function branchSha(cfg, branch, {create = false, from = ""} = {}) {
  try {
    const ref = await gh(cfg, `/repos/${cfg.repo}/git/ref/heads/${refPath(branch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.status !== 404 || !create) throw e;
    const base = from || (await gh(cfg, `/repos/${cfg.repo}`)).default_branch;
    const ref = await gh(cfg, `/repos/${cfg.repo}/git/ref/heads/${refPath(base)}`);
    await gh(cfg, `/repos/${cfg.repo}/git/refs`, {method: "POST", body: {ref: "refs/heads/" + branch, sha: ref.object.sha}});
    return ref.object.sha;
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// files: Map(path → string | Uint8Array). Returns {sha, url, files}.
// deletePaths: files to remove (only those that exist). mergeLabels: merge a
// CustomLabels file with the branch's own instead of replacing it.
export async function commitFiles(cfg, files, message, {branch, from, onStatus = () => {}, deletePaths = [], mergeLabels = true} = {}) {
  const br = branch || cfg.branch;
  onStatus(`Reading ${cfg.repo}@${br}…`);
  const head = await branchSha(cfg, br, {create: true, from});
  const commit = await gh(cfg, `/repos/${cfg.repo}/git/commits/${head}`);
  const labelsPath = [...files.keys()].find(p => /labels\/CustomLabels\.labels-meta\.xml$/.test(p));
  let existing = null;
  if ((labelsPath && mergeLabels) || deletePaths.length) {
    const full = await gh(cfg, `/repos/${cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`);
    // An incomplete listing would skip the label merge and the deletes silently.
    if (full.truncated) throw new Error(TRUNCATED_WRITE);
    existing = new Map((full.tree || []).filter(e => e.type === "blob").map(e => [e.path, e.sha]));
  }
  if (labelsPath && mergeLabels && existing && existing.has(labelsPath)) {
    const old = await gh(cfg, `/repos/${cfg.repo}/git/blobs/${existing.get(labelsPath)}`);
    const cur = files.get(labelsPath);
    files = new Map(files);
    files.set(labelsPath, mergeParentXml(bytesToText(base64ToBytes(old.content || "")), typeof cur === "string" ? cur : bytesToText(cur), {laterWins: true}));
  }
  const list = [...files.entries()];
  let done = 0;
  const tree = await pool(list, 4, async ([path, data]) => {
    const bytes = typeof data === "string" ? textToBytes(data) : data;
    const blob = await gh(cfg, `/repos/${cfg.repo}/git/blobs`, {method: "POST", body: {content: bytesToBase64(bytes), encoding: "base64"}});
    onStatus(`Uploading files… ${++done}/${list.length}`);
    return {path, mode: "100644", type: "blob", sha: blob.sha};
  });
  for (const p of deletePaths) if (existing && existing.has(p) && !files.has(p)) tree.push({path: p, mode: "100644", type: "blob", sha: null});
  onStatus("Committing…");
  const newTree = await gh(cfg, `/repos/${cfg.repo}/git/trees`, {method: "POST", body: {base_tree: commit.tree.sha, tree}});
  if (newTree.sha === commit.tree.sha) return {sha: head, url: `https://github.com/${cfg.repo}/commit/${head}`, files: list.length, unchanged: true};
  const created = await gh(cfg, `/repos/${cfg.repo}/git/commits`, {method: "POST", body: {message, tree: newTree.sha, parents: [head]}});
  try {
    await gh(cfg, `/repos/${cfg.repo}/git/refs/heads/${refPath(br)}`, {method: "PATCH", body: {sha: created.sha}});
  } catch (e) {
    // Someone pushed to the branch between reading it and moving it.
    if (e.status !== 422 || !/fast[- ]forward/i.test(e.message || "")) throw e;
    const err = new Error(`${br} changed on GitHub while SaralForce was committing (someone else pushed). Nothing was overwritten: try again.`);
    err.status = 422;
    throw err;
  }
  return {sha: created.sha, url: created.html_url || `https://github.com/${cfg.repo}/commit/${created.sha}`, files: list.length};
}

// Files under cfg.base on a branch: {files: Map(relativePath → Uint8Array),
// sha, truncated, forceignore}. truncated: GitHub cut the listing short, files
// are missing. forceignore: the repository root's .forceignore text ("" if none).
export async function readBranch(cfg, {branch, onStatus = () => {}, maxFiles = 4000} = {}) {
  const br = branch || cfg.branch;
  onStatus(`Reading ${cfg.repo}@${br}…`);
  const head = await branchSha(cfg, br);
  const commit = await gh(cfg, `/repos/${cfg.repo}/git/commits/${head}`);
  const tree = await gh(cfg, `/repos/${cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const base = String(cfg.base || "").replace(/^\/+|\/+$/g, "");
  const prefix = base ? base + "/" : "";
  const blobs = (tree.tree || []).filter(e => e.type === "blob" && e.path.startsWith(prefix));
  if (blobs.length > maxFiles) throw new Error(`${blobs.length} files under ${base || "the repository root"}: too many to read at once. Point the folder at a smaller part of the repository.`);
  let done = 0;
  const files = new Map();
  await pool(blobs, 6, async e => {
    const b = await gh(cfg, `/repos/${cfg.repo}/git/blobs/${e.sha}`);
    files.set(e.path.slice(prefix.length), base64ToBytes(b.content || ""));
    onStatus(`Reading files… ${++done}/${blobs.length}`);
  });
  const ignoreEntry = (tree.tree || []).find(e => e.type === "blob" && e.path === ".forceignore");
  let forceignore = "";
  if (ignoreEntry) {
    const b = await gh(cfg, `/repos/${cfg.repo}/git/blobs/${ignoreEntry.sha}`);
    forceignore = new TextDecoder().decode(base64ToBytes(b.content || ""));
  }
  return {files, sha: head, truncated: !!tree.truncated, forceignore, base};
}

// Commit to a new branch made from the configured one, then open (or find)
// a pull request into it. Returns {url, number, existing}.
export async function openPullRequest(cfg, files, {branch, title, body, onStatus = () => {}, deletePaths = []}) {
  const res = await commitFiles(cfg, files, title + (body ? "\n\n" + body : ""), {branch, from: cfg.branch, onStatus, deletePaths});
  onStatus("Opening the pull request…");
  try {
    const pr = await gh(cfg, `/repos/${cfg.repo}/pulls`, {method: "POST", body: {title, head: branch, base: cfg.branch, body: body || ""}});
    return {url: pr.html_url, number: pr.number, existing: false, commit: res};
  } catch (e) {
    if (e.status !== 422) throw e;
    const owner = cfg.repo.split("/")[0];
    const list = await gh(cfg, `/repos/${cfg.repo}/pulls?state=open&head=${encodeURIComponent(owner + ":" + branch)}`);
    if (list && list[0]) return {url: list[0].html_url, number: list[0].number, existing: true, commit: res};
    throw new Error(res.unchanged ? "GitHub already has these files on " + cfg.branch + ": nothing to review." : e.message);
  }
}

// Paths under cfg.base on a branch (no file contents): Set of relative paths.
// The set has truncated = true when GitHub cut the listing short (very large
// repositories): it is then incomplete and must not decide what to delete.
export async function listPaths(cfg, {branch} = {}) {
  const head = await branchSha(cfg, branch || cfg.branch);
  const commit = await gh(cfg, `/repos/${cfg.repo}/git/commits/${head}`);
  const tree = await gh(cfg, `/repos/${cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const base = String(cfg.base || "").replace(/^\/+|\/+$/g, "");
  const prefix = base ? base + "/" : "";
  const paths = new Set((tree.tree || []).filter(e => e.type === "blob" && e.path.startsWith(prefix)).map(e => e.path.slice(prefix.length)));
  paths.truncated = !!tree.truncated;
  return paths;
}
