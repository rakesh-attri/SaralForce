// SandShift: "Any manual steps for this release?" - asked once per selection,
// from Compare (Next: validate & deploy) or Deploy (Validate / Deploy now).
// The steps go to the selection's runbook, shown in Manual steps.
import {ensureStyle} from "../../ui/confirm.js";
import {releaseState, setRelease} from "./release-state.js";

const h = React.createElement;

// Before the first Validate / Deploy of a selection: what a deploy can't do
// (found by SaralForce) and your own steps before / after it. They go to
// Manual steps (the selection's runbook, then the release's).
const NO_ASK_KEY = "sf_release_no_steps_ask";
const ownStep = (phase, title) => ({key: "own-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), id: "own", custom: true, phase,
  title: title.slice(0, 140), why: "", targets: [], auto: false, setup: "", status: "todo", log: ""});

function StepsDialog({detected, saved, verb, onDone}) {
  React.useEffect(() => { ensureStyle(); }, []);
  const before = (saved || []).filter(x => x.custom && x.id === "own");
  const [own, setOwn] = React.useState(before);
  const [text, setText] = React.useState({pre: "", post: ""});
  const [noAsk, setNoAsk] = React.useState(false);
  const add = p => { if (text[p].trim()) { setOwn([...own, ownStep(p, text[p].trim())]); setText({...text, [p]: ""}); } };
  // Typed but not added yet still counts.
  const all = () => [...own, ...["pre", "post"].filter(p => text[p].trim()).map(p => ownStep(p, text[p].trim()))];
  const finish = go => onDone({go, own: all(), noAsk});
  const noSteps = () => onDone({go: true, own: before, noAsk});
  // Anything to save: a step added or removed, or one typed in a box.
  const added = own !== before || ["pre", "post"].some(p => text[p].trim());
  const group = p => [...detected.filter(d => d.phase === p), ...own.filter(o => o.phase === p)];
  const line = (st2) => h("li", {key: st2.key},
    h("span", null, st2.title),
    h("span", {className: "rel-steps-tag"}, st2.custom ? "yours" : st2.auto ? "SaralForce can run it" : "by hand"),
    st2.custom && h("button", {type: "button", className: "rel-steps-x", title: "Remove", "aria-label": "Remove " + st2.title,
      onClick: () => setOwn(own.filter(o => o.key !== st2.key))}, "✕"));
  // On <body>, like confirmDialog: the panel's own colours don't leak in.
  return ReactDOM.createPortal(h("div", {className: "sf-confirm-overlay", onMouseDown: e => { if (e.target === e.currentTarget) finish(false); }},
    h("div", {className: "sf-confirm-dialog rel-steps-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "rel-steps-title",
      onKeyDown: e => { if (e.key === "Escape") { e.stopPropagation(); finish(false); } }},
      h("h2", {id: "rel-steps-title", className: "sf-confirm-title"}, "Any manual steps for this release?"),
      h("p", {className: "sf-confirm-message"}, "Things to do by hand before or after the deploy (pause an integration, tell the support team, check a report…). " +
        "They're listed in Manual steps, where you tick them off."),
      [["pre", "⏮️ Before the deploy", "e.g. Pause the ERP sync"], ["post", "⏭️ After the deploy", "e.g. Tell the support team"]].map(([p, label, hint]) =>
        h("div", {key: p, className: "rel-steps-group"},
          h("div", {className: "rel-steps-head"}, label),
          group(p).length > 0 && h("ul", null, group(p).map(line)),
          h("div", {className: "rel-steps-add"},
            h("input", {value: text[p], autoFocus: p === "pre", placeholder: hint, "aria-label": label + ": new step",
              onChange: e => setText({...text, [p]: e.target.value}), onKeyDown: e => { if (e.key === "Enter") add(p); }}),
            h("button", {type: "button", className: "sf-confirm-btn", disabled: !text[p].trim(), onClick: () => add(p)}, "＋ Add")))),
      h("label", {className: "rel-steps-noask"}, h("input", {type: "checkbox", checked: noAsk, onChange: e => setNoAsk(e.target.checked)}),
        " Don't ask me again (add steps in Manual steps)"),
      h("div", {className: "sf-confirm-actions"},
        h("button", {type: "button", className: "sf-confirm-btn", onClick: () => finish(false)}, "Cancel"),
        h("button", {type: "button", className: "sf-confirm-btn", onClick: noSteps, title: "Nothing to do by hand: go on"},
          "No steps, " + verb),
        h("button", {type: "button", className: "sf-confirm-btn sf-confirm-btn-primary", disabled: !added, onClick: () => finish(true)},
          "Save and " + verb)))), document.body);
}

// A short fingerprint of what's being deployed (asked once; stale results).
export function selectionSig(keys, deletes) {
  let hash = 5381;
  for (const ch of [...keys].sort().join("|") + "#" + [...deletes].sort().join("|")) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

// askSteps({keys, deletes, detected, verb}) → Promise<boolean> (false: cancelled).
export function useStepsAsk() {
  const [ask, setAsk] = React.useState(null);
  const askSteps = ({keys, deletes, detected, verb}) => {
    const sig = selectionSig(keys, deletes);
    if (releaseState().stepsAsked === sig || localStorage.getItem(NO_ASK_KEY) === "1") return Promise.resolve(true);
    return new Promise(resolve => setAsk({detected, verb, resolve: res => {
      setAsk(null);
      if (res.noAsk) localStorage.setItem(NO_ASK_KEY, "1");
      if (res.go) {
        const keep = (releaseState().runbook || []).filter(x => !(x.custom && x.id === "own"));
        setRelease({runbook: [...keep, ...res.own], stepsAsked: sig});
      }
      resolve(res.go);
    }}));
  };
  const dialog = ask && h(StepsDialog, {detected: ask.detected, saved: releaseState().runbook || [], verb: ask.verb, onDone: ask.resolve});
  return {askSteps, dialog};
}
