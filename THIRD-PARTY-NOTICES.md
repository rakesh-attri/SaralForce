# Third-Party Notices (SaralForce)

This project combines original work with code derived from permissively
licensed open-source projects, plus vendored libraries. Each item below
retains its original license terms.

## 1. Salesforce-Inspector-reloaded (MIT)
- Source: https://github.com/tprouvot/Salesforce-Inspector-reloaded
- Copyright (c) 2023 Thomas Prouvot
- License: MIT (see `LICENSE` — the MIT copyright + permission notice applies
  to all copies and substantial portions, as required by the license).
- What we use: the Salesforce session/authentication approach and supporting
  plumbing — OAuth PKCE token flow, `sfConn` REST/SOAP helpers, cookie-based
  session pickup in the service worker, and the extension popup handshake.
  Affected files carry a header pointing back to the upstream project
  (`addon/inspector.js`, `addon/utils.js`, `addon/background.js`).

## 2. React + ReactDOM (MIT)
- Copyright (c) Facebook, Inc. and its affiliates.
- License: MIT. Vendored builds (`addon/react.js`, `addon/react-dom.js`)
  keep their original `@license`/copyright header comments intact, as
  required. Installable from source via `npm install` (see `package.json`).

## 3. Salesforce Lightning Design System — class names only
- Our `addon/styles/slds/slds.css` is a hand-written minimal style subset for
  the extension UI; it is not a copy of Salesforce's SLDS distribution.
- "Salesforce" word marks, the Salesforce cloud logo, and Salesforce Sans
  font files are NOT bundled.

## Trademark note
SaralForce is an independent project by Bhajan Mandali and is not affiliated
with, sponsored, or endorsed by Salesforce, Inc. or by the authors of
Salesforce-Inspector-reloaded. "Salesforce" is used nominatively to describe
interoperability with Salesforce orgs.
