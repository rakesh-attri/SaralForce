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

const h = React.createElement;

// Inspector tab registry: one entry per tab, in tab-bar order. `component`
// is rendered (with optional `props`) only while its tab is active.
export const INSPECTOR_TABS = [
  {id: "records", label: "Records", icon: "🗂️", component: RecordsTab},
  {id: "soql", label: "SOQL", icon: "🗄️", component: SoqlTab},
  {id: "apex", label: "Run-Apex", icon: "⚡", component: ApexTab},
  {id: "export", label: "Export", icon: "📤", component: ExportTab},
  {id: "import", label: "Import", icon: "📥", component: ImportTab},
  {id: "users", label: "Users", icon: "👥", component: UsersTab},
  {id: "logs", label: "Logs", icon: "📝", component: LogsTab},
  {id: "org", label: "Org Info", icon: "🏢", component: OrgTab},
  {id: "apptabs", label: "App Tab Manager", icon: "📑", component: AppTabManager},
  {id: "coverage", label: "Code Coverage", icon: "</>", component: CoverageTab}
];

export function InspectorPanel() {
  useSfTimeZoneTick();
  const [tab, setTab] = useFfSession("inspector", "tab", "records");
  // A prefill handoff from the AI Object Builder jumps straight to the
  // App Tab Manager tab (the manager consumes the payload on mount).
  React.useEffect(() => {
    if (ffHasAppTabPrefill()) setTab("apptabs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tabs = INSPECTOR_TABS;
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
    h("div", {className: "insp-tabs", role: "tablist", "aria-label": "Inspector tools"},
      tabs.map(t =>
        h("button", {
          key: t.id,
          id: "insp-tab-" + t.id,
          role: "tab",
          "aria-selected": active === t.id,
          "aria-controls": "insp-tabpanel",
          className: `insp-tab ${active === t.id ? "active" : ""}`,
          "data-ico": t.icon,
          onClick: () => pickTab(t.id)
        }, t.label)
      )
    ),
    h("div", {
      className: "inspector-body",
      id: "insp-tabpanel",
      role: "tabpanel",
      "aria-labelledby": "insp-tab-" + active
    },
      h(activeTab.component, {key: activeTab.id, ...activeTab.props})
    )
  );
}
