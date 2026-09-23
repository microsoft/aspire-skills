import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "test.yml"), "utf8").replaceAll("\r\n", "\n");

test("shared test workflow has general names and runs for its own changes", () => {
  assert.match(workflow, /^name: Tests\r?$/m);
  assert.match(workflow, /^    name: Test and build\r?$/m);
  assert.doesNotMatch(workflow, /paths:|paths-ignore:/);
});

test("all main/dev PR changes run tests without path filters", () => {
  assert.match(workflow, /pull_request:\n\s+branches:\n\s+- main\n\s+- dev/);
  assert.doesNotMatch(workflow, /paths:|paths-ignore:|branches-ignore:/);
});

test("general CI runs tests and catalog checks", () => {
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run catalog\r?$/m);
  assert.match(workflow, /run: npm run catalog:check\r?$/m);
});

const workflowDirectory = join(repoRoot, ".github", "workflows");
for (const file of readdirSync(workflowDirectory).filter(file => /\.ya?ml$/.test(file))) {
  const definition = parse(readFileSync(join(workflowDirectory, file), "utf8"));
  for (const [jobName, job] of Object.entries(definition.jobs)) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      if (step.run?.trim() !== "npm test") continue;
      test(`${file}: ${jobName} installs locked dependencies before npm test`, () => {
        assert.ok(steps.slice(0, index).some(previous =>
          previous.run?.trim() === "npm ci --ignore-scripts" &&
          previous["working-directory"] === step["working-directory"]),
        "Restore dependencies in the test working directory before running tests.");
      });
    }
  }
}

test("general tests run on both main and dev pushes", () => {
  const push = workflow.split(/\r?\n  push:\r?\n/)[1].split(/\r?\npermissions:/)[0];
  assert.match(push, /branches:\s+- main\s+- dev/);
  assert.doesNotMatch(push, /paths:|paths-ignore:/);
});

test("PR edits and ready-for-review events rerun tests", () => {
  const pr = workflow.split("  pull_request:\n")[1].split("  push:\n")[0];
  for (const event of ["opened", "synchronize", "reopened", "edited", "ready_for_review"]) {
    assert.ok(pr.includes(`- ${event}\n`), event);
  }
});

test("general test checkouts have read-only nonpersistent credentials", () => {
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|secrets\./);
  assert.match(workflow, /fetch-depth: 0\s+persist-credentials: false/);
});

test("tests run on Linux, macOS, and Windows", () => {
  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(workflow, new RegExp(`- ${runner}`));
  }

  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);
});

test("test matrix runs without prerequisite jobs or conditional skips", () => {
  const matrix = workflow.split("\n  test:\n")[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(matrix);
  assert.doesNotMatch(matrix, /continue-on-error:/);
  const header = matrix.split("    steps:\n")[0];
  assert.doesNotMatch(header, /needs:|if:/);
});

test("npm test runs the root and Aspireify unit suites", () => {
  const source = readFileSync(join(repoRoot, "package.json"), "utf8");
  assert.equal(source.match(/"test"\s*:/g)?.length, 1);
  const scripts = JSON.parse(source).scripts;
  assert.equal(scripts.test,
    "node --test tests/*.test.mjs tests/aspireify/*.test.mjs");
  assert.match(workflow, /run: npm test/);
});
