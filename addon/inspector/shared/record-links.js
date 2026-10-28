import {sfConn} from "../../inspector.js";

// ─── Shared: open-in-Salesforce ────────────────────────────────────────────
// 15/18-char Salesforce Id validation (same rule as object-creator.js).
function ffIsSfId(value) {
  const v = String(value || "").trim();
  return /^[a-zA-Z0-9]{15}$/.test(v) || /^[a-zA-Z0-9]{18}$/.test(v);
}

function ffRecordUrl(id) {
  return "https://" + sfConn.instanceHostname + "/" + id;
}

function openRecordInSf(id, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!ffIsSfId(id) || !sfConn.instanceHostname) return;
  window.open(ffRecordUrl(id), "_blank");
}

export {ffIsSfId, ffRecordUrl, openRecordInSf};
