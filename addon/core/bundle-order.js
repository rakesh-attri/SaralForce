// Deploy-time rules Salesforce enforces on code drafts.

// A bundle's base file must exist before its other files, or the Tooling API
// answers "FIELD_INTEGRITY_EXCEPTION: No base file for markup://c:name":
// LWC → the component's own .js; Aura → the .cmp / .app / .evt / .intf.
const AURA_ORDER = ["APPLICATION", "COMPONENT", "EVENT", "INTERFACE", "TOKENS",
  "CONTROLLER", "HELPER", "RENDERER", "STYLE", "DESIGN", "SVG", "DOCUMENTATION"];

export function bundleCreateOrder(files, kind, name) {
  const list = (files || []).slice();
  if (kind === "lwc") {
    const base = `lwc/${name}/${name}.js`;
    const rank = f => (f.path === base ? 0 : /\.html$/.test(f.path) ? 1 : /\.js$/.test(f.path) ? 2 : 3);
    return list.sort((a, b) => rank(a) - rank(b));
  }
  if (kind === "aura") {
    const rank = f => {
      const i = AURA_ORDER.indexOf(String(f.defType || "").toUpperCase());
      return i < 0 ? AURA_ORDER.length : i;
    };
    return list.sort((a, b) => rank(a) - rank(b));
  }
  return list;
}

// "WITH SECURITY_ENFORCED is no longer supported, use WITH USER_MODE instead"
// (current API versions). Same meaning for reads: enforce the running user's
// object and field access.
const SECURITY_ENFORCED = /\bWITH\s+SECURITY_ENFORCED\b/gi;

export function hasSecurityEnforced(code) {
  return SECURITY_ENFORCED.test(String(code || "")) && !(SECURITY_ENFORCED.lastIndex = 0);
}

export function securityEnforcedToUserMode(code) {
  let count = 0;
  const out = String(code || "").replace(SECURITY_ENFORCED, () => { count++; return "WITH USER_MODE"; });
  return {code: out, count};
}

export function isSecurityEnforcedError(message) {
  return /SECURITY_ENFORCED is no longer supported/i.test(String(message || ""));
}
