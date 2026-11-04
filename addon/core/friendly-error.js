// Salesforce / network errors → a plain title and what to do next. The raw
// message stays available as "details". Pure.

const RULES = [
  [/NOT_FOUND|requested resource does not exist/i, "Not found in this org",
    "SaralForce couldn't find this item. It may have been deleted, or this page isn't a record (for example a Setup page). Open a record or list view, or load an object by name."],
  [/INVALID_SESSION_ID|Session expired|New access token needed|Unauthorized/i, "Your Salesforce session has expired",
    "Refresh the Salesforce page (and log in again if asked), then try again."],
  [/INSUFFICIENT_ACCESS|insufficient access|Forbidden|not have access|INSUFFICIENT_PRIVILEGES/i, "You don't have access to this",
    "Your profile or permission sets don't allow it. Ask your Salesforce admin for access."],
  [/INVALID_TYPE|sObject type '[^']+' is not supported|not supported/i, "This object can't be used here",
    "Salesforce doesn't allow reading this object through the API, or it isn't enabled in this org."],
  [/INVALID_FIELD|No such column/i, "A field isn't available",
    "One of the fields doesn't exist or isn't visible to you. Check the field name and your field-level access."],
  [/MALFORMED_QUERY|unexpected token/i, "The query has a mistake",
    "Check the query near the word Salesforce points to."],
  [/REQUEST_LIMIT_EXCEEDED|TotalRequests Limit/i, "Salesforce API limit reached",
    "This org used up its API calls for now. Wait a while or ask your admin about the daily limit."],
  [/Network error|Failed to fetch|offline|timed out|timeout/i, "Couldn't reach Salesforce",
    "Check your connection and that the Salesforce tab is still logged in, then try again."],
  [/UNABLE_TO_LOCK_ROW/i, "The record is busy",
    "Someone or something else is updating it. Wait a moment and try again."],
  [/FIELD_CUSTOM_VALIDATION_EXCEPTION/i, "A validation rule blocked the save",
    "Fix the value the rule complains about (see details), then save again."],
  [/REQUIRED_FIELD_MISSING/i, "A required field is empty",
    "Fill in the required field named in the details, then save again."],
  [/DUPLICATE_VALUE|DUPLICATES_DETECTED/i, "This would create a duplicate",
    "A record with the same unique value already exists."]
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
