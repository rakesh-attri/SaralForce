import {sfConn, apiVersion} from "../../inspector.js";

let _ffObjectsCache = null;
async function ffGetObjects(force) {
  if (_ffObjectsCache && !force) return _ffObjectsCache;
  _ffObjectsCache = await recordsListObjects();
  return _ffObjectsCache;
}

// ─── Setup / Tooling API access ───────────────────────────────────────────
// Many setup entities (CustomField, Layout, Flow, CustomTab, …) and their
// records are only reachable through the Tooling API, and Setup pages hand
// us a record Id without an object name. These helpers retry any standard
// REST call through /tooling — but only when the first attempt failed
// because the endpoint does not serve that object — mirroring SF Inspector's
// "Show all data (Tooling API)" behavior for every tooling-supported object.

const _ffApiMode = {};   // object API name -> "std" | "tooling" (last success)

function ffApiPath(mode, tail) {
  return `/services/data/v${apiVersion}/${mode === "tooling" ? "tooling/" : ""}${tail}`;
}

// Endpoint miss (the object isn't served here) vs. real failures (session,
// permissions, bad field…): only the former deserves a Tooling retry.
function ffIsApiMissError(e) {
  if (!e || e.name !== "SalesforceRestError" || !Array.isArray(e.detail)) return false;
  const MISS = ["INVALID_TYPE", "NOT_FOUND", "INVALID_ENDPOINT"];
  return e.detail.some(d => d && MISS.includes(d.errorCode));
}

// Run `pathFn(mode)` against the standard API first (Tooling first when it
// already worked for this object), falling back only on an endpoint miss.
// `only` pins a single endpoint. Returns the parsed response and records
// the endpoint that worked so later calls (modal, export, save) reuse it.
async function ffAutoApi(obj, pathFn, restOpts, only) {
  const order = only
    ? [only]
    : (_ffApiMode[obj] === "tooling" ? ["tooling", "std"] : ["std", "tooling"]);
  const errs = [];
  for (const mode of order) {
    try {
      const res = await sfConn.rest(pathFn(mode), restOpts || {});
      _ffApiMode[obj] = mode;
      return res;
    } catch (e) {
      errs.push(e);
      if (!ffIsApiMissError(e)) throw e;
    }
  }
  // Every endpoint missed — include both messages so a tooling-only object
  // reports what the Tooling API said, not just "not supported".
  if (errs.length > 1) {
    const merged = new Error(`${errs[0].message} | Tooling API: ${errs[1].message}`);
    merged.name = "SalesforceRestError";
    merged.detail = errs[0].detail;
    throw merged;
  }
  throw errs[0];
}

function ffApiModeOf(obj) {
  return _ffApiMode[obj] || null;
}

const _ffDescribeCache = {};
async function ffDescribeObject(objApi, opts) {
  const key = String(objApi || "").trim();
  if (!key) throw new Error("Enter an object API name");
  const tooling = !!(opts && opts.tooling);
  const cacheKey = (tooling ? "tooling:" : "std:") + key;
  if (_ffDescribeCache[cacheKey]) return _ffDescribeCache[cacheKey];
  const d = await ffAutoApi(key,
    (mode) => ffApiPath(mode, `sobjects/${encodeURIComponent(key)}/describe`),
    {useCache: false},
    tooling ? "tooling" : null);
  _ffDescribeCache[cacheKey] = d;
  return d;
}

// Objects visible through Setup (Tooling API toggle): EntityDefinition is
// the source of truth; mapped onto the {name, label, custom} shape the
// explorer already consumes.
async function toolingListObjects() {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/query/?q=` +
    encodeURIComponent("SELECT QualifiedApiName, Label FROM EntityDefinition ORDER BY Label"),
    {useCache: false});
  const list = (res.records || [])
    .filter(r => r && r.QualifiedApiName)
    .map(r => ({
      name: r.QualifiedApiName,
      label: r.Label || r.QualifiedApiName,
      custom: /__c$/.test(r.QualifiedApiName)
    }));
  list.sort((a, b) =>
    (b.custom - a.custom) || a.label.localeCompare(b.label));
  return list;
}

// ─── Records: browse all data of an object ────────────────────
async function recordsListObjects() {
  const res = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/`, {useCache: false});
  const list = (res.sobjects || [])
    .filter(o => o && o.queryable !== false && o.name)
    .map(o => ({name: o.name, label: o.label || o.name, custom: !!o.custom}));
  list.sort((a, b) =>
    (b.custom - a.custom) || a.label.localeCompare(b.label));
  return list;
}

export {ffGetObjects, ffApiPath, ffAutoApi, ffApiModeOf, ffDescribeObject, toolingListObjects};
