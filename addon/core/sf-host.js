// Which org a Salesforce host belongs to, by its My Domain name. Pure, so the
// background worker and tests share it.
//
//   acme.my.salesforce.com, acme.lightning.force.com, acme--c.vf.force.com → "acme"
//   acme--uat.sandbox.my.salesforce.com, acme--uat--c.sandbox.vf.force.com → "acme--uat"
//   na123.salesforce.com, c.na1.visual.force.com (no My Domain) → null

const SALESFORCE_SUFFIX = /\.(salesforce|force|cloudforce|visualforce|salesforce-setup|salesforce-sites|site|documentforce|sfcrmapps|sfcrmproducts|salesforce-experience)\.(com|mil|cn)$/;
// First labels that name a server or service, not an org.
const NOT_AN_ORG = /^(c|na\d+|cs\d+|eu\d+|ap\d+|um\d+|usa\d+|gs\d+|login|test|help|www|trailhead|developer)$/;

export function myDomainLabel(host) {
  const h = String(host || "").toLowerCase().replace(/^\./, "").replace(/\.mcas\.ms$/, "");
  if (!SALESFORCE_SUFFIX.test(h) || h.split(".").length < 3) return null;
  const parts = h.split(".")[0].split("--");
  if (!parts[0] || NOT_AN_ORG.test(parts[0])) return null;
  // Sandboxes are "<domain>--<sandbox>"; a further part (VF namespace such as "c") is dropped.
  return (/\.sandbox\./.test(h) ? parts.slice(0, 2) : parts.slice(0, 1)).join("--");
}

// True when both hosts belong to the same org's My Domain.
export function sameOrgDomain(a, b) {
  const la = myDomainLabel(a);
  return !!la && la === myDomainLabel(b);
}
