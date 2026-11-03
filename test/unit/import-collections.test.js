import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ffCollectionsChunkSize, ffBuildCollectionsChunk, ffFormatSaveErrors,
  ffMapSaveResults, ffFailChunk, ffDataResultFiles
} from "../../addon/inspector/shared/import-map.js";
import {parseCsv} from "../../addon/core/csv.js";

const row = (index, body, extra = {}) => ({index, body, idVal: null, extVal: null, hasValue: true, ...extra});

test("chunk size clamps to 1..200 and defaults to 200", () => {
  assert.equal(ffCollectionsChunkSize(undefined), 200);
  assert.equal(ffCollectionsChunkSize(""), 200);
  assert.equal(ffCollectionsChunkSize("abc"), 200);
  assert.equal(ffCollectionsChunkSize(0), 200);
  assert.equal(ffCollectionsChunkSize(-5), 200);
  assert.equal(ffCollectionsChunkSize(1), 1);
  assert.equal(ffCollectionsChunkSize("50"), 50);
  assert.equal(ffCollectionsChunkSize(500), 200);
});

test("insert payload copies the mapped body", () => {
  const rows = [row(0, {Name: "A"}), row(1, {Name: "B", Phone: null})];
  const {send, rejected} = ffBuildCollectionsChunk(rows, "insert", "");
  assert.deepEqual(rejected, []);
  assert.deepEqual(send.map(s => s.record), [{Name: "A"}, {Name: "B", Phone: null}]);
  assert.notEqual(send[0].record, rows[0].body, "body is copied, not shared");
});

test("update requires Id and puts it on the record", () => {
  const rows = [row(0, {Id: "001000000000001", Name: "A"}, {idVal: "001000000000001"}), row(1, {Name: "B"})];
  const {send, rejected} = ffBuildCollectionsChunk(rows, "update", "");
  assert.deepEqual(send.map(s => s.record), [{Id: "001000000000001", Name: "A"}]);
  assert.deepEqual(rejected, [{row: 3, message: "Missing Id"}]);
});

test("upsert requires the external id field and value", () => {
  const rows = [row(0, {Ext__c: "X1", Name: "A"}, {extVal: "X1"}), row(4, {Name: "B"})];
  const {send, rejected} = ffBuildCollectionsChunk(rows, "upsert", "Ext__c");
  assert.deepEqual(send.map(s => s.record), [{Ext__c: "X1", Name: "A"}]);
  assert.deepEqual(rejected, [{row: 6, message: "Missing value for External ID Ext__c"}]);
  const none = ffBuildCollectionsChunk(rows, "upsert", "");
  assert.equal(none.send.length, 0);
  assert.equal(none.rejected[0].message, "External ID field not selected");
});

test("delete sends Id strings; hardDelete is rejected", () => {
  const rows = [row(0, {Id: "a"}, {idVal: "001000000000001"}), row(1, {})];
  const {send, rejected} = ffBuildCollectionsChunk(rows, "delete", "");
  assert.deepEqual(send.map(s => s.record), ["001000000000001"]);
  assert.deepEqual(rejected, [{row: 3, message: "Missing Id"}]);
  const hd = ffBuildCollectionsChunk(rows, "hardDelete", "");
  assert.equal(hd.send.length, 0);
  assert.equal(hd.rejected[0].message, "Hard Delete requires Bulk API 2.0");
});

test("SaveResults map back to their rows, including partial failures", () => {
  const rows = [row(0, {Name: "A"}), row(1, {Name: ""}), row(2, {Name: "C"})];
  const {send} = ffBuildCollectionsChunk(rows, "insert", "");
  const results = [
    {id: "001A", success: true, errors: []},
    {success: false, errors: [{statusCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing: [Name]", fields: ["Name"]}]},
    {id: "001C", success: true, errors: []}
  ];
  const {successes, failures} = ffMapSaveResults(send, results, "insert");
  assert.deepEqual(successes, [{row: 2, index: 0, id: "001A"}, {row: 4, index: 2, id: "001C"}]);
  assert.deepEqual(failures, [{row: 3, index: 1,
    message: "REQUIRED_FIELD_MISSING: Required fields are missing: [Name] [Name]"}]);
});

test("missing SaveResult is reported as a failure, not a success", () => {
  const {send} = ffBuildCollectionsChunk([row(0, {Name: "A"}), row(1, {Name: "B"})], "insert", "");
  const {successes, failures} = ffMapSaveResults(send, [{id: "001A", success: true}], "insert");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].row, 3);
});

test("upsert reports the real record id and created/updated", () => {
  const rows = [row(0, {Ext__c: "X1"}, {extVal: "X1"}), row(1, {Ext__c: "X2"}, {extVal: "X2"})];
  const {send} = ffBuildCollectionsChunk(rows, "upsert", "Ext__c");
  const {successes} = ffMapSaveResults(send, [
    {id: "001NEW", success: true, created: true, errors: []},
    {id: "001OLD", success: true, created: false, errors: []}
  ], "upsert");
  assert.deepEqual(successes, [
    {row: 2, index: 0, id: "001NEW", created: true},
    {row: 3, index: 1, id: "001OLD", created: false}
  ]);
});

test("delete success falls back to the sent Id", () => {
  const {send} = ffBuildCollectionsChunk([row(0, {}, {idVal: "001X"})], "delete", "");
  const {successes} = ffMapSaveResults(send, [{success: true, errors: []}], "delete");
  assert.equal(successes[0].id, "001X");
  assert.equal("created" in successes[0], false);
});

test("error formatting joins several errors", () => {
  assert.equal(ffFormatSaveErrors([
    {statusCode: "A", message: "one", fields: []},
    {statusCode: "B", message: "two", fields: ["F1", "F2"]}
  ]), "A: one\nB: two [F1, F2]");
  assert.equal(ffFormatSaveErrors([]), "Unknown error");
});

test("a rejected call fails every row in the chunk", () => {
  const {send} = ffBuildCollectionsChunk([row(0, {Name: "A"}), row(1, {Name: "B"})], "insert", "");
  assert.deepEqual(ffFailChunk(send, "Network error"), [
    {row: 2, index: 0, message: "Network error"},
    {row: 3, index: 1, message: "Network error"}
  ]);
});

test("result files carry source columns plus sf__ columns", () => {
  const headers = ["Ext", "Name"];
  const records = [{Ext: "X1", Name: "A"}, {Ext: "X2", Name: "B, Inc"}];
  const files = ffDataResultFiles({
    headers, records, operation: "upsert", lineEnding: "\n",
    successes: [{row: 2, index: 0, id: "001A", created: true}],
    failures: [{row: 3, index: 1, message: "DUPLICATE_VALUE: dup"}]
  });
  const ok = parseCsv(files.success);
  assert.deepEqual(ok.headers, ["sf__Id", "sf__Created", "Ext", "Name"]);
  assert.deepEqual(ok.records, [{sf__Id: "001A", sf__Created: "true", Ext: "X1", Name: "A"}]);
  const bad = parseCsv(files.failed);
  assert.deepEqual(bad.headers, ["sf__Error", "Ext", "Name"]);
  assert.deepEqual(bad.records, [{sf__Error: "DUPLICATE_VALUE: dup", Ext: "X2", Name: "B, Inc"}]);
  const empty = ffDataResultFiles({headers, records, operation: "insert", successes: [], failures: []});
  assert.deepEqual(empty, {success: "", failed: ""});
});
