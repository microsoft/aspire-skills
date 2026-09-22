import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkEvalRecords, checkEvalResults } from "../scripts/check-eval-results.mjs";

const evalFilePath = "/repo/skills/fixture/evals/eval.yaml";

function records({ stimuli = ["fixture-stimulus"], totalTrials = 1 } = {}) {
  const trials = [];
  for (const stimulus of stimuli) {
    for (let trialIndex = 0; trialIndex < totalTrials; trialIndex++) {
      trials.push({
        type: "trial-result",
        itemId: `${evalFilePath}::main::model::${stimulus}::trial-${trialIndex}`,
        evalName: "fixture-eval",
        evalFilePath,
        variant: "main",
        model: "model",
        stimulus,
        trialIndex,
        totalTrials,
        status: "success",
        gradeResult: { passed: true, score: 1, details: [{ passed: true, score: 1 }] }
      });
    }
  }
  return [
    ...trials,
    {
      type: "run-summary",
      hadExecutionErrors: false,
      passed: true,
      evals: [{
        name: "fixture-eval",
        evalFilePath,
        variant: "main",
        model: "model",
        passed: true,
        scoringApplied: true,
        stimuliRun: stimuli.length,
        stimuliTotal: stimuli.length,
        durationMs: 1
      }]
    }
  ];
}

function writeResults(root, run, data = records()) {
  const directory = join(root, run, "run");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "results.jsonl"), data.map(record => JSON.stringify(record)).join("\r\n"));
}

test("evaluation infrastructure checking does not replace the existing content threshold", () => {
  const data = records();
  Object.assign(data[0].gradeResult, { passed: false, score: 0.5 });
  Object.assign(data[0].gradeResult.details[0], { passed: false, score: 0 });
  data.at(-1).passed = false;
  assert.equal(checkEvalRecords(data, "fixture"), 1);
});

test("single-trial Vally records may omit trial metadata", () => {
  const data = records();
  delete data[0].trialIndex;
  delete data[0].totalTrials;
  assert.equal(checkEvalRecords(data, "fixture"), 1);
});

for (const [name, mutate, expected] of [
  ["unavailable judge despite a passing aggregate", data => { data[0].gradeResult.details[0].status = "error"; }, /grading infrastructure error/],
  ["aggregate grader error", data => { data[0].gradeResult.status = "error"; }, /grading infrastructure error/],
  ["execution error", data => { data[0].status = "error"; }, /execution did not complete/],
  ["summary execution error", data => { data.at(-1).hadExecutionErrors = true; }, /execution errors/],
  ["evaluation plan error", data => { data.at(-1).evals[0].error = "invalid spec"; }, /evaluation plan error/],
  ["ungraded trial", data => { delete data[0].gradeResult; }, /missing grading result/],
  ["missing verdict", data => { delete data[0].gradeResult.passed; }, /missing grading verdict/],
  ["invalid score", data => { data[0].gradeResult.score = 2; }, /invalid grading score/],
  ["partial trial metadata", data => { delete data[0].trialIndex; }, /incomplete trial metadata/],
  ["invalid total trial count", data => { data[0].totalTrials = 0; }, /invalid totalTrials/],
  ["out-of-range trial index", data => { data[0].trialIndex = 1; }, /invalid trialIndex/],
  ["missing trial records", data => { data[0].totalTrials = 2; }, /incomplete trial records/],
  ["duplicate trial index", data => { data.splice(-1, 0, { ...data[0] }); }, /duplicate trialIndex/],
  ["summary stimulus mismatch", data => {
    data.at(-1).evals[0].stimuliRun = 2;
    data.at(-1).evals[0].stimuliTotal = 2;
  }, /incomplete stimulus records/],
  ["truncated run", data => { data.pop(); }, /missing or duplicate run summary/],
  ["duplicate summary", data => { data.push(data.at(-1)); }, /missing or duplicate run summary/],
  ["empty run", data => { data.shift(); }, /no completed trials/]
]) {
  test(`evaluation infrastructure rejects ${name}`, () => {
    const data = records();
    mutate(data);
    assert.throws(() => checkEvalRecords(data, "fixture"), expected);
  });
}

test("result discovery requires every expected run and rejects unclaimed artifacts", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-eval-results-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => checkEvalResults(root, ["router", "migration"]), /Missing expected evaluation run: router/);

  writeResults(root, "router");
  assert.throws(() => checkEvalResults(root, ["router", "migration"]), /Missing expected evaluation run: migration/);

  writeResults(root, "migration");
  assert.deepEqual(checkEvalResults(root, ["router", "migration"]), { files: 2, trials: 2 });

  writeResults(root, "unexpected");
  assert.throws(() => checkEvalResults(root, ["router", "migration"]), /Unexpected results\.jsonl artifacts/);
  rmSync(join(root, "unexpected"), { recursive: true, force: true });

  writeFileSync(join(root, "router/run/results.jsonl"), "sensitive-malformed-input");
  assert.throws(() => checkEvalResults(root, ["router", "migration"]), error => {
    assert.match(error.message, /invalid JSON at line 1/);
    assert.doesNotMatch(error.message, /sensitive-malformed-input/);
    return true;
  });
});

test("expected run roots must be safe, unique, and map to one artifact", t => {
  const root = mkdtempSync(join(tmpdir(), "aspire-eval-runs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeResults(root, "router");

  assert.throws(() => checkEvalResults(root, []), /At least one expected evaluation run/);
  assert.throws(() => checkEvalResults(root, ["router", "router"]), /must be unique/);
  assert.throws(() => checkEvalResults(root, [".", "router"]), /cannot be combined/);
  assert.throws(() => checkEvalResults(root, ["../router"]), /Invalid expected evaluation run/);
  assert.throws(() => checkEvalResults(root, ["missing"]), /Missing expected evaluation run/);
  assert.deepEqual(checkEvalResults(root, ["."]), { files: 1, trials: 1 });

  writeResults(root, "router-second");
  assert.throws(() => checkEvalResults(root, ["router"]), /Unexpected results\.jsonl artifacts/);
  rmSync(join(root, "router-second"), { recursive: true, force: true });
  writeResults(join(root, "router"), "second");
  assert.throws(() => checkEvalResults(root, ["router"]), /expected exactly one results\.jsonl artifact/);
});
