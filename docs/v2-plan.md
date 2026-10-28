# SaralForce v2.0 — Plan (incremental refactor)

_Drafted 2026-10-28. Companion to [v2-discovery.md](v2-discovery.md)._

**Approach:** keep the no-build, native-ES-module setup (pages already load `type="module"`), and refactor in place, phase by phase, shipping something usable after each phase. No framework or bundler change. Node 24 is available locally for dev-only tooling (lint, unit tests), which never ships in `addon/`.

**Reference product:** BoltForce (Chrome Web Store, v5.2.16, 4.5★). Used only as a feature benchmark — we build our own versions, with AI as the differentiator.

---

## Phase 0 — Foundation (≈1 week)

- Work from a git clone of `github.com/rakesh-attri/SaralForce` (the local folder is not a git repo; it matches `main` except two newer `goodbye.html` edits and `privacy.html` on GitHub, and `test/` locally). Branch `v2`.
- Delete stray `System.Drawing.Drawing2D.GraphicsPath`; fix `package.json` (`build` script points to a missing file).
- Dev tooling (dev-only, outside `addon/`): ESLint (flat config, browser + webextension globals), `node --test` unit tests, a `scripts/package.js` that zips `addon/` for Chrome and Edge.
- GitHub Actions: lint + unit tests + package artifact on every PR.
- Create target folders, initially re-exporting from existing files so nothing breaks:
  ```
  addon/
    core/      sf-client.js, llm.js, storage.js, messaging.js, csv.js, xlsx.js, soql.js
    ui/        tokens.css, components.css, primitives.js (Button, Dialog, Confirm, Tabs, Toast, DataGrid), tour.js
    tabs/      soql/, export/, import/, records/, apex/, logs/, users/, org/, app-tabs/, coverage/ …
    builder/   object-builder.js, deploy/, plan-editor.js, prompts/
    shell/     app-shell.js, nav.js, command-palette.js, settings.js
  ```

## Phase 1 — Critical fixes and security (release as v1.7.0, ≈1-2 weeks)

Ship to both stores before the big UI work, so users get the fixes early.

1. Remove the session hand-off through the Salesforce page's `sessionStorage` (`button.js:272`); pass the session only via `chrome.runtime` messaging or a `postMessage` that is origin-checked.
2. Origin/source checks on every `message` listener; replace `postMessage(..., "*")` with explicit target origins; narrow `web_accessible_resources` to what the content script actually needs.
3. Deploy pipeline: a real `failed` status, an always-visible error panel, resume-from-failed-step, no false "Deployment Successful".
4. Name-field contract fix (AutoNumber); `required` for all field types; type whitelist + `Master-Detail`/`MasterDetail` normalization; API-name regex/length/duplicate validation; valid sharing models only.
5. Bulk export: strip repeated headers, handle `Sforce-Locator: "null"`.
6. Confirm dialogs for Reset Password, Freeze/Unfreeze and every destructive action (shared `Confirm` primitive).
7. `inspector.js` `rest()` null-response crash; `background.js` `getSfHost` multi/no-response; single `apiVersion` (no hardcoded `v67.0`).
8. Options: model lists fetched from provider `/models` endpoints (fallback to a curated list including `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), custom model entry, provider-switch model reset, refuse plain-http endpoints; move settings to `chrome.storage.local` (add `storage` permission back, with migration).
9. Verify Metadata SOAP `create`/`checkStatus` on a real org at API 67; switch to `createMetadata`/`upsertMetadata` if needed.

## Phase 2 — Core refactor (≈2-3 weeks)

- **`core/sf-client.js`**: one client for REST, Tooling, Composite/Collections, Bulk 2.0, Metadata SOAP and Partner SOAP: `AbortSignal`, retry with backoff on 503/`REQUEST_LIMIT_EXCEEDED`, consistent 401 handling, describe cache.
- **`core/llm.js`**: replaces the 3 copy-pasted LLM blocks; streaming, cancel, JSON-schema validation of AI output with a repair pass, smart log excerpting (FATAL/EXCEPTION windows instead of the first 12k characters).
- **`core/csv.js` / `xlsx.js`**: one parser/writer (merge the 3 copies), formula-injection guard.
- Split `inspector-tools.js` and `object-creator.js` into the folders above, one tab per module; data-driven tab registry; delete ~700 lines of dead app-assignment code.
- Unit tests for CSV, SOQL helpers, XML builders, proposal validation, API-name generation.

## Phase 3 — UI 2.0 (≈3 weeks)

- **Design tokens** (`ui/tokens.css`): color, spacing, radius, type scale, elevation, as CSS variables for light / dark / system (`prefers-color-scheme`), with no dark flash on load. `prefers-reduced-motion` respected.
- **CSS rebuilt** on tokens, replacing the 9k-line stacked file module by module; target < 3k lines; no hex literals outside tokens.
- **New shell**:
  - Left icon nav rail (Builder, Data, Code, Users & Access, Metadata, Org) instead of the emoji tab strip.
  - Org badge (Prod/Sandbox colour cue) and an org switcher of recently used orgs.
  - Command palette (`Ctrl+K`) for global search across objects, fields, records, metadata and actions.
- **Primitives**: `DataGrid` (virtualized, keyboard sortable, resizable columns, inline edit, multi-select), `Dialog`/`Confirm`, `Tabs` (`role=tablist`), `Toast`, `EmptyState`, `Skeleton`.
- **Accessibility pass**: aria labels on icon buttons, focus rings, `role="alert"` on errors, keyboard navigation everywhere.
- Floating launcher redesign: draggable, remembers position, never covers page controls.

## Phase 4 — Interactive onboarding tour (≈1 week, built on Phase 3 shell)

A dependency-free tour engine (`ui/tour.js`): spotlight overlay + popover anchored to elements tagged `data-tour="…"`; Next / Back / Skip, step dots, `Esc` to close, focus trap, keyboard and screen-reader friendly, reduced-motion aware.

| Trigger | Tour |
|---|---|
| Install (`onInstalled: install`) | **Welcome page** (replaces opening raw Settings): 3 short cards (what SaralForce does, privacy, AI optional) → "Set up AI (optional)" → "Open a Salesforce org" |
| First visit to a Salesforce page | **Launcher coach-mark** on the floating button + `Ctrl+Shift+S` hint (content script, Shadow DOM so SF styles can't break it) |
| First sidebar open | **Main tour (≈7 steps)**: nav rail → AI Object Builder → Enhance Prompt → SOQL + AI fix → Debug Logs AI analysis → Command palette → Settings / Help |
| First open of each tool | **Mini tour (2-3 steps)** per tab, shown once |
| Update (`onInstalled: update`, major/minor) | **What's New** tour highlighting only the changed areas |
| Help menu | "Replay tour", "Tour this tab", "Keyboard shortcuts" |

Progress stored per tour id + version in `chrome.storage.local`; a user can dismiss all tours globally. Tour content lives in one data file, ready for i18n later.

## Phase 5 — New features (waves, ≈5-7 weeks)

Each wave is its own minor release (2.1, 2.2, …) after 2.0 ships the new shell + tour + fixes.

**Wave A — Query & data (benchmark: BoltForce Smart Query Tools)**
- Context-aware SOQL autocomplete (objects, fields, relationship paths like `Account.Owner.Name`, `FIELDS()`).
- Visual query builder (pick fields/filters/order, two-way sync with the editor).
- **AI: natural language → SOQL** using describe data; explain-this-query.
- Results in the new `DataGrid`: paging past 20k rows (honest totals), inline edit, mass update/delete with confirmation, clone records.
- Import parity: sObject Collections batching (200/call), external-ID relationship mapping, saved mappings per object, rollback file for inserts.

**Wave B — Users & access (benchmark: Permission Set Analyzer)**
- Compare 2-5 permission sets / profiles side by side; matrix view (object CRUD, FLS, system perms, tabs, apps).
- Effective user permissions (profile + perm sets + perm set groups), with "why does this user have access to X?".
- Assign / remove permission sets and groups from the Users tab.
- **AI: security audit** summarising over-privileged users and risky system permissions.

**Wave C — Metadata & schema**
- Metadata browser (Apex, triggers, Visualforce, LWC/Aura, Flows with versions, validation rules).
- Object schema viewer with FLS, picklists, formulas, where-used; simple **ER diagram** of an object's relationships.
- One-click Setup links; export `package.xml` / SFDX-friendly schema + queries (VS Code workflow).
- **AI: explain this Flow / this Apex class / this validation rule**.

**Wave D — Dev & ops tools**
- REST / SOAP / Composite API explorer (method, path, body, history).
- Limits monitor with thresholds and history; async job list with abort.
- Test runner: per-method pass/fail, failure triage (**AI**), line-level coverage highlighting; reliable completion via the test job id.
- Run Apex via SOAP `executeAnonymous` (no URL length limit), correct log matching.
- Relationship navigator from any record; field-history viewer.

**Wave E — AI Object Builder 2.0**
- Field types: Formula, Roll-up Summary, AutoNumber, Geolocation, Time, Rich Text, Encrypted, dependent picklists, global value sets.
- Object extras: validation rules, list views, compact layout, history tracking, reports/activities/search flags.
- Full plan editor (picklist values, relatedTo, length/precision), working chat refinement after a proposal, edit existing objects.
- FLS to selected profiles / a generated permission set (not just the running user's profile).
- **AI data-quality analysis**: field fill-rate, duplicates and outliers per object with a plain-English summary.

## Phase 6 — Quality and release

- Playwright smoke tests against a mock-org fixture (extend `test/smoke.html`) + a manual checklist on a Developer Edition org and a sandbox.
- Performance budget: panel open < 500 ms, 50k-row grid scrolls smoothly.
- Store updates for Chrome and Edge: v2.0 listing copy, new screenshots, short promo video of the tour; README "What's New" for 2.0.

## Suggested release train

| Release | Contents |
|---|---|
| 1.7.0 | Phase 1 fixes |
| 2.0.0 | Phases 0-4: refactor, new UI, onboarding tour |
| 2.1 - 2.5 | Feature waves A-E |

## Open decisions

1. Feature-wave order (proposed A → B → C → D → E).
2. Whether a public "Help / Docs" page on the GitHub Pages site should back the tour's "Learn more" links.
3. Minimum Chrome version (88 today; raising to ~120 allows newer CSS such as `:has()` and container queries).
