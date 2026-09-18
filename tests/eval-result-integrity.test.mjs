import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkEvalRecords, checkEvalResults } from "../scripts/check-eval-results.mjs";

function records() {
  return [
    { type: "trial-result", status: "success",
      gradeResult: { passed: true, score: 1, details: [{ passed: true, score: 1 }] } },
    { type: "run-summary", hadExecutionErrors: false, passed: true }
  ];
}

test("evaluation infrastructure checking does not replace the existing content threshold", () => {
  const data = records();
  Object.assign(data[0].gradeResult, { passed: false, score: 0.5 });
  Object.assign(data[0].gradeResult.details[0], { passed: false, score: 0 });
  data[1].passed = false;
  assert.equal(checkEvalRecords(data, "fixture"), 1);
});

for (const [name, mutate, expected] of [
  ["unavailable judge despite a passing aggregate", data => { data[0].gradeResult.details[0].status = "error"; }, /grading infrastructure error/],
  ["aggregate grader error", data => { data[0].gradeResult.status = "error"; }, /grading infrastructure error/],
  ["execution error", data => { data[0].status = "error"; }, /execution did not complete/],
  ["summary execution error", data => { data[1].hadExecutionErrors = true; }, /execution errors/],
  ["ungraded trial", data => { delete data[0].gradeResult; }, /missing grading result/],
  ["missing verdict", data => { delete data[0].gradeResult.passed; }, /missing grading verdict/],
  ["invalid score", data => { data[0].gradeResult.score = 2; }, /invalid grading score/],
  ["truncated run", data => { data.pop(); }, /missing or duplicate run summary/],
  ["duplicate summary", data => { data.push(data[1]); }, /missing or duplicate run summary/],
  ["empty run", data => { data.shift(); }, /no completed trials/]
]) {
  test(`evaluation infrastructure rejects ${name}`, () => {
    const data = records();
    mutate(data);
    assert.throws(() => checkEvalRecords(data, "fixture"), expected);
  });
}

test("result discovery checks every suite and does not expose malformed record contents", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-eval-results-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => checkEvalResults(root), /No results.jsonl/);
  for (const suite of ["router", "migration"]) {
    const directory = join(root, suite, "run");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "results.jsonl"), records().map(record => JSON.stringify(record)).join("\r\n"));
  }
  assert.deepEqual(checkEvalResults(root), { files: 2, trials: 2 });
  writeFileSync(join(root, "router/run/results.jsonl"), "sensitive-malformed-input");
  assert.throws(() => checkEvalResults(root), error => {
    assert.match(error.message, /invalid JSON at line 1/);
    assert.doesNotMatch(error.message, /sensitive-malformed-input/);
    return true;
  });
});
