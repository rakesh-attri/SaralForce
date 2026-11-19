// SandShift → Sandboxes: list, create, clone, refresh, activate / discard and
// delete sandboxes (from production), back them up before a refresh, restore
// after, and walk through the post-refresh checklist (in the sandbox).
import {
  LICENSES, licenseOf, STATUS_GROUPS, sandboxNameError, ageDays, ageTone, staleRows, nextRefresh, statsOf, loginUrl,
  sandboxBody, myDomainOf, matchSandboxOrg, backupMatchesOrg
} from "../../core/sandboxes.js";
import {
  listSandboxes, createSandbox, refreshSandbox, deleteSandbox, setRefreshAction, postCopyClasses, publicGroups,
  backupCandidates, backupSandbox, backupRows, restoreData, checkDeliverability, invalidEmailUsers, fixInvalidEmails,
  scheduledJobs, abortJobs, outsideFlows, deactivate, endpoints, prodUrlSettings, replaceSettingValues, usersOutsideGroup, freezeUsers
} from "../shared/sandbox-api.js";
import {listBackups, deleteBackup, snapshotComponents, usage} from "../shared/release-store.js";
import {runAction} from "../shared/manual-actions.js";
import {setupUrl, queryAll as connQuery} from "../shared/deploy-api.js";
import {membersFromKeys} from "../../core/deploy.js";
import {formatBytes} from "../../core/release-history.js";
import {toCsv, downloadText} from "../shared/csv.js";
import {safeCopyText} from "../../utils.js";
import {FFBadge, EmptyState} from "../shared/ui.js";
import {useFfSession, ffLoadJson, ffSaveJson} from "../shared/session-state.js";
import {SearchSelect} from "../shared/combo.js";
import {confirmDialog} from "../../ui/confirm.js";
import {typedConfirm} from "../../ui/confirm-typed.js";
import {useRelease, setRelease, loadOrgs, orgByHost} from "./release-state.js";
import {CardHead, orgOptions, OrgTag} from "./release-ui.js";

const h = React.createElement;
const fmtDate = ms => (ms ? new Date(ms).toLocaleString(undefined, {year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}) : "—");
const COLS = [["license", "License"], ["status", "Status"], ["last", "Last refresh"], ["age", "Age"], ["description", "Description"], ["url", "Login URL"]];

export function SandboxesView({goTo}) {
  const rel = useRelease();
  React.useEffect(() => { if (!rel.orgs && !rel.orgsBusy) loadOrgs(); }, []);
  const orgs = (rel.orgs || []).filter(o => !o.isGit);
  const prods = orgs.filter(o => !o.isSandbox);
  const [prodHostSaved, setProdHost] = useFfSession("release", "sbxProd", "");
  const prod = orgByHost(prodHostSaved) || prods.find(o => o.isCurrent) || prods[0] || null;
  const [rows, setRows] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const [sel, setSel] = React.useState(new Set());
  const [term, setTerm] = React.useState("");
  const [typeF, setTypeF] = React.useState("all");
  const [statusF, setStatusF] = React.useState("all");
  const [urlStyle, setUrlStyle] = useFfSession("release", "sbxUrl", "enhanced");
  const [hidden, setHidden] = useFfSession("release", "sbxHidden", []);
  const [showCols, setShowCols] = React.useState(false);
  const [staleOff, setStaleOff] = React.useState(false);
  const [form, setForm] = React.useState(null); // {mode: create|clone|refresh, row}
  const [open, setOpen] = React.useState(null); // drawer row id
  const [drawerTab, setDrawerTab] = React.useState("overview");
  const [menu, setMenu] = React.useState(null); // {id, top|bottom, right}: the open ⋯ menu
  // The menu closes on a click elsewhere, Escape or scrolling.
  React.useEffect(() => {
    if (!menu) return undefined;
    const close = e => { if (!(e.target.closest && e.target.closest(".sbx-menu, .sbx-menu-btn"))) setMenu(null); };
    const key = e => { if (e.key === "Escape") setMenu(null); };
    const scroll = e => { if (!(e.target.closest && e.target.closest(".sbx-menu"))) setMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); window.removeEventListener("scroll", scroll, true); };
  }, [menu]);
  const prevStatus = React.useRef(new Map());

  const load = async (quiet = false) => {
    if (!prod) return;
    if (!quiet) { setBusy("Reading sandboxes…"); setError(null); }
    try {
      const list = await listSandboxes(prod.conn);
      // Say when a running copy finishes.
      for (const r of list) {
        const before = prevStatus.current.get(r.id);
        const now = r.process && r.process.group;
        if (before === "processing" && now && now !== "processing") {
          setMsg(now === "activation" ? `${r.name} is copied and waiting for you to activate it.` : `${r.name}: ${r.process.status}.`);
        }
        prevStatus.current.set(r.id, now);
      }
      setRows(list);
    } catch (e) {
      if (!quiet) setError(/INSUFFICIENT_ACCESS|not supported|sObject type/i.test(e.message || "")
        ? `${prod.name} can't list sandboxes: sign in to PRODUCTION as an admin (${e.message})` : e.message);
    } finally {
      if (!quiet) setBusy("");
    }
  };
  React.useEffect(() => { setRows(null); setSel(new Set()); if (prod) load(); }, [prod && prod.host]);
  // Watch running copies.
  const running = (rows || []).some(r => r.process && r.process.group === "processing");
  React.useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [running, prod && prod.host]);

  const work = (label, fn) => async (...a) => {
    setBusy(label); setError(null); setMsg(null);
    try { await fn(...a); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };

  const visible = (rows || []).filter(r => {
    if (typeF !== "all" && r.license !== typeF) return false;
    const g = r.process ? r.process.group : "unknown";
    if (statusF !== "all" && g !== statusF) return false;
    if (statusF === "all" && g === "deleted") return false; // shown with the "Deleted" filter
    const t = term.trim().toLowerCase();
    return !t || `${r.name} ${r.description} ${r.license}`.toLowerCase().includes(t);
  });
  const stats = statsOf(rows || []);
  const stale = staleRows(rows || []);
  const staleDev = stale.filter(r => r.license === "DEVELOPER" || r.license === "DEVELOPER PRO");
  const selected = (rows || []).filter(r => sel.has(r.id));
  const toggle = id => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const url = r => loginUrl(r, {style: urlStyle, prodHost: prod ? prod.host : ""});
  // Columns that drop out as the panel narrows, so the table never scrolls sideways.
  const [boxW, setBoxW] = React.useState(1400);
  const roRef = React.useRef(null);
  // A callback ref, so the observer follows the element however often it mounts.
  const boxRef = React.useCallback(el => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el) return;
    setBoxW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setBoxW(Math.round(e.contentRect.width)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  const tooNarrow = id => (id === "description" && boxW <= 1200) || (id === "url" && boxW <= 1000) || ((id === "last" || id === "age") && boxW <= 700);
  const col = id => !hidden.includes(id) && !tooNarrow(id);
  const span = 2 + ["license", "status", "last", "age", "description", "url"].filter(col).length;

  const csvOf = list => toCsv(["Name", "License", "Status", "Last refresh", "Age (days)", "Description", "Login URL"], list.map(r => ({
    Name: r.name, License: licenseOf(r.license).label, Status: r.process ? r.process.status : "", "Last refresh": fmtDate(r.lastRefresh),
    "Age (days)": ageDays(r) == null ? "" : ageDays(r), Description: r.description, "Login URL": url(r)})));

  // ── Actions ────────────────────────────────────────────────────────
  const doRefresh = async (row, f, {skipConfirm = false} = {}) => {
    const nr = nextRefresh(row);
    if (!skipConfirm) {
      const ok = await typedConfirm({title: `Refresh ${row.name}?`, word: row.name, confirmLabel: "Refresh",
        message: `Everything in ${row.name} is replaced with a new copy of ${prod.name}: its metadata, data, users' passwords and settings.` +
          (nr.allowed ? "" : `\n\nSalesforce allows a ${licenseOf(row.license).label} refresh every ${nr.days} day(s); the next one is allowed ${fmtDate(nr.at)}.`) +
          (f.autoActivate ? "\n\nIt will be activated as soon as it's copied: the current copy can't be kept." : "\n\nYou activate it when it's copied (until then you can still discard it and keep the current copy).")});
      if (!ok) return false;
    }
    const sbx = matchSandboxOrg(rel.orgs, row, prod.host);
    if (f.backupFirst && sbx) {
      setBusy(`Backing up ${row.name} first…`);
      await backupSandbox(sbx, {sandboxName: row.name, objects: f.backupObjects || [], metadata: true, onStatus: setBusy});
    }
    setBusy(`Starting the refresh of ${row.name}…`);
    await refreshSandbox(prod.conn, row.id, sandboxBody(f, "refresh"));
    return true;
  };

  const refreshStale = work("Refreshing…", async () => {
    const ok = await typedConfirm({title: `Refresh ${staleDev.length} Developer sandbox(es)?`, word: "REFRESH", confirmLabel: "Refresh all",
      message: `${staleDev.map(r => r.name).join(", ")} will each be replaced with a fresh copy of ${prod.name}'s metadata (no data). Their current contents are lost.`});
    if (!ok) return;
    const done = [];
    for (const r of staleDev) {
      if (!nextRefresh(r).allowed) continue;
      await refreshSandbox(prod.conn, r.id, sandboxBody({license: r.license, description: r.description, autoActivate: true, apexClassId: r.apexClassId, groupId: r.groupId}, "refresh"));
      done.push(r.name);
    }
    setMsg(`Refresh started: ${done.join(", ") || "none (too soon to refresh)"}.`);
    await load(true);
  });

  const refreshSelected = work("Refreshing…", async () => {
    const ok = await typedConfirm({title: `Refresh ${selected.length} sandbox(es)?`, word: "REFRESH", confirmLabel: "Refresh",
      message: `${selected.map(r => r.name).join(", ")} will be replaced with a new copy of ${prod.name}. They're activated when copied.`});
    if (!ok) return;
    for (const r of selected) await refreshSandbox(prod.conn, r.id, sandboxBody({license: r.license, description: r.description, autoActivate: true,
      apexClassId: r.apexClassId, groupId: r.groupId, templateId: r.templateId, historyDays: r.historyDays, copyChatter: r.copyChatter}, "refresh"));
    setMsg(`Refresh started for ${selected.map(r => r.name).join(", ")}.`);
    setSel(new Set());
    await load(true);
  });

  const activate = row => work("Activating…", async () => {
    const ok = await confirmDialog({title: `Activate ${row.name}?`, confirmLabel: "Activate", danger: true,
      message: "The new copy goes live and the previous copy of this sandbox is deleted for good. Everyone using it is logged out."});
    if (!ok) return;
    await setRefreshAction(prod.conn, row.process.id, "ACTIVATE");
    setMsg(`${row.name} is being activated.`);
    await load(true);
  })();
  const discard = row => work("Discarding…", async () => {
    const ok = await typedConfirm({title: `Discard the refresh of ${row.name}?`, word: row.name, confirmLabel: "Discard",
      message: "The new copy is deleted and the sandbox stays as it was before this refresh. This can't be undone."});
    if (!ok) return;
    await setRefreshAction(prod.conn, row.process.id, "DISCARD");
    setMsg(`The refresh of ${row.name} is being discarded; the previous copy stays.`);
    await load(true);
  })();
  const remove = row => work("Deleting…", async () => {
    const ok = await typedConfirm({title: `Delete ${row.name}?`, word: row.name, confirmLabel: "Delete sandbox",
      message: `${row.name} and everything in it are deleted. Salesforce can't bring it back. Back it up first if you might need anything from it.`});
    if (!ok) return;
    await deleteSandbox(prod.conn, row.id);
    setMsg(`${row.name} is being deleted.`);
    await load(true);
  })();

  const compareTwo = (a, b) => {
    const oa = a.isOrg ? a : matchSandboxOrg(rel.orgs, a, prod.host);
    const ob = b.isOrg ? b : matchSandboxOrg(rel.orgs, b, prod.host);
    const missing = [[a, oa], [b, ob]].filter(([, o]) => !o).map(([r]) => r.name);
    if (missing.length) { setError(`Log in to ${missing.join(" and ")} in this browser first (open its login URL), then try again.`); return; }
    setRelease({sourceHost: oa.host, targetHost: ob.host, compare: null, compareOnly: null, selected: new Set()});
    goTo("compare");
  };

  if (!rel.orgs) return h("div", {className: "org-grid"}, h("div", {className: "org-card org-card-wide"}, h("div", {className: "insp-meta"}, "Loading your orgs…")));

  return h("div", {className: "org-grid sbx", ref: boxRef},
    h("div", {className: "org-card org-card-wide"},
      h(CardHead, {icon: "🏖️", title: "Sandbox Studio"},
        h("button", {className: "btn btn-secondary btn-sm", disabled: !!busy || !prod, onClick: () => load()}, "↻ Refresh list"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !!busy || !prod || !rows, onClick: () => setForm({mode: "create"})}, "＋ New sandbox")),
      h("div", {className: "sq3-card-sub"}, "Create, clone, refresh, activate and delete sandboxes, back them up before a refresh and walk through the steps after it. " +
        "Sandboxes are managed from production: sign in to it here as an admin."),
      h("div", {className: "rel-orgbar"},
        h("div", {className: "rel-org"},
          h("span", {className: "rel-org-l"}, "Production org"),
          prods.length ? h(SearchSelect, {value: prod ? prod.host : "", options: orgOptions(prods), onChange: v => setProdHost(v || ""), ariaLabel: "Production org"})
            : h("span", {className: "insp-warn"}, "You're not logged in to a production org in this browser. Log in to production in another tab, then reload."),
          h(OrgTag, {org: prod}))),
      busy && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})), h("span", {className: "insp-meta"}, busy)),
      error && h("div", {className: "insp-error"}, error),
      msg && h("div", {className: "insp-status-ok"}, msg),
      !rows && !busy && !error && prod && h("div", {className: "sbx-notice"}, "Refresh to list sandboxes.")),

    form && h(SandboxForm, {key: form.mode + (form.row ? form.row.id : ""), mode: form.mode, row: form.row, rows: rows || [], prod, orgs: rel.orgs,
      onCancel: () => setForm(null),
      onSubmit: work(form.mode === "refresh" ? "Refreshing…" : "Creating…", async f => {
        if (form.mode === "refresh") {
          if (!(await doRefresh(form.row, f))) return;
          setMsg(`Refresh of ${form.row.name} started. Progress shows below; it can take from minutes (Developer) to days (Full).`);
        } else {
          await createSandbox(prod.conn, sandboxBody(f, form.mode));
          setMsg(`${f.name} is being ${form.mode === "clone" ? "cloned" : "created"}. Progress shows below.`);
        }
        setForm(null);
        await load(true);
      })}),

    rows && h("div", {className: "org-card org-card-wide"},
      h("div", {className: "sbx-stats"},
        [["total", "Total", "blue"], ["DEVELOPER", "Developer", "blue"], ["DEVELOPER PRO", "Developer Pro", "violet"], ["PARTIAL", "Partial copy", "amber"],
          ["FULL", "Full copy", "green"], ["processing", "Processing", "amber"]].map(([k, label, tone]) => h("button", {key: k, type: "button",
          className: "sbx-stat sbx-" + tone + ((k === typeF) || (k === "processing" && statusF === "processing") ? " on" : ""),
          onClick: () => { if (k === "processing") { setStatusF(statusF === "processing" ? "all" : "processing"); } else if (k === "total") { setTypeF("all"); setStatusF("all"); } else setTypeF(typeF === k ? "all" : k); }},
        h("span", {className: "sbx-stat-n"}, stats[k] || 0), h("span", {className: "sbx-stat-l"}, label)))),
      stats.activation > 0 && h("div", {className: "sbx-banner info"}, `⏳ ${stats.activation} sandbox(es) are copied and waiting for you to activate them.`),
      stale.length > 0 && !staleOff && h("div", {className: "sbx-banner warn"},
        h("span", null, `⚠ ${stale.length} sandbox(es) have not been refreshed in over 30 days`, staleDev.length ? ` (${staleDev.length} Developer)` : "", "."),
        staleDev.length > 0 && h("button", {className: "btn btn-sm sbx-btn-warn", disabled: !!busy, onClick: refreshStale}, "↻ Refresh all stale (Developer)"),
        h("button", {className: "field-action-btn sbx-dismiss", onClick: () => setStaleOff(true)}, "✕ Dismiss")),
      selected.length > 0 && h("div", {className: "sbx-selbar"},
        h("b", null, `${selected.length} selected`),
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => { safeCopyText(selected.map(r => `${r.name}: ${url(r)}`).join("\n")); setMsg("Login URLs copied."); }}, "📋 Copy URLs"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => downloadText("sandboxes-selected.csv", csvOf(selected))}, "⬇ Export selected"),
        h("button", {className: "btn btn-sm sbx-btn-warn", disabled: !!busy, onClick: refreshSelected}, "↻ Refresh selected"),
        h("button", {className: "btn btn-secondary btn-sm", disabled: selected.length !== 2, title: "Pick exactly two", onClick: () => compareTwo(selected[0], selected[1])}, `⇄ Compare (${selected.length})`),
        h("button", {className: "field-action-btn sbx-dismiss", onClick: () => setSel(new Set())}, "✕ Clear")),
      h("div", {className: "sbx-filters"},
        h("input", {className: "soql-save-input sbx-search", value: term, placeholder: "Search sandboxes…", "aria-label": "Search sandboxes", onChange: e => setTerm(e.target.value)}),
        h("select", {className: "sbx-select", value: typeF, "aria-label": "Type", onChange: e => setTypeF(e.target.value)},
          h("option", {value: "all"}, "All types"), Object.entries(LICENSES).map(([k, v]) => h("option", {key: k, value: k}, v.label))),
        h("select", {className: "sbx-select", value: statusF, "aria-label": "Status", onChange: e => setStatusF(e.target.value)},
          h("option", {value: "all"}, "All statuses"), Object.entries(STATUS_GROUPS).filter(([k]) => k !== "unknown").map(([k, v]) => h("option", {key: k, value: k}, v.label)))),
      h("div", {className: "sbx-tools"},
        h("span", {className: "rel-org-l"}, "URL"),
        [["enhanced", "Domain"], ["test", "test.salesforce.com"]].map(([id, label]) => h("label", {key: id, className: "sbx-radio"},
          h("input", {type: "radio", name: "sbx-url", checked: urlStyle === id, onChange: () => setUrlStyle(id)}), " ", label)),
        h("span", {className: "sbx-tools-r"},
          h("button", {className: "btn btn-secondary btn-sm", onClick: () => setShowCols(!showCols), "aria-expanded": showCols}, "⚙ Columns"),
          h("button", {className: "btn btn-secondary btn-sm", onClick: () => downloadText("sandboxes.csv", csvOf(visible))}, "⬇ Export CSV"))),
      showCols && h("div", {className: "sbx-cols"}, COLS.map(([id, label]) => h("label", {key: id, className: "sq3-check"},
        h("input", {type: "checkbox", checked: !hidden.includes(id), onChange: () => setHidden(hidden.includes(id) ? hidden.filter(x => x !== id) : [...hidden, id])}),
        h("span", {title: tooNarrow(id) ? "Hidden while the window is narrow" : undefined}, label, tooNarrow(id) ? " (narrow)" : "")))),
      !visible.length ? h(EmptyState, {art: "table", compact: true, title: rows.length ? "No sandbox matches" : "No sandboxes yet",
        text: rows.length ? "Clear the search or filters." : "Create your first sandbox with “＋ New sandbox”."})
        : h("div", {className: "insp-table-wrap rel-table-wrap sbx-table-wrap"}, h("table", {className: "insp-table rel-table sbx-table"},
          h("thead", null, h("tr", null,
            h("th", {className: "rel-cb sbx-c-cb"}, h("input", {type: "checkbox", "aria-label": "Select all", checked: visible.length > 0 && visible.every(r => sel.has(r.id)),
              onChange: e => setSel(e.target.checked ? new Set(visible.map(r => r.id)) : new Set())})),
            h("th", {className: "sbx-c-name"}, "Name"), col("license") && h("th", {className: "sbx-c-license"}, "License"), col("status") && h("th", {className: "sbx-c-status"}, "Status"),
            col("last") && h("th", {className: "sbx-c-last"}, "Last refresh"), col("age") && h("th", {className: "sbx-c-age"}, "Age"), col("description") && h("th", {className: "sbx-c-description"}, "Description"),
            col("url") && h("th", {className: "sbx-c-url"}, "Login URL"), h("th", {className: "sbx-actions-h sbx-c-actions"}, "Actions"))),
          h("tbody", null, visible.map(r => {
            const g = r.process ? r.process.group : "unknown";
            const age = ageDays(r);
            return h(React.Fragment, {key: r.id},
              h("tr", {className: "rel-row" + (sel.has(r.id) ? " sel" : "") + (open === r.id ? " sbx-open" : "")},
                h("td", {className: "rel-cb"}, h("input", {type: "checkbox", checked: sel.has(r.id), "aria-label": "Select " + r.name, onChange: () => toggle(r.id)})),
                h("td", {className: "rel-name sbx-c-name", title: r.name}, h("button", {className: "sbx-name", onClick: () => { setOpen(open === r.id ? null : r.id); setDrawerTab("overview"); }}, r.name)),
                col("license") && h("td", {className: "sbx-c-license"}, h("span", {className: "sbx-lic sbx-lic-" + r.license.replace(/\s+/g, "-").toLowerCase()}, licenseOf(r.license).tag)),
                col("status") && h("td", {className: "sbx-c-status"}, h("span", {className: "sbx-status sbx-st-" + g}, r.process ? r.process.status.toUpperCase() : "—"),
                  g === "processing" && r.process.progress != null && h("div", {className: "sbx-prog", title: `${r.process.progress}% copied`},
                    h("div", {className: "sbx-prog-fill", style: {width: `${Math.max(3, r.process.progress)}%`}}))),
                col("last") && h("td", {className: "sbx-c-last"}, fmtDate(r.lastRefresh)),
                col("age") && h("td", {className: "sbx-c-age"}, age == null ? "—" : h("span", {className: "sbx-age sbx-age-" + ageTone(age)}, `${age}d`)),
                col("description") && h("td", {className: "sbx-desc sbx-c-description", title: r.description || ""}, r.description || "—"),
                col("url") && h("td", {className: "sbx-c-url"}, h("a", {href: url(r), target: "_blank", rel: "noopener noreferrer", className: "sbx-url", title: url(r)}, url(r).replace(/^https:\/\//, ""))),
                h("td", {className: "sbx-actions sbx-c-actions"},
                  g === "activation" && h("button", {className: "btn btn-primary btn-sm", disabled: !!busy, onClick: () => activate(r)}, "Activate"),
                  h("div", {className: "sbx-menu-wrap"},
                    h("button", {className: "field-action-btn sbx-menu-btn", "aria-haspopup": "menu", "aria-expanded": !!menu && menu.id === r.id, title: "Actions",
                      onClick: e => {
                        if (menu && menu.id === r.id) { setMenu(null); return; }
                        // Fixed position: the table scrolls and would clip a menu inside it.
                        const b = e.currentTarget.getBoundingClientRect();
                        const up = window.innerHeight - b.bottom < 330;
                        setMenu({id: r.id, right: Math.max(8, window.innerWidth - b.right), top: up ? null : b.bottom + 4, bottom: up ? window.innerHeight - b.top + 4 : null});
                      }}, "⋯"),
                    menu && menu.id === r.id && h("div", {className: "sbx-menu", role: "menu",
                      style: {position: "fixed", right: menu.right, top: menu.top == null ? "auto" : menu.top, bottom: menu.bottom == null ? "auto" : menu.bottom}},
                      [["🔗 Open (login)", () => window.open(url(r), "_blank", "noopener")],
                        g !== "deleted" && ["↻ Refresh…", () => setForm({mode: "refresh", row: r})],
                        g !== "deleted" && ["⧉ Clone…", () => setForm({mode: "clone", row: r})],
                        g === "activation" && ["✔ Activate", () => activate(r)],
                        g === "activation" && ["↶ Discard the refresh", () => discard(r)],
                        ["💾 Back up…", () => { setOpen(r.id); setDrawerTab("backups"); }],
                        ["✅ Post-refresh steps", () => { setOpen(r.id); setDrawerTab("post"); }],
                        prod && ["⇄ Compare with production", () => compareTwo(r, {...prod, isOrg: true, name: prod.name})],
                        g !== "deleted" && ["🗑 Delete…", () => remove(r), "danger"]].filter(Boolean).map(([label, fn, cls]) =>
                        h("button", {key: label, role: "menuitem", className: "sbx-menu-item" + (cls ? " " + cls : ""), onClick: () => { setMenu(null); fn(); }}, label)))))),
              open === r.id && h("tr", {className: "sbx-drawer-row"}, h("td", {colSpan: span},
                h(SandboxDrawer, {row: r, prod, orgs: rel.orgs, tab: drawerTab, setTab: setDrawerTab, goTo, url: url(r)}))));
          }))))));
}

// ─── New / clone / refresh form ─────────────────────────────────────
function SandboxForm({mode, row, rows, prod, orgs, onCancel, onSubmit}) {
  const base = row || {};
  const [f, setF] = React.useState({
    name: mode === "refresh" ? base.name : "", license: mode === "clone" ? base.license : (base.license || "DEVELOPER"),
    description: mode === "refresh" ? base.description : "", autoActivate: mode === "refresh" ? !!base.autoActivate : false,
    apexClassId: base.apexClassId || "", groupId: base.groupId || "", templateId: base.templateId || "", historyDays: base.historyDays || 0,
    copyChatter: !!base.copyChatter, sourceId: mode === "clone" ? base.id : "", backupFirst: mode === "refresh", backupObjects: [],
  });
  const set = patch => setF({...f, ...patch});
  const [classes, setClasses] = React.useState(null);
  const [groups, setGroups] = React.useState(null);
  const [cands, setCands] = React.useState(null);
  const sbx = mode === "refresh" ? matchSandboxOrg(orgs, base, prod.host) : null;
  React.useEffect(() => {
    postCopyClasses(prod.conn).then(setClasses).catch(() => setClasses([]));
    publicGroups(prod.conn).then(setGroups).catch(() => setGroups([]));
    if (sbx) backupCandidates(sbx.conn).then(setCands).catch(() => setCands([]));
  }, []);
  const nameErr = mode === "refresh" ? null : sandboxNameError(f.name, rows.map(r => r.name));
  const nr = mode === "refresh" ? nextRefresh(base) : null;
  const lic = mode === "clone" ? base.license : f.license;
  const title = mode === "refresh" ? `Refresh ${base.name}` : mode === "clone" ? `Clone ${base.name}` : "New sandbox";
  return h("div", {className: "org-card org-card-wide sbx-form"},
    h(CardHead, {icon: mode === "refresh" ? "↻" : mode === "clone" ? "⧉" : "＋", title}),
    mode === "refresh" && h("div", {className: "sbx-banner warn"}, `Refreshing replaces everything in ${base.name} with a new copy of ${prod.name}.`,
      nr && !nr.allowed ? ` Salesforce allows this every ${nr.days} day(s): next allowed ${fmtDate(nr.at)}.` : ""),
    mode === "clone" && h("div", {className: "sq3-card-sub"}, `A new sandbox with ${base.name}'s metadata and data (same license: ${licenseOf(base.license).label}).`),
    h("div", {className: "sbx-form-grid"},
      mode !== "refresh" && h("label", {className: "insp-field"}, h("span", null, "Name"),
        h("input", {value: f.name, maxLength: 10, placeholder: "e.g. UAT2", autoFocus: true, onChange: e => set({name: e.target.value})}),
        f.name && nameErr && h("span", {className: "sbx-err"}, nameErr)),
      mode === "create" && h("label", {className: "insp-field"}, h("span", null, "Type"),
        h("select", {value: f.license, onChange: e => set({license: e.target.value})},
          Object.entries(LICENSES).map(([k, v]) => h("option", {key: k, value: k}, `${v.label} (refresh every ${v.refreshDays} day${v.refreshDays > 1 ? "s" : ""})`)))),
      h("label", {className: "insp-field sbx-wide"}, h("span", null, "Description"),
        h("input", {value: f.description, maxLength: 1000, placeholder: "What it's for, who uses it", onChange: e => set({description: e.target.value})})),
      (lic === "PARTIAL" || lic === "FULL") && mode !== "clone" && h("label", {className: "insp-field"}, h("span", null, "Sandbox template Id (optional)"),
        h("input", {value: f.templateId, placeholder: "1ps…", onChange: e => set({templateId: e.target.value.trim()})})),
      lic === "FULL" && mode !== "clone" && h("label", {className: "insp-field"}, h("span", null, "Object history to copy"),
        h("select", {value: f.historyDays, onChange: e => set({historyDays: Number(e.target.value)})},
          [[0, "None"], [10, "10 days"], [30, "30 days"], [60, "60 days"], [90, "90 days"], [180, "180 days"], [-1, "All"]].map(([v, l]) => h("option", {key: v, value: v}, l)))),
      lic === "FULL" && mode !== "clone" && h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: f.copyChatter, onChange: e => set({copyChatter: e.target.checked})}),
        h("span", null, "Copy Chatter")),
      h("label", {className: "insp-field"}, h("span", null, "Post-copy Apex class"),
        h("select", {value: f.apexClassId, onChange: e => set({apexClassId: e.target.value})},
          h("option", {value: ""}, classes ? (classes.length ? "None" : "None (no class implements SandboxPostCopy)") : "Loading…"),
          (classes || []).map(c => h("option", {key: c.id, value: c.id}, c.name))),
        h("span", {className: "insp-meta"}, "Runs in the sandbox after each copy (SandboxPostCopy).")),
      h("label", {className: "insp-field"}, h("span", null, "Who can log in (activation group)"),
        h("select", {value: f.groupId, onChange: e => set({groupId: e.target.value})},
          h("option", {value: ""}, "Everyone copied from production"),
          (groups || []).map(g => h("option", {key: g.id, value: g.id}, g.name)))),
      h("label", {className: "sq3-check sbx-wide"}, h("input", {type: "checkbox", checked: f.autoActivate, onChange: e => set({autoActivate: e.target.checked})}),
        h("span", null, "Activate automatically when it's copied", h("span", {className: "insp-meta"}, " (off: you activate it yourself, and can discard the refresh until then)")))),
    mode === "refresh" && h("div", {className: "sbx-backup-box"},
      h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: f.backupFirst && !!sbx, disabled: !sbx, onChange: e => set({backupFirst: e.target.checked})}),
        h("span", null, "💾 Back up first: its metadata", cands && cands.length ? " and the data below" : "")),
      !sbx && h("div", {className: "insp-meta"}, `To back up ${base.name} first, log in to it in this browser (`, h("a", {href: loginUrl(base, {prodHost: prod.host}), target: "_blank", rel: "noopener noreferrer"}, "open it"), ") and come back."),
      sbx && f.backupFirst && cands && h("div", {className: "og-chips"}, cands.slice(0, 40).map(o => h("button", {key: o.name, type: "button",
        className: "og-chip" + (f.backupObjects.includes(o.name) ? " live" : ""), onClick: () => set({backupObjects: f.backupObjects.includes(o.name) ? f.backupObjects.filter(x => x !== o.name) : [...f.backupObjects, o.name]})},
      (f.backupObjects.includes(o.name) ? "✓ " : "") + o.label)))),
    h("div", {className: "rel-actionbar"},
      h("button", {className: "btn btn-secondary btn-sm", onClick: onCancel}, "Cancel"),
      h("button", {className: "btn btn-primary btn-sm" + (mode === "refresh" ? " sbx-btn-warn" : ""), disabled: !!nameErr,
        onClick: () => onSubmit({...f, license: lic})}, mode === "refresh" ? "Refresh…" : mode === "clone" ? "Clone sandbox" : "Create sandbox")));
}

// ─── Drawer: overview, backups, post-refresh ────────────────────────
function SandboxDrawer({row, prod, orgs, tab, setTab, goTo, url}) {
  const sbx = matchSandboxOrg(orgs, row, prod.host);
  return h("div", {className: "sbx-drawer"},
    h("div", {className: "og-view-tabs"},
      [["overview", "Overview"], ["backups", "💾 Backups"], ["post", "✅ Post-refresh steps"]].map(([id, label]) => h("button", {key: id, type: "button",
        className: "og-view-tab" + (tab === id ? " on" : ""), onClick: () => setTab(id)}, label)),
      h("span", {className: "insp-meta sbx-login"}, sbx ? `Logged in here as ${sbx.user ? sbx.user.username || sbx.user : "you"}` : "Not logged in here: ",
        !sbx && h("a", {href: url, target: "_blank", rel: "noopener noreferrer"}, "log in"))),
    tab === "overview" ? h(Overview, {row, prod})
      : tab === "backups" ? h(Backups, {row, sbx, goTo})
        : h(PostRefresh, {row, sbx, prod, goTo, url}));
}

function Overview({row, prod}) {
  const nr = nextRefresh(row);
  const kv = (k, v) => h("div", {className: "sbx-kv"}, h("span", null, k), h("b", null, v));
  return h("div", {className: "sbx-overview"},
    h("div", {className: "sbx-kvs"},
      kv("License", licenseOf(row.license).label),
      kv("Status", row.process ? row.process.status : "—"),
      kv("Last refresh", fmtDate(row.lastRefresh)),
      kv("Next refresh allowed", nr.allowed ? "now" : fmtDate(nr.at)),
      kv("Auto-activate", row.autoActivate ? "Yes" : "No"),
      kv("Post-copy Apex", row.apexClassId || "None"),
      kv("Activation group", row.groupId || "Everyone"),
      row.process && row.process.orgId && kv("Org Id", row.process.orgId)),
    row.description && h("p", {className: "og-p"}, row.description),
    h("div", {className: "og-tag"}, "Refresh history"),
    row.history.length ? h("table", {className: "insp-table sbx-hist"},
      h("thead", null, h("tr", null, h("th", null, "Started"), h("th", null, "Finished"), h("th", null, "Activated"), h("th", null, "Status"))),
      h("tbody", null, row.history.map(p => h("tr", {key: p.id}, h("td", null, fmtDate(p.started)), h("td", null, fmtDate(p.ended)),
        h("td", null, fmtDate(p.activated)), h("td", null, p.status)))))
      : h("div", {className: "insp-meta"}, "No refresh yet."),
    h("div", {className: "insp-meta"}, `Managed from ${prod.name}.`));
}

function Backups({row, sbx, goTo}) {
  const [list, setList] = React.useState(null);
  const [cands, setCands] = React.useState(null);
  const [pick, setPick] = React.useState([]);
  const [meta, setMeta] = React.useState(true);
  const [busy, setBusy] = React.useState("");
  const [err, setErr] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [space, setSpace] = React.useState(null);
  // Only backups taken from this sandbox org (by org id; older ones by host).
  const reload = () => listBackups().then(all => setList(sbx ? all.filter(b => backupMatchesOrg(b, sbx)) : []));
  React.useEffect(() => { reload(); usage().then(setSpace); if (sbx) backupCandidates(sbx.conn).then(setCands).catch(() => setCands([])); }, [sbx && sbx.host]);
  const run = (label, fn) => async () => { setBusy(label); setErr(null); setResult(null); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(""); } };
  const backUp = run("Backing up…", async () => {
    await backupSandbox(sbx, {sandboxName: row.name, objects: pick, metadata: meta, onStatus: setBusy});
    setResult({text: "Backup saved in this browser."});
    await reload();
  });
  const fromOrg = b => (b.orgName && b.orgHost ? `${b.orgName} (${b.orgHost})` : b.orgName || b.orgHost || "an unknown org");
  // A backup goes back only into the org it was taken from.
  const sameOrg = b => {
    if (!sbx) throw new Error(`Log in to ${row.name} first.`);
    if (!backupMatchesOrg(b, sbx)) throw new Error(`This backup was taken from ${fromOrg(b)}, not ${sbx.host}: it can't be restored here.`);
  };
  const restoreMeta = b => run("Preparing the restore…", async () => {
    sameOrg(b);
    const ok = await confirmDialog({title: `Restore ${row.name}'s metadata?`, confirmLabel: "Continue",
      message: `From the backup of ${fromOrg(b)} taken ${new Date(b.at).toLocaleString()}, into ${sbx.host}. You validate and deploy it on the next screen.`});
    if (!ok) return;
    const comps = await snapshotComponents(b.snapshotId);
    const keys = [...comps.keys()];
    setRelease({pendingPlan: {kind: "restore", title: `Restore ${row.name}'s metadata from before the refresh`, since: new Date().toISOString(),
      detail: `Puts back ${keys.length} component(s) as they were on ${new Date(b.at).toLocaleString()}. Validate first, then deploy.`,
      comps, keys, destructive: membersFromKeys([]), targetHost: sbx.host}});
    goTo("deploy");
  })();
  const restoreRecs = b => run("Restoring data…", async () => {
    sameOrg(b);
    const total = b.data.reduce((s, d) => s + d.rows, 0);
    const ok = await confirmDialog({title: `Restore ${total.toLocaleString()} record(s) into ${row.name}?`, confirmLabel: "Restore data", danger: true,
      message: `In ${sbx.host}, from the backup of ${fromOrg(b)}: ${b.data.map(d => `${d.label}: ${d.rows}`).join(", ")}.\n\nRecords are inserted again (new ids), parents first, with lookups between them pointed at the new records. ` +
        "Files, attachments and history are not restored. Existing records aren't changed, so restoring twice makes duplicates."});
    if (!ok) return;
    const res = await restoreData(sbx, b, {onStatus: setBusy});
    setResult({restore: res});
  })();
  const download = async d => downloadText(`${row.name}-${d.object}-backup.csv`, toCsv(d.fields, await backupRows(d)));
  return h("div", {className: "sbx-backups"},
    h("div", {className: "sq3-card-sub"}, "Back up before a refresh; restore after it. Kept in this browser" +
      (space && space.quota ? ` (using ${formatBytes(space.used)} of ${formatBytes(space.quota)})` : "") + ". Before you activate a refresh, Discard is the true undo."),
    !sbx ? h("div", {className: "insp-warn"}, `To back up or restore, log in to ${row.name} in this browser.`)
      : h("div", {className: "sbx-backup-box"},
        h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: meta, onChange: e => setMeta(e.target.checked)}), h("span", null, "Metadata (Apex, components, flows, objects, security)")),
        h("div", {className: "insp-meta"}, "Data: pick objects (custom objects first)"),
        cands ? h("div", {className: "og-chips"}, cands.slice(0, 60).map(o => h("button", {key: o.name, type: "button", className: "og-chip" + (pick.includes(o.name) ? " live" : ""),
          onClick: () => setPick(pick.includes(o.name) ? pick.filter(x => x !== o.name) : [...pick, o.name])}, (pick.includes(o.name) ? "✓ " : "") + o.label)))
          : h("div", {className: "insp-meta"}, "Loading objects…"),
        h("button", {className: "btn btn-primary btn-sm", disabled: !!busy || (!meta && !pick.length), onClick: backUp}, "💾 Back up now")),
    busy && h("div", {className: "tr-progress"}, h("div", {className: "cov-progress"}, h("div", {className: "cov-progress-fill"})), h("span", {className: "insp-meta"}, busy)),
    err && h("div", {className: "insp-error"}, err),
    result && result.text && h("div", {className: "insp-status-ok"}, result.text),
    result && result.restore && h("div", {className: "sbx-restore-res"}, result.restore.map(r => h("div", {key: r.object, className: r.failed ? "insp-warn" : "insp-status-ok"},
      `${r.object}: ${r.inserted} restored${r.failed ? `, ${r.failed} failed (first: row ${r.errors[0].row}: ${r.errors[0].message})` : ""}${r.capped ? " (only the first 50,000)" : ""}`))),
    list && !list.length && h("div", {className: "insp-meta"}, "No backups of this sandbox yet."),
    (list || []).map(b => h("div", {key: b.id, className: "sbx-backup"},
      h("div", null, h("b", null, new Date(b.at).toLocaleString()), h("span", {className: "insp-meta"}, ` · ${formatBytes(b.size || 0)}`)),
      h("div", {className: "insp-meta"}, [b.snapshotId ? `${b.metaCount} metadata component(s)` : "", ...b.data.map(d => `${d.label}: ${d.rows} record(s)`)].filter(Boolean).join(" · ") || "Empty"),
      h("div", {className: "rel-snap-actions"},
        b.snapshotId && h("button", {className: "field-action-btn", disabled: !!busy, onClick: () => restoreMeta(b)}, "↩ Restore metadata"),
        b.data.length > 0 && h("button", {className: "field-action-btn", disabled: !!busy, onClick: () => restoreRecs(b)}, "↩ Restore data"),
        b.data.map(d => h("button", {key: d.object, className: "field-action-btn", onClick: () => download(d)}, `⬇ ${d.object}.csv`)),
        h("button", {className: "field-action-btn rel-chip-del", disabled: !!busy, onClick: run("Deleting…", async () => {
          if (await confirmDialog({title: "Delete this backup?", confirmLabel: "Delete", danger: true, message: "It's removed from this browser."})) { await deleteBackup(b.id); await reload(); }
        })}, "Delete")))));
}

// ─── Post-refresh checklist (in the refreshed sandbox) ──────────────
const POST_STEPS = [
  ["deliver", "📧 Email deliverability", "Refreshed sandboxes can only send system email. Turn it on only if testers need emails."],
  ["invalid", "✉️ Fix “.invalid” emails", "Salesforce adds .invalid to everyone's email. Fix it for the people who should get emails here."],
  ["jobs", "⏰ Scheduled jobs", "Jobs copied from production can call real systems or email real people. Pause them, or re-create the ones testers need."],
  ["flows", "⇢ Flows that reach the outside world", "Active flows that send email, call out or run Apex. Deactivate the ones that mustn't run here."],
  ["integrations", "🔌 Integrations pointing at production", "Named credentials, remote sites and custom setting URLs that still point at production."],
  ["people", "👥 Who can log in", "Freeze everyone except the project team, if this sandbox is for a small group."],
  ["restore", "💾 Restore my backup", "Put back the metadata and test data you backed up before the refresh."],
];

function PostRefresh({row, sbx, prod, goTo, url}) {
  const key = "sfoc_sbx_post_" + (sbx ? sbx.host : row.name);
  const [done, setDoneState] = React.useState(() => ffLoadJson(key, {}));
  const [own, setOwn] = React.useState(() => ffLoadJson(key + "_own", []));
  const [text, setText] = React.useState("");
  const setDone = (id, on) => setDoneState(d => { const n = {...d}; if (on) n[id] = true; else delete n[id]; ffSaveJson(key, n); return n; });
  const all = [...POST_STEPS.map(s => s[0]), ...own.map(o => o.id)];
  const n = all.filter(id => done[id]).length;
  if (!sbx) {
    return h("div", {className: "sbx-post"},
      h("div", {className: "insp-warn"}, `The checklist runs inside ${row.name}: `, h("a", {href: url, target: "_blank", rel: "noopener noreferrer"}, "log in to it"), ", then come back and reload the org list."),
      h("ol", {className: "og-list"}, POST_STEPS.map(([id, title, why]) => h("li", {key: id}, h("b", null, title), " ", h("span", {className: "insp-meta"}, why)))));
  }
  return h("div", {className: "sbx-post"},
    h("div", {className: "og-check-head"},
      h("span", {className: "og-check-n"}, `${n} of ${all.length} done`),
      h("div", {className: "og-check-bar"}, h("div", {className: "og-check-fill", style: {width: `${all.length ? Math.round(n * 100 / all.length) : 0}%`}}))),
    POST_STEPS.map(([id, title, why]) => h("div", {key: id, className: "sbx-step" + (done[id] ? " done" : "")},
      h("div", {className: "sbx-step-h"},
        h("input", {type: "checkbox", checked: !!done[id], "aria-label": "Done: " + title, onChange: e => setDone(id, e.target.checked)}),
        h("b", null, title)),
      h("div", {className: "insp-meta"}, why),
      h(StepBody, {id, sbx, prod, row, goTo, onDone: () => setDone(id, true)}))),
    h("div", {className: "sbx-step"},
      h("div", {className: "sbx-step-h"}, h("b", null, "📝 Your own steps")),
      own.map(o => h("div", {key: o.id, className: "sbx-own"},
        h("input", {type: "checkbox", checked: !!done[o.id], onChange: e => setDone(o.id, e.target.checked)}), " ", o.text,
        h("button", {className: "rel-steps-x", onClick: () => { const next = own.filter(x => x.id !== o.id); setOwn(next); ffSaveJson(key + "_own", next); }}, "✕"))),
      h("div", {className: "og-ask-row"},
        h("input", {className: "soql-save-input og-ask-input", value: text, placeholder: "e.g. Reset the ERP integration user's password", onChange: e => setText(e.target.value),
          onKeyDown: e => { if (e.key === "Enter" && text.trim()) { const next = [...own, {id: "own-" + Date.now(), text: text.trim()}]; setOwn(next); ffSaveJson(key + "_own", next); setText(""); } }}),
        h("button", {className: "btn btn-secondary btn-sm", disabled: !text.trim(), onClick: () => { const next = [...own, {id: "own-" + Date.now(), text: text.trim()}]; setOwn(next); ffSaveJson(key + "_own", next); setText(""); }}, "＋ Add"))));
}

// One step: find what's there, pick, act. Nothing changes without a click.
function StepBody({id, sbx, prod, row, goTo, onDone}) {
  const [data, setData] = React.useState(null);
  const [pick, setPick] = React.useState(new Set());
  const [busy, setBusy] = React.useState("");
  const [note, setNote] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [group, setGroup] = React.useState("");
  const [groups, setGroups] = React.useState(null);
  const run = (label, fn) => async () => { setBusy(label); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(""); } };
  const togglePick = k => { const s = new Set(pick); if (s.has(k)) s.delete(k); else s.add(k); setPick(s); };
  const pickAll = keys => setPick(pick.size === keys.length ? new Set() : new Set(keys));
  const listOf = (items, keyOf, render) => h("div", {className: "sbx-step-list"},
    items.length > 1 && h("label", {className: "sq3-check"}, h("input", {type: "checkbox", checked: pick.size === items.length, onChange: () => pickAll(items.map(keyOf))}), h("span", null, "All")),
    items.map(x => h("label", {key: keyOf(x), className: "sbx-step-item"}, h("input", {type: "checkbox", checked: pick.has(keyOf(x)), onChange: () => togglePick(keyOf(x))}), render(x))));
  const status = h(React.Fragment, null,
    busy && h("div", {className: "insp-meta"}, busy),
    err && h("div", {className: "insp-error"}, err),
    note && h("div", {className: note.ok === false ? "insp-warn" : "insp-status-ok"}, note.text));
  const btn = (label, fn, opts = {}) => h("button", {className: "btn btn-sm " + (opts.primary ? "btn-primary" : "btn-secondary"), disabled: !!busy || opts.disabled, onClick: fn}, label);
  const prodDom = myDomainOf(prod.host);

  if (id === "deliver") {
    return h("div", {className: "sbx-step-b"},
      h("a", {className: "btn btn-secondary btn-sm", href: setupUrl(sbx.conn, "/lightning/setup/OrgEmailSettings/home"), target: "_blank", rel: "noopener noreferrer"}, "Open Deliverability ↗"),
      btn("Check", run("Checking…", async () => setNote(await checkDeliverability(sbx)))), status,
      h("div", {className: "insp-meta"}, "Salesforce has no API to change this setting: set Access level in Setup."));
  }
  if (id === "invalid") {
    return h("div", {className: "sbx-step-b"},
      !data && btn("Find users", run("Finding…", async () => setData(await invalidEmailUsers(sbx)))),
      data && (data.length ? listOf(data, u => u.id, u => h("span", null, u.name, " ", h("span", {className: "insp-meta"}, `${u.email} → ${u.fixed} · ${u.profile}`))) : h("div", {className: "insp-meta"}, "No active user has a .invalid email.")),
      data && data.length > 0 && btn(`Fix ${pick.size} email(s)`, run("Fixing…", async () => {
        const users = data.filter(u => pick.has(u.id));
        if (!(await confirmDialog({title: `Fix ${users.length} email(s)?`, confirmLabel: "Fix emails", danger: true,
          message: `In ${sbx.host}. These people can then receive emails from this sandbox (only if deliverability allows it). Salesforce may email them to confirm the change.`}))) return;
        const r = await fixInvalidEmails(sbx, users);
        setNote({text: `${r.ok} fixed${r.failed.length ? `, ${r.failed.length} failed: ${r.failed[0]}` : ""}.`, ok: !r.failed.length});
        setData(await invalidEmailUsers(sbx)); setPick(new Set());
        if (!r.failed.length) onDone();
      }), {disabled: !pick.size, primary: true}), status);
  }
  if (id === "jobs") {
    return h("div", {className: "sbx-step-b"},
      !data && btn("List scheduled jobs", run("Reading…", async () => setData(await scheduledJobs(sbx)))),
      data && (data.length ? listOf(data, j => j.id, j => h("span", null, j.name, " ", h("span", {className: "insp-meta"}, `${j.type} · ${j.cron} · next ${j.next ? new Date(j.next).toLocaleString() : "—"}`)))
        : h("div", {className: "insp-meta"}, "No scheduled jobs here.")),
      data && data.length > 0 && btn(`Pause ${pick.size} job(s)`, run("Pausing…", async () => {
        if (!(await confirmDialog({title: `Stop ${pick.size} scheduled job(s)?`, confirmLabel: "Stop jobs", danger: true, message: `They're aborted in ${sbx.host}. Note their timing if you'll want them back.`}))) return;
        const log = await abortJobs(sbx, [...pick]);
        setNote({text: `${log.filter(x => x.ok).length} stopped${log.some(x => !x.ok) ? `, ${log.filter(x => !x.ok).length} failed` : ""}.`, ok: log.every(x => x.ok)});
        setData(await scheduledJobs(sbx)); setPick(new Set());
      }), {disabled: !pick.size, primary: true}),
      btn("Re-create production's Apex schedules", run("Scheduling…", async () => {
        const jobs = await connQuery(prod.conn, "SELECT ApexClass.Name FROM AsyncApexJob WHERE JobType = 'ScheduledApex' AND Status = 'Queued'");
        const classes = [...new Set(jobs.map(j => j.ApexClass && j.ApexClass.Name).filter(Boolean))];
        if (!classes.length) { setNote({text: "Production has no scheduled Apex."}); return; }
        if (!(await confirmDialog({title: `Schedule ${classes.length} Apex class(es) here?`, confirmLabel: "Schedule", message: `${classes.join(", ")}, with production's timing, in ${sbx.host}. Already scheduled ones are skipped.`}))) return;
        const log = await runAction({id: "schedule-jobs", targets: classes}, {source: prod, target: sbx});
        setNote({text: log, ok: !/✗/.test(log)});
        setData(await scheduledJobs(sbx));
      })), status);
  }
  if (id === "flows") {
    return h("div", {className: "sbx-step-b"},
      !data && btn("Find flows", run("Reading flows…", async () => setData(await outsideFlows(sbx)))),
      data && (data.length ? listOf(data, f => f.name, f => h("span", null, f.label, " ", h("span", {className: "insp-meta"}, f.reasons.join(" · ")))) : h("div", {className: "insp-meta"}, "No active flow emails or calls out.")),
      data && data.length > 0 && btn(`Deactivate ${pick.size} flow(s)`, run("Deactivating…", async () => {
        if (!(await confirmDialog({title: `Deactivate ${pick.size} flow(s) here?`, confirmLabel: "Deactivate", danger: true, message: `Only in ${sbx.host}. Activate them again from Flows when you need them.`}))) return;
        const log = await deactivate(sbx, [...pick]);
        setNote({text: log, ok: !/✗/.test(log)});
        setData(await outsideFlows(sbx)); setPick(new Set());
      }), {disabled: !pick.size, primary: true}), status);
  }
  if (id === "integrations") {
    return h("div", {className: "sbx-step-b"},
      !data && btn("Check integrations", run("Reading…", async () => setData({eps: await endpoints(sbx, prod.host), settings: await prodUrlSettings(sbx, prod.host)}))),
      data && h("div", null,
        data.eps.length ? h("table", {className: "insp-table sbx-hist"}, h("tbody", null, data.eps.map((e, i) => h("tr", {key: i},
          h("td", null, e.kind), h("td", null, e.name), h("td", {className: "sbx-desc"}, e.url),
          h("td", null, h(FFBadge, {kind: e.looks === "prod" ? "err" : e.looks === "sandbox" ? "ok" : "off"}, e.looks === "prod" ? "Looks like production" : e.looks === "sandbox" ? "Test endpoint" : "Check")),
          h("td", null, h("a", {href: setupUrl(sbx.conn, e.setup), target: "_blank", rel: "noopener noreferrer"}, "Edit ↗"))))))
          : h("div", {className: "insp-meta"}, "No named credentials or remote sites."),
        h("div", {className: "og-tag"}, `Custom settings mentioning ${prodDom || "production"}`),
        data.settings.length ? listOf(data.settings, s => s.id + s.field, s => h("span", null, `${s.label}: ${s.name || ""} · ${s.field}`, " ", h("span", {className: "insp-meta"}, s.value)))
          : h("div", {className: "insp-meta"}, "None found."),
        data.settings.length > 0 && btn(`Point ${pick.size} value(s) at this sandbox`, run("Updating…", async () => {
          const items = data.settings.filter(s => pick.has(s.id + s.field));
          if (!(await confirmDialog({title: `Replace ${prod.host} in ${items.length} value(s)?`, confirmLabel: "Replace",
            message: `With ${sbx.host}. Only the picked custom setting values in ${sbx.host} change.`}))) return;
          const log = await replaceSettingValues(sbx, items, sbx.host, prod.host);
          setNote({text: `${log.filter(x => x.ok).length} updated${log.some(x => !x.ok) ? `, ${log.filter(x => !x.ok).length} failed` : ""}.`, ok: log.every(x => x.ok)});
          setData({...data, settings: await prodUrlSettings(sbx, prod.host)}); setPick(new Set());
        }), {disabled: !pick.size, primary: true})), status);
  }
  if (id === "people") {
    return h("div", {className: "sbx-step-b"},
      !groups && btn("Pick the team to keep", run("Reading groups…", async () => setGroups(await publicGroups(sbx.conn)))),
      groups && h("label", {className: "insp-field"}, h("span", null, "Keep this public group active"),
        h("select", {value: group, onChange: e => { setGroup(e.target.value); setData(null); }}, h("option", {value: ""}, "Pick a group…"), groups.map(g => h("option", {key: g.id, value: g.id}, g.name)))),
      group && !data && btn("List everyone else", run("Reading users…", async () => setData(await usersOutsideGroup(sbx, group)))),
      data && (data.length ? listOf(data, u => u.id, u => h("span", null, u.name, " ", h("span", {className: "insp-meta"}, `${u.username} · ${u.profile}`))) : h("div", {className: "insp-meta"}, "Everyone active is in the group.")),
      data && data.length > 0 && btn(`Freeze ${pick.size} user(s)`, run("Freezing…", async () => {
        if (!(await typedConfirm({title: `Freeze ${pick.size} user(s)?`, word: "FREEZE", confirmLabel: "Freeze",
          message: `In ${sbx.host}. They can't log in to this sandbox until you unfreeze them (Users tab or Setup). Make sure you're not freezing yourself.`}))) return;
        const r = await freezeUsers(sbx, [...pick]);
        setNote({text: `${r.frozen} frozen${r.already ? `, ${r.already} already frozen` : ""}.`});
        setPick(new Set());
        onDone();
      }), {disabled: !pick.size, primary: true}), status);
  }
  if (id === "restore") {
    return h("div", {className: "sbx-step-b"}, h("span", {className: "insp-meta"}, `Open the Backups tab of ${row.name} to restore its metadata (through Deploy) and data.`));
  }
  return null;
}
