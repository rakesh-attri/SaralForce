import {test} from "node:test";
import assert from "node:assert/strict";
import {createSfClient, formatSalesforceErrors} from "../../addon/core/sf-client.js";

function response(status, body, headers = {}) {
  const text = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    headers: {get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null},
    text: async () => text
  };
}

function client(handler, extra = {}) {
  const calls = [];
  const sf = createSfClient({
    getHost: () => "acme.my.salesforce.com",
    getSessionId: () => "SID",
    getApiVersion: () => "68.0",
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return handler(url, init, calls.length);
    },
    ...extra
  });
  return {sf, calls};
}

test("request sends auth, call options and a cache-buster, and parses JSON", async () => {
  const {sf, calls} = client(() => response(200, {ok: true}));
  assert.deepEqual(await sf.request("/services/data/v68.0/limits/"), {ok: true});
  const {url, init} = calls[0];
  assert.match(url, /^https:\/\/acme\.my\.salesforce\.com\/services\/data\/v68.0\/limits\/\?cache=/);
  assert.equal(init.headers.Authorization, "Bearer SID");
  assert.equal(init.headers["Sforce-Call-Options"], "client=SaralForce");
});

test("useCache:false leaves the URL alone; JSON bodies are serialised", async () => {
  const {sf, calls} = client(() => response(201, {id: "001"}));
  await sf.request("/x", {method: "POST", body: {Name: "A"}, useCache: false});
  assert.equal(calls[0].url, "https://acme.my.salesforce.com/x");
  assert.equal(calls[0].init.body, '{"Name":"A"}');
  assert.match(calls[0].init.headers["Content-Type"], /application\/json/);
});

test("Salesforce errors keep the old message format", async () => {
  const {sf} = client(() => response(400, [{errorCode: "MALFORMED_QUERY", message: "bad", fields: ["Name"]}]));
  await assert.rejects(sf.request("/q"), (err) => {
    assert.equal(err.name, "SalesforceRestError");
    assert.equal(err.message, "MALFORMED_QUERY: bad [Name]");
    assert.equal(err.status, 400);
    return true;
  });
});

test("401 with an empty body does not crash and reports the auth error", async () => {
  const seen = [];
  const {sf} = client(() => response(401, ""), {onAuthError: (kind) => seen.push(kind)});
  await assert.rejects(sf.request("/q"), {name: "Unauthorized", message: "New access token needed"});
  assert.deepEqual(seen, ["unauthorized"]);
});

test("GET retries on 503 then succeeds; POST does not retry", async () => {
  const {sf, calls} = client((url, init, n) => (n === 1 ? response(503, "", {"Retry-After": "0"}) : response(200, {ok: 1})));
  assert.deepEqual(await sf.request("/q"), {ok: 1});
  assert.equal(calls.length, 2);

  const post = client(() => response(503, ""));
  await assert.rejects(post.sf.request("/q", {method: "POST", body: {}}), {status: 503});
  assert.equal(post.calls.length, 1);
});

test("an aborted signal cancels without retrying", async () => {
  const controller = new AbortController();
  const {sf, calls} = client((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const pending = sf.request("/slow", {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, {name: "AbortError"});
  assert.equal(calls.length, 1);
});

test("timeoutMs aborts a hanging request with a TimeoutError", async () => {
  const {sf} = client((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  await assert.rejects(sf.request("/slow", {timeoutMs: 20, retries: 0}), {name: "TimeoutError"});
});

test("queryAll follows nextRecordsUrl and reports truncation", async () => {
  const {sf} = client((url) => {
    if (url.includes("/query/")) return response(200, {totalSize: 5, records: [{n: 1}, {n: 2}], nextRecordsUrl: "/next1"});
    if (url.includes("/next1")) return response(200, {records: [{n: 3}, {n: 4}], nextRecordsUrl: "/next2"});
    return response(200, {records: [{n: 5}]});
  });
  const all = await sf.queryAll("SELECT Id FROM Account");
  assert.equal(all.records.length, 5);
  assert.equal(all.totalSize, 5);
  assert.equal(all.truncated, false);
  const capped = await sf.queryAll("SELECT Id FROM Account", {maxRecords: 3});
  assert.equal(capped.records.length, 3);
  assert.equal(capped.truncated, true);
});

test("describe is cached per object and API", async () => {
  const {sf, calls} = client(() => response(200, {name: "Account"}));
  await sf.describe("Account");
  await sf.describe("account");
  await sf.describe("Account", {tooling: true});
  assert.equal(calls.length, 2);
});

test("collections chunks by 200 and keeps result order", async () => {
  const {sf, calls} = client((url, init) => {
    const recs = JSON.parse(init.body).records;
    return response(200, recs.map(r => ({success: true, id: r.Name})));
  });
  const records = Array.from({length: 450}, (_, i) => ({Name: "R" + i}));
  const res = await sf.collections("insert", records, {sobject: "Account"});
  assert.equal(calls.length, 3);
  assert.equal(res.length, 450);
  assert.equal(res[449].id, "R449");
  assert.equal(JSON.parse(calls[0].init.body).records[0].attributes.type, "Account");
});

test("formatSalesforceErrors handles arrays, objects and text", () => {
  assert.equal(formatSalesforceErrors([{errorCode: "X", message: "y"}]), "X: y");
  assert.equal(formatSalesforceErrors({a: 1}), '{"a":1}');
  assert.equal(formatSalesforceErrors("plain"), "plain");
});

test("401 renews the session once and retries with the new one", async () => {
  let sid = "OLD";
  const seen = [];
  const {sf, calls} = client((url, init) => init.headers.Authorization === "Bearer NEW" ? response(200, {ok: 1}) : response(401, [{message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID"}]), {
    getSessionId: () => sid,
    renewSession: async () => { sid = "NEW"; return true; },
    onAuthError: kind => seen.push(kind)
  });
  assert.deepEqual(await sf.request("/q"), {ok: 1});
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, []);
  // Still logged out: one renewal attempt, then the auth error.
  const dead = client(() => response(401, ""), {renewSession: async () => false, onAuthError: kind => seen.push(kind)});
  await assert.rejects(dead.sf.request("/q"), {name: "Unauthorized"});
  assert.equal(dead.calls.length, 1);
  assert.deepEqual(seen, ["unauthorized"]);
});

test("cancel and timeout still apply while the body downloads", async () => {
  // Headers arrive at once; the body never does, until the signal aborts.
  const stalled = (url, init) => ({
    status: 200,
    headers: {get: () => null},
    text: () => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });
  const controller = new AbortController();
  const {sf, calls} = client(stalled);
  const pending = sf.request("/big", {signal: controller.signal});
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, {name: "AbortError"});
  assert.equal(calls.length, 1);
  await assert.rejects(client(stalled).sf.request("/big", {timeoutMs: 20, retries: 0}), {name: "TimeoutError"});
});

test("errors carry the Salesforce errorCode", async () => {
  const {sf} = client(() => response(400, [{errorCode: "MALFORMED_QUERY", message: "bad"}]));
  await assert.rejects(sf.request("/q"), {code: "MALFORMED_QUERY"});
  const plain = client(() => response(500, "oops"));
  await assert.rejects(plain.sf.request("/q", {retries: 0}), (err) => err.code === undefined);
});

test("403 is an auth error only when it is about the session or API access", async () => {
  const seen = [];
  const run = (body) => client(() => response(403, body), {onAuthError: (kind) => seen.push(kind)}).sf.request("/q");
  await assert.rejects(run([{errorCode: "REQUEST_LIMIT_EXCEEDED", message: "TotalRequests Limit exceeded."}]),
    {name: "Forbidden", code: "REQUEST_LIMIT_EXCEEDED", message: "TotalRequests Limit exceeded."});
  await assert.rejects(run([{errorCode: "INSUFFICIENT_ACCESS", message: "no"}]), {name: "Forbidden"});
  assert.deepEqual(seen, []);
  await assert.rejects(run([{errorCode: "API_DISABLED_FOR_ORG", message: "API is not enabled"}]), {code: "API_DISABLED_FOR_ORG"});
  await assert.rejects(run("<html>Forbidden</html>"), {name: "Forbidden"});
  assert.deepEqual(seen, ["forbidden", "forbidden"]);
});

test("a web page where JSON was expected is an error, not data", async () => {
  const {sf} = client(() => response(200, "<!DOCTYPE html><html><body>Sign in</body></html>"));
  await assert.rejects(sf.request("/q"), {name: "SalesforceRestError", status: 200, message: /web page instead of data/});
  // Text responses, empty bodies and JSON strings are left alone.
  assert.equal(await client(() => response(200, "<log/>")).sf.request("/log", {responseType: "text"}), "<log/>");
  assert.equal(await client(() => response(200, "")).sf.request("/empty"), null);
  assert.equal(await client(() => response(204, "")).sf.request("/none"), null);
  assert.equal(await client(() => response(200, '"<b>"')).sf.request("/str"), "<b>");
  assert.equal(await client(() => response(200, "707xx0000000001")).sf.request("/id"), "707xx0000000001");
});
