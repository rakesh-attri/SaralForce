import {sfConn, apiVersion} from "../../inspector.js";

async function appTabsResolveCurrentUserId() {
  const urls = [
    "https://" + sfConn.instanceHostname + "/services/oauth2/userinfo",
    "https://" + sfConn.instanceHostname + "/id"
  ];
  let lastStatus = 0;
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {"Authorization": "Bearer " + sfConn.sessionId}
      });
      lastStatus = res.status;
      if (!res.ok) continue;
      const data = await res.json();
      const uid = data?.user_id || data?.userId || (data?.sub ? String(data.sub).split("/").pop() : null);
      if (uid) return uid;
    } catch (e) {
      console.warn("[SaralForce] AppTabManager identity lookup failed for", u, e.message);
    }
  }
  throw new Error("Could not get user identity (tried userinfo and /id, last status " + lastStatus + ")");
}

async function usersEnsureDebugLevel() {
  try {
    const q = await sfConn.rest(`/services/data/v${apiVersion}/tooling/query/?q=` +
      encodeURIComponent("SELECT Id FROM DebugLevel WHERE DeveloperName = 'FF_UserDebug' LIMIT 1"),
      {useCache: false});
    if (q.records && q.records.length) return q.records[0].Id;
  } catch (e) { /* fall through to create */ }
  const created = await sfConn.rest(`/services/data/v${apiVersion}/tooling/sobjects/DebugLevel`, {
    method: "POST",
    useCache: false,
    body: {
      DeveloperName: "FF_UserDebug",
      MasterLabel: "FF User Debug",
      ApexCode: "DEBUG",
      ApexProfiling: "INFO",
      Callout: "INFO",
      Database: "INFO",
      System: "DEBUG",
      Validation: "INFO",
      Visualforce: "INFO",
      Workflow: "INFO"
    }
  });
  if (!created || !created.id) throw new Error("Could not create DebugLevel");
  return created.id;
}

// Parse a raw Apex debug log into Execution-Log rows:
// "15:34:27:001 USER_DEBUG [38]|DEBUG|message" → {ts, event, details}.
// Continuation lines attach to the previous row.
function parseApexLog(text) {
  const rows = [];
  // Pipe format (modern): 18:20:45.1 (1444464)|USER_INFO|[EXTERNAL]|…
  const rePipe = /^(\d{1,2}:\d{2}:\d{2})[:.](\d+)\s*(?:\(\d+\))?\|([A-Z][A-Z0-9_]*)\|(.*)$/;
  // Space format (older): 18:16:06:001 USER_INFO [EXTERNAL]|…
  const reSpace = /^(\d{1,2}:\d{2}:\d{2}:\d{1,3})\s+([A-Z][A-Z0-9_]*)(?:\s+(.*))?$/;
  const pad = d => String(d || "0").padEnd(3, "0").slice(0, 3);
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let m = rePipe.exec(line);
    if (m) {
      rows.push({ts: `${m[1]}:${pad(m[2])}`, event: m[3], details: m[4] || ""});
      continue;
    }
    m = reSpace.exec(line);
    if (m) {
      rows.push({ts: m[1], event: m[2], details: m[3] || ""});
      continue;
    }
    // Continuation lines (stack traces) attach to the previous row. Anything
    // before the first timestamp is preamble (version, levels, Execute
    // Anonymous source) — it stays in the Raw log only, never a table row.
    if (rows.length) rows[rows.length - 1].details += "\n" + line;
  }
  return rows;
}

export {appTabsResolveCurrentUserId, usersEnsureDebugLevel, parseApexLog};
