import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCsv, toCsv, csvEscape, guardFormula} from "../../addon/core/csv.js";
import {flattenRecord, columnsOf} from "../../addon/inspector/shared/csv.js";

test("parseCsv handles quotes, escaped quotes, embedded newlines and delimiters", () => {
  const text = 'Name,Note\r\n"Acme, Inc","He said ""hi""\nthen left"\r\nBeta,plain\r\n';
  const {headers, records, duplicates} = parseCsv(text);
  assert.deepEqual(headers, ["Name", "Note"]);
  assert.deepEqual(records, [
    {Name: "Acme, Inc", Note: 'He said "hi"\nthen left'},
    {Name: "Beta", Note: "plain"}
  ]);
  assert.deepEqual(duplicates, []);
});

test("parseCsv supports other delimiters, strips a BOM and skips blank rows", () => {
  const {headers, records} = parseCsv("\uFEFFa;b\n1;2\n\n;\n3;4", {delimiter: ";"});
  assert.deepEqual(headers, ["a", "b"]);
  assert.deepEqual(records, [{a: "1", b: "2"}, {a: "3", b: "4"}]);
});

test("parseCsv reports duplicate headers case-insensitively", () => {
  assert.deepEqual(parseCsv("Id,Name,id\n1,x,2").duplicates, ["id"]);
});

test("parseCsv reports an unterminated quote", () => {
  assert.match(parseCsv('a,b\n"open,2').parseError, /never closed/);
});

test("toCsv quotes only when needed and round-trips through parseCsv", () => {
  const rows = [{A: "x,y", B: 'q"uote', C: null}, {A: 1, B: "line\nbreak", C: {n: 1}}];
  const csv = toCsv(["A", "B", "C"], rows);
  assert.equal(csv, 'A,B,C\r\n"x,y","q""uote",\r\n1,"line\nbreak","{""n"":1}"');
  assert.deepEqual(parseCsv(csv).records[0], {A: "x,y", B: 'q"uote', C: ""});
});

test("toCsv options: delimiter, quote all, no headers, null value, LF", () => {
  const csv = toCsv(["a", "b"], [{a: "1", b: null}], {delimiter: ";", quoting: "all", headers: false, nullValue: "NULL", lineEnding: "\n"});
  assert.equal(csv, '"1";NULL');
});

test("guardFormula neutralises formulas but keeps plain numbers", () => {
  assert.equal(guardFormula("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(guardFormula("+1+2"), "'+1+2");
  assert.equal(guardFormula("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(guardFormula("-42"), "-42");
  assert.equal(guardFormula("+3.5"), "+3.5");
  assert.equal(guardFormula("-1,234.50"), "-1,234.50");
  assert.equal(guardFormula("plain"), "plain");
  assert.equal(toCsv(["a"], [{a: "=1+1"}], {headers: false, guardFormulas: true}), "'=1+1");
});

test("csvEscape matches the old single-value behaviour", () => {
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape("a\"b"), '"a""b"');
  assert.equal(csvEscape("plain"), "plain");
});

test("parseCsv with headers: false keeps the first row as data under Column1..N", () => {
  const {headers, records} = parseCsv("001A,Acme\n001B,Beta,extra\n", {headers: false});
  assert.deepEqual(headers, ["Column1", "Column2", "Column3"]);
  assert.deepEqual(records, [
    {Column1: "001A", Column2: "Acme", Column3: ""},
    {Column1: "001B", Column2: "Beta", Column3: "extra"}
  ]);
});

test("flattenRecord turns parent relationships into dotted columns", () => {
  const rec = {
    attributes: {type: "Contact", url: "/x"},
    Id: "003",
    Account: {attributes: {type: "Account", url: "/y"}, Name: "Acme", Owner: {attributes: {type: "User"}, Name: "Ana"}},
    MailingAddress: {city: "Pune", country: "IN"},
    Cases: {totalSize: 1, done: true, records: [{attributes: {type: "Case"}, Subject: "Hi"}]}
  };
  assert.deepEqual(flattenRecord(rec), {
    "Id": "003",
    "Account.Name": "Acme",
    "Account.Owner.Name": "Ana",
    "MailingAddress": '{"city":"Pune","country":"IN"}',
    "Cases": '[{"Subject":"Hi"}]'
  });
});

test("flattenRecord is safe as a map callback and columnsOf drops null-parent placeholders", () => {
  const rows = [
    {attributes: {}, Id: "1", Account: null},
    {attributes: {}, Id: "2", Account: {attributes: {}, Name: "Acme"}}
  ].map(r => flattenRecord(r));
  assert.deepEqual(columnsOf(rows), ["Id", "Account.Name"]);
  assert.deepEqual(columnsOf([{Id: "3", Account: null}]), ["Id", "Account"]);
  assert.deepEqual(columnsOf([{Extra: 1}], ["Id", "Account.Name"]), ["Id", "Account.Name", "Extra"]);
});
