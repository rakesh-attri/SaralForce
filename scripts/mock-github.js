// Mock GitHub REST (Git Data API) for the preview: one in-memory repo,
// acme/salesforce, branch main. test/smoke.html rewrites api.github.com
// here. GET /mock-github-state shows the files on each branch.
import crypto from "node:crypto";

const sha = s => crypto.createHash("sha1").update(s).digest("hex");
let repo;

function seed() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const put = text => { const b = Buffer.from(text).toString("base64"); const id = sha("blob" + b); blobs.set(id, b); return id; };
  const entries = [
    {path: "README.md", type: "blob", sha: put("# Salesforce source\n")},
    {path: "force-app/main/default/classes/GitOnlyHelper.cls", type: "blob", sha: put("public class GitOnlyHelper {\n    public static String hello() { return 'from git'; }\n}\n")},
    {path: "force-app/main/default/classes/GitOnlyHelper.cls-meta.xml", type: "blob", sha: put('<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>68.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n')}
  ];
  const treeSha = sha("tree" + JSON.stringify(entries));
  trees.set(treeSha, entries);
  const c = sha("commit-initial");
  commits.set(c, {sha: c, tree: {sha: treeSha}, parents: [], message: "Initial"});
  repo = {blobs, trees, commits, refs: new Map([["main", c]]), log: []};
}
seed();

export function resetGithub() {
  seed();
}

export function githubState() {
  const out = {};
  for (const [b, c] of repo.refs) out[b] = {commit: c, message: repo.commits.get(c).message, files: repo.trees.get(repo.commits.get(c).tree.sha).map(e => e.path)};
  out.pulls = repo.pulls || [];
  return out;
}

export function mockGithub(req, res, url, json) {
  const p = url.pathname.replace(/^\/mock-github/, "");
  const send = (status, body) => json(res, status, body);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"});
    return res.end();
  }
  let raw = "";
  req.on("data", c => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (!/Bearer ghp_mock|Bearer github_pat_mock/.test(String(req.headers.authorization || ""))) return send(401, {message: "Bad credentials"});
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
      if (m[1] !== "acme/salesforce") return send(404, {message: "Not Found"});
      return send(200, {full_name: "acme/salesforce", default_branch: "main", private: true, permissions: {push: true}});
    }
    if (/\/branches$/.test(p)) return send(200, [...repo.refs.keys()].map(name => ({name})));
    if ((m = /\/git\/ref\/heads\/(.+)$/.exec(p)) && req.method === "GET") {
      const c = repo.refs.get(decodeURIComponent(m[1]));
      return c ? send(200, {object: {sha: c}}) : send(404, {message: "Not Found"});
    }
    if (/\/git\/refs$/.test(p) && req.method === "POST") {
      repo.refs.set(body.ref.replace("refs/heads/", ""), body.sha);
      return send(201, {ref: body.ref, object: {sha: body.sha}});
    }
    if ((m = /\/git\/refs\/heads\/(.+)$/.exec(p)) && req.method === "PATCH") {
      repo.refs.set(decodeURIComponent(m[1]), body.sha);
      return send(200, {object: {sha: body.sha}});
    }
    if ((m = /\/git\/commits\/([0-9a-f]+)$/.exec(p))) {
      const c = repo.commits.get(m[1]);
      return c ? send(200, c) : send(404, {message: "Not Found"});
    }
    if (/\/git\/commits$/.test(p) && req.method === "POST") {
      const id = sha("commit" + body.tree + body.message + Date.now());
      repo.commits.set(id, {sha: id, tree: {sha: body.tree}, parents: body.parents, message: body.message, html_url: `https://github.com/acme/salesforce/commit/${id}`});
      repo.log.push(body.message.split("\n")[0]);
      return send(201, repo.commits.get(id));
    }
    if (/\/git\/blobs$/.test(p) && req.method === "POST") {
      const id = sha("blob" + body.content);
      repo.blobs.set(id, body.content);
      return send(201, {sha: id});
    }
    if ((m = /\/git\/blobs\/([0-9a-f]+)$/.exec(p))) {
      const b = repo.blobs.get(m[1]);
      return b ? send(200, {sha: m[1], content: b, encoding: "base64"}) : send(404, {message: "Not Found"});
    }
    if (/\/git\/trees$/.test(p) && req.method === "POST") {
      const base = new Map((repo.trees.get(body.base_tree) || []).map(e => [e.path, e]));
      for (const e of body.tree) {
        if (e.sha === null) base.delete(e.path); else base.set(e.path, {path: e.path, type: "blob", sha: e.sha});
      }
      const entries = [...base.values()].sort((a, b) => a.path.localeCompare(b.path));
      const id = sha("tree" + JSON.stringify(entries));
      repo.trees.set(id, entries);
      return send(201, {sha: id});
    }
    if ((m = /\/git\/trees\/([0-9a-f]+)$/.exec(p))) {
      const t = repo.trees.get(m[1]);
      return t ? send(200, {sha: m[1], tree: t, truncated: false}) : send(404, {message: "Not Found"});
    }
    if (/\/pulls$/.test(p) && req.method === "POST") {
      repo.pulls = repo.pulls || [];
      if (repo.pulls.some(x => x.head === body.head)) return send(422, {message: "A pull request already exists"});
      const pr = {number: repo.pulls.length + 14, head: body.head, base: body.base, title: body.title, html_url: `https://github.com/acme/salesforce/pull/${repo.pulls.length + 14}`};
      repo.pulls.push(pr);
      return send(201, pr);
    }
    if (/\/pulls$/.test(p)) {
      const head = (url.searchParams.get("head") || "").split(":")[1];
      return send(200, (repo.pulls || []).filter(x => !head || x.head === head));
    }
    return send(404, {message: "Mock GitHub: " + p});
  });
  return undefined;
}
