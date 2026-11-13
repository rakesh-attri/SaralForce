// Access → Sharing settings: Setup's Sharing Settings page, org against org,
// section by section, with what differs in plain words in the last column.
import {
  SHARING_PAGE_PARTS, buildSharingPageMatrix, sharingPageObjects, describeSharingDiff, sharingPageSummary
} from "../../core/sharing-page.js";
import {loadSharingPage} from "../shared/access-data.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {EmptyState} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {useRelease, loadOrgs, orgByHost} from "./release-state.js";
import {orgOptions, OrgTag} from "./release-ui.js";

const h = React.createElement;

function OrgSide({title, host, onHost, orgs, current}) {
  return h("div", {className: "acc-side"},
    h("div", {className: "acc-side-h"}, title),
    h("div", {className: "acc-side-org"},
      h(SearchSelect, {value: host || (current ? current.host : ""), options: orgOptions(orgs),
        onChange: v => onHost(current && v === current.host ? "" : v), ariaLabel: title, className: "acc-org"}),
      h(OrgTag, {org: host ? orgByHost(host) : current})));
}

function Cell({value, empty}) {
  if (!value) return h("span", {className: "acc-none"}, empty);
  return h("span", {className: "acc-tab"}, value);
}

const EMPTY_TEXT = {owd: "Not in this org", settings: "Not set", rules: "Not in this org", sharingSets: "Not in this org", restrictionRules: "Not in this org"};

function SharingCompareCard() {
  const rel = useRelease();
  React.useEffect(() => { if (!rel.orgs && !rel.orgsBusy) loadOrgs(); }, []);
  const orgs = (rel.orgs || []).filter(o => !o.isGit);
  const current = orgs.find(o => o.isCurrent);
  const orgOf = host => host ? orgByHost(host) : current || null;
  const orgName = host => { const o = orgOf(host); return o ? o.name : host || "This org"; };
  const [hostA, setHostA] = useFfSession("access", "shareOrgA", "");
  const [hostB, setHostB] = useFfSession("access", "shareOrgB", "");
  const [parts, setParts] = useFfSession("access", "shareParts", SHARING_PAGE_PARTS.map(p => p[0]));
  const [data, setData] = useFfSession("access", "shareData", null); // {sides, labels, parts, notes}
  const [object, setObject] = useFfSession("access", "shareObject", "");
  const [loading, setLoading] = React.useState("");
  const [error, setError] = React.useState(null);
  const [onlyDiff, setOnlyDiff] = React.useState(true);
  const [term, setTerm] = React.useState("");
  const same = hostA === hostB;

  const compare = async () => {
    setLoading("Reading org-wide defaults and sharing settings…");
    setError(null);
    try {
      const a = orgOf(hostA);
      const b = orgOf(hostB);
      for (const [o, host] of [[a, hostA], [b, hostB]]) if (!o || !o.conn) throw new Error(`Log in to ${host || "this org"} in this browser first (it isn't in your org list).`);
      const status = s => setLoading(s);
      const sides = await Promise.all([loadSharingPage(a.conn, parts, status), loadSharingPage(b.conn, parts, status)]);
      let labels = [orgName(hostA), orgName(hostB)];
      if (labels[0] === labels[1] || labels[0].toLowerCase() === labels[1].toLowerCase()) {
        labels = [a, b].map((o, i) => `${labels[i]} (${o.isSandbox ? "Sandbox" : "Production"})`);
      }
      const notes = sides.flatMap((s, i) => s.notes.map(n => `${labels[i]}: ${n}`));
      setData({sides, labels, parts: [...parts], notes});
      setObject("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading("");
    }
  };

  const all = data ? buildSharingPageMatrix(data.sides, "").filter(s => data.parts.includes(s.key)) : [];
  const sections = data ? buildSharingPageMatrix(data.sides, object).filter(s => data.parts.includes(s.key)) : [];
  const t = term.trim().toLowerCase();
  const shown = sections.map(s => ({...s, rows: s.rows.filter(r => (!onlyDiff || r.differs) &&
    (!t || `${r.key} ${r.label} ${r.group || ""}`.toLowerCase().includes(t)))}));
  const summary = sharingPageSummary(sections);

  // Objects for "Manage sharing settings for", the ones that differ marked;
  // ◀ ▶ step through those, like going page by page in Setup.
  const objOfRow = (s, r) => s.key === "owd" ? r.key : r.group;
  const diffObjs = new Set(all.flatMap(s => s.key === "settings" ? [] : s.rows.filter(r => r.differs).map(r => objOfRow(s, r))));
  const objects = data ? sharingPageObjects(data.sides) : [];
  const objOptions = [{value: "", label: "All objects"},
    ...objects.map(o => ({...o, sub: o.label !== o.value ? o.value : undefined, tag: diffObjs.has(o.value) ? "Differs" : "", tagTone: "warn"}))];
  const diffList = objects.filter(o => diffObjs.has(o.value)).map(o => o.value);
  const step = d => {
    if (!diffList.length) return;
    const i = diffList.indexOf(object);
    const next = i < 0 ? (d > 0 ? 0 : diffList.length - 1) : (i + d + diffList.length) % diffList.length;
    setObject(diffList[next]);
  };

  const exportCsv = () => {
    const [la, lb] = data.labels;
    const cols = ["Section", "Object", "Item", la, lb, "What differs"];
    const rows = [];
    for (const s of sections) {
      for (const r of s.rows) {
        const val = v => Array.isArray(v) ? `Internal: ${v[0] || "—"} · External: ${v[1] || "—"}` : v || "";
        rows.push({Section: s.title, Object: s.key === "owd" ? r.key : r.group || "", Item: r.label,
          [la]: val(r.values[0]), [lb]: val(r.values[1]), "What differs": r.differs ? describeSharingDiff(s.key, r.values, data.labels) : ""});
      }
    }
    downloadText("sharing-settings-compare.csv", toCsv(cols, rows));
  };

  const table = s => {
    const owd = s.key === "owd";
    let lastGroup = null;
    const body = [];
    for (const r of s.rows.slice(0, 1500)) {
      if (r.group && r.group !== lastGroup && !object) {
        lastGroup = r.group;
        body.push(h("tr", {key: "g|" + r.group, className: "acc-group"}, h("td", {colSpan: owd ? 6 : 4}, r.group)));
      }
      body.push(h("tr", {key: r.key, className: r.differs ? "acc-diff" : ""},
        h("td", {title: r.key}, r.label, r.sub && h("div", {className: "acc-th-sub"}, r.sub)),
        owd
          ? r.values.flatMap((v, i) => v
            ? [h("td", {key: i + "i"}, h(Cell, {value: v[0], empty: "—"})), h("td", {key: i + "e"}, h(Cell, {value: v[1], empty: "—"}))]
            : [h("td", {key: i + "n", colSpan: 2}, h("span", {className: "acc-none"}, EMPTY_TEXT.owd))])
          : r.values.map((v, i) => h("td", {key: i}, h(Cell, {value: v, empty: EMPTY_TEXT[s.key]}))),
        h("td", {className: "acc-what"}, r.differs ? describeSharingDiff(s.key, r.values, data.labels) : h("span", {className: "insp-meta"}, "Same"))));
    }
    return h("div", {className: "insp-table-wrap"},
      h("table", {className: "insp-table acc-matrix shr-matrix"},
        h("thead", null,
          h("tr", null,
            h("th", {rowSpan: owd ? 2 : 1}, s.head),
            data.labels.map((n, i) => h("th", {key: i, colSpan: owd ? 2 : 1, className: owd ? "shr-org-h" : ""}, n)),
            h("th", {rowSpan: owd ? 2 : 1, className: "acc-what"}, "What differs")),
          owd && h("tr", null, data.labels.flatMap((n, i) => [
            h("th", {key: i + "i", className: "acc-th-sub"}, "Internal"), h("th", {key: i + "e", className: "acc-th-sub"}, "External")]))),
        h("tbody", null, body)));
  };

  return h("div", {className: "org-card org-card-wide", "data-tour": "access-sharing"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico", "aria-hidden": "true"}, "🔐"),
      h("span", {className: "org-card-t"}, "Compare sharing settings"),
      data && h("div", {className: "audit-actions"}, h("button", {className: "btn btn-secondary btn-sm", onClick: exportCsv}, "Download CSV"))),
    h("div", {className: "sq3-card-sub"},
      "Setup's Sharing Settings page in two orgs side by side: org-wide defaults for internal and external users, the other sharing settings, " +
      "sharing rules, sharing sets and restriction rules, with what differs in the last column."),
    orgs.length < 2 && rel.orgs && h("div", {className: "insp-meta acc-org-hint"},
      "To compare with another org (a sandbox against production), log in to it in another tab of this browser."),
    h("div", {className: "acc-sides"},
      h(OrgSide, {title: "From org", host: hostA, onHost: setHostA, orgs, current}),
      h("div", {className: "acc-vs", "aria-hidden": "true"}, "vs"),
      h(OrgSide, {title: "Compare with org", host: hostB, onHost: setHostB, orgs, current})),
    h("div", {className: "acc-parts"},
      h("span", {className: "rel-org-l"}, "What to compare"),
      SHARING_PAGE_PARTS.map(([id, label]) => h("button", {key: id, type: "button", "aria-pressed": parts.includes(id),
        className: "insp-chip rel-chip" + (parts.includes(id) ? " on" : ""),
        onClick: () => setParts(parts.includes(id) ? parts.filter(x => x !== id) : [...parts, id])},
      (parts.includes(id) ? "✓ " : "") + label))),
    h("div", {className: "acc-run"},
      h("span", {className: "insp-meta"}, same ? "Pick two different orgs." : `${orgName(hostA)} vs ${orgName(hostB)}`),
      h("button", {className: "btn btn-primary btn-sm", disabled: same || !parts.length || !!loading || !rel.orgs, onClick: compare},
        loading ? "Comparing…" : "Compare")),
    loading && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})),
      h("span", {className: "insp-meta"}, loading)),
    error && h("div", {className: "insp-error"}, error),
    !data && !loading && h(EmptyState, {art: "shield", title: same ? "Pick two orgs" : "Ready when you are",
      text: same ? "From org: where you start (a sandbox, say). Compare with org: the one to check against (production)."
        : "Press Compare to read both orgs' sharing settings. Sharing rules, sharing sets and restriction rules come from the Metadata API and take a few seconds."}),
    data && h("div", {className: "acc-toolbar shr-toolbar"},
      h("span", {className: "rel-org-l"}, "Manage sharing settings for"),
      h(SearchSelect, {value: object, options: objOptions, onChange: v => setObject(v || ""), ariaLabel: "Object", className: "shr-object"}),
      h("button", {className: "btn btn-secondary btn-sm", disabled: !diffList.length, title: "Previous object with differences", onClick: () => step(-1)}, "◀"),
      h("button", {className: "btn btn-secondary btn-sm", disabled: !diffList.length, title: "Next object with differences", onClick: () => step(1)}, "▶"),
      h("span", {className: "insp-meta"}, diffList.length ? `${diffList.length} object${diffList.length === 1 ? "" : "s"} differ` : ""),
      h("label", {className: "sq3-check"},
        h("input", {type: "checkbox", checked: onlyDiff, onChange: e => setOnlyDiff(e.target.checked)}),
        h("span", null, "Only differences")),
      h("input", {className: "soql-save-input acc-filter", value: term, placeholder: "filter…", "aria-label": "Filter rows", onChange: e => setTerm(e.target.value)})),
    data && h("div", {className: "acc-summary" + (summary.total ? "" : " same")}, (object ? `${object}: ` : "") + summary.text),
    data && data.notes.length > 0 && h("div", {className: "insp-meta"}, data.notes.join(" · ")),
    data && shown.some(s => !s.rows.length) && h("div", {className: "insp-meta acc-empty-parts"},
      (onlyDiff || term ? "No differences in: " : "Nothing in: ") + shown.filter(s => !s.rows.length).map(s => s.title).join(", ") +
      (object && data.parts.includes("settings") ? " (other settings are org-wide: pick All objects to see them)" : "") + "."),
    data && shown.filter(s => s.rows.length).map(s => h("details", {key: s.key, className: "acc-section", open: true},
      h("summary", null, `${s.title} · ${s.rows.length}`),
      table(s),
      s.key === "owd" && h("div", {className: "insp-meta"},
        "“Grant access using hierarchies” isn't readable through any Salesforce API, so it isn't compared (it is always on for standard objects)."))));
}

export {SharingCompareCard};
