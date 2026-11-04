import test from "node:test";
import assert from "node:assert/strict";
import {applyDefaultLimit, soqlNeedsLimit, escapeSoqlString, escapeSoqlLike} from "../../addon/core/soql.js";

const raw = String.raw;

test("applyDefaultLimit appends LIMIT to a plain query", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account", 200), "SELECT Id FROM Account LIMIT 200");
  assert.equal(applyDefaultLimit("  SELECT Id FROM Account WHERE Name = 'x'  ", 5),
    "SELECT Id FROM Account WHERE Name = 'x' LIMIT 5");
});

test("applyDefaultLimit keeps an existing LIMIT", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account LIMIT 10", 200), "SELECT Id FROM Account LIMIT 10");
  assert.equal(applyDefaultLimit("select id from account limit 10 offset 5", 200), "select id from account limit 10 offset 5");
});

test("applyDefaultLimit inserts before OFFSET", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account ORDER BY Name OFFSET 10", 100),
    "SELECT Id FROM Account ORDER BY Name LIMIT 100 OFFSET 10");
});

test("applyDefaultLimit inserts before FOR / UPDATE clauses", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account FOR VIEW", 50), "SELECT Id FROM Account LIMIT 50 FOR VIEW");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account FOR REFERENCE", 50), "SELECT Id FROM Account LIMIT 50 FOR REFERENCE");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account WHERE Id = 'a' FOR UPDATE", 50),
    "SELECT Id FROM Account WHERE Id = 'a' LIMIT 50 FOR UPDATE");
  assert.equal(applyDefaultLimit("SELECT Title FROM FAQ__kav UPDATE TRACKING", 50),
    "SELECT Title FROM FAQ__kav LIMIT 50 UPDATE TRACKING");
  assert.equal(applyDefaultLimit("SELECT Title FROM FAQ__kav UPDATE VIEWSTAT", 50),
    "SELECT Title FROM FAQ__kav LIMIT 50 UPDATE VIEWSTAT");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account OFFSET 5 FOR VIEW", 50),
    "SELECT Id FROM Account LIMIT 50 OFFSET 5 FOR VIEW");
});

test("applyDefaultLimit appends after WITH clauses (WITH precedes LIMIT)", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account WITH SECURITY_ENFORCED", 10),
    "SELECT Id FROM Account WITH SECURITY_ENFORCED LIMIT 10");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account WITH USER_MODE ORDER BY Name", 10),
    "SELECT Id FROM Account WITH USER_MODE ORDER BY Name LIMIT 10");
});

test("applyDefaultLimit ignores keywords inside strings and sub-queries", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account WHERE Name = 'limit 5 offset 2'", 10),
    "SELECT Id FROM Account WHERE Name = 'limit 5 offset 2' LIMIT 10");
  assert.equal(applyDefaultLimit("SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account", 10),
    "SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account LIMIT 10");
  assert.equal(applyDefaultLimit(raw`SELECT Id FROM Account WHERE Name = 'it\'s FOR VIEW'`, 10),
    raw`SELECT Id FROM Account WHERE Name = 'it\'s FOR VIEW' LIMIT 10`);
});

test("applyDefaultLimit skips aggregate queries without GROUP BY", () => {
  assert.equal(applyDefaultLimit("SELECT COUNT() FROM Account", 10), "SELECT COUNT() FROM Account");
  assert.equal(applyDefaultLimit("SELECT MAX(Amount) FROM Opportunity", 10), "SELECT MAX(Amount) FROM Opportunity");
  assert.equal(applyDefaultLimit("SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName", 10),
    "SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName LIMIT 10");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account WHERE Name = 'COUNT(x)'", 10),
    "SELECT Id FROM Account WHERE Name = 'COUNT(x)' LIMIT 10");
});

test("applyDefaultLimit leaves the query alone for an invalid limit", () => {
  assert.equal(applyDefaultLimit("SELECT Id FROM Account", 0), "SELECT Id FROM Account");
  assert.equal(applyDefaultLimit("SELECT Id FROM Account", "abc"), "SELECT Id FROM Account");
});

test("soqlNeedsLimit", () => {
  assert.equal(soqlNeedsLimit("SELECT Id FROM Account"), true);
  assert.equal(soqlNeedsLimit("SELECT Id FROM Account LIMIT 1"), false);
  assert.equal(soqlNeedsLimit("SELECT COUNT() FROM Account"), false);
});

test("escapeSoqlString escapes backslash before quote", () => {
  assert.equal(escapeSoqlString("O'Brien"), raw`O\'Brien`);
  assert.equal(escapeSoqlString(raw`a\b`), raw`a\\b`);
  assert.equal(escapeSoqlString(raw`\'`), raw`\\\'`);
  assert.equal(escapeSoqlString("a\nb"), raw`a\nb`);
  assert.equal(escapeSoqlString(null), "");
  assert.equal(escapeSoqlString("50%_x"), "50%_x");
});

test("escapeSoqlLike also escapes wildcards", () => {
  assert.equal(escapeSoqlLike("50%_off"), raw`50\%\_off`);
  assert.equal(escapeSoqlLike(raw`it's\ `), raw`it\'s\\ `);
  assert.equal(escapeSoqlLike(undefined), "");
});
