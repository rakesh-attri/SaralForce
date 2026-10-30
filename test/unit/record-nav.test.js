import {test} from "node:test";
import assert from "node:assert/strict";
import {parentLinks, parentNameQuery, childLists, historySource, historyRows, nameFieldOf} from "../../addon/core/record-nav.js";

const FIELDS = [
  {name: "Id", type: "id"},
  {name: "Name", type: "string", nameField: true},
  {name: "OwnerId", type: "reference", label: "Owner ID", referenceTo: ["User"], relationshipName: "Owner"},
  {name: "ParentId", type: "reference", label: "Parent Account ID", referenceTo: ["Account"], relationshipName: "Parent"},
  {name: "MasterRecordId", type: "reference", label: "Master Record ID", referenceTo: ["Account"], relationshipName: "MasterRecord"},
];

test("parentLinks keeps lookups that have a value", () => {
  const links = parentLinks(FIELDS, {OwnerId: "005000000000001AAA", ParentId: null, MasterRecordId: "bad"});
  assert.deepEqual(links.map(l => [l.field, l.id, l.targets[0]]), [["OwnerId", "005000000000001AAA", "User"]]);
  assert.equal(parentNameQuery("Account", "001000000000001AAA", links), "SELECT Id, Owner.Name FROM Account WHERE Id = '001000000000001AAA'");
  assert.equal(parentNameQuery("Account", "x", []), null);
});

const DESCRIBE = {
  fields: FIELDS,
  childRelationships: [
    {relationshipName: "Opportunities", childSObject: "Opportunity", field: "AccountId"},
    {relationshipName: "Contacts", childSObject: "Contact", field: "AccountId"},
    {relationshipName: "Histories", childSObject: "AccountHistory", field: "AccountId"},
    {relationshipName: "Shares", childSObject: "AccountShare", field: "AccountId"},
    {relationshipName: null, childSObject: "Task", field: "WhatId"},
  ],
};

test("childLists hides system relationships and sorts", () => {
  assert.deepEqual(childLists(DESCRIBE).map(c => c.relationshipName), ["Contacts", "Opportunities"]);
  assert.equal(childLists(DESCRIBE, {includeSystem: true}).length, 4);
});

test("historySource finds the history object", () => {
  assert.deepEqual(historySource(DESCRIBE), {object: "AccountHistory", field: "AccountId"});
  assert.deepEqual(historySource({childRelationships: [{relationshipName: "X", childSObject: "OpportunityFieldHistory", field: "OpportunityId"}]}),
    {object: "OpportunityFieldHistory", field: "OpportunityId"});
  assert.equal(historySource({childRelationships: []}), null);
});

test("historyRows labels fields and drops id-only twins", () => {
  const rows = historyRows([
    {Id: "1", Field: "Owner", OldValue: "Ann", NewValue: "Raj", CreatedDate: "2026-10-01T10:00:00.000+0000", CreatedBy: {Name: "Admin"}},
    {Id: "2", Field: "Owner", OldValue: "005000000000001AAA", NewValue: "005000000000002AAA", CreatedDate: "2026-10-01T10:00:00.000+0000", CreatedBy: {Name: "Admin"}},
    {Id: "3", Field: "Industry", OldValue: null, NewValue: "Energy", CreatedDate: "2026-09-01T10:00:00.000+0000", CreatedBy: {Name: "Priya"}},
    {Id: "4", Field: "created", CreatedDate: "2026-08-01T10:00:00.000+0000", CreatedBy: {Name: "Priya"}},
  ], {Industry: "Industry", Owner: "Account Owner"});
  assert.deepEqual(rows.map(r => [r.label, r.oldValue, r.newValue, r.who]), [
    ["Account Owner", "Ann", "Raj", "Admin"],
    ["Industry", "", "Energy", "Priya"],
    ["Record created", "", "", "Priya"],
  ]);
});

test("nameFieldOf", () => {
  assert.equal(nameFieldOf(DESCRIBE), "Name");
  assert.equal(nameFieldOf({fields: [{name: "Id"}]}), "Id");
});
