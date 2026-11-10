import {autoStartTabTour} from "../ui/tour-runner.js";
import {useSfTimeZoneTick} from "./shared/format.js";
import {useFfSession} from "./shared/session-state.js";
import {SoqlTab} from "./tabs/soql.js";
import {ExportTab} from "./tabs/export.js";
import {ImportTab} from "./tabs/import.js";
import {OrgTab} from "./tabs/org.js";
import {RecordsTab} from "./tabs/records.js";
import {ffHasAppTabPrefill, AppTabManager} from "./tabs/app-tabs.js";
import {UsersTab} from "./tabs/users.js";
import {ApexTab} from "./tabs/apex.js";
import {LogsTab} from "./tabs/logs.js";
import {CoverageTab} from "./tabs/coverage.js";
import {AccessTab} from "./tabs/access.js";
import {MetadataTab} from "./tabs/metadata.js";
import {ApiTab} from "./tabs/api.js";
import {ReleaseTab} from "./tabs/release.js";
import {metadataTargetFromUrl} from "./shared/inspector-tab.js";
import {sfConn} from "../inspector.js";

const h = React.createElement;

// Inspector tab registry: one entry per tab, in tab-bar order. `component`
// is rendered (with optional `props`) only while its tab is active.
export const INSPECTOR_TABS = [
  {id: "records", label: "Records", icon: "🗂️", component: RecordsTab},
  {id: "soql", label: "SOQL", icon: "🗄️", component: SoqlTab},
  {id: "apex", label: "Run-Apex", icon: "⚡", component: ApexTab},
  {id: "export", label: "Export", icon: "📤", component: ExportTab},
  {id: "import", label: "Import", icon: "📥", component: ImportTab},
  {id: "api", label: "API Explorer", icon: "🔌", component: ApiTab},
  {id: "logs", label: "Logs", icon: "📝", component: LogsTab},
  {id: "users", label: "Users", icon: "👥", component: UsersTab},
  {id: "access", label: "Access", icon: "🛡️", component: AccessTab},
  {id: "metadata", label: "Metadata", icon: "🧩", component: MetadataTab},
  {id: "org", label: "Org Info", icon: "🏢", component: OrgTab},
  {id: "apptabs", label: "App Tab Manager", icon: "📑", component: AppTabManager},
  {id: "release", label: "SandShift", icon: "🚀", component: ReleaseTab},
  {id: "coverage", label: "Code Coverage", icon: "</>", component: CoverageTab}
];

// Second row of the tab bar: admin tools, then Code Coverage last.
const TAB_ROW2 = new Set(["access", "metadata", "org", "apptabs", "release", "coverage"]);

// Shown when Salesforce says the session expired and logging in again
// hasn't been picked up yet. Reconnect re-reads the session (also on its
// own when you come back to the panel). Nothing is reloaded by itself, so
// unsaved work stays; "Reload this tool" loads the open tool's data again.
function SessionBar({onReload}) {
  const [state, setState] = React.useState("ok"); // ok | expired | back
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const tryRenew = React.useCallback(async (manual) => {
    setBusy(true);
    const ok = await sfConn.renewSession();
    setBusy(false);
    if (ok) { setState("back"); setMsg(""); }
    else if (manual) setMsg("Still logged out. Log in to Salesforce first (the button opens it), then click Reconnect.");
  }, []);
  React.useEffect(() => {
    const onExpired = () => setState("expired");
    const onRenewed = () => { setState(s => s === "expired" ? "back" : s); setMsg(""); };
    window.addEventListener("sfoc-session-expired", onExpired);
    window.addEventListener("sfoc-session-renewed", onRenewed);
    return () => {
      window.removeEventListener("sfoc-session-expired", onExpired);
      window.removeEventListener("sfoc-session-renewed", onRenewed);
    };
  }, []);
  React.useEffect(() => {
    if (state !== "expired") return undefined;
    const onBack = () => { if (document.visibilityState !== "hidden") tryRenew(false); };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [state, tryRenew]);
  if (state === "back") {
    return h("div", {className: "insp-session-bar ok", role: "status"},
      h("div", {className: "insp-session-tx"}, h("b", null, "✓ Reconnected to Salesforce."), " Reload the open tool to load its data again (unsaved edits in it are lost)."),
      h("div", {className: "insp-session-actions"},
        h("button", {className: "btn btn-primary btn-sm", onClick: () => { setState("ok"); onReload(); }}, "↻ Reload this tool"),
        h("button", {className: "btn btn-secondary btn-sm", onClick: () => setState("ok")}, "Dismiss")));
  }
  if (state !== "expired") return null;
  return h("div", {className: "insp-session-bar", role: "alert"},
    h("div", {className: "insp-session-tx"},
      h("b", null, "⚠️ Your Salesforce session has expired."),
      " Log in to Salesforce again, then click Reconnect. Your work in SaralForce stays.",
      msg && h("div", {className: "insp-session-msg"}, msg)),
    h("div", {className: "insp-session-actions"},
      h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: () => tryRenew(true)}, busy ? "Reconnecting…" : "🔄 Reconnect"),
      sfConn.instanceHostname && h("a", {className: "btn btn-secondary btn-sm", href: `https://${sfConn.instanceHostname}/`, target: "_blank", rel: "noopener"}, "Log in to Salesforce ↗")));
}

export function InspectorPanel() {
  // Bumped by "Reload this tool" after a reconnect (remounts the open tool).
  const [epoch, setEpoch] = React.useState(0);
  const reconnected = React.useCallback(() => setEpoch(n => n + 1), []);
  useSfTimeZoneTick();
  const [tab, setTab] = useFfSession("inspector", "tab", "records");
  // A prefill handoff from the AI Object Builder jumps straight to the
  // App Tab Manager tab (the manager consumes the payload on mount).
  React.useEffect(() => {
    if (ffHasAppTabPrefill()) setTab("apptabs");
    // Metadata "Full screen" opens this tab straight on the Metadata tool.
    else if (metadataTargetFromUrl()) setTab("metadata");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tabs = INSPECTOR_TABS;
  // First visit to a tool shows its one-step tour (after the main tour).
  React.useEffect(() => {
    autoStartTabTour(tab);
  }, [tab]);
  // A restored snapshot may name a tab id that no longer exists.
  const active = tabs.some(t => t.id === tab) ? tab : "soql";
  const activeTab = tabs.find(t => t.id === active);
  const pickTab = id => {
    if (id !== tab) {
      setTab(id);
      // Tab content heights differ — start each tab at the top.
      const body = document.querySelector(".inspector-body");
      if (body) body.scrollTop = 0;
    }
  };
  // The pill bar lives OUTSIDE the scroller (shell = nav + body) so it can
  // never scroll away with the content.
  return h("div", {className: "insp-shell"},
    h(SessionBar, {onReload: reconnected}),
    // Two rows: data & code tools, then admin tools, split by a glass line.
    h("div", {className: "insp-tabs", role: "tablist", "aria-label": "Inspector tools", "data-tour": "inspector-tabs"},
      [1, 2].map(row => [
        row === 2 && h("div", {key: "sep", className: "insp-tab-sep", role: "presentation"}),
        h("div", {key: "row" + row, className: "insp-tab-row", role: "presentation"},
          tabs.filter(t => (TAB_ROW2.has(t.id) ? 2 : 1) === row).map(t =>
            h("button", {
              key: t.id,
              id: "insp-tab-" + t.id,
              role: "tab",
              "aria-selected": active === t.id,
              "aria-controls": "insp-tabpanel",
              className: `insp-tab ${active === t.id ? "active" : ""}`,
              "data-ico": t.icon,
              onClick: () => pickTab(t.id)
            }, t.label)))
      ])
    ),
    h("div", {
      className: "inspector-body",
      id: "insp-tabpanel",
      role: "tabpanel",
      "aria-labelledby": "insp-tab-" + active
    },
      h(activeTab.component, {key: activeTab.id + ":" + epoch, ...activeTab.props})
    )
  );
}
