import {sfConn, apiVersion} from "../../inspector.js";
import {applyDefaultLimit} from "../../core/soql.js";

// Rows fetched per run (and per "Fetch more"); Salesforce pages are 2000.
const FETCH_ROW_CAP = 20000;

// Follow nextRecordsUrl from `loc` until done or the row cap. Returns the
// records, the server's totalSize and the URL to continue from (null = done).
async function fetchPages(loc) {
  let all = [];
  let serverTotal = null;
  while (loc) {
    const res = await sfConn.rest(loc, {useCache: false});
    if (Array.isArray(res.records)) all = all.concat(res.records);
    if (serverTotal == null && typeof res.totalSize === "number") serverTotal = res.totalSize;
    loc = res.done === false && res.nextRecordsUrl ? res.nextRecordsUrl : null;
    if (all.length >= FETCH_ROW_CAP) break;
  }
  return {records: all, serverTotal, nextUrl: loc};
}

async function runSoql(query, limit, opts) {
  const {tooling = false, allRows = false} = opts || {};
  let q = String(query || "").trim();
  if (!q) throw new Error("Enter a SOQL query");
  if (!/^select\b/i.test(q)) throw new Error("Only SELECT SOQL is supported");
  // Soft-cap rows unless the user already limited. Aggregate queries
  // (COUNT/SUM/AVG/MIN/MAX) without GROUP BY must never carry LIMIT -
  // Salesforce rejects them (MALFORMED_QUERY).
  if (limit) q = applyDefaultLimit(q, parseInt(limit, 10) || 2000);
  const base = tooling ? "tooling/query/" : allRows ? "queryAll/" : "query/";
  const {records, serverTotal, nextUrl} = await fetchPages(
    `/services/data/v${apiVersion}/${base}?q=` + encodeURIComponent(q));
  // nextUrl set => we stopped at the row cap with more on the server.
  // totalSize is the server's count (COUNT() queries return no records).
  return {
    records,
    totalSize: serverTotal == null ? records.length : serverTotal,
    fetched: records.length,
    truncated: !!nextUrl,
    nextUrl,
    query: q
  };
}

// Continue a capped result from its nextUrl ("Fetch more"). Salesforce
// keeps query cursors for about 15 minutes.
async function runSoqlMore(nextUrl) {
  const {records, nextUrl: after} = await fetchPages(nextUrl);
  return {records, truncated: !!after, nextUrl: after};
}

export {runSoql, runSoqlMore};
