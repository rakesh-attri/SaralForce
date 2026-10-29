import {test} from "node:test";
import assert from "node:assert/strict";
import {
  maskCode, apexOutline, triggerOutline, pageOutline, lwcOutline, auraOutline,
  formulaTokens, formulaFields, formulaFunctions, formulaHighlight
} from "../../addon/core/code-outline.js";

const CLS = `/**
 * Handles invoices. public void notAMethod() {}
 */
@RestResource(urlMapping='/inv/*')
public with sharing class InvoiceService implements Queueable, Database.Stateful {
    private static final Integer MAX_ROWS = 200;
    public String status { get; set; }

    public InvoiceService() {
        String s = 'public void fake() {';
    }

    @AuraEnabled(cacheable=true)
    public static List<Invoice__c> getOpen(Id accountId, Integer maxRows) {
        if (accountId == null) { return new List<Invoice__c>(); }
        return [SELECT Id FROM Invoice__c WHERE Account__c = :accountId LIMIT :maxRows];
    }

    public void execute(QueueableContext ctx) {
        update new Invoice__c();
        HttpRequest req = new HttpRequest();
    }

    private class Row {
        public String name;
    }
}`;

test("maskCode blanks comments and strings but keeps length", () => {
  const src = "a = 'x{y}'; // c{\n/* {} */ b";
  const m = maskCode(src);
  assert.equal(m.length, src.length);
  assert.doesNotMatch(m, /[{}]/);
});

test("apexOutline reads the declaration, methods and fields", () => {
  const o = apexOutline(CLS);
  assert.equal(o.name, "InvoiceService");
  assert.equal(o.sharing, "with sharing");
  assert.deepEqual(o.implements, ["Queueable", "Database.Stateful"]);
  assert.deepEqual(o.annotations, ["@RestResource(urlMapping='/inv/*')"]);
  assert.deepEqual(o.methods.map(m => [m.name, m.returns, m.isStatic, m.constructor]), [
    ["InvoiceService", "", false, true],
    ["getOpen", "List<Invoice__c>", true, false],
    ["execute", "void", false, false],
  ]);
  assert.equal(o.methods[1].params, "Id accountId, Integer maxRows");
  assert.deepEqual(o.methods[1].annotations, ["@AuraEnabled(cacheable=true)"]);
  assert.deepEqual(o.fields.map(f => [f.name, f.type, f.property]), [["MAX_ROWS", "Integer", false], ["status", "String", true]]);
  assert.deepEqual(o.innerClasses, ["Row"]);
  assert.equal(o.stats.soql, 1);
  assert.equal(o.stats.dml, 1);
  assert.equal(o.stats.callouts, 1);
  assert.equal(o.stats.auraEnabled, 1);
});

test("apexOutline ignores comments above a method", () => {
  const o = apexOutline("public class A {\n    // Marks overdue invoices.\n    /* note */ public static Integer markOverdue(List<Invoice__c> rows) {\n        return 1;\n    }\n}");
  assert.deepEqual(o.methods.map(m => [m.name, m.returns, m.access]), [["markOverdue", "Integer", "public"]]);
});

test("apexOutline spots test classes", () => {
  const o = apexOutline("@IsTest\nprivate class FooTest {\n  @IsTest static void works() { }\n}");
  assert.equal(o.isTest, true);
  assert.equal(o.stats.tests, 1);
});

test("triggerOutline", () => {
  const o = triggerOutline("trigger AccTrig on Account (before insert, after  update) {\n  AccountHandler.run(Trigger.new, Trigger.oldMap);\n  System.debug('x');\n}");
  assert.equal(o.object, "Account");
  assert.deepEqual(o.events, ["before insert", "after update"]);
  assert.deepEqual(o.calls, ["AccountHandler.run"]);
  assert.deepEqual(o.usesContext, ["Trigger.new", "Trigger.oldMap"]);
});

test("pageOutline", () => {
  const o = pageOutline('<apex:page standardController="Account" extensions="A, B" renderAs="pdf">\n<apex:form><apex:inputField value="{!Account.Name}"/><apex:inputField value="{! Account.Phone }"/></apex:form></apex:page>');
  assert.equal(o.standardController, "Account");
  assert.deepEqual(o.extensions, ["A", "B"]);
  assert.deepEqual(o.components, [{name: "apex:inputfield", count: 2}, {name: "apex:form", count: 1}]);
  assert.deepEqual(o.mergeFields, ["Account.Name", "Account.Phone"]);
});

test("lwcOutline", () => {
  const o = lwcOutline([
    {path: "lwc/x/x.js", source: "import { LightningElement, api, wire } from 'lwc';\nimport getRows from '@salesforce/apex/Ctrl.getRows';\nimport { ShowToastEvent } from 'lightning/platformShowToastEvent';\nexport default class X extends LightningElement {\n  @api recordId;\n  @api get title() { return 1; }\n  @wire(getRows, {id: '$recordId'}) rows;\n  fire() { this.dispatchEvent(new CustomEvent('select')); }\n}"},
    {path: "lwc/x/x.html", source: "<template><lightning-card><c-row></c-row><c-row></c-row><lightning-button></lightning-button></lightning-card></template>"},
  ], {isExposed: true, masterLabel: "X", targets: {target: ["lightning__RecordPage"]}});
  assert.deepEqual(o.apis, ["recordId", "title"]);
  assert.deepEqual(o.apex, [{local: "getRows", method: "Ctrl.getRows"}]);
  assert.deepEqual(o.wires, ["getRows"]);
  assert.deepEqual(o.imports, ["lightning/platformShowToastEvent"]);
  assert.deepEqual(o.events, ["select"]);
  assert.deepEqual(o.children[0], {name: "c-row", count: 2});
  assert.deepEqual(o.targets, ["lightning__RecordPage"]);
  assert.equal(o.toast, true);
});

test("auraOutline", () => {
  const o = auraOutline([
    {defType: "COMPONENT", source: '<aura:component implements="force:hasRecordId,flexipage:availableForRecordHome" controller="AccCtrl">\n<aura:attribute name="rows" type="List" default="[]"/>\n<aura:handler name="init" value="{!this}" action="{!c.init}"/>\n<lightning:card><lightning:button/></lightning:card></aura:component>'},
    {defType: "CONTROLLER", source: "({ init: function (c, e, h) {}, save : function () {} })"},
  ]);
  assert.deepEqual(o.implements, ["force:hasRecordId", "flexipage:availableForRecordHome"]);
  assert.equal(o.controller, "AccCtrl");
  assert.deepEqual(o.attributes, [{name: "rows", type: "List", default: "[]"}]);
  assert.deepEqual(o.handlers, [{name: "init", action: "{!c.init}"}]);
  assert.deepEqual(o.actions, ["init", "save"]);
  assert.deepEqual(o.children.map(c => c.name), ["lightning:button", "lightning:card"]);
});

test("formula helpers", () => {
  const f = 'AND(ISPICKVAL(Stage__c, "Closed"), Amount < 0, NOT(ISBLANK(Owner.Email)), $User.Id <> null)';
  assert.deepEqual(formulaFields(f), ["Stage__c", "Amount", "Owner.Email"]);
  assert.deepEqual(formulaFunctions(f), ["AND", "ISPICKVAL", "NOT", "ISBLANK"]);
  assert.equal(formulaTokens("1 + x").map(t => t.t).join(","), "num,txt,op,txt,field");
  assert.match(formulaHighlight('LEN(Name) > 5 && "a<b"'), /<span class="tok-fn">LEN<\/span>.*&amp;&amp;.*"a&lt;b"/);
});
