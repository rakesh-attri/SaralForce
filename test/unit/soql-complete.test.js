import {test} from "node:test";
import assert from "node:assert/strict";
import {
  soqlCompletionContext, rankCompletions, resolveRelationshipPath,
  soqlCompletions, applyCompletion, pickObjectsForPrompt
} from "../../addon/core/soql-complete.js";

const ctxAtEnd = q => soqlCompletionContext(q, q.length);

const DESCRIBES = {
  Account: {
    fields: [
      {name: "Id", label: "Account ID", type: "id"},
      {name: "Name", label: "Account Name", type: "string"},
      {name: "OwnerId", label: "Owner ID", type: "reference", referenceTo: ["User"], relationshipName: "Owner"},
      {name: "Industry", label: "Industry", type: "picklist"},
    ],
    childRelationships: [
      {relationshipName: "Contacts", childSObject: "Contact"},
      {relationshipName: null, childSObject: "AccountHistory"},
    ],
  },
  User: {
    fields: [
      {name: "Id", label: "User ID", type: "id"},
      {name: "Name", label: "Full Name", type: "string"},
      {name: "ProfileId", label: "Profile ID", type: "reference", referenceTo: ["Profile"], relationshipName: "Profile"},
    ],
  },
  Profile: {fields: [{name: "Id", type: "id"}, {name: "Name", label: "Name", type: "string"}]},
  Contact: {fields: [{name: "Id", type: "id"}, {name: "Email", label: "Email", type: "email"}, {name: "LastName", label: "Last Name", type: "string"}]},
};
const deps = {
  describe: async name => {
    if (!DESCRIBES[name]) throw new Error("unknown " + name);
    return DESCRIBES[name];
  },
  listObjects: async () => [{name: "Account", label: "Account"}, {name: "Contact", label: "Contact"}, {name: "Invoice__c", label: "Invoice"}],
};

test("object after FROM", () => {
  const c = ctxAtEnd("SELECT Id FROM Acc");
  assert.equal(c.kind, "object");
  assert.equal(c.prefix, "Acc");
  assert.equal(c.start, 15);
});

test("empty prefix right after FROM still offers objects", () => {
  assert.equal(ctxAtEnd("SELECT Id FROM ").kind, "object");
});

test("field in SELECT list uses the FROM object after the caret", () => {
  const q = "SELECT Id, Na FROM Account";
  const c = soqlCompletionContext(q, "SELECT Id, Na".length);
  assert.equal(c.kind, "field");
  assert.equal(c.object, "Account");
  assert.equal(c.prefix, "Na");
  assert.deepEqual(c.path, []);
  assert.equal(c.clause, "select");
});

test("relationship path splits into path and prefix", () => {
  const q = "SELECT Owner.Profile.Na FROM Account";
  const c = soqlCompletionContext(q, "SELECT Owner.Profile.Na".length);
  assert.deepEqual(c.path, ["Owner", "Profile"]);
  assert.equal(c.prefix, "Na");
  assert.equal(c.start, "SELECT Owner.Profile.".length);
});

test("WHERE clause fields and keywords", () => {
  const c = ctxAtEnd("SELECT Id FROM Account WHERE Ind");
  assert.equal(c.kind, "field");
  assert.equal(c.clause, "where");
  assert.ok(c.keywords.includes("LIKE"));
});

test("nothing inside a string literal", () => {
  assert.equal(ctxAtEnd("SELECT Id FROM Account WHERE Name = 'Acm"), null);
});

test("nothing after LIMIT", () => {
  assert.equal(ctxAtEnd("SELECT Id FROM Account LIMIT 5"), null);
});

test("keyword after the FROM object", () => {
  const c = ctxAtEnd("SELECT Id FROM Account WH");
  assert.equal(c.kind, "keyword");
  assert.ok(c.keywords.includes("WHERE"));
});

test("child sub-query FROM offers child relationships", () => {
  const q = "SELECT Id, (SELECT Id FROM Con) FROM Account";
  const c = soqlCompletionContext(q, q.indexOf("Con)") + 3);
  assert.equal(c.kind, "child");
  assert.equal(c.parentObject, "Account");
});

test("semi-join sub-query FROM offers regular objects", () => {
  const q = "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Con)";
  const c = soqlCompletionContext(q, q.length - 1);
  assert.equal(c.kind, "object");
});

test("fields inside a child sub-query know the parent", () => {
  const q = "SELECT Id, (SELECT Em FROM Contacts) FROM Account";
  const c = soqlCompletionContext(q, q.indexOf("Em") + 2);
  assert.equal(c.kind, "field");
  assert.equal(c.object, "Contacts");
  assert.equal(c.parentObject, "Account");
});

test("function parentheses are walked through", () => {
  const q = "SELECT COUNT(Na FROM Account";
  const c = soqlCompletionContext(q, "SELECT COUNT(Na".length);
  assert.equal(c.kind, "field");
  assert.equal(c.object, "Account");
});

test("rankCompletions orders exact, prefix, label, contains", () => {
  const items = [{value: "AccountName"}, {value: "Name"}, {value: "Phone", label: "Name phone"}, {value: "Nam"}];
  assert.deepEqual(rankCompletions(items, "nam").map(i => i.value), ["Nam", "Name", "Phone", "AccountName"]);
});

test("resolveRelationshipPath follows lookups", async () => {
  assert.equal(await resolveRelationshipPath("Account", ["Owner", "Profile"], deps.describe), "Profile");
  assert.equal(await resolveRelationshipPath("Account", ["Nope"], deps.describe), null);
});

test("soqlCompletions for a relationship path", async () => {
  const q = "SELECT Owner.Pro FROM Account";
  const items = await soqlCompletions(soqlCompletionContext(q, "SELECT Owner.Pro".length), deps);
  assert.deepEqual(items.map(i => i.value), ["Profile.", "ProfileId"]);
});

test("soqlCompletions for objects and child relationships", async () => {
  const objs = await soqlCompletions(ctxAtEnd("SELECT Id FROM inv"), deps);
  assert.deepEqual(objs.map(i => i.value), ["Invoice__c"]);
  const q = "SELECT Id, (SELECT Id FROM ) FROM Account";
  const kids = await soqlCompletions(soqlCompletionContext(q, q.indexOf(")")), deps);
  assert.deepEqual(kids.map(i => i.value), ["Contacts"]);
});

test("soqlCompletions inside a child sub-query uses the child object", async () => {
  const q = "SELECT Id, (SELECT Em FROM Contacts) FROM Account";
  const items = await soqlCompletions(soqlCompletionContext(q, q.indexOf("Em") + 2), deps);
  assert.deepEqual(items.map(i => i.value), ["Email"]);
});

test("applyCompletion replaces the whole word and spaces objects", () => {
  const q = "SELECT Id FROM Acc";
  const c = ctxAtEnd(q);
  assert.deepEqual(applyCompletion(q, c, {value: "Account", kind: "object"}), {text: "SELECT Id FROM Account ", caret: 23});
  const q2 = "SELECT Nam, Id FROM Account";
  const c2 = soqlCompletionContext(q2, 9);
  assert.equal(applyCompletion(q2, c2, {value: "Name", kind: "field"}).text, "SELECT Name, Id FROM Account");
  const r = applyCompletion("SELECT Ow FROM Account", soqlCompletionContext("SELECT Ow FROM Account", 9), {value: "Owner.", kind: "relationship"});
  assert.deepEqual(r, {text: "SELECT Owner. FROM Account", caret: 13});
});

test("pickObjectsForPrompt matches labels and plurals", () => {
  const objects = [
    {name: "Account", label: "Account"}, {name: "Contact", label: "Contact"},
    {name: "Opportunity", label: "Opportunity"}, {name: "Support_Ticket__c", label: "Support Ticket"},
  ];
  assert.deepEqual(pickObjectsForPrompt("open opportunities over 10k", objects), ["Opportunity"]);
  assert.deepEqual(pickObjectsForPrompt("support tickets created today", objects), ["Support_Ticket__c"]);
  assert.deepEqual(pickObjectsForPrompt("contacts of accounts in Energy", objects).sort(), ["Account", "Contact"]);
  assert.deepEqual(pickObjectsForPrompt("hello", objects), []);
});
