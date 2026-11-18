/* global document, window, HTMLTextAreaElement */
// README screenshots: one per feature, captured from the local preview
// (`npm run dev`) against the mock org and the mock AI, so they show no real
// org data and the same content on every run.
//
//   npm run readme-shots                 # every shot
//   npm run readme-shots -- soql apex    # only these
//
// Env: BASE_URL (default http://127.0.0.1:8321), BROWSER_CHANNEL (default
// msedge). Writes docs/screenshots/<name>.png. Dev-only.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8321";
const PANEL = `${BASE_URL}/smoke.html?host=127.0.0.1&view=inspector`;
const FROZEN_TIME = new Date("2026-11-18T10:00:00Z");
const VIEWPORT = {width: 1280, height: 860};

const wait = (page, ms = 700) => page.waitForTimeout(ms);
// Buttons, tabs and clickable rows all count: many views use role="tab".
const clickable = (page, text) => page.locator("button, [role=tab], [role=button], a", {hasText: text}).first();
async function click(page, text, ms) {
  await clickable(page, text).click();
  await wait(page, ms);
}
async function tab(page, id) {
  await page.click(`#insp-tab-${id}`);
  await wait(page, 1500);
}
async function first(page, selector, ms, text) {
  await page.locator(selector, text ? {hasText: text} : {}).first().click();
  await wait(page, ms);
}
// Puts `selector` at the top of the window (below nothing) for the shot.
async function show(page, selector, offset = 80) {
  await page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
  }, [selector, offset]);
  await wait(page, 300);
}
async function setTextarea(page, selector, value) {
  await page.evaluate(([sel, v]) => {
    const ta = document.querySelector(sel);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, v);
    ta.dispatchEvent(new Event("input", {bubbles: true}));
  }, [selector, value]);
  await wait(page, 300);
}
async function pickCombo(page, inputIndex, optionText) {
  await page.locator("input[placeholder^='Search profiles']").nth(inputIndex).click();
  await wait(page, 400);
  await page.locator("[role=option]", {hasText: optionText}).first().click();
  await wait(page, 500);
}
async function metadataItem(page, kind, text) {
  await tab(page, "metadata");
  if (kind) await click(page, kind, 2000);
  await first(page, ".md-row", 2500, text);
}

// One entry per README screenshot: name -> what to open before the shot.
const SHOTS = {
  "inspector-tabs": async (page) => { await tab(page, "soql"); await click(page, "Run SOQL", 1500); },
  "records": async (page) => {
    await tab(page, "records");
    await page.locator("input").first().fill("Account");
    await click(page, "Load Object", 2500);
  },
  "soql": async (page) => { await tab(page, "soql"); await click(page, "Run SOQL", 1500); await show(page, ".sq3-editor-card", 10); },
  "soql-ai-fix": async (page) => {
    await tab(page, "soql");
    const llm = page.getByLabel(/Enable LLM assistance/);
    if (await llm.count() && !(await llm.isChecked())) await llm.check();
    await setTextarea(page, ".sq3-editor-card textarea", "SELECT Id, Nme FROM Account LIMIT 50");
    await click(page, "Run SOQL", 4000);
    await show(page, ".sq3-editor-card", 10);
  },
  "apex": async (page) => { await tab(page, "apex"); await click(page, /^Execute$/, 3000); },
  "export": async (page) => { await tab(page, "export"); await click(page, "Run Preview", 3000); },
  "import": async (page) => {
    await tab(page, "import");
    await setTextarea(page, "textarea", "Name,Industry,Phone\nAcme Corp,Technology,555-0100\nGlobex,Energy,555-0101\nInitech,Finance,555-0102");
    await click(page, "Load pasted CSV", 1500);
    await page.locator("input[placeholder^='Account / IT_Asset']").fill("Account");
    await wait(page, 1500);
    await click(page, "Auto-suggest", 1500);
  },
  "api-explorer": async (page) => { await tab(page, "api"); await click(page, "Describe Account", 500); await click(page, "Send", 2500); },
  "logs-ai": async (page) => {
    await tab(page, "logs");
    await click(page, "Load logs", 2000);
    await page.locator("button", {hasText: "Analyze"}).nth(1).click();
    await wait(page, 4500);
    await show(page, ".insp-panel, [role=tabpanel]", 10);
  },
  "logs-profile": async (page) => {
    await tab(page, "logs");
    await click(page, "Load logs", 2000);
    await page.locator("button", {hasText: /^View$/}).nth(1).click();
    await wait(page, 2500);
    await click(page, "Profile", 2500);
    await show(page, ".lp-seg", 120);
  },
  "users": async (page) => { await tab(page, "users"); await first(page, ".usr-row", 2500); },
  "users-access-check": async (page) => {
    await tab(page, "users");
    await first(page, ".usr-row", 2500);
    await click(page, "Access Check", 1500);
    await page.locator("input[placeholder^='e.g. Account']").fill("Account");
    await click(page, /^Check$/, 2500);
  },
  "coverage": async (page) => { await tab(page, "coverage"); await wait(page, 1500); },
  "access-compare": async (page) => {
    await tab(page, "access");
    await pickCombo(page, 0, "Standard User");
    await pickCombo(page, 1, "System Administrator");
    await page.locator("button", {hasText: /^Compare$/}).last().click();
    await wait(page, 4000);
  },
  "access-sharing": async (page) => {
    await tab(page, "access");
    await click(page, "Sharing settings", 1500);
    await page.locator(".ff-combo-input").nth(1).click();
    await wait(page, 400);
    const other = page.locator("[role=option]", {hasText: /UAT|localhost/}).first();
    if (await other.count()) { await other.click(); await wait(page, 600); }
    const go = page.locator("button", {hasText: /^Compare/}).last();
    if (await go.isEnabled().catch(() => false)) { await go.click(); await wait(page, 4000); }
  },
  "access-risky": async (page) => { await tab(page, "access"); await click(page, "Risky access", 2500); },
  "access-approvals": async (page) => { await tab(page, "access"); await click(page, "Approvals", 3500); },
  "metadata-apex": async (page) => { await metadataItem(page, null); },
  "metadata-flow": async (page) => { await metadataItem(page, "Flows"); },
  "metadata-lwc": async (page) => { await metadataItem(page, "LWC"); },
  "metadata-validation": async (page) => { await metadataItem(page, "Validation Rules"); },
  "metadata-cmdt": async (page) => { await metadataItem(page, "Custom Metadata"); },
  "metadata-schema": async (page) => {
    await tab(page, "metadata");
    await click(page, "Schema", 2500);
    await click(page, /^Data quality$/, 1200);
    await click(page, "Analyze data", 3500);
  },
  "metadata-new": async (page) => {
    await tab(page, "metadata");
    await click(page, "＋ New", 2000);
    await page.locator("input[placeholder^='PascalCase']").fill("InvoiceReminder");
    await page.locator("input[placeholder^='e.g. Service that closes']").fill("Batch job that emails the owner of every invoice overdue by 7 days, with a test class");
    await wait(page, 500);
  },
  "org-handbook": async (page) => {
    await tab(page, "metadata");
    await click(page, "Org Handbook", 2000);
    // No AI summary: the shot shows the handbook itself, without the confirm box.
    const ai = page.getByLabel(/AI business summary/);
    if (await ai.count() && await ai.isChecked()) await ai.uncheck();
    await click(page, "Build the handbook", 9000);
    await page.evaluate(() => window.scrollTo(0, 0));
  },
  "org-info": async (page) => { await tab(page, "org"); await wait(page, 2500); },
  "app-tabs": async (page) => { await tab(page, "apptabs"); await wait(page, 1500); },
  "sandshift-compare": async (page) => { await tab(page, "release"); await page.locator("button", {hasText: /^Compare$/}).last().click(); await wait(page, 7000); },
  "sandshift-deploy": async (page) => {
    // Compare, pick the differences, then validate them against the target.
    await tab(page, "release");
    await page.locator("button", {hasText: /^Compare$/}).last().click();
    await wait(page, 7000);
    await page.locator("thead input[type=checkbox]").first().check().catch(() => {});
    await wait(page, 600);
    await click(page, "Next: validate & deploy", 2000);
    const noSteps = page.locator("button", {hasText: /^No steps/});
    if (await noSteps.count()) { await noSteps.first().click(); await wait(page, 1500); }
    const validate = page.locator("button", {hasText: /^Validate$/}).last();
    if (await validate.isEnabled().catch(() => false)) {
      await validate.click();
      await wait(page, 1500);
      if (await noSteps.count()) { await noSteps.first().click(); await wait(page, 1000); }
      await wait(page, 7000);
    }
  },
  "sandshift-history": async (page) => { await tab(page, "release"); await click(page, "Versions, rollback", 2500); },
  "sandshift-manual": async (page) => {
    // The runbook is built from what is picked in Compare.
    await tab(page, "release");
    await page.locator("button", {hasText: /^Compare$/}).last().click();
    await wait(page, 7000);
    await page.locator("thead input[type=checkbox]").first().check().catch(() => {});
    await wait(page, 600);
    await click(page, "What a deploy can", 3000);
  },
  "sandshift-impact": async (page) => {
    await tab(page, "release");
    await click(page, "Safe to change", 2000);
    const name = page.locator("input[aria-label='Component name']").first();
    await name.click();
    await name.fill("Invoice__c.Amount__c");
    await wait(page, 600);
    await name.press("Enter");
    await wait(page, 400);
    await click(page, /^Check impact$/, 5000);
  },
  "sandbox-studio": async (page) => {
    await tab(page, "release");
    await click(page, "Sandbox Studio", 2000);
    await click(page, "Refresh list", 2500);
    await first(page, ".sbx-name", 1500);
  },
  "builder-chat": async (page) => {
    await click(page, "AI Object Builder", 1500);
    await page.locator("textarea").first().fill("Track customer support tickets for accounts with priority and SLA");
    await page.locator(".enhance-btn-inside").first().click();
    await wait(page, 4000);
  },
  "builder-plan": async (page) => {
    await click(page, "AI Object Builder", 1500);
    const box = page.locator("textarea").first();
    await box.fill("Track customer support tickets for accounts with priority, status and SLA due date");
    await box.press("Enter");
    await wait(page, 7000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(page, 300);
  },
  "ai-usage": async (page) => {
    await SHOTS["soql-ai-fix"](page);
    await wait(page, 300);
  }
};

// Shots that are not the panel.
const PAGES = {
  "settings-ai": async (page) => {
    await page.goto(`${BASE_URL}/options.html`);
    await wait(page, 1200);
    await page.locator(".opt-provider", {hasText: "Free (test)"}).click();
    await wait(page, 400);
    await page.evaluate(() => document.querySelector(".opt-card").scrollIntoView({block: "start"}));
    await wait(page, 300);
  },
  "launcher": async (page) => {
    await page.setViewportSize({width: 1440, height: 860});
    // A stand-in Salesforce page with the launcher and the open sidebar (the
    // real panel), as the content script lays them out.
    const svg = (fs.readFileSync(path.join(root, "addon", "button.js"), "utf8").match(/btn\.innerHTML = `(<svg[\s\S]*?<\/svg>)`/) || [])[1] || "";
    await page.goto(`${BASE_URL}/smoke.html?host=127.0.0.1&view=inspector`);
    await page.setContent(`<!doctype html><html><body style="margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f3f3f3">
      <div style="height:48px;background:#fff;border-bottom:1px solid #ddd;display:flex;align-items:center;padding:0 16px;color:#032d60;font-weight:600">Sales &nbsp;·&nbsp; Accounts &nbsp;·&nbsp; Contacts &nbsp;·&nbsp; Opportunities &nbsp;·&nbsp; Reports</div>
      <div style="margin:16px;width:440px;background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
        <div style="font-size:12px;color:#706e6b">Account</div><div style="font-size:20px;font-weight:700;color:#080707">Acme Corp</div>
        <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;color:#3e3e3c">
          <div>Industry<br><b>Technology</b></div><div>Phone<br><b>555-0100</b></div><div>Type<br><b>Customer</b></div><div>Owner<br><b>Priya Nair</b></div></div></div>
      <div style="position:fixed;right:954px;bottom:24px;width:42px;height:42px;border-radius:50%;background:#032d60;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.25)">${svg}</div>
      <iframe src="${PANEL}" style="position:fixed;top:0;right:0;width:940px;height:100%;border:0;box-shadow:-4px 0 18px rgba(0,0,0,.18);background:#fff"></iframe>
      </body></html>`);
    await wait(page, 4000);
    const panel = page.frames().find(fr => fr !== page.mainFrame() && fr.url().includes("smoke.html"));
    if (panel) {
      await panel.addStyleTag({content: "#fake-record { display: none !important; }"});
      await panel.click("#insp-tab-soql");
      await wait(page, 1500);
      await panel.locator("button", {hasText: "Run SOQL"}).first().click();
      await wait(page, 2000);
    }
  }
};

async function newPage(browser) {
  const context = await browser.newContext({viewport: VIEWPORT, reducedMotion: "reduce"});
  await context.addInitScript(() => {
    const ls = globalThis.localStorage;
    ls.setItem("sfoc_theme", "light");
    const seen = JSON.stringify({done: {}, disabled: true, lastSeenVersion: "9999.0.0"});
    ls.setItem("sfoc_tours", seen);
    ls.setItem("chrome.storage:sfoc_tours", seen);
    ls.setItem("chrome.storage:sfoc_launcher_tip_seen", "true");
    // ✨ features answer from the dev server's mock AI, never a real provider.
    const ai = JSON.stringify({provider: "openai_compatible", apiKey: "mock-key", model: "mock-model", baseUrl: "http://127.0.0.1:8321/mock-llm/v1"});
    ls.setItem("chrome.storage:llmConfig", ai);
    ls.setItem("llmConfig", ai);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.install({time: FROZEN_TIME});
  return {context, page};
}

async function main() {
  const only = process.argv.slice(2);
  const names = [...Object.keys(SHOTS), ...Object.keys(PAGES)].filter(n => !only.length || only.includes(n));
  const {chromium} = await import("playwright-core");
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || "msedge"});
  fs.mkdirSync(outDir, {recursive: true});
  const failed = [];
  try {
    for (const name of names) {
      const {context, page} = await newPage(browser);
      try {
        await fetch(`${BASE_URL}/mock-release?reset=1`).catch(() => {});
        if (SHOTS[name]) {
          await page.goto(PANEL);
          await page.waitForSelector("[role=tab]", {timeout: 15000});
          await page.addStyleTag({content: "#fake-record { display: none !important; }"});
          await wait(page, 800);
          await SHOTS[name](page);
        } else {
          await PAGES[name](page);
        }
        await page.screenshot({path: path.join(outDir, `${name}.png`), animations: "disabled", caret: "hide"});
        console.log(`ok      ${name}`);
      } catch (e) {
        failed.push(name);
        await page.screenshot({path: path.join(outDir, `${name}.png`), animations: "disabled", caret: "hide"}).catch(() => {});
        console.log(`FAILED  ${name}: ${String(e.message || e).split("\n")[0]}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(failed.length ? `${failed.length} shot(s) need a look: ${failed.join(", ")}` : `Saved ${names.length} screenshot(s) to docs/screenshots`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
