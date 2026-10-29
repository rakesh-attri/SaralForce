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
import {metadataTargetFromUrl} from "./shared/inspector-tab.js";

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
  {id: "access", label: "Access", icon: "🛡️", component: AccessTab},
  {id: "metadata", label: "Metadata", icon: "🧩", component: MetadataTab},
  {id: "logs", label: "Logs", icon: "📝", component: LogsTab},
  {id: "org", label: "Org Info", icon: "🏢", component: OrgTab},
  {id: "apptabs", label: "App Tab Manager", icon: "📑", component: AppTabManager},
  {id: "coverage", label: "Code Coverage", icon: "</>", component: CoverageTab}
];

// Admin tools sit on the second row of the tab bar.
const TAB_ROW2 = new Set(["users", "access", "metadata", "org", "apptabs"]);

export function InspectorPanel() {
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
      h(activeTab.component, {key: activeTab.id, ...activeTab.props})
    )
  );
}
