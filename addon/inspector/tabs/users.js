import {sfConn, apiVersion} from "../../inspector.js";
import {safeCopyText} from "../../utils.js";
import {escapeSoqlLike} from "../../core/soql.js";
import {confirmDialog} from "../../ui/confirm.js";
import {ffIsSfId, openRecordInSf} from "../shared/record-links.js";
import {useSfTimeZoneTick, fmtDateTime} from "../shared/format.js";
import {ffIcon, FF_I_SLIDERS} from "../shared/icons.js";
import {FFBadge} from "../shared/ui.js";
import {useFfSession} from "../shared/session-state.js";
import {usersEnsureDebugLevel} from "../shared/apex-debug.js";
import {loadPermSetList} from "../shared/access-data.js";
import {UserAccessCheck} from "./access.js";

const h = React.createElement;

function ffTruthy(v) {
  return v === true || v === "true";
}

// ─── Users tab ──────────────────────────────────────────
let _ffOrgId = null;
async function ffGetOrgId() {
  if (_ffOrgId) return _ffOrgId;
  const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent("SELECT Id FROM Organization LIMIT 1"), {useCache: false});
  _ffOrgId = res.records && res.records[0] && res.records[0].Id;
  if (!_ffOrgId) throw new Error("Could not determine org Id");
  return _ffOrgId;
}

function UsersTab() {
  useSfTimeZoneTick();
  const [q, setQ] = useFfSession("users", "q", "");
  const [users, setUsers] = useFfSession("users", "users", []);
  const [, setUserCols] = useFfSession("users", "userCols", []);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sel, setSel] = useFfSession("users", "sel", null);
  const [detail, setDetail] = useFfSession("users", "detail", null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState(null);
  const [actionErr, setActionErr] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [srcRec, setSrcRec] = React.useState(null);
  const [cloneOpen, setCloneOpen] = React.useState(false);
  const [profiles, setProfiles] = React.useState([]);
  const [roles, setRoles] = React.useState([]);
  const [srcPerms, setSrcPerms] = React.useState(null);
  const [srcLoading, setSrcLoading] = React.useState(false);
  const [cf, setCf] = React.useState(null);
  const [cloning, setCloning] = React.useState(false);
  const [cloneResult, setCloneResult] = React.useState(null);
  const [sites, setSites] = React.useState([]);
  const [expSite, setExpSite] = React.useState("");
  const [profileFilter, setProfileFilter] = useFfSession("users", "profileFilter", "");
  const [roleFilter, setRoleFilter] = useFfSession("users", "roleFilter", "");
  const [allProfiles, setAllProfiles] = React.useState([]);
  const [allRoles, setAllRoles] = React.useState([]);
  const [page, setPage] = React.useState(1);
  const [userTab, setUserTab] = React.useState("details");
  const [loginIp, setLoginIp] = React.useState(null);
  const [cloneStep, setCloneStep] = React.useState(1);
  const [cloneErr, setCloneErr] = React.useState(null);
  const [compSel, setCompSel] = React.useState({profile: true, ps: true, groups: true, roles: true});
  const [resetting, setResetting] = React.useState(false);
  const [freezing, setFreezing] = React.useState(false);
  const [frozenLogin, setFrozenLogin] = React.useState(null);
  const [meId, setMeId] = React.useState(null);
  const [assignable, setAssignable] = React.useState(null);
  const [assignChoice, setAssignChoice] = React.useState("");
  const [psBusy, setPsBusy] = React.useState(false);
  const USR_PAGE_SIZE = 8;

  const mapUserRows = (records) => (records || []).map(r => ({
    Id: r.Id,
    Name: r.Name,
    Username: r.Username,
    Email: r.Email,
    Alias: r.Alias,
    Active: r.IsActive ? "true" : "false",
    ProfileId: r.ProfileId,
    RoleId: r.UserRoleId,
    UserType: r.UserType || "Standard",
    Language: r.LanguageLocaleKey
  }));
  const USER_LIST_FIELDS = "Id, Name, Username, Email, Alias, IsActive, ProfileId, UserRoleId, UserType, LanguageLocaleKey";

  // Live search: the loaded list filters on every keystroke, and the org is
  // queried after a short pause so users beyond the loaded page are found.
  // An empty box brings back the default list. Stale replies are dropped.
  const searchSeq = React.useRef(0);
  const search = async (termText = q, {keepSelection = false} = {}) => {
    const raw = String(termText || "").trim();
    const mine = ++searchSeq.current;
    setError(null);
    if (!keepSelection) { setSel(null); setDetail(null); }
    const term = escapeSoqlLike(raw);
    setLoading(true);
    try {
      const soql = term
        ? `SELECT ${USER_LIST_FIELDS} ` +
          `FROM User WHERE Name LIKE '%${term}%' OR Username LIKE '%${term}%' ` +
          `OR Email LIKE '%${term}%' OR Alias LIKE '%${term}%' ORDER BY Name LIMIT 50`
        : `SELECT ${USER_LIST_FIELDS} FROM User ORDER BY Name LIMIT 25`;
      const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(soql), {useCache: false});
      if (mine !== searchSeq.current) return;
      setUsers(mapUserRows(res.records));
      setUserCols(["Name", "Username", "Email", "Alias", "Active"]);
      setPage(1);
    } catch (e) {
      if (mine === searchSeq.current) setError(e.message);
    } finally {
      if (mine === searchSeq.current) setLoading(false);
    }
  };
  const searchTimer = React.useRef(null);
  const onSearchInput = (value) => {
    setQ(value);
    setPage(1);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => search(value, {keepSelection: true}), 350);
  };
  React.useEffect(() => () => clearTimeout(searchTimer.current), []);
  const qTerm = q.trim().toLowerCase();
  const matchesTerm = (u) => !qTerm ||
    [u.Name, u.Username, u.Email, u.Alias].some(v => String(v || "").toLowerCase().includes(qTerm));

  // Filter dropdown data + first-page auto-load (best-effort; the tab is
  // usable even when Profile/UserRole listing fails).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, rRes] = await Promise.all([
          sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name"), {useCache: false})
            .catch(() => ({records: []})),
          sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent("SELECT Id, Name FROM UserRole ORDER BY Name"), {useCache: false})
            .catch(() => ({records: []}))
        ]);
        if (cancelled) return;
        setAllProfiles((pRes.records || []).map(p => ({id: p.Id, name: p.Name})));
        setAllRoles((rRes.records || []).map(r => ({id: r.Id, name: r.Name})));
      } catch (e) { /* filters stay empty */ }
      if (!cancelled && !users.length) {
        try {
          const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
            encodeURIComponent(`SELECT ${USER_LIST_FIELDS} FROM User ORDER BY Name LIMIT 25`),
            {useCache: false});
          if (cancelled) return;
          const flat = mapUserRows(res.records);
          setUsers(flat);
          setUserCols(["Name", "Username", "Email", "Alias", "Active"]);
          setPage(1);
        } catch (e) { /* list stays empty until searched */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectUser = async (row) => {
    setSel(row);
    setDetail(null);
    setActionMsg(null);
    setActionErr(null);
    setSrcRec(null);
    setCloneOpen(false);
    setCloneResult(null);
    setUserTab("details");
    setDetailLoading(true);
    loadUserExtras(row);
    try {
      const [rec, prof, roleQ] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${encodeURIComponent(row.Id)}`,
          {useCache: false}).catch(() => null),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM Profile WHERE Id = '${row.ProfileId}'`),
          {useCache: false}).catch(() => null),
        row.RoleId ? sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(`SELECT Name FROM UserRole WHERE Id = '${row.RoleId}'`),
          {useCache: false}).catch(() => null) : Promise.resolve(null)
      ]);
      setSrcRec(rec);
      setDetail({
        profile: prof && prof.records && prof.records[0] ? prof.records[0].Name : "unknown",
        role: roleQ && roleQ.records && roleQ.records[0]
          ? roleQ.records[0].Name : (row.RoleId ? "unknown" : "—"),
        lastLogin: rec && rec.LastLoginDate ? rec.LastLoginDate : null,
        created: rec && rec.CreatedDate ? rec.CreatedDate : null
      });
    } catch (e) {
      setDetail({profile: "unknown", role: "—", lastLogin: null, created: null});
    } finally {
      setDetailLoading(false);
    }
  };

  const isCommunityUser = (u) => !!u && ffTruthy(u.Active) && !!u.UserType && u.UserType !== "Standard";
  // Frozen state lives on the UserLogin row — User.IsFrozen is rejected by
  // REST/Apex (INVALID_FIELD). null until loaded, and when unavailable.
  const frozen = !!(frozenLogin && ffTruthy(frozenLogin.IsFrozen));

  // Current user Id — guards the Freeze action against locking yourself out.
  React.useEffect(() => {
    let cancelled = false;
    sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/me`, {useCache: false})
      .then(me => { if (!cancelled && me && me.Id) setMeId(me.Id); })
      .catch(() => { /* guard simply stays inactive */ });
    return () => { cancelled = true; };
  }, []);

  // Load the user's UserLogin row (requires the Manage Users permission) —
  // it drives the Is Frozen badge and the Freeze/Unfreeze action.
  React.useEffect(() => {
    let cancelled = false;
    setFrozenLogin(null);
    if (!sel || !sel.Id) return () => { cancelled = true; };
    sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
      encodeURIComponent(`SELECT Id, IsFrozen FROM UserLogin WHERE UserId = '${sel.Id}'`),
      {useCache: false})
      .then(res => {
        if (!cancelled && res && res.records && res.records[0]) {
          setFrozenLogin(res.records[0]);
        }
      })
      .catch(() => { /* frozen state unavailable without Manage Users */ });
    return () => { cancelled = true; };
  }, [sel && sel.Id]);

  React.useEffect(() => {
    if (!isCommunityUser(sel)) { setSites([]); setExpSite(""); return; }
    let cancelled = false;
    setSites([]);
    setExpSite("");
    sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
      encodeURIComponent("SELECT Id, Name, UrlPathPrefix, Status FROM Network WHERE Status = 'Live' ORDER BY Name"),
      {useCache: false})
      .then(res => {
        if (cancelled) return;
        const list = res.records || [];
        setSites(list);
        setExpSite(list.length ? list[0].Id : "");
      })
      .catch(() => { if (!cancelled) { setSites([]); setExpSite(""); } });
    return () => { cancelled = true; };
  }, [sel]);

  const loginAs = async (incognito) => {
    if (!sel) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("login");
    try {
      const orgId = await ffGetOrgId();
      const url = `https://${sfConn.instanceHostname}/servlet/servlet.su` +
        `?oid=${orgId}&suorgadminid=${sel.Id}&retURL=%2F&targetURL=%2Flightning%2Fpage%2Fhome`;
      window.open(url, "_blank");
      setActionMsg(`Login-as link opened for ${sel.Username} (requires "Log in as another user" permission).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const loginToExpSite = async () => {
    if (!sel || !expSite) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("expLogin");
    try {
      const orgId = await ffGetOrgId();
      const site = sites.find(s => s.Id === expSite) || sites[0];
      const prefix = site && site.UrlPathPrefix ? `/${site.UrlPathPrefix}` : "";
      const home = `${prefix}/s/`;
      const url = `https://${sfConn.instanceHostname}/servlet/servlet.su` +
        `?oid=${orgId}&retURL=${encodeURIComponent(home)}` +
        `&sunetworkid=${site ? site.Id : ""}&sunetworkuserid=${sel.Id}`;
      window.open(url, "_blank");
      setActionMsg(`Experience login opened for ${sel.Username} on ${site ? site.Name : "site"} (requires login-as permission).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const enableLogs = async () => {
    if (!sel) return;
    setActionMsg(null);
    setActionErr(null);
    setBusy("logs");
    try {
      const levelId = await usersEnsureDebugLevel();
      const now = new Date();
      const exp = new Date(now.getTime() + 30 * 60000);
      await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/TraceFlag`, {
        method: "POST",
        useCache: false,
        body: {
          TracedEntityId: sel.Id,
          LogType: "USER_DEBUG",
          DebugLevelId: levelId,
          StartDate: now.toISOString(),
          ExpirationDate: exp.toISOString()
        }
      });
      setActionMsg(`Debug logs enabled for ${sel.Username} for 30 minutes (Setup → Debug Logs).`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const copyId = async () => {
    if (!sel) return;
    const ok = await safeCopyText(sel.Id);
    if (ok) setActionMsg(`Copied Id ${sel.Id}`);
    else setActionErr(`Copy was blocked by the browser — copy the Id manually: ${sel.Id}`);
  };

  // Reset Password: invalidates the current password and emails the user a
  // reset link (also unlocks a locked-out account). Documented REST:
  // DELETE /sobjects/User/{id}/password.
  const resetPassword = async () => {
    if (!sel) return;
    const user = sel;
    const ok = await confirmDialog({
      title: "Reset password?",
      message: `${user.Name || user.Username} (${user.Username}) will be emailed a reset link and ` +
        "their current password will stop working immediately. This cannot be undone.",
      confirmLabel: "Reset Password",
      danger: true
    });
    if (!ok) return;
    setActionMsg(null);
    setActionErr(null);
    setResetting(true);
    try {
      await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${user.Id}/password`, {
        method: "DELETE",
        useCache: false
      });
      setActionMsg(`Password reset sent for ${user.Username} — their current password is now invalid and they will receive a reset link. This also unlocks a locked-out account.`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setResetting(false);
    }
  };

  // Freeze / unfreeze: the flag lives on the UserLogin row — User.IsFrozen
  // is rejected by the REST API (INVALID_FIELD: no such column). Requires
  // the "Freeze and unfreeze users" (Manage Users) permission — a missing
  // grant surfaces the API error in the action-error line. The button label
  // flips from the local UserLogin update, and again from the server on the
  // next selection.
  const toggleFreeze = async () => {
    if (!sel || !frozenLogin) return;
    if (meId && sel.Id === meId) {
      setActionMsg(null);
      setActionErr("You cannot freeze or unfreeze your own user.");
      return;
    }
    const user = sel;
    const login = frozenLogin;
    const next = !ffTruthy(login.IsFrozen);
    const ok = await confirmDialog(next
      ? {
        title: "Freeze user?",
        message: `${user.Name || user.Username} (${user.Username}) will be blocked from logging in ` +
          "until the account is unfrozen.",
        confirmLabel: "Freeze User",
        danger: true
      }
      : {
        title: "Unfreeze user?",
        message: `${user.Name || user.Username} (${user.Username}) will be able to log in again.`,
        confirmLabel: "Unfreeze User"
      });
    if (!ok) return;
    setActionMsg(null);
    setActionErr(null);
    setFreezing(true);
    try {
      await sfConn.rest(`/services/data/v${apiVersion}/sobjects/UserLogin/${encodeURIComponent(login.Id)}`, {
        method: "PATCH",
        useCache: false,
        body: {IsFrozen: next}
      });
      setFrozenLogin(prev => (prev && prev.Id === login.Id ? {...prev, IsFrozen: next} : prev));
      setActionMsg(next
        ? `${user.Username} is now frozen — they cannot log in until unfrozen.`
        : `${user.Username} has been unfrozen and can log in again.`);
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setFreezing(false);
    }
  };

  // ── Clone user: same profile/role, copied permission sets, groups ──
  // Shared assignment loader (clone wizard + detail tabs).
  const fetchAssignments = async (userId) => {
    const [assignRes, grpRes] = await Promise.all([
      sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(
          `SELECT Id, PermissionSetId, PermissionSet.Name, PermissionSet.Label, ` +
          `PermissionSet.IsOwnedByProfile, PermissionSetGroupId, PermissionSetGroup.MasterLabel ` +
          `FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`), {useCache: false}),
      sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(
          `SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${userId}'`),
        {useCache: false}).catch(() => ({records: []}))
    ]);
    const rows = assignRes.records || [];
    const direct = rows.filter(a =>
      a.PermissionSet && a.PermissionSet.IsOwnedByProfile !== true && a.PermissionSetId);
    // Group assignments carry PermissionSetGroupId; their PermissionSetId is
    // the group's internal aggregate set, which cannot be assigned directly.
    const ps = [];
    const psg = [];
    for (const a of direct) {
      const entry = {
        id: a.PermissionSetId,
        assignmentId: a.Id,
        groupId: a.PermissionSetGroupId || null,
        name: a.PermissionSetGroupId
          ? (a.PermissionSetGroup && a.PermissionSetGroup.MasterLabel) || a.PermissionSetGroupId
          : (a.PermissionSet && (a.PermissionSet.Label || a.PermissionSet.Name)) || a.PermissionSetId
      };
      (entry.groupId ? psg : ps).push(entry);
    }
    let groups = [];
    const grpIds = (grpRes.records || []).map(g => g.GroupId).filter(Boolean);
    if (grpIds.length) {
      try {
        const gDetail = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent(
            `SELECT Id, Name, Type FROM Group WHERE Id IN (${grpIds.map(id => `'${id}'`).join(",")})`),
          {useCache: false});
        groups = (gDetail.records || [])
          .filter(g => g.Type === "Regular" || g.Type === "Queue")
          .map(g => ({id: g.Id, name: `${g.Name} (${g.Type})`}));
      } catch (e) { /* skip groups */ }
    }
    return {ps, psg, groups};
  };

  // ── Assign / remove permission sets and groups (Permission Sets tab) ──
  React.useEffect(() => {
    if (userTab !== "ps" || assignable) return;
    loadPermSetList()
      .then(list => setAssignable(list.filter(p => p.kind !== "profile")))
      .catch(() => setAssignable([]));
  }, [userTab, assignable]);

  const reloadAssignments = async (userId) => {
    try { setSrcPerms(await fetchAssignments(userId)); }
    catch (e) { setActionErr(e.message); }
  };

  const assignPerm = async () => {
    const p = assignable && assignable.find(x => x.id === assignChoice);
    if (!sel || !p) return;
    setPsBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetAssignment`, {
        method: "POST",
        useCache: false,
        body: p.groupId
          ? {AssigneeId: sel.Id, PermissionSetGroupId: p.groupId}
          : {AssigneeId: sel.Id, PermissionSetId: p.id}
      });
      setActionMsg(`Assigned ${p.name} to ${sel.Name}.`);
      setAssignChoice("");
      await reloadAssignments(sel.Id);
    } catch (e) {
      setActionErr(`Could not assign ${p.name}: ${e.message}`);
    } finally {
      setPsBusy(false);
    }
  };

  const removePerm = async (p) => {
    if (!sel || !p.assignmentId) return;
    const ok = await confirmDialog({
      title: p.groupId ? "Remove permission set group?" : "Remove permission set?",
      message: `${sel.Name} will lose everything ${p.name} grants, effective immediately.`,
      confirmLabel: "Remove",
      danger: true
    });
    if (!ok) return;
    setPsBusy(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetAssignment/${encodeURIComponent(p.assignmentId)}`,
        {method: "DELETE", useCache: false});
      setActionMsg(`Removed ${p.name} from ${sel.Name}.`);
      await reloadAssignments(sel.Id);
    } catch (e) {
      setActionErr(`Could not remove ${p.name}: ${e.message}`);
    } finally {
      setPsBusy(false);
    }
  };

  // Detail-tab extras: assignments for the PS/Groups tabs + latest login IP.
  const loadUserExtras = async (row) => {
    setSrcPerms(null);
    setLoginIp(null);
    try {
      const perms = await fetchAssignments(row.Id);
      setSrcPerms(perms);
    } catch (e) { /* tabs show empty state */ }
    try {
      const lh = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
        encodeURIComponent(
          `SELECT UserId, SourceIp, LoginTime, Status FROM LoginHistory ` +
          `WHERE UserId = '${row.Id}' ORDER BY LoginTime DESC LIMIT 20`),
        {useCache: false}).catch(() => null);
      const rows = (lh && lh.records || [])
        .sort((a, b) => String(b.LoginTime || "").localeCompare(String(a.LoginTime || "")));
      const hit = rows.find(r => r.Status === "Success" && r.SourceIp) || rows[0];
      if (hit && hit.SourceIp) setLoginIp(hit.SourceIp);
    } catch (e) { /* IP stays blank */ }
  };

  const openClone = async () => {
    if (!sel) return;
    setCloneOpen(true);
    setCloneStep(1);
    setCloneErr(null);
    setCompSel({profile: true, ps: true, groups: true, roles: true});
    setCloneResult(null);
    setSrcLoading(true);
    setActionMsg(null);
    setActionErr(null);
    try {
      const [profRes, roleRes, perms] = await Promise.all([
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name"), {useCache: false}),
        sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
          encodeURIComponent("SELECT Id, Name FROM UserRole ORDER BY Name"), {useCache: false})
          .catch(() => ({records: []})),
        fetchAssignments(sel.Id)
      ]);
      setProfiles((profRes.records || []).map(p => ({id: p.Id, name: p.Name})));
      setRoles((roleRes.records || []).map(r => ({id: r.Id, name: r.Name})));
      const {ps, psg, groups} = perms;
      setSrcPerms({ps, psg, groups});
      const rec = srcRec || {};
      setCf({
        firstName: rec.FirstName || "",
        lastName: rec.LastName || "",
        email: "",
        username: "",
        alias: String(rec.Alias || "").slice(0, 8),
        nick: "",
        password: "",
        profileId: rec.ProfileId || sel.ProfileId || "",
        roleId: rec.UserRoleId || "",
        psIds: [...ps, ...psg].map(p => p.id),
        grpIds: groups.map(g => g.id),
        active: true,
        locale: {
          TimeZoneSidKey: rec.TimeZoneSidKey || "Asia/Kolkata",
          LocaleSidKey: rec.LocaleSidKey || "en_US",
          EmailEncodingKey: rec.EmailEncodingKey || "UTF-8",
          LanguageLocaleKey: rec.LanguageLocaleKey || "en_US"
        }
      });
    } catch (e) {
      setActionErr(e.message);
      setCloneOpen(false);
    } finally {
      setSrcLoading(false);
    }
  };

  const validateClone = () => {
    if (!cf) return "Still loading the source user — wait a moment.";    if (!cf.lastName.trim()) return "Last Name is required";
    if (!cf.email.trim()) return "Email is required";
    if (!cf.username.trim()) return "Username is required (must be globally unique, e.g. name@company.org)";
    if (!cf.profileId) return compSel.profile
      ? "Pick a profile"
      : "Pick a profile (or re-check Profile to copy the source profile)";
    return null;
  };

  const doClone = async () => {
    if (!sel || !cf) return;
    setCloneResult(null);
    setCloneErr(null);
    const problem = validateClone();
    if (problem) { setCloneErr(problem); return; }
    const firstName = cf.firstName.trim();
    const lastName = cf.lastName.trim();
    const email = cf.email.trim();
    const username = cf.username.trim();
    setCloning(true);
    const failures = [];
    let newId = null;
    try {
      // 1. Create the user (identity fields come from the form, everything
      //    else — profile, role, locale — is cloned from the source user).
      const body = {
        FirstName: firstName || undefined,
        LastName: lastName,
        Email: email,
        Username: username,
        Alias: (cf.alias.trim() || lastName.replace(/[^A-Za-z]/g, "") || "user").slice(0, 8),
        CommunityNickname: cf.nick.trim() || username.split("@")[0].slice(0, 40),
        TimeZoneSidKey: cf.locale.TimeZoneSidKey,
        LocaleSidKey: cf.locale.LocaleSidKey,
        EmailEncodingKey: cf.locale.EmailEncodingKey,
        LanguageLocaleKey: cf.locale.LanguageLocaleKey,
        ProfileId: cf.profileId,
        IsActive: !!cf.active
      };
      if (cf.roleId) body.UserRoleId = cf.roleId;
      const created = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User`, {
        method: "POST",
        useCache: false,
        body
      });
      newId = created && created.id;
      if (!newId) throw new Error("User create returned no Id");
      // 2. Optional password (admin-set).
      let pwOk = null;
      if (cf.password) {
        try {
          await sfConn.rest(`/services/data/v${apiVersion}/sobjects/User/${newId}/password`, {
            method: "POST",
            useCache: false,
            body: {NewPassword: cf.password}
          });
          pwOk = true;
        } catch (e) {
          pwOk = false;
          failures.push(`password: ${e.message}`);
        }
      }
      // 3. Copy selected permission sets + permission set groups.
      let psOk = 0;
      const wantPs = new Set(cf.psIds || []);
      const psList = srcPerms ? [...srcPerms.ps, ...srcPerms.psg].filter(p => wantPs.has(p.id)) : [];
      if (srcPerms) {
        for (const p of psList) {
          try {
            await sfConn.rest(`/services/data/v${apiVersion}/sobjects/PermissionSetAssignment`, {
              method: "POST",
              useCache: false,
              body: p.groupId
                ? {AssigneeId: newId, PermissionSetGroupId: p.groupId}
                : {AssigneeId: newId, PermissionSetId: p.id}
            });
            psOk++;
          } catch (e) {
            failures.push(`${p.name}: ${e.message}`);
          }
        }
      }
      // 4. Copy selected public group / queue memberships.
      let grpOk = 0;
      const wantGrp = new Set(cf.grpIds || []);
      const grpList = srcPerms ? srcPerms.groups.filter(g => wantGrp.has(g.id)) : [];
      if (srcPerms) {
        for (const g of grpList) {
          try {
            await sfConn.rest(`/services/data/v${apiVersion}/sobjects/GroupMember`, {
              method: "POST",
              useCache: false,
              body: {GroupId: g.id, UserOrGroupId: newId}
            });
            grpOk++;
          } catch (e) {
            failures.push(`${g.name}: ${e.message}`);
          }
        }
      }
      const totalPs = psList.length;
      const totalGrp = grpList.length;
      setCloneResult({
        ok: failures.length === 0,
        newId,
        summary: `User created (${newId}): ` +
          `${psOk}/${totalPs} permission sets/groups, ` +
          `${grpOk}/${totalGrp} group memberships` +
          (cf.password ? (pwOk ? ", password set" : ", password FAILED") : ", no password set") +
          ".",
        failures: failures.slice(0, 6)
      });
      setCf(prev => prev ? {...prev, password: ""} : prev);
    } catch (e) {
      setCloneResult({
        ok: false,
        newId,
        summary: e.message,
        failures: failures.slice(0, 6)
      });
    } finally {
      setCloning(false);
    }
  };

  const filteredUsers = users.filter(u => matchesTerm(u) &&
    (!profileFilter || u.ProfileId === profileFilter) &&
    (!roleFilter || u.RoleId === roleFilter));
  const usrPageCount = Math.max(1, Math.ceil(filteredUsers.length / USR_PAGE_SIZE));
  const usrSafePage = Math.min(Math.max(1, page), usrPageCount);
  const usrPageUsers = filteredUsers.slice(
    (usrSafePage - 1) * USR_PAGE_SIZE, usrSafePage * USR_PAGE_SIZE);
  const usrInitials = (u) => String((u && (u.Alias || u.Name)) || "?").slice(0, 2).toUpperCase();
  const profileNameOf = (pid) => {
    if (!pid) return "";
    const f = allProfiles.find(p => p.id === pid) || profiles.find(p => p.id === pid);
    if (f) return f.name;
    if (detail && sel && sel.ProfileId === pid) return detail.profile;
    return "";
  };
  const USR_TABS = [
    ["details", "Details"], ["ps", "Permission Sets"], ["access", "Access Check"], ["groups", "Groups"],
    ["profile", "Profiles"], ["role", "Roles"], ["settings", "Settings"]
  ];

  // Clone-wizard component toggles (mapped components only). Unchecking
  // clears the matching selection so the copy step skips it.
  const toggleComp = (key) => {
    const on = !compSel[key];
    setCompSel({...compSel, [key]: on});
    if (!cf) return;
    if (key === "profile")
      setCf({...cf, profileId: on ? (srcRec && srcRec.ProfileId || sel.ProfileId || "") : ""});
    if (key === "roles")
      setCf({...cf, roleId: on ? (srcRec && srcRec.UserRoleId || sel.RoleId || "") : ""});
    if (key === "ps")
      setCf({...cf, psIds: on && srcPerms ? [...srcPerms.ps, ...srcPerms.psg].map(p => p.id) : []});
    if (key === "groups")
      setCf({...cf, grpIds: on && srcPerms ? srcPerms.groups.map(g => g.id) : []});
  };

  return h("div", {className: "insp-panel"},
    h("div", {className: "usr-layout"},
      h("div", {className: "usr-side"},
        h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-ico", "aria-hidden": "true"}, ffIcon(FF_I_SLIDERS)),
            h("span", {className: "sq3-card-t"}, "Users")),
          h("div", {className: "usr-search"},
            h("input", {
              value: q,
              placeholder: "Search by name, email, or alias…",
              "aria-label": "Search users",
              onChange: e => onSearchInput(e.target.value),
              onKeyDown: e => {
                if (e.key === "Enter") { clearTimeout(searchTimer.current); search(); }
                if (e.key === "Escape" && q) onSearchInput("");
              }
            }),
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: !q.trim(),
              title: "Search users",
              onClick: () => { clearTimeout(searchTimer.current); search(); }
            }, "Search users")
          ),
          h("div", {className: "sq3-card-sub"}, "Filters"),
          h("div", {className: "usr-filters"},
            h("select", {
              value: profileFilter,
              title: "Filter by profile",
              onChange: e => { setProfileFilter(e.target.value); setPage(1); }
            },
              h("option", {value: ""}, "All Profiles"),
              allProfiles.map(p => h("option", {key: p.id, value: p.id}, p.name))),
            h("select", {
              value: roleFilter,
              title: "Filter by role",
              onChange: e => { setRoleFilter(e.target.value); setPage(1); }
            },
              h("option", {value: ""}, "All Roles"),
              allRoles.map(r => h("option", {key: r.id, value: r.id}, r.name)))
          ),
          h("div", {className: "insp-meta"}, `Total Users: ${filteredUsers.length}`),
          error && h("div", {className: "insp-error"}, error),
          loading && !users.length && h("div", {className: "insp-meta"}, "Loading users…"),
          !loading && !filteredUsers.length && !error &&
            h("div", {className: "insp-meta"}, q.trim()
              ? `No users matching "${q.trim()}".`
              : "No users found — search above."),
          usrPageUsers.map(u =>
            h("div", {
              key: u.Id,
              className: "usr-row" + (sel && sel.Id === u.Id ? " selected" : ""),
              role: "button",
              tabIndex: 0,
              title: `${u.Name} — click to select user`,
              onClick: () => selectUser(u),
              onKeyDown: e => { if (e.key === "Enter") selectUser(u); }
            },
              h("span", {className: "usr-avatar", "aria-hidden": "true"}, usrInitials(u)),
              h("span", {className: "usr-row-tx"},
                h("span", {className: "usr-row-name"}, u.Name),
                h("span", {className: "usr-row-sub"}, u.Username || u.Email || ""),
                h("span", {className: "usr-row-sub"}, profileNameOf(u.ProfileId) || "—")),
              h("span", {className: "usr-row-end"},
                h(FFBadge, {kind: ffTruthy(u.Active) ? "ok" : "off"},
                  ffTruthy(u.Active) ? "Active" : "Inactive"),
                h("span", {className: "usr-row-chev", "aria-hidden": "true"}, "›")))),
          usrPageCount > 1 && h("div", {className: "usr-pages"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: usrSafePage <= 1,
              onClick: () => setPage(usrSafePage - 1)
            }, "‹"),
            Array.from({length: usrPageCount}, (_, i) =>
              h("button", {
                key: i,
                className: "btn btn-sm" + (usrSafePage === i + 1 ? " btn-primary" : " btn-secondary"),
                onClick: () => setPage(i + 1)
              }, String(i + 1))),
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: usrSafePage >= usrPageCount,
              onClick: () => setPage(usrSafePage + 1)
            }, "›"))
        )
      ),
      h("div", {className: "usr-main"},
        sel ? h("div", {className: "sq3-card"},
          h("div", {className: "usr-dhead"},
            h("span", {className: "usr-avatar usr-avatar-xl", "aria-hidden": "true"}, usrInitials(sel)),
            h("div", {className: "usr-dtitle"},
              h("div", {className: "usr-dname"},
                sel.Name, " ",
                sel.Active != null && h(FFBadge, {kind: ffTruthy(sel.Active) ? "ok" : "off"},
                  ffTruthy(sel.Active) ? "Active" : "Inactive")),
              h("div", {className: "sq3-card-sub"},
                sel.Username,
                h("span", {className: "usr-sep", "aria-hidden": "true"}, " | "),
                detailLoading ? "Loading profile…" : (detail ? detail.profile : "—")))),
          h("div", {className: "user-actions"},
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: busy === "login",
              onClick: () => loginAs(false)
            }, busy === "login" ? "Opening…" : "Login As"),
        isCommunityUser(sel) && h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: busy === "expLogin" || !sites.length,
          title: !sites.length
            ? "No live Experience sites found in this org"
            : `Log in to the Experience site as ${sel.Username} (community user must be active)`,
          onClick: loginToExpSite
        }, busy === "expLogin" ? "Opening…" : "Login to Exp Site"),
        isCommunityUser(sel) && sites.length > 1 && h("label", {className: "user-sitepick", title: "Choose the Experience site"},
          h("span", null, "Site"),
          h("select", {
            value: expSite,
            onChange: e => setExpSite(e.target.value)
          }, sites.map(s => h("option", {key: s.Id, value: s.Id}, s.Name)))
        ),
        h("button", {
          className: "btn btn-secondary btn-sm",
          disabled: busy === "logs",
          title: "Create a 30-minute USER_DEBUG trace flag for this user",
          onClick: enableLogs
        }, busy === "logs" ? "Enabling…" : "Enable Logs"),
          h("button", {
            className: "btn btn-secondary btn-sm",
            onClick: copyId
          }, "Copy Id"),
          ffIsSfId(sel.Id) && h("button", {
            className: "btn btn-secondary btn-sm",
            title: "Open this user in Salesforce",
            onClick: (e) => openRecordInSf(sel.Id, e)
          }, "View in Salesforce")
          )
        ) : h("div", {className: "sq3-card"},
          h("div", {className: "insp-meta"}, "Select a user on the left to inspect details, permissions and login info.")),
        sel && h("div", {className: "sq3-card"},
          h("div", {className: "usr-tabs", role: "tablist"},
            USR_TABS.map(([id, label]) =>
              h("button", {
                key: id,
                role: "tab",
                className: "usr-tab" + (userTab === id ? " active" : ""),
                "aria-selected": userTab === id ? "true" : "false",
                onClick: () => setUserTab(id)
              }, label)))),
        sel && userTab === "details" && h("div", {className: "usr-grid2"},
          h("div", {className: "sq3-card"},
            h("div", {className: "sq3-card-h"},
              h("span", {className: "sq3-card-t"}, "User Information")),
            h("div", {className: "usr-kv"},
              [["First Name", srcRec && srcRec.FirstName],
               ["Last Name", srcRec && srcRec.LastName],
               ["Email", sel.Email],
               ["Username", sel.Username],
               ["Alias", sel.Alias],
               ["Nickname", srcRec && srcRec.CommunityNickname],
               ["Phone", srcRec && srcRec.Phone],
               ["Mobile", srcRec && srcRec.MobilePhone],
               ["Language", sel.Language],
               ["Time Zone", srcRec && srcRec.TimeZoneSidKey],
               ["Locale", srcRec && srcRec.LocaleSidKey],
               ["Email Encoding", srcRec && srcRec.EmailEncodingKey]
              ].map(([k, v]) =>
                h("div", {key: k, className: "usr-kv-row"},
                  h("span", {className: "usr-kv-k"}, k),
                  h("span", {className: "usr-kv-v"}, v || "—"))))),
          h("div", null,
            h("div", {className: "sq3-card"},
              h("div", {className: "sq3-card-h"},
                h("span", {className: "sq3-card-t"}, "Account & Login")),
              h("div", {className: "usr-kv"},
                [["User ID", sel.Id],
                 ["User Type", sel.UserType],
                 ["Last Login", detail && detail.lastLogin ? fmtDateTime(detail.lastLogin) : null],
                 ["Created Date", detail && detail.created ? fmtDateTime(detail.created) : null],
                 ["Last Modified Date", srcRec && srcRec.LastModifiedDate ? fmtDateTime(srcRec.LastModifiedDate) : null],
                 ["Login IP", loginIp]
                ].map(([k, v]) =>
                  h("div", {key: k, className: "usr-kv-row"},
                    h("span", {className: "usr-kv-k"}, k),
                    h("span", {className: "usr-kv-v"}, v || "—"))),
                h("div", {className: "usr-kv-row"},
                  h("span", {className: "usr-kv-k"}, "Is Active"),
                  h("span", {className: "usr-kv-v"},
                    sel.Active != null && h(FFBadge, {kind: ffTruthy(sel.Active) ? "ok" : "off"},
                      ffTruthy(sel.Active) ? "Yes" : "No"))),
                frozenLogin && h("div", {className: "usr-kv-row"},
                  h("span", {className: "usr-kv-k"}, "Is Frozen"),
                  h("span", {className: "usr-kv-v"},
                    h(FFBadge, {kind: frozen ? "off" : "ok"},
                      frozen ? "Yes" : "No"))))),
            h("div", {className: "sq3-card"},
              h("div", {className: "sq3-card-h"},
                h("span", {className: "sq3-card-t"}, "Quick Actions")),
              h("div", {className: "usr-qa"},
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  disabled: busy === "login",
                  onClick: () => loginAs(false)
                }, "Login As"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  title: "Create a new user with the same profile, role, permission sets and groups",
                  onClick: () => (cloneOpen ? setCloneOpen(false) : openClone())
                }, cloneOpen ? "Close Clone" : "Clone User"),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  disabled: freezing || !frozenLogin,
                  title: !frozenLogin
                    ? "Frozen state unavailable (requires the Manage Users permission)"
                    : frozen
                      ? "Unfreeze this user so they can log in again"
                      : "Freeze this user — they cannot log in until unfrozen",
                  onClick: toggleFreeze
                }, freezing
                  ? (frozen ? "Unfreezing…" : "Freezing…")
                  : (frozen ? "Unfreeze User" : "Freeze User")),
                h("button", {
                  className: "btn btn-secondary btn-sm",
                  disabled: resetting,
                  title: "Invalidate the current password and email the user a reset link (also unlocks a locked-out account)",
                  onClick: resetPassword
                }, resetting ? "Sending…" : "Reset Password")))
          )
        ),
        sel && userTab === "ps" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-t"}, "Permission Sets")),
          !srcPerms && h("div", {className: "insp-meta"}, "Loading assignments…"),
          srcPerms && !(srcPerms.ps.length + srcPerms.psg.length) &&
            h("div", {className: "insp-meta"}, "No direct permission set assignments (profile permissions still apply)."),
          srcPerms && [...srcPerms.psg, ...srcPerms.ps].map(p =>
            h("div", {key: p.id, className: "usr-kv-row"},
              h("span", {className: "usr-kv-v"}, p.name),
              h("span", {className: "usr-kv-k"}, p.groupId ? "Group" : "Set",
                p.assignmentId && h("button", {
                  className: "sq3-saved-x",
                  title: `Remove ${p.name}`,
                  "aria-label": `Remove ${p.name}`,
                  disabled: psBusy,
                  onClick: () => removePerm(p)
                }, "×")))),
          srcPerms && h("div", {className: "soql-save-row acc-pick-row"},
            h("select", {
              className: "soql-save-input",
              value: assignChoice,
              "aria-label": "Permission set or group to assign",
              disabled: !assignable || psBusy,
              onChange: e => setAssignChoice(e.target.value)
            },
              h("option", {value: ""}, assignable ? "Assign a permission set or group…" : "Loading…"),
              assignable && [["set", "Permission sets"], ["group", "Permission set groups"]].map(([kind, label]) =>
                h("optgroup", {key: kind, label},
                  assignable
                    .filter(p => p.kind === kind &&
                      ![...srcPerms.ps, ...srcPerms.psg].some(a => a.id === p.id || (p.groupId && a.groupId === p.groupId)))
                    .map(p => h("option", {key: p.id, value: p.id}, p.name))))),
            h("button", {
              className: "btn btn-primary btn-sm",
              disabled: !assignChoice || psBusy,
              onClick: assignPerm
            }, psBusy ? "Saving…" : "Assign"))),
        sel && userTab === "access" && h(UserAccessCheck, {userId: sel.Id}),
        sel && userTab === "groups" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-t"}, "Groups")),
          !srcPerms && h("div", {className: "insp-meta"}, "Loading memberships…"),
          srcPerms && !srcPerms.groups.length &&
            h("div", {className: "insp-meta"}, "No public group or queue memberships."),
          srcPerms && srcPerms.groups.map(g =>
            h("div", {key: g.id, className: "usr-kv-row"},
              h("span", {className: "usr-kv-v"}, g.name),
              h("span", {className: "usr-kv-k ff-mono"}, g.id)))),
        sel && userTab === "profile" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-t"}, "Profiles")),
          h("div", {className: "usr-kv"},
            h("div", {className: "usr-kv-row"},
              h("span", {className: "usr-kv-k"}, "Profile"),
              h("span", {className: "usr-kv-v"},
                detailLoading ? "…" : (detail ? detail.profile : "—"))),
            h("div", {className: "usr-kv-row"},
              h("span", {className: "usr-kv-k"}, "Profile ID"),
              h("span", {className: "usr-kv-v ff-mono"}, sel.ProfileId || "—")))),
        sel && userTab === "role" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-t"}, "Roles")),
          h("div", {className: "usr-kv"},
            h("div", {className: "usr-kv-row"},
              h("span", {className: "usr-kv-k"}, "Role"),
              h("span", {className: "usr-kv-v"},
                detailLoading ? "…" : (detail ? (detail.role || "No role") : "—"))),
            h("div", {className: "usr-kv-row"},
              h("span", {className: "usr-kv-k"}, "Role ID"),
              h("span", {className: "usr-kv-v ff-mono"}, sel.RoleId || "—")))),
        sel && userTab === "settings" && h("div", {className: "sq3-card"},
          h("div", {className: "sq3-card-h"},
            h("span", {className: "sq3-card-t"}, "Settings")),
          h("div", {className: "usr-kv"},
            [["Language", sel.Language],
             ["Time Zone", srcRec && srcRec.TimeZoneSidKey],
             ["Locale", srcRec && srcRec.LocaleSidKey],
             ["Email Encoding", srcRec && srcRec.EmailEncodingKey]
            ].map(([k, v]) =>
              h("div", {key: k, className: "usr-kv-row"},
                h("span", {className: "usr-kv-k"}, k),
                h("span", {className: "usr-kv-v"}, v || "—"))),
            h("div", {className: "usr-kv-row"},
              h("span", {className: "usr-kv-k"}, "Active"),
              h("span", {className: "usr-kv-v"},
                sel.Active != null && h(FFBadge, {kind: ffTruthy(sel.Active) ? "ok" : "off"},
                  ffTruthy(sel.Active) ? "Yes" : "No"))))),
      )),
    sel && cloneOpen && h("div", {className: "usr-modal-veil",
      onClick: (e) => { if (e.target === e.currentTarget) setCloneOpen(false); }},
      h("div", {className: "usr-modal sq3-card", role: "dialog", "aria-label": "Clone User"},
        h("div", {className: "usr-modal-h"},
          h("span", {className: "usr-avatar usr-avatar-lg", "aria-hidden": "true"}, usrInitials(sel)),
          h("div", {className: "usr-modal-t"},
            h("div", {className: "sq3-card-t"}, "Clone User"),
            h("div", {className: "sq3-card-sub"},
              "Create a new user by cloning all settings from the selected user. You can choose which components to include or exclude.")),
          h("button", {
            className: "btn btn-secondary btn-sm",
            title: "Close",
            onClick: () => setCloneOpen(false)
          }, "✕")),
        h("div", {className: "usr-steps"},
          [["1", "Select User & Details"], ["2", "Review & Clone"]].map(([n, label], i) =>
            h("div", {key: n, className: "usr-step" + (cloneStep === i + 1 ? " active" : "")},
              h("span", {className: "usr-step-n"}, n),
              h("span", {className: "usr-step-t"}, label)))),
        srcLoading && h("div", {className: "insp-meta"}, "Loading profile, role and assignments…"),
        !srcLoading && cf && cloneStep === 1 && h("div", null,
          h("div", {className: "usr-src"},
            h("span", {className: "usr-avatar usr-avatar-lg", "aria-hidden": "true"}, usrInitials(sel)),
            h("div", {className: "usr-src-tx"},
              h("div", {className: "usr-src-name"},
                sel.Name, " ",
                sel.Active != null && h(FFBadge, {kind: ffTruthy(sel.Active) ? "ok" : "off"},
                  ffTruthy(sel.Active) ? "Active" : "Inactive")),
              h("div", {className: "usr-src-sub"}, sel.Email || sel.Username || ""),
              h("div", {className: "usr-src-sub"}, detail ? detail.profile : "…")),
            h("div", {className: "usr-src-meta"},
              [["User ID", sel.Id],
               ["Last Login", detail && detail.lastLogin ? fmtDateTime(detail.lastLogin) : null],
               ["Created Date", detail && detail.created ? fmtDateTime(detail.created) : null]
              ].map(([k, v]) =>
                h("div", {key: k, className: "usr-src-mrow"},
                  h("span", {className: "usr-kv-k"}, k),
                  h("span", {className: "usr-kv-v"}, v || "—"))))),
          h("div", {className: "usr-comp-h"},
            h("span", {className: "sq3-card-t"}, "1. Select Components to Clone"),
            h("label", {className: "usr-selectall"},
              h("input", {
                type: "checkbox",
                checked: compSel.profile && compSel.ps && compSel.groups && compSel.roles,
                onChange: (e) => {
                  const on = e.target.checked;
                  setCompSel({profile: on, ps: on, groups: on, roles: on});
                  if (!cf) return;
                  setCf({...cf,
                    profileId: on ? (srcRec && srcRec.ProfileId || sel.ProfileId || "") : "",
                    roleId: on ? (srcRec && srcRec.UserRoleId || sel.RoleId || "") : "",
                    psIds: on && srcPerms ? [...srcPerms.ps, ...srcPerms.psg].map(p => p.id) : [],
                    grpIds: on && srcPerms ? srcPerms.groups.map(g => g.id) : []});
                }
              }),
              h("span", null, "Select All"))),
          h("div", {className: "insp-meta"}, "Choose which settings and data should be copied to the new user."),
          [["profile", "Profile", "User profile" + (detail ? ` (e.g., ${detail.profile})` : "")],
           ["ps", "Permission Sets", srcPerms ? `${srcPerms.ps.length + srcPerms.psg.length} assigned permission set(s)` : "Assigned permission sets"],
           ["groups", "Groups", srcPerms ? `${srcPerms.groups.length} user group(s) and public group(s)` : "User groups and public groups"],
           ["roles", "Roles", "Role and role hierarchy"]
          ].map(([key, label, sub]) =>
            h("label", {key, className: "usr-comp"},
              h("input", {
                type: "checkbox",
                checked: !!compSel[key],
                onChange: () => toggleComp(key)
              }),
              h("span", {className: "usr-comp-tx"},
                h("span", {className: "usr-comp-t"}, label),
                h("span", {className: "usr-comp-s"}, sub)))),
          h("div", {className: "usr-comp-h"},
            h("span", {className: "sq3-card-t"}, "2. New User Details")),
          h("div", {className: "insp-meta"}, "Enter the details for the cloned user."),
          h("div", {className: "insp-form-grid"},
            h("label", {className: "insp-field"},
              h("span", null, "First Name"),
              h("input", {
                value: cf.firstName,
                onChange: e => setCf({...cf, firstName: e.target.value})
              })
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Last Name *"),
              h("input", {
                value: cf.lastName,
                onChange: e => setCf({...cf, lastName: e.target.value})
              })
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Email *"),
              h("input", {
                value: cf.email,
                placeholder: "user@company.com",
                onChange: e => setCf({...cf, email: e.target.value})
              })
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Username *"),
              h("input", {
                value: cf.username,
                placeholder: "name@company.org (globally unique)",
                onChange: e => setCf({...cf, username: e.target.value})
              })
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Alias (≤8)"),
              h("input", {
                value: cf.alias,
                onChange: e => setCf({...cf, alias: e.target.value})
              })
            ),
            h("label", {className: "insp-field"},
              h("span", null, "Nickname"),
              h("input", {
                value: cf.nick,
                placeholder: "defaults to username prefix",
                onChange: e => setCf({...cf, nick: e.target.value})
              })
            ),
            h("label", {className: "insp-field insp-field-grow"},
              h("span", null, "Password (optional, admin-set)"),
              h("input", {
                type: "password",
                value: cf.password,
                placeholder: "leave blank to skip",
                onChange: e => setCf({...cf, password: e.target.value})
              })
            ),
            h("label", {className: "insp-field insp-field-grow"},
              h("span", null, "Profile * (cloned from source)"),
              h("select", {
                value: cf.profileId,
                onChange: e => setCf({...cf, profileId: e.target.value})
              },
                h("option", {value: ""}, "— pick —"),
                profiles.map(p => h("option", {key: p.id, value: p.id}, p.name))
              )
            ),
            h("label", {className: "insp-field insp-field-grow"},
              h("span", null, "Role (cloned from source)"),
              h("select", {
                value: cf.roleId,
                onChange: e => setCf({...cf, roleId: e.target.value})
              },
                h("option", {value: ""}, "— none —"),
                roles.map(r => h("option", {key: r.id, value: r.id}, r.name))
              )
            )
          ),
          h("label", {className: "insp-check"},
            h("input", {
              type: "checkbox",
              checked: cf.active,
              onChange: e => setCf({...cf, active: e.target.checked})
            }),
            h("span", null, "Active")
          ),
          cloneErr && h("div", {className: "insp-error"}, cloneErr),
          h("div", {className: "usr-modal-nav"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              onClick: () => setCloneOpen(false)
            }, "Cancel"),
            h("button", {
              className: "btn btn-primary btn-sm",
              onClick: () => {
                const p = validateClone();
                if (p) { setCloneErr(p); return; }
                setCloneErr(null);
                setCloneStep(2);
              }
            }, "Next →"))
        ),
        !srcLoading && cf && cloneStep === 2 && h("div", null,
          h("div", {className: "usr-comp-h"},
            h("span", {className: "sq3-card-t"}, "3. Review & Clone")),
          h("div", {className: "insp-meta"}, "Confirm the new user before creating it."),
          h("div", {className: "usr-kv"},
            [["Source user", `${sel.Name} (${sel.Username})`],
             ["New name", `${cf.firstName} ${cf.lastName}`.trim() || "—"],
             ["Email", cf.email || "—"],
             ["Username", cf.username || "—"],
             ["Alias", cf.alias || "—"],
             ["Profile", compSel.profile
               ? ((profiles.find(p => p.id === cf.profileId) || {}).name || detail && detail.profile || "—")
               : "— excluded —"],
             ["Role", compSel.roles
               ? ((roles.find(r => r.id === cf.roleId) || {}).name || "— none —")
               : "— excluded —"],
             ["Permission sets", compSel.ps ? `${cf.psIds.length} selected` : "— excluded —"],
             ["Groups", compSel.groups ? `${cf.grpIds.length} selected` : "— excluded —"],
             ["Active", cf.active ? "Yes" : "No"],
             ["Password", cf.password ? "Will be set" : "Skipped"]
              ].map(([k, v]) =>
                h("div", {key: k, className: "usr-kv-row"},
                  h("span", {className: "usr-kv-k"}, k),
                  h("span", {className: "usr-kv-v"}, v || "—")))),
          cloneErr && h("div", {className: "insp-error"}, cloneErr),
          cloneResult && h("div", {className: cloneResult.ok ? "insp-ok" : "insp-warn"},
            cloneResult.summary,
            cloneResult.failures && cloneResult.failures.length > 0 &&
              h("div", null, "First issues: " + cloneResult.failures.join("; "))
          ),
          h("div", {className: "usr-modal-nav"},
            h("button", {
              className: "btn btn-secondary btn-sm",
              disabled: cloning,
              onClick: () => setCloneStep(1)
            }, "← Previous"),
            cloneResult && cloneResult.ok
              ? h("button", {
                  className: "btn btn-secondary btn-sm",
                  onClick: () => setCloneOpen(false)
                }, "Done")
              : h("button", {
                  className: "btn btn-primary btn-sm",
                  disabled: cloning,
                  onClick: doClone
                }, cloning ? "Creating…" : "Create cloned user")))
      )
    ),
    cloneResult && h("div", {className: cloneResult.ok ? "insp-ok" : "insp-warn"},
      cloneResult.summary,
      cloneResult.failures && cloneResult.failures.length > 0 &&
        h("div", null, "First issues: " + cloneResult.failures.join("; "))
    ),
    actionMsg && h("div", {className: "insp-ok"}, actionMsg),
    actionErr && h("div", {className: "insp-error"}, actionErr)
  );
}

export {UsersTab};
