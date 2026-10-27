import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function assertObject(value, context) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${context}: invalid object`);
}

function assertNonemptyString(value, context) {
  assert.ok(typeof value === "string" && value.length > 0, `${context}: missing value`);
}

function evalKey(record) {
  return JSON.stringify([record.evalFilePath, record.variant, record.model ?? null]);
}

function trialGroupKey(record) {
  return JSON.stringify([record.evalFilePath, record.variant, record.model ?? null, record.stimulus]);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function discoverResultFiles(root) {
  const files = [];
  const visit = path => {
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), "Evaluation results must not contain symbolic links");
    assert.ok(stat.isDirectory(), `Evaluation result path is not a directory: ${path}`);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "Evaluation results must not contain symbolic links");
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === "results.jsonl") files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

function expectedResultFiles(root, expectedRuns) {
  assert.ok(Array.isArray(expectedRuns) && expectedRuns.length > 0, "At least one expected evaluation run is required");
  const unique = new Set(expectedRuns);
  assert.equal(unique.size, expectedRuns.length, "Expected evaluation runs must be unique");
  if (unique.has(".")) assert.equal(unique.size, 1, "The root evaluation run cannot be combined with child runs");

  const allFiles = discoverResultFiles(root);
  const claimed = new Set();
  const files = [];
  for (const run of expectedRuns) {
    assert.equal(typeof run, "string", "Expected evaluation run must be a string");
    assert.match(run, /^(?:\.|[a-z0-9][a-z0-9-]*)$/, `Invalid expected evaluation run: ${run}`);
    const path = run === "." ? root : join(root, run);
    assert.ok(existsSync(path), `Missing expected evaluation run: ${run}`);
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), "Evaluation results must not contain symbolic links");
    assert.ok(stat.isDirectory(), `Expected evaluation run is not a directory: ${run}`);
    const matches = allFiles.filter(file => isWithin(path, file));
    assert.equal(matches.length, 1, `${run}: expected exactly one results.jsonl artifact`);
    assert.ok(!claimed.has(matches[0]), `Overlapping expected evaluation run: ${run}`);
    claimed.add(matches[0]);
    files.push(matches[0]);
  }

  const unexpected = allFiles.filter(file => !claimed.has(file))
    .map(file => relative(root, file).split(sep).join("/"));
  assert.equal(unexpected.length, 0, `Unexpected results.jsonl artifacts: ${unexpected.join(", ")}`);
  return files;
}

export function checkEvalRecords(records, source) {
  const trials = records.filter(record => record.type === "trial-result");
  const summaries = records.filter(record => record.type === "run-summary");
  assert.ok(trials.length > 0, `${source}: no completed trials`);
  assert.equal(summaries.length, 1, `${source}: missing or duplicate run summary`);
  const summary = summaries[0];
  assert.equal(summary.hadExecutionErrors, false, `${source}: execution errors`);
  assert.ok(Array.isArray(summary.evals) && summary.evals.length > 0, `${source}: missing evaluation summaries`);

  const evals = new Map();
  for (const [index, evaluation] of summary.evals.entries()) {
    const context = `${source}: summary evaluation ${index + 1}`;
    assertObject(evaluation, context);
    assertNonemptyString(evaluation.name, `${context}: name`);
    assertNonemptyString(evaluation.evalFilePath, `${context}: eval file`);
    assertNonemptyString(evaluation.variant, `${context}: variant`);
    if (evaluation.model !== undefined) assertNonemptyString(evaluation.model, `${context}: model`);
    assert.equal(evaluation.error, undefined, `${context}: evaluation plan error`);
    assert.ok(Number.isInteger(evaluation.stimuliRun) && evaluation.stimuliRun >= 0,
      `${context}: invalid stimuliRun`);
    assert.ok(Number.isInteger(evaluation.stimuliTotal) && evaluation.stimuliTotal >= 0,
      `${context}: invalid stimuliTotal`);
    assert.ok(evaluation.stimuliRun <= evaluation.stimuliTotal, `${context}: invalid stimulus counts`);
    const key = evalKey(evaluation);
    assert.ok(!evals.has(key), `${context}: duplicate evaluation summary`);
    evals.set(key, evaluation);
  }

  const groups = new Map();
  for (const [index, trial] of trials.entries()) {
    const context = `${source}: trial ${index + 1}`;
    assert.equal(trial.status, "success", `${context}: execution did not complete successfully`);
    assertNonemptyString(trial.evalName, `${context}: eval name`);
    assertNonemptyString(trial.evalFilePath, `${context}: eval file`);
    assertNonemptyString(trial.variant, `${context}: variant`);
    if (trial.model !== undefined) assertNonemptyString(trial.model, `${context}: model`);
    assertNonemptyString(trial.stimulus, `${context}: stimulus`);
    const hasTrialIndex = trial.trialIndex !== undefined;
    const hasTotalTrials = trial.totalTrials !== undefined;
    assert.equal(hasTrialIndex, hasTotalTrials, `${context}: incomplete trial metadata`);
    const trialIndex = trial.trialIndex ?? 0;
    const totalTrials = trial.totalTrials ?? 1;
    assert.ok(Number.isInteger(totalTrials) && totalTrials > 0, `${context}: invalid totalTrials`);
    assert.ok(Number.isInteger(trialIndex) && trialIndex >= 0 && trialIndex < totalTrials,
      `${context}: invalid trialIndex`);
    assert.ok(trial.gradeResult && typeof trial.gradeResult === "object", `${context}: missing grading result`);
    const pending = [trial.gradeResult];
    while (pending.length) {
      const grade = pending.pop();
      assert.ok(grade && typeof grade === "object", `${context}: invalid grading result`);
      assert.notEqual(grade.status, "error", `${context}: grading infrastructure error`);
      assert.equal(typeof grade.passed, "boolean", `${context}: missing grading verdict`);
      assert.ok(Number.isFinite(grade.score) && grade.score >= 0 && grade.score <= 1,
        `${context}: invalid grading score`);
      if (grade.details !== undefined) {
        assert.ok(Array.isArray(grade.details), `${context}: invalid grading details`);
        pending.push(...grade.details);
      }
    }

    const key = trialGroupKey(trial);
    const group = groups.get(key) ?? {
      evalName: trial.evalName,
      evalKey: evalKey(trial),
      stimulus: trial.stimulus,
      totalTrials,
      indices: new Set()
    };
    assert.equal(group.evalName, trial.evalName, `${context}: inconsistent eval name`);
    assert.equal(group.totalTrials, totalTrials, `${context}: inconsistent totalTrials`);
    assert.ok(!group.indices.has(trialIndex), `${context}: duplicate trialIndex`);
    group.indices.add(trialIndex);
    groups.set(key, group);
  }

  const groupCounts = new Map();
  for (const group of groups.values()) {
    assert.equal(group.indices.size, group.totalTrials,
      `${source}: ${group.stimulus}: incomplete trial records`);
    for (let index = 0; index < group.totalTrials; index++) {
      assert.ok(group.indices.has(index), `${source}: ${group.stimulus}: missing trial index ${index}`);
    }
    const evaluation = evals.get(group.evalKey);
    assert.ok(evaluation, `${source}: ${group.stimulus}: missing evaluation summary`);
    assert.equal(group.evalName, evaluation.name, `${source}: ${group.stimulus}: evaluation name mismatch`);
    groupCounts.set(group.evalKey, (groupCounts.get(group.evalKey) ?? 0) + 1);
  }

  for (const [key, evaluation] of evals) {
    assert.equal(groupCounts.get(key) ?? 0, evaluation.stimuliRun,
      `${source}: ${evaluation.name}: incomplete stimulus records`);
  }
  return trials.length;
}

export function checkEvalResults(root, expectedRuns) {
  const resolvedRoot = resolve(root);
  assert.ok(existsSync(resolvedRoot), `Missing evaluation results directory: ${resolvedRoot}`);
  const files = expectedResultFiles(resolvedRoot, expectedRuns);
  let trials = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim());
    const records = lines.map((line, index) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(`${file}: invalid JSON at line ${index + 1}`);
      }
      assertObject(record, `${file}: record at line ${index + 1}`);
      return record;
    });
    trials += checkEvalRecords(records, file);
  }
  return { files: files.length, trials };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length >= 4,
      "Usage: node scripts/check-eval-results.mjs <results-directory> <expected-run>...");
    const expectedRuns = process.argv.slice(3);
    const result = checkEvalResults(resolve(process.argv[2]), expectedRuns);
    console.log(`Checked ${result.trials} trials in ${result.files} result files across ${expectedRuns.length} expected runs: no execution or grading infrastructure errors.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation infrastructure check failed");
    process.exitCode = 1;
  }
}
