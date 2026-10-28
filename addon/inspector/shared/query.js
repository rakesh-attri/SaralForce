import {sfConn, apiVersion} from "../../inspector.js";
import {applyDefaultLimit} from "../../core/soql.js";

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
  const url = `/services/data/v${apiVersion}/${base}?q=` + encodeURIComponent(q);
  let loc = url;
  let all = [];
  let pages = 0;
  let serverTotal = null;
  const maxPages = 20;
  while (loc && pages < maxPages) {
    const res = await sfConn.rest(loc, {useCache: false});
    if (Array.isArray(res.records)) all = all.concat(res.records);
    if (serverTotal == null && typeof res.totalSize === "number") serverTotal = res.totalSize;
    pages++;
    if (res.done === false && res.nextRecordsUrl) {
      loc = res.nextRecordsUrl;
    } else {
      loc = null;
    }
    if (all.length > 20000) break;
  }
  // `loc` still set => we stopped at the page/row cap with more on the server.
  // totalSize is the server's count (COUNT() queries return no records).
  return {
    records: all,
    totalSize: serverTotal == null ? all.length : serverTotal,
    fetched: all.length,
    truncated: !!loc,
    query: q
  };
}

export {runSoql};
