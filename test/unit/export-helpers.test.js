import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCsv, decodeCsvBytes} from "../../addon/core/csv.js";
import {soqlFromObject, formatSoql} from "../../addon/core/soql.js";
import {toXlsxBlob} from "../../addon/inspector/shared/xlsx.js";

const raw = String.raw;

test("parseCsv skips blank rows by default and keeps them with keepBlankRows", () => {
  const csv = '"Description"\n""\n"x"\n\n""';
  assert.deepEqual(parseCsv(csv).records, [{Description: "x"}]);
  assert.deepEqual(parseCsv(csv, {keepBlankRows: true}).records,
    [{Description: ""}, {Description: "x"}, {Description: ""}, {Description: ""}]);
});

test("keepBlankRows does not invent a row for the trailing line break", () => {
  assert.equal(parseCsv("A,B\r\n,\r\n1,2\r\n", {keepBlankRows: true}).records.length, 2);
  assert.equal(parseCsv("A\n", {keepBlankRows: true}).records.length, 0);
});

test("decodeCsvBytes reads UTF-8, falls back to Windows-1252 and honours UTF-16 marks", () => {
  const utf8 = new TextEncoder().encode("Name\nJosé €");
  assert.deepEqual(decodeCsvBytes(utf8), {text: "Name\nJosé €", encoding: "UTF-8"});
  assert.deepEqual(decodeCsvBytes(utf8.buffer), {text: "Name\nJosé €", encoding: "UTF-8"});
  // "José €" as Excel saves it: é = 0xE9, € = 0x80.
  const cp1252 = Uint8Array.from([0x4A, 0x6F, 0x73, 0xE9, 0x20, 0x80]);
  assert.deepEqual(decodeCsvBytes(cp1252), {text: "José €", encoding: "Windows-1252"});
  const utf16 = Uint8Array.from([0xFF, 0xFE, 0x41, 0x00, 0xE9, 0x00]);
  const r = decodeCsvBytes(utf16);
  assert.equal(r.encoding, "UTF-16");
  assert.equal(r.text, "Aé");
});

test("soqlFromObject finds the outer FROM", () => {
  assert.equal(soqlFromObject("SELECT Id FROM Account"), "Account");
  assert.equal(soqlFromObject("SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Name != null"), "Account");
  assert.equal(soqlFromObject("select id from Case where Subject = 'copied from Lead'"), "Case");
  assert.equal(soqlFromObject("SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)"), "Account");
  assert.equal(soqlFromObject(raw`SELECT Id FROM Lead WHERE Name = 'O\'Brien from X'`), "Lead");
});

test("soqlFromObject returns an empty string without an outer FROM", () => {
  assert.equal(soqlFromObject(""), "");
  assert.equal(soqlFromObject("SELECT Id, (SELECT Id FROM Contacts)"), "");
  assert.equal(soqlFromObject("SELECT Id, (SELECT Id FROM Con"), "");
  assert.equal(soqlFromObject("SELECT Id FROM "), "");
});

test("formatSoql upper-cases keywords and breaks clauses", () => {
  assert.equal(formatSoql("select Id,  Name from Account where Name like 'a%' order by Name desc limit 5"),
    "SELECT Id, Name \nFROM Account \nWHERE Name LIKE 'a%' \nORDER BY Name DESC \nLIMIT 5");
  assert.equal(formatSoql("   "), "   ");
});

test("formatSoql leaves string literals with escaped quotes untouched", () => {
  const lit = raw`'O\'Brien and from x'`;
  assert.equal(formatSoql(`select Id from Contact where Name = ${lit} and Title = 'or  not'`),
    `SELECT Id \nFROM Contact \nWHERE Name = ${lit} AND Title = 'or  not'`);
  const tail = raw`'a\\'`;
  assert.equal(formatSoql(`select Id from A where X = ${tail} and Y = 'limit'`),
    `SELECT Id \nFROM A \nWHERE X = ${tail} AND Y = 'limit'`);
});

const sheetXml = async blob => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));

test("xlsx writes JS numbers as numeric cells and everything else as text", async () => {
  const xml = await sheetXml(toXlsxBlob("S", ["Amount", "Phone", "Id", "Bad"],
    [{Amount: 12.5, Phone: "0123456789", Id: "001000000000001", Bad: NaN}]));
  assert.ok(xml.includes('<c r="A2"><v>12.5</v></c>'));
  assert.ok(xml.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">0123456789</t></is></c>'));
  assert.ok(xml.includes('<c r="C2" t="inlineStr">'));
  assert.ok(xml.includes('<c r="D2" t="inlineStr"><is><t xml:space="preserve">NaN</t></is></c>'));
});

test("xlsx refuses more rows than an Excel sheet holds", () => {
  assert.throws(() => toXlsxBlob("S", ["A"], {length: 1048576}), /do not fit in one Excel sheet/);
});
