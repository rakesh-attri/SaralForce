import {sfConn, apiVersion} from "../../inspector.js";
import {confirmDialog} from "../../ui/confirm.js";
import {soqlIdList} from "../../core/access.js";
import {escapeSoqlString} from "../../core/soql.js";
import {queryAll} from "../shared/query.js";
import {appTabsResolveCurrentUserId} from "../shared/apex-debug.js";
import {fmtDateTime} from "../shared/format.js";
import {FFBadge} from "../shared/ui.js";
import {ffIsSfId} from "../shared/record-links.js";
import {useFfSession} from "../shared/session-state.js";

const h = React.createElement;

const WORKITEM_FIELDS = "Id, ActorId, Actor.Name, CreatedDate, ElapsedTimeInDays, " +
  "ProcessInstance.Id, ProcessInstance.TargetObjectId, ProcessInstance.TargetObject.Name, " +
  "ProcessInstance.TargetObject.Type, ProcessInstance.ProcessDefinition.Name, " +
  "ProcessInstance.SubmittedBy.Name, ProcessInstance.Status";

const sfUrl = path => "https://" + sfConn.instanceHostname + path;

function mapWorkitem(w) {
  const pi = w.ProcessInstance || {};
  const t = pi.TargetObject || {};
  return {
    id: w.Id,
    recordId: pi.TargetObjectId,
    recordName: t.Name || pi.TargetObjectId,
    objectType: t.Type || "",
    process: (pi.ProcessDefinition && pi.ProcessDefinition.Name) || "Approval",
    submittedBy: (pi.SubmittedBy && pi.SubmittedBy.Name) || "",
    actor: (w.Actor && w.Actor.Name) || "",
    created: w.CreatedDate,
    days: w.ElapsedTimeInDays,
  };
}

// Work items for the user directly or through a queue/group they belong to.
async function myWorkitems(meId) {
  let groups = [];
  try { groups = (await queryAll(`SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${escapeSoqlString(meId)}'`)).map(g => g.GroupId); }
  catch (e) { /* direct items only */ }
  const ids = soqlIdList([meId, ...groups]);
  return (await queryAll(`SELECT ${WORKITEM_FIELDS} FROM ProcessInstanceWorkitem WHERE ActorId IN (${ids}) ORDER BY CreatedDate DESC LIMIT 200`))
    .map(mapWorkitem);
}

async function orgWorkitems() {
  return (await queryAll(`SELECT ${WORKITEM_FIELDS} FROM ProcessInstanceWorkitem ORDER BY CreatedDate DESC LIMIT 500`)).map(mapWorkitem);
}

async function mySubmissions(meId) {
  const rows = await queryAll("SELECT Id, Status, CreatedDate, CompletedDate, TargetObjectId, TargetObject.Name, TargetObject.Type, " +
    `ProcessDefinition.Name FROM ProcessInstance WHERE SubmittedById = '${escapeSoqlString(meId)}' ORDER BY CreatedDate DESC LIMIT 50`);
  return rows.map(r => ({
    id: r.Id, recordId: r.TargetObjectId, recordName: (r.TargetObject && r.TargetObject.Name) || r.TargetObjectId,
    objectType: (r.TargetObject && r.TargetObject.Type) || "", process: (r.ProcessDefinition && r.ProcessDefinition.Name) || "Approval",
    status: r.Status, created: r.CreatedDate, completed: r.CompletedDate,
  }));
}

// Approve / Reject a work item, or Submit a record, through the REST
// process/approvals resource. Throws with Salesforce's message on failure.
async function approvalAction(actionType, contextId, comments) {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/process/approvals/`, {
    method: "POST",
    useCache: false,
    body: {requests: [{actionType, contextId, comments: comments || undefined}]}
  });
  const r = Array.isArray(res) ? res[0] : res;
  if (r && r.success === false) {
    throw new Error((r.errors || []).map(e => e.message).join("; ") || `${actionType} failed`);
  }
  return r;
}

function ItemRow({item, onAct, busy, showActor}) {
  return h("div", {className: "apv-row"},
    h("div", {className: "apv-main"},
      h("a", {className: "apv-name", href: sfUrl("/" + item.recordId), target: "_blank", rel: "noreferrer",
        title: "Open the record in Salesforce"}, item.recordName, " ↗"),
      h("div", {className: "sq3-card-sub"},
        [item.objectType, item.process, item.submittedBy && `submitted by ${item.submittedBy}`,
          showActor && item.actor && `assigned to ${item.actor}`].filter(Boolean).join(" · "))),
    h("div", {className: "apv-side"},
      item.status
        ? h(FFBadge, {kind: item.status === "Approved" ? "ok" : item.status === "Rejected" ? "err" : item.status === "Pending" ? "warn" : "off"}, item.status)
        : h("span", {className: "insp-meta", title: fmtDateTime(item.created)},
            item.days != null ? `${Math.floor(item.days)}d waiting` : fmtDateTime(item.created)),
      onAct && h("button", {className: "btn btn-primary btn-sm", disabled: busy, onClick: () => onAct("Approve", item)}, "Approve"),
      onAct && h("button", {className: "btn btn-secondary btn-sm", disabled: busy, onClick: () => onAct("Reject", item)}, "Reject")));
}

function ApprovalsView() {
  const [meId, setMeId] = React.useState(null);
  const [scope, setScope] = useFfSession("access", "apvScope", "mine");
  const [items, setItems] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [recent, setRecent] = React.useState(null);
  const [term, setTerm] = React.useState("");
  const [picked, setPicked] = React.useState(null);
  const [submitComment, setSubmitComment] = React.useState("");

  const load = React.useCallback(async (who = meId, which = scope) => {
    if (!who) return;
    setItems(null);
    setError(null);
    try {
      setItems(which === "org" ? await orgWorkitems() : which === "submitted" ? await mySubmissions(who) : await myWorkitems(who));
    } catch (e) {
      setError(e.message);
      setItems([]);
    }
  }, [meId, scope]);

  React.useEffect(() => {
    appTabsResolveCurrentUserId().then(id => { setMeId(id); }).catch(e => setError(e.message));
    queryAll("SELECT Id, Name, Type FROM RecentlyViewed ORDER BY LastViewedDate DESC LIMIT 100")
      .then(setRecent).catch(() => setRecent([]));
  }, []);
  React.useEffect(() => { if (meId) load(meId, scope); }, [meId, scope, load]);

  const act = async (action, item) => {
    const ok = await confirmDialog({
      title: `${action} this request?`,
      message: `${item.recordName} (${item.process})` + (comment.trim() ? `\nComment: ${comment.trim()}` : ""),
      confirmLabel: action,
      danger: action === "Reject"
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      await approvalAction(action, item.id, comment.trim());
      setMsg(`${action === "Approve" ? "Approved" : "Rejected"} ${item.recordName}.`);
      setComment("");
      await load();
    } catch (e) {
      setError(`${action} failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const recordId = picked ? picked.Id : (ffIsSfId(term.trim()) ? term.trim() : null);
  const submit = async () => {
    if (!recordId) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await approvalAction("Submit", recordId, submitComment.trim());
      setMsg(`Submitted ${picked ? picked.Name : recordId} for approval${r && r.instanceStatus ? ` (${r.instanceStatus})` : ""}.`);
      setPicked(null);
      setTerm("");
      setSubmitComment("");
      if (scope !== "org") await load();
    } catch (e) {
      setError(`Submit failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const t = term.trim().toLowerCase();
  const matches = !picked && recent && t && !ffIsSfId(term.trim())
    ? recent.filter(r => String(r.Name || "").toLowerCase().includes(t) || String(r.Type || "").toLowerCase().includes(t)).slice(0, 8)
    : [];
  const pending = scope !== "submitted" && items ? items.length : null;

  return h("div", {className: "apv"},
    scope === "mine" && items && h("div", {className: "apv-banner" + (items.length ? " has-items" : "")},
      h("span", {className: "apv-banner-ico", "aria-hidden": "true"}, items.length ? "⏳" : "✅"),
      items.length ? `${items.length} approval${items.length === 1 ? "" : "s"} waiting for you.` : "No pending approvals — you're all caught up!"),
    h("div", {className: "org-card"},
      h("div", {className: "org-card-h"},
        h("span", {className: "org-card-ico", "aria-hidden": "true"}, "📥"),
        h("span", {className: "org-card-t"}, scope === "org" ? "All pending in org" : scope === "submitted" ? "Submitted by me" : "Your inbox"),
        h("div", {className: "audit-actions"},
          h("button", {className: "btn btn-secondary btn-sm", disabled: !meId, onClick: () => load()}, "Refresh"),
          h("a", {className: "btn btn-secondary btn-sm", href: sfUrl("/lightning/o/ProcessInstanceWorkitem/home"),
            target: "_blank", rel: "noreferrer"}, "Open Inbox ↗"))),
      h("div", {className: "sq3-pills", role: "group", "aria-label": "Which approvals"},
        [["mine", "Assigned to me"], ["org", "All pending in org"], ["submitted", "Submitted by me"]].map(([id, label]) =>
          h("button", {key: id, className: "sq3-pill" + (scope === id ? " active" : ""), onClick: () => setScope(id)},
            label + (scope === id && pending != null ? ` (${pending})` : "")))),
      msg && h("div", {className: "insp-status-ok"}, msg),
      error && h("div", {className: "insp-error"}, error),
      !items && !error && h("div", {className: "insp-meta"}, "Loading…"),
      items && !items.length && !error && h("div", {className: "insp-meta apv-empty"},
        scope === "submitted" ? "You have not submitted anything recently." : "No pending items" + (scope === "mine" ? " for you." : " in this org.")),
      scope !== "submitted" && items && items.length > 0 && h("input", {
        className: "soql-save-input apv-comment",
        value: comment,
        placeholder: "Comment for Approve / Reject (optional)…",
        "aria-label": "Approval comment",
        onChange: e => setComment(e.target.value)
      }),
      items && items.map(it => h(ItemRow, {key: it.id, item: it, busy, showActor: scope === "org",
        onAct: scope === "submitted" ? null : act}))),
    h("div", {className: "org-card"},
      h("div", {className: "org-card-h"},
        h("span", {className: "org-card-ico", "aria-hidden": "true"}, "📤"),
        h("span", {className: "org-card-t"}, "Submit Record for Approval")),
      h("div", {className: "apv-search"},
        h("input", {
          className: "soql-save-input",
          value: picked ? `${picked.Name} (${picked.Type})` : term,
          placeholder: "Search recently viewed records, or paste a record Id…",
          "aria-label": "Record to submit",
          onChange: e => { setPicked(null); setTerm(e.target.value); }
        }),
        matches.length > 0 && h("div", {className: "apv-matches", role: "listbox"},
          matches.map(r => h("div", {
            key: r.Id, role: "option", className: "apv-match",
            onMouseDown: e => { e.preventDefault(); setPicked(r); }
          }, h("span", null, r.Name), h("span", {className: "insp-meta"}, r.Type))))),
      h("input", {
        className: "soql-save-input apv-comment",
        value: submitComment,
        placeholder: "Comment (optional)…",
        "aria-label": "Submission comment",
        onChange: e => setSubmitComment(e.target.value)
      }),
      h("div", {className: "apv-actions"},
        h("button", {className: "btn btn-primary btn-sm", disabled: !recordId || busy, onClick: submit}, busy ? "Working…" : "📤 Submit"),
        h("a", {
          className: "btn btn-secondary btn-sm" + (recordId ? "" : " apv-disabled"),
          href: recordId ? sfUrl("/" + recordId) : undefined,
          "aria-disabled": !recordId,
          target: "_blank", rel: "noreferrer"
        }, "Open Full Page ↗"))));
}

export {ApprovalsView, approvalAction};
