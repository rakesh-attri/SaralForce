// Pure helpers for AI-written Lightning Web Components: map the model's
// JSON reply to draft files, check the bundle before showing it, and turn
// a draft into prompt text for edit requests. No chrome/window/DOM access.
import {pascalCase} from "./metadata-templates.js";

const APEX_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function text(v) {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n") : "";
}

// Model replies may give Apex as one object or a list.
function apexList(reply) {
  const raw = reply && reply.apex;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map(a => ({name: String((a && a.name) || "").trim(), body: text(a && (a.body || a.content))}))
    .filter(a => APEX_NAME_RE.test(a.name) && a.body.trim());
}

// AI reply → draft files (same paths/formats as lwcFiles, without the
// generated js-meta.xml). reply: {files: {html, js, css?, svg?}, apex?}.
export function normalizeBundleReply(reply, name) {
  const f = (reply && reply.files) || {};
  const files = [];
  const add = (ext, format) => {
    const content = text(f[ext]);
    if (content.trim()) files.push({path: `lwc/${name}/${name}.${ext}`, format, content: content.endsWith("\n") ? content : content + "\n"});
  };
  add("html", "html");
  add("js", "js");
  add("css", "css");
  add("svg", "svg");
  for (const a of apexList(reply)) {
    files.push({path: `classes/${a.name}.cls`, format: "apex", role: "apex", name: a.name,
      content: a.body.endsWith("\n") ? a.body : a.body + "\n"});
  }
  return files;
}

// Problems that would make the bundle fail to save or run. Empty = OK.
// Used as the askAiJson validator so one bad reply is retried.
export function checkLwcBundle(files, name) {
  const problems = [];
  const byExt = ext => files.find(x => x.path === `lwc/${name}/${name}.${ext}`);
  const html = byExt("html");
  const js = byExt("js");
  if (!html) problems.push(`Missing ${name}.html.`);
  else if (!/^\s*(<!--[\s\S]*?-->\s*)*<template[\s>]/.test(html.content)) problems.push("The HTML must start with a <template> root.");
  if (!js) problems.push(`Missing ${name}.js.`);
  else {
    const cls = pascalCase(name);
    if (!/from\s+['"]lwc['"]/.test(js.content)) problems.push("The JS must import LightningElement from 'lwc'.");
    if (!new RegExp(`export\\s+default\\s+class\\s+${cls}\\s+extends\\s+(LightningElement|NavigationMixin\\(\\s*LightningElement\\s*\\))`).test(js.content)) {
      problems.push(`The JS must declare: export default class ${cls} extends LightningElement.`);
    }
    const apex = files.filter(x => x.role === "apex");
    const re = /from\s+['"]@salesforce\/apex\/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(js.content))) {
      const [, clsName, method] = m;
      const file = apex.find(a => a.name === clsName);
      if (!file) problems.push(`The JS imports @salesforce/apex/${clsName}.${method} but no Apex class ${clsName} was returned.`);
      else if (!new RegExp(`@AuraEnabled[^\\n]*\\n?\\s*(public|global)\\s+static\\s+[\\w<>,\\s.]+\\s${method}\\s*\\(`).test(file.content)) {
        problems.push(`Apex class ${clsName} has no @AuraEnabled static method ${method}.`);
      }
    }
  }
  for (const x of files) {
    if (x.role === "apex") continue;
    if (/\.innerHTML\s*=|\beval\s*\(|new\s+Function\s*\(/.test(x.content)) problems.push(`${x.path.split("/").pop()} uses innerHTML/eval, which LWC does not allow.`);
    if (/<script[\s>]/i.test(x.content)) problems.push(`${x.path.split("/").pop()} contains a <script> tag; LWC does not allow it.`);
  }
  for (const a of files.filter(x => x.role === "apex")) {
    if (!new RegExp(`\\bclass\\s+${a.name}\\b`).test(a.content)) problems.push(`Apex file ${a.name}.cls does not declare class ${a.name}.`);
  }
  return problems;
}

// Draft files as prompt text (generated/read-only files are left out).
export function bundleForPrompt(files) {
  return files
    .filter(x => !x.generated && !x.readOnly)
    .map(x => `=== ${x.path} ===\n${x.content}`)
    .join("\n\n");
}

// Merge AI-changed files into a draft. changed: {path: content}. Unknown
// paths are added only for LWC resources / Apex classes of this draft;
// generated or read-only files are never touched.
export function mergeRevision(draft, changed) {
  const name = draft.name;
  const files = draft.files.map(x => {
    if (x.generated || x.readOnly || !Object.prototype.hasOwnProperty.call(changed, x.path)) return x;
    const c = text(changed[x.path]);
    return c.trim() ? {...x, content: c.endsWith("\n") ? c : c + "\n"} : x;
  });
  if (draft.kind === "lwc") {
    for (const [path, content] of Object.entries(changed)) {
      if (files.some(x => x.path === path) || !text(content).trim()) continue;
      const res = new RegExp(`^lwc/${name}/${name}\\.(html|js|css|svg)$`).exec(path);
      const cls = /^classes\/([A-Za-z][A-Za-z0-9_]{0,39})\.cls$/.exec(path);
      const meta = files.findIndex(x => x.generated);
      if (res) files.splice(meta < 0 ? files.length : meta, 0, {path, format: res[1], lang: res[1] === "js" ? "js" : res[1] === "css" ? "css" : "markup", content: text(content)});
      else if (cls) files.push({path, format: "apex", role: "apex", name: cls[1], lang: "apex", content: text(content)});
    }
  }
  return {...draft, files};
}
