import {test} from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath, withVersion, soapTemplate, SOAP_APIS, SESSION_PLACEHOLDER, formatXml,
  prettyBody, apiLinks, addHistory, byteSize, REST_PRESETS
} from "../../addon/core/api-explorer.js";

test("normalizePath", () => {
  assert.equal(normalizePath("sobjects/Account", "67.0"), "/services/data/v67.0/sobjects/Account");
  assert.equal(normalizePath("v60.0/limits", "67.0"), "/services/data/v60.0/limits");
  assert.equal(normalizePath("/services/apexrest/x", "67.0"), "/services/apexrest/x");
  assert.equal(normalizePath("services/data/", "67.0"), "/services/data/");
  assert.equal(normalizePath("https://acme.my.salesforce.com/services/data/v67.0/", "67.0"), "/services/data/v67.0/");
  assert.equal(normalizePath("", "67.0"), "/services/data/v67.0/");
});

test("withVersion fills strings and nested bodies", () => {
  assert.equal(withVersion("/services/data/v{v}/x", "67.0"), "/services/data/v67.0/x");
  const comp = REST_PRESETS.find(p => p.label.startsWith("Composite (create")).body;
  assert.match(JSON.stringify(withVersion(comp, "67.0")), /\/services\/data\/v67\.0\/sobjects\/Account/);
  assert.doesNotMatch(JSON.stringify(withVersion(comp, "67.0")), /\{v\}/);
});

test("soapTemplate puts a session placeholder and the API namespace", () => {
  const t = soapTemplate(SOAP_APIS[0], "67.0");
  assert.match(t, /xmlns:urn="urn:partner\.soap\.sforce\.com"/);
  assert.ok(t.includes(SESSION_PLACEHOLDER));
  assert.match(soapTemplate(SOAP_APIS[1], "67.0"), /<urn:asOfVersion>67\.0<\/urn:asOfVersion>/);
});

test("formatXml indents and keeps text inline", () => {
  assert.equal(formatXml("<?xml version=\"1.0\"?><a><b>x</b><c/><d><e>1</e></d></a>"),
    "<?xml version=\"1.0\"?>\n<a>\n  <b>x</b>\n  <c/>\n  <d>\n    <e>1</e>\n  </d>\n</a>");
});

test("prettyBody detects JSON, XML and text", () => {
  assert.deepEqual(prettyBody("{\"a\":1}", "application/json"), {kind: "json", text: "{\n  \"a\": 1\n}"});
  assert.equal(prettyBody("<a><b>1</b></a>", "text/xml").kind, "xml");
  assert.deepEqual(prettyBody("hello", "text/plain"), {kind: "text", text: "hello"});
  assert.equal(prettyBody("", "").kind, "empty");
  assert.equal(prettyBody("{not json", "application/json").kind, "text");
});

test("apiLinks finds clickable resource paths", () => {
  const t = JSON.stringify({sobjects: "/services/data/v67.0/sobjects", nextRecordsUrl: "/services/data/v67.0/query/01g-2000", other: "x"});
  assert.deepEqual(apiLinks(t), ["/services/data/v67.0/sobjects", "/services/data/v67.0/query/01g-2000"]);
});

test("addHistory de-duplicates and caps", () => {
  let h = [];
  h = addHistory(h, {mode: "rest", method: "GET", path: "/a", status: 200});
  h = addHistory(h, {mode: "rest", method: "GET", path: "/b", status: 200});
  h = addHistory(h, {mode: "rest", method: "GET", path: "/a", status: 404});
  assert.deepEqual(h.map(e => `${e.path}:${e.status}`), ["/a:404", "/b:200"]);
  assert.equal(addHistory(Array.from({length: 40}, (_, i) => ({mode: "rest", method: "GET", path: "/" + i})), {mode: "rest", method: "GET", path: "/new"}).length, 30);
});

test("byteSize", () => {
  assert.equal(byteSize("abc"), "3 B");
  assert.equal(byteSize("x".repeat(2048)), "2.0 KB");
});
