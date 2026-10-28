// Chat history (localStorage) and sidebar/inspector session snapshots
// (sessionStorage) for the Object Builder. Storage is only touched when a
// function is called, so the module imports cleanly in Node.

export const CHAT_HISTORY_KEY = "sfoc_chat_history";
export const CHAT_HISTORY_LIMIT = 20;

export const INTERRUPTED_DEPLOY_MSG = "The previous deployment was interrupted before it finished. " +
  "Use Resume deploy to finish the remaining steps.";

export function loadChatHistory(sfHost) {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY + "_" + sfHost);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

export function saveChatHistory(sfHost, chats) {
  try {
    localStorage.setItem(CHAT_HISTORY_KEY + "_" + sfHost, JSON.stringify(chats));
  } catch (e) { /* quota exceeded, ignore */ }
}

// Snapshot of the current builder conversation for the history list.
export function buildChatEntry(state, now = Date.now()) {
  const {messages, currentProposal, deploymentResults, deploymentStatus, activeChatId, selectedFields,
    visibilityMode, selectedProfiles, builderMode, deployError, deployedObjectName} = state;
  return {
    id: activeChatId || now.toString(),
    timestamp: now,
    messages,
    currentProposal,
    deploymentResults,
    deploymentStatus,
    deployError,
    deployedObjectName,
    selectedFields,
    visibilityMode,
    selectedProfiles,
    builderMode: builderMode || "plan"
  };
}

// Replace the entry with the same id (or prepend it), keeping the newest
// CHAT_HISTORY_LIMIT chats. Returns a new array.
export function upsertChat(chatHistory, chatEntry, limit = CHAT_HISTORY_LIMIT) {
  const next = [...(chatHistory || [])];
  const existingIdx = next.findIndex(c => c.id === chatEntry.id);
  if (existingIdx >= 0) {
    next[existingIdx] = chatEntry;
  } else {
    next.unshift(chatEntry);
  }
  return next.slice(0, limit);
}

// State patch that restores a saved chat. Never restores a mid-deploy flag —
// the previous run is gone.
export function chatToState(chat) {
  const st = chat.deploymentStatus === "deploying" ? "failed" : (chat.deploymentStatus || null);
  return {
    messages: chat.messages || [],
    currentProposal: chat.currentProposal || null,
    deploymentStatus: st,
    deploymentStep: st === "complete" ? (chat.deploymentStep || "Deployment complete!") : (chat.deploymentStep || null),
    deploymentProgress: chat.deploymentProgress || 0,
    deploymentResults: chat.deploymentResults || [],
    deployError: chat.deploymentStatus === "deploying" ? INTERRUPTED_DEPLOY_MSG : (chat.deployError || null),
    deployedObjectName: chat.deployedObjectName || null,
    selectedFields: chat.selectedFields || (chat.currentProposal?.fields || []).map(f => f.name),
    visibilityMode: chat.visibilityMode || "all",
    selectedProfiles: chat.selectedProfiles || [],
    recordTypesDone: false,
    builderMode: chat.builderMode || "plan",
    error: null,
    activeChatId: chat.id
  };
}

export function loadPersistedState(sfHost) {
  try {
    const raw = sessionStorage.getItem(sfHost + "_sidebar_state");
    if (raw) {
      sessionStorage.removeItem(sfHost + "_sidebar_state");
      return JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function persistedStateSnapshot(state) {
  return {
    messages: state.messages,
    currentProposal: state.currentProposal,
    deploymentStatus: state.deploymentStatus,
    deploymentStep: state.deploymentStep,
    deploymentProgress: state.deploymentProgress,
    deploymentResults: state.deploymentResults,
    deployError: state.deployError,
    deployedObjectName: state.deployedObjectName,
    selectedFields: state.selectedFields,
    visibilityMode: state.visibilityMode,
    selectedProfiles: state.selectedProfiles,
    availableProfiles: state.availableProfiles,
    recordTypesDone: state.recordTypesDone,
    builderMode: state.builderMode || "plan"
  };
}

export function persistState(sfHost, state) {
  try {
    sessionStorage.setItem(sfHost + "_sidebar_state", JSON.stringify(persistedStateSnapshot(state)));
  } catch (e) { /* ignore */ }
}

// Deploy fields restored from a saved snapshot. A saved mid-deploy flag
// means the run was interrupted (the frame was torn down), not that it
// finished.
export function restoredDeployState(saved) {
  const interrupted = saved?.deploymentStatus === "deploying";
  return {
    deploymentStatus: interrupted ? "failed" : (saved?.deploymentStatus || null),
    deploymentStep: interrupted ? "Deployment interrupted" : (saved?.deploymentStep || null),
    deploymentProgress: saved?.deploymentProgress || 0,
    deploymentResults: saved?.deploymentResults || [],
    deployError: interrupted ? INTERRUPTED_DEPLOY_MSG : (saved?.deployError || null),
    deployedObjectName: saved?.deployedObjectName || null
  };
}

// Inspector page + loaded data, saved only when the sidebar minimizes so a
// refresh of the host page resets it (key is consumed on read). Parsed once
// per document — initApp can construct App twice (session fallback race), and
// the second construction must see the same snapshot.
let _inspectorStateCache;
export function loadInspectorState(sfHost) {
  if (_inspectorStateCache !== undefined) return _inspectorStateCache;
  _inspectorStateCache = null;
  try {
    const raw = sessionStorage.getItem(sfHost + "_inspector_state");
    if (raw) {
      sessionStorage.removeItem(sfHost + "_inspector_state");
      _inspectorStateCache = JSON.parse(raw);
    }
  } catch (e) { /* ignore */ }
  return _inspectorStateCache;
}

// opts.hostBoot: the current host-page boot id (URL param); opts.takeSnapshot:
// returns the inspector's serializable state (may throw).
export function saveInspectorState(sfHost, state, {hostBoot = null, takeSnapshot = null} = {}) {
  const payload = {uiMode: state.uiMode || "inspector",
    hostBoot: hostBoot || null, ff: null};
  try { if (takeSnapshot) payload.ff = takeSnapshot(); } catch (e) { /* ignore */ }
  // Quota: retry without the snapshot rather than lose the current page too.
  const attempts = [payload, {...payload, ff: null}];
  for (const attempt of attempts) {
    try {
      sessionStorage.setItem(sfHost + "_inspector_state", JSON.stringify(attempt));
      return;
    } catch (e) { /* try next */ }
  }
}
