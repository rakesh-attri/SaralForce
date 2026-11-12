// Show All Data → Related (parent lookups and child lists, click to open)
// and History (field-history timeline).
import {sfConn, apiVersion} from "../../inspector.js";
import {escapeSoqlString} from "../../core/soql.js";
import {parentLinks, parentNameQuery, parentNames, childLists, historySource, historyRows, nameFieldOf} from "../../core/record-nav.js";
import {queryAll} from "./query.js";
import {ffDescribeObject} from "./describe.js";
import {fmtDateTime} from "./format.js";

const h = React.createElement;

// Account has 100+ child relationships: their COUNT() queries run a few at a
// time. A queued job whose list has unmounted (or whose record changed) is
// skipped by its own `stale` check before it calls Salesforce.
const COUNT_POOL = 5;
let countActive = 0;
const countQueue = [];
function runCount(job) {
  return new Promise(resolve => {
    countQueue.push(() => Promise.resolve().then(job).then(resolve, resolve));
    pumpCounts();
  });
}
function pumpCounts() {
  while (countActive < COUNT_POOL && countQueue.length) {
    countActive++;
    countQueue.shift()().then(() => { countActive--; pumpCounts(); });
  }
}

// Parent names in one query; when one lookup breaks it (a parent object
// without a Name field, a hidden field), read each lookup on its own so the
// others still show names.
async function loadParentNames(obj, id, parents) {
  const sq = parentNameQuery(obj, id, parents);
  if (!sq) return {};
  try {
    return parentNames((await queryAll(sq))[0] || {}, parents);
  } catch (e) {
    const names = {};
    const todo = parents.filter(p => p.relationshipName);
    for (let i = 0; i < todo.length; i += COUNT_POOL) {
      await Promise.all(todo.slice(i, i + COUNT_POOL).map(async p => {
        try {
          Object.assign(names, parentNames((await queryAll(parentNameQuery(obj, id, [p])))[0] || {}, [p]));
        } catch (e2) { /* this parent keeps its Id */ }
      }));
    }
    return names;
  }
}

function ChildList({rel, recordId, onOpen}) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState(null); // {rows, nameField} | {error}
  const [count, setCount] = React.useState(null);
  const load = async () => {
    setState({loading: true});
    try {
      const d = await ffDescribeObject(rel.childSObject);
      const nf = nameFieldOf(d);
      const cols = [...new Set(["Id", nf, (d.fields || []).some(f => f.name === "CreatedDate") ? "CreatedDate" : null].filter(Boolean))];
      const rows = await queryAll(`SELECT ${cols.join(", ")} FROM ${rel.childSObject} WHERE ${rel.field} = '${escapeSoqlString(recordId)}' ` +
        `${cols.includes("CreatedDate") ? "ORDER BY CreatedDate DESC " : ""}LIMIT 50`);
      setState({rows, nameField: nf});
    } catch (e) {
      setState({error: e.message});
    }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !state) load();
  };
  React.useEffect(() => {
    let stale = false;
    runCount(() => {
      if (stale) return null;
      return sfConn.rest(`/services/data/v${apiVersion}/query/?q=` + encodeURIComponent(
        `SELECT COUNT() FROM ${rel.childSObject} WHERE ${rel.field} = '${escapeSoqlString(recordId)}'`), {useCache: false})
        .then(r => { if (!stale) setCount(typeof r.totalSize === "number" ? r.totalSize : null); })
        .catch(() => { if (!stale) setCount(null); });
    });
    return () => { stale = true; };
  }, [rel.childSObject, rel.field, recordId]);
  return h("div", {className: "rn-child" + (count === 0 ? " empty" : "")},
    h("button", {className: "rn-child-h", onClick: toggle, "aria-expanded": open, disabled: count === 0},
      h("span", {className: "rn-chev", "aria-hidden": "true"}, open ? "▾" : "▸"),
      h("span", {className: "rn-rel"}, rel.relationshipName),
      h("span", {className: "insp-meta"}, rel.childSObject),
      h("span", {className: "rn-count"}, count == null ? "…" : count.toLocaleString())),
    open && h("div", {className: "rn-child-b"},
      state && state.loading && h("div", {className: "insp-meta"}, "Loading…"),
      state && state.error && h("div", {className: "insp-error"}, state.error),
      state && state.rows && (state.rows.length
        ? state.rows.map(r => h("button", {key: r.Id, className: "rn-rec", title: "Open this record", onClick: () => onOpen(rel.childSObject, r.Id)},
            h("span", {className: "rn-rec-n"}, r[state.nameField] != null && state.nameField !== "Id" ? String(r[state.nameField]) : r.Id),
            h("span", {className: "rn-rec-id"}, r.Id),
            r.CreatedDate && h("span", {className: "insp-meta"}, fmtDateTime(r.CreatedDate))))
        : h("div", {className: "insp-meta"}, "No records.")),
      state && state.rows && count > state.rows.length && h("div", {className: "insp-meta"}, `Showing the newest ${state.rows.length} of ${count.toLocaleString()}.`)));
}

export function RelatedPanel({obj, id, values, onOpen}) {
  const [data, setData] = React.useState(null);
  const [showAll, setShowAll] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  React.useEffect(() => {
    let stale = false;
    (async () => {
      const d = await ffDescribeObject(obj);
      const parents = parentLinks(d.fields, values);
      const names = await loadParentNames(obj, id, parents);
      if (!stale) setData({parents, names, children: childLists(d), allChildren: childLists(d, {includeSystem: true})});
    })().catch(e => { if (!stale) setData({error: e.message}); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj, id]);
  if (!data) return h("div", {className: "insp-meta rn-pad"}, "Loading relationships…");
  if (data.error) return h("div", {className: "insp-error"}, data.error);
  const t = filter.trim().toLowerCase();
  const kids = (showAll ? data.allChildren : data.children)
    .filter(c => !t || c.relationshipName.toLowerCase().includes(t) || c.childSObject.toLowerCase().includes(t));
  return h("div", {className: "rn"},
    h("div", {className: "rn-sec"},
      h("div", {className: "rn-sec-h"}, `Parents (${data.parents.length})`),
      data.parents.length
        ? h("div", {className: "rn-parents"}, data.parents.map(p => h("button", {
            key: p.field, className: "rn-parent", title: `Open ${p.targets.join(" / ")} ${p.id}`,
            onClick: () => onOpen(p.targets.length === 1 ? p.targets[0] : null, p.id)
          },
            h("span", {className: "rn-parent-l"}, p.label.replace(/ ID$/, "")),
            h("span", {className: "rn-parent-n"}, data.names[p.field] || p.id),
            h("span", {className: "insp-meta"}, p.targets.length === 1 ? p.targets[0] : "lookup"))))
        : h("div", {className: "insp-meta"}, "This record has no filled-in lookups.")),
    h("div", {className: "rn-sec"},
      h("div", {className: "rn-sec-h"},
        `Child records (${kids.length})`,
        h("input", {className: "md-filter acc-filter rn-filter", value: filter, placeholder: "Filter lists…", "aria-label": "Filter child lists",
          onChange: e => setFilter(e.target.value)}),
        h("label", {className: "sq3-check"},
          h("input", {type: "checkbox", checked: showAll, onChange: e => setShowAll(e.target.checked)}),
          h("span", null, "Include system lists"))),
      kids.length
        ? kids.map(c => h(ChildList, {key: c.relationshipName, rel: c, recordId: id, onOpen}))
        : h("div", {className: "insp-meta"}, "No child relationships.")));
}

export function HistoryPanel({obj, id}) {
  const [state, setState] = React.useState(null);
  React.useEffect(() => {
    let stale = false;
    (async () => {
      const d = await ffDescribeObject(obj);
      const src = historySource(d);
      if (!src) return {none: true};
      const labels = Object.fromEntries((d.fields || []).map(f => [f.name, f.label]));
      const recs = await queryAll(`SELECT Id, Field, OldValue, NewValue, CreatedDate, CreatedBy.Name FROM ${src.object} ` +
        `WHERE ${src.field} = '${escapeSoqlString(id)}' ORDER BY CreatedDate DESC LIMIT 200`);
      return {rows: historyRows(recs, labels), source: src.object};
    })().then(s => { if (!stale) setState(s); }).catch(e => { if (!stale) setState({error: e.message}); });
    return () => { stale = true; };
  }, [obj, id]);
  if (!state) return h("div", {className: "insp-meta rn-pad"}, "Loading history…");
  if (state.error) return h("div", {className: "insp-error"}, state.error);
  if (state.none) return h("div", {className: "insp-empty rn-pad"}, `Field history isn't tracked for ${obj}. Turn it on in Setup → Object Manager → ${obj} → Fields & Relationships → Set History Tracking.`);
  if (!state.rows.length) return h("div", {className: "insp-empty rn-pad"}, "No tracked changes yet for this record.");
  return h("div", {className: "rn"},
    h("div", {className: "insp-meta rn-pad"}, `${state.rows.length} change${state.rows.length === 1 ? "" : "s"} · from ${state.source}`),
    h("ol", {className: "rn-hist"}, state.rows.map(r => h("li", {key: r.id, className: "rn-hist-i k-" + r.kind},
      h("div", {className: "rn-hist-h"},
        h("span", {className: "rn-hist-f"}, r.label),
        h("span", {className: "insp-meta"}, `${fmtDateTime(r.at)} · ${r.who}`)),
      r.kind === "changed" && h("div", {className: "rn-hist-v"},
        h("span", {className: "rn-old"}, r.oldValue || "(blank)"),
        h("span", {className: "rn-arrow", "aria-hidden": "true"}, "→"),
        h("span", {className: "rn-new"}, r.newValue || "(blank)"))))));
}
