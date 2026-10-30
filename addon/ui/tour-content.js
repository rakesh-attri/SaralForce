// Tour scripts and release notes. Targets use data-tour attributes (or the
// Inspector tab ids), so tours survive styling changes.

const tabStep = (id, title, body) => ({target: `#insp-tab-${id}`, title, body, placement: "bottom"});

export const PANEL_TOUR = {
  id: "panel",
  steps: [
    {title: "Welcome to SaralForce", body: "Your Salesforce toolkit lives in this panel: an AI object builder plus inspector tools for data, code and admin work. This quick tour shows you around. It takes under a minute."},
    {target: "[data-tour=inspector-tabs]", title: "Your tools", body: "Each tab is a tool: Records, SOQL, Run Apex, Export, Import, Users, Access, Metadata, Logs, Org info, App tabs and Code coverage. Click any tab to switch.", placement: "bottom"},
    tabStep("records", "Records", "Shows the record or list you have open in Salesforce: every field, related lookups, and edit in place."),
    tabStep("soql", "SOQL", "Write and run queries with a field explorer and history. If a query fails, AI can explain the error and suggest a fix."),
    tabStep("logs", "Debug logs", "Load debug logs for any user and get a plain-English AI summary of what happened and what went wrong."),
    {target: "[data-tour=builder-btn]", title: "AI Object Builder", body: "Describe the data you want to track in plain English, and the AI drafts a complete custom object with fields that you review and deploy.", placement: "bottom"},
    {target: "[data-tour=api-names]", title: "Show API names", body: "Adds field API names next to the labels on the Salesforce page behind this panel. Click again to hide them.", placement: "bottom"},
    {target: "[data-tour=help]", title: "Help is always here", body: "Replay this tour, get a quick tour of the tool you're on, or see what's new. AI features need your own API key, which you can add in Settings.", placement: "bottom"}
  ]
};

export const BUILDER_TOUR = {
  id: "builder",
  steps: [
    {target: "[data-tour=chat-input]", title: "Describe your object", body: "Say what you want to track, for example \"support tickets linked to accounts, with priority and status\". The AI proposes the object and its fields.", placement: "top"},
    {target: "[data-tour=enhance]", title: "Enhance prompt", body: "Turns a rough one-liner into a detailed design brief before you send it. You can accept or discard the result.", placement: "top"},
    {target: "[data-tour=history]", title: "Your chats", body: "Earlier designs are saved here, so you can come back to one later. New starts a fresh design.", placement: "bottom"},
    {target: "[data-tour=inspector-btn]", title: "Back to the tools", body: "Switch to the inspector tools at any time.", placement: "bottom"}
  ]
};

const TAB_TOURS = {
  records: ["Records", "Open any record or list view in Salesforce and it loads here. Use View, Read-only or Edit mode, and export the fields to CSV."],
  soql: ["SOQL", "Type a query and suggestions appear (Tab or Enter accepts), or add fields from the explorer, then press Ctrl+Enter to run. Turn on Tooling API for setup objects, or Recycle Bin for deleted rows. Click an Id in the results to see the whole record."],
  apex: ["Run Apex", "Run anonymous Apex and read the debug log right below. Select a few lines and use Execute Highlighted to run only those. Limits shows the CPU, queries and DML the run used. With Use AI on, code is checked for compile errors first."],
  export: ["Export", "Build a query or pick an object, preview the rows, then download CSV, Excel or JSON. Bulk API handles very large exports."],
  import: ["Import", "Drop in a CSV, map columns to fields, and validate before you run. Deletes always ask for confirmation, and result files show every success and failure."],
  users: ["Users", "Type to search users as you go. Inspect and assign permission sets, check why a user can see an object or field, log in as a user, or clone one with the same access. Reset, freeze and removals ask before they run."],
  access: ["Access", "Compare up to five profiles or permission sets side by side, audit who holds powerful permissions such as Modify All Data, and work your approval inbox: approve, reject or submit records."],
  metadata: ["Metadata", "Browse Apex, triggers, pages, components, flows, validation rules and custom metadata, read their source, and ask AI to explain them. Schema shows an object's fields, relationships, field access and data quality. Use New to start an Apex class, trigger, page, LWC, Aura component, flow or validation rule from a working template (or describe it and let AI write it), edit it, ask AI for changes, then deploy. Edit opens an existing component the same way and saves it back (Apex classes and triggers: sandboxes and developer orgs only). Add items to a package.xml."],
  api: ["API Explorer", "Send REST, Composite or SOAP requests to this org with your session. Pick a quick request on the left, click any API path in a response to open it, and find past requests in History."],
  logs: ["Debug logs", "Turn on logging for a user, load recent logs, and use AI Quick Analysis for a plain-English summary. Ask AI lets you ask questions about one log."],
  org: ["Org info", "Storage, API limits, recent setup changes and login history at a glance, plus an optional AI hygiene check."],
  apptabs: ["App tabs", "Pick an app, add a tab from one search box, reorder or remove tabs, and choose which profiles or permission sets can see each tab."],
  coverage: ["Code coverage", "Coverage per Apex class, with a filter for test classes. Lines shows which lines are covered. Run tests to see live progress and each failure, and ask AI to explain a failing test."]
};

export function tabTour(tabId) {
  const t = TAB_TOURS[tabId];
  if (!t) return null;
  return {
    id: `tab:${tabId}`,
    steps: [
      {target: `#insp-tab-${tabId}`, title: t[0], body: t[1], placement: "bottom"}
    ]
  };
}

export const SETTINGS_TOUR = {
  id: "settings",
  steps: [
    {title: "Welcome to SaralForce", body: "Thanks for installing. Most tools work right away with your Salesforce login. AI features are optional and use your own API key. Here's how to set them up."},
    {target: "#provider", title: "Pick an AI provider", body: "OpenAI, Anthropic Claude, Google Gemini, OpenRouter, or any OpenAI-compatible endpoint.", placement: "bottom"},
    {target: "#apiKey", title: "Add your API key", body: "Your key stays in your browser and is sent only to the provider you choose.", placement: "bottom"},
    {target: "#model", title: "Choose a model", body: "Pick a suggestion or type any model ID. Refresh list loads the models your key can use.", placement: "bottom"},
    {target: "[data-tour=settings-actions]", title: "Save and test", body: "Save Settings asks for permission to reach the provider. Then use Test Connection to check it works.", placement: "top"},
    {title: "You're ready", body: "Open any Salesforce page and click the SaralForce button on the right edge, or press Ctrl+Shift+S."}
  ]
};

// Highlights per release, shown once after an update (newest first).
export const RELEASE_NOTES = [
  {
    version: "2.1.0",
    title: "What's new in SaralForce 2.1",
    items: [
      "Object Builder 2.0: formula, roll-up, auto number, geolocation, time, rich text and encrypted fields; dependent picklists; validation rules, list views and compact layouts; edit existing objects; field access for profiles or a new permission set.",
      "Run Apex returns the exact debug log of each run, with a Limits view and Go to line for errors.",
      "Test runner: live progress, failures with stack traces, AI explanations, and covered / uncovered lines.",
      "New API Explorer for REST, Composite, Tooling and SOAP calls.",
      "Show All Data: related records and field history. Records follows the Salesforce page with Reload page.",
      "Metadata → Schema → Data quality: fill rates, outliers and duplicates, with an AI review. Messages now scroll into view."
    ]
  },
  {
    version: "2.0.0",
    title: "SaralForce 2.0",
    items: [
      "New Metadata tab: readable overviews of Apex, triggers, pages, LWC and Aura bundles, flows, validation rules and custom metadata, plus New from real templates.",
      "Validation rules: edit in place, switch on or off, and let AI write the formula.",
      "New Access tab: compare profiles and permission sets, audit risky access, and approve or reject requests.",
      "SOQL autocomplete as you type, plain English to SOQL, and paging through every fetched row.",
      "Users: live search, assign or remove permission sets, and a 'why can this user see it?' check.",
      "Flows now read step by step, and tools are grouped in two rows."
    ]
  },
  {
    version: "1.7.0",
    title: "What's new in SaralForce",
    items: [
      "Guided tours: use the ? button to replay them any time.",
      "The panel now follows your device's light or dark theme.",
      "Bulk API imports fixed, and Data API imports send 200 records per call.",
      "AI providers updated for the latest models, with a model list loaded from your key.",
      "Safer by default: confirmations before resets, deletes and aborts."
    ]
  }
];

export function releaseNotesTour(notes) {
  return {
    id: "whats-new",
    steps: notes.map(n => ({
      title: `${n.title} (${n.version})`,
      body: n.items.map(i => `• ${i}`).join("\n")
    }))
  };
}
