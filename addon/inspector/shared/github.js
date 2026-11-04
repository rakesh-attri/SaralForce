// GitHub (optional): commit releases and snapshots in Salesforce DX source
// format, and read a branch as a deploy source. Uses the Git Data API with a
// personal access token kept in this browser's extension storage.
import {getSetting, setSetting} from "../../core/storage.js";
import {bytesToBase64, base64ToBytes, textToBytes} from "../../core/zip.js";

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
    const err = new Error(res.status === 401 ? "GitHub rejected the token (expired or wrong)." :
      res.status === 404 ? `Not found on GitHub: check the repository name and that the token can see it (${msg}).` : "GitHub: " + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Checks the token and repo; returns {fullName, defaultBranch, canPush, private}.
export async function testGithub(cfg) {
  const r = await gh(cfg, `/repos/${cfg.repo}`);
  return {fullName: r.full_name, defaultBranch: r.default_branch, canPush: !!(r.permissions && r.permissions.push), private: !!r.private};
}

export async function listBranches(cfg) {
  const list = await gh(cfg, `/repos/${cfg.repo}/branches?per_page=100`);
  return (list || []).map(b => b.name);
}

async function branchSha(cfg, branch, {create = false} = {}) {
  try {
    const ref = await gh(cfg, `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.status !== 404 || !create) throw e;
    const info = await gh(cfg, `/repos/${cfg.repo}`);
    const from = await gh(cfg, `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`);
    await gh(cfg, `/repos/${cfg.repo}/git/refs`, {method: "POST", body: {ref: "refs/heads/" + branch, sha: from.object.sha}});
    return from.object.sha;
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
export async function commitFiles(cfg, files, message, {branch, onStatus = () => {}} = {}) {
  const br = branch || cfg.branch;
  onStatus(`Reading ${cfg.repo}@${br}…`);
  const head = await branchSha(cfg, br, {create: true});
  const commit = await gh(cfg, `/repos/${cfg.repo}/git/commits/${head}`);
  const list = [...files.entries()];
  let done = 0;
  const tree = await pool(list, 4, async ([path, data]) => {
    const bytes = typeof data === "string" ? textToBytes(data) : data;
    const blob = await gh(cfg, `/repos/${cfg.repo}/git/blobs`, {method: "POST", body: {content: bytesToBase64(bytes), encoding: "base64"}});
    onStatus(`Uploading files… ${++done}/${list.length}`);
    return {path, mode: "100644", type: "blob", sha: blob.sha};
  });
  onStatus("Committing…");
  const newTree = await gh(cfg, `/repos/${cfg.repo}/git/trees`, {method: "POST", body: {base_tree: commit.tree.sha, tree}});
  if (newTree.sha === commit.tree.sha) return {sha: head, url: `https://github.com/${cfg.repo}/commit/${head}`, files: list.length, unchanged: true};
  const created = await gh(cfg, `/repos/${cfg.repo}/git/commits`, {method: "POST", body: {message, tree: newTree.sha, parents: [head]}});
  await gh(cfg, `/repos/${cfg.repo}/git/refs/heads/${encodeURIComponent(br)}`, {method: "PATCH", body: {sha: created.sha}});
  return {sha: created.sha, url: created.html_url || `https://github.com/${cfg.repo}/commit/${created.sha}`, files: list.length};
}

// Files under cfg.base on a branch: Map(relativePath → Uint8Array).
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
  return {files, sha: head, truncated: !!tree.truncated};
}
