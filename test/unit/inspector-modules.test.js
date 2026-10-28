import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inspectorDir = path.join(root, "addon", "inspector");

function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

const files = walk(inspectorDir).filter(f => f.endsWith(".js"));

test("addon/inspector contains modules", () => {
  assert.ok(files.length > 10, `expected inspector modules, found ${files.length}`);
});

test("every inspector module is an ES module whose static imports resolve", () => {
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    assert.match(src, /^\s*(import|export)\s/m, `${rel} has no import/export`);
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gm)].map(m => m[1]);
    for (const spec of specs) {
      assert.ok(spec.startsWith("."), `${rel}: non-relative import "${spec}"`);
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(fs.existsSync(target), `${rel}: import "${spec}" does not resolve`);
    }
  }
});

test("inspector-tools.js facade re-exports resolve", () => {
  const facade = path.join(root, "addon", "inspector-tools.js");
  const src = fs.readFileSync(facade, "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]);
  assert.ok(specs.length > 0);
  for (const spec of specs) assert.ok(fs.existsSync(path.resolve(path.dirname(facade), spec)), spec);
});

test("inspector-panel registry lists the 10 tabs in order", () => {
  const src = fs.readFileSync(path.join(inspectorDir, "inspector-panel.js"), "utf8");
  const block = src.match(/export const INSPECTOR_TABS = \[([\s\S]*?)\n\];/);
  assert.ok(block, "INSPECTOR_TABS registry not found");
  const ids = [...block[1].matchAll(/\{id:\s*"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ["records", "soql", "apex", "export", "import", "users", "logs", "org", "apptabs", "coverage"]);
  for (const entry of block[1].matchAll(/\{id:[^\n]*\}/g)) {
    assert.match(entry[0], /component:\s*\w+/, `registry entry missing component: ${entry[0]}`);
  }
});
