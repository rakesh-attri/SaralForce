import {test} from "node:test";
import assert from "node:assert/strict";
import {apexErrorForAi, fixSummary, fixDropsCode} from "../../addon/core/apex-ai.js";

test("a clean run never asks the AI", () => {
  assert.equal(apexErrorForAi({compiled: true, success: true}), null);
  assert.equal(apexErrorForAi(null), null);
});

test("compile and runtime errors are described for the AI", () => {
  assert.deepEqual(apexErrorForAi({compiled: false, success: false, compileProblem: "Unexpected token 'insert'.", line: 4, column: 1}),
    {stage: "compile", text: "Compile error (line 4, column 1): Unexpected token 'insert'."});
  const rt = apexErrorForAi({compiled: true, success: false, exceptionMessage: "System.DmlException: REQUIRED_FIELD_MISSING",
    exceptionStackTrace: "AnonymousBlock: line 20, column 1"});
  assert.equal(rt.stage, "runtime");
  assert.match(rt.text, /^Runtime exception: System\.DmlException: REQUIRED_FIELD_MISSING\nStack: AnonymousBlock: line 20/);
});

const SCRIPT = `Order ord = new Order(Status = 'Draft');
insert ord;
ord.Status = 'Activated';
update ord;
AcademicOrder acOrder = new AcademicOrder(
    OrderId = ord.Id,
    AcademicIntervalId = '0u7f60000001kX3AAI'
);
insert acOrder;
System.debug(ord.Id);`;

test("fixSummary shows a fix that silently deletes a block", () => {
  const dropped = SCRIPT.replace(/AcademicOrder[\s\S]*insert acOrder;\n/, "");
  const s = fixSummary(SCRIPT, dropped);
  assert.equal(s.changed, true);
  assert.equal(s.removed.length, 5);
  assert.equal(s.added.length, 0);
  assert.equal(fixDropsCode(s), true);
});

test("fixSummary on a one-line fix and on identical code", () => {
  const fixed = SCRIPT.replace("insert ord;", "insert ord; // fixed");
  const s = fixSummary(SCRIPT, fixed);
  assert.deepEqual([s.removed, s.added], [["insert ord;"], ["insert ord; // fixed"]]);
  assert.equal(fixDropsCode(s), false);
  assert.equal(fixSummary(SCRIPT, SCRIPT + "\n\n").changed, false);
});
