# SaralForce v2.0 — Discovery Report

_Exploration of the v1.6.0 codebase, 2026-10-28. Input for the v2.0 plan. Line numbers refer to v1.6.0._

## 1. Snapshot

| Item | Value |
|---|---|
| Local version | 1.6.0 (`addon/manifest.json`) |
| Chrome Web Store | 1.4.21, updated Oct 27 2026, 726 KiB, no ratings yet |
| Edge Add-ons | live (link in README) |
| Platform | MV3, Chrome/Edge ≥ 88, only permission `cookies` + SF host permissions, optional `https://*/*` for AI |
| Stack | React 18 UMD globals (`h` = createElement), **no build step, no bundler, no TypeScript, no lint, no tests** (only `test/smoke.html` harness) |
| Repo hygiene | not a git repo; `package.json` `build` script points to missing `scripts/build.js`; stray file `System.Drawing.Drawing2D.GraphicsPath` (a misnamed PNG) |

### Code size

| File | Lines | Role |
|---|---|---|
| `addon/inspector-tools.js` | 11,763 | All Inspector tabs |
| `addon/object-creator.css` | 9,002 | Shared styles (5 stacked re-themes) |
| `addon/object-creator.js` | 4,390 | App shell + AI Object Builder + deploy pipeline |
| `addon/button.js` | 866 | Content script: floating button, sidebar iframe, API-names overlay, user card |
| `addon/inspector.js` | 402 | `sfConn` REST/SOAP layer, OAuth PKCE |
| `addon/options.js` | 395 | LLM settings page |
| `addon/llm/*` | ~650 | OpenAI, Claude, Gemini, OpenAI-compatible/OpenRouter adapters |
| `addon/background.js` | 147 | Service worker: session cookie, LLM fetch proxy, tab opening |

## 2. Feature inventory (v1.6.0)

- **AI Object Builder**: natural language → object + fields proposal, Enhance Prompt, Plan/Build editor, deploy via Metadata SOAP (object, fields, FLS, layout, tab, profile tab visibility), record types, "Add to Lightning App" handoff.
- **SOQL**: highlighted editor, field explorer, Tooling / Recycle Bin modes, history/saved, CSV, record detail with inline edit, AI query fix.
- **Export**: Data API + Bulk 2.0 query, CSV/XLSX/JSON with formatting options, saved configs, history.
- **Import**: insert/update/upsert/delete/hardDelete, CSV parsing, auto-mapping, validation, duplicate check, templates, Data API or Bulk 2.0 ingest.
- **Records**: page-context record view/read/edit, related lookups, Tooling fallback.
- **Run Apex**: editor, templates, saved scripts, log level, debug log view, AI pre-check/fix.
- **Debug Logs**: trace flags, log list, search, view/download/delete, AI quick analysis + per-log chat.
- **Users**: search/filter, detail tabs, Login As, freeze, reset password, trace flag, clone wizard.
- **Org Info**: limits, perm sets, audit trail, Apex jobs, login history, AI hygiene audit.
- **App Tab Manager**: add/remove/reorder app tabs, visibility per profile/perm set.
- **Code Coverage**: aggregate coverage, run class / all tests.
- **API Names overlay** on record pages (content script).
- **AI providers**: OpenAI, Claude, Gemini, OpenRouter, OpenAI-compatible (BYO key).

## 3. Verified bugs — prioritized

### Critical / security
1. **Session id leaked to the Salesforce page** — `button.js:271-272` writes the session (`sid`, which is HttpOnly) into the host page's `sessionStorage`, readable by any script on that page. The extension-side read can never succeed anyway (different origin).
2. **Untrusted framing/messaging** — `object-creator.html` is web-accessible to all `*.force.com` / `*.salesforce.com` origins (incl. Experience sites); its `message` listeners don't check `origin`/`source` (`object-creator.js:4347, 4379`), and it posts user/org info to `parent` with `"*"` (`:750`).
3. **Deploy failures display "✓ Deployment Successful"** — failure path sets `deploymentStatus: "complete"` (`object-creator.js:1467`); if the throw happens before any step result, the success banner renders (`:4238`). Error banner lives in the chat panel, which is hidden once a proposal exists (`:3800`).
4. **Redeploy after partial failure silently does nothing** — duplicate pre-check throws (`:1168`) and bug 3 hides it. No rollback / resume; orphan objects remain.

### High
5. **AutoNumber / custom name field never deployed** — `buildObjectXml` reads `objectDef.nameFieldType/nameFieldLabel/displayFormat` (`:1781`) but prompt + plan editor write `object.nameField.{label,type,format}`.
6. **Bulk export CSV corrupted on multi-chunk results** — chunks concatenated with repeated header rows (`inspector-tools.js:2736-2741`); `Sforce-Locator` value `"null"` (string) is also treated as truthy.
7. **Reset Password / Freeze run on one click, no confirm** (`inspector-tools.js:8826`, `8266`, `8290`).
8. **SOQL results freeze on large sets** — O(n²) `indexOf` row selection (`:1931, 2330, 2341`); silent truncation at 20k rows with `totalSize` overwritten (`:87-115`); only 300 rows rendered, no paging.
9. **`required` honored only for Text fields** (`object-creator.js:1823`); relationship type naming mismatch (`Master-Detail` vs `MasterDetail`) passes validation then throws at build time; no type whitelist, each bad field burns 5 retries.
10. **Deprecated Metadata SOAP `create`/`checkStatus`** used at API 67.0 — needs real-org verification; v2 should use `createMetadata`/`upsertMetadata` or `deploy()`.

### Medium
- FLS granted only to the running user's profile while tab visibility defaults to all profiles (`object-creator.js:1958-2008`, `1389`).
- Invalid sharing models offered (`FullAccess`, `ReadWriteTransfer`); `ControlledByParent` missing (`:3958`).
- API-name validation: no regex/40-char/duplicate checks; `suggestApiName` collides on non-ASCII labels; unescaped names in SOQL (`:343, 368, 2712, 1167`).
- Fuzzy profile matching can write tab visibility to the wrong profile (`:2353, 2364`).
- Run Apex sends code via GET URL (~5-8k char real limit) (`inspector-tools.js:9182`); reuses existing TraceFlag ignoring chosen level (`:9218`); may show another request's log (`:9263`); log truncated to first 30k chars, losing FATAL_ERROR tail (`:9430`).
- AI log analysis sends only the first 12k chars (`:10176`).
- Code coverage "done" detection compares server timestamps against client clock and ignores the test job id; no test pass/fail results (`:11217`).
- Data API import = one REST call per row (no sObject Collections) (`:3751`); Bulk result counts break on multi-line fields (`:3866`).
- Long-running polls not cancelled on unmount (`:462`, coverage, log search).
- Dead "Show All Data" button (`:6201`); unreachable "Retry with new name" and `REFINEMENT_PROMPT`; record types enabled after failed deploy.
- `background.js` `getSfHost` may call `sendResponse` multiple times or never (no-match case hangs the button).
- `inspector.js` `rest()` crashes on 401/403 with null response (`xhr.response.length`); org-info query on session start has no `catch`.
- Hardcoded `v67.0` in `button.js:620-628` separate from `apiVersion`.
- Options: provider switch keeps foreign model (e.g. `gpt-4o` under Claude); OpenRouter blank base URL → "not configured"; http endpoints bypass permission check; key stored in plaintext `localStorage`.
- LLM model lists hardcoded and already stale (e.g. Claude list lacks current `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`).

### Low
- CSV export has no formula-injection guard; users list `LIMIT 25`; LIKE searches don't escape `%`/`_`; footer shows "10 of 10 selected" when 0 selected; chat history never pruned across hosts; duplicate listeners from double `initApp`; leftover "ForceForge" branding (`Sforce-Call-Options`, `ForceForge_Layout`, `ff_` keys).

## 4. Code health

- **Monoliths**: `App` class ~3,800 lines; tabs of 900-1,170 lines with 28-40+ state hooks each; ~700 lines of dead app-assignment code in `object-creator.js` (2776, 2850-3547).
- **Duplication**: 2-3 CSV parsers/writers, 3 copies of the LLM call block, 2 highlighters, 3 DebugLevel creators, header/footer duplicated.
- **API layer inconsistency**: Bulk and Metadata SOAP bypass `sfConn` (no shared 401 handling, no AbortSignal, no retry policy).
- **CSS**: 9k lines of stacked restyle passes, `.btn` defined 4×, 1,197 hex literals vs 78 CSS vars, dark mode via 134 override pairs, defaults to dark (flash for light users), no `prefers-color-scheme` / `prefers-reduced-motion`, ~90 dead classes, ad-hoc breakpoints. Options page has no dark theme. SLDS file is just a reset.
- **Accessibility**: tab bar lacks `tablist`/`aria-selected`; icon-only buttons lack `aria-label`; sortable headers not keyboard operable; errors lack `role="alert"`.
- **Performance**: no virtualization, few memoizations, large results pushed into sessionStorage snapshots.
- **Silent failures**: 34 empty `catch` blocks in `inspector-tools.js`.
- **No i18n**, all strings inline.

## 5. Feature gaps / v2.0 opportunities

- **Metadata & schema**: object/field describe explorer (FLS, picklists, formulas, where-used), package.xml builder, metadata retrieve/deploy, Flow list/versions, validation rules & triggers browser, org-to-org compare.
- **Object Builder**: Formula, Roll-up Summary, AutoNumber, Geolocation, Time, Rich Text, Encrypted, dependent picklists, global value sets, validation rules, list views, compact layouts, history tracking, object flags (reports/activities/search); full plan editing (picklist values, relatedTo, length/precision); edit existing objects; rollback/resume.
- **Permissions**: "why does user X have access to Y", perm set/profile compare, FLS matrix, assign/remove perm sets.
- **Data**: virtualized grid with inline edit, SOQL autocomplete, natural-language → SOQL, SOSL, REST explorer, record JSON copy, import via external-ID relationships, sObject Collections batching.
- **Observability**: limits history, EventLogFile browser, Platform Event / CDC subscriber, async job abort, test runner with per-method results and line coverage, smart log excerpting (FATAL/EXCEPTION windows).
- **AI**: model lists fetched from provider APIs, one shared LLM service with streaming + cancellation, explain flow/permission, failed-test triage.

## 6. Architecture direction (for discussion)

- Introduce a lightweight build (e.g. Vite + TypeScript) or at minimum ES-module splitting per tab; data-driven tab registry.
- One `SalesforceClient` (REST, Tooling, Bulk 2.0, Metadata, SOAP) with AbortSignal, retry, 401 handling, versioned API.
- One `LLMService` (shared prompt helpers, JSON schema validation, streaming, cancel).
- New design system: tokens (CSS variables) for light/dark, component primitives (Button, Dialog/Confirm, Tabs, DataGrid, Toast), `prefers-*` support, rebuilt CSS from scratch.
- Security hardening: remove page `sessionStorage` session handoff, origin checks on all `message` listeners, narrow `web_accessible_resources`, `chrome.storage.local` for settings.
- Quality: ESLint, unit tests for parsers/validators/XML builders, Playwright smoke tests against a mock org, CI packaging for Chrome + Edge.
