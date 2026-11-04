import test from "node:test";
import assert from "node:assert/strict";
import {normalizeLocator, mergeCsvChunks, countCsvRecords} from "../../addon/core/bulk.js";

test("normalizeLocator treats missing and literal null as end", () => {
  assert.equal(normalizeLocator(null), null);
  assert.equal(normalizeLocator(undefined), null);
  assert.equal(normalizeLocator(""), null);
  assert.equal(normalizeLocator("null"), null);
  assert.equal(normalizeLocator(" NULL "), null);
  assert.equal(normalizeLocator("MTAwMDA"), "MTAwMDA");
});

test("mergeCsvChunks keeps only the first header (LF)", () => {
  const a = "\"Id\",\"Name\"\n\"1\",\"A\"\n";
  const b = "\"Id\",\"Name\"\n\"2\",\"B\"\n";
  assert.equal(mergeCsvChunks([a, b]), "\"Id\",\"Name\"\n\"1\",\"A\"\n\"2\",\"B\"\n");
});

test("mergeCsvChunks handles CRLF and missing trailing newline", () => {
  const a = "Id,Name\r\n1,A";
  const b = "Id,Name\r\n2,B\r\n";
  assert.equal(mergeCsvChunks([a, b]), "Id,Name\r\n1,A\r\n2,B\r\n");
});

test("mergeCsvChunks respects quoted line breaks in the header", () => {
  const a = "\"Id\",\"Multi\nLine\"\n1,x\n";
  const b = "\"Id\",\"Multi\nLine\"\n2,y\n";
  assert.equal(mergeCsvChunks([a, b]), "\"Id\",\"Multi\nLine\"\n1,x\n2,y\n");
});

test("mergeCsvChunks skips empty and header-only chunks", () => {
  assert.equal(mergeCsvChunks([]), "");
  assert.equal(mergeCsvChunks(["", null]), "");
  assert.equal(mergeCsvChunks(["Id\n1\n", "", "Id\n", "Id", "Id\n2\n"]), "Id\n1\n2\n");
  assert.equal(mergeCsvChunks(["", "Id\n1\n"]), "Id\n1\n");
});

test("countCsvRecords counts data rows only", () => {
  assert.equal(countCsvRecords(""), 0);
  assert.equal(countCsvRecords(null), 0);
  assert.equal(countCsvRecords("Id\n"), 0);
  assert.equal(countCsvRecords("Id\n1\n2\n"), 2);
  assert.equal(countCsvRecords("Id\r\n1\r\n2"), 2);
  assert.equal(countCsvRecords("Id\n1\n\n2\n\n"), 2);
});

test("countCsvRecords handles multi-line quoted fields", () => {
  const csv = "\"sf__Id\",\"Description\"\n\"001\",\"line one\nline two\r\nline three\"\n\"002\",\"say \"\"hi\"\"\"\n";
  assert.equal(countCsvRecords(csv), 2);
});
