# SaralForce 2.0 — Feature Guide

A complete, tool-by-tool reference of everything SaralForce can do: what you can **see**,
what you can **change**, how to do it, and where the limits are.

> **Legend**
> 👁 = read-only (looks, never changes the org) · ✏️ = changes data or setup in the org ·
> ✨ = uses AI (needs your own provider key in Settings) · 🔒 = asks for confirmation first

---

## Contents

1. [Getting around](#1-getting-around)
2. [AI Object Builder](#2-ai-object-builder)
3. [Records](#3-records)
4. [SOQL](#4-soql)
5. [Run Apex](#5-run-apex)
6. [Export](#6-export)
7. [Import](#7-import)
8. [Logs](#8-logs-debug-logs)
9. [API Explorer](#9-api-explorer)
10. [Code Coverage](#10-code-coverage)
11. [Users](#11-users)
12. [Access](#12-access) — Compare · Risky access · Approvals
13. [Metadata](#13-metadata) — Apex · Triggers · Visualforce · LWC · Aura · Flows · Validation Rules · Custom Metadata · Schema · New · package.xml
14. [Org Info](#14-org-info)
15. [App Tab Manager](#15-app-tab-manager)
16. [Settings & AI providers](#16-settings--ai-providers)
17. [Safety, privacy and limits](#17-safety-privacy-and-limits)
18. [Quick "can I…?" answers](#18-quick-can-i-answers)

---

## 1. Getting around

| Feature | What it does |
|---|---|
| **Launcher button** | A floating SaralForce button on every Salesforce page opens the side panel. A one-time tip points it out on your first visit. |
| **Two-row tool bar** | Top row = Records, SOQL, Run-Apex, Export, Import, API Explorer, Logs, Users. Bottom row = Access, Metadata, Org Info, App Tab Manager, Code Coverage. Each row stays on one line; tabs tighten as the panel narrows. A glass divider separates them; nothing scrolls sideways. |
| **Header buttons** | **AI Object Builder ⇄ Inspector** switch · **Show / Hide API Names** · **Theme** (System → Light → Dark) · **?** Help menu · user initials. |
| **Show API Names** 👁 | Adds each field's API name next to its label on the Salesforce record page behind the panel. The button changes to *Hide API Names* only once names are actually showing. |
| **Help menu (?)** | Take the tour · Tour this tool · What's new · Open Settings · **Help** (opens the GitHub issues page). |
| **Guided tours** | Welcome tour on first open, a one-tip intro the first time you open each tool, an Object Builder tour, a Settings tour after install, and a "What's new" card after each update. Replay any time from **?**. |
| **Remembers your place** | The last tool, your queries, filters and results are kept when you close and reopen the panel. |
| **Messages come to you** | When an action finishes with a success, warning or error message (e.g. *trace flag created*, an import error), the panel scrolls to it and flashes it once. |
| **Theme** | Follows your device's light/dark setting by default; the header button overrides it. |

---

## 2. AI Object Builder ✨

Design a custom object by describing it in plain English, then deploy it.

| You can | Details |
|---|---|
| Describe an object | e.g. *"support tickets linked to accounts, with priority and status"*. The AI proposes label, API name, every field, data types, required flags, picklist values and Lookup / Master-Detail relationships. |
| **23 field types** | Text, Text Area (plain, long, **rich**), Number, Currency, Percent, Date, Date/Time, **Time**, Checkbox, Picklist, Multi-Select Picklist, Email, Phone, URL, Lookup, Master-Detail, **Formula**, **Roll-Up Summary**, **Auto Number**, **Geolocation** and **Text (Encrypted)**. Picklists can use a **global value set** or depend on a **controlling field**. |
| ✨ **Enhance Prompt** | Turns a one-liner into a full design brief (purpose, fields, volumes, relationships, security). **Accept** or **Discard**. |
| ✨ **Ask AI** (in Plan) | "add a resolution notes field", "make Priority required", "add a rule that Due Date can't be in the past" — the plan updates; nothing is deployed. |
| **Plan mode** | Edit object label, API name, sharing model and every field inline. **⚙** on a field opens its details: length, decimals, picklist values and default, global value set, controlling field with a **dependency matrix**, related object and delete behaviour, formula and return type, roll-up operation, auto-number format, help text and **track history**. |
| **Object settings** | Track field history, reports, activities, search, Chatter feed; **validation rules**, **list views** and a **compact layout** — all created with the object. |
| **Field access** | Who gets read/edit on the new fields: **My profile**, the **tab visibility profiles**, or a **new permission set** (object + field access, assigned to you). Formula, roll-up and auto-number fields get read-only access. |
| ✎ **Edit an existing object** | Load a custom object from the org; its fields are shown read-only and new fields, rules and list views are added beside them. |
| **Build mode** ✏️ | Locks the plan and deploys: creates the object, the fields (controlling picklists before dependents, roll-ups last), field access, page layout, validation rules, list views, compact layout and the tab. |
| Chat history | Earlier designs are saved; reopen or start new. |
| Hand-off | After deploy, jump to **App Tab Manager** to put the new tab into an app. |

---

## 3. Records

Open the record (or list) you are looking at in Salesforce, inside the panel.

| You can | Details |
|---|---|
| 👁 View a record | Detects the record on the current Salesforce page automatically (record Id, object, fields with label, API name, type and value). |
| ↻ **Reload page** | Moved to another record in Salesforce while the panel was open? The button turns blue (*The Salesforce page changed*); click it — or **Refresh** — to load the page you are on now. |
| 👁 Load any object | **Load Object** by API name to see its details: total records, last updated, fields (Standard / Custom). **Refresh** reloads. |
| Quick Overview | Key facts of the record or object at a glance. |
| ✏️ Edit fields in place | Click a value (**Click to edit**), change it, **Save**; unsaved changes are marked. |
| 👁 Show All Data | Every field of the record in a popup (Esc to close), including fields not on the layout; editable there too. |
| 👁 **Related** | Parent records (lookups, with names) and every child list with a record count; expand a list to see the newest 50 and click one to open it. **‹ Back** returns along the trail (e.g. *Account › Contact*). |
| 👁 **History** | Field history as a timeline (who changed what, old → new), when history tracking is on for the object. |
| Export Records | Download the record's fields as CSV. |
| Tooling API | Toggle to open setup records (e.g. a CustomField, Layout, Flow) that only the Tooling API serves — tried automatically when the standard API can't. |
| Open in Salesforce ↗ | Jump to the record in a new tab. |

---

## 4. SOQL

A query workbench with an editor, field explorer and results grid.

| You can | Details |
|---|---|
| Write & run | Syntax-highlighted editor with line numbers. **Ctrl+Enter** runs, **Ctrl+/** formats. |
| **Autocomplete** | Suggestions as you type: objects after `FROM`, fields, relationship paths (`Owner.Profile.Name`, up to 5 levels), child relationships inside sub-queries, `FIELDS(ALL)`, `COUNT()` and clause keywords. Arrow keys move, **Enter/Tab** accepts, **Esc** closes. |
| Field explorer | Fields of the `FROM` object grouped by Standard / Custom / Relationships / Picklist / Formula. Click to insert. **Ctrl+Space** inserts every field. |
| Tooling API / Recycle Bin | Toggles: query setup objects, or include deleted rows (`queryAll`). |
| Results | Sort by any column, search inside results, tick rows, **Download** CSV (ticked rows or all). |
| **Paging** | 300 rows per page with Prev/Next; every fetched row is reachable. |
| **Fetch more rows** | When a query returns more than 20,000 rows, continue from where it stopped (honest "x of y" totals). |
| Show All Data | Click an **Id** to open the full record; ✏️ edit and save from there. |
| History & Saved | Last 20 queries; save queries with a label. |
| ✨ **Write SOQL** | (When *Enable LLM assistance* is ticked) describe what you want — the AI writes a query using your org's real fields and picklist values. **Use & Run**, **Use query** or **Dismiss**. |
| ✨ **Explain** | Plain-words explanation of the query in the editor. |
| ✨ **Suggested fix** | When a query fails, the AI explains the error and proposes a corrected query (**Apply & Run**). |

---

## 5. Run Apex

| You can | Details |
|---|---|
| ✏️ Execute anonymous Apex | Terminal-style editor; **Ctrl+Enter** to run (a second press while running is ignored). **Tab / Shift+Tab** indent and un-indent. |
| Execute Highlighted | Run only the selected lines; error line numbers still point at the right line in the editor. |
| One call, exact log | Runs through the Apex API and gets that run's own debug log back — no trace flag, no guessing which log is yours. Falls back to the REST API when the org blocks it. |
| Log level & timeout | Choose before running. |
| Quick Templates · Saved · Recent scripts | Reuse code. |
| Execution Results | Debug log with event filters, Debug-only view, raw trace, **Download Log**. **Go to line N** jumps to a compile or runtime error. |
| **Limits** | CPU time, SOQL queries, DML, heap and the other governor limits the run used, as bars (amber/red when close). |
| ✨ **Use AI** | Checks code for compile errors before running; shows a suggested fix (**Apply & Run**) or **Run anyway**. |

---

## 6. Export

| You can | Details |
|---|---|
| Build the query | Object picker, Field Explorer (Standard / Custom / Relationship / Formula), editor with autocomplete, **Validate**, **Format Query**, query examples. |
| Preview | **Run Preview** pages through real results with sorting; **Load more from server**. |
| Choose the API | **Data API** (synchronous) or **Bulk API 2.0** for very large exports (job tracking, **Cancel Job**). |
| Output | CSV, Excel or JSON. CSV options: delimiter (comma, semicolon, tab, pipe), line endings, UTF-8 / UTF-8 with BOM (Excel), quoting, date format. |
| Spreadsheet safety | Cells starting with `= + - @` are prefixed so spreadsheets don't run them as formulas. |
| Save Export · history | Saved exports and recent runs per org. |

---

## 7. Import

| You can | Details |
|---|---|
| ✏️ Operations | **Insert, Update, Upsert, Delete** 🔒 (deletes always confirm). |
| Load a CSV | Drag & drop, choose a file, or paste. CSV settings (delimiter, line endings). |
| Field mapping | Auto-suggested, editable, **saveable templates**; External ID for upserts. |
| **Validate Data** | Checks the file before sending; **Download error CSV**. |
| Duplicate check | Optional run before importing. |
| Engines | **Data API** — sObject Collections, up to 200 records per call (live progress, **Stop**). **Bulk API 2.0** — ingest job with live tracking and **Cancel Job**. |
| Result files | Success / Failed / Unprocessed files pulled from Salesforce, with real record Ids for upserts. |

---

## 8. Logs (Debug logs)

| You can | Details |
|---|---|
| ✏️ Trace flags | Create / manage trace flags for a **user** or an **Apex class** for a chosen window. |
| 👁 Load logs | Recent `ApexLog` rows; view, **Download**. |
| Search | Search across every loaded log body. |
| ✏️ Delete 🔒 | Single or **Delete All Logs**. |
| ✨ **AI Quick Analysis** | One click per log: *What happened*, *Errors*, *Debug highlights*, *Next step*. Cached per log; **Re-run** for a fresh answer. |
| ✨ **Ask AI About This Log** | A chat about one log. |

---

## 9. API Explorer

Call any Salesforce REST or SOAP API with your current session.

| You can | Details |
|---|---|
| 👁 / ✏️ REST & Composite | GET, POST, PATCH, PUT, DELETE 🔒 to any path; JSON body with **Format**. Presets for org, data, composite, Tooling and Apex REST calls (API version filled in). |
| SOAP | Partner, Metadata and Apex APIs with a ready envelope; your session is added only when sending. |
| Response | Status, time, size, body and headers; **Copy** or **Download**. Paths inside a JSON response are links — click to GET them. |
| History | The last 30 calls, per org. |

---

## 10. Code Coverage

| You can | Details |
|---|---|
| 👁 Coverage per class/trigger | Covered vs. uncovered lines and %, summary, filter test classes, search. |
| 👁 **Lines** | The class or trigger source with covered lines green and uncovered lines red; **First uncovered line** jumps there. |
| ✏️ Run tests | **Run All Tests** or **Run specific test class**. Live progress per class, **Abort** 🔒, then passed / failed / skipped per method. |
| Failures | Message and stack trace for each failing method, failures first. |
| ✨ **Explain failure** | Why the test failed, where, and how to fix it — using the test method and the code under test. |

---

## 11. Users

Search, inspect and manage users.

### 11.1 Find users

| You can | Details |
|---|---|
| **Live search** | Type a name, username, email or alias — the list narrows on every keystroke and the whole org is searched after a short pause. **Esc** clears. |
| Filters | By **Profile** and **Role**. Paged list with Active / Inactive badges. |

### 11.2 Inspect a user (detail sub-tabs) 👁

| Sub-tab | Shows |
|---|---|
| **Details** | User information, account & login, recent **login IP**, Is Active, **Is Frozen**. |
| **Permission Sets** | Every directly assigned permission set and permission set group (labelled *Set* / *Group*). |
| **Access Check** | *Why does this user have access?* — see 11.4. |
| **Groups** | Public groups and queues the user belongs to. |
| **Profiles** / **Roles** | The profile and role (with Ids). |
| **Settings** | Language, time zone, locale, email encoding, active flag. |

### 11.3 Change a user ✏️

| Action | Details |
|---|---|
| **Assign** a permission set or group | Pick from the dropdown on **Permission Sets** → **Assign**. Already-assigned ones are hidden. |
| **Remove** a permission set or group 🔒 | **×** next to it; asks first, takes effect immediately. |
| **Login As** | Opens Salesforce logged in as that user (needs "Login as any user" enabled in the org). |
| **Login to Experience Site** | For community users, when live sites exist. |
| **Freeze / Unfreeze** 🔒 | Blocks or restores login. You cannot freeze yourself. |
| **Reset Password** 🔒 | Sends Salesforce's password-reset email. |
| **Enable Logs** | 30-minute debug trace for the user. |
| **Clone User** | Wizard: choose what to copy (profile, role, permission sets **and permission set groups**, public groups/queues), enter the new user's details, confirm, create. |
| Copy Id · View in Salesforce | Quick links. |

### 11.4 Access Check — "why can this user see it?" 👁

Pick what to check, type it, **Check**:

| Check | Answers | Example |
|---|---|---|
| **Object** | Read / Create / Edit / Delete / View All / Modify All — and **which** profile, permission set or group grants each. | `Account` |
| **Field** | Read / Edit and the sources. | `Account.AnnualRevenue` |
| **System permission** | Whether the user has it and from where. | `PermissionsModifyAllData` |

It looks at the user's profile **plus** every permission set and permission set group
they hold, shows the **effective** result (✓ / ✗ per permission) and lists each source.

> **Note** — Users lets you *check* object, field and system permissions and *change*
> which permission sets / groups a user has. Editing the object or field permissions
> **inside** a profile or permission set is done in Salesforce Setup (use **Access →
> Compare** to see exactly what each one grants).

---

## 12. Access

A small menu at the top: **Compare · Risky access · Approvals**.

### 12.1 Compare 👁

| You can | Details |
|---|---|
| Pick 2–5 items | Any mix of **profiles**, **permission sets** and **permission set groups**. |
| Side-by-side matrix | **System permissions** (✓ per item) · **Object permissions** shown as letters R C E D V M (Read, Create, Edit, Delete, View All, Modify All) · **Tab settings** (Visible / Available) · **Assigned apps**. |
| Only differences | Hide rows where all items agree (on by default). |
| Filter | Find a permission or object by name. |
| Download CSV | The whole matrix. |

### 12.2 Risky access 👁 ✨

| You can | Details |
|---|---|
| **Run check** | Finds **active** users holding powerful permissions: Modify All Data, View All Data, Manage Users, Author Apex, Customize Application, Manage Profiles & Permission Sets, Assign Permission Sets, Reset Passwords, View Setup, Export Reports. |
| Per permission | How many users hold it and which profiles / permission sets grant it. |
| Per user | Users ranked by how many risky permissions they hold, and via what. |
| ✨ **Summarize with AI** | A short report: summary, highest risks, who to review, next steps. |

### 12.3 Approvals ✏️

| You can | Details |
|---|---|
| Status banner | *"No pending approvals — you're all caught up!"* or *"N approvals waiting for you"*. |
| **Assigned to me** | Your inbox — items assigned to you **and** to queues/groups you belong to. Shows record (link ↗), object, approval process, who submitted, days waiting. |
| **All pending in org** | Every pending request and its current approver (admin view). |
| **Submitted by me** | Your recent submissions with status (Pending / Approved / Rejected). |
| **Approve / Reject** 🔒 | With an optional comment; asks first. |
| **Submit for approval** | Search your *recently viewed* records (or paste a record Id), add a comment, **Submit**. **Open Full Page ↗** opens the record. |
| Refresh · **Open Inbox ↗** | Reload, or open Salesforce's approval list. |

---

## 13. Metadata

Browse, understand, create and change org metadata. Pick a kind from the chips at the
top (each shows a count); **＋ New …** on the right creates one of that kind.

### 13.1 Common to every kind

| You can | Details |
|---|---|
| Search the list | Filter by name or details. Drafts (not yet deployed) appear on top with a **NEW** badge. |
| **Overview** 👁 | A readable summary built from the source (details per kind below). |
| **Source** 👁 | The code with line numbers and highlighting. |
| ✨ **Explain** | Plain-words report: what it does, when it runs, data it touches, risks. |
| **Open in Setup ↗** | Jump to the item in Salesforce Setup (Flow Builder for flows). |
| **＋ package.xml** | Add to the package.xml basket (see 13.12). |
| Copy source | To the clipboard. |
| **⛶ Full screen ↗** | Opens the inspector in its **own browser tab**, straight on this item (same tool, kind and selection), so code and details get the whole screen. Also on drafts in the draft editor. |

### 13.2 Apex classes 👁

**Overview**: access, **sharing mode** (warns when missing), virtual/abstract, test class,
annotations (e.g. `@RestResource`), extends / implements · counters: methods, fields,
**SOQL**, **DML**, callouts, `@AuraEnabled`, invocable, test methods · **method table**
(name, parameters, return type, access, annotations) — **click a method to jump to its
line** · fields & properties · inner classes.

### 13.3 Triggers 👁

**Overview**: the object · all 7 events with the ones it runs on highlighted · handler
classes it calls · trigger context it uses (`Trigger.new`, `oldMap`…) · counters, with a
warning when SOQL/DML sits directly in the trigger.

### 13.4 Visualforce pages 👁

**Overview**: standard controller / controller / extensions, render-as (e.g. PDF),
Lightning stylesheets · components used (with counts) · merge fields shown.

### 13.5 Lightning Web Components (LWC) 👁

**Overview**: where it can be used (**exposed in builders**, targets such as RecordPage,
AppPage, Community), API version, description · **public properties** (`@api`) · **data**
(Apex methods imported, `@wire` adapters) · child components used · behaviour (events
fired, navigation, toasts, Lightning modules).
**Bundle** tab: file tree (html, js, helpers, css, svg, js-meta.xml) with the code beside
it. Long file names wrap; the part that differs is in bold.

### 13.6 Aura components 👁

**Overview**: interfaces implemented, Apex controller · **attributes** table (name, type,
default) · handlers and registered events · controller actions · child components.
**Bundle** tab: component, controller, helper, renderer, style, design, docs, svg.

### 13.7 Flows 👁

| You can | Details |
|---|---|
| **Steps** | **Start** card (what starts it: object, created/updated/deleted, before/after save, entry conditions, schedule) then every element **in order**, numbered, with plain-words details (what it reads, sets, updates, which action) and **where each decision branch goes**. Unconnected elements listed separately. |
| Versions | Switch between versions (active one marked ●). |
| Outline · Metadata JSON | A text outline, or the raw flow metadata. |

### 13.8 Validation rules ✏️ ✨

| You can | Details |
|---|---|
| 👁 Read it | **Blocks the save when this is TRUE** — highlighted formula, the **fields** it uses (with labels; unknown names flagged) and **functions**. **What the user sees** — a preview of the Salesforce error ("We hit a snag…") and which field it shows on. **About** — description and status. |
| **Enable / disable** | The **Active** switch turns the rule on or off immediately. |
| **Edit rule** | Change formula, error message, error field (dropdown of the object's fields) and description → **Save rule**. |
| ✨ **Use AI** | Describe the rule or the change (*"close date can't be in the past when stage is Closed Won"*, *"let admins skip it"*). The AI writes the formula, message, error field and description from the object's real fields and explains when it blocks the save. Review, then save. |
| Managed rules | Rules from managed packages show 🔒 and can't be changed (Salesforce rule). |

### 13.9 Custom Metadata Types ✏️

| You can | Details |
|---|---|
| 👁 Browse types | Every `__mdt` type in the org. |
| 👁 **Records** | All records with **every field value** (like Setup → *Manage Records*), searchable. |
| 👁 **Fields** | Field API name, label, type, required. |
| ✏️ **Edit records in place** | **✎ Edit records** turns the table into an editable grid — change labels, tick/untick checkboxes (e.g. turn a feature flag's `Enabled` on or off), pick picklist values, type numbers/text/dates. Changed cells are highlighted; **✓ Save** writes all changed records at once. |
| ✏️ **＋ New record** | Form built from the type's fields: label, record name (auto-filled), every value, *Protected* option. |
| ✏️ **Delete record** 🔒 | 🗑 on the row; asks first. |
| ✏️ **New Metadata Type** | Label (API name and plural fill in automatically), visibility (Public / Protected / Package-protected), description and **fields** (Text, Checkbox, Number, Percent, Date, Date/Time, Email, Phone, URL, Text Area, Long Text Area; required). |
| Export | **Download CSV** of records · **Copy SOQL** · add the **type** or **single records** to package.xml. |
| Managed records | Records from managed packages are locked 🔒. |

> Custom metadata has no on/off switch of its own — "enabling" usually means changing a
> record's value (for example a checkbox field), which the editable grid does.

### 13.10 Schema (any object) 👁

| You can | Details |
|---|---|
| Fields table | API name, label, type, details (length, precision, required, unique, external Id, lookup target, **formula**, **picklist values**); filter. |
| **Access** (per field) | Which profiles / permission sets can read or edit it. |
| **Where used** (custom fields) | Components that reference it (Apex, layouts, flows…). |
| **Relationships** | Diagram: lookups on the left, child objects on the right; click a box to open that object. |
| **Data quality** | Profiles the newest 200 / 1,000 / 2,000 records: fill rate per field, distinct and most common values, extreme numbers, inactive picklist values and likely duplicates (same name, email, phone…), with a quality score. ✨ **AI review** turns it into top problems and quick wins. One query; nothing is changed. |
| Export | **Download schema JSON**, **Copy SOQL** (all fields), **Open in Object Manager ↗**, add the object to package.xml. |

### 13.11 Create new metadata — **＋ New** ✏️ ✨

Every form validates names before anything is sent. **Create** opens the generated files in
the **draft editor** (nothing is saved to the org yet); **✓ Deploy** creates it in the org.

| Kind | Options | Templates |
|---|---|---|
| **Apex class** | Name, template, API version | Empty, Service, Batch, Queueable, Schedulable, Invocable (for Flow), REST resource, LWC/Aura controller, Test class |
| **Trigger** | Name, object, events (before/after insert/update/delete/undelete), API version | Optional **handler class** (one handler per object, created with it) |
| **Visualforce page** | Name, label, optional standard controller, API version | SLDS-styled page |
| **LWC** | Component name (camelCase), master label, **isExposed**, CSS file, SVG icon, **targets** (searchable multi-select), API version (latest read from your org), description, object & fields for data templates | **Basic card** · **Record details** (record view form) · **Record form** (create/edit with save toasts) · **Data table with search** (also creates the Apex **controller and test class**) · **Quick action** |
| ✨ **Build with AI** | For **LWC, Aura, Apex classes, triggers and Visualforce pages**: describe what you need in plain English; the AI writes the files (and any Apex a component needs) using the chosen object's real fields, checks them, and opens them in the draft editor. | — |
| **Aura component** | Name, label, implements (searchable), API version, style file, object & fields | Basic card · Record details · Quick action · Data table (Apex controller + test) |
| **Flow** | API name, label, type (Autolaunched, **Record-triggered** with object / when / before-or-after save, Screen, Scheduled), description | Saved as a **draft** version to finish in Flow Builder |
| **Validation rule** | Object, name, formula, message, error field, active, description | ✨ **Use AI** writes the rule |
| **Custom Metadata Type** | See 12.9 | — |

**Draft editor**

| You can | Details |
|---|---|
| Edit files | File tree with type icons and a NEW badge; highlighted editor; Tab inserts spaces; changed files marked ●. |
| Drafts are kept | Saved in this browser until deployed or discarded ("Draft saved locally"). |
| ✨ **Ask AI to change** | Describe a change in plain English (e.g. *"add a search box above the table"*); the AI edits the draft's files. |
| ✨ **Fix with AI** | Appears after a failed deploy: sends Salesforce's error to the AI and applies its fix. |
| **Undo AI change** | Puts the draft back as it was before the last AI edit. |
| **✓ Deploy** | Creates everything through the Tooling API (custom metadata through the Metadata API). Apex the component needs is created first; if a bundle step fails, the half-created bundle is removed. |
| **Discard** | Throws the draft away. |

> Salesforce only allows creating **Apex classes and triggers** this way in **sandboxes and
> developer orgs**; in production it refuses and the message says so (use a change set).

### 13.12 package.xml basket

Add any class, trigger, page, component, flow, rule, object, custom metadata type or single
custom metadata record with **＋ package.xml**. The bar at the top shows the count;
**Download package.xml** (sorted, de-duplicated, your API version) or **Clear**.

---

## 14. Org Info 👁

| You can | Details |
|---|---|
| Organization | Name, instance, edition, sandbox/production, customizable objects. |
| Org Limits | Data/file storage and daily API requests as bars; other limits listed. |
| Permission Sets | Counts (total, licensed, groups) and a searchable list. |
| Setup Audit Trail | Newest 200 setup changes, searchable, copy a row. |
| Apex Jobs · Login History | Recent async jobs and logins with status. |
| ✨ **AI Org Hygiene Audit** | Read-only facts (profiles, inactive users, storage, API) → an AI report of risks and next steps. |

---

## 15. App Tab Manager ✏️

| You can | Details |
|---|---|
| Find an app | Pick a Lightning app. |
| Current App Tabs | See, **reorder (↑ ↓)** and remove tabs. |
| Add tabs | Add custom tabs to the app (**Add Tab to App**, **Add & Make Visible**). |
| Visibility | Set tab visibility (Default On / Default Off / Hidden) for chosen **profiles** or **permission sets**; **Visible to me**. |
| From the Object Builder | A newly created object's tab arrives ready to add. |

---

## 16. Settings & AI providers

| Setting | Details |
|---|---|
| Providers | **OpenAI**, **Anthropic Claude**, **Google Gemini**, **OpenRouter**, any **OpenAI-compatible** endpoint. |
| Key & model | Paste your API key (stays in your browser); the model list loads from your key. |
| Without a key | Everything except ✨ features works. |
| Tours | Each tour shows automatically only once; replay any of them from **?**. |

---

## 17. Safety, privacy and limits

- **Your data stays yours** — no accounts, analytics or tracking. Org data goes to your AI
  provider **only** when you press an ✨ button.
- **Confirmations** before destructive or account-level actions: removing permission
  sets, freezing users, resetting passwords, approving/rejecting, deleting records,
  logs or custom metadata, import deletes, job cancels.
- **AI never acts on its own** — every AI result (queries, fixes, formulas, components) is
  shown first; you choose to run, save or deploy.
- **Managed package items** (namespaced rules, records, components) are read-only.
- **Your Salesforce permissions apply** — SaralForce works with your own session; if you
  can't do something in Salesforce, you can't do it here either.
- **Production orgs** — Apex classes/triggers can't be created directly (Salesforce rule).

---

## 18. Quick "can I…?" answers

| Question | Answer |
|---|---|
| See what object permissions a user has? | **Yes** — Users → user → **Access Check** → Object. Shows each permission and where it comes from. |
| See field-level access for a user? | **Yes** — Access Check → Field (`Object.Field`). |
| See who can read/edit a field (all profiles)? | **Yes** — Metadata → Schema → field → **Access**. |
| Change a user's permissions? | **Yes**, by **assigning / removing permission sets and groups** (Users → Permission Sets). Editing a profile's object permissions is done in Setup. |
| Compare two profiles? | **Yes** — Access → **Compare** (up to 5, only differences). |
| Find over-privileged users? | **Yes** — Access → **Risky access**. |
| Approve or reject requests? | **Yes** — Access → **Approvals**. |
| Turn a validation rule on/off? | **Yes** — Metadata → Validation Rules → **Active** switch. |
| Write a validation rule without knowing formulas? | **Yes** — ✨ **Use AI** (in Edit rule or New). |
| Edit custom metadata records? | **Yes** — Metadata → Custom Metadata → **✎ Edit records** (inline, save all). |
| Create a custom metadata type? | **Yes** — Custom Metadata → **＋ New Metadata Type**, with fields. |
| Understand what a flow does? | **Yes** — Metadata → Flows → **Steps** (or ✨ Explain). |
| Create an LWC? | **Yes** — from 5 real templates or ✨ **Build with AI**; edit, then deploy. |
| Build a package.xml? | **Yes** — **＋ package.xml** on any item, then **Download**. |
| Query more than 20,000 rows? | **Yes** — SOQL → **Fetch more rows**, or Export with **Bulk API 2.0**. |
| Use it without an AI key? | **Yes** — only the ✨ features need one. |
| Add fields to an object that already exists? | **Yes** — AI Object Builder → **✎ Edit an existing object**. |
| Create formula, roll-up or dependent picklist fields? | **Yes** — Object Builder → Plan → field **⚙** details. |
| Give a team access to a new object? | **Yes** — Object Builder → Field access → **New permission set** (then assign it in Setup). |
| See why a test failed? | **Yes** — Code Coverage → run tests → failure → ✨ **Explain failure**. |
| See which lines a test does not cover? | **Yes** — Code Coverage → **Lines**. |
| Call a REST or SOAP API directly? | **Yes** — **API Explorer**. |
| Find empty fields and duplicates? | **Yes** — Metadata → Schema → **Data quality**. |
| Walk from an account to its contacts? | **Yes** — Records → Show All Data → **Related**. |
