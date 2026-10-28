import {sfConn, apiVersion} from "../../inspector.js";
import {hasValidConfig} from "../../llm/llm-service.js";
import {safeCopyText} from "../../utils.js";
import {isDateOnlyString, parseSfInstant, ensureSfTimeZone} from "../../sf-time.js";
import {kickSfTzFetch, useSfTimeZoneTick, fmtDateTime, fmtNum} from "../shared/format.js";
import {FFBadge} from "../shared/ui.js";
import {logsAskLlm} from "../shared/ai.js";
import {AnalysisReport} from "../shared/analysis-report.js";
import {useFfSession} from "../shared/session-state.js";

const h = React.createElement;

function fmtStorage(mb) {
  if (typeof mb !== "number") return String(mb);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return (gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)) + " GB";
  }
  return Math.round(mb) + " MB";
}

// Relative label for list rows ("just now", "5m ago", "3h ago", "2d ago"),
// falling back to the absolute date past 30 days. Computed per render — the
// lists are static snapshots, no timer re-renders them.
// Uses single-parse SF instant; absolute fallback renders in the SF zone.
function ffAgo(value) {
  if (value == null || value === "") return "";
  kickSfTzFetch();
  if (isDateOnlyString(String(value))) return String(value).slice(0, 10);
  const d = parseSfInstant(value);
  if (!d) return String(value);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return fmtDateTime(value);
}

// ─── Org Info tab ───────────────────────────────────────────
function OrgTab() {
  useSfTimeZoneTick();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [info, setInfo] = useFfSession("org", "info", null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // Prime the SF user time zone first so every fmtDateTime below matches
      // the Salesforce UI for the authenticated user.
      try { await ensureSfTimeZone(sfConn, apiVersion); } catch (e) { /* fallback to browser */ }
      const org = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(
          "SELECT Id, Name, InstanceName, IsSandbox, OrganizationType, TrialExpirationDate, FiscalYearStartMonth, DefaultLocaleSidKey, TimeZoneSidKey FROM Organization LIMIT 1"),
        {useCache: false});
      const limits = await sfConn.rest(`/services/data/v${apiVersion}/limits`);
      let user = null;
      try {
        user = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/me`);
      } catch (e) {
        try {
          const idRes = await fetch("https://" + sfConn.instanceHostname + "/services/oauth2/userinfo", {
            headers: {Authorization: "Bearer " + sfConn.sessionId}
          });
          if (idRes.ok) user = await idRes.json();
        } catch (e2) { /* ignore */ }
      }
      let counts = null;
      try {
        const cRes = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(
            "SELECT COUNT() FROM EntityDefinition WHERE IsCustomizable = true"));
        counts = cRes && typeof cRes.totalSize === "number" ? cRes.totalSize : null;
      } catch (e) { /* ignore */ }

      // Permission sets — best effort, each query failing independently.
      const q = (soql) => sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      const uid = user && (user.user_id || user.Id);
      const [psRes, psgRes, mineRes] = await Promise.all([
        q("SELECT Id, Label, Name, Description, NamespacePrefix, LicenseId, IsOwnedByProfile, CreatedDate " +
          "FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label LIMIT 2000").catch(() => null),
        q("SELECT COUNT() FROM PermissionSetGroup").catch(() => null),
        uid
          ? q("SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = '" + uid + "'").catch(() => null)
          : Promise.resolve(null)
      ]);

      setInfo({
        org: org.records && org.records[0] ? org.records[0] : null,
        limits: limits || null,
        user,
        customObjects: counts,
        permsets: psRes ? {records: psRes.records || [], total: psRes.totalSize || 0} : null,
        permsetGroups: psgRes && typeof psgRes.totalSize === "number" ? psgRes.totalSize : null,
        myPermsets: mineRes && typeof mineRes.totalSize === "number" ? mineRes.totalSize : null
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, []);

  const details = [];
  if (info?.org) {
    const o = info.org;
    if (o.FiscalYearStartMonth) details.push(["Fiscal year starts", o.FiscalYearStartMonth]);
  }
  if (info?.user) {
    const u = info.user;
    details.push(["User", u.preferred_username || u.username || u.Email || u.name || ""]);
    if (u.organization_id) details.push(["Org Id", u.organization_id]);
    if (u.user_id || u.Id) details.push(["User Id", u.user_id || u.Id]);
  }
  if (info?.customObjects != null) details.push(["Customizable objects", fmtNum(info.customObjects)]);

  const limitTiles = [];
  const limitPlain = [];
  if (info?.limits) {
    const L = info.limits;
    // The Limits API returns storage as DataStorageMB/FileStorageMB (MB,
    // requires Manage Users); older orgs/docs may use DataStorage/FileStorage.
    const aliases = [
      ["Data Storage", ["DataStorageMB", "DataStorage"]],
      ["File Storage", ["FileStorageMB", "FileStorage"]],
      ["Daily API requests", ["DailyApiRequests"]],
      ["Daily Bulk API", ["DailyBulkApiRequests", "DailyBulkBatches"]],
      ["Daily Streaming events", ["DailyStreamingApiEvents"]],
      ["Daily Scratch Orgs", ["DailyScratchOrgs"]],
      ["Concurrent Async GET", ["ConcurrentAsyncGet", "ConcurrentAsyncGetReportInstances"]],
      ["Daily Workspace Node Count", ["DailyWorkspaceNodeCount"]]
    ];
    for (const [label, keys] of aliases) {
      let bucket = null;
      let matchedKey = null;
      for (const k of keys) {
        if (L[k] != null) { bucket = L[k]; matchedKey = k; }
      }
      if (bucket && typeof bucket === "object") {
        if (bucket.Max != null) {
          limitTiles.push({
            label,
            max: bucket.Max,
            remaining: bucket.Remaining,
            storage: /MB$/.test(matchedKey)
          });
        } else {
          limitPlain.push([label, JSON.stringify(bucket)]);
        }
      }
    }
  }
  const hasStorage = limitTiles.some(t => t.storage);

  const org = info && info.org;
  const orgRows = [];
  if (org) {
    orgRows.push(["Org Name", org.Name || "Organization"]);
    if (org.InstanceName) orgRows.push(["Instance", org.InstanceName]);
    if (org.OrganizationType) orgRows.push(["Organization Type", org.OrganizationType]);
    if (org.IsSandbox != null) orgRows.push(["Environment", org.IsSandbox ? "Sandbox" : "Production"]);
    if (org.DefaultLocaleSidKey) orgRows.push(["Locale", org.DefaultLocaleSidKey]);
    if (org.TrialExpirationDate) orgRows.push(["Trial ends", fmtDateTime(org.TrialExpirationDate)]);
  }
  for (const [k, v] of details) orgRows.push([k, v]);

  return h("div", {className: "insp-panel"},
    h("div", {className: "insp-card-header"},
      h("div", {className: "insp-card-title"}, "Org Details & Limits"),
      h("div", {className: "insp-card-actions"},
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: loading,
          onClick: load
        }, loading ? "Loading…" : "Refresh org info")
      )
    ),
    error && h("div", {className: "insp-error"}, error),
    info && h("div", {className: "org-grid"},

      // General details — description list, Users-view style
      h("div", {className: "org-card"},
        h("div", {className: "org-card-h"},
          h("span", {className: "org-card-ico"}, "🏢"),
          h("span", {className: "org-card-t"}, "Organization")
        ),
        orgRows.length > 0
          ? h("dl", {className: "org-dl"},
              orgRows.map(([k, v]) =>
                h("div", {key: k, className: "org-dl-row"},
                  h("dt", null, k),
                  h("dd", null, v == null || v === "" ? "—" : String(v))
                )
              )
            )
          : h("div", {className: "insp-empty"}, "No data yet")
      ),

      // Limits — visual progress bars only, no "X remaining" sentences
      h("div", {className: "org-card"},
        h("div", {className: "org-card-h"},
          h("span", {className: "org-card-ico"}, "📈"),
          h("span", {className: "org-card-t"}, "Org Limits")
        ),
        limitTiles.length > 0
          ? limitTiles.map(r => {
              const remaining = r.remaining != null ? r.remaining : r.max;
              let pct, kind;
              if (r.storage) {
                // Storage bars show usage (high = bad); values are MB.
                const used = Math.max(0, r.max - remaining);
                pct = r.max > 0 ? Math.max(0, Math.min(100, Math.round(used / r.max * 100))) : 0;
                kind = pct > 90 ? " crit" : (pct > 70 ? " warn" : "");
              } else {
                pct = r.max > 0 ? Math.max(0, Math.min(100, Math.round(remaining / r.max * 100))) : 100;
                kind = pct > 60 ? "" : (pct > 30 ? " warn" : " crit");
              }
              return h("div", {key: r.label, className: "limit-item"},
                h("div", {className: "limit-label"}, r.label),
                h("div", {className: "limit-bar"},
                  h("div", {className: "limit-fill" + kind, style: {width: pct + "%"}})),
                h("div", {className: "limit-foot"},
                  h("span", null, r.storage
                    ? `${fmtStorage(r.max - remaining)} of ${fmtStorage(r.max)} used`
                    : `${fmtNum(remaining)} / ${fmtNum(r.max)}`),
                  h("span", {className: "limit-pct"}, `${pct}%`))
              );
            })
          : h("div", {className: "insp-empty"}, "No limit data"),
        limitPlain.length > 0 && h("dl", {className: "org-dl"},
          limitPlain.map(([k, v]) =>
            h("div", {key: k, className: "org-dl-row"},
              h("dt", null, k),
              h("dd", null, v)
            )
          )
        ),
        !hasStorage && limitTiles.length > 0 &&
          h("div", {className: "insp-hint-strip", style: {margin: "10px 0 0"}},
            "Data/File storage not returned — requires the Manage Users permission.")
      ),

      // Permission sets — counts + searchable list.
      h(PermSetsCard, {info}),

      // Setup changes (SetupAuditTrail) — newest 200, search + copy.
      h(SetupAuditCard, {info}),

      // Recent async Apex work (AsyncApexJob) — newest 20, status badges.
      h(ApexJobsCard, null),

      // Logins (LoginHistory) — newest 200, status badges + copy.
      h(LoginHistoryCard, {info}),

      // AI hygiene audit — facts gathered on demand, then one LLM call.
      h(AuditCard, {info})
    )
  );
}

function PermSetsCard({info}) {
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(null);
  const ps = info && info.permsets;
  const list = (ps && ps.records) || [];
  const licensed = list.filter(p => p && p.LicenseId).length;

  const stats = [];
  stats.push(["Total", ps ? fmtNum(ps.total) : null]);
  if (info && info.myPermsets != null) stats.push(["Assigned to me", fmtNum(info.myPermsets)]);
  if (ps) stats.push(["Licensed (needs PSL)", fmtNum(licensed)]);
  if (info && info.permsetGroups != null) stats.push(["Permission set groups", fmtNum(info.permsetGroups)]);
  const anyStat = stats.some(([, v]) => v != null);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? list.filter(p => p && (
        (p.Label || "").toLowerCase().includes(needle) ||
        (p.Name || "").toLowerCase().includes(needle)))
    : list;

  const copy = (name) => {
    try { safeCopyText(name); } catch (e) { /* ignore */ }
    setCopied(name);
    setTimeout(() => setCopied(null), 1200);
  };

  return h("div", {className: "org-card"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, "🔐"),
      h("span", {className: "org-card-t"}, "Permission Sets")
    ),
    anyStat
      ? h("dl", {className: "org-dl"},
          stats.map(([k, v]) =>
            h("div", {key: k, className: "org-dl-row"},
              h("dt", null, k),
              h("dd", null, v == null ? "—" : String(v))
            )
          )
        )
      : h("div", {className: "insp-empty"}, "No data yet"),
    list.length > 0 && h("div", {className: "perm-block"},
      h("input", {
        className: "perm-search",
        type: "search",
        placeholder: `Filter ${fmtNum(list.length)} permission sets\u2026`,
        value: filter,
        onChange: (e) => setFilter(e.target.value)
      }),
      h("div", {className: "perm-list"},
        shown.map(p =>
          h("div", {
            key: p.Id || p.Name,
            className: "perm-row",
            title: "Click to copy " + p.Name,
            onClick: () => copy(p.Name)
          },
            h("span", {className: "perm-l"}, p.Label || p.Name),
            p.LicenseId ? h(FFBadge, {kind: "warn"}, "PSL") : null,
            p.NamespacePrefix ? h(FFBadge, {kind: "info"}, "managed") : null,
            h("span", {className: "perm-n"}, copied === p.Name ? "\u2713 copied" : p.Name)
          )
        ),
        shown.length === 0 && h("div", {className: "insp-empty"}, "No matches")
      ),
      ps && ps.total > list.length &&
        h("div", {className: "perm-more"},
          `Showing first ${fmtNum(list.length)} of ${fmtNum(ps.total)}`)
    )
  );
}

// ─── Shared searchable list card (Org Info) ─────────────────────────
// LoginHistory has no traversable `User` relationship (INVALID_FIELD on
// `User.Name`), so we fetch ids only and resolve display names with a
// second query. Best-effort: on failure rows keep their raw ids.
const resolveUserNames = async (rows, idKey) => {
  const ids = [];
  rows.forEach(r => { const id = r[idKey]; if (id && ids.indexOf(id) === -1) ids.push(id); });
  if (!ids.length) return rows;
  try {
    const q = "SELECT Id, Name FROM User WHERE Id IN (" +
      ids.map(i => "'" + i + "'").join(",") + ")";
    const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` + encodeURIComponent(q));
    const map = Object.create(null);
    (res.records || []).forEach(u => { map[u.Id] = u.Name; });
    rows.forEach(r => { r._name = map[r[idKey]] || null; });
  } catch (e) { /* keep raw ids */ }
  return rows;
};

// Fetches one SOQL list on mount (header Refresh re-runs it), then renders
// stats, a filter box and click-to-copy rows. `row(r, {copied, copy})`
// draws each line; `match(r, needle)` does the (already lowercased) filter.
function OrgLogCard({icon, title, soql, placeholder, match, stats, row, emptyText, postFetch, tooling}) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sfConn.rest(`/services/data/v${apiVersion}/${tooling ? "tooling/" : ""}query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      let recs = (res && res.records) || [];
      if (postFetch) recs = await postFetch(recs);
      setRows(recs);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => { load(); }, []);

  const copy = (key, text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const list = rows || [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? list.filter(r => match(r, needle)) : list;

  return h("div", {className: "org-card"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, icon),
      h("span", {className: "org-card-t"}, title),
      h("div", {className: "audit-actions"},
        h("button", {
          className: "field-action-btn",
          disabled: busy,
          onClick: load
        }, busy ? (rows ? "Refreshing…" : "Loading…") : "Refresh"))
    ),
    error && h("div", {className: "insp-error"}, error),
    rows === null && !error &&
      h("div", {className: "insp-status-info"}, "Loading " + title.toLowerCase() + "\u2026"),
    rows !== null && stats && h("dl", {className: "org-dl"},
      stats(rows).map(([k, v]) =>
        h("div", {key: k, className: "org-dl-row"},
          h("dt", null, k),
          h("dd", null, String(v))
        )
      )
    ),
    rows !== null && list.length === 0 &&
      h("div", {className: "insp-empty"}, emptyText || "No records found."),
    rows !== null && list.length > 0 && h(React.Fragment, null,
      h("input", {
        className: "perm-search",
        type: "search",
        placeholder: placeholder(list.length),
        value: filter,
        onChange: (e) => setFilter(e.target.value)
      }),
      h("div", {className: "perm-list"},
        shown.map(r => row(r, {copied, copy})),
        shown.length === 0 && h("div", {className: "insp-empty"}, "No matches")
      ),
      list.length >= 200 &&
        h("div", {className: "perm-more"}, "Showing the newest 200 rows.")
    )
  );
}

// Newest setup changes — the SOQL-visible Setup Audit Trail object.
// Row click opens a detail popup (Esc / overlay-click / × close); the popup
// keeps the copy-row action as a button.
function SetupAuditCard({info}) {
  const me = info && info.user && (info.user.user_id || info.user.Id);
  const nm = (r) => r._name || r.CreatedById || "Unknown user";
  const [detail, setDetail] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const lineOf = (r) => [ffAgo(r.CreatedDate), nm(r), r.Action, r.Section, r.Display]
    .filter(x => x != null && x !== "").join(" | ");
  const copyLine = (text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  React.useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === "Escape") setDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);
  return h(React.Fragment, null,
    h(OrgLogCard, {
      icon: "\ud83d\udcdc",
      title: "Setup Audit Trail",
      soql: "SELECT Id, CreatedDate, CreatedById, Action, Section, Display " +
        "FROM SetupAuditTrail ORDER BY CreatedDate DESC LIMIT 200",
      postFetch: (rows) => resolveUserNames(rows, "CreatedById"),
      emptyText: "No setup changes recorded.",
      placeholder: (n) => `Filter ${fmtNum(n)} setup changes\u2026`,
      match: (r, needle) =>
        [nm(r), r.Section, r.Action, r.Display].join(" ").toLowerCase().includes(needle),
      stats: (rows) => [
        ["Total", fmtNum(rows.length)],
        ["Changed by me", fmtNum(rows.filter(r => me && r.CreatedById === me).length)]
      ],
      row: (r) => h("div", {
          key: r.Id || r.Display,
          className: "perm-row",
          title: "Click to view details: " + lineOf(r),
          onClick: () => { setCopied(false); setDetail(r); }
        },
        h("span", {className: "perm-l"}, r.Display || r.Action || "(change)"),
        me && r.CreatedById === me && h(FFBadge, {kind: "info"}, "you"),
        r.Section && h(FFBadge, {kind: "off"}, r.Section),
        h("span", {className: "perm-n"},
          `${ffAgo(r.CreatedDate)} · ${nm(r)}${r.Action ? " · " + r.Action : ""}`)
      )
    }),
    detail && h("div", {
        className: "ff-modal-overlay",
        onMouseDown: (e) => { if (e.target === e.currentTarget) setDetail(null); }
      },
      h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
        h("div", {className: "ff-modal-head"},
          h("div", {className: "ff-modal-title"}, "Setup change details",
            h("span", {className: "ff-modal-sub"},
              ` - ${detail.Section || "Setup"} / ${detail.Action || ""}`)),
          h("button", {className: "ff-modal-x", title: "Close (Esc)",
            onClick: () => setDetail(null)}, "\u00d7")
        ),
        h("div", {className: "ff-modal-body"},
          h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table"},
              h("thead", null,
                h("tr", null, h("th", null, "Field"), h("th", null, "Value"))),
              h("tbody", null,
                [["Change", detail.Display],
                 ["Action", detail.Action],
                 ["Section", detail.Section],
                 ["When", fmtDateTime(detail.CreatedDate)],
                 ["Changed by", nm(detail)],
                 ["Record Id", detail.Id]].map(([k, v]) =>
                  h("tr", {key: k},
                    h("td", null, k),
                    h("td", null, v == null || v === "" ? "(Blank)" : String(v))))
              )
            )
          )
        ),
        h("div", {className: "insp-toolbar"},
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => copyLine(lineOf(detail))},
            copied ? "\u2713 copied" : "Copy row"),
          h("span", {className: "insp-meta"}, "Esc or click outside to close")
        )
      )
    )
  );
}

// Recent async Apex work — AsyncApexJob, newest 20: class, status badge,
// progress and error count. Row click opens a detail popup (Esc / overlay /
// × close) mirroring the Salesforce Apex Jobs page columns.
function ApexJobsCard() {
  const st = (r) => String(r.Status || "");
  const cls = (r) => (r.ApexClass && r.ApexClass.Name) || r.ApexClassId || "(class)";
  const failed = (r) => /^(Failed|Aborted)/i.test(st(r));
  const active = (r) => /^(Processing|Preparing|Queued)/i.test(st(r));
  const prog = (r) => r.TotalJobItems != null && r.TotalJobItems > 0
    ? `${fmtNum(r.JobItemsProcessed || 0)}/${fmtNum(r.TotalJobItems)} items`
    : "";
  const [detail, setDetail] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const lineOf = (r) => [cls(r), st(r) || "?", r.JobType, prog(r),
    r.CreatedDate && fmtDateTime(r.CreatedDate), r.MethodName,
    (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`,
    r.ExtendedStatus].filter(x => x != null && x !== "" && x !== false).join(" | ");
  const copyLine = (text) => {
    try { safeCopyText(text); } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  React.useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === "Escape") setDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);
  return h(React.Fragment, null,
    h(OrgLogCard, {
      icon: "⚡",
      title: "Apex Jobs",
      soql: "SELECT Id, ApexClass.Name, JobType, Status, MethodName, TotalJobItems, " +
        "JobItemsProcessed, NumberOfErrors, CreatedDate, CompletedDate, ExtendedStatus " +
        "FROM AsyncApexJob ORDER BY CreatedDate DESC LIMIT 20",
      emptyText: "No recent Apex jobs.",
      placeholder: (n) => `Filter ${fmtNum(n)} apex jobs\u2026`,
      match: (r, needle) =>
        [cls(r), r.JobType, r.Status, r.MethodName, r.ExtendedStatus]
          .join(" ").toLowerCase().includes(needle),
      stats: (rows) => [
        ["Total", fmtNum(rows.length)],
        ["Failed", fmtNum(rows.filter(failed).length)],
        ["Active", fmtNum(rows.filter(active).length)]
      ],
      row: (r) => {
        const key = r.Id || (r.CreatedDate + "-" + cls(r));
        const bad = failed(r);
        const done = /^Completed/i.test(st(r));
        const kind = bad ? "err" : done ? "ok"
          : /^(Processing|Preparing)/i.test(st(r)) ? "warn"
          : st(r) ? "info" : "off";
        const line = [cls(r), st(r) || "?", r.JobType, prog(r), ffAgo(r.CreatedDate),
          r.MethodName, (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`,
          r.ExtendedStatus].filter(x => x != null && x !== "" && x !== false).join(" | ");
        return h("div", {
          key,
          className: "perm-row",
          title: "Click to view details: " + line,
          onClick: () => { setCopied(false); setDetail(r); }
        },
          h("span", {className: "perm-l"}, cls(r)),
          h(FFBadge, {kind}, st(r) || "?"),
          h("span", {className: "perm-n"},
            [ffAgo(r.CreatedDate), r.JobType, prog(r),
             (r.NumberOfErrors || 0) > 0 && `${r.NumberOfErrors} error(s)`]
              .filter(x => x != null && x !== "" && x !== false).join(" · "))
        );
      }
    }),
    detail && h("div", {
        className: "ff-modal-overlay",
        onMouseDown: (e) => { if (e.target === e.currentTarget) setDetail(null); }
      },
      h("div", {className: "ff-modal", role: "dialog", "aria-modal": "true"},
        h("div", {className: "ff-modal-head"},
          h("div", {className: "ff-modal-title"}, "Apex job details",
            h("span", {className: "ff-modal-sub"},
              ` - ${cls(detail)} / ${st(detail) || "?"}`)),
          h("button", {className: "ff-modal-x", title: "Close (Esc)",
            onClick: () => setDetail(null)}, "\u00d7")
        ),
        h("div", {className: "ff-modal-body"},
          h("div", {className: "insp-table-wrap"},
            h("table", {className: "insp-table"},
              h("thead", null,
                h("tr", null, h("th", null, "Field"), h("th", null, "Value"))),
              h("tbody", null,
                [["Apex Class", cls(detail)],
                 ["Job Type", detail.JobType],
                 ["Status", detail.Status],
                 ["Status Detail", detail.ExtendedStatus],
                 ["Method", detail.MethodName],
                 ["Total Batches", detail.TotalJobItems],
                 ["Batches Processed", detail.JobItemsProcessed],
                 ["Failures", detail.NumberOfErrors],
                 ["Submitted Date", detail.CreatedDate && fmtDateTime(detail.CreatedDate)],
                 ["Completion Date", detail.CompletedDate && fmtDateTime(detail.CompletedDate)],
                 ["Job Id", detail.Id]].map(([k, v]) =>
                  h("tr", {key: k},
                    h("td", null, k),
                    h("td", null, v == null || v === "" ? "(Blank)" : String(v))))
              )
            )
          )
        ),
        h("div", {className: "insp-toolbar"},
          h("button", {className: "btn btn-secondary btn-sm",
            onClick: () => copyLine(lineOf(detail))},
            copied ? "\u2713 copied" : "Copy row"),
          h("span", {className: "insp-meta"}, "Esc or click outside to close")
        )
      )
    )
  );
}

// Recent logins — success/failure badges, IP in the secondary line.
function LoginHistoryCard({info}) {
  const me = info && info.user && (info.user.user_id || info.user.Id);
  const nm = (r) => r._name || r.UserId || "Unknown user";
  const failed = (r) => !/^Success/i.test(r.Status || "");
  return h(OrgLogCard, {
    icon: "\ud83d\udeaa",
    title: "Login History",
    soql: "SELECT Id, UserId, LoginTime, SourceIp, Status, LoginType " +
      "FROM LoginHistory ORDER BY LoginTime DESC LIMIT 200",
    postFetch: (rows) => resolveUserNames(rows, "UserId"),
    emptyText: "No logins recorded.",
    placeholder: (n) => `Filter ${fmtNum(n)} logins\u2026`,
    match: (r, needle) =>
      [nm(r), r.Status, r.SourceIp, r.LoginType]
        .join(" ").toLowerCase().includes(needle),
    stats: (rows) => [
      ["Total", fmtNum(rows.length)],
      ["Failed", fmtNum(rows.filter(failed).length)]
    ],
    row: (r, ctx) => {
      const key = r.Id || (r.LoginTime + "-" + r.UserId);
      const bad = failed(r);
      const line = [ffAgo(r.LoginTime), nm(r), r.Status, r.SourceIp, r.LoginType]
        .filter(x => x != null && x !== "").join(" | ");
      return h("div", {
        key,
        className: "perm-row",
        title: "Click to copy: " + line,
        onClick: () => ctx.copy(key, line)
      },
        h("span", {className: "perm-l"}, nm(r)),
        me && r.UserId === me && h(FFBadge, {kind: "info"}, "you"),
        h(FFBadge, {kind: bad ? "err" : "ok"}, bad ? "Failed" : "Success"),
        h("span", {className: "perm-n"},
          ctx.copied === key
            ? "\u2713 copied"
            : `${ffAgo(r.LoginTime)} · ${r.Status || "?"}${r.SourceIp ? " · " + r.SourceIp : ""}`)
      );
    }
  });
}

// ─── Org hygiene audit: cheap facts → one LLM call → report ────────
const ORG_AUDIT_SYSTEM =
  "You are a senior Salesforce org hygiene auditor reviewing ONE org for a beginner admin. " +
  "You are given a plain-text facts snapshot collected live from the org. " +
  "Reply as plain text with exactly these sections: SUMMARY, ISSUES, NEXT ACTIONS. " +
  "Keep it under 250 words. Base every issue strictly on the facts given — never invent " +
  "numbers, objects or settings that are not in the facts. Call out concrete risks (storage " +
  "pressure, API usage, inactive users, permission sprawl) with the exact numbers from the " +
  "facts. NEXT ACTIONS must be short actionable bullets a beginner can do in Setup.";

// Best-effort extra facts for the audit: inactive users, profile count,
// recent logins. Each query fails independently (read-only COUNT queries).
async function orgAuditFacts(info) {
  const q = (soql) => sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent(soql), {useCache: false});
  const cnt = async (soql) => {
    try {
      const r = await q(soql);
      return r && typeof r.totalSize === "number" ? r.totalSize : null;
    } catch (e) { return null; }
  };
  const [profiles, inactive, neverLoggedIn, psetAssignments] = await Promise.all([
    cnt("SELECT COUNT() FROM Profile"),
    cnt("SELECT COUNT() FROM User WHERE IsActive = false"),
    cnt("SELECT COUNT() FROM User WHERE LastLoginDate = null"),
    cnt("SELECT COUNT() FROM PermissionSetAssignment")
  ]);
  return {profiles, inactive, neverLoggedIn, psetAssignments};
}

// Compact plain-text snapshot handed to the LLM (and shown under the report).
function orgAuditSnapshot(info, facts) {
  const L = (key) => facts && facts[key] != null ? fmtNum(facts[key]) : "unknown";
  const lines = [];
  const o = info && info.org;
  if (o) {
    lines.push(`Org: ${o.Name || "?"} (${o.OrganizationType || "?"}, ` +
      `${o.IsSandbox ? "Sandbox" : "Production"}, instance ${o.InstanceName || "?"})`);
  }
  if (info && info.customObjects != null) {
    lines.push(`Customizable objects: ${fmtNum(info.customObjects)}`);
  }
  lines.push(`Profiles: ${L("profiles")}`);
  lines.push(`Inactive users: ${L("inactive")}`);
  lines.push(`Users who never logged in: ${L("neverLoggedIn")}`);
  const ps = info && info.permsets;
  if (ps) {
    const licensed = ps.records.filter(p => p && p.LicenseId).length;
    lines.push(`Permission sets (non-profile): ${fmtNum(ps.total)} ` +
      `(${fmtNum(licensed)} license-restricted, ${L("psetAssignments")} assignments)`);
  } else {
    lines.push(`Permission sets (non-profile): unknown`);
  }
  if (info && info.permsetGroups != null) lines.push(`Permission set groups: ${fmtNum(info.permsetGroups)}`);
  const lim = info && info.limits;
  if (lim) {
    const pct = (bucket) => {
      if (!bucket || typeof bucket !== "object" || !bucket.Max) return null;
      const used = bucket.Max - (bucket.Remaining != null ? bucket.Remaining : bucket.Max);
      return Math.max(0, Math.min(100, Math.round(used / bucket.Max * 100)));
    };
    const d = pct(lim.DataStorageMB || lim.DataStorage);
    const f = pct(lim.FileStorageMB || lim.FileStorage);
    const a = pct(lim.DailyApiRequests);
    if (d != null) lines.push(`Data storage used: ${d}%`);
    if (f != null) lines.push(`File storage used: ${f}%`);
    if (a != null) lines.push(`Daily API requests used: ${a}%`);
  }
  return lines.join("\n");
}

// Card in the Org Info grid: Run audit → facts → AI report (persisted per session).
function AuditCard({info}) {
  const [running, setRunning] = React.useState(false);
  const [report, setReport] = useFfSession("org", "auditReport", null);
  const [snapshot, setSnapshot] = useFfSession("org", "auditSnapshot", null);
  const [auditErr, setAuditErr] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  const openSettings = () => {
    try {
      chrome.runtime.sendMessage({message: "openOptions", host: ""});
    } catch (e) { /* extension context only */ }
  };

  const run = async () => {
    setAuditErr(null);
    if (!hasValidConfig()) { setAuditErr("NO_LLM_CONFIG"); return; }
    setRunning(true);
    try {
      const facts = await orgAuditFacts(info);
      const snap = orgAuditSnapshot(info, facts);
      setSnapshot(snap);
      const text = await logsAskLlm(ORG_AUDIT_SYSTEM, "Org hygiene facts:\n" + snap);
      setReport({text, at: Date.now()});
    } catch (e) {
      setAuditErr(e.message === "NO_LLM_CONFIG" ? "NO_LLM_CONFIG" : e.message);
    } finally {
      setRunning(false);
    }
  };

  const onCopy = () => {
    try {
      if (report) safeCopyText(report.text);
    } catch (e) { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return h("div", {className: "org-card org-card-wide"},
    h("div", {className: "org-card-h"},
      h("span", {className: "org-card-ico"}, "🩺"),
      h("span", {className: "org-card-t"}, "AI Org Hygiene Audit"),
      h("div", {className: "audit-actions"},
        report && h("span", {className: "audit-at"},
          "Last run " + fmtDateTime(report.at)),
        h("button", {
          className: "btn btn-primary btn-sm",
          disabled: running,
          onClick: run
        }, running ? "Auditing…" : report ? "Run again" : "Run audit")
      )
    ),
    (!hasValidConfig() || auditErr === "NO_LLM_CONFIG") &&
      h("div", {className: "insp-warn"},
        "AI audit needs a provider + API key. ",
        h("button", {className: "field-action-btn", onClick: openSettings}, "Open Settings")),
    auditErr && auditErr !== "NO_LLM_CONFIG" &&
      h("div", {className: "insp-error"}, auditErr),
    running && h("div", {className: "insp-status-info"},
      "Collecting org facts, then asking the AI — usually a few seconds…"),
    report && h(AnalysisReport, {text: report.text, copied, onCopy}),
    report && snapshot &&
      h("details", {className: "audit-details"},
        h("summary", null, "Facts sent to the AI"),
        h("pre", {className: "audit-facts"}, snapshot)),
    !report && !running && !auditErr &&
      h("div", {className: "insp-hint-strip"},
        "Runs read-only counts (profiles, inactive users, storage, API) and asks your AI " +
        "for risks and next steps. Nothing is changed in the org.")
  );
}

export {OrgTab};
