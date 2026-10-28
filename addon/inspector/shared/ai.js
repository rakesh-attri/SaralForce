import {askAi, askAiJson} from "../../core/llm.js";
import {ffDescribeObject} from "./describe.js";

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

export {suggestSoqlFix, apexAiCheck, logsAskLlm};
