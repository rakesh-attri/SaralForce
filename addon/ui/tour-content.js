// Tour scripts and release notes. Targets use data-tour attributes (or the
// Inspector tab ids), so tours survive styling changes.

const tabStep = (id, title, body) => ({target: `#insp-tab-${id}`, title, body, placement: "bottom"});

export const PANEL_TOUR = {
  id: "panel",
  steps: [
    {title: "Welcome to SaralForce", body: "Your Salesforce toolkit lives in this panel: an AI object builder plus inspector tools for data, code and admin work. This quick tour shows you around. It takes under a minute."},
    {target: "[data-tour=inspector-tabs]", title: "Your tools", body: "Each tab is a tool: Records, SOQL, Run Apex, Export, Import, Users, Logs, Org info, App tabs and Code coverage. Click any tab to switch.", placement: "bottom"},
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
  apex: ["Run Apex", "Run anonymous Apex and read the debug log right below. Select a few lines and use Execute Highlighted to run only those. With Use AI on, code is checked for compile errors first."],
  export: ["Export", "Build a query or pick an object, preview the rows, then download CSV, Excel or JSON. Bulk API handles very large exports."],
  import: ["Import", "Drop in a CSV, map columns to fields, and validate before you run. Deletes always ask for confirmation, and result files show every success and failure."],
  users: ["Users", "Search users, inspect permissions and login history, log in as a user, or clone one with the same access. Reset and freeze actions ask before they run."],
  logs: ["Debug logs", "Turn on logging for a user, load recent logs, and use AI Quick Analysis for a plain-English summary. Ask AI lets you ask questions about one log."],
  org: ["Org info", "Storage, API limits, recent setup changes and login history at a glance, plus an optional AI hygiene check."],
  apptabs: ["App tabs", "Add, reorder or remove tabs in a Lightning app, and control which profiles can see them."],
  coverage: ["Code coverage", "Coverage per Apex class, with a filter for test classes. Run tests and watch coverage refresh."]
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
