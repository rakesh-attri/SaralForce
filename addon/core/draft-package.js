// A Metadata-tab draft (Apex class, trigger, Visualforce page, LWC, Aura) as
// one Metadata API package: compiled together by a check-only deploy, and
// deployed all-or-nothing (no half-created bundles). Pure.
import {buildPackageXml} from "./metadata.js";

export const PACKAGE_KINDS = ["apex", "triggers", "pages", "lwc", "aura"];

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const classMeta = v => `${XML}<ApexClass ${NS}>\n    <apiVersion>${v}</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;
const triggerMeta = v => `${XML}<ApexTrigger ${NS}>\n    <apiVersion>${v}</apiVersion>\n    <status>Active</status>\n</ApexTrigger>\n`;
const pageMeta = (v, label) => `${XML}<ApexPage ${NS}>\n    <apiVersion>${v}</apiVersion>\n    <availableInTouch>false</availableInTouch>\n` +
  `    <confirmationTokenRequired>false</confirmationTokenRequired>\n    <label>${esc(label)}</label>\n</ApexPage>\n`;
const auraMeta = (v, description) => `${XML}<AuraDefinitionBundle ${NS}>\n    <apiVersion>${v}</apiVersion>\n` +
  (description ? `    <description>${esc(description)}</description>\n` : "") + `</AuraDefinitionBundle>\n`;

const isTest = text => /@isTest\b/i.test(text || "") || /\btestMethod\b/i.test(text || "");

// draft → {entries: [[path, text]], members, tests: [class names], main: {type, name}}
export function draftPackage(draft, fallbackVersion) {
  const f = draft.form || {};
  const v = Number(f.apiVersion || fallbackVersion).toFixed(1);
  const entries = [];
  const members = {};
  const add = (type, name) => { (members[type] = members[type] || []).push(name); };
  const tests = [];
  for (const file of draft.files) {
    const m = /^classes\/([A-Za-z][\w]*)\.cls$/.exec(file.path);
    if (m) {
      entries.push([file.path, file.content], [file.path + "-meta.xml", classMeta(v)]);
      add("ApexClass", m[1]);
      if (isTest(file.content)) tests.push(m[1]);
    }
  }
  let main;
  switch (draft.kind) {
  case "apex":
    main = {type: "ApexClass", name: draft.name};
    break;
  case "triggers": {
    const t = draft.files.find(x => /^triggers\//.test(x.path));
    entries.push([`triggers/${draft.name}.trigger`, t ? t.content : ""], [`triggers/${draft.name}.trigger-meta.xml`, triggerMeta(v)]);
    add("ApexTrigger", draft.name);
    main = {type: "ApexTrigger", name: draft.name};
    break;
  }
  case "pages": {
    const p = draft.files.find(x => /^pages\//.test(x.path));
    entries.push([`pages/${draft.name}.page`, p ? p.content : ""], [`pages/${draft.name}.page-meta.xml`, pageMeta(v, f.label || draft.name)]);
    add("ApexPage", draft.name);
    main = {type: "ApexPage", name: draft.name};
    break;
  }
  case "lwc":
    for (const file of draft.files.filter(x => x.path.startsWith(`lwc/${draft.name}/`))) entries.push([file.path, file.content]);
    add("LightningComponentBundle", draft.name);
    main = {type: "LightningComponentBundle", name: draft.name};
    break;
  case "aura": {
    for (const file of draft.files.filter(x => x.path.startsWith(`aura/${draft.name}/`))) entries.push([file.path, file.content]);
    const base = draft.files.find(x => new RegExp(`^aura/${draft.name}/${draft.name}\\.(cmp|app|evt|intf)$`).test(x.path));
    const ext = base ? base.path.split(".").pop() : "cmp";
    entries.push([`aura/${draft.name}/${draft.name}.${ext}-meta.xml`, auraMeta(v, f.description)]);
    add("AuraDefinitionBundle", draft.name);
    main = {type: "AuraDefinitionBundle", name: draft.name};
    break;
  }
  default:
    throw new Error("This kind is not deployed as a package: " + draft.kind);
  }
  entries.push(["package.xml", buildPackageXml(members, v)]);
  return {entries, members, tests, main, apiVersion: v};
}

// Test level for a check or deploy: sandboxes skip tests; production runs
// the draft's own test classes (or all local tests when it has none).
export function draftTestOptions({isSandbox, hasApex, tests}) {
  if (isSandbox || !hasApex) return {testLevel: "NoTestRun", runTests: []};
  if (tests.length) return {testLevel: "RunSpecifiedTests", runTests: tests};
  return {testLevel: "RunLocalTests", runTests: []};
}

// Deploy result → readable lines, one per problem, for people and for the AI.
export function compileErrorText(summary, draft) {
  const lines = [];
  for (const f of summary.componentFailures || []) {
    const file = f.fileName ? f.fileName.split("/").pop() : `${f.type} ${f.fullName}`;
    lines.push(`${file}${f.line ? ` line ${f.line}` : ""}${f.column ? `:${f.column}` : ""}: ${f.problem}`);
  }
  for (const t of summary.testFailures || []) lines.push(`Test ${t.className}.${t.method} failed: ${t.message}`);
  for (const w of summary.coverageWarnings || []) lines.push(`Coverage: ${w.name ? w.name + ": " : ""}${w.message}`);
  if (!lines.length && summary.errorMessage) lines.push(summary.errorMessage);
  if (!lines.length) lines.push(`${draft ? draft.name : "The draft"} could not be deployed (${summary.status || "failed"}).`);
  return lines.join("\n");
}
