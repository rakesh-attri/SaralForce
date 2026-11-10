// Salesforce / network errors → a plain title and what to do next. The raw
// message stays available as "details". Pure.

// Exact Salesforce error codes first, then (anchored) generic phrases, so a
// validation message that happens to say "offline" isn't read as a network error.
const RULES = [
  [/insufficient access rights on cross-reference id/i, "Salesforce refused a reference (not your admin rights)",
    "Something still points at what you are changing. For a flow delete: an active version, paused or waiting runs, queued scheduled-path actions, or metadata that calls the flow. Otherwise the item points at a record, user, queue or template ID the target doesn't have."],
  [/did not run tests in the org/i, "This validation can't be quick deployed",
    "Salesforce only quick-deploys validations that ran tests. Use “Deploy validated package” (no tests needed when there is no Apex), or validate again with Local or Specified tests."],
  [/\bFIELD_CUSTOM_VALIDATION_EXCEPTION\b/, "A validation rule blocked the save",
    "Fix the value the rule complains about (see details), then save again."],
  [/\bREQUIRED_FIELD_MISSING\b/, "A required field is empty",
    "Fill in the required field named in the details, then save again."],
  [/\bDUPLICATE_VALUE\b|\bDUPLICATES_DETECTED\b/, "This would create a duplicate",
    "A record with the same unique value already exists."],
  [/\bUNABLE_TO_LOCK_ROW\b/, "The record is busy",
    "Someone or something else is updating it. Wait a moment and try again."],
  [/\bINVALID_SESSION_ID\b|^Session expired or invalid|^New access token needed/i, "Your Salesforce session has expired",
    "Log in to Salesforce again, then click Reconnect at the top of SaralForce."],
  [/\bREQUEST_LIMIT_EXCEEDED\b|TotalRequests Limit exceeded/i, "Salesforce API limit reached",
    "This org used up its API calls for now. Wait a while or ask your admin about the daily limit."],
  [/\bINSUFFICIENT_ACCESSw*\b|\bINSUFFICIENT_PRIVILEGES\b|^Forbidden\b/, "You don't have access to this",
    "Your profile or permission sets don't allow it. Ask your Salesforce admin for access."],
  [/\bINVALID_TYPE\b|sObject type '[^']+' is not supported/, "This object can't be used here",
    "Salesforce doesn't allow reading this object through the API, or it isn't enabled in this org."],
  [/\bINVALID_FIELD\b|No such column '/, "A field isn't available",
    "One of the fields doesn't exist or isn't visible to you. Check the field name and your field-level access."],
  [/\bMALFORMED_QUERY\b/, "The query has a mistake",
    "Check the query near the word Salesforce points to."],
  [/\bNOT_FOUND\b|^The requested resource does not exist/, "Not found in this org",
    "SaralForce couldn't find this item. It may have been deleted, or this page isn't a record (for example a Setup page). Open a record or list view, or load an object by name."],
  [/^Network error, offline or timeout|^Failed to fetch|^NetworkError\b/, "Couldn't reach Salesforce",
    "Check your connection and that the Salesforce tab is still logged in, then try again."]
];

// "A | Tooling API: A" → "A" (the same message twice reads as noise).
export function cleanDetail(message) {
  const parts = String(message || "").split(/\s*\|\s*Tooling API:\s*/);
  const uniq = [...new Set(parts.map(p => p.trim()).filter(Boolean))];
  return uniq.join(" · ");
}

export function friendlyError(error) {
  const raw = String(error && error.message != null ? error.message : error || "").trim();
  const detail = cleanDetail(raw);
  for (const [re, title, hint] of RULES) if (re.test(raw)) return {title, hint, detail};
  return {title: "Something went wrong", hint: "", detail};
}
