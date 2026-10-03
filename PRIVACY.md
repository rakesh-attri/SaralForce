# SaralForce Privacy Policy

SaralForce is an independent project by Bhajan Mandali, not affiliated with
Salesforce, Inc. or any LLM provider.

## What the extension accesses and why

- **Salesforce session cookie (`sid`)**: read on Salesforce pages only, to call
  Salesforce REST/SOAP/Tooling APIs as you — the same way the Salesforce
  Inspector family of tools authenticates. The cookie value is used as your
  API session token and is never transmitted anywhere except Salesforce
  endpoints for your org.
- **Salesforce org data**: queried or modified only when you act (run SOQL,
  browse records, export/import, deploy metadata, manage users, read debug
  logs). Data stays between your browser and your org, except text you
  explicitly send to an AI provider (below).
- **Your LLM API key and settings**: stored only in your browser's local
  storage. Sent only to the provider endpoint you configured (OpenAI,
  Anthropic, Google, or your own OpenAI-compatible base URL).
- **Your prompts and AI replies**: sent to your configured LLM provider to
  generate answers. Only what you type (plus minimal schema context needed
  for the task) is transmitted — never your API keys, never your Salesforce
  session.
- **OAuth tokens** (when you use "Connect with Salesforce"): stored in your
  browser's local storage for your org's host only.

## What we do NOT do

- No analytics, no tracking, no telemetry.
- No remote servers of our own: there is no SaralForce backend — the
  extension talks directly to Salesforce and to your chosen LLM provider.
- We do not sell, share, or disclose your data to anyone.

## Permissions rationale (for store review)

- `cookies`: read the Salesforce `sid` session cookie to authenticate API calls.
- `storage`: persist settings (LLM config) locally.
- Host permissions: Salesforce domains (API access) and LLM provider
  endpoints (chat completions) — nothing else.

Questions: open an issue at https://github.com/rakesh-attri/SaralForce.
