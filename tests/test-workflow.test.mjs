import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { job, step } from "./helpers/workflow-source.mjs";

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
  assert.doesNotMatch(workflow, /\.github\/workflows\/publish\.yml/);
  assert.doesNotMatch(workflow, /publish-opencode-catalog|pages:/);
});

test("general CI runs tests and catalog checks without building release tar bundles", () => {
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run catalog\r?$/m);
  assert.match(workflow, /run: npm run catalog:check\r?$/m);
  assert.doesNotMatch(workflow, /Build release-equivalent bundles|npm run bundle\b|build-aspire-bundles\.mjs|gh release/);
});

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

test("setup runs only the test matrix and defers steady-state policy enforcement", () => {
  const jobs = [...workflow.split("\njobs:\n")[1].matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  assert.deepEqual(jobs, ["test"]);
  for (const name of ["branch-check.yml", "release-check.yml", "bundle-test.yml"]) {
    assert.equal(existsSync(join(repoRoot, ".github", "workflows", name)), false);
  }
  assert.doesNotMatch(workflow, /continue-on-error:|bootstrap|release\.mjs" check/);
  const header = job(workflow, "test").split("    steps:\n")[0];
  assert.doesNotMatch(header, /needs:|if:/);
});

test("npm test includes unit suites while the Linux rehearsal runs afterward without duplicate suites", () => {
  const source = readFileSync(join(repoRoot, "package.json"), "utf8");
  assert.equal(source.match(/"test"\s*:/g)?.length, 1);
  const scripts = JSON.parse(source).scripts;
  assert.equal(scripts.test,
    'node --test --test-skip-pattern="^local release workflow rehearsal" tests/*.test.mjs tests/aspireify/*.test.mjs');
  assert.equal(scripts["test:release-workflow"], "node --test tests/release-workflow-e2e.test.mjs");
  assert.match(workflow, /run: npm test/);
  const matrix = job(workflow, "test");
  const rehearsal = step(matrix, "Rehearse release workflow");
  assert.match(rehearsal, /if: runner\.os == 'Linux'/);
  assert.match(rehearsal, /run: npm run test:release-workflow/);
  assert.doesNotMatch(rehearsal, /continue-on-error:|always\(\)/);
  assert.ok(matrix.indexOf("name: Test\n") < matrix.indexOf("name: Rehearse release workflow\n"));
  assert.ok(matrix.indexOf("name: Rehearse release workflow\n") < matrix.indexOf("name: Build OpenCode catalog\n"));
});
