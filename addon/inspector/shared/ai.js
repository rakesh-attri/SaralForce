import {askAi, askAiJson} from "../../core/llm.js";
import {ffDescribeObject, ffGetObjects} from "./describe.js";
import {pickObjectsForPrompt} from "../../core/soql-complete.js";
import {normalizeBundleReply, checkLwcBundle, bundleForPrompt, mergeRevision} from "../../core/lwc-ai.js";
import {pascalCase, LWC_TARGETS, validateName} from "../../core/metadata-templates.js";
import {normalizeCodeReply, checkCodeBundle, expectedPaths, AI_CODE_KINDS} from "../../core/code-ai.js";

const SOQL_FIX_SYSTEM =
  "You are a Salesforce SOQL expert helping a beginner. " +
  "Rules: SELECT-only queries. Never use SELECT *. Keep or add a LIMIT, " +
  "EXCEPT for aggregate queries (COUNT/SUM/AVG/MIN/MAX) without GROUP BY, which must never have LIMIT. " +
  "Relationship queries use __r with the relationship name, filters use __c field API names. " +
  "Reply with ONLY a JSON object: " +
  '{"explanation": "<plain simple words, 1-2 sentences, no jargon>", "fixedQuery": "<corrected SOQL, single line>"}';

const APEX_CHECK_SYSTEM =
  "You are a Salesforce Apex expert helping a beginner. " +
  "Find compile errors: missing semicolons, unbalanced braces, unknown methods or variables, " +
  "wrong types, bad SOQL syntax. " +
  "Reply with ONLY a JSON object: " +
  '{"ok": true, "error": "", "line": null, "explanation": "", "fixedCode": ""} when the code is fine, ' +
  'or {"ok": false, "error": "<the compile error in plain words>", "line": <number or null>, ' +
  '"explanation": "<1-2 simple sentences a beginner understands>", "fixedCode": "<the FULL corrected code>"}';

// Ask the Options-configured LLM to fix a failing SOQL query.
// Returns {explanation, fixedQuery} — never runs anything itself.
async function suggestSoqlFix(failedQuery, sfError, {signal} = {}) {
  const fromMatch = /\bfrom\s+([a-zA-Z0-9_]+)/i.exec(String(failedQuery || ""));
  let schemaHint = "";
  if (fromMatch) {
    try {
      const d = await ffDescribeObject(fromMatch[1]);
      const names = (d.fields || []).slice(0, 80)
        .map(f => `${f.name} (${f.type})`).join(", ");
      schemaHint = `\nObject "${fromMatch[1]}" fields: ${names}`;
    } catch (e) {
      schemaHint = `\n(Object "${fromMatch[1]}" describe failed: ${e.message})`;
    }
  }
  const parsed = await askAiJson({
    system: SOQL_FIX_SYSTEM,
    user: `Failed SOQL: ${failedQuery}\nSalesforce error: ${sfError}${schemaHint}`,
    validate: o => (o.fixedQuery ? null : "The JSON has no fixedQuery."),
    signal
  });
  return {
    explanation: String(parsed.explanation || "Here is a corrected query."),
    fixedQuery: String(parsed.fixedQuery).trim()
  };
}

const SOQL_FROM_TEXT_SYSTEM =
  "You are a Salesforce SOQL expert. Turn the user's request into ONE valid SOQL query. " +
  "Rules: SELECT-only. Never use SELECT *. Use only objects and field API names from the schema given; " +
  "parent fields use the relationship name (Owner.Name, Account__r.Name), child sub-queries use the child relationship name. " +
  "Use date literals (TODAY, LAST_N_DAYS:30, THIS_YEAR) for relative dates. Add LIMIT 200 unless the user asks for a count or another limit; " +
  "aggregate queries without GROUP BY must never have LIMIT. " +
  "Reply with ONLY a JSON object: " +
  '{"query": "<SOQL, single line>", "explanation": "<one plain sentence describing what it returns>"}';

const SOQL_EXPLAIN_SYSTEM =
  "You are a Salesforce SOQL expert helping an admin. Explain what the query returns in plain words: " +
  "the object, the filters, sorting and limits, and any relationship or sub-query. " +
  "Mention anything that could make it slow or fail (non-selective filters on large objects, missing LIMIT). " +
  "Reply in at most 4 short sentences, no markdown, no code.";

function describeForPrompt(d) {
  const fields = (d.fields || []).slice(0, 150).map(f => {
    let s = `${f.name} (${f.type}`;
    if (f.type === "reference" && f.relationshipName) s += ` → ${(f.referenceTo || []).join("/")} via ${f.relationshipName}`;
    if (f.type === "picklist" && Array.isArray(f.picklistValues) && f.picklistValues.length) {
      s += ": " + f.picklistValues.filter(v => v.active !== false).slice(0, 15).map(v => v.value).join("|");
    }
    return s + ")";
  });
  const kids = (d.childRelationships || []).filter(r => r.relationshipName).slice(0, 30)
    .map(r => `${r.relationshipName} (${r.childSObject})`);
  return `Object ${d.name} fields: ${fields.join(", ")}` +
    (kids.length ? `\nChild relationships of ${d.name}: ${kids.join(", ")}` : "");
}

// Plain English → SOQL. Sends the schema of the objects the request most
// likely means (plus the editor's current FROM object) so the model uses
// real API names. Returns {query, explanation}; never runs anything.
async function soqlFromText(request, {currentObject, signal} = {}) {
  const text = String(request || "").trim();
  if (!text) throw new Error("Describe the records you want first.");
  let objects = [];
  try { objects = await ffGetObjects(); } catch (e) { /* schema hint only */ }
  const picked = pickObjectsForPrompt(text, objects, 2);
  if (currentObject && !picked.includes(currentObject) && picked.length < 2) picked.push(currentObject);
  const schema = [];
  for (const name of picked) {
    try { schema.push(describeForPrompt(await ffDescribeObject(name))); }
    catch (e) { /* skip objects we cannot describe */ }
  }
  const others = objects.filter(o => !picked.includes(o.name)).slice(0, 300).map(o => o.name);
  const parsed = await askAiJson({
    system: SOQL_FROM_TEXT_SYSTEM,
    user: `Request: ${text}\n\n${schema.join("\n\n") || "(no schema matched)"}` +
      (others.length ? `\n\nOther queryable objects: ${others.join(", ")}` : ""),
    validate: o => (/^\s*select\b/i.test(String(o.query || "")) ? null : "The JSON has no SELECT query."),
    signal
  });
  return {
    query: String(parsed.query).trim(),
    explanation: String(parsed.explanation || "")
  };
}

// Plain-words explanation of a SOQL query.
function explainSoql(query, {signal} = {}) {
  const q = String(query || "").trim();
  if (!q) return Promise.reject(new Error("Enter a SOQL query first."));
  return askAi({system: SOQL_EXPLAIN_SYSTEM, user: q.slice(0, 8000), signal});
}

const METADATA_EXPLAIN_SYSTEM =
  "You are a senior Salesforce developer explaining org metadata to an admin. Given one component " +
  "(an Apex class or trigger, a Flow outline, a validation rule, a Visualforce page or a Lightning component), " +
  "write these sections in CAPITALS: WHAT IT DOES, WHEN IT RUNS, DATA IT TOUCHES, RISKS. " +
  "Plain words, short bullet lines, no code blocks, no markdown tables. Say so when something is unclear from the source.";

const VALIDATION_RULE_SYSTEM =
  "You are a Salesforce admin expert writing validation rules. The formula must evaluate to TRUE when the record is INVALID " +
  "(that blocks the save). Use only field API names from the schema given; use ISPICKVAL/TEXT for picklists, ISBLANK for empty " +
  "checks, ISNEW/ISCHANGED/PRIORVALUE where the request implies create or change, $Profile.Name or $Permission for bypasses when asked. " +
  "Keep it as simple as possible. Reply with ONLY a JSON object: " +
  '{"ruleName": "<API name, letters digits underscores>", "formula": "<formula>", "errorMessage": "<message shown to the user>", ' +
  '"errorDisplayField": "<field API name to show the error on, or empty for top of page>", "description": "<one sentence>", ' +
  '"explanation": "<one plain sentence of when it blocks the save>"}';

// Plain English → validation rule for an object. Returns the parsed JSON.
async function validationRuleFromText(objectName, request, {current, signal} = {}) {
  const text = String(request || "").trim();
  if (!text) throw new Error("Describe what the rule should prevent.");
  let schema = "";
  try { schema = describeForPrompt(await ffDescribeObject(objectName)); }
  catch (e) { schema = `(Could not describe ${objectName}: ${e.message})`; }
  const parsed = await askAiJson({
    system: VALIDATION_RULE_SYSTEM,
    user: `Object: ${objectName}\nRequest: ${text}` + (current ? `\nCurrent formula (improve it): ${current}` : "") + `\n\n${schema}`,
    validate: o => (String(o.formula || "").trim() ? null : "The JSON has no formula."),
    signal
  });
  return {
    ruleName: String(parsed.ruleName || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, ""),
    formula: String(parsed.formula).trim(),
    errorMessage: String(parsed.errorMessage || ""),
    errorDisplayField: String(parsed.errorDisplayField || ""),
    description: String(parsed.description || ""),
    explanation: String(parsed.explanation || ""),
  };
}

const LWC_RULES =
  "LWC rules: the HTML root is <template>; the JS is `import { LightningElement, api, wire } from 'lwc'` and " +
  "`export default class <ClassName> extends LightningElement`. Prefer lightning base components (lightning-card, " +
  "lightning-datatable, lightning-record-form, lightning-input, lightning-button) and SLDS utility classes. On record pages " +
  "use `@api recordId` and `@api objectApiName`. Read single records with lightning/uiRecordApi (getRecord, getFieldValue) " +
  "and only add Apex when a query is needed. Apex classes are `public with sharing`, methods `@AuraEnabled(cacheable=true)` " +
  "for reads, use WITH SECURITY_ENFORCED, bind variables, and LIMIT. Import Apex as `import m from '@salesforce/apex/Class.method'`. " +
  "Show errors with lightning/platformShowToastEvent. No innerHTML, eval, <script>, external libraries or hard-coded ids. " +
  "CSS is scoped to the component (use :host). Use only field API names from the schema given.";

const LWC_FROM_TEXT_SYSTEM =
  "You are a senior Salesforce Lightning Web Components developer. Write ONE complete, deployable component from the request. " +
  LWC_RULES + " Reply with ONLY a JSON object: " +
  '{"label": "<master label>", "description": "<one sentence>", "targets": ["lightning__RecordPage", ...], ' +
  '"files": {"html": "<file>", "js": "<file>", "css": "<file or empty>"}, ' +
  '"apex": [{"name": "<ClassName>", "body": "<full class>"}] (or [] when no Apex is needed), ' +
  '"explanation": "<two plain sentences: what it shows and where to add it>"}';

const APEX_RULES =
  "Apex rules: classes are `with sharing` unless the request needs otherwise; bulkify (no SOQL or DML inside loops, work on " +
  "collections); use WITH SECURITY_ENFORCED or Security.stripInaccessible for user-facing reads, bind variables, and LIMIT; " +
  "no hard-coded record ids; triggers stay thin and call a handler class; test classes use @IsTest, @TestSetup data, " +
  "Test.startTest/stopTest and real asserts with messages (aim for full coverage). Visualforce pages start with <apex:page> " +
  "and use lightningStylesheets=\"true\". Aura components start with <aura:component>; controller and helper JS files are " +
  "object literals wrapped in ({ ... }); @AuraEnabled methods are static. Use only field API names from the schema given.";

// What each kind is, for the "write it from a description" prompt.
const CODE_KIND_BRIEF = {
  apex: "an Apex class",
  triggers: "an Apex trigger, with a handler class that holds the logic",
  pages: "a Visualforce page (plus an Apex controller or extension only if the page needs one)",
  aura: "an Aura component (markup, controller JS, helper JS when useful, CSS when useful, and an Apex controller only if data needs a query)",
};

const CODE_FROM_TEXT_SYSTEM =
  "You are a senior Salesforce developer. Write ONE complete, deployable piece of metadata from the request. " + APEX_RULES +
  " Reply with ONLY a JSON object: " +
  '{"files": [{"path": "<one of the allowed paths>", "content": "<the full file>"}], ' +
  '"label": "<short label, or empty>", "description": "<one sentence>", ' +
  '"explanation": "<two plain sentences: what it does and how to use or test it>"}';

const DRAFT_REVISE_SYSTEM =
  "You are a senior Salesforce developer editing a draft before it is deployed. Apply the request (or fix the Salesforce " +
  "deploy error) with the smallest correct change and keep everything else as it is. " + APEX_RULES + " " + LWC_RULES +
  " Reply with ONLY a JSON object: " +
  '{"files": {"<path exactly as given>": "<the FULL new content of that file>"}, "explanation": "<one or two plain sentences>"} ' +
  "Include only files you changed. You may add an Apex class as classes/<Name>.cls or a missing css/svg file of the component.";

async function schemaForRequest(object, request) {
  let names = object ? [object] : [];
  if (!names.length) {
    try { names = pickObjectsForPrompt(request, await ffGetObjects(), 2); } catch (e) { names = []; }
  }
  const parts = [];
  for (const n of names) {
    try { parts.push(describeForPrompt(await ffDescribeObject(n))); } catch (e) { /* schema is a hint only */ }
  }
  return parts.join("\n\n");
}

// Plain English → a whole LWC bundle (html/js/css + Apex when needed).
// Returns {files, label, description, targets, explanation}; files are
// draft files without the js-meta.xml. Never deploys anything.
async function lwcFromText(request, {name, label, object, apiVersion, targets, signal} = {}) {
  const ask = String(request || "").trim();
  if (!ask) throw new Error("Describe the component you want first.");
  if (!/^[a-z][A-Za-z0-9]*$/.test(name || "")) throw new Error("Enter a camelCase component name first, e.g. openCases.");
  const schema = await schemaForRequest(object, ask);
  let files = [];
  const parsed = await askAiJson({
    system: LWC_FROM_TEXT_SYSTEM,
    user: `Component folder name: ${name} (JS class ${pascalCase(name)})` +
      (label ? `\nLabel: ${label}` : "") + (object ? `\nMain object: ${object}` : "") +
      `\nAPI version: ${apiVersion || "latest"}` + (targets && targets.length ? `\nPreferred targets: ${targets.join(", ")}` : "") +
      `\nRequest: ${ask}` + (schema ? `\n\n${schema}` : ""),
    validate: o => {
      files = normalizeBundleReply(o, name);
      const problems = checkLwcBundle(files, name);
      return problems.length ? "Fix these problems: " + problems.join(" ") : null;
    },
    signal
  });
  return {
    files,
    label: String(parsed.label || "").trim(),
    description: String(parsed.description || "").trim(),
    targets: (Array.isArray(parsed.targets) ? parsed.targets : []).filter(t => LWC_TARGETS.includes(t)),
    explanation: String(parsed.explanation || "").trim(),
  };
}

// Plain English → an Apex class, trigger, Visualforce page or Aura
// component (kind: apex | triggers | pages | aura). form gives name,
// object, label, events/template hints. Returns {files, label,
// description, explanation}; never deploys anything.
async function codeFromText(kind, request, form = {}, {signal} = {}) {
  const ask = String(request || "").trim();
  if (!ask) throw new Error("Describe what you want first.");
  if (!CODE_KIND_BRIEF[kind]) throw new Error("AI writing is not available for this kind.");
  const name = String(form.name || "").trim();
  const nameErr = validateName(name, {apex: "apex", triggers: "trigger", pages: "page", aura: "aura"}[kind]);
  if (nameErr) throw new Error("Enter a valid name first: " + nameErr);
  const object = kind === "pages" ? form.controller : form.object;
  const schema = await schemaForRequest(object, ask);
  let files = [];
  const hints = [
    `Kind: ${CODE_KIND_BRIEF[kind]}`,
    `Name: ${name}`,
    object ? `Object: ${object}` : "",
    kind === "triggers" && form.events && form.events.length ? `Preferred events: ${form.events.join(", ")}` : "",
    form.label ? `Label: ${form.label}` : "",
    `API version: ${form.apiVersion || "latest"}`,
    `Allowed paths:\n- ${expectedPaths(kind, name).join("\n- ")}`,
    `Request: ${ask}`,
  ].filter(Boolean).join("\n");
  const parsed = await askAiJson({
    system: CODE_FROM_TEXT_SYSTEM,
    user: hints + (schema ? `\n\n${schema}` : ""),
    validate: o => {
      files = normalizeCodeReply(kind, o, name);
      const problems = checkCodeBundle(kind, files, name, {object: kind === "triggers" ? object : null});
      return problems.length ? "Fix these problems: " + problems.join(" ") : null;
    },
    signal
  });
  return {
    files,
    label: String(parsed.label || "").trim(),
    description: String(parsed.description || "").trim(),
    explanation: String(parsed.explanation || "").trim(),
  };
}

// Change a draft from an instruction, or fix it from a deploy error.
// Returns {draft, changed: [paths], explanation}.
async function reviseDraftFromText(draft, instruction, {error, signal} = {}) {
  const ask = String(instruction || "").trim();
  if (!ask && !error) throw new Error("Describe the change first.");
  const editable = new Set(draft.files.filter(x => !x.generated && !x.readOnly).map(x => x.path));
  let merged = draft;
  let changed = [];
  const parsed = await askAiJson({
    system: DRAFT_REVISE_SYSTEM,
    user: `Kind: ${draft.kind}\nName: ${draft.name}\n` +
      (ask ? `Request: ${ask}\n` : "") + (error ? `Salesforce deploy error to fix: ${error}\n` : "") +
      `\nCurrent files:\n${bundleForPrompt(draft.files)}`.slice(0, 60000),
    validate: o => {
      const files = o && o.files && typeof o.files === "object" ? o.files : null;
      if (!files || !Object.keys(files).length) return "The JSON has no changed files.";
      merged = mergeRevision(draft, files);
      changed = merged.files.filter(x => {
        const before = draft.files.find(y => y.path === x.path);
        return !before || before.content !== x.content;
      }).map(x => x.path).filter(p => editable.has(p) || !draft.files.some(y => y.path === p));
      if (!changed.length) return "None of the returned files changed an editable file of this draft; use the exact paths given.";
      const problems = draft.kind === "lwc" ? checkLwcBundle(merged.files, draft.name, {orgApex: draft.mode === "edit"})
        : AI_CODE_KINDS.includes(draft.kind)
        ? checkCodeBundle(draft.kind, merged.files, draft.name, {object: draft.kind === "triggers" ? (draft.form || {}).object : null})
        : [];
      if (problems.length) return "The result still has problems: " + problems.join(" ");
      return null;
    },
    signal
  });
  return {draft: merged, changed, explanation: String(parsed.explanation || "").trim()};
}

// Plain-words explanation of one metadata component. Never changes anything.
function explainMetadata(kind, name, source, {signal} = {}) {
  const text = String(source || "").slice(0, 15000);
  if (!text.trim()) return Promise.reject(new Error("Nothing to explain: the source is empty."));
  return askAi({system: METADATA_EXPLAIN_SYSTEM, user: `${kind}: ${name}\n\n${text}`, signal});
}

const DATA_QUALITY_SYSTEM =
  "You are a Salesforce admin reviewing data quality for a teammate. From the field profile of a record sample, write " +
  "these sections in CAPITALS: OVERALL (one or two sentences), TOP PROBLEMS (most impactful first), QUICK WINS " +
  "(validation rules, required fields, picklist cleanup, duplicate rules, fields to retire — name the fields). Plain " +
  "words, short bullet lines. It is a sample, so say \"in this sample\" and do not overstate.";

// Plain-words review of a Data quality profile. Never changes anything.
function explainDataQuality(profileText, {signal} = {}) {
  return askAi({system: DATA_QUALITY_SYSTEM, user: String(profileText || "").slice(0, 14000), signal});
}

const TEST_FAILURE_SYSTEM =
  "You are a senior Salesforce developer triaging a failing Apex test for a teammate. From the failure message, " +
  "stack trace and test source, write these sections in CAPITALS: WHY IT FAILED, WHERE (class, method and line), " +
  "HOW TO FIX. Say whether the bug is most likely in the test or in the code under test. Plain words, short bullet " +
  "lines, at most one short code snippet. Say so when the cause is unclear.";

// Plain-words triage of one failing test method. Never changes anything.
function explainTestFailure({className, method, message, stackTrace, testSource, codeSource}, {signal} = {}) {
  const parts = [`Test: ${className}.${method}`, `Failure: ${message || "(no message)"}`, `Stack trace:\n${stackTrace || "(none)"}`];
  if (testSource) parts.push(`Test method source:\n${String(testSource).slice(0, 6000)}`);
  if (codeSource) parts.push(`Code under test (where it failed):\n${String(codeSource).slice(0, 6000)}`);
  return askAi({system: TEST_FAILURE_SYSTEM, user: parts.join("\n\n"), signal});
}

// Ask the Options-configured LLM to review Apex for compile errors BEFORE a run
// (or after Salesforce rejects it). Never executes anything itself.
// Returns {ok, error, line, explanation, fixedCode}.
async function apexAiCheck(sourceCode, serverError, {signal} = {}) {
  const code = String(sourceCode || "").slice(0, 12000);
  const parsed = await askAiJson({
    system: APEX_CHECK_SYSTEM,
    user: serverError
      ? `Salesforce rejected this code with: ${serverError}\n\nApex code:\n${code}`
      : `Apex code:\n${code}`,
    validate: o => (typeof o.ok === "boolean" ? null : "The JSON has no boolean \"ok\"."),
    signal
  });
  return {
    ok: !!parsed.ok,
    error: String(parsed.error || ""),
    line: parsed.line || null,
    explanation: String(parsed.explanation || ""),
    fixedCode: String(parsed.fixedCode || "")
  };
}

// One shared call to the Options-configured LLM (log Quick Analysis, log
// chat, org audit). Throws "NO_LLM_CONFIG" when no provider is set up.
function logsAskLlm(systemPrompt, userText, {signal} = {}) {
  return askAi({system: systemPrompt, user: userText, signal});
}

export {suggestSoqlFix, soqlFromText, explainSoql, explainMetadata, explainDataQuality, validationRuleFromText, lwcFromText, codeFromText, reviseDraftFromText, explainTestFailure, apexAiCheck, logsAskLlm};
