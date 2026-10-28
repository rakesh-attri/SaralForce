// Inspector tools now live in addon/inspector/ (shared/ helpers, tabs/ per
// tab, inspector-panel.js with the tab registry). This file is kept as the
// stable entry point for existing importers (object-creator.js).
export {InspectorPanel} from "./inspector/inspector-panel.js";
export {ffApplyRestore, ffTakeSnapshot} from "./inspector/shared/session-state.js";
export {ffSetAppTabPrefill} from "./inspector/tabs/app-tabs.js";
