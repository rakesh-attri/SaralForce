import {askAi, askAiJson} from "../../core/llm.js";
import {ffDescribeObject, ffGetObjects} from "./describe.js";
import {pickObjectsForPrompt} from "../../core/soql-complete.js";

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

// Plain-words explanation of one metadata component. Never changes anything.
function explainMetadata(kind, name, source, {signal} = {}) {
  const text = String(source || "").slice(0, 15000);
  if (!text.trim()) return Promise.reject(new Error("Nothing to explain: the source is empty."));
  return askAi({system: METADATA_EXPLAIN_SYSTEM, user: `${kind}: ${name}\n\n${text}`, signal});
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

export {suggestSoqlFix, soqlFromText, explainSoql, explainMetadata, validationRuleFromText, apexAiCheck, logsAskLlm};
