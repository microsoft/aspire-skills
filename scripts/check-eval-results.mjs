import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkEvalRecords(records, source) {
  const trials = records.filter(record => record.type === "trial-result");
  const summaries = records.filter(record => record.type === "run-summary");
  assert.ok(trials.length > 0, `${source}: no completed trials`);
  assert.equal(summaries.length, 1, `${source}: missing or duplicate run summary`);
  assert.equal(summaries[0].hadExecutionErrors, false, `${source}: execution errors`);
  for (const [index, trial] of trials.entries()) {
    const context = `${source}: trial ${index + 1}`;
    assert.equal(trial.status, "success", `${context}: execution did not complete successfully`);
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
  }
  return trials.length;
}

export function checkEvalResults(root) {
  const files = [];
  const visit = path => {
    assert.ok(!lstatSync(path).isSymbolicLink(), "Evaluation results must not contain symbolic links");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "Evaluation results must not contain symbolic links");
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === "results.jsonl") files.push(file);
    }
  };
  visit(root);
  assert.ok(files.length > 0, "No results.jsonl artifacts found");
  let trials = 0;
  for (const file of files.sort()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim());
    const records = lines.map((line, index) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(`${file}: invalid JSON at line ${index + 1}`);
      }
      assert.ok(record && typeof record === "object" && !Array.isArray(record),
        `${file}: invalid record at line ${index + 1}`);
      return record;
    });
    trials += checkEvalRecords(records, file);
  }
  return { files: files.length, trials };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, "Usage: node scripts/check-eval-results.mjs <results-directory>");
    const result = checkEvalResults(resolve(process.argv[2]));
    console.log(`Checked ${result.trials} trials in ${result.files} result files: no execution or grading infrastructure errors.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation infrastructure check failed");
    process.exitCode = 1;
  }
}
