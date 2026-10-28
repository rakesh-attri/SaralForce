// Visual regression for the panel UI. Captures every Inspector tab and the
// Object Builder in light and dark theme from the local preview
// (`npm run dev`), then compares against a baseline pixel by pixel.
//
//   node scripts/visual-snapshots.js capture baseline   # save reference shots
//   node scripts/visual-snapshots.js capture current    # after a change
//   node scripts/visual-snapshots.js compare baseline current
//
// Env: BASE_URL (default http://127.0.0.1:8321), BROWSER_CHANNEL (default
// msedge; any installed Chromium channel works). Dev-only.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {PNG} from "pngjs";
import pixelmatch from "pixelmatch";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = path.join(root, "test", "visual");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8321";
const TABS = ["records", "soql", "apex", "export", "import", "users", "logs", "org", "apptabs", "coverage"];
const THEMES = ["light", "dark"];
const FROZEN_TIME = new Date("2026-10-28T10:00:00Z");

async function capture(name) {
  const {chromium} = await import("playwright-core");
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || "msedge"});
  const outDir = path.join(shotsDir, name);
  fs.mkdirSync(outDir, {recursive: true});
  try {
    for (const theme of THEMES) {
      const context = await browser.newContext({viewport: {width: 1280, height: 860}, reducedMotion: "reduce"});
      await context.addInitScript((t) => {
        localStorage.setItem("sfoc_theme", t);
      }, theme);
      const page = await context.newPage();
      await page.clock.install({time: FROZEN_TIME});
      await page.goto(`${BASE_URL}/smoke.html?host=127.0.0.1&view=inspector`);
      await page.waitForSelector("[role=tab]", {timeout: 15000});
      for (const tab of TABS) {
        await page.click(`#insp-tab-${tab}`);
        await page.waitForTimeout(700);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({path: path.join(outDir, `${theme}-${tab}.png`), animations: "disabled", caret: "hide"});
      }
      // The Object Builder (chat view) is the panel's other mode.
      const builderBtn = page.getByRole("button", {name: /AI Object Builder/});
      if (await builderBtn.count()) {
        await builderBtn.first().click();
        await page.waitForTimeout(700);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({path: path.join(outDir, `${theme}-builder.png`), animations: "disabled", caret: "hide"});
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`Saved screenshots to ${path.relative(root, outDir)}`);
}

function compare(a, b) {
  const dirA = path.join(shotsDir, a);
  const dirB = path.join(shotsDir, b);
  const diffDir = path.join(shotsDir, `diff-${a}-${b}`);
  fs.mkdirSync(diffDir, {recursive: true});
  let changed = 0;
  for (const file of fs.readdirSync(dirA).filter(f => f.endsWith(".png")).sort()) {
    const fileB = path.join(dirB, file);
    if (!fs.existsSync(fileB)) {
      console.log(`MISSING  ${file}`);
      changed++;
      continue;
    }
    const imgA = PNG.sync.read(fs.readFileSync(path.join(dirA, file)));
    const imgB = PNG.sync.read(fs.readFileSync(fileB));
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
      console.log(`SIZE     ${file} ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`);
      changed++;
      continue;
    }
    const diff = new PNG({width: imgA.width, height: imgA.height});
    const pixels = pixelmatch(imgA.data, imgB.data, diff.data, imgA.width, imgA.height, {threshold: 0.1});
    const pct = (100 * pixels / (imgA.width * imgA.height)).toFixed(3);
    if (pixels > 0) {
      fs.writeFileSync(path.join(diffDir, file), PNG.sync.write(diff));
      changed++;
    }
    console.log(`${pixels ? "CHANGED " : "same    "} ${file}${pixels ? `  ${pixels} px (${pct}%)` : ""}`);
  }
  console.log(changed ? `${changed} screenshot(s) differ; diffs in ${path.relative(root, diffDir)}` : "No visual changes.");
  process.exitCode = changed ? 1 : 0;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "capture" && a) await capture(a);
else if (cmd === "compare" && a && b) compare(a, b);
else {
  console.error("Usage: visual-snapshots.js capture <name> | compare <a> <b>");
  process.exitCode = 2;
}
