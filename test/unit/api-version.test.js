import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("button.js API_VERSION matches inspector.js defaultApiVersion", () => {
  const inspectorVersion = read("../../addon/inspector.js").match(/defaultApiVersion = "([\d.]+)"/)[1];
  const buttonVersion = read("../../addon/button.js").match(/const API_VERSION = "([\d.]+)"/)[1];
  assert.equal(buttonVersion, inspectorVersion);
});

test("button.js has no hardcoded REST API versions", () => {
  assert.doesNotMatch(read("../../addon/button.js"), /\/services\/data\/v\d+\.\d+\//);
});

test("manifest only exposes the panel page to web pages", () => {
  const manifest = JSON.parse(read("../../addon/manifest.json"));
  assert.deepEqual(manifest.web_accessible_resources.map(r => r.resources).flat(), ["object-creator.html"]);
});
