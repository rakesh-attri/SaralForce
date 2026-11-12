import {test} from "node:test";
import assert from "node:assert/strict";
import {listBranches, commitFiles, listPaths, rateLimitMessage} from "../../addon/inspector/shared/github.js";

const cfg = {token: "t", repo: "o/r", branch: "main", base: "force-app/main/default"};

// routes: (method, path) → {status?, body?, headers?}. Records every call.
function mockGithub(route) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push(init.method + " " + path);
    const r = route(init.method, path, init.body ? JSON.parse(init.body) : null) || {};
    const status = r.status || 200;
    const headers = new Map(Object.entries(r.headers || {}));
    return {ok: status < 300, status, headers: {get: n => (headers.has(n) ? headers.get(n) : null)}, text: async () => JSON.stringify(r.body == null ? {} : r.body)};
  };
  return calls;
}

test("listBranches follows pages until a short one", async () => {
  const page = n => Array.from({length: n}, (_, i) => ({name: "b" + i}));
  const calls = mockGithub((m, p) => ({body: /page=1$/.test(p) ? page(100) : /page=2$/.test(p) ? page(100) : page(7)}));
  const names = await listBranches(cfg);
  assert.equal(names.length, 207);
  assert.equal(calls.length, 3);
});

test("rate limit errors say when the limit resets", async () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const h = o => n => (n in o ? o[n] : null);
  assert.match(rateLimitMessage(403, h({"x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600)}), now), /rate limit reached.*resets at .*about 10 minute/);
  assert.match(rateLimitMessage(429, h({"retry-after": "30"}), now), /Try again in 30 second/);
  assert.equal(rateLimitMessage(403, h({"x-ratelimit-remaining": "12"}), now), "");
  assert.equal(rateLimitMessage(404, h({"x-ratelimit-remaining": "0"}), now), "");
  mockGithub(() => ({status: 403, headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120)}, body: {message: "API rate limit exceeded for user ID 1."}}));
  await assert.rejects(listBranches(cfg), e => /GitHub rate limit reached/.test(e.message) && e.status === 403 && !/user ID/.test(e.message));
});

const baseRoutes = (m, p) => {
  if (m === "GET" && p.endsWith("/git/ref/heads/main")) return {body: {object: {sha: "head1"}}};
  if (m === "GET" && p.endsWith("/git/commits/head1")) return {body: {tree: {sha: "tree1"}}};
  if (m === "POST" && p.endsWith("/git/blobs")) return {body: {sha: "blob1"}};
  if (m === "POST" && p.endsWith("/git/trees")) return {body: {sha: "tree2"}};
  if (m === "POST" && p.endsWith("/git/commits")) return {body: {sha: "c2", html_url: "u"}};
  return null;
};

test("a commit that needs the tree refuses a truncated listing", async () => {
  const calls = mockGithub((m, p) => baseRoutes(m, p) || (p.includes("/git/trees/tree1") ? {body: {truncated: true, tree: []}} : null));
  await assert.rejects(commitFiles(cfg, new Map([["a.txt", "x"]]), "msg", {deletePaths: ["old.txt"]}), /too large for GitHub to list/);
  assert.ok(!calls.some(c => c.startsWith("POST")), "nothing written");
});

test("a concurrent push is reported in plain words", async () => {
  mockGithub((m, p) => baseRoutes(m, p) || (m === "PATCH" ? {status: 422, body: {message: "Update is not a fast forward"}} : null));
  await assert.rejects(commitFiles(cfg, new Map([["a.txt", "x"]]), "msg"), e => /changed on GitHub while SaralForce was committing/.test(e.message) && e.status === 422);
});

test("listPaths flags a truncated listing", async () => {
  mockGithub((m, p) => baseRoutes(m, p) || {body: {truncated: true, tree: [{type: "blob", path: "force-app/main/default/classes/A.cls"}]}});
  const paths = await listPaths(cfg);
  assert.deepEqual([...paths], ["classes/A.cls"]);
  assert.equal(paths.truncated, true);
});
